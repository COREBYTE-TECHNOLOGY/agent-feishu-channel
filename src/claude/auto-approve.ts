import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Logger } from "pino";
import { isWithinDirectory } from "../config.js";

/**
 * COREBYTE hardening — scoped auto-approve.
 *
 * Because the bridge hands the Claude Agent SDK a `canUseTool`
 * callback, the SDK routes **every** tool call through it, including
 * the read-only ones plain Claude Code never prompts for. One real
 * Lark conversation produced 81 permission cards (51 Bash / 29 Read /
 * 1 Skill) and the operator clicked 一律同意 97 times. A human clicking
 * 97 cards is not reviewing any of them — that is worse security than
 * a narrow, auditable auto-approve.
 *
 * This module answers exactly one question: "may this tool call skip
 * the card?" It is fail-closed everywhere — every unknown tool,
 * unparseable input, unreadable rules file and filesystem error ends
 * in `{ approve: false }`, i.e. the card the operator sees today.
 */

/** Read-only tools that may auto-approve when every path stays in cwd. */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
]);

/** Tools with no filesystem reach at all — auto-approve unconditionally. */
export const PATH_FREE_AUTO_TOOLS: ReadonlySet<string> = new Set(["TodoWrite"]);

/**
 * Tools that change state or leave the workspace. These ALWAYS card,
 * no matter what the config or a project rule says. `mcp__*` is
 * handled separately by prefix.
 */
export const NEVER_AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
]);

/** Input keys whose value is a single filesystem path. */
const PATH_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "dir",
  "directory",
] as const;

/** Input keys whose value is an array of filesystem paths. */
const PATH_ARRAY_KEYS = ["file_paths", "paths"] as const;

/**
 * Keys that are normally patterns, not paths (`Glob.pattern`,
 * `Grep.glob`). We only treat them as paths when they *look* like an
 * escape attempt — absolute, `..`-bearing or `~`-rooted — so a plain
 * `**\/*.ts` does not force a card while `../../other-repo/**` does.
 */
const PATTERN_KEYS = ["pattern", "glob"] as const;

export type AutoApproveDecision =
  | { approve: true; reason: string }
  | { approve: false; reason: string };

export interface AutoApproveConfig {
  /** `[access] auto_approve_readonly` */
  autoApproveReadonly: boolean;
  /** `[access] honor_project_permissions` */
  honorProjectPermissions: boolean;
}

export interface AutoApproverOptions {
  config: AutoApproveConfig;
  /**
   * Upper bound for the `.claude/settings.json` walk-up — normally
   * `agent.default_cwd`. Never read a settings file above this.
   */
  boundaryCwd: string;
  logger: Logger;
}

// --- path helpers ------------------------------------------------------

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function looksLikeEscape(value: string): boolean {
  if (value.startsWith("~")) return true;
  if (isAbsolute(value)) return true;
  if (value === ".." || value.startsWith("../")) return true;
  if (value.includes("/../") || value.endsWith("/..")) return true;
  return false;
}

/**
 * Collect every value in a tool input that we are willing to treat as
 * a filesystem path. Deliberately key-driven rather than "every string
 * that contains a slash": a Grep *pattern* is a regex, not a path, and
 * flagging it would card half the read-only calls for nothing. Escape-
 * shaped patterns are still picked up via {@link PATTERN_KEYS}.
 */
