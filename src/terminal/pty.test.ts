import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPtySession, buildCastText, ensureSpawnHelperExecutable } from "./pty.js";
import { parseCast } from "./cast.js";

// A fake node-pty that emits scripted chunks then exits — lets us exercise the
// capture shim deterministically without the native dependency or a real fork.
function fakePty(chunks: string[], exitCode = 0) {
  return {
    spawn() {
      let dataCb: (d: string) => void = () => {};
      let exitCb: (e: { exitCode: number }) => void = () => {};
      // Deliver chunks on the next ticks, then exit.
      queueMicrotask(async () => {
        for (const c of chunks) {
          dataCb(c);
          await Promise.resolve();
        }
        exitCb({ exitCode });
      });
      return {
        onData(cb: (d: string) => void) { dataCb = cb; },
        onExit(cb: (e: { exitCode: number }) => void) { exitCb = cb; },
        write() {},
        resize() {},
        kill() {},
      };
    },
  };
}

describe("recordPtySession (DM-1226 live capture shim)", () => {
  it("records pty output as a parseable asciinema v2 cast", async () => {
    const r = await recordPtySession(
      ["echo", "hi"],
      { cols: 72, rows: 16, echo: null, input: null },
      fakePty(["\x1b[32m$\x1b[0m echo hi\r\n", "hi\r\n"]) as never,
    );
    expect(r.exitCode).toBe(0);
    expect([r.cols, r.rows]).toEqual([72, 16]);

    const cast = parseCast(r.cast);
    expect(cast.header).toMatchObject({ version: 2, width: 72, height: 16 });
    expect(cast.events).toHaveLength(2);
    expect(cast.events[0].data).toContain("echo hi");
    expect(cast.events[1].data).toBe("hi\r\n");
    // monotonic non-negative timestamps
    expect(cast.events[0].time).toBeGreaterThanOrEqual(0);
    expect(cast.events[1].time).toBeGreaterThanOrEqual(cast.events[0].time);
  });

  it("propagates the child's non-zero exit code", async () => {
    const r = await recordPtySession(["false"], { echo: null, input: null }, fakePty([], 1) as never);
    expect(r.exitCode).toBe(1);
  });

  it("rejects an empty command", async () => {
    await expect(recordPtySession([], { echo: null, input: null }, fakePty([]) as never)).rejects.toThrow(/no command/);
  });

  it("buildCastText emits a valid v2 header line + one JSON array per event", () => {
    const text = buildCastText(80, 24, ["ls", "-la"], [[0, "o", "a"], [0.5, "o", "b\r\n"]]);
    const lines = text.trimEnd().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 80, height: 24, command: "ls -la" });
    expect(JSON.parse(lines[1])).toEqual([0, "o", "a"]);
    expect(JSON.parse(lines[2])).toEqual([0.5, "o", "b\r\n"]);
    expect(parseCast(text).events).toHaveLength(2);
  });
});

// DM-1227: node-pty ships a prebuilt `spawn-helper` whose +x bit can be stripped
// during install, breaking `pty.fork` with "posix_spawnp failed.". We restore it
// on the live path. These exercise that self-heal deterministically (no real pty).
describe("ensureSpawnHelperExecutable (DM-1227 prebuilt-helper self-heal)", () => {
  // Skip on Windows: there is no spawn-helper, and the function early-returns.
  const onUnix = process.platform !== "win32";

  function fakePkgWithHelper(mode: number): { dir: string; helper: string } {
    const dir = mkdtempSync(join(tmpdir(), "nodepty-"));
    const prebuilds = join(dir, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(prebuilds, { recursive: true });
    const helper = join(prebuilds, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, mode);
    return { dir, helper };
  }

  it.runIf(onUnix)("adds the execute bit when the prebuilt helper is missing it", () => {
    const { dir, helper } = fakePkgWithHelper(0o644);
    try {
      expect(statSync(helper).mode & 0o111).toBe(0);
      ensureSpawnHelperExecutable(() => dir);
      expect(statSync(helper).mode & 0o111).toBe(0o111); // owner+group+other x
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(onUnix)("leaves an already-executable helper untouched", () => {
    const { dir, helper } = fakePkgWithHelper(0o755);
    try {
      const before = statSync(helper).mode;
      ensureSpawnHelperExecutable(() => dir);
      expect(statSync(helper).mode).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when node-pty can't be located", () => {
    expect(() => ensureSpawnHelperExecutable(() => null)).not.toThrow();
  });

  it("never throws when the resolved dir has no helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodepty-empty-"));
    try {
      expect(() => ensureSpawnHelperExecutable(() => dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
