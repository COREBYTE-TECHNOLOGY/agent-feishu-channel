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
import { LruDedup, type DedupChecker } from "../util/dedup.js";
import { FeishuClient, type BotIdentity } from "./client.js";
import type { ReceiveV1Event } from "./types.js";
import { translateReceiveEvent } from "./message-translator.js";
import { mentionsName, mentionsOpenId } from "./mentions.js";

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
  /**
   * COREBYTE hardening (shared-group model): when true, group messages
   * are only handled if they @mention THIS bot. All three COREBYTE bots
   * live in one Lark group, and the @mention is what routes a message
   * to one of them. Direct (p2p) chats are never gated.
   */
  requireMention: boolean;
  onMessage: MessageHandler;
  onCardAction: CardActionHandler;
  /**
   * Resolves this app's own bot identity. Defaults to
   * `feishuClient.getBotIdentity()`; injectable so tests never touch
   * the network.
   */
  resolveBotIdentity?: () => Promise<BotIdentity>;
  /**
   * Dedup cache for inbound `message_id`s. Defaults to an in-memory
   * LRU; production injects a `PersistentDedup` so that a message which
   * killed the process is not reprocessed after launchd restarts us and
   * Lark redelivers the event.
   */
  dedup?: DedupChecker;
}

export class FeishuGateway {
  private readonly lark: LarkClient;
  private readonly wsClient: WSClient;
  private readonly dedup: DedupChecker;
  private readonly logger: Logger;
  private readonly access: AccessControl;
  private readonly feishuClient: FeishuClient;
  private readonly onMessage: MessageHandler;
  private readonly onCardAction: CardActionHandler;
  private readonly requireMention: boolean;
  private readonly resolveBotIdentity: () => Promise<BotIdentity>;
  /** Memoized bot identity; `null` once resolution has failed. */
  private botIdentity: BotIdentity | null = null;
  private botIdentityPromise: Promise<BotIdentity | null> | null = null;

  constructor(opts: FeishuGatewayOptions) {
    this.lark = opts.lark;
    this.dedup = opts.dedup ?? new LruDedup(1000);
    this.logger = opts.logger.child({ component: "feishu-gateway" });
    this.access = opts.access;
    this.feishuClient = opts.feishuClient;
    this.onMessage = opts.onMessage;
    this.onCardAction = opts.onCardAction;
    this.requireMention = opts.requireMention;
    this.resolveBotIdentity =
      opts.resolveBotIdentity ?? (() => this.feishuClient.getBotIdentity());

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

    // COREBYTE hardening: resolve our own open_id once, before the
    // socket opens, so the very first group message can be matched
    // against it. Failures are non-fatal here (the bot still serves p2p
    // chats) but make the mention gate fail closed for group chats.
    await this.ensureBotIdentity();

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

    // COREBYTE hardening: never react to another app's messages. The
    // three COREBYTE bots share one group, so a bot's own output is a
    // plausible trigger for the others. Lark sets sender_type to "app"
    // for bots and "user" for humans; a MISSING value is treated as a
    // human so an SDK/payload change cannot silently mute the bridge.
    const senderType = event.sender.sender_type;
    if (typeof senderType === "string" && senderType !== "user") {
      log.debug({ sender_type: senderType }, "Message from a non-user sender, dropping");
      return;
    }

    // COREBYTE hardening: chat allowlist runs BEFORE the open_id check so
    // an allowed user cannot drive the bot from an unlisted chat either.
    if (!this.access.isChatAllowed(event.message.chat_id)) {
      log.debug("Message from non-allowlisted chat, dropping");
      return;
    }

    // COREBYTE hardening: mention gate. Runs BEFORE the open_id check so
    // a message addressed to one of the other two bots never draws an
    // "Unauthorized sender" reply out of this one.
    if (!(await this.isAddressedToUs(event, log))) return;

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

    const incoming = await translateReceiveEvent(
      event, this.feishuClient, log, this.botIdentity?.openId,
    );
    if (incoming === null) return;

    try {
      await this.onMessage(incoming);
    } catch (err) {
      log.error({ err }, "Message handler threw");
    }
  }

  /**
   * Resolve (and memoize) this app's own bot identity. Returns `null`
   * when the Lark bot-info call failed; the failure is logged once.
   */
  private async ensureBotIdentity(): Promise<BotIdentity | null> {
    if (this.botIdentity !== null) return this.botIdentity;
    if (this.botIdentityPromise === null) {
      this.botIdentityPromise = this.resolveBotIdentity()
        .then((identity) => {
          if (!identity.openId) {
            this.logger.warn(
              { identity },
              "Bot info returned no open_id; mention matching will fall back to app_name",
            );
          } else {
            this.logger.info(
              { open_id: identity.openId, app_name: identity.appName },
              "Resolved own bot identity",
            );
          }
          this.botIdentity = identity;
          return identity;
        })
        .catch((err: unknown) => {
          this.logger.warn(
            { err },
            "Failed to resolve own bot identity via GET /open-apis/bot/v3/info; " +
              "group messages will be dropped while access.require_mention is true",
          );
          // Allow a later retry rather than caching the failure forever.
          this.botIdentityPromise = null;
          return null;
        });
    }
    return this.botIdentityPromise;
  }

  /**
   * COREBYTE hardening: true when this event should be handled by THIS
   * bot.
   *
   * In the shared COREBYTE group, `@mention` is the routing mechanism:
   * without the "获取群组中所有消息" scope (which we do not grant) Lark
   * only delivers group messages that mention us, and the mention also
   * tells the three bots apart. p2p chats are never gated. When our own
   * identity cannot be resolved at all, group messages are DROPPED
   * (fail closed) instead of being handled by every bot at once.
   */
  private async isAddressedToUs(
    event: ReceiveV1Event,
    log: Logger,
  ): Promise<boolean> {
    if (!this.requireMention) return true;
    // Only p2p is exempt; an unknown chat_type is treated as a group.
    if (event.message.chat_type === "p2p") return true;

    const identity = await this.ensureBotIdentity();
    if (identity === null) {
      log.warn(
        "Own bot identity unknown, dropping group message (access.require_mention " +
          "fails closed; check the app's bot info permissions)",
      );
      return false;
    }

    const mentions = event.message.mentions;
    if (mentionsOpenId(mentions, identity.openId)) return true;
    if (!identity.openId && mentionsName(mentions, identity.appName)) {
      log.debug("Matched mention by app_name fallback");
      return true;
    }

    if (!identity.openId && !identity.appName) {
      log.warn(
        "Bot info carried neither open_id nor app_name, dropping group message",
      );
      return false;
    }

    log.debug(
      { mentions: mentions?.map((m) => m.id?.open_id) },
      "Group message does not mention this bot, dropping",
    );
    return false;
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
