import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitHubWorkJournal } from "../../../src/audit/work-journal.js";
import { createRedactor } from "../../../src/audit/redact.js";
import type { JournalRemote } from "../../../src/audit/github-client.js";
import type { IncomingMessage } from "../../../src/types.js";

const DESTINATION = "COREBYTE-TECHNOLOGY/corebyte#52";
const ISSUE_URL = "https://github.com/COREBYTE-TECHNOLOGY/corebyte/issues/52";
const COMMENT = { id: 123, url: `${ISSUE_URL}#issuecomment-123` };
const FAKE_SECRET = "synthetic-private-material";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface StoredEntry {
  id: string;
  actor: string;
  instruction: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  actions: Array<{ key: string; name: string; detail: string; result: string }>;
  omittedActions: number;
  report: string;
  error: string;
  revision: number;
  syncedRevision: number;
  createAttempted: boolean;
  commentId?: number;
  url?: string;
}
interface StoredState { version: 1; destination: string; entries: StoredEntry[] }

let tempDirectory: string;
let stateFile: string;
let journals: GitHubWorkJournal[];

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "corebyte-work-journal-test-"));
  stateFile = join(tempDirectory, "private", "journal.json");
  journals = [];
});

afterEach(async () => {
  // Every path removed here was created by this test's mkdtemp fixture.
  for (const journal of journals) await journal.close();
  vi.useRealTimers();
  rmSync(tempDirectory, { recursive: true, force: true });
});

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatId: "synthetic-chat", messageId: "synthetic-message", senderOpenId: "verified-sender",
    text: "Inspect the synthetic task and report its result.", receivedAt: Date.UTC(2026, 8, 7, 8),
    ...overrides,
  };
}

function remoteMock() {
  return {
    find: vi.fn<JournalRemote["find"]>().mockResolvedValue(null),
    create: vi.fn<JournalRemote["create"]>().mockResolvedValue(COMMENT),
    update: vi.fn<JournalRemote["update"]>().mockResolvedValue(COMMENT),
  };
}

type JournalOptions = ConstructorParameters<typeof GitHubWorkJournal>[0];
function fixture(overrides: Partial<JournalOptions> = {}) {
  const remote = remoteMock();
  const onSyncError = vi.fn<() => void>();
  const redactor = createRedactor([FAKE_SECRET]);
  const redact = vi.fn((text: string, maxChars?: number) => redactor(text, maxChars));
  const journal = new GitHubWorkJournal({
    remote, onSyncError, redact, stateFile, destination: DESTINATION, issueUrl: ISSUE_URL,
    actorLabels: { "verified-sender": "Verified Operator" }, ...overrides,
  });
  journals.push(journal);
  return { journal, remote, onSyncError, redact };
}

