import type { AgentProvider } from "../types.js";
import { t, type Locale } from "../util/i18n.js";

export type TurnFailureKind = "provider_auth" | "generic";

/**
 * Provider startup / credential failures.
 *
 * These are the failures where the operator — not the chat user — has
 * to do something on the host, so they get a specific, actionable
 * message instead of a raw error string. The canonical production case
 * is the Claude Agent SDK surfacing
 * `Claude Code returned an error result: Not logged in · Please run /login`
 * when the `claude` CLI's credentials have expired.
 *
 * Deliberately narrow: anything not matched here falls back to the
 * generic "本次执行失败：<reason>" text, which is never wrong, just
 * less helpful.
 */
const PROVIDER_AUTH_PATTERNS: readonly RegExp[] = [
  /\bnot logged\s?in\b/i,
  /\bplease run\s+\/login\b/i,
  /\bplease run\s+`?codex login`?\b/i,
  /\brun\s+`?codex login`?\b/i,
  /\blogin required\b/i,
  /\bnot authenticated\b/i,
  /\bauthentication[_ ]error\b/i,
  /\binvalid api key\b/i,
  /\boauth token (?:has )?expired\b/i,
  /\bcredentials?\b.*\bexpired\b/i,
];

/** Text of an arbitrary thrown value, for matching and for display. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export function classifyTurnFailure(err: unknown): TurnFailureKind {
  const text = errorText(err);
  return PROVIDER_AUTH_PATTERNS.some((re) => re.test(text))
    ? "provider_auth"
    : "generic";
}

/**
 * Render the chat message posted into the originating conversation when
 * a turn fails. The human must never be left staring at silence — that
 * was the other half of the production defect: the process died before
 * any reply was sent, so the chat showed nothing at all.
 */
export function formatTurnFailure(opts: {
  err: unknown;
  provider: AgentProvider;
  locale?: Locale;
}): string {
  const locale = opts.locale ?? "zh";
  const strings = t(locale);
  const reason = errorText(opts.err);

  if (classifyTurnFailure(opts.err) === "provider_auth") {
    const isCodex = opts.provider === "codex";
    return strings.turnFailedAuth(
      isCodex ? "Codex CLI" : "Claude Code CLI",
      isCodex ? strings.loginHintCodex : strings.loginHintClaude,
      reason,
    );
  }
  return strings.turnFailed(reason);
}
