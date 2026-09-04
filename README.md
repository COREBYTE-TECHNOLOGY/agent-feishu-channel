<p align="center">
  <img src="assets/logo.svg" width="180" alt="AFC Logo" />
</p>

<h1 align="center">agent-feishu-channel · COREBYTE 加固分支</h1>

<p align="center">
  Claude and Codex, natively in Feishu / Lark.
  <br />
  A full coding-agent workflow — right inside your Lark group chat.
</p>

## COREBYTE 加固分支说明（请先读）

本仓库是 [Blackman99/agent-feishu-channel](https://github.com/Blackman99/agent-feishu-channel) 的
**安全加固 fork**，供 COREBYTE 团队内部使用（Lark 国际版，两名开发者：A 用 Claude Code，B 用 Codex CLI）。
分支 `corebyte-hardening` 基于上游审计过的提交 `ddb873b241b6bb86ed7c4be07b1d71d4fb53bc75`。

**不发布到 npm。** `package.json` 已标记 `"private": true`；只从源码运行（见下）。

### 相对上游的六项改动

| # | 改动 | 配置键 / 位置 |
|---|------|---------------|
| 1 | **Lark 国际版域名**：`Client` 与 `WSClient` 均按 `feishu.domain` 选择 `Domain.Lark` / `Domain.Feishu`；**本分支默认 `"lark"`**（open.larksuite.com）。国内飞书需显式写 `domain = "feishu"`。 | `[feishu].domain` |
| 2 | **彻底移除 `bypassPermissions`**：配置校验、`/mode`、`/config set`、Codex 映射（`approvalPolicy = never` / `sandboxMode = danger-full-access`）全部删除。旧配置若仍含该值会在启动时报错。`/config set` 拒绝一切 `*_permission_mode` 键。保留 `default` / `acceptEdits` / `plan`。 | `src/config.ts`、`src/commands/*`、`src/codex/sdk-run.ts` |
| 3 | **群聊白名单**：新增必填、非空的 `access.allowed_chat_ids`。消息事件与卡片点击都先按 `chat_id` 过滤（debug 日志静默丢弃），再走 `open_id` 校验——白名单用户在未列出的群里也无法驱动 bot。 | `[access].allowed_chat_ids` |
| 4 | **锁定工作目录**：`agent.locked_cwd`（默认 `true`）。开启时 `/cd` 只接受 `agent.default_cwd` 自身或其子目录（`path.resolve` + 前缀判断，`..` 与同名前缀均被拦截）；`[projects]` 别名在配置加载时校验必须位于 `default_cwd` 内；`/config set *default_cwd` 被拒绝。 | `[agent].locked_cwd` |
| 5 | **权限卡片去掉 `allow_session` 按钮**：不再有会话级「一直允许」。保留 允许 / 拒绝 / 本轮 acceptEdits。`allow_turn` 只作用于当前 turn 的 SDK 查询，不会置位会话粘性标记（下一轮从配置 / `/mode` 重新计算）。 | `src/feishu/cards/permission-card.ts`、`src/claude/*` |
| 6 | **文件权限**：`afc init` 写出的 `config.toml` 为 `0600`（目录 `0700`）；`state.json` 与 `/config set --persist` 回写也以 `0600` 写入。 | `src/cli.ts`、`src/persistence/state-store.ts`、`src/config.ts` |

### 从源码运行

```bash
git clone https://github.com/COREBYTE-TECHNOLOGY/agent-feishu-channel.git
cd agent-feishu-channel            # 默认分支即 corebyte-hardening
corepack pnpm install --frozen-lockfile   # 或 npx pnpm@10 install --frozen-lockfile
pnpm build

node dist/cli.js init              # 生成 ~/.agent-feishu-channel/config.toml（0600）
vim ~/.agent-feishu-channel/config.toml
#   [feishu]  domain = "lark"，填 app_id / app_secret
#   [access]  allowed_open_ids + allowed_chat_ids（必填）
#   [agent]   default_cwd（/cd 与 [projects] 都被锁在这个目录内）

node dist/cli.js -c ~/.agent-feishu-channel/config.toml
```

校验：`pnpm test`（vitest，618 用例）、`pnpm typecheck`。

### 上游同步

只从 `ddb873b` 之后的上游提交 cherry-pick / rebase，合并前重新审计
`bypassPermissions`、`allow_session`、`danger-full-access` 是否被重新引入（`grep -rn` 一遍 `src/`）。

---

以下为上游 README（部分表格已按本分支修订）。

> **Migrating from `claude-feishu-channel`?** The project was renamed to reflect multi-provider support (Claude + Codex). Run `pnpm remove claude-feishu-channel && pnpm add agent-feishu-channel` (or the npm equivalent). Command is now `afc` instead of `cfc`. On first run, the state directory at `~/.claude-feishu-channel/` will be auto-renamed to `~/.agent-feishu-channel/` — session history is preserved. Config keys are unchanged.

## Features

- **Dual providers** — switch between Claude and Codex per config or per session
- **Full coding agent** — file editing, shell commands, search, planning
- **Permission brokering** — tool calls post interactive approval cards in Feishu
- **Session persistence** — survives process restarts, auto-resumes conversations
- **Queue & interrupt** — messages queue during generation; `!` prefix interrupts
- **Interactive cards** — streaming status, tool activity, thinking blocks, permissions
- **Staged context mitigation** — warn, then hard 50MB fallback
- **Runtime config** — `/config set` to tune behavior without restart

## Quick Start

### Install

```bash
npm install -g agent-feishu-channel
```

### Initialize config

```bash
afc init
# Creates ~/.agent-feishu-channel/config.toml from template
```

Edit the config with your Feishu credentials:

```bash
vim ~/.agent-feishu-channel/config.toml
```

To discover your Feishu `open_id` on first run, temporarily set
`allowed_open_ids = []` and `unauthorized_behavior = "reject"`, then send the
bot a message. It will reply with your `open_id`; add that value to
`allowed_open_ids` and switch back to `"ignore"` for normal use.

### Run

```bash
afc
```

The bot connects to Feishu via WebSocket and starts listening for messages.

### CLI Options

```
afc [options]            Start the service
afc init                 Create config template at ~/.agent-feishu-channel/config.toml

Options:
  -c, --config <path>    Path to config.toml (overrides default location)
  -v, --version          Show version number
  -h, --help             Show help
```

## Prerequisites

- **Node.js** >= 20
- **Claude CLI** — `claude` binary in `$PATH` when using the Claude provider
- **Codex CLI + SDK** — `codex` binary in `$PATH` plus `@openai/codex-sdk` when using the Codex provider
- **Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, reasoning effort, token usage |
| `/cost` | Show token usage totals (input / output / total) for this session |
| `/context` | Show context window usage and mitigation status |
| `/compact` | Reset the current session to free context (idle-only) |
| `/sessions` | List all known sessions |
| `/projects` | List all configured project aliases |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card; locked to `agent.default_cwd` when `agent.locked_cwd = true`) |
| `/project <alias>` | Switch to a configured project alias |
| `/provider <claude\|codex>` | Switch the current session provider |
| `/mode <mode>` | Set permission mode: `default`, `acceptEdits`, `plan` (`bypassPermissions` removed in this fork) |
| `/model <name>` | Switch the current provider model |
| `/effort <level>` | Switch the current provider reasoning effort |
| `/config show` | Display current configuration |
| `/config set <key> <value>` | Change a config value at runtime |
| `/config set <key> <value> --persist` | Change and write back to config.toml |
| `/memory` | Show current provider memory files (`CLAUDE.md` for Claude, `AGENTS.md` for Codex) |
| `/memory add <text>` | Append `<text>` as a bullet to the current provider's project memory file |
| `/help` | Show available commands |

