import type { Logger } from "pino";
import type { ReceiveV1Event } from "./types.js";
import type { IncomingMessage } from "../types.js";
import { detectImageMime } from "./image-mime.js";
import { parsePost, type ParsedPost } from "./post-parser.js";
import { stripMentions } from "./mentions.js";

export interface FeishuImageClient {
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
}

/**
 * Translate a raw Feishu `im.message.receive_v1` event into an internal
 * `IncomingMessage`. Returns `null` if the event should be dropped
 * (unparseable content, download failure, unsupported type, empty
 * post). All drop decisions are logged here so the caller only needs
 * to check for null.
 */
export async function translateReceiveEvent(
  event: ReceiveV1Event,
  client: FeishuImageClient,
  log: Logger,
  ownBotOpenId?: string,
): Promise<IncomingMessage | null> {
  const msgType = event.message.message_type;
  let text = "";
  let imageDataUris: string[] | undefined;

  if (msgType === "text") {
    try {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      // COREBYTE hardening: strip Lark's inline @mention placeholders
      // (`@_user_1`, `@_all`) before anything downstream sees the text.
      // In the shared COREBYTE group every message addressed to this bot
      // starts with a mention, so without this "@corebyte-claude /stop"
      // would reach the command router as "@_user_1 /stop" and never
      // parse as a command.
      text = stripMentions(parsed.text ?? "", event.message.mentions);
    } catch (err) {
      log.error({ err }, "Failed to parse text message content");
      return null;
    }
  } else if (msgType === "image") {
    try {
      const parsed = JSON.parse(event.message.content) as { image_key?: string };
      const imageKey = parsed.image_key;
      if (!imageKey) {
        log.warn({ content: event.message.content }, "Image message has no image_key");
        return null;
      }
      const bytes = await client.downloadImage(event.message.message_id, imageKey);
      imageDataUris = [`data:${detectImageMime(bytes)};base64,${bytes.toString("base64")}`];
      text = "[Image]";
    } catch (err) {
      log.warn({ err }, "Failed to download image — dropping message");
      return null;
    }
  } else if (msgType === "post") {
    let parsed: ParsedPost;
    try {
      // Rich-text posts carry structural `at` nodes, unlike plain-text
      // placeholders. Resolve aliases only from metadata tied to OUR open_id;
      // a matching display name alone is not sufficient to strip a mention.
      const ownMentionIds = new Set<string>();
      if (ownBotOpenId) {
        ownMentionIds.add(ownBotOpenId);
        for (const mention of event.message.mentions ?? []) {
          if (mention.id?.open_id !== ownBotOpenId) continue;
          for (const id of [mention.key, mention.id.user_id, mention.id.union_id]) {
            if (id) ownMentionIds.add(id);
          }
        }
      }
      parsed = parsePost(event.message.content, ownMentionIds);
    } catch (err) {
      log.error({ err }, "Failed to parse post message content");
      return null;
    }
    text = stripMentions(parsed.text, event.message.mentions);

    if (parsed.imageKeys.length > 0) {
      try {
        const buffers = await Promise.all(
          parsed.imageKeys.map((k) =>
            client.downloadImage(event.message.message_id, k),
          ),
        );
        imageDataUris = buffers.map(
          (b) => `data:${detectImageMime(b)};base64,${b.toString("base64")}`,
        );
      } catch (err) {
        log.warn({ err }, "Failed to download post image — dropping message");
        return null;
      }
    }

    if (text.length === 0 && imageDataUris === undefined) {
      log.info("Empty post, dropping");
      return null;
    }
  } else {
    log.info({ message_type: msgType }, "Unsupported message type, dropping");
    return null;
  }

  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    senderOpenId: event.sender.sender_id.open_id,
    text,
    ...(imageDataUris ? { imageDataUris } : {}),
    // Feishu create_time is a stringified Unix milliseconds timestamp
    // (confirmed via open.feishu.cn docs: "消息发送时间（毫秒）"). No
    // conversion needed — IncomingMessage.receivedAt is also in ms.
    receivedAt: Number(event.message.create_time),
  };
}
