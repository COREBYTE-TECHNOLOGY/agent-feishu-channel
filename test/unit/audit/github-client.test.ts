import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import {
  GhIssueJournalClient,
  type GhExecutionRequest,
  type GhExecutor,
  type GhIssueJournalClientOptions,
} from "../../../src/audit/github-client.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const REPO = "COREBYTE-TECHNOLOGY/corebyte";
const MARKER = "<!-- corebyte-journal:task-1 -->";
const BODY = `Task report\n\n${MARKER}`;
const BASE = { repo: REPO, issue: 52, ghPath: "/opt/homebrew/bin/gh", expectedLogin: "JournalOwner" };

function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    html_url: `https://github.com/${REPO}/issues/52#issuecomment-123`,
    issue_url: `https://api.github.com/repos/${REPO}/issues/52`,
    user: { login: "JournalOwner" },
    body: BODY,
    ...overrides,
  };
}

function fixture(responses: unknown[], options: Partial<GhIssueJournalClientOptions> = {}) {
  const calls: GhExecutionRequest[] = [];
  const execute: GhExecutor = async (request) => {
    calls.push(request);
    if (responses.length === 0) throw new Error("unexpected request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return JSON.stringify(response);
  };
  return { client: new GhIssueJournalClient({ ...BASE, execute, ...options }), calls };
}

const user = () => ({ login: "journalowner" });
const ref = { id: 123, url: `https://github.com/${REPO}/issues/52#issuecomment-123` };

describe("GhIssueJournalClient configuration", () => {
  it.each(["other/repo", "corebyte-technology/corebyte", "COREBYTE-TECHNOLOGY/corebyte/../other"])(
    "rejects non-allowlisted repo %s", (repo) => {
      expect(() => new GhIssueJournalClient({ ...BASE, repo })).toThrow("repository is not allowed");
    });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid issue %s", (issue) => {
      expect(() => new GhIssueJournalClient({ ...BASE, issue })).toThrow("invalid issue number");
    });
  it.each(["gh", "", "/tmp/gh\n--evil"])("requires a valid absolute gh path %s", (ghPath) => {
    expect(() => new GhIssueJournalClient({ ...BASE, ghPath })).toThrow("invalid gh executable path");
  });
  it.each(["", "user/name", "someone\nelse"])("rejects invalid login %s", (expectedLogin) => {
    expect(() => new GhIssueJournalClient({ ...BASE, expectedLogin })).toThrow("invalid expected login");
  });
});

describe("GhIssueJournalClient find", () => {
  it("returns null for no matching complete line; inline and partial markers do not match", async () => {
    const { client } = fixture([user(), [comment({ body: `prefix ${MARKER}\n${MARKER} suffix\n${MARKER}x` })]]);
    await expect(client.find(MARKER)).resolves.toBeNull();
  });

  it("matches a complete CRLF-delimited marker line and case-insensitive author", async () => {
    const { client } = fixture([user(), [comment({ body: `hello\r\n${MARKER}\r\nworld`, user: { login: "JOURNALOWNER" } })]]);
    await expect(client.find(MARKER)).resolves.toEqual(ref);
  });

  it("paginates 100 comments per request and finds the second page", async () => {
    const { client, calls } = fixture([user(), Array.from({ length: 100 }, () => comment({ body: "unrelated" })), [comment()]]);
    await expect(client.find(MARKER)).resolves.toEqual(ref);
    expect(calls.map((call) => call.args[1])).toEqual([
      "user", `repos/${REPO}/issues/52/comments?per_page=100&page=1`,
      `repos/${REPO}/issues/52/comments?per_page=100&page=2`,
    ]);
  });

  it("continues after a match and rejects a foreign-author collision on a later page", async () => {
    const firstPage = [comment(), ...Array.from({ length: 99 }, () => comment({ body: "unrelated" }))];
    const { client, calls } = fixture([user(), firstPage, [comment({ user: { login: "attacker" } })]]);
    await expect(client.find(MARKER)).rejects.toThrow("different author");
    expect(calls).toHaveLength(3);
  });

  it("rejects a lone foreign marker instead of treating it as absent", async () => {
    const { client } = fixture([user(), [comment({ user: { login: "attacker" } })]]);
    await expect(client.find(MARKER)).rejects.toThrow("different author");
  });

  it("rejects duplicate owned markers rather than choosing an arbitrary comment", async () => {
    const { client } = fixture([user(), [comment(), comment()]]);
    await expect(client.find(MARKER)).rejects.toThrow("multiple comments");
  });

  it.each([{}, [null], [comment({ body: null })]])("fails closed on malformed lists", async (response) => {
    const { client } = fixture([user(), response]);
    await expect(client.find(MARKER)).rejects.toThrow("invalid comment list response");
  });

  it("fails closed when the search page cap is reached", async () => {
    const page = Array.from({ length: 100 }, () => comment({ body: "unrelated" }));
    const { client, calls } = fixture([user(), ...Array.from({ length: 100 }, () => page)]);
    await expect(client.find(MARKER)).rejects.toThrow("search limit exceeded");
    expect(calls).toHaveLength(101);
  });
});

