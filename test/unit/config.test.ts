import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  ConfigError,
  isWithinDirectory,
  writeConfigKey,
} from "../../src/config.js";
import { statSync } from "node:fs";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.toml");
  writeFileSync(path, content);
  return path;
}

const MINIMAL_CONFIG = `
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
`;

describe("loadConfig", () => {
  it("loads a minimal valid config with defaults filled in", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_cwd = "/tmp/cfc-test"

[claude]
default_model = "claude-opus-4-6"
cli_path = "claude"
`);
    const cfg = await loadConfig(path);
    const agent = cfg.agent!;
    const codex = cfg.codex!;
    expect(cfg.feishu.appId).toBe("cli_test");
    expect(cfg.feishu.appSecret).toBe("secret");
    expect(cfg.feishu.encryptKey).toBe("");
    expect(cfg.feishu.verificationToken).toBe("");
    expect(cfg.access.allowedOpenIds).toEqual(["ou_test"]);
    expect(cfg.access.unauthorizedBehavior).toBe("ignore");
    // COREBYTE hardening: shared-group model defaults to mention-gated.
    expect(cfg.access.requireMention).toBe(true);
    expect(cfg.logging.level).toBe("info");
    expect(agent.defaultProvider).toBe("claude");
    expect(agent.defaultCwd).toBe("/tmp/cfc-test");
    expect(agent.defaultPermissionMode).toBe("default");
    expect(agent.permissionTimeoutMs).toBe(300_000);
    expect(agent.permissionWarnBeforeMs).toBe(60_000);
    expect(cfg.claude.defaultModel).toBe("claude-opus-4-6");
    expect(cfg.claude.defaultEffort).toBe("high");
    expect(cfg.claude.cliPath).toBe("claude");
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.defaultEffort).toBe("high");
    expect(codex.defaultPermissionMode).toBe("default");
    expect(codex.cliPath).toBe("codex");
  });

  it("expands ~ in persistence paths", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_cwd = "/tmp/cfc-test"

[persistence]
state_file = "~/.agent-feishu-channel/state.json"
log_dir = "~/.agent-feishu-channel/logs"

[claude]
default_model = "claude-opus-4-6"
`);
    const cfg = await loadConfig(path);
    const agent = cfg.agent!;
    const codex = cfg.codex!;
    expect(cfg.persistence.stateFile).toBe(
      join(homedir(), ".agent-feishu-channel/state.json"),
    );
    expect(cfg.persistence.logDir).toBe(
      join(homedir(), ".agent-feishu-channel/logs"),
    );
  });

  it("loads new-style [agent] and [codex] settings", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_provider = "codex"
default_cwd = "~/workspace"
default_permission_mode = "acceptEdits"
permission_timeout_seconds = 120
permission_warn_before_seconds = 30

[claude]
default_model = "claude-sonnet-4-6"
default_effort = "max"
cli_path = "/usr/local/bin/claude"

[codex]
default_model = "gpt-5.4-mini"
default_effort = "minimal"
default_permission_mode = "plan"
cli_path = "/opt/homebrew/bin/codex"
`);
    const cfg = await loadConfig(path);
    const agent = cfg.agent!;
    const codex = cfg.codex!;
    expect(agent.defaultProvider).toBe("codex");
    expect(agent.defaultCwd).toBe(join(homedir(), "workspace"));
    expect(agent.defaultPermissionMode).toBe("acceptEdits");
    expect(agent.permissionTimeoutMs).toBe(120_000);
    expect(agent.permissionWarnBeforeMs).toBe(30_000);
    expect(cfg.claude.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.claude.defaultEffort).toBe("max");
    expect(cfg.claude.cliPath).toBe("/usr/local/bin/claude");
    expect(codex.defaultModel).toBe("gpt-5.4-mini");
    expect(codex.defaultEffort).toBe("minimal");
    expect(codex.defaultPermissionMode).toBe("plan");
    expect(codex.cliPath).toBe("/opt/homebrew/bin/codex");
  });

  it("allows provider-specific permission modes to differ from the shared fallback", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_cwd = "/tmp/cfc-test"
default_permission_mode = "default"

[claude]
default_model = "claude-sonnet-4-6"
default_permission_mode = "acceptEdits"

[codex]
default_permission_mode = "plan"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.defaultPermissionMode).toBe("default");
    expect(cfg.claude.defaultPermissionMode).toBe("acceptEdits");
    expect(cfg.codex.defaultPermissionMode).toBe("plan");
  });

  it("rejects conflicting legacy Claude-era fields when [agent] is present", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_cwd = "/tmp/new-cwd"
default_permission_mode = "default"
permission_timeout_seconds = 300
permission_warn_before_seconds = 60

[claude]
default_cwd = "/tmp/legacy-cwd"
default_permission_mode = "plan"
permission_timeout_seconds = 120
permission_warn_before_seconds = 30
default_model = "claude-sonnet-4-6"
`);
    await expect(loadConfig(path)).rejects.toThrow(/claude\.default_cwd/);
  });

  it("falls back to legacy [claude] settings when [agent] is omitted", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/legacy"
default_permission_mode = "plan"
permission_timeout_seconds = 180
permission_warn_before_seconds = 45
default_model = "claude-sonnet-4-6"
cli_path = "/usr/local/bin/claude"
`);
    const cfg = await loadConfig(path);
    const agent = cfg.agent!;
    const codex = cfg.codex!;
    expect(agent.defaultProvider).toBe("claude");
    expect(agent.defaultCwd).toBe("/tmp/legacy");
    expect(agent.defaultPermissionMode).toBe("plan");
    expect(agent.permissionTimeoutMs).toBe(180_000);
    expect(agent.permissionWarnBeforeMs).toBe(45_000);
    expect(cfg.claude.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.claude.cliPath).toBe("/usr/local/bin/claude");
    expect(codex.defaultModel).toBe("gpt-5.5");
    expect(codex.cliPath).toBe("codex");
  });

  it("loads partial [agent] settings written into a legacy Claude config", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_provider = "codex"

[claude]
default_cwd = "/tmp/legacy"
default_permission_mode = "plan"
permission_timeout_seconds = 180
permission_warn_before_seconds = 45
default_model = "claude-opus-4-7"
cli_path = "claude"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.defaultProvider).toBe("codex");
    expect(cfg.agent.defaultCwd).toBe("/tmp/legacy");
    expect(cfg.agent.defaultPermissionMode).toBe("plan");
    expect(cfg.agent.permissionTimeoutMs).toBe(180_000);
    expect(cfg.agent.permissionWarnBeforeMs).toBe(45_000);
    expect(cfg.claude.defaultCwd).toBe("/tmp/legacy");
    expect(cfg.claude.defaultPermissionMode).toBe("plan");
    expect(cfg.codex.defaultModel).toBe("gpt-5.5");
    expect(cfg.codex.defaultPermissionMode).toBe("plan");
  });

  it("lets provider-specific settings override partial shared fallbacks", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
default_cwd = "/tmp/shared"
default_permission_mode = "default"

[claude]
default_model = "claude-opus-4-7"
default_permission_mode = "acceptEdits"

[codex]
default_model = "gpt-5.5"
default_permission_mode = "plan"
default_effort = "minimal"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.defaultCwd).toBe("/tmp/shared");
    expect(cfg.agent.defaultPermissionMode).toBe("default");
    expect(cfg.claude.defaultPermissionMode).toBe("acceptEdits");
    expect(cfg.codex.defaultPermissionMode).toBe("plan");
    expect(cfg.codex.defaultEffort).toBe("minimal");
  });

  it("throws ConfigError on missing file", async () => {
    const path = join(tmpDir, "does-not-exist.toml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on malformed TOML", async () => {
    const path = writeConfig("this = is [ not valid toml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError with field path on invalid schema", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
# missing app_secret

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
`);
    await expect(loadConfig(path)).rejects.toThrow(/feishu\.app_secret/);
  });

  it("allows empty allowed_open_ids for first-run open_id discovery", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = []
allowed_chat_ids = ["oc_test"]

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.allowedOpenIds).toEqual([]);
  });

  it("accepts unauthorized_behavior = 'reject'", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
unauthorized_behavior = "reject"

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.unauthorizedBehavior).toBe("reject");
  });

  it("rejects unknown unauthorized_behavior value", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
unauthorized_behavior = "bogus"

[claude]
default_cwd = "/tmp/cfc-test"
`);
    await expect(loadConfig(path)).rejects.toThrow(/unauthorized_behavior/);
  });
});

describe("loadConfig [claude] section", () => {
  const CLAUDE_CONFIG = `
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test-cwd"
`;

  it("loads [claude] with explicit defaults", async () => {
    const path = writeConfig(CLAUDE_CONFIG);
    const cfg = await loadConfig(path);
    const agent = cfg.agent!;
    expect(cfg.claude.defaultModel).toBe("claude-opus-4-6");
    expect(cfg.claude.cliPath).toBe("claude");
    expect(agent.defaultCwd).toBe("/tmp/cfc-test-cwd");
    expect(agent.defaultPermissionMode).toBe("default");
  });

  it("accepts a custom cli_path", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
cli_path = "/usr/local/bin/claude"
`);
    const cfg = await loadConfig(path);
    expect(cfg.claude.cliPath).toBe("/usr/local/bin/claude");
  });

  it("expands ~ in default_cwd", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "~/some-project"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent!.defaultCwd).toBe(join(homedir(), "some-project"));
  });

  it("accepts custom permission_mode and model", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
default_permission_mode = "acceptEdits"
default_model = "claude-sonnet-4-6"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent!.defaultPermissionMode).toBe("acceptEdits");
    expect(cfg.claude.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("rejects unknown permission_mode", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
default_permission_mode = "bogus"
`);
    await expect(loadConfig(path)).rejects.toThrow(/default_permission_mode/);
  });

  it("requires [claude] section to be present", async () => {
    const path = writeConfig(MINIMAL_CONFIG);
    await expect(loadConfig(path)).rejects.toThrow(/claude/);
  });

  it("requires default_cwd to be non-empty", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = ""
`);
    await expect(loadConfig(path)).rejects.toThrow(/default_cwd/);
  });

  describe("permission timeout config", () => {
    it("loads default permission timeout values when not specified", async () => {
      const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
      const cfg = await loadConfig(path);
      expect(cfg.agent!.permissionTimeoutMs).toBe(300_000);
      expect(cfg.agent!.permissionWarnBeforeMs).toBe(60_000);
    });

    it("multiplies permission_timeout_seconds by 1000", async () => {
      const path = writeConfig(`
${MINIMAL_CONFIG}

      [claude]
default_cwd = "/tmp/cfc-test"
permission_timeout_seconds = 120
`);
      const cfg = await loadConfig(path);
      expect(cfg.agent!.permissionTimeoutMs).toBe(120_000);
    });

    it("rejects permission_timeout_seconds = 0", async () => {
      const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
permission_timeout_seconds = 0
`);
      await expect(loadConfig(path)).rejects.toThrow(/permission_timeout_seconds/);
    });
  });
});

describe("projects table", () => {
  it("parses [projects] with tilde expansion", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[agent]
# aliases below live outside default_cwd — only legal with the lock off
locked_cwd = false

[claude]
default_cwd = "/tmp/cfc-test"

[projects]
my-app = "~/projects/my-app"
infra = "/absolute/path/infra"
`);
    const cfg = await loadConfig(path);
    expect(cfg.projects["my-app"]).toBe(join(homedir(), "projects/my-app"));
    expect(cfg.projects["infra"]).toBe("/absolute/path/infra");
  });

  it("defaults to empty object when [projects] is omitted", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.projects).toEqual({});
  });
});

