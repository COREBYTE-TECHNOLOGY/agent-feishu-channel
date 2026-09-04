/**
 * LRU-based dedup set. `check(id)` returns true if the id was already
 * present (and promotes it to MRU), false if the id is new (and inserts it).
 */
export class LruDedup {
  private readonly capacity: number;
  private readonly map = new Map<string, true>();

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("LruDedup capacity must be > 0");
    this.capacity = capacity;
  }

  check(id: string): boolean {
    if (this.map.has(id)) {
      // Promote to MRU by re-inserting.
      this.map.delete(id);
      this.map.set(id, true);
      return true;
    }
    this.map.set(id, true);
    if (this.map.size > this.capacity) {
      // Evict the least recently used (first key in insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }

  size(): number {
    return this.map.size;
  }
}

/** One recently-seen inbound message id, with the time we first saw it. */
export interface SeenMessage {
  id: string;
  /** Epoch milliseconds when the id was first observed. */
  ts: number;
}

/**
 * The slice of `LruDedup` the gateway actually depends on. Declared so
 * `PersistentDedup` can be substituted without the gateway caring which
 * implementation it got.
 */
export interface DedupChecker {
  check(id: string): boolean;
}

export const PERSISTENT_DEDUP_CAPACITY = 200;
export const PERSISTENT_DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PersistentDedupOptions {
  /** Ring restored from `state.json` at startup. Unknown/expired entries are dropped. */
  initial?: readonly SeenMessage[];
  /** Max ids retained. Oldest are evicted first. */
  capacity?: number;
  /** Entries older than this are pruned on every `check()`. */
  ttlMs?: number;
  /** Injectable clock so tests never depend on wall time. */
  now?: () => number;
  /**
   * Called after every mutation with the ring to persist. MUST NOT
   * throw and MUST NOT return a floating rejected promise — the whole
   * point of this class is that dedup bookkeeping can never take the
   * process down.
   */
  persist?: (entries: readonly SeenMessage[]) => void;
}

/**
 * Restart-surviving dedup for inbound Lark `message_id`s.
 *
 * WHY THIS EXISTS (loop-prevention, NOT exactly-once): the bridge runs
 * under launchd with `KeepAlive=true`. If a message makes the process
 * die, launchd restarts it, Lark redelivers the same `im.message.receive_v1`
 * event, and a purely in-memory dedup cache — which is what `LruDedup`
 * is — has forgotten the id, so the same message is processed again and
 * kills the process again. That is a crash loop, and it is exactly what
 * was observed in production (three restarts in ~21 seconds).
 *
 * Persisting the last N ids breaks that loop. It deliberately does NOT
 * promise exactly-once delivery: the ring is bounded (`capacity`) and
 * time-limited (`ttlMs`), the write is best-effort and asynchronous, and
 * a hard kill between "id observed" and "id flushed" still loses the
 * entry. Under-dedup (a message handled twice) is an accepted outcome;
 * the guarantee we need is only that a *repeatedly redelivered* event
 * stops being reprocessed forever.
 */
export class PersistentDedup implements DedupChecker {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly persist: (entries: readonly SeenMessage[]) => void;
  /** Insertion-ordered: oldest first, which is also eviction order. */
  private readonly entries = new Map<string, number>();

  constructor(opts: PersistentDedupOptions = {}) {
    this.capacity = opts.capacity ?? PERSISTENT_DEDUP_CAPACITY;
    this.ttlMs = opts.ttlMs ?? PERSISTENT_DEDUP_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.persist = opts.persist ?? (() => {});
    if (this.capacity <= 0) {
      throw new Error("PersistentDedup capacity must be > 0");
    }

    for (const entry of opts.initial ?? []) {
      if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
      if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)) continue;
      this.entries.set(entry.id, entry.ts);
    }
    this.prune();
    this.evictOverflow();
  }

  /**
   * True when `id` has been seen recently (so the caller should skip
   * it). A new id is recorded and the ring is flushed.
   *
   * Unlike `LruDedup`, a repeat does NOT refresh the timestamp: an
   * event that is redelivered forever must still age out after
   * `ttlMs`, otherwise a poison message could be suppressed for good.
   */
  check(id: string): boolean {
    this.prune();
    if (this.entries.has(id)) return true;
    this.entries.set(id, this.now());
    this.evictOverflow();
    this.flush();
    return false;
  }

  /** Current ring, oldest first. Used for persistence and in tests. */
  snapshot(): SeenMessage[] {
    return [...this.entries].map(([id, ts]) => ({ id, ts }));
  }

  size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, ts] of this.entries) {
      // Insertion order is *roughly* chronological, but a restored ring
      // can be out of order, so scan the whole map rather than breaking
      // on the first live entry.
      if (ts <= cutoff) this.entries.delete(id);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  private flush(): void {
    try {
      this.persist(this.snapshot());
    } catch {
      // Persistence is best-effort by construction — see the class
      // doc. Never let it escape into the caller's message path.
    }
  }
}
