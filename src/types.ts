export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type AgentProvider = "claude" | "codex";

/**
 * COREBYTE hardening: `bypassPermissions` is intentionally NOT a member of
 * this union. The Feishu bot must never be able to run a provider with the
 * permission broker disabled.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan";

/** Which Lark/Feishu API domain the bot talks to. */
export type FeishuDomain = "feishu" | "lark";

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type CodexEffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ReasoningEffort = ClaudeEffortLevel | CodexEffortLevel;

export interface ClaudeProviderConfig {
  defaultModel: string;
  defaultEffort: ClaudeEffortLevel;
  defaultPermissionMode: PermissionMode;
  /** Path to the CLI binary. Usually a bare command resolved via $PATH. */
  cliPath: string;
}

export interface CodexProviderConfig {
  defaultModel: string;
  defaultEffort: CodexEffortLevel;
  defaultPermissionMode: PermissionMode;
  /** Path to the CLI binary. Usually a bare command resolved via $PATH. */
  cliPath: string;
}

export interface AgentConfig {
  defaultProvider: AgentProvider;
  defaultCwd: string;
  /**
   * COREBYTE hardening: when true, `/cd` may only target `defaultCwd` or a
   * directory inside it, and every `[projects]` alias must resolve inside
   * `defaultCwd` (validated at config load).
   */
  lockedCwd: boolean;
  defaultPermissionMode: PermissionMode;
  /** Max time the broker waits for a user decision before auto-denying. */
  permissionTimeoutMs: number;
  /** How far BEFORE the timeout to post the "⏰ 60s" warning reminder. */
  permissionWarnBeforeMs: number;
}

export interface LoadedAppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey: string;
    verificationToken: string;
    /** "lark" (open.larksuite.com, default in this fork) or "feishu" (open.feishu.cn). */
    domain: FeishuDomain;
  };
  access: {
    allowedOpenIds: readonly string[];
    /** COREBYTE hardening: events from any other chat_id are dropped. */
    allowedChatIds: readonly string[];
    unauthorizedBehavior: "ignore" | "reject";
    /**
     * COREBYTE hardening: require an @mention of this bot before handling
     * a group message (default true). The three COREBYTE bots share one
     * Lark group; the mention is the routing mechanism. p2p is unaffected.
     */
    requireMention: boolean;
    /**
     * COREBYTE hardening: auto-approve read-only tools (Read/Glob/Grep/
     * LS/NotebookRead/TodoWrite) whose paths all stay inside the session
     * cwd, instead of posting a permission card for each. Default true.
     */
    autoApproveReadonly: boolean;
    /**
     * COREBYTE hardening: apply the project's own committed
     * `.claude/settings.json` permissions.deny / permissions.allow rules
     * to Bash commands. Default true.
     */
    honorProjectPermissions: boolean;
  };
  agent: AgentConfig;
  claude: ClaudeProviderConfig & {
    defaultCwd: string;
    permissionTimeoutMs: number;
    permissionWarnBeforeMs: number;
  };
  codex: CodexProviderConfig;
  render: {
    /** Max bytes (UTF-8) of inline content in a card before truncation. */
    inlineMaxBytes: number;
    /** If true, skip thinking blocks entirely. */
    hideThinking: boolean;
    /** If true, send a stats tip ("✅ 12.3s · 1.2k in / 3.4k out") at turn end. */
    showTurnStats: boolean;
  };
  persistence: {
    stateFile: string;
    logDir: string;
    sessionTtlDays: number;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error";
  };
  /** Project aliases — map of alias → absolute cwd path. */
  projects: Record<string, string>;
  /** User-configured MCP servers registered alongside built-in shims. */
  mcp: McpServerConfig[];
}

/**
 * A user message received from Feishu after the gateway has translated the
 * raw event into our internal representation.
 */
export interface IncomingMessage {
  /** Feishu unique message id, used for dedup. */
  messageId: string;
  /** Feishu chat id (p2p or group). */
  chatId: string;
  /** Sender's open_id. */
  senderOpenId: string;
  /** Plain text content. Rich content is flattened to text in Phase 1. */
  text: string;
  /** Attached images as data URIs. Undefined for text-only messages;
   *  non-empty array when the source message carried one or more images. */
  imageDataUris?: readonly string[];
  /** Receive timestamp (ms). */
  receivedAt: number;
}

/**
 * A plain-text reply the gateway will send back to a specific chat.
 */
export interface OutgoingTextMessage {
  chatId: string;
  text: string;
}

/**
 * Loaded, validated application config (produced by src/config.ts).
 * Later phases will extend this with more sections.
 */
export type AppConfig = LoadedAppConfig;