function state(): StoredState {
  return JSON.parse(readFileSync(stateFile, "utf8")) as StoredState;
}
function onlyEntry(): StoredEntry {
  const entries = state().entries;
  expect(entries).toHaveLength(1);
  return entries[0]!;
}
function uploadedBodies(remote: ReturnType<typeof remoteMock>): string[] {
  return [...remote.create.mock.calls.map((call) => call[1]), ...remote.update.mock.calls.map((call) => call[2])];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GitHubWorkJournal acceptance and durable identity", () => {
  it("persists acceptance before making a remote call and records a verified display label", async () => {
    const remote = remoteMock();
    remote.find.mockImplementation(async () => {
      expect(onlyEntry()).toMatchObject({ status: "accepted", actor: "Verified Operator", createAttempted: false });
      return null;
    });
    const { journal } = fixture({ remote });
    const incoming = message();
    expect(journal.begin(incoming, "/tmp/synthetic-project")).not.toBeNull();
    expect(onlyEntry()).toMatchObject({
      id: digest(`${incoming.chatId}\n${incoming.messageId}`),
      createdAt: "2026-09-07T08:00:00.000Z", status: "accepted",
    });
    await journal.flush();
    expect(remote.create).toHaveBeenCalledTimes(1);
    const raw = readFileSync(stateFile, "utf8");
    for (const identifier of [incoming.chatId, incoming.messageId, incoming.senderOpenId]) {
      expect(raw).not.toContain(identifier);
    }
  });

  it.each(["unknown-sender", ""])("rejects sender %j without a verified actor mapping before any remote request", (senderOpenId) => {
    const { journal, remote } = fixture();
    expect(() => journal.begin(message({ senderOpenId }), "/tmp/synthetic-project")).toThrow("verified actor mapping");
    expect(state().entries).toEqual([]);
    expect(remote.find).not.toHaveBeenCalled();
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.update).not.toHaveBeenCalled();
  });

  it("deduplicates chat/message pairs durably, but accepts the same message id in another chat", async () => {
    const { journal, remote } = fixture();
    const original = message();
    const run = journal.begin(original, "/tmp/synthetic-project")!;
    await journal.flush();
    run.finish("completed");
    await journal.flush();
    expect(journal.begin({ ...original, text: "changed duplicate content" }, "/tmp/other")).toBeNull();
    expect(remote.create).toHaveBeenCalledTimes(1);
    await journal.close();

    const restarted = fixture();
    expect(restarted.journal.begin(original, "/tmp/other")).toBeNull();
    expect(restarted.remote.find).not.toHaveBeenCalled();
    expect(restarted.journal.begin(message({ chatId: "different-synthetic-chat" }), "/tmp/other")).not.toBeNull();
    await restarted.journal.flush();
    expect(state().entries).toHaveLength(2);
    expect(restarted.remote.create).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubWorkJournal lifecycle", () => {
  it.each([
    ["completed", "本轮执行结束（不代表需求已验收）"],
    ["cancelled", "已取消"],
    ["failed", "执行失败"],
  ] as const)("records terminal %s once without later events changing the outcome", async (status, label) => {
    const { journal, remote } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    run.event({ type: "queued", position: 2 });
    expect(onlyEntry().status).toBe("queued");
    run.event({ type: "text", text: "intermediate answer must not survive" });
    run.event({ type: "tool_use", id: "final-check", name: "Read", input: { path: "/tmp/synthetic-check.ts" } });
    run.event({ type: "text", text: "Final business summary: completed checks; remaining human review." });
    expect(onlyEntry().status).toBe("running");
    run.finish(status, status === "failed" ? `Synthetic failure: ${FAKE_SECRET}` : undefined);
    await journal.flush();
    const terminalEntry = onlyEntry();
    expect(terminalEntry.status).toBe(status);
    expect(terminalEntry.report).toBe(status === "completed" ? "Final business summary: completed checks; remaining human review." : "");
    const body = uploadedBodies(remote).at(-1)!;
    expect(body).toContain(label);
    expect(body).not.toContain("intermediate answer must not survive");
    if (status !== "completed") expect(body).not.toContain("Final business summary");
    if (status === "failed") expect(body).toContain("[REDACTED]");
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).toContain("不是人工审批或人工验收");

    run.event({ type: "text", text: "late answer" });
    run.event({ type: "tool_use", id: "late-tool", name: "Late tool", input: {} });
    run.finish("failed", "late failure");
    await journal.flush();
    expect(onlyEntry()).toEqual(terminalEntry);
  });

  it.each(["accepted", "queued", "running"] as const)("marks interrupted %s records unknown after restart and does not replay them", async (priorStatus) => {
    const { journal } = fixture();
    const incoming = message();
    const run = journal.begin(incoming, "/tmp/synthetic-project")!;
    await journal.flush();
    if (priorStatus === "queued") run.event({ type: "queued", position: 1 });
    if (priorStatus === "running") run.event({ type: "text", text: "Unfinished answer is not a final report" });
    expect(onlyEntry().status).toBe(priorStatus);
    const oldRevision = onlyEntry().revision;
    await journal.close();

    const restarted = fixture();
    expect(onlyEntry()).toMatchObject({ status: "unknown", report: "", revision: oldRevision + 1 });
    expect(onlyEntry().error).toContain("不自动重跑");
    expect(restarted.remote.find).not.toHaveBeenCalled();
    expect(restarted.remote.create).not.toHaveBeenCalled();
    expect(restarted.journal.begin(incoming, "/tmp/synthetic-project")).toBeNull();
    await restarted.journal.flush();
    expect(restarted.remote.create).not.toHaveBeenCalled();
    expect(restarted.remote.update).toHaveBeenCalledTimes(1);
    const body = uploadedBodies(restarted.remote).at(-1)!;
    expect(body).toContain("结果待核实（桥曾重启）");
    expect(body).not.toContain("Unfinished answer is not a final report");
  });
});

