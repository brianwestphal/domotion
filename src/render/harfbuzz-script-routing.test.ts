// `harfbuzzShapedScriptOverride` — the post-step in `resolveFontForCodepoint`
// that routes a script's SHAPING to HarfBuzz (the engine Chrome runs) while
// leaving the OUTLINES with whichever engine resolved the face.
//
// The bug class this guards is specific and has already been shipped once: a
// reroute that moves the outlines along with the shaping. That version made the
// Thai fixture measurably WORSE (worst tile 0.0940 → 0.1214) even though on the
// face that fixture paints with, the two engines shape byte-for-byte
// identically — the entire cost was the outline engine changing hands, against
// which the macOS pixel calibration was measured. A pixel suite reports that as
// "still passes, slightly worse"; these assertions report it as a failure.
//
// So the invariants are asserted as a PAIR, and neither alone is sufficient:
//   1. the glyph IDS are HarfBuzz's (the reroute is actually in the loop), and
//   2. the glyph OUTLINES came from the base instance (the reroute did not also
//      swap the drawing engine).
//
// Plus the two properties that make a whole-run reroute safe where a
// single-codepoint override did not have to be: proxy identity is stable (the
// renderer groups runs by an identity comparison on the override, so a fresh
// object per codepoint silently hands the shaper one-character runs and turns
// contextual shaping off), and the FontInstance metadata the embedded-font path
// reads survives the proxy's fixed property set.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { clearFontResolutionCaches, getFontInstance, resolveFontForCodepoint, resolveFontKey } from "./font-resolution.js";
import { usesDedicatedShaper, usesHarfbuzzShaping } from "./unicode-classification.js";

const ARIAL_UNICODE = "/Library/Fonts/Arial Unicode.ttf";
const onDarwin = process.platform === "darwin";
const describeMac = onDarwin && existsSync(ARIAL_UNICODE) ? describe : describe.skip;

beforeEach(() => { clearFontResolutionCaches(); });

describe("usesHarfbuzzShaping — which scripts are rerouted", () => {
  it("covers Thai and stops at the block boundary", () => {
    expect(usesHarfbuzzShaping(0x0E01)).toBe(true);  // ก KO KAI
    expect(usesHarfbuzzShaping(0x0E37)).toBe(true);  // ◌ื SARA UEE — one of the PUA-shifted marks
    expect(usesHarfbuzzShaping(0x0E49)).toBe(true);  // ◌้ MAI THO — the other
    expect(usesHarfbuzzShaping(0x0E7F)).toBe(true);
    expect(usesHarfbuzzShaping(0x0DFF)).toBe(false);
    expect(usesHarfbuzzShaping(0x0E80)).toBe(false); // Lao — a separate script, not measured
  });

  it("covers Telugu and stops at the block boundary", () => {
    expect(usesHarfbuzzShaping(0x0C15)).toBe(true);  // క KA
    expect(usesHarfbuzzShaping(0x0C4D)).toBe(true);  // ◌్ VIRAMA — the conjunct former
    expect(usesHarfbuzzShaping(0x0C00)).toBe(true);
    expect(usesHarfbuzzShaping(0x0C7F)).toBe(true);
    expect(usesHarfbuzzShaping(0x0BFF)).toBe(false); // Tamil block below
    expect(usesHarfbuzzShaping(0x0C80)).toBe(false); // Kannada block above
  });

  it("covers all four Hangul blocks", () => {
    expect(usesHarfbuzzShaping(0xAC00)).toBe(true);  // 가 — syllables
    expect(usesHarfbuzzShaping(0xD55C)).toBe(true);  // 한
    expect(usesHarfbuzzShaping(0x1100)).toBe(true);  // ᄀ — Jamo
    expect(usesHarfbuzzShaping(0x3131)).toBe(true);  // ㄱ — Compatibility Jamo
    expect(usesHarfbuzzShaping(0xA960)).toBe(true);  // Jamo Extended-A
    expect(usesHarfbuzzShaping(0xD7FF)).toBe(true);  // Jamo Extended-B tail
    expect(usesHarfbuzzShaping(0xD800)).toBe(false); // surrogates — past the end
    expect(usesHarfbuzzShaping(0x10FF)).toBe(false);
  });

  it("covers the Devanagari block but not its extensions", () => {
    expect(usesHarfbuzzShaping(0x0915)).toBe(true);  // क KA
    expect(usesHarfbuzzShaping(0x093F)).toBe(true);  // ि — the pre-base matra
    expect(usesHarfbuzzShaping(0x094D)).toBe(true);  // ◌् VIRAMA
    expect(usesHarfbuzzShaping(0x0900)).toBe(true);
    expect(usesHarfbuzzShaping(0x097F)).toBe(true);
    expect(usesHarfbuzzShaping(0x0980)).toBe(false); // Bengali — cluster-only, excluded
    expect(usesHarfbuzzShaping(0xA8E0)).toBe(false); // Devanagari Extended — not measured
    expect(usesHarfbuzzShaping(0x1CD0)).toBe(false); // Vedic Extensions — a different route
  });

  it("does not reroute the scripts that have not been swept yet", () => {
    // Each of these is a live claim about a script whose reroute has its own
    // commit and its own CI sweep. Flipping one without updating this line
    // means the sweep did not happen.
    for (const cp of [
      0x05D0, // Hebrew alef
      0x0645, // Arabic meem
      0x1000, // Myanmar ka — cluster-only, deliberately excluded
      0x0995, // Bengali ka — cluster-only
      0x1780, // Khmer ka — cluster-only
      0x0B95, // Tamil ka — cluster-only
      0x0F40, // Tibetan ka — never measured as glyph-differing
    ]) {
      expect(usesHarfbuzzShaping(cp)).toBe(false);
    }
  });

  it("a rerouted script stays a DEDICATED-shaper script", () => {
    // `usesDedicatedShaper` is what tells the renderer a run needs RUN-based
    // shaping rather than per-character. Narrowing it as scripts move would
    // turn contextual shaping off for exactly the runs being rerouted — the
    // opposite of the intent.
    for (const cp of [0x0E01, 0x0E37, 0x0E49]) {
      expect(usesDedicatedShaper(cp)).toBe(true);
    }
  });
});

