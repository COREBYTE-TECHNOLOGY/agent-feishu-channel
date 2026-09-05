import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const FeishuSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  encrypt_key: z.string().default(""),
  verification_token: z.string().default(""),
  // COREBYTE fork: default to Lark international (open.larksuite.com).
  domain: z.enum(["feishu", "lark"]).default("lark"),
});

const AccessSchema = z.object({
  allowed_open_ids: z.array(z.string().min(1)),
  // COREBYTE hardening: required and non-empty. The bot only reacts to
  // events originating from these chat_ids.
  allowed_chat_ids: z
    .array(z.string().min(1))
    .min(1, "at least one chat_id is required"),
  unauthorized_behavior: z.enum(["ignore", "reject"]).default("ignore"),
  // COREBYTE hardening (shared-group model): all three COREBYTE bots live
  // in ONE Lark group, and the @mention is what routes a message to one of
  // them. Default true: in a group chat the bridge only handles messages
  // that @mention its own bot. p2p chats are never gated.
  require_mention: z.boolean().default(true),
  // COREBYTE hardening (approval fatigue): read-only tools whose every
  // filesystem path resolves inside the session cwd resolve without a
  // permission card. State-changing and network tools always card.
  auto_approve_readonly: z.boolean().default(true),
  // COREBYTE hardening (approval fatigue): consult the project's own
  // `.claude/settings.json` `permissions.allow` / `permissions.deny`
  // for Bash commands. That file is committed and CODEOWNERS-reviewed,
  // so it is a reviewed allowlist rather than an ad-hoc one.
  honor_project_permissions: z.boolean().default(true),
});

// COREBYTE hardening: `bypassPermissions` removed on purpose — a config that
// still carries it fails validation instead of silently disabling the broker.
const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan"]);

const ClaudeEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const CodexEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const AgentSchema = z.object({
  default_provider: z.enum(["claude", "codex"]).default("claude"),
  default_cwd: z.string().min(1).optional(),
  // COREBYTE hardening: lock /cd and [projects] to default_cwd.
  locked_cwd: z.boolean().default(true),
  default_permission_mode: PermissionModeSchema.optional(),
  permission_timeout_seconds: z.number().int().positive().optional(),
  permission_warn_before_seconds: z.number().int().positive().optional(),
});

const ClaudeSchema = z.object({
  default_model: z.string().min(1).default("claude-opus-4-6"),
  default_effort: ClaudeEffortSchema.default("high"),
  cli_path: z.string().min(1).default("claude"),
  default_cwd: z.string().min(1).optional(),
  default_permission_mode: PermissionModeSchema.default("default"),
  permission_timeout_seconds: z.number().int().positive().default(300),
  permission_warn_before_seconds: z.number().int().positive().default(60),
});

const CodexSchema = z.object({
  default_model: z.string().min(1).default("gpt-5.5"),
  default_effort: CodexEffortSchema.default("high"),
  default_permission_mode: PermissionModeSchema.default("default"),
  cli_path: z.string().min(1).default("codex"),
});

const RenderSchema = z
  .object({
    inline_max_bytes: z.number().int().positive().default(2048),
    hide_thinking: z.boolean().default(false),
    show_turn_stats: z.boolean().default(true),
  })
  .default({
    inline_max_bytes: 2048,
    hide_thinking: false,
    show_turn_stats: true,
  });

const PersistenceSchema = z
  .object({
    state_file: z.string().default("~/.agent-feishu-channel/state.json"),
    log_dir: z.string().default("~/.agent-feishu-channel/logs"),
    session_ttl_days: z.number().int().positive().default(30),
  })
  .default({
    state_file: "~/.agent-feishu-channel/state.json",
    log_dir: "~/.agent-feishu-channel/logs",
    session_ttl_days: 30,
  });

const LoggingSchema = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
  })
  .default({ level: "info" });

const ProjectsSchema = z.record(z.string(), z.string()).default({});
const McpServerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["stdio", "sse"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "stdio" && !value.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "required for stdio MCP servers",
    });
  }
  if (value.type === "sse" && !value.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "required for sse MCP servers",
    });
  }
});

