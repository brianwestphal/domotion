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
    expect(usesHarfbuzzShaping(0x0980)).toBe(true);  // Bengali — rerouted separately, see "covers Bengali"
    expect(usesHarfbuzzShaping(0xA8E0)).toBe(false); // Devanagari Extended — not measured
    expect(usesHarfbuzzShaping(0x1CD0)).toBe(false); // Vedic Extensions — a different route
  });

  it("covers Hebrew AND its presentation forms, which shape as one unit", () => {
    expect(usesHarfbuzzShaping(0x05D0)).toBe(true);  // ALEF
    expect(usesHarfbuzzShaping(0x05BC)).toBe(true);  // DAGESH — the composing point
    expect(usesHarfbuzzShaping(0x0590)).toBe(true);
    expect(usesHarfbuzzShaping(0x05FF)).toBe(true);
    // compose_hebrew maps 05D0-05EA + 05BC onto FB30-FB4A, so the two blocks
    // must route together or a mixed text is shaped as two separate runs.
    expect(usesHarfbuzzShaping(0xFB30)).toBe(true);
    expect(usesHarfbuzzShaping(0xFB4F)).toBe(true);
    expect(usesHarfbuzzShaping(0x058F)).toBe(false); // Armenian — a different script
  });

  it("covers every Arabic block, base and presentation forms alike", () => {
    expect(usesHarfbuzzShaping(0x0645)).toBe(true);  // MEEM
    expect(usesHarfbuzzShaping(0x0650)).toBe(true);  // KASRA
    expect(usesHarfbuzzShaping(0x0750)).toBe(true);  // Arabic Supplement
    expect(usesHarfbuzzShaping(0x0870)).toBe(true);  // Arabic Extended-B
    expect(usesHarfbuzzShaping(0x08A0)).toBe(true);  // Arabic Extended-A
    expect(usesHarfbuzzShaping(0xFB50)).toBe(true);  // Presentation Forms-A
    expect(usesHarfbuzzShaping(0xFEFC)).toBe(true);  // LAM-ALEF ligature, Forms-B
    // Joining spans all of these, so a subset would split a word mid-join.
    expect(usesHarfbuzzShaping(0x0700)).toBe(false); // Syriac — a different script
    expect(usesHarfbuzzShaping(0xFE00)).toBe(false); // Variation Selectors
  });

  it("does not reroute the scripts that have not been swept yet", () => {
    // Each of these is a live claim about a script whose reroute has its own
    // commit and its own CI sweep. Flipping one without updating this line
    // means the sweep did not happen.
    for (const cp of [
      0x0B95, // Tamil ka — cluster-only
      0x0F40, // Tibetan ka — never measured as glyph-differing
      0x0A05, // Gurmukhi — vowel-constraint script, not (yet) rerouted
    ]) {
      expect(usesHarfbuzzShaping(cp)).toBe(false);
    }
  });

  it("covers Myanmar and its three Extended blocks", () => {
    expect(usesHarfbuzzShaping(0x1000)).toBe(true);   // Myanmar KA
    expect(usesHarfbuzzShaping(0x109F)).toBe(true);   // Myanmar block end
    expect(usesHarfbuzzShaping(0x109E)).toBe(true);   // Myanmar SYMBOL SHAN ONE (just inside)
    expect(usesHarfbuzzShaping(0xAA60)).toBe(true);   // Myanmar Extended-A start
    expect(usesHarfbuzzShaping(0xAA7F)).toBe(true);   // Myanmar Extended-A end
    expect(usesHarfbuzzShaping(0xA9E0)).toBe(true);   // Myanmar Extended-B start
    expect(usesHarfbuzzShaping(0xA9FF)).toBe(true);   // Myanmar Extended-B end
    expect(usesHarfbuzzShaping(0x116D0)).toBe(true);  // Myanmar Extended-C start
    expect(usesHarfbuzzShaping(0x116FF)).toBe(true);  // Myanmar Extended-C end
    expect(usesHarfbuzzShaping(0x0FFF)).toBe(false);  // just below the base block
    expect(usesHarfbuzzShaping(0x10A0)).toBe(false);  // Georgian — a different script entirely
  });

  it("covers Bengali", () => {
    expect(usesHarfbuzzShaping(0x0985)).toBe(true);   // BENGALI LETTER A
    expect(usesHarfbuzzShaping(0x09BE)).toBe(true);   // BENGALI VOWEL SIGN AA
    expect(usesHarfbuzzShaping(0x0980)).toBe(true);   // block start
    expect(usesHarfbuzzShaping(0x09FF)).toBe(true);   // block end
    expect(usesHarfbuzzShaping(0x0A00)).toBe(false);  // Gurmukhi — not (yet) rerouted
  });

  it("covers Khmer and Khmer Symbols", () => {
    expect(usesHarfbuzzShaping(0x1780)).toBe(true);   // Khmer KA
    expect(usesHarfbuzzShaping(0x17D2)).toBe(true);   // Khmer COENG
    expect(usesHarfbuzzShaping(0x17FF)).toBe(true);   // base block end
    expect(usesHarfbuzzShaping(0x19E0)).toBe(true);   // Khmer Symbols start
    expect(usesHarfbuzzShaping(0x19FF)).toBe(true);   // Khmer Symbols end
    expect(usesHarfbuzzShaping(0x177F)).toBe(false);  // just below the base block
    expect(usesHarfbuzzShaping(0x1800)).toBe(false);  // Mongolian — a different script
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
    // Latin 'A' and Tibetan KA both resolve without a shaping override.
    for (const cp of [0x0041, 0x0F40]) {
      const res = resolveFontForCodepoint(cp, base, k!, 400, 16, 0, undefined, undefined, [k!]);
      expect(res.fontOverride).toBeNull();
    }
  });
});

