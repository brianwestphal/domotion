// Consolidated run-level HarfBuzz shaping + the RTL mirror domain.
//
// Two defects, pinned together because the second gates the first:
//
// 1. `harfbuzzShapedRunOverride` is the single post-selection production
//    shaper. These tests assert it is IN THE LOOP for ordinary Latin and a
//    covering complex-script primary, with
//    the same paired invariants the per-codepoint pin file
//    (`harfbuzz-script-routing.test.ts`) established: HarfBuzz's ids, the BASE
//    engine's outlines, stable proxy identity, carried metadata.
//
// 2. RTL text reaching the renderer is PAINT-domain: `applyBidi` (text.ts)
//    already substituted the Bidi_Mirroring_Glyph counterpart at odd embedding
//    levels, because fontkit and the platform helpers draw exactly what they
//    are given. HarfBuzz mirrors RTL buffers ITSELF, coverage-gated
//    (`hb_ot_rotate_chars`, `hb-ot-shape.cc:657-668`, rev 4de187d) — Blink
//    never pre-mirrors — so an hb-backed layout fed pre-mirrored text mirrored
//    brackets TWICE and painted the logical `(` as `(` where Chrome paints
//    `)`. The mirror-domain adapter in `harfbuzz-shaper.ts` maps every
//    character of an RTL buffer through the BMG involution first; these tests
//    assert the painted bracket is the mirrored one, on both splitters and on
//    both the guessed-direction and explicit-direction paths.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  clearFontResolutionCaches, getFontInstance, resolveFontKey, resolveFontKeyChain,
  fontFeatureValueShapingOverride, harfbuzzShapedRunOverride, ensureGlyphDef,
} from "./font-resolution.js";
import { splitTextIntoFontRunsShaped } from "./cluster-fallback.js";
import { textToPathMarkup, clearGlyphDefs } from "./text-to-path.js";

const ARIAL_UNICODE = "/Library/Fonts/Arial Unicode.ttf";
const onDarwin = process.platform === "darwin";
const describeMac = onDarwin && existsSync(ARIAL_UNICODE) ? describe : describe.skip;

const savedClusterFlag = process.env.DOMOTION_CLUSTER_FALLBACK;
beforeEach(() => { clearFontResolutionCaches(); clearGlyphDefs(); });
afterEach(() => {
  if (savedClusterFlag == null) delete process.env.DOMOTION_CLUSTER_FALLBACK;
  else process.env.DOMOTION_CLUSTER_FALLBACK = savedClusterFlag;
  clearFontResolutionCaches();
  clearGlyphDefs();
});

type Getter = { getGlyph(id: number): { path: { commands: Array<{ command: string; args: number[] }> } } };

function splitArabic(text: string): NonNullable<ReturnType<typeof splitTextIntoFontRunsShaped>> {
  const key = resolveFontKey("Arial Unicode MS");
  const primary = getFontInstance(key, 400, 16, 0);
  if (primary == null) throw new Error("Arial Unicode MS did not open");
  const runs = splitTextIntoFontRunsShaped(text, primary, key, 400, 16, 0, undefined, undefined, resolveFontKeyChain("Arial Unicode MS"), false, 100, undefined, "Arial Unicode MS");
  if (runs == null) throw new Error("shaped splitter declined");
  return runs;
}

