import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, IncomingMessage } from "../../../src/types.js";
import type { FeishuGatewayOptions } from "../../../src/feishu/gateway.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import type { QueryFn } from "../../../src/claude/query-handle.js";
import type { JournalRemote } from "../../../src/audit/github-client.js";

// All external boundaries are replaced before index.ts is imported. No real
// config, credentials, CLI, SDK query, Lark connection or GitHub client is used.
const offline = vi.hoisted(() => {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    logger,
    loadConfig: vi.fn<(path: string) => Promise<AppConfig>>(),
    query: vi.fn<QueryFn>(),
    unexpectedClaudeQuery: vi.fn<QueryFn>(() => { throw new Error("Unexpected Claude query in offline test"); }),
    preflight: vi.fn().mockResolvedValue({ ok: true, version: "synthetic-offline" }),
    sdkInstalled: vi.fn().mockResolvedValue(undefined),
    gatewayOptions: undefined as FeishuGatewayOptions | undefined,
    gatewayStart: vi.fn().mockResolvedValue(undefined),
    larkConstructed: vi.fn(),
    replyText: vi.fn<FeishuClient["replyText"]>().mockResolvedValue({ messageId: "synthetic-text-reply" }),
    replyCard: vi.fn<FeishuClient["replyCard"]>().mockResolvedValue({ messageId: "synthetic-status-message" }),
    convertMessageIdToCardId: vi.fn<FeishuClient["convertMessageIdToCardId"]>().mockResolvedValue("synthetic-status-card"),
    streamElementContent: vi.fn<FeishuClient["streamElementContent"]>().mockResolvedValue(undefined),
    patchCard: vi.fn<FeishuClient["patchCard"]>().mockResolvedValue(undefined),
  };
});

vi.mock("../../../src/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/config.js")>(),
  loadConfig: offline.loadConfig,
  writeConfigKey: vi.fn(() => { throw new Error("Config writes are forbidden in this test"); }),
}));
vi.mock("../../../src/util/logger.js", () => ({ createLogger: () => offline.logger }));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class { constructor(...args: unknown[]) { offline.larkConstructed(...args); } },
}));
vi.mock("../../../src/feishu/client.js", () => ({
  FeishuClient: class {
    replyText = offline.replyText;
    replyCard = offline.replyCard;
    convertMessageIdToCardId = offline.convertMessageIdToCardId;
    streamElementContent = offline.streamElementContent;
    patchCard = offline.patchCard;
  },
}));
vi.mock("../../../src/feishu/gateway.js", () => ({
  toLarkDomain: () => "synthetic-offline-domain",
  FeishuGateway: class {
    constructor(options: FeishuGatewayOptions) { offline.gatewayOptions = options; }
    start = offline.gatewayStart;
  },
}));
vi.mock("../../../src/claude/preflight.js", () => ({ checkClaudeCli: offline.preflight }));
vi.mock("../../../src/codex/preflight.js", () => ({ checkCodexCli: offline.preflight }));
vi.mock("../../../src/claude/sdk-query.js", () => ({ createSdkQueryFn: () => offline.unexpectedClaudeQuery }));
vi.mock("../../../src/codex/sdk-run.js", () => ({
  checkCodexSdkInstalled: offline.sdkInstalled,
  createCodexQueryFn: () => offline.query,
}));
// Session construction normally creates an in-process SDK MCP shim. This
// unrelated SDK boundary is inert; session scheduling/cancellation stay real.
vi.mock("../../../src/claude/ask-user-mcp.js", () => ({
  createAskUserMcpServer: () => ({ type: "sdk", name: "synthetic-offline", instance: {} }),
}));

