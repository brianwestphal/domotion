/**
 * DM-1883: the shaper injected into helper-backed faces that have no `shape`
 * query of their own.
 *
 * The bug this guards is quiet by construction, which is why it needs a test at
 * all. Not every platform helper implements `shape` — macOS does, the Windows
 * DirectWrite helper does not — and `layout()` responded to a failed shape by
 * falling through to naive one-glyph-per-codepoint mapping. That path produces
 * *correct advances* and *wrong glyphs*: for Arabic, every letter in its isolated
 * form. Against Chromium-on-Windows it showed as 13–18% missing ink with
 * byte-identical ink extents — nothing shifted, nothing clipped, so it read as a
 * rendering-quality difference rather than as shaping being absent entirely.
 *
 * The assertions below are therefore about CONTEXTUAL FORMS, not about glyph
 * counts or advances, because advances were never the thing that broke.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { makeFontkitShaper, resolveFontSpec } from "./font-resolution.js";

/** The platform's Arabic face, or null where this host has none. */
function arabicFontPath(): { path: string; ps?: string } | null {
  const spec = resolveFontSpec("sf-arabic");
  if (spec?.path == null || spec.path === "" || !existsSync(spec.path)) return null;
  return { path: spec.path, ps: spec.postscriptName };
}

const arabic = arabicFontPath();
// Skipped rather than failed on a host with no Arabic face: the point is to pin
// shaping behavior where a face exists, not to require one everywhere.
const describeArabic = arabic != null ? describe : describe.skip;

describeArabic("fontkit shaper for helper-backed faces (DM-1883)", () => {
  const shape = makeFontkitShaper(arabic!.path, arabic!.ps)!;

  it("applies Arabic contextual joining rather than isolated forms", () => {
    // مرحبا — every letter here joins. The naive path returns the cmap glyph for
    // each codepoint, i.e. the ISOLATED form of each. Shaping must return
    // something different, because initial/medial/final forms are different
    // glyphs in the font.
    const run = shape("مرحبا");
    expect(run).not.toBeNull();
    expect(run!.ids.length).toBeGreaterThan(0);

    // The discriminator: compare against what per-codepoint mapping WOULD give.
    // Using fontkit's own cmap keeps this a comparison of shaped-vs-unshaped
    // within one engine, so a font substitution cannot make it pass by accident.
    const naive = naiveIds("مرحبا");
    expect(naive.length).toBeGreaterThan(0);
    expect(
      run!.ids,
      "shaped ids equal the per-codepoint cmap ids — contextual joining did not run",
    ).not.toEqual(naive);
  });

  it("returns a cluster per glyph, so the caller can map glyphs to source text", () => {
    // The naive path supplied no cluster map at all. Losing it is what breaks
    // per-character x positioning and selection geometry downstream.
    const run = shape("مرحبا")!;
    expect(run.clusters).toHaveLength(run.ids.length);
    expect(run.clusters.every((c) => Number.isFinite(c) && c >= 0)).toBe(true);
  });

  it("maps RTL clusters in DESCENDING order, matching the platform helper", () => {
    // The bug this pins is a silent one. fontkit exposes no `.cluster` — it
    // exposes `codePoints` — so reading `.cluster` gives `undefined` and a map
    // of all zeros. That is not obviously wrong to look at, and is badly wrong
    // in effect: every glyph claims to start at source index 0.
    //
    // For a 5-character RTL word with no ligatures, the clusters must be
    // 4,3,2,1,0 — fontkit returns glyphs in VISUAL order, so the first glyph is
    // the LAST character. This exact sequence was verified against the macOS
    // helper's own `shape` query for the same string and face.
    const run = shape("مرحبا")!;
    expect(run.clusters).toEqual([4, 3, 2, 1, 0]);
  });

  it("maps LTR clusters in ASCENDING order", () => {
    const run = shape("Hello")!;
    expect(run.clusters).toEqual([0, 1, 2, 3, 4]);
  });

  it("never reports every glyph at cluster 0 for a multi-character run", () => {
    // The explicit regression guard for the all-zeros failure, phrased so it
    // holds for any script rather than for one expected sequence.
    for (const text of ["مرحبا", "Hello", "نمستے"]) {
      const run = shape(text);
      if (run == null || run.ids.length < 2) continue;
      expect(new Set(run.clusters).size, `all glyphs mapped to one cluster for ${text}`)
        .toBeGreaterThan(1);
    }
  });

  it("returns one position per glyph", () => {
    // `layout()` rejects a shaped run whose arrays disagree, so a shaper that
    // returned mismatched lengths would silently fall back to naive rather than
    // fail loudly. Pin the contract here instead.
    const run = shape("مرحبا")!;
    expect(run.positions).toHaveLength(run.ids.length);
    for (const p of run.positions) {
      expect(Number.isFinite(p.xAdvance)).toBe(true);
      expect(Number.isFinite(p.xOffset)).toBe(true);
    }
  });

  it("leaves an unjoined script alone — Latin shapes to its cmap glyphs", () => {
    // A guard against the opposite failure: a shaper that mangles simple text
    // would show up here. Latin "Hello" has no contextual substitution in a
    // normal face, so shaped and naive should agree.
    const run = shape("Hello");
    expect(run).not.toBeNull();
    expect(run!.ids).toEqual(naiveIds("Hello"));
  });

  it("is null-safe on a path that is not a font", () => {
    const bogus = makeFontkitShaper("/definitely/not/a/font/file.ttf");
    expect(bogus).toBeDefined();
    expect(bogus!("abc")).toBeNull();
  });

  it("returns undefined for an empty path, so nothing is injected", () => {
    expect(makeFontkitShaper("")).toBeUndefined();
  });

  /** Per-codepoint cmap ids — what the naive fallback path produces. */
  function naiveIds(text: string): number[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fontkit = require("fontkit");
    const opened: any = fontkit.openSync(arabic!.path);
    let f: any = opened;
    if (opened?.fonts != null && Array.isArray(opened.fonts)) {
      f = (arabic!.ps != null && opened.getFont != null)
        ? (opened.getFont(arabic!.ps) ?? opened.fonts[0])
        : opened.fonts[0];
    }
    return [...text].map((ch) => f.glyphForCodePoint(ch.codePointAt(0)!).id as number);
  }
});
