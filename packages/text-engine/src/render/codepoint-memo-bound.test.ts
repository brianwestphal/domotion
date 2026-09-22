/**
 * The per-codepoint fallback memos must be droppable by the batch reset the
 * exhaustive sweeps use.
 *
 * `glyph-helper.ts` memoizes the platform's answer for a codepoint keyed on
 * `(base face, codepoint, weight, style, size, locale, …)`. That key is
 * unbounded in the codepoint universe, and the map had no caller outside the
 * unit tests — so a process that walked the whole universe kept every answer for
 * its lifetime. A render is unaffected (one page, a few hundred codepoints); an
 * exhaustive sweep is not.
 *
 * Measured, on the full-corpus macOS font-conformance run: 22 stacks × 292,466
 * codepoints in one process, and **four of twenty shards died with
 * `JavaScript heap out of memory`** roughly two hours in, taking the run's
 * verdict with them. The canonical six-stack slice had never shown it, because
 * it puts ONE stack in each shard — 292k memo entries rather than 6.4M. The
 * oracle was already trimming the memos `font-resolution.ts` owns on every
 * batch; the ones holding the bytes sat one module lower and were missed.
 *
 * The invariant this pins: after `clearFontResolutionCaches()`, the helper's
 * per-codepoint memos are empty. The precondition assertion matters as much as
 * the claim — a run that populated nothing would satisfy "empty afterwards"
 * trivially, and would keep passing against the exact defect being guarded.
 */
import { describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontForCodepoint,
} from "./font-resolution.js";
import { glyphHelperCodepointMemoSize, isGlyphHelperAvailable } from "./glyph-helper.js";

/**
 * Codepoints no ordinary text primary covers, so each one has to ask the
 * platform. Spread across scripts on purpose: a single block could be answered
 * by one cached face on some host and populate a single entry.
 */
const UNCOVERED = [
  0x0905, // DEVANAGARI LETTER A
  0x0e01, // THAI CHARACTER KO KAI
  0x4e2d, // CJK UNIFIED IDEOGRAPH-4E2D
  0x0627, // ARABIC LETTER ALEF
  0x05d0, // HEBREW LETTER ALEF
  0x10a0, // GEORGIAN CAPITAL LETTER AN
  0x1200, // ETHIOPIC SYLLABLE HA
  0x0e3f, // THAI CURRENCY SYMBOL BAHT
];

const STACK = "sans-serif";

/** The live resolver is what populates these memos; without it the whole
 *  question is moot on this host, so skip rather than assert vacuously. */
const describeLive = isGlyphHelperAvailable() ? describe : describe.skip;

describeLive("the per-codepoint fallback memos are dropped by the batch reset", () => {
  it("populates on resolution and empties on clearFontResolutionCaches()", () => {
    clearFontResolutionCaches();
    expect(glyphHelperCodepointMemoSize(), "starts empty").toBe(0);

    const key = resolveFontKey(STACK);
    const chain = resolveFontKeyChain(STACK);
    const primary = resolveFont(STACK, 400, 16, 0);
    expect(primary, `the ${STACK} primary must resolve on this host`).not.toBeNull();

    for (const cp of UNCOVERED) {
      resolveFontForCodepoint(cp, primary!, key, 400, 16, 0, undefined, "en", chain);
    }

    // PRECONDITION, not decoration: if the resolver answered every one of these
    // without ever asking the platform, the assertion below proves nothing.
    const populated = glyphHelperCodepointMemoSize();
    expect(populated, "the resolver must have asked the platform at least once").toBeGreaterThan(0);

    clearFontResolutionCaches();
    expect(glyphHelperCodepointMemoSize(), "the batch reset must reach these memos").toBe(0);
  });

  it("grows with the codepoint axis — which is why it has to be droppable", () => {
    // Not a restatement of the test above: it pins the SHAPE of the growth. A
    // memo keyed by family rather than by codepoint would stay flat here, and
    // the unbounded-in-the-universe claim would be wrong.
    clearFontResolutionCaches();
    const key = resolveFontKey(STACK);
    const chain = resolveFontKeyChain(STACK);
    const primary = resolveFont(STACK, 400, 16, 0);
    if (primary == null) return;

    const sizes: number[] = [];
    for (const cp of UNCOVERED) {
      resolveFontForCodepoint(cp, primary, key, 400, 16, 0, undefined, "en", chain);
      sizes.push(glyphHelperCodepointMemoSize());
    }
    expect(sizes[sizes.length - 1]).toBeGreaterThan(sizes[0]);
    clearFontResolutionCaches();
  });
});