describeMac("run-level reroute — a covering primary's runs shape through HarfBuzz", () => {
  it("routes a primary-covered Arabic run (the resolver is bypassed for it)", () => {
    const key = resolveFontKey("Arial Unicode MS");
    const primary = getFontInstance(key, 400, 16, 0)!;
    const runs = splitArabic("مرحبا");
    expect(runs.length).toBe(1);
    expect(runs[0].fontKey).toBe(key);
    expect(runs[0].isPrimary).toBe(true);
    // The discriminating half: before the run-level wrap, this run's font WAS
    // the raw primary instance — fontkit shaping, reroute inert. (Identity
    // compared as a boolean: a failure diff over a fontkit Font object OOMs
    // the test worker trying to serialize its tables.)
    expect(runs[0].font === primary).toBe(false);
    expect(runs[0].font.shapesWithHarfbuzz).toBe(true);
  });

  it("Thai on a covering primary substitutes the Windows-PUA shift-left forms, with base outlines", () => {
    // Same sequence the per-codepoint pin file uses — PO PLA + SARA UEE +
    // MAI THO + NO NU: `hb-ot-shaper-thai.cc` (rev 4de187d) maps U+0E37 →
    // U+F704 and U+0E49 → U+F714 over an ascender base; on this face those
    // are gids 5447 / 5463, and the base engine emits the plain cmap glyphs
    // 2158 / 2172. Before the run-level wrap this run shaped with the base
    // engine, so the PUA substitution never happened for a COVERING primary.
    const key = resolveFontKey("Arial Unicode MS");
    const primary = getFontInstance(key, 400, 16, 0)!;
    const runs = splitArabic("ปื้น");
    expect(runs.length).toBe(1);
    const hb = runs[0].font.layout("ปื้น");
    expect(hb.glyphs.map((g) => g.id)).toEqual([2130, 5447, 5463, 2128]);
    // Outlines must not change hands: every glyph is drawn by the BASE engine.
    const getGlyph = (primary as unknown as Getter).getGlyph.bind(primary);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });

  it("returns a STABLE font object across split calls (run-grouping identity)", () => {
    const a = splitArabic("مرحبا");
    const b = splitArabic("مرحبا");
    expect(a[0].font === b[0].font).toBe(true);
  });

  it("carries the FontInstance metadata the embedded path reads", () => {
    const key = resolveFontKey("Arial Unicode MS");
    const primary = getFontInstance(key, 400, 16, 0)!;
    const run = splitArabic("مرحبا")[0];
    expect(run.font.postscriptName).toBe(primary.postscriptName);
    expect(run.font.naturalWeight).toBe(primary.naturalWeight);
    expect(run.font.faceIsBoldTrait).toBe(primary.faceIsBoldTrait);
    expect(run.font.unitsPerEm).toBe(primary.unitsPerEm);
  });

  it("routes ordinary Latin too, and never double-wraps an hb font", () => {
    const key = resolveFontKey("Arial Unicode MS");
    const primary = getFontInstance(key, 400, 16, 0)!;
    const latin = splitArabic("hello");
    expect(latin[0].font === primary).toBe(false);
    expect(latin[0].font.shapesWithHarfbuzz).toBe(true);
    // A font already shaping through HarfBuzz (here: the feature-list proxy)
    // must come back unchanged — a proxy-over-proxy has no `getGlyph` and
    // would silently swap the outline engine.
    const featProxy = fontFeatureValueShapingOverride(primary, key, 400, 16, 0, undefined, ["-liga"]);
    expect(featProxy === primary).toBe(false);
    expect(harfbuzzShapedRunOverride(featProxy, key, 400, 16, 0, undefined, "مرحبا") === featProxy).toBe(true);
  });

  it("feature reroute over a script-rerouted run keeps the BASE outlines (no proxy stacking)", () => {
    // The emitters apply `fontFeatureValueShapingOverride` AFTER the splitter,
    // so a routed-script run hands it the script proxy. Stacking a proxy over
    // a proxy silently swaps the outline engine — the inner proxy exposes no
    // `getGlyph`, so `outlinesFromBase` falls back to HarfBuzz's own
    // `glyphToPath` — which is the shipped regression class the per-codepoint
    // pin file records (Thai worst tile 0.0940 → 0.1214 from the outline
    // engine changing hands alone). `hbShapingBaseOf` unwraps to the true base.
    const key = resolveFontKey("Arial Unicode MS");
    const primary = getFontInstance(key, 400, 16, 0)!;
    const scriptProxy = harfbuzzShapedRunOverride(primary, key, 400, 16, 0, undefined, "ปื้น");
    expect(scriptProxy === primary).toBe(false);
    const stacked = fontFeatureValueShapingOverride(scriptProxy, key, 400, 16, 0, undefined, ["-liga"]);
    const hb = stacked.layout("ปื้น");
    expect(hb.glyphs.length).toBeGreaterThan(0);
    const getGlyph = (primary as unknown as Getter).getGlyph.bind(primary);
    for (const g of hb.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(g.path.commands)).toBe(JSON.stringify(getGlyph(g.id).path.commands));
    }
  });
});

// Kohinoor Bangla is a system face on macOS; the vowel-constraint case is the
// concrete sequence Bengali was routed for — fontkit shapes অ + AA straight
// through (2 glyphs) where HarfBuzz inserts U+25CC between them
// (`_hb_preprocess_text_vowel_constraints`,
// `hb-ot-shaper-vowel-constraints.cc:58-446`, rev 4de187d).
describeMac("run-level reroute — Bengali vowel constraint on a covering primary", () => {
  it("inserts the dotted circle when the covering font is the PRIMARY", () => {
    const key = "u-kohinoor-bangla";
    const primary = getFontInstance(key, 400, 16, 0);
    if (primary == null) throw new Error("u-kohinoor-bangla did not open");
    const runs = splitTextIntoFontRunsShaped("অা", primary, key, 400, 16, 0, undefined, undefined, [key], false, 100, undefined, undefined);
    if (runs == null) throw new Error("shaped splitter declined");
    expect(runs.length).toBe(1);
    const hb = runs[0].font.layout("অা");
    expect(primary.layout("অা").glyphs.length).toBe(2); // base engine: no circle
    expect(hb.glyphs.length).toBe(3);                    // HarfBuzz: base, ◌, vowel sign
    const circleId = primary.glyphForCodePoint(0x25CC).id;
    expect(circleId).not.toBe(0);
    expect(hb.glyphs[1].id).toBe(circleId);
  });
});