export function extractPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  for (const key of PATH_ARRAY_KEYS) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) out.push(entry);
      }
    }
  }
  for (const key of PATTERN_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0 && looksLikeEscape(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Resolve `path` as far as the filesystem allows: `fs.realpath` on the
 * deepest existing ancestor (so a symlinked directory cannot smuggle a
 * path out of the tree), with the non-existent tail re-appended
 * lexically. Falls back to `path.resolve` when nothing resolves.
 */
export async function realpathBestEffort(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when every path in `input` resolves inside `cwd`. `~` is
 * expanded before resolution, so `~/.ssh/id_rsa` is recognised as the
 * escape it is instead of being resolved to `<cwd>/~/.ssh/id_rsa`.
 */
export async function allPathsWithinCwd(
  cwd: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const paths = extractPaths(input);
  if (paths.length === 0) return true;
  const realCwd = await realpathBestEffort(cwd);
  for (const raw of paths) {
    const expanded = expandHome(raw);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const real = await realpathBestEffort(absolute);
    if (!isWithinDirectory(realCwd, real)) return false;
  }
  return true;
}

// --- project permission rules -----------------------------------------

export type BashRuleKind = "exact" | "prefix" | "prefix-word";

export interface BashRule {
  /** The rule exactly as written in settings.json, for the audit log. */
  readonly raw: string;
  readonly kind: BashRuleKind;
  readonly value: string;
}

export interface ProjectPermissionRules {
  readonly allow: readonly BashRule[];
  readonly deny: readonly BashRule[];
  readonly understood: number;
  readonly skipped: number;
}

/**
 * Parse one Claude Code permission rule. Only the `Bash(...)` form is
 * understood; every other rule kind (`Read(...)`, `WebFetch(...)`, a
 * bare tool name, …) returns `null` and is counted as skipped.
 *
 * Supported shapes:
 *   `Bash(make lint)`     → exact match
 *   `Bash(git status*)`   → prefix match
 *   `Bash(git status:*)`  → Claude Code's own prefix form; matches the
 *                           literal command or that command plus args
 */
export function parseBashRule(raw: string): BashRule | null {
  if (!raw.startsWith("Bash(") || !raw.endsWith(")")) return null;
  const content = raw.slice("Bash(".length, -1).trim();
  if (content.length === 0) return null;
  if (content.endsWith(":*")) {
    const value = content.slice(0, -2).trim();
    if (value.length === 0) return null;
    return { raw, kind: "prefix-word", value };
  }
  if (content.endsWith("*")) {
    const value = content.slice(0, -1);
    if (value.trim().length === 0) return null;
    return { raw, kind: "prefix", value };
  }
  return { raw, kind: "exact", value: content };
}

export function matchesBashRule(rule: BashRule, command: string): boolean {
  switch (rule.kind) {
    case "exact":
      return command === rule.value;
    case "prefix":
      return command.startsWith(rule.value);
    case "prefix-word":
      return command === rule.value || command.startsWith(rule.value + " ");
  }
}

/**
 * Shell constructs we refuse to reason about. A prefix rule like
 * `Bash(git status*)` would otherwise happily match
 * `git status && rm -rf /`, so any command carrying substitution,
 * redirection or a newline is sent to the card untouched.
 */
const SHELL_UNSAFE = /[`$><\n\r&|;]/;
const SEGMENT_SPLIT = /&&|\|\||;|\|/;

/**
 * Split a command into the sub-commands an allow rule must cover.
 * Returns `null` when the command contains anything we will not
 * reason about, which the caller must treat as "card it".
 */
export function splitBashSegments(command: string): string[] | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  // Reject substitution / redirection / newlines outright; they can
  // reach outside whatever the visible command appears to do.
  if (/[`$><\n\r]/.test(trimmed)) return null;
  const segments = trimmed.split(SEGMENT_SPLIT).map((part) => part.trim());
  if (segments.some((part) => part.length === 0)) return null;
  // A stray `&` (background) survives the split above; refuse it too.
  if (segments.some((part) => SHELL_UNSAFE.test(part))) return null;
  return segments;
}

interface RulesCacheEntry {
  rules: ProjectPermissionRules;
  /** Candidate settings paths with the mtime they had when loaded. */
  stamps: { path: string; mtimeMs: number | null }[];
  /** Whether the debug "N understood / M skipped" line was emitted. */
  logged: boolean;
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.mtimeMs;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await fileMtime(path)) !== null;
}

// --- the approver ------------------------------------------------------

export class AutoApprover {
  private readonly config: AutoApproveConfig;
  private readonly boundaryCwd: string;
  private readonly logger: Logger;
  private readonly rulesCache = new Map<string, RulesCacheEntry>();

  constructor(opts: AutoApproverOptions) {
    this.config = opts.config;
    this.boundaryCwd = resolve(opts.boundaryCwd);
    this.logger = opts.logger;
  }