import { main } from "../../../src/index.js";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import { GitHubWorkJournal } from "../../../src/audit/work-journal.js";
import { createRedactor } from "../../../src/audit/redact.js";
import { formatStopAck } from "../../../src/feishu/messages.js";
import { detectLocale } from "../../../src/util/i18n.js";
import { FakeQueryHandle } from "../claude/fakes/fake-query-handle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(directory: string): AppConfig {
  return {
    feishu: { appId: "synthetic-app", appSecret: "synthetic-not-a-secret", encryptKey: "", verificationToken: "", domain: "lark" },
    access: {
      allowedOpenIds: ["synthetic-operator"], allowedChatIds: ["synthetic-chat"],
      unauthorizedBehavior: "ignore", requireMention: true,
      autoApproveReadonly: false, honorProjectPermissions: false,
    },
    agent: {
      defaultProvider: "codex", defaultCwd: directory, lockedCwd: true,
      defaultPermissionMode: "default", permissionTimeoutMs: 30_000, permissionWarnBeforeMs: 5_000,
    },
    claude: {
      defaultCwd: directory, cliPath: "/synthetic/not-executable/claude", defaultModel: "synthetic-claude",
      defaultEffort: "high", defaultPermissionMode: "default",
      permissionTimeoutMs: 30_000, permissionWarnBeforeMs: 5_000,
    },
    codex: { cliPath: "/synthetic/not-executable/codex", defaultModel: "synthetic-codex", defaultEffort: "high", defaultPermissionMode: "default" },
    render: { inlineMaxBytes: 2048, hideThinking: true, showTurnStats: true },
    persistence: { stateFile: join(directory, "bridge-state.json"), logDir: join(directory, "logs"), sessionTtlDays: 1 },
    logging: { level: "error" }, projects: {}, mcp: [],
  };
}

interface StoredEntry {
  status: string;
  instruction: string;
  report: string;
  revision: number;
  syncedRevision: number;
  commentId?: number;
}

