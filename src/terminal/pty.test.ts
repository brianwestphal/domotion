import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { recordPtySession, buildCastText, ensureSpawnHelperExecutable, loadNodePty } from "./pty.js";
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
        onData(cb: (d: string) => void) {
          dataCb = cb;
        },
        onExit(cb: (e: { exitCode: number }) => void) {
          exitCb = cb;
        },
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
    const text = buildCastText(
      80,
      24,
      ["ls", "-la"],
      [
        [0, "o", "a"],
        [0.5, "o", "b\r\n"],
      ],
    );
    const lines = text.trimEnd().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 80, height: 24, command: "ls -la" });
    expect(JSON.parse(lines[1])).toEqual([0, "o", "a"]);
    expect(JSON.parse(lines[2])).toEqual([0.5, "o", "b\r\n"]);
    expect(parseCast(text).events).toHaveLength(2);
  });
});

describe("optional node-pty loader", () => {
  it("defers the optional package lookup and explains a missing install", async () => {
    const requested: string[] = [];
    await expect(
      loadNodePty(async (specifier) => {
        requested.push(specifier);
        throw new Error("Cannot find package");
      }),
    ).rejects.toThrow(/needs the optional `node-pty`.*Install it with:/s);
    expect(requested).toEqual(["node-pty"]);
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

// A pty whose lifetime the test controls, so teardown on every exit path can be observed.
function controllablePty() {
  const calls = { write: [] as string[], resize: [] as Array<[number, number]>, kill: 0 };
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const module = {
    spawn() {
      return {
        onData(cb: (d: string) => void) {
          dataCb = cb;
        },
        onExit(cb: (e: { exitCode: number }) => void) {
          exitCb = cb;
        },
        write(d: string) {
          calls.write.push(d);
        },
        resize(c: number, r: number) {
          calls.resize.push([c, r]);
        },
        kill() {
          calls.kill++;
        },
      };
    },
  };
  return { module, calls, emit: (d: string) => dataCb(d), exit: (exitCode = 0) => exitCb({ exitCode }) };
}

// A TTY-shaped stdin with the full surface recordPtySession touches.
function fakeStdin(options: { throwOnResume?: boolean; throwOnRestore?: boolean } = {}) {
  const emitter = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };
  emitter.isTTY = true;
  emitter.isRaw = false;
  emitter.setRawMode = vi.fn((mode: boolean) => {
    if (options.throwOnRestore && mode === false) throw new Error("tty closed");
    emitter.isRaw = mode;
  });
  emitter.resume = vi.fn(() => {
    if (options.throwOnResume) throw new Error("stdin unavailable");
  });
  emitter.pause = vi.fn();
  return emitter;
}

const resizeListeners = (): number => process.stdout.listenerCount("resize");
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("recordPtySession teardown (stdin, listeners, child)", () => {
  it("puts stdin in raw mode for the session and restores everything after a normal exit", async () => {
    const pty = controllablePty();
    const stdin = fakeStdin();
    const baseline = resizeListeners();

    const done = recordPtySession(
      ["sh"],
      { cols: 80, rows: 24, echo: null, input: stdin as never },
      pty.module as never,
    );
    await tick();
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.isRaw).toBe(true);
    expect(stdin.listenerCount("data")).toBe(1);
    expect(resizeListeners()).toBe(baseline + 1);

    pty.exit(0);
    await done;

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.pause).toHaveBeenCalled();
    expect(resizeListeners()).toBe(baseline);
    expect(pty.calls.kill).toBe(0); // a child that exited on its own is not killed
  });

  it("forwards stdin data to the child and terminal resizes to the pty, and stops after exit", async () => {
    const pty = controllablePty();
    const stdin = fakeStdin();
    const done = recordPtySession(
      ["sh"],
      { cols: 100, rows: 30, echo: null, input: stdin as never },
      pty.module as never,
    );
    await tick();

    stdin.emit("data", Buffer.from("ls\r"));
    process.stdout.emit("resize");
    expect(pty.calls.write).toEqual(["ls\r"]);
    expect(pty.calls.resize).toEqual([[process.stdout.columns || 100, process.stdout.rows || 30]]);

    pty.exit(0);
    await done;
    stdin.emit("data", Buffer.from("late"));
    process.stdout.emit("resize");
    expect(pty.calls.write).toEqual(["ls\r"]); // detached
    expect(pty.calls.resize).toHaveLength(1);
  });

  it("kills the child and restores the terminal when wiring stdin throws, reporting the original error", async () => {
    const pty = controllablePty();
    const stdin = fakeStdin({ throwOnResume: true, throwOnRestore: true });
    const baseline = resizeListeners();

    await expect(recordPtySession(["sh"], { echo: null, input: stdin as never }, pty.module as never)).rejects.toThrow(
      "stdin unavailable",
    ); // not "tty closed" from the restore attempt

    expect(pty.calls.kill).toBe(1);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false); // restore was attempted
    expect(stdin.listenerCount("data")).toBe(0);
    expect(resizeListeners()).toBe(baseline);
  });

  it("does not touch raw mode when the input is not a TTY", async () => {
    const pty = controllablePty();
    const stdin = fakeStdin();
    stdin.isTTY = false;
    const done = recordPtySession(["sh"], { echo: null, input: stdin as never }, pty.module as never);
    await tick();
    pty.exit(0);
    await done;
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("kills a child that outlives timeoutMs and rejects", async () => {
    const pty = controllablePty();
    const stdin = fakeStdin();
    const baseline = resizeListeners();

    await expect(
      recordPtySession(["sleep", "999"], { echo: null, input: stdin as never, timeoutMs: 20 }, pty.module as never),
    ).rejects.toThrow(/did not exit within 20 ms/);

    expect(pty.calls.kill).toBe(1);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(resizeListeners()).toBe(baseline);
  });

  it("does not fire the timeout after a timely exit", async () => {
    const pty = controllablePty();
    const done = recordPtySession(["sh"], { echo: null, input: null, timeoutMs: 30 }, pty.module as never);
    pty.exit(0);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pty.calls.kill).toBe(0);
  });

  it("kills the child when the abort signal fires, and rejects immediately for an already-aborted signal", async () => {
    const pty = controllablePty();
    const controller = new AbortController();
    const done = recordPtySession(["sh"], { echo: null, input: null, signal: controller.signal }, pty.module as never);
    await tick();
    controller.abort();
    await expect(done).rejects.toThrow(/aborted/);
    expect(pty.calls.kill).toBe(1);

    const second = controllablePty();
    const already = new AbortController();
    already.abort();
    await expect(
      recordPtySession(["sh"], { echo: null, input: null, signal: already.signal }, second.module as never),
    ).rejects.toThrow(/aborted/);
    expect(second.calls.kill).toBe(1);
  });

  it("leaves no listeners behind across repeated sessions, including failed ones", async () => {
    const stdin = fakeStdin();
    const baseline = resizeListeners();
    for (const outcome of ["exit", "timeout", "exit", "timeout"] as const) {
      const pty = controllablePty();
      const run = recordPtySession(
        ["sh"],
        { echo: null, input: stdin as never, ...(outcome === "timeout" ? { timeoutMs: 10 } : {}) },
        pty.module as never,
      );
      if (outcome === "exit") {
        await tick();
        pty.exit(0);
        await run;
      } else {
        await expect(run).rejects.toThrow();
      }
      expect(stdin.listenerCount("data")).toBe(0);
      expect(resizeListeners()).toBe(baseline);
      expect(stdin.isRaw).toBe(false);
    }
    expect(stdin.setRawMode.mock.calls.map(([mode]) => mode)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("propagates a spawn failure without touching stdin", async () => {
    const stdin = fakeStdin();
    const failing = {
      spawn() {
        throw new Error("posix_spawnp failed.");
      },
    };
    await expect(recordPtySession(["nope"], { echo: null, input: stdin as never }, failing as never)).rejects.toThrow(
      "posix_spawnp failed.",
    );
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("uses the injected clock for event times", async () => {
    const pty = controllablePty();
    const times = [1000, 1250, 2000, 2000];
    const now = vi.fn(() => times.shift() ?? 9999);
    const done = recordPtySession(["sh"], { cols: 10, rows: 5, echo: null, input: null, now }, pty.module as never);
    pty.emit("a");
    pty.exit(0);
    const { cast } = await done;
    expect(parseCast(cast).events).toEqual([{ time: 0.25, data: "a" }]);
  });
});
