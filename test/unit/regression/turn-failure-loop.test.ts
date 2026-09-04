import { describe, expect, it } from "vitest";
import {
  ClaudeSession,
  type ClaudeSessionOptions,
} from "../../../src/claude/session.js";
import type { QueryFn, QueryHandle } from "../../../src/claude/query-handle.js";
import type { RenderEvent } from "../../../src/claude/render-event.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import { FakePermissionBroker } from "../claude/fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "../claude/fakes/fake-question-broker.js";
import { FakeQueryHandle } from "../claude/fakes/fake-query-handle.js";
import { formatTurnFailure } from "../../../src/agent/turn-failure.js";

/**
 * Regression suite for the production crash loop observed on 2026-09-04.
 *
 * Symptom (real logs, bridge under launchd with KeepAlive=true):
 *   level 50  "Claude turn failed" · "Claude Code returned an error
 *             result: Not logged in · Please run /login"
 *   level 60  "Unhandled promise rejection"
 *   <exit> → launchd restarts → Lark redelivers → repeat, 3× in ~21s
 *
 * Root cause: `ClaudeSession.submit()` hands the caller a Deferred
 * (`outcome.done`), but `src/index.ts` awaited a Feishu status-card
 * round trip BEFORE attaching its rejection handler. A provider that
 * fails instantly — an unauthenticated CLI does — rejected that promise
 * while nobody was observing it, so Node reported `unhandledRejection`
 * and the process-level handler called `process.exit(1)`.
 */

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  defaultEffort: "high" as const,
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
};

const AUTH_ERROR =
  "Claude Code returned an error result: Not logged in · Please run /login";

function runInput(text: string) {
  return {
    kind: "run" as const,
    text,
    senderOpenId: "ou_test",
    parentMessageId: "om_test",
    locale: "zh" as const,
  };
}

/** A provider whose message stream rejects on the very first pull. */
function rejectingHandle(message: string): QueryHandle {
  return {
    messages: {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error(message)),
        } as AsyncIterator<never>;
      },
    },
    interrupt: async () => {},
    setPermissionMode: () => {},
  };
}

function createSession(queryFn: QueryFn): ClaudeSession {
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock: new FakeClock(),
    permissionBroker: new FakePermissionBroker(),
    questionBroker: new FakeQuestionBroker(),
    logger: SILENT_LOGGER,
  };
  return new ClaudeSession(opts);
}

/**
 * Run `fn` with every other `unhandledRejection` listener (vitest's
 * included) detached, and collect anything Node reports. Node only
 * decides a rejection is unhandled once the microtask queue has drained,
 * so we let a couple of macrotask ticks pass before reading the result.
 */
async function watchUnhandledRejections(
  fn: () => Promise<void>,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const collect = (reason: unknown): void => {
    collected.push(reason);
  };
  process.on("unhandledRejection", collect);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", collect);
    for (const listener of saved) {
      process.on("unhandledRejection", listener as (r: unknown) => void);
    }
  }
  return collected;
}

/**
 * Mirrors the consumption order in `src/index.ts`'s `onMessage`: submit,
 * send the status card (a real Lark round trip — modelled here as a
 * macrotask), then observe the turn and, on failure, reply into the
 * originating chat. `main()` itself needs a live Lark WebSocket, so the
 * ordering under test is reproduced rather than imported.
 */
async function handleMessage(
  session: ClaudeSession,
  text: string,
  sent: string[],
  events: RenderEvent[],
): Promise<void> {
  const emit = async (event: RenderEvent): Promise<void> => {
    events.push(event);
  };
  try {
    const outcome = await session.submit(runInput(text), emit);
    const turnSettled =
      outcome.kind === "started" || outcome.kind === "queued"
        ? outcome.done.then(
          () => null,
          (err: unknown) => ({ err }),
        )
        : null;
    if (outcome.kind === "started") {
      // The status-card send: a network round trip, i.e. at least one
      // macrotask. This is the window the bug lived in.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (turnSettled !== null) {
      const failure = await turnSettled;
      if (failure !== null) throw failure.err;
    }
  } catch (err) {
    sent.push(
      formatTurnFailure({
        err,
        provider: session.getStatus().provider,
        locale: "zh",
      }),
    );
  }
}

