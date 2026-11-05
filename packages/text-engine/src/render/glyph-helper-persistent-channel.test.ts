/**
 * Transition matrix for the persistent `--serve` helper channel's failure
 * branches (`callHelperPersistent` in glyph-helper-transport.ts):
 *
 *  - the first round trip fails → the channel is disabled, one-shot answers;
 *  - it worked, then the child crashed → the next call respawns;
 *  - it worked, then crashes on every request → respawns are BOUNDED
 *    (`MAX_CONSECUTIVE_PERSISTENT_CRASHES`), after which one-shot answers alone;
 *  - a success between crashes resets the bound;
 *  - an environment reset (`clearGlyphHelperTransport`) forgets all of it.
 *
 * The helper is a fake `.mjs` (the transport runs such paths through the
 * current Node executable). Each spawn appends its argv to a log; a per-spawn
 * plan says how many `--serve` requests that spawn answers before exiting.
 * Windows carries the channel over a named pipe this fake does not implement.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONSECUTIVE_PERSISTENT_CRASHES,
  __persistentFlagsForTest,
  callGlyphHelper,
  clearGlyphHelperTransport,
} from "./glyph-helper-transport.js";
import type { HelperRequest } from "./glyph-helper-protocol.js";

const FAKE_HELPER = `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.DM_FAKE_HELPER_LOG;
const args = process.argv.slice(2);
const index = readFileSync(log, "utf8").split("\\n").filter(Boolean).length;
appendFileSync(log, JSON.stringify(args) + "\\n");
const reply = JSON.stringify({ results: [] }) + "\\n";
if (args[0] === "--serve") {
  const plan = JSON.parse(process.env.DM_FAKE_HELPER_PLAN);
  let left = plan[Math.min(index, plan.length - 1)];
  createInterface({ input: process.stdin }).on("line", () => {
    if (left === 0) process.exit(1);
    left--;
    process.stdout.write(reply);
  });
} else {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(reply));
}
`;

const REQUEST = { queries: [] } as unknown as HelperRequest;
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("persistent helper channel failure branches", () => {
  const saved = {
    path: process.env.DOMOTION_HELPER_PATH,
    noServe: process.env.DOMOTION_HELPER_NO_SERVE,
    log: process.env.DM_FAKE_HELPER_LOG,
    plan: process.env.DM_FAKE_HELPER_PLAN,
  };
  let dir = "";
  let log = "";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dm-persistent-"));
    log = path.join(dir, "spawns.log");
    const helper = path.join(dir, "fake-helper.mjs");
    writeFileSync(helper, FAKE_HELPER);
    process.env.DOMOTION_HELPER_PATH = helper;
    process.env.DM_FAKE_HELPER_LOG = log;
    delete process.env.DOMOTION_HELPER_NO_SERVE;
  });

  afterAll(() => {
    clearGlyphHelperTransport();
    for (const [key, value] of [
      ["DOMOTION_HELPER_PATH", saved.path],
      ["DOMOTION_HELPER_NO_SERVE", saved.noServe],
      ["DM_FAKE_HELPER_LOG", saved.log],
      ["DM_FAKE_HELPER_PLAN", saved.plan],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearGlyphHelperTransport();
    writeFileSync(log, "");
  });

  /** Spawns since the last reset, split by transport. */
  function spawns(): { serve: number; oneShot: number } {
    const rows = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { serve: rows.filter((r) => r[0] === "--serve").length, oneShot: rows.filter((r) => r.length === 0).length };
  }

  function call(times: number): void {
    for (let i = 0; i < times; i++) expect(callGlyphHelper(REQUEST)).toEqual({ results: [] });
  }

  it("a healthy channel serves every request from one child", () => {
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([1000]);
    call(5);
    expect(spawns()).toEqual({ serve: 1, oneShot: 0 });
  });

  it("first round trip fails → channel disabled for the environment; one-shot answers", () => {
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([0]);
    call(4);
    expect(spawns()).toEqual({ serve: 1, oneShot: 4 });
    expect(__persistentFlagsForTest()).toEqual({ disabled: true, everWorked: false });
  });

  it("worked, then crashed once → the next call respawns and is served", () => {
    // Spawn 0 answers two requests then exits on the third; spawn 1 is healthy.
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([2, 1000]);
    call(6);
    // Request 3 hits the dead child → one-shot; request 4 respawns.
    expect(spawns()).toEqual({ serve: 2, oneShot: 1 });
    expect(__persistentFlagsForTest().disabled).toBe(false);
  });

  it("worked, then crashes on every request → respawns stop at the bound", () => {
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([1, 0]);
    call(1 + MAX_CONSECUTIVE_PERSISTENT_CRASHES + 5);
    expect(spawns()).toEqual({
      // The first child, then one respawn per crash up to the bound.
      serve: MAX_CONSECUTIVE_PERSISTENT_CRASHES,
      oneShot: MAX_CONSECUTIVE_PERSISTENT_CRASHES + 5,
    });
    expect(__persistentFlagsForTest()).toEqual({ disabled: true, everWorked: true });
  });

  it("a success between crashes resets the bound", () => {
    // Every child answers exactly one request, then dies on the next.
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([1]);
    const calls = 4 * MAX_CONSECUTIVE_PERSISTENT_CRASHES;
    call(calls);
    expect(__persistentFlagsForTest().disabled).toBe(false);
    // Alternates: served by a fresh child, then one-shot after its crash.
    expect(spawns()).toEqual({ serve: calls / 2, oneShot: calls / 2 });
  });

  it("an environment reset re-enables a channel the bound disabled", () => {
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([1, 0]);
    call(1 + MAX_CONSECUTIVE_PERSISTENT_CRASHES);
    expect(__persistentFlagsForTest().disabled).toBe(true);
    clearGlyphHelperTransport();
    writeFileSync(log, "");
    process.env.DM_FAKE_HELPER_PLAN = JSON.stringify([1000]);
    call(3);
    expect(spawns()).toEqual({ serve: 1, oneShot: 0 });
  });
});
