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

### 相对上游的九项改动

| # | 改动 | 配置键 / 位置 |
|---|------|---------------|
| 1 | **Lark 国际版域名**：`Client` 与 `WSClient` 均按 `feishu.domain` 选择 `Domain.Lark` / `Domain.Feishu`；**本分支默认 `"lark"`**（open.larksuite.com）。国内飞书需显式写 `domain = "feishu"`。 | `[feishu].domain` |
| 2 | **彻底移除 `bypassPermissions`**：配置校验、`/mode`、`/config set`、Codex 映射（`approvalPolicy = never` / `sandboxMode = danger-full-access`）全部删除。旧配置若仍含该值会在启动时报错。`/config set` 拒绝一切 `*_permission_mode` 键。保留 `default` / `acceptEdits` / `plan`。 | `src/config.ts`、`src/commands/*`、`src/codex/sdk-run.ts` |
| 3 | **群聊白名单**：新增必填、非空的 `access.allowed_chat_ids`。消息事件与卡片点击都先按 `chat_id` 过滤（debug 日志静默丢弃），再走 `open_id` 校验——白名单用户在未列出的群里也无法驱动 bot。 | `[access].allowed_chat_ids` |
| 4 | **锁定工作目录**：`agent.locked_cwd`（默认 `true`）。开启时 `/cd` 只接受 `agent.default_cwd` 自身或其子目录（`path.resolve` + 前缀判断，`..` 与同名前缀均被拦截）；`[projects]` 别名在配置加载时校验必须位于 `default_cwd` 内；`/config set *default_cwd` 被拒绝。 | `[agent].locked_cwd` |
| 5 | **权限卡片去掉 `allow_session` 按钮**：不再有会话级「一直允许」。保留 允许 / 拒绝 / 本轮 acceptEdits。`allow_turn` 只作用于当前 turn 的 SDK 查询，不会置位会话粘性标记（下一轮从配置 / `/mode` 重新计算）。 | `src/feishu/cards/permission-card.ts`、`src/claude/*` |
| 6 | **文件权限**：`afc init` 写出的 `config.toml` 为 `0600`（目录 `0700`）；`state.json` 与 `/config set --persist` 回写也以 `0600` 写入。 | `src/cli.ts`、`src/persistence/state-store.ts`、`src/config.ts` |
| 8 | **失败轮次不再拖垮进程**：一次失败的 turn 现在只做三件事——记日志、往发起会话里回一条可读的「❌ 本次执行失败：…」、保留会话可用；**进程绝不退出**。provider 未登录（`Not logged in · Please run /login`）会给出可操作提示（去那台机器上跑 `claude` 然后 `/login`；provider=codex 则是 `codex login`）。`process.on("unhandledRejection")` 改为 fatal 记录但**不退出**（`uncaughtException` 仍退出）。同时 `message_id` 去重改为落盘（`state.json` 内最近 200 条、按 1 小时老化），使重启后 Lark 重投的同一事件不会被重复处理。 | `src/agent/turn-failure.ts`、`src/util/dedup.ts`、`src/claude/session.ts`、`src/index.ts` |
| 7 | **共享群 @提及 路由**：三个 bot 同处一个 Lark 群。新增 `access.require_mention`（默认 `true`）：群聊消息必须 @ 到本 bot（`mentions[].id.open_id` == 本 bot 的 `open_id`，启动时经 `GET /open-apis/bot/v3/info` 解析并缓存）才处理，解析失败则群聊 fail closed；单聊不受影响。同时丢弃 `sender_type != "user"` 的事件（bot 不互相触发），并在进命令路由前剥掉 `@_user_N` / `@_all` 占位符。 | `[access].require_mention`、`src/feishu/mentions.ts`、`src/feishu/gateway.ts` |
| 10 | **`state.json` 写入串行化**：第 8 项的落盘去重上线后，线上日志出现 `Failed to persist message dedup ring … ENOENT rename state.json.tmp`——去重 flush、`SessionManager.saveNow()`、关停三处并发调 `save()`，都用同一个固定 `.tmp` 再 rename，后者把前者的临时文件抢走。现在 `save()` 排队执行（后到者等前者落盘；某次失败不阻塞后续），每次写唯一临时名 `state.json.<pid>.<seq>.tmp`，写完即 rename。另：Lark 应用需授予 `cardkit:card:read`，否则每张状态卡都会先报 `idConvert failed (99991672)` 再降级到 `patchCard`（功能可用，日志噪音）。 | `src/persistence/state-store.ts`；Lark 后台权限 |
| 9 | **有作用域的免卡片放行（治审批疲劳）**：线上一次 Lark 对话产生 81 张权限卡片（51 `Bash` / 29 `Read` / 1 `Skill`），人类点了 97 次「一律同意」——点到第 97 次的人不在审阅任何一张卡片。新增 `access.auto_approve_readonly`（默认 `true`）：只读工具（`Read`/`Glob`/`Grep`/`LS`/`NotebookRead`，以及无路径的 `TodoWrite`）在输入里每一个路径都落在会话 cwd 子树内时直接放行（`~` 先展开，`fs.realpath` 解析，软链接逃逸算越界）。新增 `access.honor_project_permissions`（默认 `true`）：`Bash` 先查项目自己的 `<cwd>/.claude/settings.json`（向上合并到 git 根或 `agent.default_cwd`，深层优先，按 mtime 缓存）里 `Bash(...)` 形式的 allow / deny 规则，**deny 永远优先**。**改状态与出网的工具永远出卡片**：未命中 allow 的 `Bash`、`Write`、`Edit`、`MultiEdit`、`NotebookEdit`、`WebFetch`、`WebSearch`、`Task`、`Skill`，以及任何 `mcp__` 前缀工具。每次放行打 info 日志（`reason` = `readonly-in-cwd` / `project-allow-rule:<规则>`），`/status` 显示本会话累计放行次数。 | `[access].auto_approve_readonly`、`[access].honor_project_permissions`、`src/claude/auto-approve.ts` |

