import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export interface JournalCommentRef {
  id: number;
  url: string;
}

export interface JournalRemote {
  find(marker: string): Promise<JournalCommentRef | null>;
  create(marker: string, body: string): Promise<JournalCommentRef>;
  update(marker: string, id: number, body: string): Promise<JournalCommentRef>;
}

export interface GhExecutionRequest {
  executable: string;
  args: readonly string[];
  input?: string;
  timeoutMs: number;
  maxBufferBytes: number;
  env: NodeJS.ProcessEnv;
}

/** Injectable for offline tests; implementations must honor the supplied limits. */
export type GhExecutor = (request: GhExecutionRequest) => Promise<string>;

export interface GhIssueJournalClientOptions {
  repo: string;
  issue: number;
  ghPath: string;
  expectedLogin: string;
  execute?: GhExecutor;
}

const ALLOWED_REPO = "COREBYTE-TECHNOLOGY/corebyte";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function failure(reason: string): Error {
  // Never attach CLI errors, causes, stdout, stderr, markers, or comment bodies.
  return new Error(`GitHub journal: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function markerCount(body: string, marker: string): number {
  return body.split(/\r?\n/).filter((line) => line === marker).length;
}

function validateMarker(marker: string): void {
  if (typeof marker !== "string" || marker.trim().length === 0 ||
      Buffer.byteLength(marker) > 512 || /[\u0000-\u001f\u007f]/.test(marker)) {
    throw failure("invalid marker");
  }
}

function commentBody(marker: string, body: string): string {
  validateMarker(marker);
  if (typeof body !== "string") throw failure("invalid comment body");
  const count = markerCount(body, marker);
  if (count > 1) throw failure("duplicate marker in comment body");
  const result = count === 1 ? body : `${body}\n\n${marker}`;
  if (Buffer.byteLength(result) > MAX_BODY_BYTES) throw failure("comment body is too large");
  return result;
}

function ghEnvironment(): NodeJS.ProcessEnv {
  // gh uses its existing local login/configuration. Do not forward token, host,
  // debug, or arbitrary configuration overrides from the bridge environment.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

const executeGh: GhExecutor = (request) => new Promise((resolve, reject) => {
  const child = execFile(request.executable, [...request.args], {
    encoding: "utf8",
    shell: false,
    timeout: request.timeoutMs,
    maxBuffer: request.maxBufferBytes,
    killSignal: "SIGKILL",
    env: request.env,
  }, (error, stdout) => {
    if (error) reject(failure("request failed"));
    else resolve(stdout);
  });
  child.stdin?.on("error", () => {
    child.kill("SIGKILL");
    reject(failure("request failed"));
  });
  child.stdin?.end(request.input);
});

/** Fixed-repository, fixed-issue transport; no POST retries are performed here. */
export class GhIssueJournalClient implements JournalRemote {
  private readonly issue: number;
  private readonly ghPath: string;
  private readonly expectedLogin: string;
  private readonly execute: GhExecutor;

  constructor(options: GhIssueJournalClientOptions) {
    if (options.repo !== ALLOWED_REPO) throw failure("repository is not allowed");
    if (!validId(options.issue)) throw failure("invalid issue number");
    if (typeof options.ghPath !== "string" || !isAbsolute(options.ghPath) ||
        /[\u0000-\u001f\u007f]/.test(options.ghPath)) throw failure("invalid gh executable path");
    if (typeof options.expectedLogin !== "string" ||
        !/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(options.expectedLogin)) {
      throw failure("invalid expected login");
    }
    this.issue = options.issue;
    this.ghPath = options.ghPath;
    this.expectedLogin = options.expectedLogin.toLowerCase();
    this.execute = options.execute ?? executeGh;
  }

  async find(marker: string): Promise<JournalCommentRef | null> {
    validateMarker(marker);
    await this.assertLogin();
    let found: JournalCommentRef | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.request("GET",
        `repos/${ALLOWED_REPO}/issues/${this.issue}/comments?per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw failure("invalid comment list response");
      for (const row of rows) {
        if (!isRecord(row) || typeof row.body !== "string") throw failure("invalid comment list response");
        if (markerCount(row.body, marker) === 0) continue;
        const match = this.validateComment(row, marker);
        if (found !== null) throw failure("multiple comments contain the task marker");
        found = match;
      }
      // Scan the entire list, even after a match, to reject foreign collisions.
      if (rows.length < PAGE_SIZE) return found;
    }
    throw failure("comment search limit exceeded");
  }

  async create(marker: string, body: string): Promise<JournalCommentRef> {
    const payload = commentBody(marker, body);
    await this.assertLogin();
    const response = await this.request("POST",
      `repos/${ALLOWED_REPO}/issues/${this.issue}/comments`, payload);
    // A failure here is an uncertain write: the caller must find before retrying.
    return this.validateComment(response, marker);
  }

  async update(marker: string, id: number, body: string): Promise<JournalCommentRef> {
    if (!validId(id)) throw failure("invalid comment id");
    const payload = commentBody(marker, body);
    await this.assertLogin();
    const endpoint = `repos/${ALLOWED_REPO}/issues/comments/${id}`;
    this.validateComment(await this.request("GET", endpoint), marker, id);
    return this.validateComment(await this.request("PATCH", endpoint, payload), marker, id);
  }

  private async assertLogin(): Promise<void> {
    const user = await this.request("GET", "user");
    if (!isRecord(user) || typeof user.login !== "string" ||
        user.login.toLowerCase() !== this.expectedLogin) {
      throw failure("authenticated login does not match expected login");
    }
  }

  private async request(method: "GET" | "POST" | "PATCH", endpoint: string, body?: string): Promise<unknown> {
    const args = ["api", endpoint, "--hostname", "github.com", "--method", method,
      "--header", "Accept: application/vnd.github+json",
      "--header", "X-GitHub-Api-Version: 2026-03-10"];
    if (body !== undefined) args.push("--input", "-");
    let output: string;
    try {
      output = await this.execute({
        executable: this.ghPath,
        args,
        ...(body !== undefined ? { input: JSON.stringify({ body }) } : {}),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBufferBytes: MAX_BUFFER_BYTES,
        env: ghEnvironment(),
      });
    } catch {
      throw failure("request failed");
    }
    if (typeof output !== "string" || Buffer.byteLength(output) > MAX_BUFFER_BYTES) {
      throw failure("response is too large or invalid");
    }
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw failure("invalid JSON response");
    }
  }

  private validateComment(value: unknown, marker: string, expectedId?: number): JournalCommentRef {
    if (!isRecord(value) || !validId(value.id) ||
        (expectedId !== undefined && value.id !== expectedId) ||
        typeof value.body !== "string" || markerCount(value.body, marker) !== 1) {
      throw failure("comment identity or marker does not match");
    }
    if (!isRecord(value.user) || typeof value.user.login !== "string" ||
        value.user.login.toLowerCase() !== this.expectedLogin) {
      throw failure("task marker belongs to a different author");
    }
    if (typeof value.issue_url !== "string" ||
        value.issue_url.toLowerCase() !== `https://api.github.com/repos/${ALLOWED_REPO}/issues/${this.issue}`.toLowerCase()) {
      throw failure("comment does not belong to the configured issue");
    }
    const expectedUrl = `https://github.com/${ALLOWED_REPO}/issues/${this.issue}#issuecomment-${value.id}`;
    if (typeof value.html_url !== "string" || value.html_url.toLowerCase() !== expectedUrl.toLowerCase()) {
      throw failure("invalid comment URL");
    }
    return { id: value.id, url: value.html_url };
  }
}
