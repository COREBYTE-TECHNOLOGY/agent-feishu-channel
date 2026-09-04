import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessControl } from "../../../src/access.js";
import { FeishuGateway } from "../../../src/feishu/gateway.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import type { ReceiveV1Event } from "../../../src/feishu/types.js";
import { StateStore, type State } from "../../../src/persistence/state-store.js";
import { PersistentDedup } from "../../../src/util/dedup.js";
import { createLogger } from "../../../src/util/logger.js";

/**
 * Second half of the 2026-09-04 crash loop: dedup lived only in memory,
 * so every launchd restart forgot which Lark events had already been
 * seen. Lark redelivered the message that had just killed the bridge,
 * the bridge processed it again, and died again. Persisting the ring is
 * what turns a repeating crash into a single logged failure.
 */

const SILENT = createLogger({ level: "error", pretty: false });

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-dedup-restart-"));
  statePath = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(messageId: string): ReceiveV1Event {
  return {
    sender: { sender_id: { open_id: "ou_allowed" } },
    message: {
      message_id: messageId,
      chat_id: "oc_allowed",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1700000000000",
    },
  };
}

async function handleReceiveV1(
  gateway: FeishuGateway,
  event: ReceiveV1Event,
): Promise<void> {
  await (
    gateway as unknown as {
      handleReceiveV1(event: ReceiveV1Event): Promise<void>;
    }
  ).handleReceiveV1(event);
}

/**
 * One process lifetime: a fresh StateStore + PersistentDedup + gateway
 * over the same state file, exactly as `src/index.ts` wires them at
 * startup.
 */
async function bootBridge(): Promise<{
  gateway: FeishuGateway;
  handled: string[];
  flushed: Promise<void>[];
  state: State;
}> {
  const stateStore = new StateStore(statePath);
  const state = await stateStore.load();
  const flushed: Promise<void>[] = [];
  const dedup = new PersistentDedup({
    initial: stateStore.loadedSeenMessages(),
    persist: (entries) => {
      flushed.push(stateStore.saveSeenMessages(entries));
    },
  });
  const handled: string[] = [];
  const gateway = new FeishuGateway({
    appId: "cli_test",
    appSecret: "secret",
    domain: "lark",
    logger: SILENT,
    lark: {} as never,
    feishuClient: { replyText: async () => ({}) } as unknown as FeishuClient,
    access: new AccessControl({
      allowedOpenIds: ["ou_allowed"],
      allowedChatIds: ["oc_allowed"],
      unauthorizedBehavior: "ignore",
    }),
    requireMention: false,
    onMessage: async (msg) => {
      handled.push(msg.messageId);
    },
    onCardAction: async () => {},
    dedup,
  });
  return { gateway, handled, flushed, state };
}

describe("regression: dedup survives a restart", () => {
  it("skips a redelivered message_id after the process restarts", async () => {
    // --- lifetime 1: the message arrives and (in production) kills us.
    const first = await bootBridge();
    await handleReceiveV1(first.gateway, makeEvent("om_poison"));
    expect(first.handled).toEqual(["om_poison"]);
    await Promise.all(first.flushed);

    // --- lifetime 2: launchd restarted us, Lark redelivers the event.
    const second = await bootBridge();
    await handleReceiveV1(second.gateway, makeEvent("om_poison"));
    expect(second.handled).toEqual([]);

    // A genuinely new message still gets through.
    await handleReceiveV1(second.gateway, makeEvent("om_next"));
    expect(second.handled).toEqual(["om_next"]);
    // Settle the fire-and-forget flush before the temp dir is removed.
    await Promise.all(second.flushed);
  });

  it("keeps the persisted ring owner-only (0600) in state.json", async () => {
    const first = await bootBridge();
    await handleReceiveV1(first.gateway, makeEvent("om_1"));
    await Promise.all(first.flushed);

    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      seenMessages?: { id: string }[];
    };
    expect(parsed.seenMessages?.map((e) => e.id)).toEqual(["om_1"]);
  });

  it("a full session-state save does not clobber the dedup ring", async () => {
    const first = await bootBridge();
    await handleReceiveV1(first.gateway, makeEvent("om_1"));
    await Promise.all(first.flushed);

    // SessionManager.saveNow() builds a complete State from its own
    // snapshots and knows nothing about dedup — it must not drop it.
    const store = new StateStore(statePath);
    const state = await store.load();
    await store.save({
      ...state,
      sessions: {
        "oc_allowed\t\tclaude": {
          provider: "claude",
          cwd: "/tmp/x",
          createdAt: "2026-09-04T00:00:00Z",
          lastActiveAt: "2026-09-04T00:01:00Z",
        },
      },
    });

    const reloaded = new StateStore(statePath);
    await reloaded.load();
    expect(reloaded.loadedSeenMessages().map((e) => e.id)).toEqual(["om_1"]);
  });

  it("expired ids are dropped on reload so the ring cannot grow forever", async () => {
    const store = new StateStore(statePath);
    await store.load();
    const stale = Date.now() - 2 * 60 * 60 * 1000; // 2h old, TTL is 1h
    await store.saveSeenMessages([{ id: "om_ancient", ts: stale }]);

    const reloaded = new StateStore(statePath);
    await reloaded.load();
    const dedup = new PersistentDedup({
      initial: reloaded.loadedSeenMessages(),
    });
    expect(dedup.size()).toBe(0);
    expect(dedup.check("om_ancient")).toBe(false);
  });
});