### 免卡片放行决策表（第 9 项）

`canUseTool` 收到的每一次工具调用，按下表从上往下判定，第一条命中即生效：

| 工具 | 条件 | 结果 |
|------|------|------|
| `mcp__feishu__*` | 桥接自己注入的 in-process shim（`ask_user`） | 直接放行（本分支既有行为，与本项无关） |
| 任何 `mcp__*` | —— | **卡片**，`auto_approve_readonly` / `honor_project_permissions` 都管不着 |
| `Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `WebFetch` / `WebSearch` / `Task` / `Skill` | —— | **卡片**，同上 |
| `Bash` | `honor_project_permissions = false` | **卡片** |
| `Bash` | 命令含 `` ` `` / `$` / `>` / `<` / 换行 / 裸 `&` | **卡片**（不做解析，fail closed） |
| `Bash` | 整条命令或任一分段命中 deny 规则 | **卡片**（deny 永远优先，即使 allow 也命中） |
| `Bash` | `&&` `\|\|` `;` `\|` 拆开后**每一段**都命中 allow 规则 | 放行，`reason = project-allow-rule:<规则>` |
| `Bash` | 其它（含没有 / 读不出 `.claude/settings.json`） | **卡片** |
| `TodoWrite` | `auto_approve_readonly = true` | 放行，`reason = readonly-in-cwd` |
| `Read` / `Glob` / `Grep` / `LS` / `NotebookRead` | `auto_approve_readonly = true` 且输入里每个路径都在会话 cwd 子树内 | 放行，`reason = readonly-in-cwd` |
| `Read` / `Glob` / `Grep` / `LS` / `NotebookRead` | 任一路径越界（`~/.ssh/id_rsa`、`../../other-repo`、软链接逃逸） | **卡片** |
| 其它任何工具名 | —— | **卡片** |

判定过程中任何异常（fs 报错、JSON 损坏、输入形状不对）都落到**卡片**，
不会放行。这比现状更安全：今天 `Read ~/.ssh` 也会出卡片，但那是 97 张里的
一张，没人会看见它；现在它是那一小把真正需要人点的卡片之一。

### 共享群模型（三个 bot 一个群）

`corebyte-hermes`（GitHub ↔ Lark 控制面，独立代码库）、`corebyte-claude`
（本桥接，provider=claude，跑在 A 的 Mac）、`corebyte-codex`（本桥接，
provider=codex，跑在 B 的 Mac）**共用同一个 Lark 群**，不是一 bot 一群。

路由机制就是 **@提及**：

- 平台行为：群里的 bot 只会收到 **@ 了自己** 的消息的 `im.message.receive_v1`
  事件——除非该应用被授予「获取群组中所有消息 / `im:message.group_msg`」权限。
- 本分支策略：**三个应用都不申请该权限**。

  > ⚠️ 一旦授予「获取群组中所有消息」，每个 bot 都能看到群里的全部消息，
  > 包括另外两个 bot 的消息和它们的输出——这正是 bot 互相触发、串台的来源。
  > 需要的只有 `im:message.receive_v1` 这一条事件订阅，不要加这条权限。

- 应用需要的权限（scope）：`im:message`、`im:message:send_as_bot`、`im:chat:readonly`、
  `contact:user.base:readonly`、**`cardkit:card:read`**（状态/思考/工具活动卡片的 `id_convert`
  需要它；缺了会降级到 `patchCard`，可用但每张卡先报一次 99991672）。回调订阅里除
  `im.message.receive_v1` 外还要有 **`card.action.trigger`**（权限卡片的按钮点击靠它回到进程）。

代码侧两道闸（`src/feishu/gateway.ts`）：

