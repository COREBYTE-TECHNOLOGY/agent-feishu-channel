import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../../../src/access.js";
import {
  FeishuGateway,
  toLarkDomain,
  type CardActionEvent,
  type CardActionHandler,
  type MessageHandler,
} from "../../../src/feishu/gateway.js";
import { Domain } from "@larksuiteoapi/node-sdk";
import type { BotIdentity, FeishuClient } from "../../../src/feishu/client.js";
import type { ReceiveV1Event } from "../../../src/feishu/types.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

function makeTextEvent(openId: string, chatId = "oc_test"): ReceiveV1Event {
  return {
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: "om_test",
      chat_id: chatId,
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1700000000000",
    },
  };
}

function makeGateway(args: {
  access: AccessControl;
  feishuClient: Pick<FeishuClient, "replyText">;
  onMessage?: MessageHandler;
  onCardAction?: CardActionHandler;
  /** Defaults to false so the pre-existing cases keep their old semantics. */
  requireMention?: boolean;
  resolveBotIdentity?: () => Promise<BotIdentity>;
}): FeishuGateway {
  return new FeishuGateway({
    appId: "cli_test",
    appSecret: "secret",
    domain: "lark",
    logger: SILENT,
    lark: {} as never,
    feishuClient: args.feishuClient as FeishuClient,
    access: args.access,
    requireMention: args.requireMention ?? false,
    onMessage: args.onMessage ?? (async () => {}),
    onCardAction: args.onCardAction ?? vi.fn(),
    ...(args.resolveBotIdentity
      ? { resolveBotIdentity: args.resolveBotIdentity }
      : {}),
  });
}

async function handleCardAction(
  gateway: FeishuGateway,
  event: CardActionEvent,
): Promise<unknown> {
  return (gateway as unknown as {
    handleCardAction(event: CardActionEvent): Promise<unknown>;
  }).handleCardAction(event);
}

async function handleReceiveV1(
  gateway: FeishuGateway,
  event: ReceiveV1Event,
): Promise<void> {
  await (gateway as unknown as {
    handleReceiveV1(event: ReceiveV1Event): Promise<void>;
  }).handleReceiveV1(event);
}

describe("FeishuGateway access-control replies", () => {
  it("replies with the sender open_id when unauthorized_behavior is reject", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: new AccessControl({
        allowedOpenIds: [],
        allowedChatIds: ["oc_test"],
        unauthorizedBehavior: "reject",
      }),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_intruder"));

    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0]?.[0]).toBe("om_test");
    expect(replyText.mock.calls[0]?.[1]).toContain("ou_intruder");
    expect(replyText.mock.calls[0]?.[1]).toContain("allowed_open_ids");
  });

  it("stays silent when unauthorized_behavior is ignore", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: new AccessControl({
        allowedOpenIds: [],
        allowedChatIds: ["oc_test"],
        unauthorizedBehavior: "ignore",
      }),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_intruder"));

    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });
});

describe("FeishuGateway chat allowlist (COREBYTE hardening)", () => {
  function allowAlice(chatIds: string[]): AccessControl {
    return new AccessControl({
      allowedOpenIds: ["ou_alice"],
      allowedChatIds: chatIds,
      unauthorizedBehavior: "reject",
    });
  }

  it("delivers messages from an allowlisted chat by an allowed sender", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_alice", "oc_team"));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(replyText).not.toHaveBeenCalled();
  });

  it("silently drops messages from a non-allowlisted chat even for an allowed sender", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_alice", "oc_other"));

    expect(onMessage).not.toHaveBeenCalled();
    // Chat filter runs BEFORE the open_id check: no "reject" reply leaks out.
    expect(replyText).not.toHaveBeenCalled();
  });

  it("drops unauthorized senders in a non-allowlisted chat without replying, even with reject behavior", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_intruder", "oc_other"));

    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("routes card actions from an allowlisted chat", async () => {
    const onCardAction = vi.fn(async () => undefined);
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText: vi.fn() },
      onCardAction: onCardAction as unknown as CardActionHandler,
    });

    await handleCardAction(gateway, {
      operator: { open_id: "ou_alice" },
      action: { value: { kind: "permission", request_id: "r1", choice: "allow" } },
      context: { open_chat_id: "oc_team", open_message_id: "om_card" },
    });

    expect(onCardAction).toHaveBeenCalledTimes(1);
  });

  it("drops card actions from a non-allowlisted chat", async () => {
    const onCardAction = vi.fn(async () => undefined);
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText: vi.fn() },
      onCardAction: onCardAction as unknown as CardActionHandler,
    });

    await handleCardAction(gateway, {
      operator: { open_id: "ou_alice" },
      action: { value: { kind: "permission", request_id: "r1", choice: "allow" } },
      context: { open_chat_id: "oc_other" },
    });

    expect(onCardAction).not.toHaveBeenCalled();
  });

  it("drops card actions that carry no chat context at all", async () => {
    const onCardAction = vi.fn(async () => undefined);
    const gateway = makeGateway({
      access: allowAlice(["oc_team"]),
      feishuClient: { replyText: vi.fn() },
      onCardAction: onCardAction as unknown as CardActionHandler,
    });

    await handleCardAction(gateway, {
      operator: { open_id: "ou_alice" },
      action: { value: { kind: "permission", request_id: "r1", choice: "allow" } },
    });

    expect(onCardAction).not.toHaveBeenCalled();
  });
});

