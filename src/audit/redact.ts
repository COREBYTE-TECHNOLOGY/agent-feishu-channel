const REDACTED = "[REDACTED]";
const DEFAULT_MAX_CHARS = 8_000;
const SENSITIVE_KEY = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential|signature|(?:^|[_-])(?:sig|key)(?:$|[_-])|密码|密钥|令牌|口令/i;
const FORMATTING_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"`]+/gi;
const GITHUB_REFERENCE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+(?:#[A-Za-z0-9_-]+)?/g;
const KEY = String.raw`(?:[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*|[\u3400-\u9fff]*(?:密码|密钥|令牌|口令))`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.\-\u3400-\u9fff])((?:["']?${KEY}["']?)\s*(?:[:=：]|为|是)\s*)(?:\[REDACTED\]|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\x60[^\x60]*\x60?|[^\s,;&}\])]+)`,
  "gi",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeUrlPart(value: string): string {
  let decoded = value;
  // Catch common percent-encoded/double-encoded keys without an unbounded
  // decode loop. Malformed URL content must not abort journal processing.
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, " "));
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function redactOpaque(text: string): string {
  const withoutBase64 = text.replace(/\b[A-Za-z0-9+\/]{30,}={1,2}(?![A-Za-z0-9=])/g, REDACTED);
  const references = [...withoutBase64.matchAll(GITHUB_REFERENCE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Retain ordinary paths; mixed-case/digit slash-bearing runs may be
  // unpadded base64 and are conservatively treated as opaque identifiers.
  return withoutBase64
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, (value: string, offset: number) => {
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) return value;
      if (references.some(({ start, end }) => offset >= start && offset + value.length <= end)) {
        return value;
      }
      if (value.includes("/") && (value.startsWith("/")
        || !(/[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)))) {
        return value;
      }
      return REDACTED;
    });
}

function neutralizeMarkup(text: string): string {
  return text
    // Keep readable text, but no hidden HTML instructions or image embeds.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, REDACTED)
    .replace(/[<>]/g, (value) => value === "<" ? "&lt;" : "&gt;")
    .replace(/!\[/g, "！[")
    .replace(/&(?:#0*64|#x0*40|commat);/gi, "＠")
    .replace(/@/g, "＠")
    // A journal renderer should still choose a safe outer code fence.
    // Splitting fence runs prevents this text from closing a common fence.
    .replace(/`{3,}|~{3,}/g, (value) => [...value].join("\u200b"));
}

function truncate(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : DEFAULT_MAX_CHARS;
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  let prefix = text.slice(0, limit - 1);
  // Do not split a UTF-16 surrogate pair at the truncation boundary.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

/**
 * corebyte #52: best-effort redaction for approved journal text only.
 * Never pass raw tool output, reasoning, or attachment contents here as a
 * substitute for excluding them at the source. Unknown short/unlabelled or
 * deliberately encoded secrets may evade these heuristics; this is not DLP.
 * Bare 40/64-hex identifiers are retained for Git evidence, so unknown secrets
 * of the same shape require a known-secret entry or a sensitive assignment.
 * The caller must render the result as inert text, not trusted Markdown/HTML.
 */
export function createRedactor(
  knownSecrets: readonly string[],
): (text: string, maxChars?: number) => string {
  const secrets = [...new Set(knownSecrets
    .flatMap((value) => [value, value.replace(FORMATTING_CONTROLS, "")])
    .filter((value) => value.trim().length > 0))]
    .sort((a, b) => b.length - a.length);
  const knownPattern = secrets.length > 0
    ? new RegExp(secrets.map(escapeRegExp).join("|"), "g")
    : null;
  const replaceKnown = (value: string): string => knownPattern === null
    ? value
    : value.replace(knownPattern, () => REDACTED);

  const protectKnownValues = (value: string): string => {
    if (knownPattern === null) return value;
    // Preserve assignment-key syntax until its value has been filtered.
    // Every other known literal is removed before heuristics can split it.
    const keys = [...value.matchAll(ASSIGNMENT)].map((match) => ({
      start: match.index,
      end: match.index + (match[1]?.length ?? 0),
    }));
    return value.replace(knownPattern, (secret: string, offset: number) =>
      keys.some(({ start, end }) => offset >= start && offset + secret.length <= end)
        ? secret
        : REDACTED);
  };

  return (text, maxChars = DEFAULT_MAX_CHARS) => {
    // Formatting controls must not split a recognizable token or mention.
    let cleaned = protectKnownValues(text.replace(FORMATTING_CONTROLS, ""))
      .replace(/<!--[\s\S]*?(?:-->|$)/g, REDACTED)
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED)
      .replace(URL_PATTERN, (url) => url
        .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/i, `$1${REDACTED}@`)
        .replace(/([?&#;])([^=?&#;]+)=([^&#;\s]*)/g, (_match, separator: string, key: string, value: string) => {
          const decoded = decodeUrlPart(value);
          const sensitive = SENSITIVE_KEY.test(decodeUrlPart(key))
            || redactOpaque(replaceKnown(decoded)) !== decoded;
          return `${separator}${key}=${sensitive ? REDACTED : value}`;
        }))
      .replace(/(["']?\b(?:proxy-)?authorization["']?\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, REDACTED)
      .replace(ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`)
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}|LTAI[A-Za-z0-9]{8,}|STS\.[A-Za-z0-9._-]{8,})\b/g, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(/\b(?:ou|oc|cli)_[A-Za-z0-9_-]+\b/g, REDACTED);
    // Detect labelled values before replacing known literals: a known value
    // that is also a key word must not disable assignment recognition.
    cleaned = replaceKnown(cleaned);
    cleaned = redactOpaque(cleaned);
    return truncate(neutralizeMarkup(cleaned), maxChars);
  };
}
