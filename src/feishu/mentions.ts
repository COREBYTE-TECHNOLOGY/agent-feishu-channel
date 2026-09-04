/**
 * COREBYTE hardening: mention handling for the shared-group model.
 *
 * The three COREBYTE bots (corebyte-hermes, corebyte-claude,
 * corebyte-codex) live in ONE Lark group. Without the
 * "获取群组中所有消息 / im:message.group_msg" scope -- which we
 * deliberately do NOT grant -- a bot only receives
 * `im.message.receive_v1` for messages that @mention it, so the
 * @mention is the routing mechanism.
 *
 * Two consequences are handled here:
 *
 * 1. Lark delivers the mention inline in `message.content` as an opaque
 *    placeholder (`@_user_1`, `@_all`), so a message typed as
 *    "@corebyte-claude /stop" arrives as "@_user_1 /stop" and no
 *    command parser anchored at the start of the string can ever match
 *    it. `stripMentions` removes those placeholders.
 * 2. The bridge must be able to tell "this message mentions ME" from
 *    "this message mentions the other bot in the same group".
 *    `mentionsOpenId` / `mentionsName` answer that.
 */

/**
 * One entry of `im.message.receive_v1`'s `message.mentions` array.
 * Everything is optional because the field is only present when the
 * message actually carries mentions, and older payloads may omit
 * `id` / `name`.
 */
export interface FeishuMention {
  /** Placeholder as it appears inline in the content, e.g. `@_user_1`. */
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  /** Display name of the mentioned user or bot. */
  name?: string;
  tenant_key?: string;
}

/** Placeholders Lark always uses, even when `mentions` is absent. */
const BUILTIN_MENTION_SOURCE = "@_user_\\d+|@_all";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove Lark's inline mention placeholders from `text`.
 *
 * Every `key` in `mentions` is removed, plus the built-in `@_user_N`
 * and `@_all` forms (defensive: a payload can carry the placeholder
 * without a matching `mentions` entry). Horizontal whitespace around a
 * removed placeholder collapses to a single space when the placeholder
 * sat between two words, and disappears entirely at the start or end,
 * so "@_user_1 /stop" becomes "/stop" and "看 @_user_1 这里" becomes
 * "看 这里". The result is trimmed. Newlines are preserved: only
 * spaces and tabs adjacent to a removed placeholder are touched.
 */
export function stripMentions(
  text: string,
  mentions?: readonly FeishuMention[] | null,
): string {
  if (typeof text !== "string" || text.length === 0) return "";

  const customKeys = (mentions ?? [])
    .map((m) => m?.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    // Longest first so "@_user_11" is not eaten by "@_user_1".
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);

  const alternation = [...customKeys, BUILTIN_MENTION_SOURCE].join("|");
  const pattern = new RegExp(`[ \\t]*(?:${alternation})[ \\t]*`, "g");

  const cleaned = text.replace(pattern, (match: string, offset: number) => {
    const atStart = offset === 0;
    const atEnd = offset + match.length === text.length;
    return atStart || atEnd ? "" : " ";
  });

  return cleaned.trim();
}

/** True when any mention resolves to `openId` (empty ids never match). */
export function mentionsOpenId(
  mentions: readonly FeishuMention[] | undefined | null,
  openId: string | undefined,
): boolean {
  if (typeof openId !== "string" || openId.length === 0) return false;
  return (mentions ?? []).some((m) => m?.id?.open_id === openId);
}

/**
 * True when any mention's display name equals `name`. Fallback path
 * only -- used when the bot's own open_id could not be resolved but its
 * app name could. Display names are not unique, so this is deliberately
 * the second choice.
 */
export function mentionsName(
  mentions: readonly FeishuMention[] | undefined | null,
  name: string | undefined,
): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  return (mentions ?? []).some((m) => m?.name === name);
}
