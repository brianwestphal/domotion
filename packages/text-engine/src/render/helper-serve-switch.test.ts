/**
 * `DOMOTION_HELPER_NO_SERVE=1` must change the TRANSPORT and nothing else.
 *
 * The persistent helper channel is otherwise unfalsifiable from outside: when it
 * degrades, every query still returns the right answer and only the wall clock
 * moves — and a wall clock has no baseline unless the mechanism can be turned
 * off. That is why the switch exists, and it is only useful if flipping it is
 * answer-neutral, which is what this pins.
 *
 * `DOMOTION_DISABLE_HELPER` is NOT a substitute and the distinction matters:
 * that one disables the helper outright, so the resolver falls back to the
 * static chain and the answers change. Comparing throughput across it would
 * grade two different resolvers.
 *
 * Measured on macOS, one conformance slice of 7,312 codepoints, the switch as
 * the only difference:
 *
 *     channel on    ours  4.5 s   0.615 ms/codepoint   1,032 comparisons/s
 *     channel off   ours 179.0 s  24.480 ms/codepoint      40 comparisons/s
 *
 * …with byte-identical reports. The 24 ms is one process spawn per codepoint,
 * and it is why a Windows sweep on a Parallels VM measured 47/s where the same
 * code on a GitHub Windows runner measures 636-695/s.
 *
 * That cost is the MOTIVATION, not the assertion. The transport is proven by
 * counting the helper processes each arm actually starts (one reused `--serve`
 * child vs one argument-less spawn per request), which a loaded host cannot
 * perturb the way it perturbed the former wall-clock ratio.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontForCodepoint,
} from "./font-resolution.js";
import { clearGlyphHelperCache, isGlyphHelperAvailable, resolvedGlyphHelperPathForEvidence } from "./glyph-helper.js";

/** Codepoints no ordinary text primary covers, so each one reaches the helper.
 *  Spread across scripts so a single cached answer cannot stand for all. */
const UNCOVERED = [0x0905, 0x0e01, 0x4e2d, 0x0627, 0x05d0, 0x10a0, 0x1200, 0x0e3f];
const STACK = "sans-serif";

const describeLive = isGlyphHelperAvailable() ? describe : describe.skip;

/** The faces the resolver picks for `UNCOVERED`, under whatever transport is
 *  currently configured. Caches are cleared first so nothing is answered from a
 *  previous transport's memo. */
function facesUnderCurrentTransport(): Array<string | null> {
  clearGlyphHelperCache();
  clearFontResolutionCaches();
  const key = resolveFontKey(STACK);
  const chain = resolveFontKeyChain(STACK);
  const primary = resolveFont(STACK, 400, 16, 0);
  if (primary == null) return [];
  return UNCOVERED.map((cp) => resolveFontForCodepoint(cp, primary, key, 400, 16, 0, undefined, "en", chain).key);
}

/**
 * A spawn-recording stand-in for the real helper. It appends its argv to a log
 * and then runs the real binary with inherited stdio, so the persistent
 * channel's pipes (or, on Windows, its named-pipe argument) pass straight
 * through. The transport routes a `.mjs` helper path through the running Node
 * executable, which is what lets this work on all three platforms.
 */
function writeSpawnRecorder(dir: string, realHelper: string, log: string): string {
  const wrapper = path.join(dir, "record-helper-spawns.mjs");
  const source = [
    'import { appendFileSync } from "node:fs";',
    'import { spawn } from "node:child_process";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
    `const child = spawn(${JSON.stringify(realHelper)}, args, { stdio: "inherit" });`,
    'for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));',
    'child.on("exit", (code) => process.exit(code ?? 1));',
    "",
  ].join("\n");
  writeFileSync(wrapper, source);
  return wrapper;
}

