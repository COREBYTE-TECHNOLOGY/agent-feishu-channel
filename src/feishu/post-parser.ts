export interface ParsedPost {
  /** Paragraphs joined by "\n\n", trimmed. May be empty. */
  text: string;
  /** Inline image_key values in document order. May be empty. */
  imageKeys: string[];
}

interface PostElement {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  emoji_type?: string;
  image_key?: string;
  un_escape?: boolean;
}

interface PostEnvelope {
  title?: string;
  content?: unknown;
}

const ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
};

function unescapeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

function renderElement(
  el: PostElement,
  imageKeys: string[],
  ownMentionIds: ReadonlySet<string>,
): string {
  switch (el.tag) {
    case "text": {
      const text = el.text ?? "";
      return el.un_escape === true ? unescapeEntities(text) : text;
    }
    case "a":
      return `${el.text ?? ""} (${el.href ?? ""})`;
    case "at":
      // Remove only a structural mention whose identity was resolved to
      // this bot. Never strip a display name or ordinary body text.
      // A space prevents removal from concatenating two command fragments.
      if (el.user_id && ownMentionIds.has(el.user_id)) return " ";
      return `@${el.user_name ?? el.user_id ?? "user"}`;
    case "emotion":
      return `:${el.emoji_type ?? ""}:`;
    case "img":
    case "media": {
      if (typeof el.image_key === "string" && el.image_key.length > 0) {
        imageKeys.push(el.image_key);
      }
      return "";
    }
    default:
      return "";
  }
}

/**
 * Flatten a Feishu `post` message content string into plain text plus
 * an ordered list of inline image_keys. Throws on malformed JSON or
 * when the envelope lacks a content array.
 */
export function parsePost(
  rawContent: string,
  ownMentionIds: ReadonlySet<string> = new Set(),
): ParsedPost {
  const envelope = JSON.parse(rawContent) as PostEnvelope;
  if (!Array.isArray(envelope.content)) {
    throw new Error("parsePost: `content` is not an array");
  }

  const imageKeys: string[] = [];
  const paragraphs: string[] = [];

  const title = envelope.title?.trim();
  if (title && title.length > 0) {
    paragraphs.push(title);
  }

  for (const paragraph of envelope.content) {
    if (!Array.isArray(paragraph)) {
      throw new Error("parsePost: paragraph is not an array");
    }
    const rendered = (paragraph as PostElement[])
      .map((el) => renderElement(el, imageKeys, ownMentionIds))
      .join("");
    if (rendered.length > 0) {
      paragraphs.push(rendered);
    }
  }

  return {
    text: paragraphs.join("\n\n").trim(),
    imageKeys,
  };
}
