#!/usr/bin/env npx tsx
/**
 * DM-1972: assert the Linux glyph helper's declared-family matcher is not
 * merely BUILT but REACHED, before a fidelity suite is scored against it.
 *
 * A flag being on is not evidence a mechanism is in the loop, and neither is a
 * binary existing on disk. Windows shipped its live DirectWrite resolver
 * "default-on" for weeks while it answered nothing for every codepoint, because
 * the Node side declared a base font DirectWrite could not open — and it
 * reported a stable, plausible number the whole time. The check that would have
 * caught it immediately is this one: disable the mechanism and REQUIRE the
 * answer to move. An unchanged answer means something intercepted ahead of the
 * path you thought you were measuring.
 *
 * Two things make this non-obvious enough to be worth a dedicated check.
 *
 * 1. `isGlyphHelperAvailable()` is NOT the right predicate, and answering it
 *    "true" is the trap. With the in-tree binary moved aside it still returns
 *    true, because `resolveHelperPath` falls through to the on-demand download
 *    of the published release asset. Measured in the pinned noble container:
 *    binary absent, `isGlyphHelperAvailable()` true, `familyMatch` false — the
 *    acquired asset predates the query and answers "unknown query type", which
 *    `resolveLinuxFamilyMatch` swallows into null. So a helper can be present,
 *    reachable, and still not carry the mechanism.
 *
 * 2. The rung has to DISCRIMINATE. The degraded path — the two-slot `key` /
 *    `key-bold` table `linuxPrimaryCutKey` falls back to — crosses to the bold
 *    cut at 600, while fontconfig's weight scoring (which the helper's
 *    `familyMatch` query transcribes from
 *    `SkFontConfigInterfaceDirect::matchFamilyName`, Skia rev fd139e79,
 *    `src/ports/SkFontConfigInterface_direct.cpp:592-713`) already prefers Bold
 *    at 550. A probe at 400 or 700 agrees on both paths and would pass while
 *    measuring nothing.
 *
 * Exits non-zero when the matcher is absent or when disabling it does not move
 * the answer. Prints and exits 0 on non-Linux, so it is safe to call anywhere.
 */
import { getFontInstance, withSystemFallbackResolution } from "../src/render/font-resolution.js";
import { resolveLinuxFamilyMatch } from "../src/render/glyph-helper.js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (process.platform !== "linux") {
  console.log("skipped: not Linux (this asserts the Linux helper seam).");
  process.exit(0);
}

// Deliberately NOT isGlyphHelperAvailable() — see (1) above. A non-null
// familyMatch answer is the only evidence the transcribed matcher is reachable.
if (resolveLinuxFamilyMatch("Liberation Sans", { weight: 700 }) == null) {
  fail("the helper does not answer `familyMatch`, so the declared-family cut mechanism is inert. "
    + "Either no helper resolved, or the one that did predates the query (the published release "
    + "asset does) — in both cases a fidelity number scored here describes the two-slot fallback "
    + "table, not the shipped mechanism.");
}

const psName = (weight: number): string | undefined =>
  (getFontInstance("arial", weight, 22, 0) as { postscriptName?: string } | null)?.postscriptName;

const on = psName(550);
const off = withSystemFallbackResolution(false, () => psName(550));

console.log(`arial@550  resolver ON  -> ${on ?? "(none)"}`);
console.log(`arial@550  resolver OFF -> ${off ?? "(none)"}`);

if (on == null || on === off) {
  fail("disabling the resolver did NOT move the answer at the discriminating rung — the matcher is "
    + "not in the loop, so a green fidelity number here would be about a path nobody meant to measure.");
}

console.log(`MOVED (${off ?? "(none)"} -> ${on}) — the declared-family matcher is in the loop.`);
