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
    expect(usesHarfbuzzShaping(0x0C80)).toBe(true);  // Kannada — rerouted separately below
  });

  it("covers the four Linux vowel-constraint reroutes and excludes Tamil", () => {
    for (const cp of [
      0x0A05, 0x0A3E, // Gurmukhi invalid base + dependent vowel
      0x0A85, 0x0ABE, // Gujarati
      0x0B05, 0x0B3E, // Oriya
      0x0C89, 0x0CBE, // Kannada
    ]) expect(usesHarfbuzzShaping(cp)).toBe(true);

    expect(usesHarfbuzzShaping(0x09FF)).toBe(true);  // Bengali's existing route
    expect(usesHarfbuzzShaping(0x0B80)).toBe(false); // Tamil needs the vendored-HB fix (DM-2057)
    expect(usesHarfbuzzShaping(0x0D00)).toBe(false); // Malayalam, same limitation
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
    expect(usesHarfbuzzShaping(0x0A00)).toBe(true);   // Gurmukhi — rerouted separately
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

  it("covers Adlam and Hanifi Rohingya — the two DM-2054 additions that ALSO reroute", () => {
    expect(usesHarfbuzzShaping(0x1E900)).toBe(true);  // Adlam block start
    expect(usesHarfbuzzShaping(0x1E95F)).toBe(true);  // Adlam block end
    expect(usesHarfbuzzShaping(0x1E960)).toBe(false); // just past the block
    expect(usesHarfbuzzShaping(0x10D00)).toBe(true);  // Hanifi Rohingya block start
    expect(usesHarfbuzzShaping(0x10D3F)).toBe(true);  // Hanifi Rohingya block end
    expect(usesHarfbuzzShaping(0x10D40)).toBe(false); // Garay — a different script (RTL_SMP_SCRIPT_RANGES neighbor)
  });

  it("does NOT reroute the other DM-2033/DM-2054 dedicated-shaper additions — measured inert", () => {
    // Sinhala, N'Ko, Mandaic, Phags-pa, Manichaean, Psalter Pahlavi and
    // Kharoshthi all AGREED fontkit-vs-harfbuzzjs on their real darwin
    // production faces (see the `DEDICATED_SHAPER_RANGES` comment), so unlike
    // Adlam/Hanifi Rohingya above they stay OUT of `usesHarfbuzzShaping` —
    // `isShapingRequired` alone is the whole fix for them.
    for (const cp of [
      0x0D91, // Sinhala KA
      0x07C8, // N'Ko A
      0x0845, // Mandaic AG
      0xA841, // Phags-pa KA
      0x10AC1, // Manichaean ALEPH
      0x10B81, // Psalter Pahlavi ALEPH
      0x10A02, // Kharoshthi I
    ]) {
      expect(usesHarfbuzzShaping(cp)).toBe(false);
    }
  });
});