describe("main /stop with GitHub journal backpressure (corebyte #52 AC3)", () => {
  it("cancels through the registered message handler before GitHub settles, then synchronizes the same task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "corebyte-stop-journal-offline-"));
    const stateFile = join(directory, "private", "outbox.json");
    const processEvents = ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException"] as const;
    const originalListeners = new Map(processEvents.map(event => [event, process.listeners(event)]));
    const processExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("main must not exit the test process");
    });
    const getSession = vi.spyOn(ClaudeSessionManager.prototype, "getOrCreate");
    const provider = new FakeQueryHandle();
    const interrupt = vi.spyOn(provider, "interrupt");
    const lookup = deferred<{ id: number; url: string } | null>();
    let remoteSettled = false;
    const comment = { id: 123, url: "https://github.com/COREBYTE-TECHNOLOGY/corebyte/issues/53#issuecomment-123" };
    const remote = {
      find: vi.fn<JournalRemote["find"]>().mockReturnValueOnce(lookup.promise).mockResolvedValue(null),
      create: vi.fn<JournalRemote["create"]>().mockResolvedValue(comment),
      update: vi.fn<JournalRemote["update"]>().mockResolvedValue(comment),
    };
    // Resolve only from the test's explicit recovery/cleanup paths.
    void lookup.promise.then(() => { remoteSettled = true; });
    const journal = new GitHubWorkJournal({
      remote, stateFile, destination: "COREBYTE-TECHNOLOGY/corebyte#53",
      issueUrl: "https://github.com/COREBYTE-TECHNOLOGY/corebyte/issues/53",
      actorLabels: { "synthetic-operator": "Synthetic Operator" }, redact: createRedactor([]),
    });
    const entries = (): StoredEntry[] => (JSON.parse(readFileSync(stateFile, "utf8")) as { entries: StoredEntry[] }).entries;
    const task: IncomingMessage = {
      chatId: "synthetic-chat", senderOpenId: "synthetic-operator", messageId: "synthetic-task",
      text: "离线检查：仅产生可取消的模拟回复。", receivedAt: Date.UTC(2026, 8, 7),
    };
    const stop = { ...task, messageId: "synthetic-stop", text: "/stop" };
    const pendingHandlers: Promise<unknown>[] = [];
    let taskSettled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      offline.loadConfig.mockResolvedValue(config(directory));
      offline.query.mockReturnValue(provider);
      await main(join(directory, "synthetic-config-not-read.toml"), journal);
      expect(offline.loadConfig).toHaveBeenCalledExactlyOnceWith(join(directory, "synthetic-config-not-read.toml"));
      expect(offline.gatewayStart).toHaveBeenCalledOnce();
      expect(offline.larkConstructed).toHaveBeenCalledOnce();
      expect(offline.preflight).toHaveBeenCalledExactlyOnceWith("/synthetic/not-executable/codex");
      expect(offline.sdkInstalled).toHaveBeenCalledOnce();
      const onMessage = offline.gatewayOptions!.onMessage; // Real main closure, not a reimplementation.
      const taskHandler = onMessage(task).then(() => { taskSettled = true; });
      pendingHandlers.push(taskHandler);
      // Observe rejection immediately; cleanup also drains every handler.
      void taskHandler.catch(() => undefined);
      await vi.waitFor(() => {
        expect(offline.query).toHaveBeenCalledOnce();
        expect(remote.find).toHaveBeenCalledOnce();
        expect(offline.convertMessageIdToCardId).toHaveBeenCalledOnce();
      }, { timeout: 1000, interval: 1 });
      const session = getSession.mock.results[0]!.value as ReturnType<ClaudeSessionManager["getOrCreate"]>;
      expect(session.getStatus()).toMatchObject({ provider: "codex", state: "generating", turnCount: 0 });
      provider.emitMessage({ type: "assistant", message: { content: [{ type: "text", text: "Unfinished synthetic report must not be published" }] } });
      await vi.waitFor(() => { expect(entries()[0]?.status).toBe("running"); }, { timeout: 1000, interval: 1 });

      let stopSettled = false;
      const stopHandler = onMessage(stop).then(() => { stopSettled = true; });
      pendingHandlers.push(stopHandler);
      void stopHandler.catch(() => undefined);
      await vi.waitFor(() => {
        expect(stopSettled).toBe(true);
        expect(interrupt).toHaveBeenCalledOnce();
        expect(session.getStatus()).toMatchObject({ state: "idle", queueLength: 0, turnCount: 0 });
        expect(offline.replyText).toHaveBeenCalledWith(stop.messageId, formatStopAck(detectLocale(stop.text)));
        expect(offline.streamElementContent).toHaveBeenCalledWith(expect.objectContaining({
          cardId: "synthetic-status-card", content: formatStopAck(detectLocale(task.text)),
        }));
        expect(entries()).toHaveLength(1);
        expect(entries()[0]).toMatchObject({ status: "cancelled", instruction: task.text, report: "", syncedRevision: 0 });
      }, { timeout: 1000, interval: 1 });
      expect(remoteSettled).toBe(false);
      expect(taskSettled).toBe(false); // Only the original task's syncNotice is waiting.
      expect(remote.create).not.toHaveBeenCalled();
      expect(remote.update).not.toHaveBeenCalled();
      expect(offline.query).toHaveBeenCalledOnce(); // /stop is not another model task.
      expect(offline.unexpectedClaudeQuery).not.toHaveBeenCalled();

      // The original reply may time out independently; /stop already finished.
      await vi.advanceTimersByTimeAsync(12_000);
      await taskHandler;
      expect(remoteSettled).toBe(false);
      expect(offline.replyText).toHaveBeenCalledWith(task.messageId, expect.stringContaining("GitHub 尚待同步"));
      expect(entries()[0]?.status).toBe("cancelled");
      expect(offline.replyCard).toHaveBeenCalledOnce(); // Status only: no cancelled partial/final answer card.

      lookup.resolve(null);
      await journal.flush();
      await journal.flush(); // Coalesced terminal revision follows the initial in-flight snapshot.
      expect(remote.create).toHaveBeenCalledOnce();
      expect(remote.update).toHaveBeenCalledOnce();
      const marker = remote.create.mock.calls[0]![0];
      expect(remote.update).toHaveBeenLastCalledWith(marker, comment.id, expect.stringContaining("状态：已取消"));
      const cancelledBody = remote.update.mock.calls[0]![2];
      expect(cancelledBody).not.toContain("Unfinished synthetic report");
      expect(cancelledBody).not.toContain("状态：本轮执行结束");
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({ status: "cancelled", commentId: comment.id });
      expect(entries()[0]?.syncedRevision).toBe(entries()[0]?.revision);
      await journal.flush();
      expect(remote.create).toHaveBeenCalledOnce();
      expect(remote.update).toHaveBeenCalledOnce();
      expect(processExit).not.toHaveBeenCalled();
      expect(offline.logger.error).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(null);
      if (!provider.interrupted) await provider.interrupt();
      await vi.advanceTimersByTimeAsync(12_000);
      await Promise.allSettled(pendingHandlers);
      await journal.flush();
      await journal.close();
      for (const manager of new Set(getSession.mock.contexts as ClaudeSessionManager[])) await manager.flushPendingSave();
      for (const event of processEvents) {
        for (const listener of process.listeners(event)) {
          if (!originalListeners.get(event)!.includes(listener)) process.removeListener(event, listener);
        }
      }
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      // Only this test's mkdtemp directory is removed; no user state is touched.
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
