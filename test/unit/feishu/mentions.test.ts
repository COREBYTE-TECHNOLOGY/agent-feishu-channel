import { describe, expect, it } from "vitest";
import {
  mentionsName,
  mentionsOpenId,
  stripMentions,
  type FeishuMention,
} from "../../../src/feishu/mentions.js";
import { extractBotIdentity } from "../../../src/feishu/client.js";

const CLAUDE_BOT: FeishuMention = {
  key: "@_user_1",
  id: { open_id: "ou_claude_bot" },
  name: "corebyte-claude",
};
const CODEX_BOT: FeishuMention = {
  key: "@_user_2",
  id: { open_id: "ou_codex_bot" },
  name: "corebyte-codex",
};

describe("stripMentions", () => {
  it("strips a leading mention so a command parses", () => {
    expect(stripMentions("@_user_1 /stop", [CLAUDE_BOT])).toBe("/stop");
  });

  it("preserves plain text after a mention", () => {
    expect(stripMentions("@_user_1 看下这个 PR", [CLAUDE_BOT])).toBe(
      "看下这个 PR",
    );
  });

  it("strips multiple mentions in one message", () => {
    expect(stripMentions("@_user_1 @_user_2 /status", [CLAUDE_BOT, CODEX_BOT])).toBe(
      "/status",
    );
  });

  it("strips @_all", () => {
    expect(stripMentions("@_all deploy now", [{ key: "@_all", name: "all" }])).toBe(
      "deploy now",
    );
  });

  it("strips built-in placeholders even without a mentions array", () => {
    expect(stripMentions("@_user_3 /help")).toBe("/help");
    expect(stripMentions("@_all ping", undefined)).toBe("ping");
  });

  it("collapses a mention sitting between words to a single space", () => {
    expect(stripMentions("hey @_user_1 look", [CLAUDE_BOT])).toBe("hey look");
  });

  it("strips a trailing mention", () => {
    expect(stripMentions("look at this @_user_1", [CLAUDE_BOT])).toBe("look at this");
  });

  it("keeps newlines in a multi-line message", () => {
    expect(stripMentions("@_user_1 line one\nline two", [CLAUDE_BOT])).toBe(
      "line one\nline two",
    );
  });

  it("does not let a short key eat a longer one", () => {
    const many: FeishuMention[] = [
      { key: "@_user_1", id: { open_id: "ou_a" } },
      { key: "@_user_11", id: { open_id: "ou_b" } },
    ];
    expect(stripMentions("@_user_11 hi", many)).toBe("hi");
  });

  it("supports non-standard keys and escapes regex metacharacters", () => {
    expect(stripMentions("@bot(1) /stop", [{ key: "@bot(1)" }])).toBe("/stop");
  });

  it("returns the trimmed original when there is nothing to strip", () => {
    expect(stripMentions("  /stop  ")).toBe("/stop");
    expect(stripMentions("")).toBe("");
  });
});

describe("mentionsOpenId / mentionsName", () => {
  it("matches our own open_id", () => {
    expect(mentionsOpenId([CLAUDE_BOT, CODEX_BOT], "ou_claude_bot")).toBe(true);
  });

  it("does not match another bot's open_id", () => {
    expect(mentionsOpenId([CODEX_BOT], "ou_claude_bot")).toBe(false);
  });

  it("never matches an empty or missing open_id", () => {
    expect(mentionsOpenId([{ key: "@_user_1", id: {} }], undefined)).toBe(false);
    expect(mentionsOpenId([{ key: "@_user_1", id: {} }], "")).toBe(false);
    expect(mentionsOpenId(undefined, "ou_claude_bot")).toBe(false);
  });

  it("matches by display name for the fallback path", () => {
    expect(mentionsName([CLAUDE_BOT], "corebyte-claude")).toBe(true);
    expect(mentionsName([CODEX_BOT], "corebyte-claude")).toBe(false);
    expect(mentionsName([CLAUDE_BOT], undefined)).toBe(false);
  });
});

describe("extractBotIdentity (bot/v3/info envelope tolerance)", () => {
  it("reads the documented top-level `bot` object", () => {
    expect(
      extractBotIdentity({
        code: 0,
        msg: "ok",
        bot: { app_name: "corebyte-claude", open_id: "ou_claude_bot" },
      }),
    ).toEqual({ openId: "ou_claude_bot", appName: "corebyte-claude" });
  });

  it("reads a `data.bot` envelope", () => {
    expect(
      extractBotIdentity({
        code: 0,
        data: { bot: { app_name: "corebyte-codex", open_id: "ou_codex_bot" } },
      }),
    ).toEqual({ openId: "ou_codex_bot", appName: "corebyte-codex" });
  });

  it("reads a flat `data` envelope", () => {
    expect(
      extractBotIdentity({ code: 0, data: { open_id: "ou_x", app_name: "x" } }),
    ).toEqual({ openId: "ou_x", appName: "x" });
  });

  it("reads a bare top-level payload", () => {
    expect(extractBotIdentity({ open_id: "ou_y" })).toEqual({ openId: "ou_y" });
  });

  it("returns an empty identity for garbage", () => {
    expect(extractBotIdentity(null)).toEqual({});
    expect(extractBotIdentity("nope")).toEqual({});
    expect(extractBotIdentity({ code: 0, data: {} })).toEqual({});
  });
});