describe("GhIssueJournalClient writes", () => {
  it("creates once using JSON stdin, never shell arguments, and appends the marker", async () => {
    const body = "quote \" and $(touch /tmp/should-not-exist); `shell`\nnext line";
    const { client, calls } = fixture([user(), comment({ body: `${body}\n\n${MARKER}` })]);
    await expect(client.create(MARKER, body)).resolves.toEqual(ref);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("POST");
    expect(calls[1]!.args).toContain(`repos/${REPO}/issues/52/comments`);
    expect(calls[1]!.args.slice(-2)).toEqual(["--input", "-"]);
    expect(calls[1]!.args.join(" ")).not.toContain(body);
    expect(JSON.parse(calls[1]!.input!)).toEqual({ body: `${body}\n\n${MARKER}` });
  });

  it("does not duplicate an existing complete marker line", async () => {
    const { client, calls } = fixture([user(), comment()]);
    await client.create(MARKER, BODY);
    expect(JSON.parse(calls[1]!.input!)).toEqual({ body: BODY });
  });

  it("does not retry an uncertain POST failure", async () => {
    const { client, calls } = fixture([user(), new Error("sensitive stderr and original body")]);
    await expect(client.create(MARKER, BODY)).rejects.toThrow("GitHub journal: request failed");
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes("POST"))).toHaveLength(1);
  });

  it("GET-verifies the marker, author, issue, and id before PATCH", async () => {
    const { client, calls } = fixture([user(), comment(), comment({ body: `updated\n${MARKER}` })]);
    await expect(client.update(MARKER, 123, `updated\n${MARKER}`)).resolves.toEqual(ref);
    expect(calls.map((call) => [call.args[1], call.args[5]])).toEqual([
      ["user", "GET"], [`repos/${REPO}/issues/comments/123`, "GET"],
      [`repos/${REPO}/issues/comments/123`, "PATCH"],
    ]);
    expect(JSON.parse(calls[2]!.input!)).toEqual({ body: `updated\n${MARKER}` });
  });

  it.each([
    { body: "different marker" },
    { body: `${MARKER}\n${MARKER}` },
    { user: { login: "attacker" } },
    { issue_url: `https://api.github.com/repos/${REPO}/issues/53` },
    { issue_url: "https://api.github.com/repos/attacker/corebyte/issues/52" },
    { issue_url: `https://api.github.com.evil.example/repos/${REPO}/issues/52` },
    { id: 124 },
    { html_url: "https://evil.example/comment" },
  ])("does not PATCH a comment that fails preflight validation: %j", async (overrides) => {
    const { client, calls } = fixture([user(), comment(overrides)]);
    await expect(client.update(MARKER, 123, BODY)).rejects.toThrow("GitHub journal:");
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.args.includes("PATCH"))).toBe(false);
  });

  it("rejects a mismatched write response without a second write", async () => {
    const { client, calls } = fixture([user(), comment(), comment({ user: { login: "other" } })]);
    await expect(client.update(MARKER, 123, BODY)).rejects.toThrow("different author");
    expect(calls.filter((call) => call.args.includes("PATCH"))).toHaveLength(1);
  });
});

