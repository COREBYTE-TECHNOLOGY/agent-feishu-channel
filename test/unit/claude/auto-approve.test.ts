import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoApprover,
  parseBashRule,
  splitBashSegments,
} from "../../../src/claude/auto-approve.js";
import { createLogger } from "../../../src/util/logger.js";
import {
  ClaudeSession,
  type ClaudeSessionOptions,
} from "../../../src/claude/session.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";
import { FakeClock } from "../../../src/util/clock.js";
import type { QueryFn, QueryHandle } from "../../../src/claude/query-handle.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

/**
 * These tests use real temp directories rather than a mocked fs: the
 * behaviour under test IS `fs.realpath` (symlink escapes) and mtime
 * invalidation, which a mock would define away. Nothing touches the
 * network.
 */
let root: string;
let workspace: string;

async function writeSettings(
  dir: string,
  body: unknown | string,
): Promise<void> {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(
    join(dir, ".claude", "settings.json"),
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
    "utf8",
  );
}

function approver(
  overrides: {
    autoApproveReadonly?: boolean;
    honorProjectPermissions?: boolean;
    boundaryCwd?: string;
  } = {},
): AutoApprover {
  return new AutoApprover({
    config: {
      autoApproveReadonly: overrides.autoApproveReadonly ?? true,
      honorProjectPermissions: overrides.honorProjectPermissions ?? true,
    },
    boundaryCwd: overrides.boundaryCwd ?? workspace,
    logger: SILENT_LOGGER,
  });
}

beforeEach(async () => {
  // realpath the temp root so macOS's /var → /private/var symlink does
  // not make every in-cwd path look like an escape.
  root = await realpath(await mkdtemp(join(tmpdir(), "afc-auto-approve-")));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "index.ts"), "export {};\n", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AutoApprover — read-only tools", () => {
  it("auto-approves Read of a file inside the session cwd", async () => {
    const decision = await approver().decide(
      "Read",
      { file_path: join(workspace, "src", "index.ts") },
      workspace,
    );
    expect(decision).toEqual({ approve: true, reason: "readonly-in-cwd" });
  });

  it("auto-approves a relative Read path that stays inside cwd", async () => {
    const decision = await approver().decide(
      "Read",
      { file_path: "src/index.ts" },
      workspace,
    );
    expect(decision.approve).toBe(true);
  });

  it("auto-approves Glob / Grep / LS / NotebookRead inside cwd", async () => {
    const a = approver();
    for (const [tool, input] of [
      ["Glob", { pattern: "**/*.ts", path: workspace }],
      ["Grep", { pattern: "export", path: join(workspace, "src") }],
      ["LS", { path: workspace }],
      ["NotebookRead", { notebook_path: join(workspace, "a.ipynb") }],
    ] as const) {
      const decision = await a.decide(tool, input, workspace);
      expect(decision, tool).toEqual({
        approve: true,
        reason: "readonly-in-cwd",
      });
    }
  });

  it("auto-approves path-free TodoWrite", async () => {
    const decision = await approver().decide(
      "TodoWrite",
      { todos: [{ content: "x", status: "pending" }] },
      workspace,
    );
    expect(decision.approve).toBe(true);
  });

  it("cards a Read of an absolute path outside the cwd tree", async () => {
    const outside = join(root, "other-repo", "secrets.txt");
    await mkdir(join(root, "other-repo"), { recursive: true });
    await writeFile(outside, "s", "utf8");
    const decision = await approver().decide(
      "Read",
      { file_path: outside },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "path-outside-cwd" });
  });

  it("cards a Read that climbs out with ..", async () => {
    const decision = await approver().decide(
      "Read",
      { file_path: "../../other-repo/secrets.txt" },
      workspace,
    );
    expect(decision.approve).toBe(false);
  });

  it("cards a Read of ~/.ssh/id_rsa (tilde is expanded, not joined)", async () => {
    const decision = await approver().decide(
      "Read",
      { file_path: "~/.ssh/id_rsa" },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "path-outside-cwd" });
  });

  it("cards a Read that escapes through a symlink inside the cwd", async () => {
    const secretDir = join(root, "outside");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "id_rsa"), "KEY", "utf8");
    await symlink(secretDir, join(workspace, "link"));

    const decision = await approver().decide(
      "Read",
      { file_path: join(workspace, "link", "id_rsa") },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "path-outside-cwd" });
  });

  it("cards a Glob whose pattern itself climbs out of the cwd", async () => {
    const decision = await approver().decide(
      "Glob",
      { pattern: "../../other-repo/**/*.ts" },
      workspace,
    );
    expect(decision.approve).toBe(false);
  });

  it("cards every read-only tool when auto_approve_readonly = false", async () => {
    const a = approver({ autoApproveReadonly: false });
    for (const tool of ["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"]) {
      const decision = await a.decide(tool, { path: workspace }, workspace);
      expect(decision, tool).toEqual({
        approve: false,
        reason: "auto_approve_readonly-off",
      });
    }
  });
});