describeMac("harfbuzzShapedScriptOverride on Arial Unicode MS", () => {
  const key = () => resolveFontKey("Arial Unicode MS");

  function resolveThai(): { override: unknown; base: ReturnType<typeof getFontInstance> } {
    const k = key();
    if (k == null) throw new Error("Arial Unicode MS did not resolve to a key");
    const base = getFontInstance(k, 400, 16, 0);
    if (base == null) throw new Error("Arial Unicode MS did not open");
    const res = resolveFontForCodepoint(0x0E1B, base, k, 400, 16, 0, undefined, undefined, [k]);
    return { override: res.fontOverride, base };
  }

  // ปื้น — PO PLA (an ascender consonant) + SARA UEE + MAI THO + NO NU.
  const TEXT = "ปื้น";

  it("substitutes the Windows-PUA shift-left forms Chrome's HarfBuzz paints", () => {
    const { override, base } = resolveThai();
    expect(override).not.toBeNull();
    const hb = (override as NonNullable<ReturnType<typeof getFontInstance>>).layout(TEXT);
    const ct = base!.layout(TEXT);
    // The rule is `hb-ot-shaper-thai.cc` (rev 4de187d): an above-vowel and then
    // a tone mark over an ascender base both take the SL (shift-left) action,
    // and `SL_mappings` maps U+0E37 → U+F704 and U+0E49 → U+F714. On this face
    // those are gids 5447 / 5463; CoreText emits the plain cmap glyphs.
    expect(hb.glyphs.map((g) => g.id)).toEqual([2130, 5447, 5463, 2128]);
    expect(ct.glyphs.map((g) => g.id)).toEqual([2130, 2158, 2172, 2128]);
  });

  it("draws HarfBuzz's ids with the BASE engine's outlines", () => {
    // The half of the mechanism a pixel suite cannot see. Every shaped glyph
    // must arrive with a real outline — a proxy that fell back to HarfBuzz's
    // own `glyphToPath` would still produce paths here, so the discriminating
    // assertion is that the outline is the one the base engine draws for that
    // id, checked against `base.getGlyph(id)` directly.
    const { override, base } = resolveThai();
    const hb = (override as NonNullable<ReturnType<typeof getFontInstance>>).layout(TEXT);
    const getGlyph = (base as unknown as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph.bind(base);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });

  it("returns a STABLE object so run grouping does not split per character", () => {
    // `renderTextAsPath` ends a run on `useFontOverride !== curFontOverride`,
    // an identity comparison. A fresh proxy per codepoint would end the run at
    // every character and hand the shaper one-character runs — contextual
    // shaping silently off, output still well-formed.
    const a = resolveThai().override;
    const b = resolveThai().override;
    expect(a).toBe(b);
  });

  it("carries the FontInstance metadata the embedded path reads", () => {
    // The proxy exposes a fixed property set, so these would otherwise come
    // back undefined and silently disable synthetic bold / oblique for every
    // rerouted run — in the DEFAULT render mode, which has no pixel coverage.
    const { override, base } = resolveThai();
    const o = override as NonNullable<ReturnType<typeof getFontInstance>>;
    expect(o.postscriptName).toBe(base!.postscriptName);
    expect(o.naturalWeight).toBe(base!.naturalWeight);
    expect(o.faceIsBoldTrait).toBe(base!.faceIsBoldTrait);
    expect(o.resolvedItalicAngle).toBe(base!.resolvedItalicAngle);
    // Metrics still delegate to the base — the proxy replaces shaping only.
    expect(o.unitsPerEm).toBe(base!.unitsPerEm);
    expect(o.ascent).toBe(base!.ascent);
  });

  it("leaves a non-rerouted script's resolution untouched", () => {
    const k = key();
    const base = getFontInstance(k!, 400, 16, 0)!;
    // Latin 'A' and Hebrew ALEF both resolve without a shaping override.
    for (const cp of [0x0041, 0x05D0]) {
      const res = resolveFontForCodepoint(cp, base, k!, 400, 16, 0, undefined, undefined, [k!]);
      expect(res.fontOverride).toBeNull();
    }
  });
});
