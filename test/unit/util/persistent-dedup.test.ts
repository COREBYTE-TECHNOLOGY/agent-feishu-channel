import { describe, expect, it } from "vitest";
import {
  PersistentDedup,
  PERSISTENT_DEDUP_CAPACITY,
  PERSISTENT_DEDUP_TTL_MS,
  type SeenMessage,
} from "../../../src/util/dedup.js";

describe("PersistentDedup", () => {
  it("reports a new id as unseen and a repeat as seen", () => {
    const dedup = new PersistentDedup();
    expect(dedup.check("om_1")).toBe(false);
    expect(dedup.check("om_1")).toBe(true);
    expect(dedup.check("om_2")).toBe(false);
  });

  it("restores a ring and skips ids seen before the restart", () => {
    const now = 1_000_000;
    const dedup = new PersistentDedup({
      initial: [{ id: "om_old", ts: now - 1000 }],
      now: () => now,
    });
    expect(dedup.check("om_old")).toBe(true);
    expect(dedup.check("om_new")).toBe(false);
  });

  it("prunes entries older than the TTL", () => {
    let now = 1_000_000;
    const dedup = new PersistentDedup({ ttlMs: 1000, now: () => now });
    dedup.check("om_1");
    expect(dedup.size()).toBe(1);

    now += 999;
    expect(dedup.check("om_1")).toBe(true); // still inside the window

    now += 2;
    expect(dedup.check("om_1")).toBe(false); // aged out → treated as new
    expect(dedup.size()).toBe(1);
  });

  it("drops restored entries that are already expired", () => {
    const now = 10_000_000;
    const dedup = new PersistentDedup({
      initial: [
        { id: "om_stale", ts: now - PERSISTENT_DEDUP_TTL_MS - 1 },
        { id: "om_fresh", ts: now - 1000 },
      ],
      now: () => now,
    });
    expect(dedup.size()).toBe(1);
    expect(dedup.check("om_stale")).toBe(false);
    expect(dedup.check("om_fresh")).toBe(true);
  });

  it("does not refresh the timestamp on a repeat, so a poison id still ages out", () => {
    let now = 1_000_000;
    const dedup = new PersistentDedup({ ttlMs: 1000, now: () => now });
    dedup.check("om_poison");
    now += 600;
    expect(dedup.check("om_poison")).toBe(true);
    now += 600; // 1200ms after first sighting, despite the repeat at 600
    expect(dedup.check("om_poison")).toBe(false);
  });

  it("evicts the oldest ids beyond capacity", () => {
    const dedup = new PersistentDedup({ capacity: 3, now: () => 1000 });
    for (const id of ["a", "b", "c", "d"]) dedup.check(id);
    expect(dedup.size()).toBe(3);
    expect(dedup.check("a")).toBe(false); // evicted → looks new again
    expect(dedup.check("d")).toBe(true);
  });

  it("bounds a restored over-capacity ring", () => {
    const initial: SeenMessage[] = [];
    for (let i = 0; i < PERSISTENT_DEDUP_CAPACITY + 50; i += 1) {
      initial.push({ id: `om_${i}`, ts: 1000 + i });
    }
    const dedup = new PersistentDedup({ initial, now: () => 2000 });
    expect(dedup.size()).toBe(PERSISTENT_DEDUP_CAPACITY);
  });

  it("ignores malformed restored entries instead of throwing", () => {
    const dedup = new PersistentDedup({
      initial: [
        { id: "", ts: 1000 },
        { id: "om_ok", ts: 1000 },
        { id: "om_bad", ts: Number.NaN },
      ] as SeenMessage[],
      now: () => 1500,
    });
    expect(dedup.size()).toBe(1);
    expect(dedup.check("om_ok")).toBe(true);
  });

  it("flushes the ring on every newly seen id", () => {
    const flushes: SeenMessage[][] = [];
    const dedup = new PersistentDedup({
      now: () => 1000,
      persist: (entries) => flushes.push([...entries]),
    });
    dedup.check("om_1");
    dedup.check("om_1"); // repeat → nothing new to persist
    dedup.check("om_2");
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toEqual([
      { id: "om_1", ts: 1000 },
      { id: "om_2", ts: 1000 },
    ]);
  });

  it("never lets a persistence failure escape into the message path", () => {
    const dedup = new PersistentDedup({
      persist: () => {
        throw new Error("disk full");
      },
    });
    expect(() => dedup.check("om_1")).not.toThrow();
    expect(dedup.check("om_1")).toBe(true);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new PersistentDedup({ capacity: 0 })).toThrow(
      /capacity must be > 0/,
    );
  });
});