describe("mcp config", () => {
  it("defaults mcp to empty array", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
`);
    const cfg = await loadConfig(path);
    expect(cfg.mcp).toEqual([]);
  });

  it("parses [[mcp]] servers", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"

[[mcp]]
name = "my-server"
type = "stdio"
command = "npx"
args = ["-y", "@my/mcp-server"]

[[mcp]]
name = "remote"
type = "sse"
url = "http://localhost:8080/sse"
`);
    const cfg = await loadConfig(path);
    expect(cfg.mcp).toHaveLength(2);
    expect(cfg.mcp[0]).toMatchObject({
      name: "my-server",
      type: "stdio",
      command: "npx",
    });
    expect(cfg.mcp[1]).toMatchObject({
      name: "remote",
      type: "sse",
      url: "http://localhost:8080/sse",
    });
  });
});

describe("persistence config", () => {
  it("defaults session_ttl_days to 30 when [persistence] is omitted", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.persistence.sessionTtlDays).toBe(30);
  });

  it("parses explicit session_ttl_days from TOML", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[persistence]
session_ttl_days = 90
`);
    const cfg = await loadConfig(path);
    expect(cfg.persistence.sessionTtlDays).toBe(90);
  });
});

describe("render config", () => {
  it("defaults to inline_max_bytes=2048, hide_thinking=false, show_turn_stats=true when [render] is absent", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.render.inlineMaxBytes).toBe(2048);
    expect(cfg.render.hideThinking).toBe(false);
    expect(cfg.render.showTurnStats).toBe(true);
  });

  it("accepts explicit [render] values", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
inline_max_bytes = 512
hide_thinking = true
show_turn_stats = false
`);
    const cfg = await loadConfig(path);
    expect(cfg.render.inlineMaxBytes).toBe(512);
    expect(cfg.render.hideThinking).toBe(true);
    expect(cfg.render.showTurnStats).toBe(false);
  });

  it("rejects negative inline_max_bytes", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
inline_max_bytes = -1
`);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });
});

describe("writeConfigKey", () => {
  it("writes a boolean value to an existing TOML file", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
hide_thinking = false
show_turn_stats = true
`);

    await writeConfigKey(path, "render.hide_thinking", true);

    const cfg = await loadConfig(path);
    expect(cfg.render.hideThinking).toBe(true);
    expect(cfg.render.showTurnStats).toBe(true);
  });

  it("writes a string value", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[logging]
level = "info"
`);

    await writeConfigKey(path, "logging.level", "debug");

    const cfg = await loadConfig(path);
    expect(cfg.logging.level).toBe("debug");
  });

  it("writes a number value", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
inline_max_bytes = 2048
`);

    await writeConfigKey(path, "render.inline_max_bytes", 4096);

    const cfg = await loadConfig(path);
    expect(cfg.render.inlineMaxBytes).toBe(4096);
  });

  it("creates section if it does not exist", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);

    await writeConfigKey(path, "render.hide_thinking", true);

    const cfg = await loadConfig(path);
    expect(cfg.render.hideThinking).toBe(true);
  });

  it("preserves other sections when writing", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
default_model = "claude-opus-4-6"

[logging]
level = "info"
`);

    await writeConfigKey(path, "logging.level", "debug");

    const cfg = await loadConfig(path);
    expect(cfg.claude.defaultModel).toBe("claude-opus-4-6");
    expect(cfg.logging.level).toBe("debug");
  });

  it("uses atomic write (tmp + rename)", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);

    await writeConfigKey(path, "logging.level", "warn");

    const tmpPath = path + ".tmp";
    expect(() => readFileSync(tmpPath)).toThrow();

    const cfg = await loadConfig(path);
    expect(cfg.logging.level).toBe("warn");
  });

  it("throws on nonexistent config file", async () => {
    const path = join(tmpDir, "nonexistent.toml");
    await expect(writeConfigKey(path, "logging.level", "debug")).rejects.toThrow();
  });
});

describe("COREBYTE hardening — [feishu].domain", () => {
  it("defaults to lark (international)", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    const cfg = await loadConfig(path);
    expect(cfg.feishu.domain).toBe("lark");
  });

  it("accepts feishu explicitly", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"
domain = "feishu"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]

[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    const cfg = await loadConfig(path);
    expect(cfg.feishu.domain).toBe("feishu");
  });

  it("rejects unknown domain values", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"
domain = "dingtalk"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]

[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    await expect(loadConfig(path)).rejects.toThrow(/feishu\.domain/);
  });
});

describe("COREBYTE hardening — [access].allowed_chat_ids", () => {
  it("is required", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]

[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    await expect(loadConfig(path)).rejects.toThrow(/access\.allowed_chat_ids/);
  });

  it("must be non-empty", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = []

[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    await expect(loadConfig(path)).rejects.toThrow(/access\.allowed_chat_ids/);
  });

  it("is exposed as access.allowedChatIds", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.allowedChatIds).toEqual(["oc_test"]);
  });
});

describe("COREBYTE hardening — bypassPermissions removed", () => {
  it.each(["agent", "claude", "codex"])(
    "rejects default_permission_mode = bypassPermissions under [%s]",
    async (section) => {
      const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
[claude]
[codex]
[${section}]
default_permission_mode = "bypassPermissions"
`);
      await expect(loadConfig(path)).rejects.toThrow(ConfigError);
      await expect(loadConfig(path)).rejects.toThrow(/default_permission_mode/);
    },
  );
});