describeLive("the helper transport switch changes only the transport", () => {
  const saved = process.env.DOMOTION_HELPER_NO_SERVE;
  const savedPath = process.env.DOMOTION_HELPER_PATH;
  let scratch = "";
  let spawnLog = "";
  let recorder = "";
  let baselineFaces: Array<string | null> = [];

  /** Resolve `UNCOVERED` through the spawn recorder and report which helper
   *  processes the transport started to do it. Clearing the caches afterwards
   *  kills a serving child, so nothing carries into the next arm. */
  function spawnsUnderCurrentTransport(): {
    faces: Array<string | null>;
    spawns: string[][];
    serving: number;
    oneShot: number;
  } {
    writeFileSync(spawnLog, "");
    process.env.DOMOTION_HELPER_PATH = recorder;
    const faces = facesUnderCurrentTransport();
    clearGlyphHelperCache();
    clearFontResolutionCaches();
    const spawns = readFileSync(spawnLog, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
    return {
      faces,
      spawns,
      // `--serve` on macOS/Linux, `--serve-pipe <name>` on Windows.
      serving: spawns.filter((args) => args[0]?.startsWith("--serve") === true).length,
      oneShot: spawns.filter((args) => args.length === 0).length,
    };
  }

  beforeAll(() => {
    delete process.env.DOMOTION_HELPER_NO_SERVE;
    const real = resolvedGlyphHelperPathForEvidence();
    if (real == null) throw new Error("the live helper must resolve to a path");
    scratch = mkdtempSync(path.join(tmpdir(), "domotion-serve-switch-"));
    spawnLog = path.join(scratch, "spawns.log");
    recorder = writeSpawnRecorder(scratch, real, spawnLog);
    baselineFaces = facesUnderCurrentTransport();
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  beforeEach(() => {
    delete process.env.DOMOTION_HELPER_NO_SERVE;
  });
  afterEach(() => {
    if (saved == null) delete process.env.DOMOTION_HELPER_NO_SERVE;
    else process.env.DOMOTION_HELPER_NO_SERVE = saved;
    if (savedPath == null) delete process.env.DOMOTION_HELPER_PATH;
    else process.env.DOMOTION_HELPER_PATH = savedPath;
    clearGlyphHelperCache();
    clearFontResolutionCaches();
  });

  it("resolves the same faces with the channel on and off", () => {
    const withChannel = facesUnderCurrentTransport();
    // PRECONDITION: if nothing resolved, "identical" would be two empty lists.
    expect(withChannel.length, "the probe must have resolved something").toBe(UNCOVERED.length);
    expect(
      withChannel.some((k) => k != null),
      "at least one must reach the helper",
    ).toBe(true);

    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    expect(facesUnderCurrentTransport()).toEqual(withChannel);
  });

  it("actually changes the transport — one serving child vs one process per request", () => {
    // Answer-neutrality alone would pass against a switch that does NOTHING,
    // which is the failure mode this whole area keeps producing. Both transports
    // return the same faces, so the observable that separates "the switch works"
    // from "the switch is inert" is the PROCESS LEDGER: the channel starts one
    // `--serve` child and reuses it, the one-shot path spawns a fresh argument-
    // less helper per request.
    //
    // This used to be a wall-clock ratio (no-serve > 3x the channel). The real
    // effect is ~40x over a large slice, but on a 150-codepoint loop under host
    // load it measured 2.9x twice and flaked. Counting spawns is contention-
    // insensitive and a stronger proof: it observes the actual OS processes,
    // through a wrapper installed as `DOMOTION_HELPER_PATH`, not the module's
    // own bookkeeping.
    const withChannel = spawnsUnderCurrentTransport();
    expect(withChannel.faces, "the wrapper must not change the answers").toEqual(baselineFaces);
    expect(withChannel.serving, `channel spawns: ${JSON.stringify(withChannel.spawns)}`).toBe(1);
    expect(withChannel.oneShot, `channel spawns: ${JSON.stringify(withChannel.spawns)}`).toBe(0);

    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    const withoutChannel = spawnsUnderCurrentTransport();
    expect(withoutChannel.faces, "the wrapper must not change the answers").toEqual(baselineFaces);
    expect(withoutChannel.serving, `no-serve spawns: ${JSON.stringify(withoutChannel.spawns)}`).toBe(0);
    // More than one: a single one-shot spawn would be indistinguishable from a
    // channel that happened to serve one request. Distinct codepoints across
    // scripts, caches cleared, so every arm makes several requests.
    expect(withoutChannel.oneShot, `no-serve spawns: ${JSON.stringify(withoutChannel.spawns)}`).toBeGreaterThan(1);
  });

  it("is read per call, not captured at module load", () => {
    // A `const` snapshot would make the switch silently inert for anything
    // already imported — the exact "the flag was on but the mechanism was not in
    // the loop" shape this area keeps producing. Setting it AFTER the module has
    // resolved faces once, and still getting a working resolver, is the check.
    const before = facesUnderCurrentTransport();
    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    const after = facesUnderCurrentTransport();
    delete process.env.DOMOTION_HELPER_NO_SERVE;
    const again = facesUnderCurrentTransport();
    expect(after).toEqual(before);
    expect(again).toEqual(before);
  });
});