const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  agent: AgentSchema.optional(),
  claude: ClaudeSchema,
  codex: CodexSchema.default({
    default_model: "gpt-5.5",
    default_effort: "high",
    default_permission_mode: "default",
    cli_path: "codex",
  }),
  render: RenderSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
  projects: ProjectsSchema,
  mcp: z.array(McpServerSchema).default([]),
});

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

/**
 * COREBYTE hardening: true when `target` resolves to `base` itself or to a
 * path strictly inside `base`. Both sides go through `path.resolve`, so
 * `..` segments and trailing slashes cannot escape. Symlinks are NOT
 * followed here — this is a lexical check on the configured strings.
 */
export function isWithinDirectory(base: string, target: string): boolean {
  const root = resolve(base);
  const candidate = resolve(target);
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

function validateLockedProjects(
  path: string,
  defaultCwd: string,
  projects: Record<string, string>,
): void {
  const offenders = Object.entries(projects)
    .filter(([, cwd]) => !isWithinDirectory(defaultCwd, cwd))
    .map(([alias, cwd]) => `  - projects.${alias}: ${cwd} is outside agent.default_cwd (${defaultCwd}); set agent.locked_cwd = false to allow`);
  if (offenders.length > 0) {
    throw new ConfigError(`Invalid config at ${path}:\n${offenders.join("\n")}`);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

function hasOwnProperty(
  value: unknown,
  key: string,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function sectionHasField(raw: unknown, section: string, field: string): boolean {
  return hasOwnProperty(raw, section) && hasOwnProperty(raw[section], field);
}

function validateMixedAgentConfig(
  path: string,
  raw: unknown,
  agent: z.infer<typeof AgentSchema>,
): void {
  if (!hasOwnProperty(raw, "claude")) return;
  const claude = raw.claude;
  if (!hasOwnProperty(claude, "default_cwd")) {
    return;
  }

  const conflicts: string[] = [];
  if (
    hasOwnProperty(claude, "default_cwd") &&
    agent.default_cwd !== undefined &&
    typeof claude.default_cwd === "string" &&
    expandHome(claude.default_cwd) !== expandHome(agent.default_cwd)
  ) {
    conflicts.push("claude.default_cwd");
  }

  if (conflicts.length > 0) {
    throw new ConfigError(
      `Invalid config at ${path}:\n${conflicts
        .map((field) => `  - ${field}: conflicts with [agent] when both sections are present`)
        .join("\n")}`,
    );
  }
}

/**
 * Write a single key-value pair into an existing TOML config file.
 *
 * Round-trips the file through smol-toml parse/stringify so structure
 * is preserved (minus comments — smol-toml doesn't preserve those).
 * Uses atomic write (write to .tmp, then rename) to avoid corruption.
 */
export async function writeConfigKey(
  configPath: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parseToml(raw) as Record<string, Record<string, unknown>>;

  const [section, field] = key.split(".");
  if (!section || !field) {
    throw new Error(`Invalid config key format: ${key}`);
  }

  if (!parsed[section]) {
    parsed[section] = {};
  }
  parsed[section]![field] = value;

  const toml = stringifyToml(parsed);
  const tmpPath = configPath + ".tmp";
  // COREBYTE hardening: config holds app_secret — owner-only permissions.
  await writeFile(tmpPath, toml, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, configPath);
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(
      `Failed to read config at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse TOML at ${path}: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${path}:\n${formatZodError(result.error)}`,
    );
  }

  const data = result.data;
  if (data.agent) {
    validateMixedAgentConfig(path, parsed, data.agent);
  }
  const agent = data.agent ?? {
    default_provider: "claude" as const,
    locked_cwd: true,
  };
  const agentDefaultCwd = agent.default_cwd ?? data.claude.default_cwd;
  const lockedCwd = agent.locked_cwd ?? true;
  const agentDefaultPermissionMode =
    agent.default_permission_mode ?? data.claude.default_permission_mode;
  const agentPermissionTimeoutSeconds =
    agent.permission_timeout_seconds ?? data.claude.permission_timeout_seconds;
  const agentPermissionWarnBeforeSeconds =
    agent.permission_warn_before_seconds
    ?? data.claude.permission_warn_before_seconds;
  const requireDefaultCwd = (): string => {
    if (!agentDefaultCwd) {
      throw new ConfigError(
        `Invalid config at ${path}:\n  - agent.default_cwd: required when claude.default_cwd is omitted`,
      );
    }
    return expandHome(agentDefaultCwd);
  };
  const claudeDefaultPermissionMode = sectionHasField(
    parsed,
    "claude",
    "default_permission_mode",
  )
    ? data.claude.default_permission_mode
    : agentDefaultPermissionMode;
  const codexDefaultPermissionMode = sectionHasField(
    parsed,
    "codex",
    "default_permission_mode",
  )
    ? data.codex.default_permission_mode
    : agentDefaultPermissionMode;
  const claudePermissionTimeoutSeconds = sectionHasField(
    parsed,
    "claude",
    "permission_timeout_seconds",
  )
    ? data.claude.permission_timeout_seconds
    : agentPermissionTimeoutSeconds;
  const claudePermissionWarnBeforeSeconds = sectionHasField(
    parsed,
    "claude",
    "permission_warn_before_seconds",
  )
    ? data.claude.permission_warn_before_seconds
    : agentPermissionWarnBeforeSeconds;
  const projects = Object.fromEntries(
    Object.entries(data.projects ?? {}).map(([k, v]) => [k, expandHome(v)]),
  );
  if (lockedCwd) {
    validateLockedProjects(path, requireDefaultCwd(), projects);
  }
  return {
    feishu: {
      appId: data.feishu.app_id,
      appSecret: data.feishu.app_secret,
      encryptKey: data.feishu.encrypt_key,
      verificationToken: data.feishu.verification_token,
      domain: data.feishu.domain,
    },
    access: {
      allowedOpenIds: data.access.allowed_open_ids,
      allowedChatIds: data.access.allowed_chat_ids,
      unauthorizedBehavior: data.access.unauthorized_behavior,
      requireMention: data.access.require_mention,
      autoApproveReadonly: data.access.auto_approve_readonly,
      honorProjectPermissions: data.access.honor_project_permissions,
    },
    agent: {
      defaultProvider: agent.default_provider,
      defaultCwd: requireDefaultCwd(),
      lockedCwd,
      defaultPermissionMode: agentDefaultPermissionMode,
      permissionTimeoutMs: agentPermissionTimeoutSeconds * 1000,
      permissionWarnBeforeMs: agentPermissionWarnBeforeSeconds * 1000,
    },
    claude: {
      defaultCwd: requireDefaultCwd(),
      defaultPermissionMode: claudeDefaultPermissionMode,
      defaultModel: data.claude.default_model,
      defaultEffort: data.claude.default_effort,
      cliPath: data.claude.cli_path,
      permissionTimeoutMs: claudePermissionTimeoutSeconds * 1000,
      permissionWarnBeforeMs: claudePermissionWarnBeforeSeconds * 1000,
    },
    codex: {
      defaultModel: data.codex.default_model,
      defaultEffort: data.codex.default_effort,
      defaultPermissionMode: codexDefaultPermissionMode,
      cliPath: data.codex.cli_path,
    },
    render: {
      inlineMaxBytes: data.render.inline_max_bytes,
      hideThinking: data.render.hide_thinking,
      showTurnStats: data.render.show_turn_stats,
    },
    persistence: {
      stateFile: expandHome(data.persistence.state_file),
      logDir: expandHome(data.persistence.log_dir),
      sessionTtlDays: data.persistence.session_ttl_days,
    },
    logging: {
      level: data.logging.level,
    },
    projects,
    mcp: data.mcp.map((server) => ({
      name: server.name,
      type: server.type,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
    })),
  };
}