describe("GitHubWorkJournal source exclusion and filtering", () => {
  it("combines consecutive text deltas into the complete final reply group and resets at tool use", async () => {
    const { journal, remote } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    run.event({ type: "text", text: "An intermediate " });
    run.event({ type: "text", text: "reply group must not survive." });
    run.event({ type: "tool_use", id: "reply-boundary", name: "Read", input: {} });
    run.event({ type: "tool_result", toolUseId: "reply-boundary", isError: false, text: "private tool output" });
    const fragments = ["完成项：", "离线测试通过。", "\n待办：", "人工复核。"];
    for (const text of fragments) {
      run.event({ type: "text", text });
      expect(onlyEntry().report).toBe("");
    }
    run.finish("completed");
    await journal.flush();
    expect(onlyEntry().report).toBe(fragments.join(""));
    const body = uploadedBodies(remote).at(-1)!;
    expect(body).toContain("完成项：离线测试通过。\n    待办：人工复核。");
    expect(body).not.toContain("An intermediate");
    expect(body).not.toContain("reply group must not survive");
  });

  it("holds split secret fragments only in memory until completion and redacts the assembled final reply", async () => {
    const secret = "offline-only-secret-literal";
    const parts = [secret.slice(0, 13), secret.slice(13)];
    const redact = vi.fn(createRedactor([secret]));
    const { journal, remote } = fixture({ redact });
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    const fragments = ["Synthetic final report: ", ...parts, ". Human review remains."];
    for (const text of fragments) {
      run.event({ type: "text", text });
      await journal.flush();
      expect(onlyEntry().report).toBe("");
      const stored = readFileSync(stateFile, "utf8");
      const uploaded = uploadedBodies(remote).join("\n");
      const redactionInputs = redact.mock.calls.map((call) => call[0]).join("\n");
      for (const part of parts) {
        expect(stored).not.toContain(part);
        expect(uploaded).not.toContain(part);
        expect(redactionInputs).not.toContain(part);
      }
      expect(uploaded).not.toContain("Synthetic final report:");
    }
    run.finish("completed");
    await journal.flush();
    expect(redact).toHaveBeenCalledWith(fragments.join(""), 8000);
    expect(onlyEntry().report).toBe("Synthetic final report: [REDACTED]. Human review remains.");
    const output = `${readFileSync(stateFile, "utf8")}\n${uploadedBodies(remote).join("\n")}`;
    expect(output).toContain("[REDACTED]");
    for (const value of [secret, ...parts]) expect(output).not.toContain(value);
  });

  it("never passes thinking, tool output, attachments, raw commands, scripts, or extra input fields to redaction/storage/upload", async () => {
    const { journal, remote, redact } = fixture();
    const excluded = {
      thinking: "private-thought-not-for-upload", output: "raw-tool-output-not-for-upload",
      image: "data:image/png;base64,SYNTHETIC_ATTACHMENT", command: "raw-shell-argument-not-for-upload",
      cmd: "script-body-not-for-upload", pattern: "sensitive-search-not-for-upload",
      extra: "extra-input-value-not-for-upload", nested: "nested-input-value-not-for-upload",
    };
    const run = journal.begin(message({ imageDataUris: [excluded.image] }), "/tmp/synthetic-project")!;
    await journal.flush();
    run.event({ type: "thinking", text: excluded.thinking });
    run.event({ type: "tool_use", id: "synthetic-tool-id", name: "Shell", input: {
      command: excluded.command, cmd: excluded.cmd, pattern: excluded.pattern,
      path: "/tmp/synthetic-project", file_path: "/tmp/synthetic-file.ts",
      content: excluded.extra, nested: { path: excluded.nested },
    } });
    run.event({ type: "tool_result", toolUseId: "synthetic-tool-id", isError: false, text: excluded.output });
    run.event({ type: "tool_result", toolUseId: "unknown-tool", isError: true, text: excluded.output });
    run.event({ type: "turn_end", durationMs: 12, inputTokens: 10, outputTokens: 20 });
    run.event({ type: "text", text: "Public business summary" });
    run.finish("completed");
    await journal.flush();

    const persisted = readFileSync(stateFile, "utf8");
    const body = uploadedBodies(remote).join("\n");
    const redactInput = redact.mock.calls.map((call) => call[0]).join("\n");
    for (const value of Object.values(excluded)) {
      expect(persisted).not.toContain(value);
      expect(body).not.toContain(value);
      expect(redactInput).not.toContain(value);
    }
    const entry = onlyEntry();
    expect(entry.actions).toHaveLength(1);
    expect(entry.actions[0]).toMatchObject({ key: digest("synthetic-tool-id"), name: "Shell", result: "ok" });
    expect(entry.actions[0]!.detail).toContain("/tmp/synthetic-file.ts");
    expect(entry.actions[0]!.detail).toContain("/tmp/synthetic-project");
    expect(body).toContain("工具返回成功仅代表工具结果，不代表业务验收");
  });

  it("filters non-string input values and records error results without their payload", async () => {
    const { journal, remote } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    for (const [index, input] of [null, "primitive-input", { path: 42, file_path: { nested: "not-uploaded" } }].entries()) {
      run.event({ type: "tool_use", id: `tool-${index}`, name: "Read", input });
    }
    run.event({ type: "tool_result", toolUseId: "tool-1", isError: true, text: "raw-error-not-uploaded" });
    run.finish("failed");
    await journal.flush();
    expect(onlyEntry().actions.map((action) => action.result)).toEqual(["pending", "error", "pending"]);
    const output = `${readFileSync(stateFile, "utf8")}\n${uploadedBodies(remote).join("\n")}`;
    for (const omitted of ["primitive-input", "not-uploaded", "raw-error-not-uploaded"]) expect(output).not.toContain(omitted);
    expect(uploadedBodies(remote).at(-1)).toContain("工具返回失败");
  });

  it("redacts every allowed text surface and renders user/model text as inert quoted lines", async () => {
    const { journal, remote } = fixture({ actorLabels: { "verified-sender": `Operator ${FAKE_SECRET}` } });
    const untrusted = `Public line ${FAKE_SECRET}\n### untrusted-heading\n@synthetic-user\n![external](https://example.invalid/image)\n<!-- injected-marker -->`;
    const run = journal.begin(message({ text: untrusted }), `/tmp/${FAKE_SECRET}`)!;
    await journal.flush();
    run.event({ type: "tool_use", id: "tool", name: `Read ${FAKE_SECRET}`, input: { path: `/tmp/${FAKE_SECRET}` } });
    run.event({ type: "text", text: untrusted });
    run.finish("completed", `Synthetic diagnostic ${FAKE_SECRET}`);
    await journal.flush();
    const body = uploadedBodies(remote).at(-1)!;
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("\n    ### untrusted-heading");
    expect(body).not.toContain("\n### untrusted-heading");
    expect(body).not.toContain("@synthetic-user");
    expect(body).not.toContain("![external]");
    expect(body).not.toContain("<!-- injected-marker -->");
    expect(body).not.toContain(FAKE_SECRET);
    expect(readFileSync(stateFile, "utf8")).not.toContain(FAKE_SECRET);
  });
});

