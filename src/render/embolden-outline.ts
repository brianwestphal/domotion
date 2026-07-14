// DM-1693 / DM-1695: synthetic (faux) bold + oblique for embedded-font mode.
//
// Faux-italic (DM-1695): when italic is requested but the resolved face is
// upright (no italic sibling, no `slnt` axis), Chrome synthesizes an oblique by
// shearing the glyph at render time (Skia `SkFont.setSkewX(-1/4)`). A shear is a
// pure affine transform — it commutes with the uniform font scaling, so a
// design-space shear reproduces Chrome's device-space skew EXACTLY at every size
// (unlike the embolden, which has a hinting-space residual). So `shearPathCommands`
// bakes `x += OBLIQUE_SHEAR·y` into the outline; the `@font-face` stays tagged
// `font-style: italic` so the consumer browser synthesizes nothing on top.
//
// Faux-bold (DM-1693) below.
//
// When Chrome paints text in a system font that has NO face at (or near) the
// requested weight, it does not leave the glyphs thin — it ALGORITHMICALLY
// emboldens the resolved face's outline. On Linux this is Skia's SkScalerContext
// synthetic bold (an `FT_Outline_Embolden` on the FreeType outline); on macOS /
// Windows the CoreText / DirectWrite equivalents. The emboldening is applied at
// a strength proportional to the pixel size, so the equivalent dilation in
// FONT-DESIGN units is a CONSTANT (independent of render size) — see
// `emboldenStrengthForFont` for the calibrated value. So we bake the embolden
// straight into the embedded glyph outline once and it reproduces Chrome's paint
// at every font-size, with no reliance on the consumer browser's own synthesis
// (whose fixed `@font-face`-descriptor threshold cannot mirror fontconfig's
// face-specific one — the reason the descriptor-only approach was reverted).
//
// The dilation is a faithful float port of FreeType's `FT_Outline_EmboldenXY`
// (ftoutln.c — the exact routine Skia runs): see `ftEmboldenContour`. Porting
// the exact algorithm (not an approximation) keeps the emboldened outline
// corner-for-corner with Chrome's, which matters when the glyph is also
// `-webkit-text-stroke`d and the stroke traces that outline.
//
// NOTE: applied to UNSTROKED runs only (gated in `renderTextAsEmbedded`). Chrome
// emboldens in device space (post-hinting); we bake in design space. The
// strengths match (verified: reproduces Chrome's +51% stroke coverage within
// ±9%), but a ~1px edge residual survives that a high-contrast stroke would
// magnify — so stroked heavy text stays at its thin baseline for now.

import type { PathCommand } from "./embedded-font-builder.js";

/** Requested-vs-face weight gap above which Chrome emboldens a static face.
 *  Calibrated on Linux/fontconfig against WenQuanYi Zen Hei (usWeightClass 500):
 *  weight 700 (Δ200) renders the Medium face as-is; weight ≥720 (Δ≥220) is
 *  emboldened. `> 200` reproduces every measured point and is safely clear of
 *  the corpus-wide 700-weight headers (Δ200) that must NOT be emboldened. */
export const FAUX_BOLD_WEIGHT_DELTA = 200;

/** Synthetic-oblique shear factor, in font-design (y-up) space: `x += 0.25·y`.
 *  Mirrors Chrome's `SkFont.setSkewX(-SK_Scalar1/4)` (a right-lean of ~14°) —
 *  the exact skew Blink applies for synthesized italic (font_platform_data.cc). */
export const OBLIQUE_SHEAR = 0.25;

/**
 * Return a NEW PathCommand[] sheared by `x' = x + factor·y` (font units, y-up —
 * so ascenders lean right, descenders left, pivoting at the baseline y=0). This
 * is a pure affine transform, so no orientation/winding handling is needed and
 * it reproduces Chrome's device-space skew exactly at every render size.
 * `factor === 0` returns the input unchanged.
 */