**Special inputs:**

| Input | Effect |
|-------|--------|
| `!<text>` | Interrupt current turn + run `<text>` as new turn |
| Plain text | Queue as next turn (or start immediately if idle) |

## Configuration

See [`config.example.toml`](config.example.toml) for all options with comments.

### Sections

| Section | Keys | Description |
|---------|------|-------------|
| `[feishu]` | `domain` (`lark` default / `feishu`), `app_id`, `app_secret`, `encrypt_key`, `verification_token` | Lark / Feishu bot credentials |
| `[access]` | `allowed_open_ids`, `allowed_chat_ids` (required), `unauthorized_behavior` | Who, and from which chats, can talk to the bot |
| `[agent]` | `default_provider`, `default_cwd`, `locked_cwd` (default `true`), `default_permission_mode`, `permission_timeout_seconds`, `permission_warn_before_seconds` | Shared defaults and legacy fallbacks |
| `[claude]` | `default_permission_mode`, `default_model`, `default_effort`, `permission_timeout_seconds`, `permission_warn_before_seconds`, `cli_path` | Claude provider defaults |
| `[codex]` | `default_permission_mode`, `default_model`, `default_effort`, `cli_path` | Codex provider defaults |
| `[render]` | `inline_max_bytes`, `hide_thinking`, `show_turn_stats` | Card rendering options |
| `[persistence]` | `state_file`, `log_dir`, `session_ttl_days` | State and log paths |
| `[logging]` | `level` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `[projects]` | `<alias> = "<path>"` | Project aliases for `/project` command |
| `[[mcp]]` (array) | `name`, `type` (`stdio`/`sse`), `command`/`args`/`env` or `url` | Custom MCP servers exposed to the active provider |

