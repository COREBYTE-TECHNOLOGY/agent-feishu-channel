import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, type State } from "../../../src/persistence/state-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const EMPTY_STATE: State = {
  version: 3,
  lastCleanShutdown: true,
  sessions: {},
  activeProjects: {},
  activeProviders: {},
};

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(rm).mockReset().mockImplementation(actualFs.rm);
  vi.mocked(writeFile).mockReset().mockImplementation(actualFs.writeFile);
  tmpDir = mkdtempSync(join(tmpdir(), "afc-state-failure-test-"));
  statePath = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function failNextWrite(stage: "write" | "rename", error: Error): void {
  if (stage === "rename") {
    vi.mocked(rename).mockRejectedValueOnce(error);
    return;
  }
  // A failed write may already have created/truncated the temp file.
  vi.mocked(writeFile).mockImplementationOnce(async (path) => {
    await actualFs.writeFile(path, "partial state", "utf8");
    throw error;
  });
}

describe("StateStore failed-write cleanup (corebyte #22)", () => {
  it.each(["write", "rename"] as const)(
    "removes only its own temp file after a %s failure and preserves committed state",
    async (stage) => {
      const store = new StateStore(statePath);
      await store.save(EMPTY_STATE);
      const before = readFileSync(statePath, "utf8");
      const unrelatedTmp = join(tmpDir, "another-writer.tmp");
      await actualFs.writeFile(unrelatedTmp, "leave alone", "utf8");
      const originalError = new Error(`injected ${stage} failure`);
      failNextWrite(stage, originalError);

      await expect(store.save({ ...EMPTY_STATE, lastCleanShutdown: false }))
        .rejects.toBe(originalError);

      expect(rm).toHaveBeenCalledExactlyOnceWith(
        `${statePath}.${process.pid}.2.tmp`,
        { force: true },
      );
      expect(readFileSync(statePath, "utf8")).toBe(before);
      expect(readFileSync(unrelatedTmp, "utf8")).toBe("leave alone");
      expect(readdirSync(tmpDir).filter((name) => name.startsWith("state.json.") && name.endsWith(".tmp")))
        .toEqual([]);
      await expect(store.save({ ...EMPTY_STATE, lastCleanShutdown: false }))
        .resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, "utf8")).lastCleanShutdown).toBe(false);
    },
  );

  it.each(["write", "rename"] as const)(
    "preserves the original %s error when cleanup also fails, without poisoning queued writes",
    async (stage) => {
      const store = new StateStore(statePath);
      const originalError = new Error(`injected ${stage} failure`);
      failNextWrite(stage, originalError);
      vi.mocked(rm).mockRejectedValueOnce(new Error("injected cleanup failure"));

      const failed = store.save(EMPTY_STATE);
      const queued = store.save({ ...EMPTY_STATE, lastCleanShutdown: false });
      const outcomes = await Promise.allSettled([failed, queued]);

      expect(outcomes).toEqual([
        { status: "rejected", reason: originalError },
        { status: "fulfilled", value: undefined },
      ]);
      expect(outcomes[0]?.status === "rejected" ? outcomes[0].reason : undefined)
        .toBe(originalError);
      expect(rm).toHaveBeenCalledExactlyOnceWith(
        `${statePath}.${process.pid}.1.tmp`,
        { force: true },
      );
      expect(vi.mocked(writeFile).mock.calls.map(([path]) => path)).toEqual([
        `${statePath}.${process.pid}.1.tmp`,
        `${statePath}.${process.pid}.2.tmp`,
      ]);
      expect(JSON.parse(readFileSync(statePath, "utf8")).lastCleanShutdown).toBe(false);
      // Failed best-effort cleanup cannot prevent the next unique file
      // from being persisted. The fixture teardown removes this residue.
      expect(readdirSync(tmpDir).filter((name) => name.endsWith(".tmp")))
        .toEqual([`state.json.${process.pid}.1.tmp`]);
    },
  );
});