describe("FeishuGateway shared-group mention gate (COREBYTE hardening)", () => {
  const OUR_OPEN_ID = "ou_claude_bot";
  const OTHER_BOT_OPEN_ID = "ou_codex_bot";

  const OUR_IDENTITY: BotIdentity = {
    openId: OUR_OPEN_ID,
    appName: "corebyte-claude",
  };

  function access(): AccessControl {
    return new AccessControl({
      allowedOpenIds: ["ou_alice"],
      allowedChatIds: ["oc_shared"],
      unauthorizedBehavior: "reject",
    });
  }

  function groupEvent(args: {
    mentions?: ReceiveV1Event["message"]["mentions"];
    chatType?: string;
    senderType?: string;
    text?: string;
  }): ReceiveV1Event {
    return {
      sender: {
        sender_id: { open_id: "ou_alice" },
        ...(args.senderType === undefined ? {} : { sender_type: args.senderType }),
      },
      message: {
        message_id: "om_test",
        chat_id: "oc_shared",
        chat_type: args.chatType ?? "group",
        message_type: "text",
        content: JSON.stringify({ text: args.text ?? "@_user_1 /help" }),
        create_time: "1700000000000",
        ...(args.mentions ? { mentions: args.mentions } : {}),
      },
    };
  }

  function setup(args: {
    requireMention?: boolean;
    resolveBotIdentity?: () => Promise<BotIdentity>;
  } = {}) {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: access(),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
      requireMention: args.requireMention ?? true,
      resolveBotIdentity:
        args.resolveBotIdentity ?? (async (): Promise<BotIdentity> => OUR_IDENTITY),
    });
    return { gateway, onMessage, replyText };
  }

  it("handles a group message that mentions our own open_id", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(
      gateway,
      groupEvent({
        mentions: [
          { key: "@_user_1", id: { open_id: OUR_OPEN_ID }, name: "corebyte-claude" },
        ],
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a group message that mentions a different bot", async () => {
    const { gateway, onMessage, replyText } = setup();
    await handleReceiveV1(
      gateway,
      groupEvent({
        mentions: [
          { key: "@_user_1", id: { open_id: OTHER_BOT_OPEN_ID }, name: "corebyte-codex" },
        ],
      }),
    );
    expect(onMessage).not.toHaveBeenCalled();
    // The gate runs before the open_id check, so nothing leaks into the group.
    expect(replyText).not.toHaveBeenCalled();
  });

  it("drops a group message with no mentions at all", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(gateway, groupEvent({ text: "just chatting" }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("leaves p2p chats untouched by the gate", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(
      gateway,
      groupEvent({ chatType: "p2p", text: "hello there" }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("treats an unknown chat_type as a group (fails closed)", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(
      gateway,
      groupEvent({ chatType: "topic_group", text: "hello there" }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("require_mention = false restores the old behaviour", async () => {
    const resolveBotIdentity = vi.fn(async (): Promise<BotIdentity> => OUR_IDENTITY);
    const { gateway, onMessage } = setup({
      requireMention: false,
      resolveBotIdentity,
    });
    await handleReceiveV1(
      gateway,
      groupEvent({
        mentions: [{ key: "@_user_1", id: { open_id: OTHER_BOT_OPEN_ID } }],
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    // No bot-info lookup is needed when the gate is off.
    expect(resolveBotIdentity).not.toHaveBeenCalled();
  });

  it("resolves the bot identity only once across several messages", async () => {
    const resolveBotIdentity = vi.fn(async (): Promise<BotIdentity> => OUR_IDENTITY);
    const { gateway, onMessage } = setup({ resolveBotIdentity });
    const mentions = [{ key: "@_user_1", id: { open_id: OUR_OPEN_ID } }];
    await handleReceiveV1(gateway, groupEvent({ mentions }));
    const second = groupEvent({ mentions });
    second.message.message_id = "om_test_2";
    await handleReceiveV1(gateway, second);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(resolveBotIdentity).toHaveBeenCalledTimes(1);
  });

  it("falls back to matching the app_name when open_id is unavailable", async () => {
    const { gateway, onMessage } = setup({
      resolveBotIdentity: async () => ({ appName: "corebyte-claude" }),
    });
    await handleReceiveV1(
      gateway,
      groupEvent({
        mentions: [{ key: "@_user_1", name: "corebyte-claude" }],
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a group message mentioning another bot's name in the fallback path", async () => {
    const { gateway, onMessage } = setup({
      resolveBotIdentity: async () => ({ appName: "corebyte-claude" }),
    });
    await handleReceiveV1(
      gateway,
      groupEvent({ mentions: [{ key: "@_user_1", name: "corebyte-codex" }] }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("fails closed in group chats when the bot-info call fails", async () => {
    const resolveBotIdentity = vi.fn(async (): Promise<BotIdentity> => {
      throw new Error("bot info unavailable");
    });
    const { gateway, onMessage, replyText } = setup({ resolveBotIdentity });
    await handleReceiveV1(
      gateway,
      groupEvent({ mentions: [{ key: "@_user_1", id: { open_id: OUR_OPEN_ID } }] }),
    );
    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
    expect(resolveBotIdentity).toHaveBeenCalledTimes(1);
  });

  it("still serves p2p chats when the bot-info call fails", async () => {
    const { gateway, onMessage } = setup({
      resolveBotIdentity: async () => {
        throw new Error("bot info unavailable");
      },
    });
    await handleReceiveV1(gateway, groupEvent({ chatType: "p2p", text: "hi" }));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when bot info carries neither open_id nor app_name", async () => {
    const { gateway, onMessage } = setup({ resolveBotIdentity: async () => ({}) });
    await handleReceiveV1(
      gateway,
      groupEvent({ mentions: [{ key: "@_user_1", id: { open_id: OUR_OPEN_ID } }] }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("retries the bot-info call after a failure", async () => {
    let calls = 0;
    const resolveBotIdentity = vi.fn(async (): Promise<BotIdentity> => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return OUR_IDENTITY;
    });
    const { gateway, onMessage } = setup({ resolveBotIdentity });
    const mentions = [{ key: "@_user_1", id: { open_id: OUR_OPEN_ID } }];
    await handleReceiveV1(gateway, groupEvent({ mentions }));
    expect(onMessage).not.toHaveBeenCalled();
    const second = groupEvent({ mentions });
    second.message.message_id = "om_test_2";
    await handleReceiveV1(gateway, second);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(resolveBotIdentity).toHaveBeenCalledTimes(2);
  });
});

describe("FeishuGateway bot-sender gate (COREBYTE hardening)", () => {
  function setup() {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: new AccessControl({
        allowedOpenIds: ["ou_alice", "ou_other_bot"],
        allowedChatIds: ["oc_shared"],
        unauthorizedBehavior: "reject",
      }),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });
    return { gateway, onMessage, replyText };
  }

  function event(senderType: string | undefined, openId = "ou_alice"): ReceiveV1Event {
    return {
      sender: {
        sender_id: { open_id: openId },
        ...(senderType === undefined ? {} : { sender_type: senderType }),
      },
      message: {
        message_id: "om_bot",
        chat_id: "oc_shared",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1700000000000",
      },
    };
  }

  it("drops messages sent by another app (sender_type = app)", async () => {
    const { gateway, onMessage, replyText } = setup();
    await handleReceiveV1(gateway, event("app", "ou_other_bot"));
    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });

  it("drops any non-user sender_type", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(gateway, event("system"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handles messages sent by a human (sender_type = user)", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(gateway, event("user"));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a missing sender_type as a human so the bridge cannot mute itself", async () => {
    const { gateway, onMessage } = setup();
    await handleReceiveV1(gateway, event(undefined));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe("toLarkDomain", () => {
  it("maps config values onto the Lark SDK Domain enum", () => {
    expect(toLarkDomain("lark")).toBe(Domain.Lark);
    expect(toLarkDomain("feishu")).toBe(Domain.Feishu);
  });
});
