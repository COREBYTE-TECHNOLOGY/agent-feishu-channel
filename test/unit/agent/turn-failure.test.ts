import { describe, expect, it } from "vitest";
import {
  classifyTurnFailure,
  errorText,
  formatTurnFailure,
} from "../../../src/agent/turn-failure.js";

/** The exact string seen in production on 2026-09-04. */
const PROD_AUTH_ERROR =
  "Claude Code returned an error result: Not logged in · Please run /login";

describe("classifyTurnFailure", () => {
  it("recognises the production 'Not logged in · Please run /login' error", () => {
    expect(classifyTurnFailure(new Error(PROD_AUTH_ERROR))).toBe(
      "provider_auth",
    );
  });

  it.each([
    "Invalid API key",
    "authentication_error: bad credentials",
    "Login required",
    "OAuth token has expired",
    "Not authenticated. Please run `codex login`.",
  ])("recognises %s as an auth failure", (message) => {
    expect(classifyTurnFailure(new Error(message))).toBe("provider_auth");
  });

  it.each([
    "Claude turn failed (error_during_execution): boom",
    "Claude turn ended without a result message",
    "ENOENT: no such file or directory",
    "request too large",
  ])("treats %s as a generic failure", (message) => {
    expect(classifyTurnFailure(new Error(message))).toBe("generic");
  });
});

describe("errorText", () => {
  it("unwraps Error, string and object shapes", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ code: 42 })).toBe('{"code":42}');
  });
});

describe("formatTurnFailure", () => {
  it("renders a generic failure with the underlying reason", () => {
    const text = formatTurnFailure({
      err: new Error("boom"),
      provider: "claude",
      locale: "zh",
    });
    expect(text).toBe("❌ 本次执行失败：boom");
  });

  it("gives Claude auth failures actionable /login steps", () => {
    const text = formatTurnFailure({
      err: new Error(PROD_AUTH_ERROR),
      provider: "claude",
      locale: "zh",
    });
    expect(text).toContain("本次执行失败");
    expect(text).toContain("Claude Code CLI");
    expect(text).toContain("运行 `claude`");
    expect(text).toContain("`/login`");
    expect(text).toContain("运行本 bridge 的那台机器");
    expect(text).toContain("不需要重启");
    // The raw provider text is still there for debugging.
    expect(text).toContain("Not logged in");
  });

  it("gives Codex auth failures the codex login flow instead", () => {
    const text = formatTurnFailure({
      err: new Error("Not logged in"),
      provider: "codex",
      locale: "zh",
    });
    expect(text).toContain("Codex CLI");
    expect(text).toContain("`codex login`");
    expect(text).not.toContain("运行 `claude`");
  });

  it("localises to English", () => {
    expect(
      formatTurnFailure({
        err: new Error("boom"),
        provider: "claude",
        locale: "en",
      }),
    ).toBe("❌ This turn failed: boom");

    const auth = formatTurnFailure({
      err: new Error(PROD_AUTH_ERROR),
      provider: "claude",
      locale: "en",
    });
    expect(auth).toContain("is not logged in");
    expect(auth).toContain("`/login`");
    expect(auth).toContain("machine running this bridge");
  });

  it("defaults to Chinese when no locale is given", () => {
    expect(
      formatTurnFailure({ err: new Error("boom"), provider: "claude" }),
    ).toContain("本次执行失败");
  });
});
