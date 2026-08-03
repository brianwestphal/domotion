// `resolveSystemFallbackFonts` used to walk whatever the helper returned and
// write all of it to the process-lifetime cache, trusting the response to be
// both complete and in-domain and checking neither.
//
// Neither hazard is theoretical in effect. A SHORT response silently leaves its
// missing codepoints to the lazy path, which asks in a different order — and ask
// order is what has already produced a wrong answer here once, via an
// under-keyed helper cache where the face you got depended on which spec asked
// first. An OUT-OF-DOMAIN entry writes a cache row, under the asking base's key,
// for a codepoint nobody asked about.
//
// Driven through a fake helper (`DOMOTION_HELPER_PATH`) because the real one
// answers correctly — which is the point. These cover what happens when it does
// not, i.e. exactly the case no real run will ever demonstrate.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGlyphHelperCache, resolveSystemFallbackFonts, takeFallbackResponseAnomalies,
} from "./glyph-helper.js";

let dir: string;
let modeFile: string;

/**
 * ONE fake helper for the whole file, reading its behaviour from a file on
 * every request.
 *
 * Not a convenience. The caller keeps a PERSISTENT helper process, and it
 * outlives `clearGlyphHelperCache()` — which resets the resolved path, not the
 * running child. A second fake written to a second path is therefore never
 * spoken to: the first process keeps answering, and the test silently measures
 * the previous test's behaviour. That produced three off-by-one failures whose
 * numbers looked exactly like a bug in the code under test.
 *
 * It also speaks BOTH transports. A fake handling only one-shot stdin/EOF hangs
 * for the 30 s read deadline and then passes by accident on the retry.
 */
function installFakeHelper(): string {
  const p = join(dir, "fake-helper");
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    `const MODE_FILE = ${JSON.stringify(modeFile)};`,
    "function answer(req) {",
    "  const asked = (req.queries && req.queries[0] && req.queries[0].cps) || [];",
    '  const mode = JSON.parse(fs.readFileSync(MODE_FILE, "utf-8"));',
    '  const mk = (cp) => ({ cp, found: true, postscriptName: "Helvetica",',
    '                        familyName: "Helvetica", path: "/System/Library/Fonts/Helvetica.ttc" });',
    "  let fonts;",
    '  if (mode.kind === "short") fonts = asked.slice(0, mode.n).map(mk);',
    '  else if (mode.kind === "outOfDomain") fonts = asked.map(mk).concat([mk(0x9999)]);',
    "  else fonts = asked.map(mk);",
    '  return JSON.stringify({ results: [{ type: "fallback", fonts }] });',
    "}",
    'let buf = "";',
    'process.stdin.on("data", (c) => {',
    '  buf += c.toString("utf-8");',
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    "    const line = buf.slice(0, i);",
    "    buf = buf.slice(i + 1);",
    '    if (line.trim()) process.stdout.write(answer(JSON.parse(line)) + "\\n");',
    "  }",
    "});",
    'process.stdin.on("end", () => { if (buf.trim()) process.stdout.write(answer(JSON.parse(buf))); });',
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

/** What the (already running) fake does for the next request. */
type Mode = { kind: "short"; n: number } | { kind: "outOfDomain" } | { kind: "full" };
const mode = (m: Mode): void => writeFileSync(modeFile, JSON.stringify(m));

// The directory outlives every test for the same reason the fake does: the
// persistent helper process is still running and still reading the mode file.
// Tearing the directory down per test made it log ENOENT after each one.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "domotion-fbguard-"));
  modeFile = join(dir, "mode.json");
  mode({ kind: "full" });
  process.env.DOMOTION_HELPER_PATH = installFakeHelper();
  clearGlyphHelperCache();
});
afterAll(() => {
  delete process.env.DOMOTION_HELPER_PATH;
  clearGlyphHelperCache();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mode({ kind: "full" });
  clearGlyphHelperCache();
  takeFallbackResponseAnomalies();
});
afterEach(() => {
  takeFallbackResponseAnomalies();
});

// Distinct codepoints per test, because the fallback cache and the helper
// process both outlive an individual test.
describe("a short fallback response", () => {
  it("leaves the unanswered codepoints ASKABLE rather than cached as null", () => {
    // The recoverable state is the point. Caching a null would turn one short
    // response into a permanently wrong answer for those codepoints, and that
    // cache lives for the whole process.
    mode({ kind: "short", n: 2 });
    const out = resolveSystemFallbackFonts([0x41, 0x42, 0x43, 0x44], "Helvetica");
    expect(out.size).toBe(2);
    expect(out.has(0x43)).toBe(false);
    expect(out.has(0x44)).toBe(false);
  });

  it("records the shortfall instead of swallowing it", () => {
    // A silent partial response is the leading candidate for the conformance
    // oracle disagreeing with itself run to run, so it has to be observable: a
    // sweep reporting none has ELIMINATED the candidate rather than not looked.
    mode({ kind: "short", n: 1 });
    resolveSystemFallbackFonts([0x51, 0x52, 0x53], "Helvetica");
    const anomalies = takeFallbackResponseAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ asked: 3, answered: 1, missing: 2, outOfDomain: 0 });
  });
});

describe("an out-of-domain fallback response", () => {
  it("drops entries for codepoints that were never asked about", () => {
    mode({ kind: "outOfDomain" });
    const out = resolveSystemFallbackFonts([0x61], "Helvetica");
    expect(out.has(0x61)).toBe(true);
    expect(out.has(0x9999)).toBe(false);
    expect(takeFallbackResponseAnomalies()[0]).toMatchObject({ outOfDomain: 1, missing: 0 });
  });
});

describe("a well-formed response", () => {
  it("records no anomaly — the control", () => {
    // Without this, every assertion above is satisfied by an implementation
    // that simply flags everything.
    mode({ kind: "full" });
    const out = resolveSystemFallbackFonts([0x71, 0x72, 0x73], "Helvetica");
    expect(out.size).toBe(3);
    expect(takeFallbackResponseAnomalies()).toEqual([]);
  });
});