describe("GitHubWorkJournal persistence safety", () => {
  it("keeps state owner-only (0600), its directory private, and leaves no temporary files", async () => {
    const { journal } = fixture();
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(stateFile)).mode & 0o777).toBe(0o700);
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    run.event({ type: "text", text: "Synthetic result" });
    run.finish("completed");
    await journal.flush();
    await journal.close();
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(stateFile))).toEqual(["journal.json"]);
    expect(onlyEntry().status).toBe("completed");
  });

  it("rejects a public state directory and a symlinked state file", async () => {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    chmodSync(dirname(stateFile), 0o755);
    expect(() => fixture()).toThrow("private");
    chmodSync(dirname(stateFile), 0o700);
    const target = join(tempDirectory, "synthetic-target.json");
    writeFileSync(target, "do-not-overwrite", { mode: 0o600 });
    symlinkSync(target, stateFile);
    expect(() => fixture()).toThrow("symlink");
    expect(readFileSync(target, "utf8")).toBe("do-not-overwrite");
  });

  it("rejects a symlinked parent directory", () => {
    const target = join(tempDirectory, "real-private-directory");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dirname(stateFile));
    expect(() => fixture()).toThrow("symlink");
    expect(readdirSync(target)).toEqual([]);
  });

  it("fails closed on destination drift or duplicate persisted record ids", async () => {
    const { journal } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    run.finish("completed");
    await journal.flush();
    await journal.close();
    expect(() => fixture({ destination: "different-destination" })).toThrow("destination changed");
    const duplicateState = state();
    duplicateState.entries.push({ ...duplicateState.entries[0]! });
    writeFileSync(stateFile, JSON.stringify(duplicateState), { mode: 0o600 });
    expect(() => fixture()).toThrow("Duplicate journal record");
  });
});