describe("usesDedicatedShaper — DM-2033 / DM-2054 additions (isShapingRequired routing)", () => {
  it("covers Sinhala — USE-shaped, not Indic-shaped", () => {
    expect(usesDedicatedShaper(0x0D80)).toBe(true);  // block start
    expect(usesDedicatedShaper(0x0DFF)).toBe(true);  // block end
    expect(usesDedicatedShaper(0x0D91)).toBe(true);  // KA
    expect(usesDedicatedShaper(0x0D7F)).toBe(true);  // still Indic (Malayalam block end) — unaffected neighbor
    expect(usesDedicatedShaper(0x0E00)).toBe(true);  // Thai — unaffected neighbor on the other side
  });

  it("covers the reachable Arabic-misrouted set: N'Ko, Mandaic, Phags-pa, Manichaean, Psalter Pahlavi", () => {
    const blocks: Array<[number, number]> = [
      [0x07C0, 0x07FF], // N'Ko
      [0x0840, 0x085F], // Mandaic
      [0xA840, 0xA87F], // Phags-pa
      [0x10AC0, 0x10AFF], // Manichaean
      [0x10B80, 0x10BAF], // Psalter Pahlavi
    ];
    for (const [lo, hi] of blocks) {
      expect(usesDedicatedShaper(lo), `0x${lo.toString(16)} (block start)`).toBe(true);
      expect(usesDedicatedShaper(hi), `0x${hi.toString(16)} (block end)`).toBe(true);
    }
  });

  it("does NOT cover Mongolian — deliberately out of scope (already extractor:'native' on darwin)", () => {
    // HarfBuzz also sends Mongolian to USE (`hb-ot-shaper.hh:279`), but
    // fontkit never shapes it on this platform today, so the bug this section
    // fixes (fontkit's own wrong internal dispatch) does not apply to it.
    expect(usesDedicatedShaper(0x1801)).toBe(false); // Mongolian block
  });

  it("covers Adlam, Kharoshthi and Hanifi Rohingya", () => {
    const blocks: Array<[number, number]> = [
      [0x1E900, 0x1E95F], // Adlam
      [0x10A00, 0x10A5F], // Kharoshthi
      [0x10D00, 0x10D3F], // Hanifi Rohingya
    ];
    for (const [lo, hi] of blocks) {
      expect(usesDedicatedShaper(lo), `0x${lo.toString(16)} (block start)`).toBe(true);
      expect(usesDedicatedShaper(hi), `0x${hi.toString(16)} (block end)`).toBe(true);
    }
  });

  it("does NOT cover Old Sogdian, Sogdian or Old Uyghur — held out for no covering darwin face", () => {
    // HarfBuzz also sends all three to USE (`hb-ot-shaper.hh:364-365,381`),
    // but a live Playwright + CDP probe against this darwin checkout shows
    // Chrome itself falls back to Times (no system font covers them), and
    // Arial Unicode MS — the darwin routing table's own guess — has zero
    // glyphs in any of the three blocks. Routing to nowhere is not "matching
    // HarfBuzz's dispatch", it is unverifiable, so these stay out until a
    // covering face is confirmed.
    for (const cp of [0x10F00, 0x10F30, 0x10F70]) {
      expect(usesDedicatedShaper(cp)).toBe(false);
    }
  });

  it("does NOT cover the scripts HarfBuzz sends to its DEFAULT shaper, not USE", () => {
    // No `case` at all for these four in `hb_ot_shaper_categorize`
    // (`hb-ot-shaper.hh`, checked against the full switch) — they fall to
    // `default: return &_hb_ot_shaper_default;`, so the per-character
    // captured-xOffset path is already correct for them (HarfBuzz does no
    // contextual substitution on them either). Adding them would have
    // introduced a divergence from Chrome, not fixed one — mirrors the
    // Old Hungarian exclusion already documented on `isRtlScriptCodepoint`.
    expect(usesDedicatedShaper(0x10C05)).toBe(false); // Old Turkic
    expect(usesDedicatedShaper(0x10C85)).toBe(false); // Old Hungarian
    expect(usesDedicatedShaper(0x10905)).toBe(false); // Phoenician
    expect(usesDedicatedShaper(0x1E805)).toBe(false); // Mende Kikakui
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

  it("routes every script through HarfBuzz when the supported companions are present", () => {
    const k = key();
    const base = getFontInstance(k!, 400, 16, 0)!;
    // Chromium has no script allowlist in front of HarfBuzz. Latin and
    // Tibetan are useful controls because neither belonged to the legacy
    // empirically grown reroute table.
    for (const cp of [0x0041, 0x0F40]) {
      const res = resolveFontForCodepoint(cp, base, k!, 400, 16, 0, undefined, undefined, [k!]);
      expect(res.fontOverride?.shapesWithHarfbuzz).toBe(true);
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

  // DM-2054: unlike Myanmar/Khmer/Bengali above (and every other DM-2033
  // addition), fontkit's `ArabicShaper` picks DIFFERENT GLYPHS ENTIRELY for
  // Adlam and Hanifi Rohingya — not a cluster-map or advance/offset nuance.
  // Measured on the blocks' real darwin production faces with explicit RTL
  // direction (both scripts are `isRtlScriptCodepoint`):
  //
  //     Adlam 𞤀𞤁𞤂𞤃: fontkit {70,66,18,1} vs hb {71,69,21,3} — disjoint id sets
  //     on the SAME on-disk font file, so id N denotes the same outline under
  //     both engines.
  it("Adlam: HarfBuzz selects DIFFERENT glyphs than fontkit's ArabicShaper, with fontkit's outlines", () => {
    const { override, base } = resolveOverride("u-noto-sans-adlam", 0x1E900);
    expect(override).not.toBeNull();
    const o = override as NonNullable<ReturnType<typeof getFontInstance>>;
    const TEXT = "\u{1E900}\u{1E901}\u{1E902}\u{1E903}"; // 4 Adlam capital letters
    const hb = o.layout(TEXT, undefined, undefined, undefined, "rtl");
    const fk = base!.layout(TEXT, undefined, undefined, undefined, "rtl");
    const hbIds = hb.glyphs.map((g) => g.id);
    const fkIds = fk.glyphs.map((g) => g.id);
    // The discriminating assertion: the two engines do NOT pick the same
    // glyphs for this text on this font, so routing through this override
    // (rather than fontkit's own ArabicShaper) is what makes Domotion's paint
    // match Chrome's.
    expect(hbIds).not.toEqual(fkIds);
    expect(new Set(hbIds).size).toBeGreaterThan(0);
    for (const id of hbIds) expect(fkIds).not.toContain(id); // disjoint, not just reordered
    // And the outlines still come from fontkit's own `getGlyph` — the reroute
    // moves shaping only, per the DM-1197 invariant this whole file guards.
    const getGlyph = (base as unknown as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph.bind(base);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });

  it("Hanifi Rohingya: HarfBuzz selects different glyphs and advances than fontkit's ArabicShaper", () => {
    const { override, base } = resolveOverride("u-noto-sans-hanifirohg", 0x10D00);
    expect(override).not.toBeNull();
    const o = override as NonNullable<ReturnType<typeof getFontInstance>>;
    const TEXT = "\u{10D00}\u{10D01}\u{10D02}";
    const hb = o.layout(TEXT, undefined, undefined, undefined, "rtl");
    const fk = base!.layout(TEXT, undefined, undefined, undefined, "rtl");
    expect(hb.glyphs.map((g) => g.id)).not.toEqual(fk.glyphs.map((g) => g.id));
    const getGlyph = (base as unknown as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph.bind(base);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });

  it("routes formerly inert-script controls through Chromium's universal HarfBuzz path", () => {
    // These seven were deliberately absent from the empirically grown table
    // because sampled output happened to agree. Supported mode now mirrors
    // Chromium's mechanism instead: agreement is not a reason to skip its
    // shaper.
    for (const [fontKey, cp] of [
      ["u-sinhala-sangam-mn", 0x0D91],
      ["u-noto-sans-nko", 0x07C8],
      ["u-noto-sans-mandaic", 0x0845],
      ["u-noto-sans-phagspa", 0xA841],
      ["u-noto-sans-manichaean", 0x10AC1],
      ["u-noto-sans-psapahlavi", 0x10B81],
      ["u-noto-sans-kharoshthi", 0x10A02],
    ] as const) {
      const { override } = resolveOverride(fontKey, cp);
      expect((override as { shapesWithHarfbuzz?: boolean } | null)?.shapesWithHarfbuzz, fontKey).toBe(true);
    }
  });
});