describe("AutoApprover — tools that always card", () => {
  it("never auto-approves state-changing or network tools", async () => {
    const a = approver();
    for (const tool of [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "Skill",
    ]) {
      const decision = await a.decide(
        tool,
        { file_path: join(workspace, "src", "index.ts") },
        workspace,
      );
      expect(decision, tool).toEqual({
        approve: false,
        reason: "state-changing-tool",
      });
    }
  });

  it("never auto-approves an mcp__* tool, whatever its input", async () => {
    const a = approver();
    for (const tool of [
      "mcp__anything__read_file",
      "mcp__feishu__ask_user",
      "mcp__github__list_issues",
    ]) {
      const decision = await a.decide(
        tool,
        { file_path: join(workspace, "src", "index.ts") },
        workspace,
      );
      expect(decision, tool).toEqual({
        approve: false,
        reason: "mcp-tool-never-auto",
      });
    }
  });

  it("cards an unknown tool name", async () => {
    const decision = await approver().decide("SomeFutureTool", {}, workspace);
    expect(decision).toEqual({ approve: false, reason: "unknown-tool" });
  });
});

describe("AutoApprover — project Bash rules", () => {
  beforeEach(async () => {
    await writeSettings(workspace, {
      permissions: {
        allow: ["Bash(git status*)", "Bash(make lint)", "Read(**)"],
        deny: ["Bash(git push*)", "Bash(rm*)"],
      },
    });
  });

  it("auto-approves a Bash command matched by an allow rule", async () => {
    const decision = await approver().decide(
      "Bash",
      { command: "git status --short" },
      workspace,
    );
    expect(decision).toEqual({
      approve: true,
      reason: "project-allow-rule:Bash(git status*)",
    });
  });

  it("auto-approves an exact-match allow rule", async () => {
    const decision = await approver().decide(
      "Bash",
      { command: "make lint" },
      workspace,
    );
    expect(decision.approve).toBe(true);
  });

  it("cards rm -rf / — nothing allows it", async () => {
    const decision = await approver().decide(
      "Bash",
      { command: "rm -rf /" },
      workspace,
    );
    expect(decision).toEqual({
      approve: false,
      reason: "project-deny-rule:Bash(rm*)",
    });
  });

  it("cards an unmatched command", async () => {
    const decision = await approver().decide(
      "Bash",
      { command: "curl https://example.com" },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "no-allow-rule" });
  });

  it("cards when allow and deny both match — deny wins", async () => {
    await writeSettings(workspace, {
      permissions: {
        allow: ["Bash(git push*)"],
        deny: ["Bash(git push*)"],
      },
    });
    const decision = await approver().decide(
      "Bash",
      { command: "git push origin main" },
      workspace,
    );
    expect(decision).toEqual({
      approve: false,
      reason: "project-deny-rule:Bash(git push*)",
    });
  });

  it("cards a chained command whose prefix matches an allow rule", async () => {
    // `git status && rm -rf /` must NOT ride in on Bash(git status*).
    const decision = await approver().decide(
      "Bash",
      { command: "git status && rm -rf /" },
      workspace,
    );
    expect(decision.approve).toBe(false);
  });

  it("cards a command carrying substitution or redirection", async () => {
    const a = approver();
    for (const command of [
      "git status $(rm -rf /)",
      "git status > /etc/passwd",
      "git status `whoami`",
    ]) {
      const decision = await a.decide("Bash", { command }, workspace);
      expect(decision.approve, command).toBe(false);
    }
  });

  it("cards every Bash command when honor_project_permissions = false", async () => {
    const decision = await approver({
      honorProjectPermissions: false,
    }).decide("Bash", { command: "git status" }, workspace);
    expect(decision).toEqual({
      approve: false,
      reason: "honor_project_permissions-off",
    });
  });

  it("counts understood vs skipped rules", async () => {
    const rules = await approver().loadRules(workspace);
    // 2 allow Bash(...) + 2 deny Bash(...) understood; Read(**) skipped.
    expect(rules.understood).toBe(4);
    expect(rules.skipped).toBe(1);
  });
});

