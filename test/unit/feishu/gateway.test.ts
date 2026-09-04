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
import type { FeishuClient } from "../../../src/feishu/client.js";
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
}): FeishuGateway {
  return new FeishuGateway({
    appId: "cli_test",
    appSecret: "secret",
    domain: "lark",
    logger: SILENT,
    lark: {} as never,
    feishuClient: args.feishuClient as FeishuClient,
    access: args.access,
    onMessage: args.onMessage ?? (async () => {}),
    onCardAction: args.onCardAction ?? vi.fn(),
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

describe("toLarkDomain", () => {
  it("maps config values onto the Lark SDK Domain enum", () => {
    expect(toLarkDomain("lark")).toBe(Domain.Lark);
    expect(toLarkDomain("feishu")).toBe(Domain.Feishu);
  });
});
