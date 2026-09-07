import { describe, expect, it } from "vitest";
import { createRedactor } from "../../../src/audit/redact.js";

// Every value in this suite is synthetic; no local credentials are loaded.
const redact = createRedactor([]);

describe("createRedactor (corebyte #52)", () => {
  it("replaces literal known secrets longest-first and ignores empty/blank entries", () => {
    const filter = createRedactor(["", " ", "fake.secret+", "fake.secret+long", "fake.secret+"]);
    expect(filter("before fake.secret+long / fake.secret+ after"))
      .toBe("before [REDACTED] / [REDACTED] after");
    expect(createRedactor(["", "\n"])("ordinary text")).toBe("ordinary text");
  });

  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"])(
    "removes multiline %s blocks",
    (kind) => {
      expect(redact(`before\n-----BEGIN ${kind}-----\nSYNTHETIC_PRIVATE_DATA\n-----END ${kind}-----\nafter`))
        .toBe("before\n[REDACTED]\nafter");
    },
  );

  it("removes an unterminated private key instead of leaking its tail", () => {
    expect(redact("-----BEGIN PRIVATE KEY-----\nfake unfinished content"))
      .toBe("[REDACTED]");
  });

  it.each([
    "ghp_synthetic123456789", "gho_synthetic123456789", "ghu_synthetic123456789",
    "ghs_synthetic123456789", "ghr_synthetic123456789", "github_pat_synthetic123456789",
    "sk-synthetic123456789", "sk-proj-synthetic123456789", "sk-svcacct-synthetic123456789",
    "LTAIsynthetic123456789", "STS.synthetic123456789", "eyJfake.fakepayload.fakesignature",
  ])("removes a recognized synthetic credential prefix: %s", (value) => {
    expect(redact(`value ${value} end`)).toBe("value [REDACTED] end");
  });

  it.each([
    "password=", "PASSWORD = ", "passwd:", "pwd:", "app_secret=", "TOKEN=",
    "OPENAI_API_KEY=", "AccessKeyId:", "AccessKeySecret=", "clientSecret = ",
    "private_key=", "Cookie:", "密码：", "登录密码=", "密钥为", "令牌是", "口令：",
  ])("removes sensitive assignment values (%s)", (prefix) => {
    expect(redact(`${prefix}synthetic-short`)).not.toContain("synthetic-short");
    expect(redact(`${prefix}synthetic-short`)).toContain("[REDACTED]");
  });

  it("covers quoted JSON, shell values with spaces, and escaped quotes", () => {
    const input = '{"password":"two synthetic words","token":"fake\\\"quoted"} export API_KEY=\'another synthetic value\'';
    const result = redact(input);
    expect(result).not.toMatch(/synthetic|quoted|another/);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("recognizes assignments even when a known secret is itself a key word", () => {
    expect(createRedactor(["password"])("password=unlisted-short-value"))
      .not.toContain("unlisted-short-value");
    expect(createRedactor(["alpha token=beta gamma"])("alpha token=beta gamma"))
      .toBe("[REDACTED]");
  });

  it.each([
    "Authorization: Bearer synthetic-token",
    '"Authorization": "Bearer synthetic-token"',
    "authorization=Basic synthetic-basic",
    "Proxy-Authorization: Negotiate synthetic-other",
    "curl -H 'Authorization: Bearer synthetic-token' https://example.test",
    "Bearer synthetic-token",
  ])("removes authorization credentials (%s)", (input) => {
    expect(redact(input)).not.toMatch(/synthetic-(?:token|basic|other)/);
  });

  it("removes URL userinfo, sensitive query/fragment values, and encoded sensitive keys", () => {
    const result = redact("https://fake-user:fake-pass@example.test/path?ok=1&%74oken=hidden-short#client_secret=other-short");
    expect(result).not.toMatch(/fake-user|fake-pass|hidden-short|other-short/);
    expect(result).toContain("example.test/path?ok=1");
    expect(result).toContain("%74oken=[REDACTED]");
  });

  it("removes percent-encoded known secrets under an otherwise ordinary URL key", () => {
    expect(createRedactor(["synthetic/value"])("https://example.test/?value=synthetic%252Fvalue&ok=1"))
      .toContain("value=[REDACTED]&ok=1");
    const encodedOpaque = [..."Ab9_".repeat(8)]
      .map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    expect(redact(`https://example.test/?value=${encodedOpaque}`))
      .toBe("https://example.test/?value=[REDACTED]");
  });

  it("does not throw for malformed URL encoding", () => {
    expect(redact("https://example.test/?token=%not-valid&ok=1"))
      .not.toContain("%not-valid");
  });

  it("hides signed URL credentials and does not duplicate redaction markers", () => {
    expect(redact("https://example.test/?token=short&X-Amz-Signature=short-signature&OSSAccessKeyId=short-id&key=short-key"))
      .toBe("https://example.test/?token=[REDACTED]&X-Amz-Signature=[REDACTED]&OSSAccessKeyId=[REDACTED]&key=[REDACTED]");
    expect(redact("Authorization: Bearer short-token")).toBe("Authorization: [REDACTED]");
  });

  it.each(["ou_synthetic", "oc_synthetic", "cli_synthetic"])("hides Lark identity %s", (id) => {
    expect(redact(`identity ${id}`)).toBe("identity [REDACTED]");
  });

  it("redacts opaque identifiers at 32 characters, including padded base64", () => {
    const opaque = "Ab9_".repeat(8);
    const base64 = "Ab9/".repeat(10) + "==";
    expect(redact(`value ${opaque} ${base64}`)).toBe("value [REDACTED] [REDACTED]");
    expect(redact(`value ${"Ab9/".repeat(8)}`)).toBe("value [REDACTED]");
    expect(redact("a".repeat(31))).toBe("a".repeat(31));
  });

  it("preserves Git SHA evidence but not labelled or known hex secrets", () => {
    const sha40 = "abcdef0123".repeat(4);
    const sha64 = "abcdef01".repeat(8);
    expect(redact(`commit ${sha40} tree ${sha64}`)).toBe(`commit ${sha40} tree ${sha64}`);
    expect(redact(`commit=${sha40} sha=${sha64}`)).toBe(`commit=${sha40} sha=${sha64}`);
    expect(redact(`token=${sha40}`)).not.toContain(sha40);
    expect(createRedactor([sha64])(sha64)).toBe("[REDACTED]");
  });

  it("preserves ordinary text, short commands, paths, and GitHub Issue/PR links", () => {
    const text = "请检查 git diff -- src/audit/redact.ts\nhttps://github.com/COREBYTE-TECHNOLOGY/agent-feishu-channel/issues/52\nhttps://github.com/COREBYTE-TECHNOLOGY/agent-feishu-channel/pull/8#issuecomment-123";
    expect(redact(text)).toBe(text);
    const longRepo = "ordinary-repository-name-with-many-words";
    const link = `https://github.com/test-org/${longRepo}/issues/52`;
    expect(redact(link)).toBe(link);
    expect(redact(`${"Ab9/".repeat(10)}== ${link}`)).toBe(`[REDACTED] ${link}`);
    const path = "/Users/example/Documents/Codex/project/src/audit/redact.ts";
    expect(redact(`git diff -- ${path}`)).toBe(`git diff -- ${path}`);
  });

  it("neutralizes hidden comments, HTML, image embeds, mentions, and code-fence breakouts", () => {
    const input = '<!--hidden instructions--><img src="https://example.test/image"> ![image](https://example.test/image) ![ref][image] @someone @org/team &#64;other\n```\n~~~';
    const result = redact(input);
    expect(result).not.toMatch(/hidden instructions|<!--|<img|!\[|@someone|@org|&#64;|```|~~~/);
    expect(result).toContain("&lt;img");
    expect(result).toContain("！[image]");
    expect(result).toContain("＠someone");
  });

  it("removes unterminated hidden comments and deobfuscates formatting controls", () => {
    expect(redact("visible <!--hidden forever")).toBe("visible [REDACTED]");
    expect(redact("password=synthe\u200btic-short")).not.toContain("tic-short");
    expect(createRedactor(["ab\u200bcd"])("ab\u200bcd abcd")).toBe("[REDACTED] [REDACTED]");
  });

  it("redacts before truncation, including a private-key block beyond the limit", () => {
    const secret = "synthetic-known-value".repeat(10);
    const result = createRedactor([secret])(`prefix ${secret} suffix`, 16);
    expect(result).not.toContain("synthetic");
    expect(result.length).toBeLessThanOrEqual(16);
    expect(redact("-----BEGIN PRIVATE KEY-----\n" + "x".repeat(500), 30)).toBe("[REDACTED]");
  });

  it("applies bounded truncation and handles tiny/invalid limits without splitting emoji", () => {
    expect(redact("ordinary text", 0)).toBe("");
    expect(redact("ordinary text", 1)).toBe("…");
    expect(redact("ordinary text", -1)).toBe("");
    expect(redact("😀abc", 2)).toBe("…");
    expect(redact("x ".repeat(10_000))).toHaveLength(8_000);
    expect(redact("x ".repeat(10_000), Number.NaN)).toHaveLength(8_000);
  });

  it("documents the heuristic boundary: an unknown short unlabelled value is not identified", () => {
    expect(redact("unlabelled short-value")).toBe("unlabelled short-value");
  });
});