describe("AutoApprover — settings.json degradation (fail closed)", () => {
  it("cards everything when no settings.json exists", async () => {
    const decision = await approver().decide(
      "Bash",
      { command: "git status" },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "no-project-rules" });
  });

  it("cards everything when settings.json is malformed JSON", async () => {
    await writeSettings(workspace, "{ this is not json ");
    const decision = await approver().decide(
      "Bash",
      { command: "git status" },
      workspace,
    );
    expect(decision).toEqual({ approve: false, reason: "no-project-rules" });
  });

  it("cards everything when permissions is missing or the wrong shape", async () => {
    await writeSettings(workspace, { model: "opus", permissions: 42 });
    const decision = await approver().decide(
      "Bash",
      { command: "git status" },
      workspace,
    );
    expect(decision.approve).toBe(false);
  });

  it("ignores non-string entries inside allow/deny", async () => {
    await writeSettings(workspace, {
      permissions: { allow: [17, null, "Bash(make lint)"], deny: [] },
    });
    const decision = await approver().decide(
      "Bash",
      { command: "make lint" },
      workspace,
    );
    expect(decision.approve).toBe(true);
  });

  it("leaves read-only auto-approve untouched when the rules file is broken", async () => {
    await writeSettings(workspace, "{ broken ");
    const decision = await approver().decide(
      "Read",
      { file_path: join(workspace, "src", "index.ts") },
      workspace,
    );
    expect(decision.approve).toBe(true);
  });
});