1. **@提及闸**（`access.require_mention`，默认 `true`）：`chat_type` 不是
   `"p2p"` 时，`message.mentions[].id.open_id` 必须命中本 bot 自己的
   `open_id`，否则静默丢弃。本 bot 的 `open_id` 在 `start()` 时经
   `GET /open-apis/bot/v3/info` 解析一次并缓存；拿不到 `open_id` 时退化为
   按 `app_name` 匹配 `mentions[].name`；两者都拿不到就**丢弃群聊消息**
   （fail closed，不是 fail open）。该闸跑在 `open_id` 白名单校验**之前**，
   所以发给另外两个 bot 的消息不会被本 bot 回一句「Unauthorized sender」。
2. **bot 发送方闸**：`sender.sender_type` 明确不是 `"user"`（Lark 用
   `"app"` 表示机器人）的事件一律丢弃，debug 级日志。字段缺失时按人类处理，
   避免上游 payload 变动把整个桥接静音。

另外，Lark 把 @ 提及以 `@_user_1` / `@_all` 占位符的形式内联在
`message.content` 里，所以 `@corebyte-claude /stop` 实际收到的是
`@_user_1 /stop`。`src/feishu/mentions.ts` 在进命令路由前把这些占位符剥掉
（`@corebyte-claude /stop` → `/stop`；`@corebyte-claude 看下这个 PR` →
`看下这个 PR`），否则任何以 `/` 开头的命令都无法解析。

### 失败轮次与崩溃回环（改动 8）

2026-09-04 线上现象：A 的 Mac 上桥接由 launchd 托管（`KeepAlive=true`），
`claude` CLI 登录态失效后，一条消息把进程打挂，21 秒内重启三次：

```
level 50  "Claude turn failed" · "Claude Code returned an error result: Not logged in · Please run /login"
level 60  "Unhandled promise rejection"
<进程退出 → launchd 拉起 → Lark 重投同一事件 → 再挂>
```

两个原因，各修一半：

1. **逃逸的 promise**。`ClaudeSession.submit()` 把 `done` deferred 交还给
   调用方，但 `src/index.ts` 在挂上 rejection handler **之前** 先 `await`
   了一次状态卡片的网络往返。provider 瞬时失败（未登录就是）时，这个
   promise 在无人观察的状态下 reject，Node 报 `unhandledRejection`，
   进程自杀。现在 session 在创建 deferred 的同一刻就挂上惰性 catch，
   `index.ts` 也改为先把结果 promise 转成已观察的值再去发卡片；
   `sdk-query.ts` 里 `setPermissionMode()` 的浮空 promise 一并修掉。
2. **内存态去重**。重启后去重缓存清空，Lark 重投的同一 `message_id`
   被再次处理——这才是把「一次失败」放大成「回环」的东西。去重环现在
   随 `state.json` 落盘（最近 200 条 + 1 小时老化，0600）。这是
   **防回环，不是 exactly-once**：环有界、写入尽力而为，重复处理是可
   接受结果，唯一保证是被反复重投的事件不会永远被反复处理。

`unhandledRejection` 现在只记 fatal 日志、**不退出**：聊天桥接必须活过
单次坏轮次，而退出在 launchd 下反而制造回环。`uncaughtException` 仍然
退出——同步抛栈可能留下半改状态，没法安全推断还剩什么。

### 从源码运行

```bash
git clone https://github.com/COREBYTE-TECHNOLOGY/agent-feishu-channel.git
cd agent-feishu-channel            # 默认分支即 corebyte-hardening
corepack pnpm install --frozen-lockfile   # 或 npx pnpm@10 install --frozen-lockfile
pnpm build

node dist/cli.js init              # 生成 ~/.agent-feishu-channel/config.toml（0600）
vim ~/.agent-feishu-channel/config.toml
#   [feishu]  domain = "lark"，填 app_id / app_secret
#   [access]  allowed_open_ids + allowed_chat_ids（必填）；require_mention 默认 true
#   [agent]   default_cwd（/cd 与 [projects] 都被锁在这个目录内）

node dist/cli.js -c ~/.agent-feishu-channel/config.toml
```

校验：`pnpm test`（vitest，662 用例）、`pnpm typecheck`。

### 上游同步

只从 `ddb873b` 之后的上游提交 cherry-pick / rebase，合并前重新审计
`bypassPermissions`、`allow_session`、`danger-full-access` 是否被重新引入（`grep -rn` 一遍 `src/`），
以及 `im.message.receive_v1` 的处理链上 @提及闸 / bot 发送方闸是否仍在 `open_id` 校验之前。

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
| `[access]` | `allowed_open_ids`, `allowed_chat_ids` (required), `unauthorized_behavior`, `require_mention` (default `true`) | Who, and from which chats, can talk to the bot; in a group the message must @mention this bot |
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