describe("COREBYTE hardening — agent.locked_cwd", () => {
  it("defaults to true", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
[claude]
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.lockedCwd).toBe(true);
  });

  it("defaults to true even when [agent] is omitted entirely", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.lockedCwd).toBe(true);
  });

  it("rejects a [projects] alias outside default_cwd while locked", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
[claude]
[projects]
ok = "/tmp/cfc-test/ok"
evil = "/etc"
sneaky = "/tmp/cfc-test/../../etc"
`);
    const err = await loadConfig(path).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toMatch(/projects\.evil/);
    expect(message).toMatch(/projects\.sneaky/);
    expect(message).not.toMatch(/projects\.ok/);
  });

  it("accepts [projects] aliases inside default_cwd (incl. default_cwd itself and ~ expansion)", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "~/afc-root"
[claude]
[projects]
root = "~/afc-root"
svc = "~/afc-root/svc"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.lockedCwd).toBe(true);
    expect(Object.keys(cfg.projects)).toEqual(["root", "svc"]);
  });

  it("allows outside aliases when locked_cwd = false", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[agent]
default_cwd = "/tmp/cfc-test"
locked_cwd = false
[claude]
[projects]
evil = "/etc"
`);
    const cfg = await loadConfig(path);
    expect(cfg.agent.lockedCwd).toBe(false);
    expect(cfg.projects.evil).toBe("/etc");
  });
});

