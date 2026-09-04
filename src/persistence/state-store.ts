import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SeenMessage } from "../util/dedup.js";

export interface SessionRecord {
  provider: "claude" | "codex";
  providerSessionId?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
}

type LegacySessionRecordInput = {
  claudeSessionId: string;
  provider?: "claude" | "codex";
  providerSessionId?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
};

export interface State {
  version: 3;
  lastCleanShutdown: boolean;
  /**
   * Sessions keyed by `chatId\t\tprovider` (default project) or
   * `chatId\tprojectAlias\tprovider` (named project). Older state files may
   * still contain legacy keys without a provider suffix and are normalized by
   * the session manager at runtime.
   */
  sessions: Record<string, SessionRecord>;
  /** Tracks the currently active project alias per chatId. */
  activeProjects: Record<string, string>;
  /** Tracks the currently selected provider per chatId or `chatId\tprojectAlias`. */
  activeProviders: Record<string, "claude" | "codex">;
}

const INITIAL_STATE: State = {
  version: 3,
  lastCleanShutdown: true,
  sessions: {},
  activeProjects: {},
  activeProviders: {},
};

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeSessionRecord(record: unknown): SessionRecord {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid session record in state file");
  }

  const session = record as LegacySessionRecordInput;

  const provider =
    session.provider === "claude" || session.provider === "codex"
      ? session.provider
      : isString(session.claudeSessionId)
        ? "claude"
      : undefined;
  const providerSessionId = isString(session.providerSessionId)
    ? session.providerSessionId
    : isString(session.claudeSessionId)
      ? session.claudeSessionId
      : undefined;

  if (!provider || !isString(session.cwd) || !isString(session.createdAt) || !isString(session.lastActiveAt)) {
    throw new Error("Unsupported session record shape in state file");
  }

  return {
    provider,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(isString(session.permissionMode)
      ? { permissionMode: session.permissionMode }
      : {}),
    ...(isString(session.model) ? { model: session.model } : {}),
    ...(isString(session.effort) ? { effort: session.effort } : {}),
  };
}

function normalizeState(parsed: {
  lastCleanShutdown?: unknown;
  sessions?: Record<string, unknown>;
  activeProjects?: Record<string, string>;
  activeProviders?: Record<string, unknown>;
}): State {
  const sessions: Record<string, SessionRecord> = {};
  for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
    try {
      sessions[key] = normalizeSessionRecord(value);
    } catch (err) {
      // Older builds could persist placeholder records before a real
      // session ID was captured. Skip those malformed records on load
      // instead of failing startup for the entire bot.
      if (
        err instanceof Error &&
        /Unsupported session record shape/.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }

  const activeProviders: Record<string, "claude" | "codex"> = {};
  for (const [key, value] of Object.entries(parsed.activeProviders ?? {})) {
    if (value === "claude" || value === "codex") {
      activeProviders[key] = value;
    }
  }

  return {
    version: 3,
    lastCleanShutdown: Boolean(parsed.lastCleanShutdown),
    sessions,
    activeProjects: parsed.activeProjects ?? {},
    activeProviders,
  };
}

/**
 * Parse the persisted dedup ring. Anything malformed is dropped rather
 * than throwing: a corrupt dedup entry must never keep the bridge from
 * starting, since the ring is only a loop-prevention hint.
 */
function normalizeSeenMessages(value: unknown): SeenMessage[] {
  if (!Array.isArray(value)) return [];
  const out: SeenMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, ts } = entry as { id?: unknown; ts?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    out.push({ id, ts });
  }
  return out;
}

export class StateStore {
  /**
   * Recently-seen inbound Lark message ids, persisted alongside the
   * sessions in the same `state.json`.
   *
   * It is deliberately NOT part of `State`. `SessionManager.saveNow()`
   * builds a complete `State` from its own in-memory snapshots and has
   * no idea the dedup ring exists, so if the ring lived on `State`
   * every session save would silently wipe it. Keeping the store
   * itself as the single owner of the field, and merging it into every
   * write, makes the two writers independent.
   */
  private seenMessages: SeenMessage[] = [];
  /**
   * Last full `State` written (or loaded), so `saveSeenMessages()` can
   * reflush the file without needing a `State` from its caller.
   */
  private lastState: State = structuredClone(INITIAL_STATE);

  constructor(private readonly path: string) {}

  /** The dedup ring as read from disk by the most recent `load()`. */
  loadedSeenMessages(): readonly SeenMessage[] {
    return this.seenMessages;
  }

  /**
   * Replace the persisted dedup ring and flush it. Merged into the
   * last known full state so this never clobbers session data.
   */
  async saveSeenMessages(entries: readonly SeenMessage[]): Promise<void> {
    this.seenMessages = [...entries];
    await this.save(this.lastState);
  }

  async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.seenMessages = [];
        return this.remember(structuredClone(INITIAL_STATE));
      }
      throw new Error(
        `Failed to read state file ${this.path}: ${(err as Error).message}`,
      );
    }

    let parsed: State;
    try {
      parsed = JSON.parse(raw) as State;
    } catch (err) {
      throw new Error(
        `Malformed JSON in state file ${this.path}: ${(err as Error).message}`,
      );
    }
    // `seenMessages` is additive and version-independent: it is absent
    // from older files (→ empty ring) and ignored by older builds, so
    // it does not warrant a state-file version bump.
    this.seenMessages = normalizeSeenMessages(
      (parsed as unknown as { seenMessages?: unknown }).seenMessages,
    );

    // Migrate v1/v2 → v3: add activeProjects/activeProviders fields.
    if ((parsed as { version: number }).version === 1) {
      return this.remember(normalizeState({
        lastCleanShutdown: (parsed as unknown as { lastCleanShutdown: boolean }).lastCleanShutdown,
        sessions: (parsed as unknown as { sessions: Record<string, unknown> }).sessions,
        activeProjects: {},
        activeProviders: {},
      }));
    }
    if ((parsed as { version: number }).version === 2) {
      return this.remember(normalizeState({
        lastCleanShutdown: (parsed as unknown as { lastCleanShutdown: boolean }).lastCleanShutdown,
        sessions: (parsed as unknown as { sessions: Record<string, unknown> }).sessions,
        activeProjects: (parsed as unknown as { activeProjects?: Record<string, string> }).activeProjects ?? {},
        activeProviders: {},
      }));
    }
    if (parsed.version !== 3) {
      throw new Error(
        `Unsupported state file version ${(parsed as { version: number }).version} in ${this.path}`,
      );
    }
    return this.remember(normalizeState(parsed));
  }

  private remember(state: State): State {
    this.lastState = state;
    return state;
  }

  async save(state: State): Promise<void> {
    this.lastState = state;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // The dedup ring is merged in from the store rather than taken from
    // `state`, so a caller that builds a fresh `State` (SessionManager)
    // cannot drop it. Omitted entirely when empty to keep the file — and
    // every existing round-trip assertion on it — unchanged.
    const payload =
      this.seenMessages.length > 0
        ? { ...state, seenMessages: this.seenMessages }
        : state;
    // COREBYTE hardening: state.json carries chat/session ids — owner-only.
    await writeFile(tmp, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.path);
  }

  async markUncleanAtStartup(state: State): Promise<void> {
    state.lastCleanShutdown = false;
    await this.save(state);
  }

  async markCleanShutdown(state: State): Promise<void> {
    state.lastCleanShutdown = true;
    await this.save(state);
  }
}
