/**
 * Shared Feishu event / transport types used across the gateway and
 * the message translator.
 */

import type { FeishuMention } from "./mentions.js";

/**
 * Payload of the `im.message.receive_v1` event, narrowed to the fields
 * our translator and gateway actually consume. The upstream event
 * carries more fields (parent_id, message_type-specific extras, ...) --
 * add them here as we start reading them.
 */
export interface ReceiveV1Event {
  sender: {
    sender_id: {
      open_id: string;
    };
    /**
     * COREBYTE hardening: `"user"` for humans, `"app"` for bots. The
     * gateway drops anything that is explicitly not a user so the three
     * COREBYTE bots sharing one group can never react to each other.
     * Optional because older payloads / fixtures may omit it; a missing
     * value is treated as a human (see gateway).
     */
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    /** `"p2p"` for 1:1 chats, `"group"` for group chats. */
    chat_type?: string;
    message_type: string;
    content: string; // JSON-encoded
    create_time: string;
    /**
     * Present when the message @mentions somebody. Each entry maps an
     * inline placeholder (`key`, e.g. `@_user_1`) to the mentioned
     * user's or bot's ids and display name.
     */
    mentions?: FeishuMention[];
  };
}