export function shearPathCommands(cmds: PathCommand[], factor: number): PathCommand[] {
  if (factor === 0 || cmds.length === 0) return cmds;
  return cmds.map((c) => {
    const args = c.args.slice();
    for (let i = 0; i + 1 < args.length; i += 2) {
      args[i] = Math.round(args[i] + factor * args[i + 1]);
      args[i + 1] = Math.round(args[i + 1]);
    }
    return { command: c.command, args };
  });
}

/**
 * Embolden strength in font-design units (TOTAL growth; each side shifts by
 * half). FreeType's textbook `FT_GlyphSlot_Embolden` uses `unitsPerEm / 24`, but
 * Skia's SkScalerContext synthetic-bold (what Chrome actually paints) is weaker —
 * at the textbook strength our faithful `FT_Outline_EmboldenXY` port paints ~66%
 * more ink where Chrome paints +49%. A 0.73× factor reconciles them, calibrated
 * against Chrome-on-Linux's actual painted ink for WenQuanYi Zen Hei at weight
 * 800 (the emboldened target), verified within ±2% on both a corner-dense glyph
 * (目) and a curvy one (가) — confirming the dilation is glyph-independent. Net:
 * `unitsPerEm / 24 * 0.73` ≈ `unitsPerEm / 32.9`.
 */
export function emboldenStrengthForFont(unitsPerEm: number): number {
  return (unitsPerEm / 24) * 0.73;
}

interface Pt {
  x: number;
  y: number;
  /** Back-reference: which command + which arg index pair this point occupies. */
  cmd: number;
  arg: number;
}

function contourSignedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Return a NEW PathCommand[] with the outline emboldened by `strength` font
 * units (total growth; `strength/2` per side). `strength <= 0` returns the
 * input unchanged. Coordinates are font units, y-up (the fontkit path space the
 * embedded builder consumes).
 */
export function emboldenPathCommands(cmds: PathCommand[], strength: number): PathCommand[] {
  if (!(strength > 0) || cmds.length === 0) return cmds;

  // Deep-copy args so the source outline (fontkit's cached glyph path) is never
  // mutated — the same glyph can be tracked at multiple weights.
  const out: PathCommand[] = cmds.map((c) => ({ command: c.command, args: c.args.slice() }));

  // Group points by contour. Each command contributes its coordinate pairs in
  // order; the LAST pair is the on-curve endpoint, earlier pairs are controls.
  const contours: Pt[][] = [];
  let cur: Pt[] = [];
  for (let ci = 0; ci < out.length; ci++) {
    const c = out[ci];
    const a = c.args;
    switch (c.command) {
      case "moveTo":
        if (cur.length > 0) contours.push(cur);
        cur = [{ x: a[0], y: a[1], cmd: ci, arg: 0 }];
        break;
      case "lineTo":
        cur.push({ x: a[0], y: a[1], cmd: ci, arg: 0 });
        break;
      case "quadraticCurveTo":
        cur.push({ x: a[0], y: a[1], cmd: ci, arg: 0 });
        cur.push({ x: a[2], y: a[3], cmd: ci, arg: 2 });
        break;
      case "bezierCurveTo":
        cur.push({ x: a[0], y: a[1], cmd: ci, arg: 0 });
        cur.push({ x: a[2], y: a[3], cmd: ci, arg: 2 });
        cur.push({ x: a[4], y: a[5], cmd: ci, arg: 4 });
        break;
      case "closePath":
        // Z carries no point; the contour closes back to its moveTo.
        break;
      default:
        break;
    }
  }
  if (cur.length > 0) contours.push(cur);

  // Orientation drives the shift sign (FT_Outline_Get_Orientation). Compute the
  // total signed area across all contours; a net-clockwise outline in this
  // y-up space (negative area) is FreeType's TRUETYPE fill orientation — the
  // convention glyf outlines use. Holes share the outline's single orientation,
  // so they shrink (growing the ink) rather than each following its own winding.
  let totalArea = 0;
  for (const ct of contours) totalArea += contourSignedArea(ct);
  const orientationTrueType = totalArea < 0;

  for (const pts of contours) ftEmboldenContour(pts, orientationTrueType, strength);

  // Write the (mutated-in-place) point coordinates back into the command args,
  // rounding to integer font units — glyf coordinates are integers, and
  // svg2ttf / the golden SVG want deterministic, compact numbers.
  for (const pts of contours) {
    for (const p of pts) {
      out[p.cmd].args[p.arg] = Math.round(p.x);
      out[p.cmd].args[p.arg + 1] = Math.round(p.y);
    }
  }
  return out;
}