describe("AutoApprover — settings walk-up and cache", () => {
  it("merges parent settings with the deeper file winning", async () => {
    const nested = join(workspace, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeSettings(workspace, {
      permissions: { allow: ["Bash(make lint)"], deny: [] },
    });
    await writeSettings(nested, {
      permissions: { allow: ["Bash(pnpm test*)"], deny: ["Bash(make lint)"] },
    });

    const a = approver();
    // Deeper allow rule applies.
    expect(
      (await a.decide("Bash", { command: "pnpm test --run" }, nested)).approve,
    ).toBe(true);
    // Deeper deny beats the parent's allow.
    expect(
      (await a.decide("Bash", { command: "make lint" }, nested)).approve,
    ).toBe(false);
  });

  it("stops walking up at the git root", async () => {
    const nested = join(workspace, "repo", "sub");
    await mkdir(nested, { recursive: true });
    await mkdir(join(workspace, "repo", ".git"), { recursive: true });
    await writeSettings(workspace, {
      permissions: { allow: ["Bash(make lint)"], deny: [] },
    });
    const decision = await approver().decide(
      "Bash",
      { command: "make lint" },
      nested,
    );
    // workspace/.claude/settings.json is above the git root → not read.
    expect(decision.approve).toBe(false);
  });

  it("never reads a settings file above the boundary cwd", async () => {
    await writeSettings(root, {
      permissions: { allow: ["Bash(make lint)"], deny: [] },
    });
    const decision = await approver().decide(
      "Bash",
      { command: "make lint" },
      workspace,
    );
    expect(decision.approve).toBe(false);
  });

  it("re-reads settings.json after its mtime changes", async () => {
    const a = approver();
    await writeSettings(workspace, {
      permissions: { allow: ["Bash(make lint)"], deny: [] },
    });
    expect(
      (await a.decide("Bash", { command: "make lint" }, workspace)).approve,
    ).toBe(true);

    await writeSettings(workspace, { permissions: { allow: [], deny: [] } });
    // Force a distinct mtime even on coarse-grained filesystems.
    const future = new Date(Date.now() + 10_000);
    await utimes(join(workspace, ".claude", "settings.json"), future, future);

    expect(
      (await a.decide("Bash", { command: "make lint" }, workspace)).approve,
    ).toBe(false);
  });
});

describe("rule parsing helpers", () => {
  it("parses the three supported Bash rule shapes", () => {
    expect(parseBashRule("Bash(make lint)")).toEqual({
      raw: "Bash(make lint)",
      kind: "exact",
      value: "make lint",
    });
    expect(parseBashRule("Bash(git status*)")).toEqual({
      raw: "Bash(git status*)",
      kind: "prefix",
      value: "git status",
    });
    expect(parseBashRule("Bash(git status:*)")).toEqual({
      raw: "Bash(git status:*)",
      kind: "prefix-word",
      value: "git status",
    });
  });

  it("skips non-Bash and empty rules", () => {
    expect(parseBashRule("Read(**)")).toBeNull();
    expect(parseBashRule("WebFetch(domain:example.com)")).toBeNull();
    expect(parseBashRule("Bash()")).toBeNull();
    expect(parseBashRule("Bash(*)")).toBeNull();
    expect(parseBashRule("Edit")).toBeNull();
  });

  it("refuses to segment commands with shell escapes", () => {
    expect(splitBashSegments("git status")).toEqual(["git status"]);
    expect(splitBashSegments("git status && make lint")).toEqual([
      "git status",
      "make lint",
    ]);
    expect(splitBashSegments("git status $(id)")).toBeNull();
    expect(splitBashSegments("git status > out")).toBeNull();
    expect(splitBashSegments("git status &")).toBeNull();
    expect(splitBashSegments("git status &&")).toBeNull();
    expect(splitBashSegments("   ")).toBeNull();
  });
});

describe("ClaudeSession — canUseTool honours the AutoApprover", () => {
  interface Harness {
    session: ClaudeSession;
    fakes: FakeQueryHandle[];
    broker: FakePermissionBroker;
  }

  function makeHarness(): Harness {
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const broker = new FakePermissionBroker();
    const opts: ClaudeSessionOptions = {
      chatId: "oc_x",
      config: {
        defaultCwd: workspace,
        defaultPermissionMode: "default",
        defaultModel: "claude-opus-4-6",
        defaultEffort: "high",
        cliPath: "claude",
        permissionTimeoutMs: 300_000,
        permissionWarnBeforeMs: 60_000,
      },
      queryFn,
      clock: new FakeClock(),
      permissionBroker: broker,
      questionBroker: new FakeQuestionBroker(),
      autoApprover: approver(),
      logger: SILENT_LOGGER,
    };
    return { session: new ClaudeSession(opts), fakes, broker };
  }

  /**
   * Wait until the session has handed `count` requests to the broker.
   * The auto-approve check does real `fs.realpath` work before it gives
   * up and posts a card, so a fixed number of microtask flushes is not
   * a deterministic barrier here.
   */
  async function waitForRequests(h: Harness, count: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (h.broker.requests.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function startTurn(h: Harness): Promise<FakeQueryHandle> {
    await h.session.submit(
      {
        kind: "run",
        text: "hello",
        senderOpenId: "ou_test",
        parentMessageId: "om_test",
        locale: "zh",
      },
      new SpyRenderer().emit,
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return h.fakes[0]!;
  }

  it("resolves a read-only in-cwd call without touching the broker", async () => {
    const h = makeHarness();
    const fake = await startTurn(h);
    const result = await fake.canUseTool!(
      "Read",
      { file_path: join(workspace, "src", "index.ts") },
      { signal: new AbortController().signal, toolUseID: "tu_1" },
    );
    expect(result.behavior).toBe("allow");
    expect(h.broker.requests).toHaveLength(0);
    expect(h.session.getStatus().autoApprovedCount).toBe(1);
  });

  it("still posts a card for a Write, and does not count it", async () => {
    const h = makeHarness();
    const fake = await startTurn(h);
    const pending = fake.canUseTool!(
      "Write",
      { file_path: join(workspace, "src", "index.ts"), content: "x" },
      { signal: new AbortController().signal, toolUseID: "tu_2" },
    );
    await waitForRequests(h, 1);
    expect(h.broker.requests).toHaveLength(1);
    expect(h.broker.requests[0]!.toolName).toBe("Write");
    h.broker.fakeResolve({ behavior: "allow" });
    await expect(pending).resolves.toEqual({ behavior: "allow" });
    expect(h.session.getStatus().autoApprovedCount).toBe(0);
  });

  it("still posts a card for a Read that leaves the cwd", async () => {
    const h = makeHarness();
    const fake = await startTurn(h);
    const pending = fake.canUseTool!(
      "Read",
      { file_path: "~/.ssh/id_rsa" },
      { signal: new AbortController().signal, toolUseID: "tu_3" },
    );
    await waitForRequests(h, 1);
    expect(h.broker.requests).toHaveLength(1);
    h.broker.fakeResolve({ behavior: "deny", message: "no" });
    await expect(pending).resolves.toEqual({
      behavior: "deny",
      message: "no",
    });
  });
});
