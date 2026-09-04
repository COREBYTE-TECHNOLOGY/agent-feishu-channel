import {
  Client as LarkClient,
  Domain,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { FeishuDomain, IncomingMessage } from "../types.js";
import type { AccessControl } from "../access.js";
import type { FeishuCardV2 } from "./card-types.js";
import { LruDedup } from "../util/dedup.js";
import { FeishuClient } from "./client.js";
import type { ReceiveV1Event } from "./types.js";
import { translateReceiveEvent } from "./message-translator.js";

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface CardActionEvent {
  operator: {
    open_id: string;
  };
  action: {
    value: Record<string, unknown>;
  };
  /**
   * Card callback context. `open_chat_id` is the chat the card lives in;
   * the COREBYTE chat allowlist is enforced on it. Optional in the type
   * because the SDK does not guarantee it — a missing chat id is treated
   * as NOT allowed.
   */
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  // The event carries more fields (token, tenant_key, form_value...)
  // that we do not read.
}

/**
 * Result of handling a card action. If a `card` is returned, the
 * gateway sends it back in the `card.action.trigger` callback response
 * body as `{ card: { type: "raw", data: card } }`, which is the
 * documented mechanism Feishu uses to update the displayed card after
 * a button click. Returning `void` (or undefined) leaves the card
 * unchanged.
 */
export type CardActionResult = { card?: FeishuCardV2 } | void;

export type CardActionHandler = (action: {
  senderOpenId: string;
  value: Record<string, unknown>;
}) => Promise<CardActionResult>;

/** Map our config value onto the Lark SDK's `Domain` enum. */
export function toLarkDomain(domain: FeishuDomain): Domain {
  return domain === "feishu" ? Domain.Feishu : Domain.Lark;
}

export interface FeishuGatewayOptions {
  appId: string;
  appSecret: string;
  /** Lark international ("lark") or Feishu China ("feishu"). */
  domain: FeishuDomain;
  logger: Logger;
  lark: LarkClient;
  feishuClient: FeishuClient;
  access: AccessControl;
  onMessage: MessageHandler;
  onCardAction: CardActionHandler;
}

export class FeishuGateway {
  private readonly lark: LarkClient;
  private readonly wsClient: WSClient;
  private readonly dedup = new LruDedup(1000);
  private readonly logger: Logger;
  private readonly access: AccessControl;
  private readonly feishuClient: FeishuClient;
  private readonly onMessage: MessageHandler;
  private readonly onCardAction: CardActionHandler;

  constructor(opts: FeishuGatewayOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger.child({ component: "feishu-gateway" });
    this.access = opts.access;
    this.feishuClient = opts.feishuClient;
    this.onMessage = opts.onMessage;
    this.onCardAction = opts.onCardAction;

    this.wsClient = new WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: toLarkDomain(opts.domain),
      loggerLevel: 2, // lark sdk's "warn"
    });
  }

  async start(): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const event = data as ReceiveV1Event;
        await this.handleReceiveV1(event);
      },
      "card.action.trigger": async (data: unknown) => {
        const result = await this.handleCardAction(data as CardActionEvent);
        // Feishu's card callback response schema supports
        // `{ card: { type: "raw", data: <FeishuCardV2> } }` to update
        // the displayed card in place. The Lark WSClient base64-encodes
        // whatever we return here into the response payload (see
        // WSClient.handleEventData in the node-sdk), so this is the
        // supported click-to-update mechanism.
        if (result && result.card) {
          return { card: { type: "raw", data: result.card } };
        }
        return {};
      },
    });

    this.logger.info("Starting Feishu WebSocket client");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  private async handleReceiveV1(event: ReceiveV1Event): Promise<void> {
    const log = this.logger.child({
      message_id: event.message.message_id,
      chat_id: event.message.chat_id,
    });

    if (this.dedup.check(event.message.message_id)) {
      log.debug("Duplicate message, skipping");
      return;
    }

    // COREBYTE hardening: chat allowlist runs BEFORE the open_id check so
    // an allowed user cannot drive the bot from an unlisted chat either.
    if (!this.access.isChatAllowed(event.message.chat_id)) {
      log.debug("Message from non-allowlisted chat, dropping");
      return;
    }

    const decision = this.access.check(event.sender.sender_id.open_id);
    if (!decision.allowed) {
      const senderOpenId = event.sender.sender_id.open_id;
      log.warn(
        { open_id: senderOpenId, action: decision.action },
        "Unauthorized sender",
      );
      if (decision.action === "reject") {
        try {
          await this.feishuClient.replyText(
            event.message.message_id,
            [
              "Unauthorized sender.",
              `Your open_id is: ${senderOpenId}`,
              "Ask the bot owner to add it to [access].allowed_open_ids in config.toml.",
            ].join("\n"),
          );
        } catch (err) {
          log.warn({ err }, "Failed to send unauthorized reject reply");
        }
      }
      return;
    }

    const incoming = await translateReceiveEvent(event, this.feishuClient, log);
    if (incoming === null) return;

    try {
      await this.onMessage(incoming);
    } catch (err) {
      log.error({ err }, "Message handler threw");
    }
  }

  private async handleCardAction(
    event: CardActionEvent,
  ): Promise<CardActionResult> {
    const chatId = event.context?.open_chat_id;
    const log = this.logger.child({
      open_id: event.operator.open_id,
      chat_id: chatId,
    });
    // COREBYTE hardening: drop card clicks from chats outside the allowlist
    // (or with no chat context at all) before anything else.
    if (!this.access.isChatAllowed(chatId)) {
      log.debug("Card action from non-allowlisted chat, dropping");
      return;
    }
    log.info(
      { value: event.action.value },
      "card.action.trigger received",
    );
    const decision = this.access.check(event.operator.open_id);
    if (!decision.allowed) {
      log.warn(
        { action: decision.action },
        "Unauthorized card action, ignoring",
      );
      return;
    }
    try {
      return await this.onCardAction({
        senderOpenId: event.operator.open_id,
        value: event.action.value,
      });
    } catch (err) {
      log.error({ err }, "Card action handler threw");
      return;
    }
  }
}