/**
 * The ORIGINAL (pre-fix) consumption order from `src/index.ts`: await
 * the status card first, attach the rejection handler afterwards. Kept
 * as a test so `ClaudeSession`'s own guard is pinned independently of
 * how careful its callers happen to be — a future caller that awaits
 * anything before touching `outcome.done` must not be able to
 * resurrect this crash loop.
 */
async function handleMessageLegacyOrder(
  session: ClaudeSession,
  text: string,
  sent: string[],
): Promise<void> {
  const emit = async (): Promise<void> => {};
  try {
    const outcome = await session.submit(runInput(text), emit);
    if (outcome.kind === "started") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (outcome.kind === "started" || outcome.kind === "queued") {
      await outcome.done;
    }
  } catch (err) {
    sent.push(
      formatTurnFailure({
        err,
        provider: session.getStatus().provider,
        locale: "zh",
      }),
    );
  }
}

describe("regression: a failed turn must never kill the bridge", () => {
  it("raises no unhandledRejection even if the caller observes `done` late", async () => {
    const session = createSession(() => rejectingHandle(AUTH_ERROR));
    const sent: string[] = [];

    const unhandled = await watchUnhandledRejections(async () => {
      await handleMessageLegacyOrder(session, "构建一下", sent);
    });

    // The session pre-observes its own Deferred, so the late awaiter
    // still sees the rejection...
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("本次执行失败");
    // ...without Node ever reporting it as unhandled.
    expect(unhandled).toEqual([]);
  });

  it("raises no unhandledRejection when the turn fails during the status-card round trip", async () => {
    const session = createSession(() => rejectingHandle(AUTH_ERROR));
    const sent: string[] = [];
    const events: RenderEvent[] = [];

    const unhandled = await watchUnhandledRejections(async () => {
      await handleMessage(session, "构建一下", sent, events);
    });

    expect(unhandled).toEqual([]);
  });

  it("posts a readable failure message into the originating chat", async () => {
    const session = createSession(() => rejectingHandle("provider exploded"));
    const sent: string[] = [];
    const events: RenderEvent[] = [];

    await handleMessage(session, "构建一下", sent, events);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("本次执行失败");
    expect(sent[0]).toContain("provider exploded");
  });

  it("leaves the session usable — the next message still runs a turn", async () => {
    let call = 0;
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = () => {
      call += 1;
      if (call === 1) return rejectingHandle(AUTH_ERROR);
      const fake = new FakeQueryHandle();
      fakes.push(fake);
      return fake;
    };
    const session = createSession(queryFn);
    const sent: string[] = [];
    const events: RenderEvent[] = [];

    await handleMessage(session, "第一条", sent, events);
    expect(sent).toHaveLength(1);
    expect(session.getStatus().state).toBe("idle");

    const second = handleMessage(session, "第二条", sent, events);
    // Let the loop start the second turn, then complete it normally.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fakes).toHaveLength(1);
    fakes[0]!.finishWithSuccess({
      result: "done",
      durationMs: 12,
      inputTokens: 3,
      outputTokens: 4,
    });
    await second;

    // No second failure message: the turn after the failure succeeded.
    expect(sent).toHaveLength(1);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
    expect(session.getStatus().turnCount).toBe(1);
  });

  it("turns a provider auth failure into actionable /login instructions", async () => {
    const session = createSession(() => rejectingHandle(AUTH_ERROR));
    const sent: string[] = [];
    const events: RenderEvent[] = [];

    await handleMessage(session, "构建一下", sent, events);

    const text = sent[0]!;
    expect(text).toContain("本次执行失败");
    expect(text).toContain("Claude Code CLI");
    expect(text).toContain("`claude`");
    expect(text).toContain("`/login`");
    // Names the machine the operator has to fix, not just the failure.
    expect(text).toContain("运行本 bridge 的那台机器");
  });
});