/**
 * Faithful float port of FreeType's `FT_Outline_EmboldenXY` (ftoutln.c) — the
 * exact algorithm Skia/Chrome-on-Linux runs for synthetic bold. Mutates `pts`
 * (one contour's point polygon — on- AND off-curve control points) IN PLACE.
 *
 * Reproducing FreeType's exact per-point shift (rather than an approximate
 * offset) is load-bearing when the emboldened glyph is ALSO `-webkit-text-
 * stroke`d: the stroke traces the outline, so any corner-geometry difference
 * from Chrome's own faux-bold is magnified into a visible edge mismatch.
 *
 * `strength` is the TOTAL growth in font units; FreeType halves it internally.
 * `orientationTrueType` mirrors `FT_Outline_Get_Orientation` (glyf outlines are
 * TRUETYPE-oriented) and selects which shift component is negated. FreeType
 * walks only points that MOVE — `j` cycles through every point while `i` lags,
 * so runs of coincident points collapse and each point is shifted exactly once
 * (after both its incident edges are known), which is why in-place mutation is
 * safe: a shifted point is never re-read as an edge endpoint.
 */
function ftEmboldenContour(pts: Pt[], orientationTrueType: boolean, strength: number): void {
  const n = pts.length;
  if (n < 2) return;
  const xs = strength / 2;
  const ys = strength / 2;

  let inx = 0, iny = 0, lIn = 0;
  let ancx = 0, ancy = 0, lAnchor = 0;
  const nextIdx = (p: number) => (p < n - 1 ? p + 1 : 0);

  let i = n - 1;
  let j = 0;
  let k = -1;
  let guard = 0;
  const maxIter = n * 4 + 8;

  while (j !== i && i !== k && guard++ < maxIter) {
    let outx: number, outy: number, lOut: number;
    if (j !== k) {
      outx = pts[j].x - pts[i].x;
      outy = pts[j].y - pts[i].y;
      lOut = Math.hypot(outx, outy);
      if (lOut === 0) {
        j = nextIdx(j);
        continue;
      }
      outx /= lOut;
      outy /= lOut;
    } else {
      outx = ancx;
      outy = ancy;
      lOut = lAnchor;
    }

    if (lIn !== 0) {
      if (k < 0) {
        k = i;
        ancx = inx;
        ancy = iny;
        lAnchor = lIn;
      }
      let d = inx * outx + iny * outy; // cos of the turn
      let shx = 0, shy = 0;
      // Shift only if the turn is less than ~160° (FreeType's d > -0xF000/0x10000).
      if (d > -0.9375) {
        d = d + 1;
        shx = iny + outy;
        shy = inx + outx;
        if (orientationTrueType) shx = -shx;
        else shy = -shy;
        let q = outx * iny - outy * inx; // sin of the turn
        if (orientationTrueType) q = -q;
        const l = Math.min(lIn, lOut);
        // Miter limit: scale by strength/d normally, by edge-length/q at spikes.
        shx = xs * q <= l * d ? (shx * xs) / d : (shx * l) / q;
        shy = ys * q <= l * d ? (shy * ys) / d : (shy * l) / q;
      }
      // Move every point in [i, j) by (strength/2 + shift).
      let m = i;
      let g2 = 0;
      while (m !== j && g2++ < maxIter) {
        pts[m].x += xs + shx;
        pts[m].y += ys + shy;
        m = nextIdx(m);
      }
      i = j;
    } else {
      i = j;
    }
    inx = outx;
    iny = outy;
    lIn = lOut;
    j = nextIdx(j);
  }
}