// Myanmar, Khmer and Bengali all resolve to a font key that is NOT
// `extractor: "native"` on this platform (`u-myanmar-sangam-mn`,
// `u-khmer-sangam-mn`, `u-kohinoor-bangla` — see the block comment on
// `HARFBUZZ_SHAPED_RANGES`), so — unlike the Arial-Unicode-MS Thai proof above
// — the BASE instance here is fontkit's own, not the CoreText helper's. That
// makes `outlinesFromBase` exercise the OTHER half of its contract: drawing
// HarfBuzz's glyph ids through fontkit's `getGlyph`, not the helper's.
describeMac("harfbuzzShapedScriptOverride on fontkit-backed production faces", () => {
  function resolveOverride(fontKey: string, cp: number): { override: unknown; base: ReturnType<typeof getFontInstance> } {
    const base = getFontInstance(fontKey, 400, 16, 0);
    if (base == null) throw new Error(`${fontKey} did not open`);
    const res = resolveFontForCodepoint(cp, base, fontKey, 400, 16, 0, undefined, undefined, [fontKey]);
    return { override: res.fontOverride, base };
  }

  it("Bengali: inserts HarfBuzz's mid-sequence vowel-constraint dotted circle, with fontkit's outlines", () => {
    // U+0985 BENGALI LETTER A + U+09BE BENGALI VOWEL SIGN AA is a broken
    // cluster under Bengali orthography — no consonant can take that vowel
    // sign directly after a bare vowel letter — and HarfBuzz's vowel-
    // constraint preprocessing (`_hb_preprocess_text_vowel_constraints`,
    // `hb-ot-shaper-vowel-constraints.cc:58-446`, rev 4de187d) inserts U+25CC
    // BETWEEN the two before shaping. fontkit's `IndicShaper` has no
    // equivalent pass and shapes the pair straight through: 2 glyphs, no
    // circle. This is the concrete case the ticket named.
    const { override, base } = resolveOverride("u-kohinoor-bangla", 0x0985);
    expect(override).not.toBeNull();
    const o = override as NonNullable<ReturnType<typeof getFontInstance>>;
    const TEXT = "অা";
    const hb = o.layout(TEXT);
    const fk = base!.layout(TEXT);
    expect(fk.glyphs.length).toBe(2);   // fontkit: no dotted circle
    expect(hb.glyphs.length).toBe(3);   // HarfBuzz: base, ◌, vowel sign
    const circleId = base!.glyphForCodePoint(0x25CC).id;
    expect(circleId).not.toBe(0); // the face must actually carry U+25CC
    expect(hb.glyphs.map((g) => g.id)).toEqual([fk.glyphs[0].id, circleId, fk.glyphs[1].id]);
    // And the outline for every glyph — including the inserted circle, which
    // has no source codepoint of its own — comes from fontkit's `getGlyph`,
    // not from HarfBuzz's own `glyphToPath`.
    const getGlyph = (base as unknown as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph.bind(base);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });

  it("Myanmar and Khmer: reroute is active and stable, even though it is currently glyph-agreeing", () => {
    // Unlike Bengali above, these two are measured INERT for the samples this
    // project has checked (see the `HARFBUZZ_SHAPED_RANGES` comment) — so the
    // discriminating assertion is not "the glyphs differ" but "the mechanism
    // is genuinely wired up": an override exists, it is stable across calls
    // (the run-grouping identity invariant), and its outlines are fontkit's.
    for (const [fontKey, cp, text] of [
      ["u-myanmar-sangam-mn", 0x1000, "ကြော"],
      ["u-khmer-sangam-mn", 0x1780, "ខ្ញុំ"],
    ] as const) {
      const a = resolveOverride(fontKey, cp);
      const b = resolveOverride(fontKey, cp);
      expect(a.override).not.toBeNull();
      expect(a.override).toBe(b.override); // stable proxy identity
      const o = a.override as NonNullable<ReturnType<typeof getFontInstance>>;
      const hb = o.layout(text);
      const getGlyph = (a.base as unknown as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph.bind(a.base);
      expect(hb.glyphs.length).toBeGreaterThan(0);
      for (const g of hb.glyphs) {
        expect(g.path.commands.length).toBeGreaterThan(0);
        expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
      }
    }
  });
});