describeMac("RTL mirror domain — hb-shaped runs paint the same bracket applyBidi chose", () => {
  // Logical text ALEF ( BEH: every character sits at an odd embedding level
  // (the bracket's neighbors are both strong-R), so `applyBidi` pre-mirrors
  // the bracket and the renderer receives ALEF ) BEH. Chrome paints `)` — the
  // hb mirror of the logical `(`. Double mirroring painted `(`.
  const PREMIRRORED = "ا)ب";

  function bracketDefIds(): { open: string; close: string; font: ReturnType<typeof getFontInstance> } {
    const key = resolveFontKey("Arial Unicode MS");
    const font = getFontInstance(key, 400, 16, 0)!;
    const gidOpen = font.glyphForCodePoint(0x28).id;
    const gidClose = font.glyphForCodePoint(0x29).id;
    // Def identity includes the outline digest. Reuse the exact base outlines
    // that the production emitter registers so these lookups resolve its ids;
    // empty commands would intentionally name fresh defs after the variable-
    // axis cache fix made commands part of the identity.
    const getGlyph = (font as unknown as Getter).getGlyph.bind(font);
    return {
      open: ensureGlyphDef(key, 400, 16, 0, gidOpen, getGlyph(gidOpen).path.commands),
      close: ensureGlyphDef(key, 400, 16, 0, gidClose, getGlyph(gidClose).path.commands),
      font,
    };
  }

  it("paints the mirrored bracket — SAME glyph from both splitters", () => {
    for (const flag of ["1", "0"]) {
      process.env.DOMOTION_CLUSTER_FALLBACK = flag;
      clearFontResolutionCaches();
      clearGlyphDefs();
      const res = textToPathMarkup(PREMIRRORED, 16, "Arial Unicode MS", "400", undefined, [0, 10, 20]);
      expect(res).not.toBeNull();
      const ids = bracketDefIds();
      expect(res!.markup.includes(`href="#${ids.close}"`), `splitter=${flag}: must paint ')'`).toBe(true);
      expect(res!.markup.includes(`href="#${ids.open}"`), `splitter=${flag}: must NOT paint '('`).toBe(false);
    }
  });

  it("paints the mirrored bracket through the feature-list hb reroute (guessed direction)", () => {
    // Reachable before any run-level routing existed: `-liga` wraps the run in
    // the hb proxy, `singleFontMarkup` layouts the whole text with no explicit
    // direction, and hb's own guess makes the buffer RTL. Without the
    // mirror-domain adapter this painted the logical `(` as `(`.
    const res = textToPathMarkup(PREMIRRORED, 16, "Arial Unicode MS", "400", undefined, [0, 10, 20], undefined, ["-liga"]);
    expect(res).not.toBeNull();
    const ids = bracketDefIds();
    expect(res!.markup.includes(`href="#${ids.close}"`)).toBe(true);
    expect(res!.markup.includes(`href="#${ids.open}"`)).toBe(false);
  });

  it("proxy layout honors the mirror domain for an EXPLICIT direction, and leaves LTR untouched", () => {
    const key = resolveFontKey("Arial Unicode MS");
    const base = getFontInstance(key, 400, 16, 0)!;
    const gidOpen = base.glyphForCodePoint(0x28).id;
    const gidClose = base.glyphForCodePoint(0x29).id;
    const proxy = fontFeatureValueShapingOverride(base, key, 400, 16, 0, undefined, ["liga"]);
    expect(proxy === base).toBe(false);
    // Paint-domain ")" shaped RTL must stay the ")" glyph: the adapter maps it
    // back to "(" and hb's coverage-gated mirror re-applies ")".
    const rtl = proxy.layout(PREMIRRORED, undefined, undefined, undefined, "rtl");
    expect(rtl.glyphs.map((g) => g.id)).toContain(gidClose);
    expect(rtl.glyphs.map((g) => g.id)).not.toContain(gidOpen);
    // An LTR buffer is untouched — hb mirrors nothing there, so applyBidi's
    // substitutions (and plain unmirrored brackets) pass through.
    const ltr = proxy.layout("(x", undefined, undefined, undefined, "ltr");
    expect(ltr.glyphs.map((g) => g.id)).toContain(gidOpen);
    expect(ltr.glyphs.map((g) => g.id)).not.toContain(gidClose);
  });
});
