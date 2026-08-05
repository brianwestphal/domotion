#!/usr/bin/env node
/**
 * Record and replay the glyph helper's IPC — the DM-1980 prototype for making
 * the HOST an input rather than an ambient fact.
 *
 * ## Why this exists
 *
 * The font subsystem is already an island: 21 files whose only coupling outward
 * is one type-only import. What makes it slow to work on is not its size but
 * that its answers are a function of the machine — `font-resolution.ts` alone
 * reads `process.platform` 43 times and calls into the glyph helper 62 times.
 * So Linux and Windows resolution logic is untestable on a Mac, and the only
 * instruments that say anything about them cost 3-34 minutes of CI.
 *
 * The single largest source of that host-dependence is already behind ONE
 * process boundary speaking ONE line-delimited JSON protocol, and
 * `DOMOTION_HELPER_PATH` already accepts an arbitrary executable. So the whole
 * idea can be tested with **no production change at all**: put this script in
 * that variable and the renderer talks to a recording instead of a machine.
 *
 * ## Usage
 *
 *   # 1. Record, on a machine that has a real helper:
 *   DOMOTION_HELPER_PATH=$PWD/tools/font-env-cassette.mjs \
 *   FONT_CASSETTE=cassettes/darwin.json FONT_CASSETTE_MODE=record \
 *   FONT_CASSETTE_REAL=tools/macos-glyph-extractor/domotion-glyph-paths \
 *     npx vitest run src/render/darwin-declared-family-cut.test.ts
 *
 *   # 2. Replay it anywhere, including a platform that cannot answer at all:
 *   DOMOTION_HELPER_PATH=$PWD/tools/font-env-cassette.mjs \
 *   FONT_CASSETTE=cassettes/darwin.json FONT_CASSETTE_MODE=replay \
 *     npx vitest run src/render/darwin-declared-family-cut.test.ts
 *
 * ## Protocol notes
 *
 * `callHelper` tries a persistent `--serve` channel first and falls back to a
 * one-shot `spawnSync(bin, [], { input: JSON })` when that fails. This script
 * deliberately EXITS NON-ZERO on `--serve`/`--serve-pipe` so the caller takes
 * the one-shot path, which is the only one worth recording — one request in,
 * one response out, no session state.
 *
 * ## The honest limit, stated up front
 *
 * A cassette proves the LOGIC is right *given* those environment answers. It
 * does not prove the answers are right — it is a recording, i.e. a sample, and
 * this project's recurring lesson is that samples are blind rather than wrong
 * and still score well. This is a PRE-FILTER that catches logic regressions in
 * seconds. The conformance oracles remain the only thing that establishes
 * parity with Blink, and nothing here should reduce how often they run.
 *
 * A replay miss is therefore a hard failure (exit 3) rather than a fallthrough
 * to the real helper: silently answering from the machine would turn "this
 * cassette covers the case" into an unfalsifiable claim.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MODE = process.env.FONT_CASSETTE_MODE ?? "replay";
const PATH_ = process.env.FONT_CASSETTE;
const REAL = process.env.FONT_CASSETTE_REAL;

// The caller probes for a persistent channel first. Refuse it so we only ever
// see the one-shot form.
if (process.argv.slice(2).some((a) => a.startsWith("--serve"))) process.exit(1);

if (PATH_ == null || PATH_ === "") {
  process.stderr.write("font-env-cassette: FONT_CASSETTE (path) is required\n");
  process.exit(2);
}

const raw = readFileSync(0, "utf8");

/**
 * Canonical key for a request. The helper's answer depends only on the queries,
 * and `fonts` entries carry a `ref` that is assigned per call — so keying on
 * the raw JSON would make every replay miss. Normalizing the refs away is what
 * makes a cassette reusable across runs.
 */
function keyFor(text) {
  let req;
  try { req = JSON.parse(text); } catch { return text; }
  const fonts = (req.fonts ?? []).map((f) => ({
    fontPath: f.fontPath, size: f.size, index: f.index, variations: f.variations,
  }));
  return JSON.stringify({ fonts, queries: req.queries ?? [] });
}

const key = keyFor(raw);

function loadCassette() {
  if (!existsSync(PATH_)) return { format: "font-env-cassette/1", platform: process.platform, entries: {} };
  return JSON.parse(readFileSync(PATH_, "utf8"));
}

if (MODE === "record") {
  if (REAL == null || !existsSync(REAL)) {
    process.stderr.write(`font-env-cassette: FONT_CASSETTE_REAL must point at a real helper (got ${REAL})\n`);
    process.exit(2);
  }
  const proc = spawnSync(REAL, [], { input: raw, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) {
    process.stderr.write(proc.stderr ?? "");
    process.exit(proc.status ?? 1);
  }
  const cassette = loadCassette();
  cassette.entries[key] = proc.stdout;
  mkdirSync(dirname(PATH_), { recursive: true });
  writeFileSync(PATH_, JSON.stringify(cassette, null, 0));
  process.stdout.write(proc.stdout);
  process.exit(0);
}

// replay
const cassette = loadCassette();
const hit = cassette.entries[key];
if (hit == null) {
  // Loud, not silent. See the header: falling through to the real helper would
  // make "the cassette covers this" unfalsifiable.
  process.stderr.write(
    `font-env-cassette: REPLAY MISS (${Object.keys(cassette.entries).length} entries recorded on ${cassette.platform})\n`
    + `  request: ${key.slice(0, 400)}\n`,
  );
  process.exit(3);
}
process.stdout.write(hit);