describe("GitHubWorkJournal remote reconciliation", () => {
  it("keeps a durable unsynced record on lookup failure, logs no error payload, and succeeds later", async () => {
    const { journal, remote, onSyncError } = fixture();
    remote.find.mockRejectedValue(new Error(`Synthetic remote error ${FAKE_SECRET}`));
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    expect(onlyEntry()).toMatchObject({ syncedRevision: 0, createAttempted: false });
    expect(remote.create).not.toHaveBeenCalled();
    expect(await run.syncNotice()).toContain("GitHub 尚待同步（请勿视为已同步）");
    expect(onSyncError).toHaveBeenCalled();
    expect(onSyncError.mock.calls.every((args) => args.length === 0)).toBe(true);
    expect(readFileSync(stateFile, "utf8")).not.toContain(FAKE_SECRET);

    remote.find.mockResolvedValue(null);
    await journal.flush();
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(await run.syncNotice()).toBe(`工作记录已同步 GitHub：${COMMENT.url}`);
  });

  it("returns a pending sync notice at its deadline and closes without waiting for a slow remote", async () => {
    vi.useFakeTimers();
    const lookup = deferred<null>();
    const { journal, remote } = fixture();
    remote.find.mockReturnValue(lookup.promise);
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    const firstFlush = journal.flush();
    expect(journal.flush()).toBe(firstFlush);
    const notice = run.syncNotice(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await notice).toContain("GitHub 尚待同步");
    await expect(journal.close()).resolves.toBeUndefined();
    expect(remote.create).not.toHaveBeenCalled();
    lookup.resolve(null);
    await firstFlush;
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost POST response by finding the marker and updating the same comment, never creating twice", async () => {
    const { journal, remote } = fixture();
    remote.create.mockRejectedValueOnce(new Error("Synthetic lost POST response"));
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    expect(onlyEntry()).toMatchObject({ createAttempted: true, syncedRevision: 0 });
    expect(onlyEntry().commentId).toBeUndefined();
    const marker = remote.create.mock.calls[0]![0];
    remote.find.mockResolvedValue(COMMENT);
    run.event({ type: "text", text: "Recovered final business summary" });
    run.finish("completed");
    await journal.flush();
    expect(remote.find).toHaveBeenCalledTimes(2);
    expect(remote.find).toHaveBeenLastCalledWith(marker);
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(remote.update).toHaveBeenCalledTimes(1);
    expect(remote.update).toHaveBeenLastCalledWith(marker, COMMENT.id, expect.stringContaining("Recovered final business summary"));
    expect(onlyEntry().syncedRevision).toBe(onlyEntry().revision);
    expect(await run.syncNotice()).toContain(COMMENT.url);
  });

  it("never blindly retries an uncertain creation, even after restart when lookup still finds nothing", async () => {
    const { journal, remote } = fixture();
    remote.create.mockRejectedValue(new Error("Synthetic ambiguous write"));
    journal.begin(message(), "/tmp/synthetic-project");
    await journal.flush();
    await journal.flush();
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(remote.find).toHaveBeenCalledTimes(2);
    await journal.close();

    const restarted = fixture();
    await restarted.journal.flush();
    await restarted.journal.flush();
    expect(restarted.remote.find).toHaveBeenCalledTimes(2);
    expect(restarted.remote.create).not.toHaveBeenCalled();
    expect(restarted.remote.update).not.toHaveBeenCalled();
    expect(onlyEntry()).toMatchObject({ status: "unknown", createAttempted: true, syncedRevision: 0 });
    expect(restarted.journal.begin(message(), "/tmp/synthetic-project")).toBeNull();
  });

  it("updates an existing comment instead of creating another, and preserves newer revisions during an in-flight update", async () => {
    const { journal, remote } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    const marker = remote.create.mock.calls[0]![0];
    const pendingUpdate = deferred<typeof COMMENT>();
    remote.update.mockReturnValueOnce(pendingUpdate.promise);
    run.event({ type: "queued", position: 1 });
    const flush = journal.flush();
    run.event({ type: "text", text: "Newer final report" });
    run.finish("completed");
    pendingUpdate.resolve(COMMENT);
    await flush;
    // Streaming updates are coalesced to at most one PATCH per pass; the
    // newer revision must remain dirty for the next pass, not be lost.
    expect(remote.update).toHaveBeenCalledTimes(1);
    expect(onlyEntry().syncedRevision).toBeLessThan(onlyEntry().revision);
    await journal.flush();
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(remote.find).toHaveBeenCalledTimes(1);
    expect(remote.update).toHaveBeenCalledTimes(2);
    expect(remote.update).toHaveBeenLastCalledWith(marker, COMMENT.id, expect.stringContaining("Newer final report"));
    expect(onlyEntry().syncedRevision).toBe(onlyEntry().revision);
  });

  it("does not let a throwing sync-error observer break retry processing", async () => {
    const { journal, remote } = fixture({ onSyncError: () => { throw new Error("Synthetic observer error"); } });
    remote.find.mockRejectedValue(new Error("Synthetic offline remote"));
    journal.begin(message(), "/tmp/synthetic-project");
    await expect(journal.flush()).resolves.toBeUndefined();
    remote.find.mockResolvedValue(null);
    await journal.flush();
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "update"] as const)("rotates past 20 permanently in-doubt entries so the 21st record can %s in a bounded later flush", async (operation) => {
    const base: StoredEntry = {
      id: digest("synthetic-template"), actor: "Verified Operator", instruction: "Synthetic queued task",
      cwd: "/tmp/synthetic-project", createdAt: "2026-09-07T08:00:00.000Z", updatedAt: "2026-09-07T08:00:00.000Z",
      status: "unknown", actions: [], omittedActions: 0, report: "", error: "Synthetic ambiguous creation",
      revision: 1, syncedRevision: 0, createAttempted: true,
    };
    const blocked = Array.from({ length: 20 }, (_, index) => ({ ...base, id: digest(`synthetic-in-doubt-${index}`) }));
    const healthy: StoredEntry = {
      ...base, id: digest("synthetic-healthy-record"), status: "completed", error: "",
      report: "Healthy final business summary", createAttempted: operation === "update",
      ...(operation === "update" ? { commentId: COMMENT.id, url: COMMENT.url } : {}),
    };
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const saved: StoredState = { version: 1, destination: DESTINATION, entries: [...blocked, healthy] };
    writeFileSync(stateFile, JSON.stringify(saved), { mode: 0o600 });
    const { journal, remote } = fixture();
    const marker = `<!-- corebyte-lark-work:${healthy.id} -->`;

    await journal.flush();
    expect(remote.find).toHaveBeenCalledTimes(20);
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.update).not.toHaveBeenCalled();
    expect(state().entries[20]!.syncedRevision).toBe(0);

    await journal.flush();
    expect(remote.find.mock.calls.length + remote.update.mock.calls.length).toBe(40);
    if (operation === "create") {
      expect(remote.create).toHaveBeenCalledExactlyOnceWith(marker, expect.stringContaining("Healthy final business summary"));
      expect(remote.update).not.toHaveBeenCalled();
    } else {
      expect(remote.update).toHaveBeenCalledExactlyOnceWith(marker, COMMENT.id, expect.stringContaining("Healthy final business summary"));
      expect(remote.create).not.toHaveBeenCalled();
    }
    expect(state().entries[20]).toMatchObject({ commentId: COMMENT.id, syncedRevision: 1, revision: 1 });

    // A further all-failing pass must still terminate after 20 scans; none of
    // the uncertain creations may be replayed and the healthy row stays clean.
    await journal.flush();
    expect(remote.find.mock.calls.length + remote.update.mock.calls.length).toBe(60);
    expect(remote.create).toHaveBeenCalledTimes(operation === "create" ? 1 : 0);
    expect(remote.update).toHaveBeenCalledTimes(operation === "update" ? 1 : 0);
    for (const entry of state().entries.slice(0, 20)) {
      expect(entry).toMatchObject({ status: "unknown", createAttempted: true, syncedRevision: 0 });
      expect(entry.commentId).toBeUndefined();
    }
  });
});