  /**
   * May this tool call skip the permission card? Never throws — any
   * unexpected failure is reported as "card it".
   */
  async decide(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<AutoApproveDecision> {
    try {
      return await this.decideInner(toolName, input, cwd);
    } catch (err) {
      this.logger.warn(
        { err, tool_name: toolName },
        "auto-approve check failed; falling back to permission card",
      );
      return { approve: false, reason: "check-failed" };
    }
  }

  private async decideInner(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<AutoApproveDecision> {
    // Rule 3 — the hard floor. Nothing below can lift these.
    if (toolName.startsWith("mcp__")) {
      return { approve: false, reason: "mcp-tool-never-auto" };
    }
    if (NEVER_AUTO_APPROVE_TOOLS.has(toolName)) {
      return { approve: false, reason: "state-changing-tool" };
    }

    if (toolName === "Bash") {
      if (!this.config.honorProjectPermissions) {
        return { approve: false, reason: "honor_project_permissions-off" };
      }
      return await this.decideBash(input, cwd);
    }

    if (!this.config.autoApproveReadonly) {
      return { approve: false, reason: "auto_approve_readonly-off" };
    }
    if (PATH_FREE_AUTO_TOOLS.has(toolName)) {
      return { approve: true, reason: "readonly-in-cwd" };
    }
    if (!READONLY_TOOLS.has(toolName)) {
      return { approve: false, reason: "unknown-tool" };
    }
    if (await allPathsWithinCwd(cwd, input)) {
      return { approve: true, reason: "readonly-in-cwd" };
    }
    return { approve: false, reason: "path-outside-cwd" };
  }

  private async decideBash(
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<AutoApproveDecision> {
    const command = input["command"];
    if (typeof command !== "string") {
      return { approve: false, reason: "no-command" };
    }
    const rules = await this.loadRules(cwd);
    if (rules.allow.length === 0 && rules.deny.length === 0) {
      return { approve: false, reason: "no-project-rules" };
    }

    const segments = splitBashSegments(command);
    if (segments === null) {
      return { approve: false, reason: "unparseable-command" };
    }
    const candidates = [command.trim(), ...segments];

    // Deny wins, always — even when an allow rule also matches.
    for (const candidate of candidates) {
      for (const rule of rules.deny) {
        if (matchesBashRule(rule, candidate)) {
          this.logger.warn(
            { command: candidate, rule: rule.raw },
            "auto-approve: project deny rule matched; sending permission card",
          );
          return { approve: false, reason: `project-deny-rule:${rule.raw}` };
        }
      }
    }

    const matched: string[] = [];
    for (const segment of segments) {
      const rule = rules.allow.find((entry) => matchesBashRule(entry, segment));
      if (rule === undefined) {
        return { approve: false, reason: "no-allow-rule" };
      }
      matched.push(rule.raw);
    }
    return {
      approve: true,
      reason: `project-allow-rule:${[...new Set(matched)].join(",")}`,
    };
  }

  /**
   * Load and merge `.claude/settings.json` from `cwd` upward.
   *
   * Why this file is trustworthy as an allowlist: it is committed to
   * the product repo and sits under CODEOWNERS dual review, so every
   * entry in it has already been read by a second engineer. That makes
   * it a *reviewed* allowlist rather than an ad-hoc one — categorically
   * different from a runtime flag a single operator can flip.
   *
   * The walk stops at the git root or `agent.default_cwd`, whichever
   * comes first, so no settings file outside the locked workspace is
   * ever consulted. Deeper files win on merge.
   */
  async loadRules(cwd: string): Promise<ProjectPermissionRules> {
    const key = resolve(cwd);
    const dirs = await this.candidateDirs(key);
    const paths = dirs.map((dir) => join(dir, ".claude", "settings.json"));
    const stamps = await Promise.all(
      paths.map(async (path) => ({ path, mtimeMs: await fileMtime(path) })),
    );

    const cached = this.rulesCache.get(key);
    if (cached && stampsEqual(cached.stamps, stamps)) {
      return cached.rules;
    }

    const allow: BashRule[] = [];
    const deny: BashRule[] = [];
    const seenAllow = new Set<string>();
    const seenDeny = new Set<string>();
    let understood = 0;
    let skipped = 0;

    // `paths` is deepest-first, so the deeper file's rules land first
    // and win any dedupe.
    for (const path of paths) {
      const parsed = await this.readSettings(path);
      if (parsed === null) continue;
      for (const raw of parsed.deny) {
        const rule = parseBashRule(raw);
        if (rule === null) {
          skipped += 1;
          continue;
        }
        understood += 1;
        if (!seenDeny.has(rule.raw)) {
          seenDeny.add(rule.raw);
          deny.push(rule);
        }
      }
      for (const raw of parsed.allow) {
        const rule = parseBashRule(raw);
        if (rule === null) {
          skipped += 1;
          continue;
        }
        understood += 1;
        if (!seenAllow.has(rule.raw)) {
          seenAllow.add(rule.raw);
          allow.push(rule);
        }
      }
    }

    const rules: ProjectPermissionRules = { allow, deny, understood, skipped };
    const wasLogged = cached?.logged ?? false;
    if (!wasLogged) {
      this.logger.debug(
        { cwd: key, understood, skipped, files: paths.length },
        "auto-approve: loaded project permission rules",
      );
    }
    this.rulesCache.set(key, { rules, stamps, logged: true });
    return rules;
  }

  /**
   * `cwd` first, then each parent, stopping at (and including) the git
   * root or the boundary cwd — whichever is reached first.
   */
  private async candidateDirs(cwd: string): Promise<string[]> {
    const dirs: string[] = [];
    let dir = cwd;
    for (;;) {
      dirs.push(dir);
      if (dir === this.boundaryCwd) break;
      if (await pathExists(join(dir, ".git"))) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      // Never read a settings file above the locked workspace.
      if (!isWithinDirectory(this.boundaryCwd, parent)) break;
      dir = parent;
    }
    return dirs;
  }

  /**
   * Read one settings.json. A missing file yields `null` (nothing to
   * merge); a malformed one ALSO yields `null` after a warning — a
   * broken rules file must never widen what auto-approves.
   */
  private async readSettings(
    path: string,
  ): Promise<{ allow: string[]; deny: string[] } | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      const permissions = (parsed as Record<string, unknown>)["permissions"];
      if (typeof permissions !== "object" || permissions === null) return null;
      const record = permissions as Record<string, unknown>;
      return {
        allow: stringArray(record["allow"]),
        deny: stringArray(record["deny"]),
      };
    } catch (err) {
      this.logger.warn(
        { err, path },
        "auto-approve: malformed .claude/settings.json; ignoring its rules",
      );
      return null;
    }
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stampsEqual(
  a: readonly { path: string; mtimeMs: number | null }[],
  b: readonly { path: string; mtimeMs: number | null }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.path === b[index]!.path && entry.mtimeMs === b[index]!.mtimeMs,
  );
}