describe("isWithinDirectory", () => {
  it("accepts the base itself and nested paths", () => {
    expect(isWithinDirectory("/srv/work", "/srv/work")).toBe(true);
    expect(isWithinDirectory("/srv/work/", "/srv/work")).toBe(true);
    expect(isWithinDirectory("/srv/work", "/srv/work/")).toBe(true);
    expect(isWithinDirectory("/srv/work", "/srv/work/a/b")).toBe(true);
    expect(isWithinDirectory("/srv/work", "/srv/work/a/../b")).toBe(true);
  });

  it("rejects parents, siblings and prefix look-alikes", () => {
    expect(isWithinDirectory("/srv/work", "/srv")).toBe(false);
    expect(isWithinDirectory("/srv/work", "/srv/work/..")).toBe(false);
    expect(isWithinDirectory("/srv/work", "/srv/work-evil")).toBe(false);
    expect(isWithinDirectory("/srv/work", "/srv/workspace")).toBe(false);
    expect(isWithinDirectory("/srv/work", "/etc")).toBe(false);
    expect(isWithinDirectory("/srv/work", "/srv/work/../other")).toBe(false);
  });
});

describe("COREBYTE hardening — writeConfigKey file mode", () => {
  it("leaves the rewritten config owner-only (0600)", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
[render]
hide_thinking = false
`);
    await writeConfigKey(path, "render.hide_thinking", true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("access.require_mention (COREBYTE hardening)", () => {
  it("can be turned off explicitly", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
require_mention = false

[agent]
default_cwd = "/tmp/cfc-test"

[claude]
default_model = "claude-opus-4-6"
cli_path = "claude"
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.requireMention).toBe(false);
  });

  it("rejects a non-boolean value", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
allowed_chat_ids = ["oc_test"]
require_mention = "yes"

[agent]
default_cwd = "/tmp/cfc-test"

[claude]
default_model = "claude-opus-4-6"
cli_path = "claude"
`);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });
});