### Runtime-settable keys

These keys can be changed via `/config set` without restart:

`render.hide_thinking`, `render.show_turn_stats`, `render.inline_max_bytes`,
`logging.level`, `agent.default_provider`, `agent.default_cwd` (refused while `locked_cwd`),
`agent.permission_timeout_seconds`, `agent.permission_warn_before_seconds`,
`claude.default_model`, `claude.default_effort`, `claude.default_cwd` (refused while `locked_cwd`),
`claude.permission_timeout_seconds`, `claude.permission_warn_before_seconds`,
`codex.default_model`, `codex.default_effort`

`*.default_permission_mode` keys are **never** settable at runtime in this fork.

### Upgrading old configs

Existing Claude-only configs continue to load. Legacy `[claude]` values are used as shared fallbacks when `[agent]` is absent or only partially present, and Codex receives safe defaults (`gpt-5.5`, `high` effort, shared permission mode). Users can move to the new layout gradually with `/config set ... --persist`; no one-time manual migration is required.

## Architecture

```
Feishu WebSocket
      │
      ▼
FeishuGateway (event decryption, dedup, access control)
      │
      ├─ onMessage ──▶ parseInput (router)
      │                    │
      │                    ├─ /command ──▶ CommandDispatcher
      │                    │
      │                    └─ plain text ──▶ ClaudeSession.submit
      │                                        │
      │                                        ▼
      │                           provider queryFn (Claude or Codex)
      │                                        │
      │                                        ├─ tool_use ──▶ PermissionBroker ──▶ Feishu card
      │                                        ├─ thinking ──▶ Feishu card (streaming)
      │                                        └─ text ──▶ Feishu answer card
      │
      └─ onCardAction ──▶ PermissionBroker.resolveByCard
                          QuestionBroker.resolveByCard
                          CommandDispatcher.resolveCdConfirm
```

**Key components:**

- **`FeishuGateway`** — receives WebSocket events, verifies signatures, deduplicates, enforces access control
- **`ClaudeSession`** — shared session state machine (idle → generating → idle) with message queue, drives the selected provider runtime
- **`ClaudeSessionManager`** — `chat_id → ClaudeSession` map with persistence, provider selection, and crash recovery
- **`FeishuPermissionBroker`** — posts permission cards, tracks pending approvals, handles timeouts
- **`CommandDispatcher`** — handles slash commands (`/new`, `/cd`, `/config set`, etc.)

## Context Handling

The bot now applies staged mitigation before it hits Claude's 50MB hard request limit:

1. `warn` — notify that the session is getting large
2. `hard reset fallback` — keep the backend-driven `Request too large / max 50MB` reset-and-retry path as the last fallback

Use `/context` to inspect current window usage and see the mitigation order reflected in user-facing output.

## Development

```bash
# Clone and install
git clone https://github.com/Blackman99/agent-feishu-channel.git
cd agent-feishu-channel
pnpm install

# Run in dev mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build
pnpm build
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_FEISHU_CONFIG` | Override config file path (default: `~/.agent-feishu-channel/config.toml`) |
| `CLAUDE_FEISHU_CONFIG` | Legacy alias for `AGENT_FEISHU_CONFIG` (still honored) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint for Claude SDK |
| `ANTHROPIC_AUTH_TOKEN` | Auth token for custom endpoint |

## Current Codex Limits

- Mid-turn `acceptEdits` escalation is still a provider-specific downgrade on Codex: `setPermissionMode()` is a safe no-op in the current adapter.

## License

MIT