describe("GhIssueJournalClient boundaries", () => {
  it.each(["find", "create", "update"] as const)("checks active gh identity before %s", async (operation) => {
    const { client, calls } = fixture([{ login: "someone-else" }]);
    const result = operation === "find" ? client.find(MARKER)
      : operation === "create" ? client.create(MARKER, BODY) : client.update(MARKER, 123, BODY);
    await expect(result).rejects.toThrow("authenticated login does not match");
    expect(calls).toHaveLength(1);
  });

  it("rechecks active identity for each operation", async () => {
    const { client, calls } = fixture([user(), [], { login: "different" }]);
    await client.find(MARKER);
    await expect(client.create(MARKER, BODY)).rejects.toThrow("authenticated login does not match");
    expect(calls).toHaveLength(3);
  });

  it.each(["", "one\ntwo", "one\rtwo", "a\u0000b", "x".repeat(513)])("rejects invalid markers before any request", async (marker) => {
    const { client, calls } = fixture([]);
    await expect(client.find(marker)).rejects.toThrow("invalid marker");
    expect(calls).toHaveLength(0);
  });

  it("rejects repeated markers, oversized bodies, and invalid ids before any request", async () => {
    const { client, calls } = fixture([]);
    await expect(client.create(MARKER, `${MARKER}\n${MARKER}`)).rejects.toThrow("duplicate marker");
    await expect(client.create(MARKER, "x".repeat(60_000))).rejects.toThrow("too large");
    await expect(client.update(MARKER, 0, BODY)).rejects.toThrow("invalid comment id");
    expect(calls).toHaveLength(0);
  });

  it("passes per-request timeout, bounded buffers, fixed host, and an allowlisted environment", async () => {
    const { client, calls } = fixture([user(), []]);
    await client.find(MARKER);
    for (const request of calls) {
      expect(request.timeoutMs).toBe(10_000);
      expect(request.maxBufferBytes).toBe(2 * 1024 * 1024);
      expect(request.args.slice(2, 4)).toEqual(["--hostname", "github.com"]);
      expect(request.input).toBeUndefined();
      expect(Object.keys(request.env).sort()).toEqual(expect.arrayContaining(["GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT"]));
      expect(Object.keys(request.env).every((key) => ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT"].includes(key))).toBe(true);
    }
  });

  it.each(["sensitive non-JSON body", "x".repeat(2 * 1024 * 1024 + 1)])("never exposes invalid raw output", async (output) => {
    const client = new GhIssueJournalClient({ ...BASE, execute: async () => output });
    const error = await client.find(MARKER).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(output.slice(0, 20));
    expect((error as Error).cause).toBeUndefined();
  });

  it("does not propagate sensitive executor errors or their causes", async () => {
    const original = Object.assign(new Error("SYNTHETIC_SECRET stdout body"), { stdout: BODY, stderr: "SYNTHETIC_SECRET" });
    const { client } = fixture([original]);
    const error = await client.find(MARKER).catch((reason: unknown) => reason);
    expect((error as Error).message).toBe("GitHub journal: request failed");
    expect((error as Error).cause).toBeUndefined();
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
  });
});

describe("default gh executor", () => {
  it("uses execFile with no shell and sends write JSON only to stdin", async () => {
    const inputs: Array<string | undefined> = [];
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      const stdin = Object.assign(new EventEmitter(), { end: (input?: string) => { inputs.push(input); } });
      const cliArgs = args[1] as string[];
      queueMicrotask(() => callback(null, JSON.stringify(cliArgs[1] === "user" ? user() : comment()), ""));
      return { stdin, kill: vi.fn() } as unknown as ReturnType<typeof execFile>;
    });
    const client = new GhIssueJournalClient(BASE);
    await expect(client.create(MARKER, BODY)).resolves.toEqual(ref);
    expect(inputs).toEqual([undefined, JSON.stringify({ body: BODY })]);
    const last = vi.mocked(execFile).mock.calls.at(-1)!;
    expect(last[0]).toBe(BASE.ghPath);
    expect(last[2]).toMatchObject({ shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" });
    vi.mocked(execFile).mockReset();
  });

  it("sanitizes a default execFile failure", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(new Error("SYNTHETIC_SECRET timeout stderr"), BODY, "SYNTHETIC_SECRET"));
      return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() } as unknown as ReturnType<typeof execFile>;
    });
    await expect(new GhIssueJournalClient(BASE).find(MARKER)).rejects.toThrow("GitHub journal: request failed");
    vi.mocked(execFile).mockReset();
  });
});