describe("GitHubWorkJournal capacity and report bounds", () => {
  it("explicitly omits the entire reply group once accumulated text exceeds 64K characters", async () => {
    const { journal, remote } = fixture();
    const run = journal.begin(message(), "/tmp/synthetic-project")!;
    await journal.flush();
    run.event({ type: "text", text: `OVERFLOW-PREFIX ${"界".repeat(40_000)}` });
    run.event({ type: "text", text: "界".repeat(30_000) });
    run.event({ type: "text", text: " OVERFLOW-TAIL-MUST-NOT-SURVIVE" });
    await journal.flush();
    expect(onlyEntry().report).toBe("");
    run.finish("completed");
    await journal.flush();
    const report = onlyEntry().report;
    expect(report).toMatch(/超[过出限]/);
    expect(report).toContain("未上传回复正文");
    const output = `${readFileSync(stateFile, "utf8")}\n${uploadedBodies(remote).join("\n")}`;
    for (const value of ["OVERFLOW-PREFIX", "OVERFLOW-TAIL-MUST-NOT-SURVIVE", "界".repeat(10)]) {
      expect(output).not.toContain(value);
    }
    expect(uploadedBodies(remote).at(-1)).toContain("未上传回复正文");
    expect(Buffer.byteLength(uploadedBodies(remote).at(-1)!, "utf8")).toBeLessThanOrEqual(60_000);
  });

  it("caps actions at 40, counts omitted calls, and truncates all persisted summary fields", async () => {
    const { journal, remote } = fixture({ actorLabels: { "verified-sender": "名".repeat(500) } });
    const run = journal.begin(message({ text: "指".repeat(10_000) }), `/${"路".repeat(1000)}`)!;
    await journal.flush();
    for (let index = 0; index < 45; index++) {
      run.event({ type: "tool_use", id: `tool-${index}`, name: "工".repeat(500), input: { path: "路".repeat(1000) } });
    }
    run.event({ type: "text", text: "报".repeat(15_000) });
    run.finish("completed", "误".repeat(3000));
    await journal.flush();
    const entry = onlyEntry();
    expect(entry.actor.length).toBeLessThanOrEqual(100);
    expect(entry.instruction.length).toBeLessThanOrEqual(6000);
    expect(entry.cwd.length).toBeLessThanOrEqual(500);
    expect(entry.actions).toHaveLength(40);
    expect(entry.omittedActions).toBe(5);
    expect(entry.actions.every((action) => action.name.length <= 120 && action.detail.length <= 600)).toBe(true);
    expect(entry.report.length).toBeLessThanOrEqual(8000);
    expect(entry.error.length).toBeLessThanOrEqual(2000);
    const body = uploadedBodies(remote).at(-1)!;
    expect(body).toContain("另有 5 次工具调用超出本条明细上限");
    expect(body).toContain("已截断");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
  });

  it.each(["界", "😀", "界\n", "\n"])("keeps multilingual and newline-heavy %j reports under the remote byte limit without broken surrogate pairs", async (unit) => {
    const { journal, remote } = fixture();
    const large = unit.repeat(15_000);
    const run = journal.begin(message({ text: large }), `/${large}`)!;
    await journal.flush();
    for (let index = 0; index < 40; index++) {
      run.event({ type: "tool_use", id: `tool-${index}`, name: `Tool ${unit.repeat(100)}`, input: { file_path: large } });
    }
    run.event({ type: "text", text: large });
    run.finish("completed", large);
    await journal.flush();
    for (const body of uploadedBodies(remote)) {
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
      expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
      expect(body).not.toContain("\uFFFD");
    }
    expect(uploadedBodies(remote).at(-1)).toContain("已截断");
  });

  it("rejects new tasks at 2000 entries without losing durable duplicate protection", async () => {
    const { journal } = fixture();
    const incoming = message();
    const run = journal.begin(incoming, "/tmp/synthetic-project")!;
    await journal.flush();
    run.finish("completed");
    await journal.flush();
    await journal.close();
    const saved = state();
    const template = saved.entries[0]!;
    saved.entries = Array.from({ length: 2000 }, (_, index) => ({
      ...template, id: index === 0 ? template.id : digest(`archived-synthetic-task-${index}`),
    }));
    writeFileSync(stateFile, JSON.stringify(saved), { mode: 0o600 });
    const restarted = fixture();
    expect(restarted.journal.begin(incoming, "/tmp/synthetic-project")).toBeNull();
    expect(() => restarted.journal.begin(message({ messageId: "new-synthetic-message" }), "/tmp/synthetic-project")).toThrow("capacity reached");
    expect(state().entries).toHaveLength(2000);
    expect(restarted.remote.find).not.toHaveBeenCalled();
    expect(restarted.remote.create).not.toHaveBeenCalled();
  });
});
