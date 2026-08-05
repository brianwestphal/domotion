// The HarfBuzz feature-reroute must shape against the face it will DRAW from
// (DM-1982).
//
// `fontFeatureValueShapingOverride` reroutes a run whose feature list carries a
// disable (`-liga`) or an explicit value (`aalt=2`) through the vendored
// HarfBuzz, because fontkit's list is enable-only and cannot switch a default-on
// feature off. The outlines stay with the resolved face (`outlinesFromBase`), so
// the shaper and the outlines have to agree about which FILE they are on.
//
// They did not. The face was re-derived with `shapingFaceFor(fontKey, …)`, and a
// font key names a FAMILY — the run's slant and weight pick a sibling file or
// TTC member out of it, and that derivation lives in `getFontInstance`. So an
// italic run shaped against the family's UPRIGHT face and then drew those glyph
// ids out of the italic one. Every glyph came out a different character, not
// subtly displaced: the affected fixture painted stacked accented Latin where
// "italic outline" belonged.
//
// Measured on `system-ui` at weight 800, "italic outline":
//   fontkit (italic face)  716,847,577,744,716,645,3,780,859,…
//   proxy, before the fix  739,894,588,772,739,656,3,815,906,…   the upright ids
//
// The fix takes the face from `getFontSourceInfo(base)` — the file the outlines
// are actually taken from — so agreement is by construction rather than by two
// derivations happening to coincide.
import { describe, expect, it } from "vitest";
import {
  resolveFont, resolveFontKey, fontFeatureValueShapingOverride, getFontSourceInfo,
} from "./font-resolution.js";

const TEXT = "italic outline";
const SIZE = 72, WEIGHT = 800;
const DISABLES = ["-liga", "-clig", "-calt"];

/** Shaped glyph ids + total advance for a run, through whichever instance. */
function shaped(font: ReturnType<typeof resolveFont>): { ids: string; adv: number } | null {
  if (font == null) return null;
  const r = font.layout(TEXT);
  return {
    ids: r.glyphs.map((g) => g.id).join(","),
    adv: +r.positions.reduce((s, p) => s + p.xAdvance, 0).toFixed(4),
  };
}

describe("HarfBuzz feature-reroute keeps the shaping face (DM-1982)", () => {
  // Each family whose italic / bold is a SEPARATE file or TTC member — the
  // shape of face the key-based derivation could not reach. A family the host
  // lacks simply drops out rather than asserting nothing.
  //
  // `Arial` leads the list because it is the one that discriminates on BOTH
  // platforms: measured, it routes all four (weight x slant) combinations to
  // distinct files on macOS (Arial / Arial Italic / Arial Bold / Arial Bold
  // Italic) and on Linux (LiberationSans Regular / Italic / Bold / BoldItalic).
  // The macOS-flavored families below add coverage where they exist; on Linux
  // `system-ui` in particular resolves ONE face for both slants, so a list
  // without Arial would leave the container asserting nothing.
  for (const family of ["Arial", "system-ui", "Georgia", "Times", "Helvetica"]) {
    for (const slant of [0, 1]) {
      it(`${family} at slant ${slant}: the proxy shapes the same glyphs as the base instance`, () => {
        const key = resolveFontKey(family);
        const base = resolveFont(family, WEIGHT, SIZE, slant, undefined, 100);
        if (base == null) return;
        const direct = shaped(base);
        const proxy = shaped(
          fontFeatureValueShapingOverride(base, key, WEIGHT, SIZE, slant, undefined, DISABLES),
        );
        if (direct == null || proxy == null) return;
        // The claim, stated on the ids rather than on a pixel measure: the
        // rerouted run must resolve the SAME characters. An advance check alone
        // would not have caught this — the upright and italic cuts of these
        // families are metric-compatible, so the wrong glyphs occupied exactly
        // the right width.
        expect(proxy.ids).toBe(direct.ids);
        expect(proxy.adv).toBe(direct.adv);
      });
    }
  }

  it("is DISCRIMINATING: some family above really does route to a different FILE", () => {
    // Without this, every assertion above could pass on a host where nothing
    // routes anywhere — vacuous exactly where the bug lived.
    //
    // The check is on the FILE, not on the glyph ids, because the file is what
    // the bug was about: the proxy opened the family's base member while the
    // outlines came from a sibling. Ids are a downstream symptom, and a
    // platform-dependent one — measured in the pinned Linux container, Arial's
    // four cuts resolve to four distinct Liberation files that nonetheless
    // share a glyph ORDER, so the ids agree across them. (Which also means the
    // bug was benign on Linux for these families: wrong file, same ids. It was
    // not benign on macOS, where Times and Helvetica are TTC members with
    // genuinely different orders.)
    //
    // Asked across the whole list rather than of one family, because whether a
    // family routes at all is a per-host fact: `system-ui` resolves to two
    // files on macOS and to ONE on Linux, where the slant is synthesized.
    const routes = ["Arial", "system-ui", "Georgia", "Times", "Helvetica"].filter((family) => {
      const seen = new Set<string>();
      for (const [w, sl] of [[400, 0], [400, 1], [800, 0], [800, 1]] as const) {
        const src = getFontSourceInfo(resolveFont(family, w, SIZE, sl, undefined, 100));
        if (src != null) seen.add(`${src.path}#${src.faceIndex}`);
      }
      return seen.size > 1;
    });
    // A host where NOTHING routes cannot exercise the bug at all, and should say
    // so loudly rather than report ten green vacuous assertions.
    expect(routes.length).toBeGreaterThan(0);
  });
});
