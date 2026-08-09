#!/usr/bin/env tsx
/**
 * Text-decoration GEOMETRY ORACLE.
 *
 * Whole-fixture pixel-diff structurally rewards the WRONG decoration
 * constants: an intentionally mis-tuned geometry can compensate for a
 * rasterization gap we do not own, and the diff score improves while the
 * geometry gets further from what Chrome paints. Measured twice in one
 * session: a skip-ink dilation constant corrected from a fitted value to
 * Blink's real rule moved the painted gap unambiguously CLOSER to Chrome's
 * 25px while the whole-fixture diffPct moved the other way; and a fixture
 * PASSED at a displayed 0.00% in both arms of a change whose emitted SVG
 * differed by an entire line segment. So decoration work is gated on
 * GEOMETRY — the painted line's extent, thickness, offset, and gap
 * intervals — not on aggregate pixel difference.
 *
 * Three answers per case, compared pairwise:
 *
 *   C  Chrome-measured   The painted decoration bar, measured out of a
 *                        deviceScaleFactor-4 screenshot. The decoration is
 *                        forced to pure red (`text-decoration-color: #ff0000`)
 *                        so its pixels are separable from black glyph ink by
 *                        channel arithmetic, and geometry is recovered by
 *                        coverage-weighted row/column profiles (±0.06 CSS px).
 *   R  Rule-predicted    Blink's decoration rules transcribed from source
 *                        (file:line citations below, Chromium rev 7d859f27),
 *                        fed with inputs measured from the SAME page: fragment
 *                        top + baseline from layout, FloatAscent from canvas
 *                        `measureText().fontBoundingBoxAscent` (which IS
 *                        `FontMetrics::FloatAscent` for the alphabetic
 *                        baseline — `core/html/canvas/text_metrics.cc:133-138`).
 *                        Only `from-font` and `under` cases read font tables
 *                        through fontkit (see Blind spots).
 *   S  SVG-emitted       Domotion's decoration geometry parsed ANALYTICALLY
 *                        out of the emitted SVG markup (`<line>` y/stroke-width
 *                        under accumulated translate transforms). Our side is
 *                        never rasterized — that is the point: the consumer's
 *                        SVG renderer owns rasterization, we own geometry.
 *
 * Checks and gating:
 *
 *   C vs R  "transcription" — validates the transcription (and the oracle's
 *           own measurement) against Chrome's actual paint. ALWAYS gates:
 *           if this fails the oracle must not be trusted to judge anything.
 *   C vs S  "skip-ink" — Domotion's emitted gap intervals vs Chrome's painted
 *           gap intervals, per edge. Gates by default (--no-gate-skip-ink to
 *           demote). This is the leg that discriminates the skip-ink dilation
 *           constant: Blink pads each glyph intercept by
 *           `min(thickness, 13)` (`core/paint/text_painter.cc:607-608`,
 *           constant `kDecorationClipMaxDilation` at :46); a half-sized pad
 *           moves every gap edge by t/2 and fails here.
 *   R vs S  "svg-geometry" — the gate for Domotion's own decoration
 *           geometry. ON by default (--no-gate-svg-geometry to demote) since
 *           the decoration-geometry transcription landed:
 *           `getDecorationMetrics` + `emitDecorationLine` now emit Blink's
 *           rules exactly, and this leg passes 84/84. It was off while the
 *           renderer carried the empirical constants the transcription
 *           replaced.
 *
 * Transcribed rules (all horizontal-tb, alphabetic baseline, zoom 1,
 * Chromium rev 7d859f27; ascF = FloatAscent, ascI = lround(ascF), fs = used
 * font size, t = resolved thickness, LU(x) = round(x*64)/64 — LayoutUnit):
 *
 *   thickness   `core/paint/text_decoration_info.cc:65-92,449-451`
 *               auto -> fs/10; from-font -> FontMetrics underline thickness
 *               (or fs/10 if absent); length/percent -> roundf(px, % of fs);
 *               then max(1, t).
 *   underline   `core/layout/text_decoration_offset.cc:16-35,91-120`
 *     auto        top = ascI + gap + roundf(extra),
 *                 gap = extraIsAuto ? max(1, ceil(t/2)) : 0
 *     from-font   top = roundf(ascF + underlinePos + extra)   [pos below
 *                 baseline positive — Skia fUnderlinePosition, negated
 *                 CTFontGetUnderlinePosition on macOS]
 *     under       top = floor(LU(ascF + NTD) + LU(extra)) + 1
 *                 (`:52-89`; VerticalPosition(BottomOfEmHeight) =
 *                 -NormalizedTypoDescent, `platform/fonts/simple_font_data.cc:417-431`)
 *   overline    top = floor(LU(ascF - ascI)) - floor(t)   (`:52-89`, TextTop)
 *   line-through top = 2*ascF/3 - t/2   (`text_decoration_info.cc:385-386`)
 *   double      second bar at top + d, d = +(t+1) underline, -(t+1)
 *               overline, floor(t+1) line-through
 *               (`text_decoration_info.cc:259-279`)
 *   paint snap  HTML solid/double lines snap: topS = floor(top + 0.5),
 *               hS = max(floor(t), 1)
 *               (`core/paint/decoration_line_painter.cc` SnapYAxis /
 *               RoundDownThickness / DrawLineAsRect)
 *   skip-ink    intercept band = bar inset 0.5px top+bottom
 *               (`text_painter.cc:589-590`), each intercept dilated
 *               horizontally by min(t, 13) (`:607-608`).
 *
 * Patterned styles (dashed / dotted / wavy) are graded too, differently:
 *   - The C leg measures the painted-ink EXTENT (50%-coverage row/column
 *     threshold) instead of the coverage-weighted bar profile — a dot's row
 *     mass is a chord length and a wave's is its slope density, so the
 *     profile method does not apply. Tolerance is correspondingly coarser
 *     (TOL_TRANSCRIPTION_EXTENT).
 *   - The R leg predicts the stroke band (dashed/dotted: snapped midline ±
 *     unrounded t/2) or the wavy ink extent (centerline ± (cpDist/(2√3) +
 *     t/2) — the analytic form of Skia's stroke bounding rect of the cubic
 *     centerline, which `ComputeWavyPatternRect` floor/ceils into the
 *     pattern band).
 *   - The segment compare runs for EVERY patterned case, not just skip-ink
 *     text: each painted dash / dot is a segment on both sides, so dash
 *     layout — and, across skip-ink gaps, dash-phase continuity (Blink
 *     computes the pattern once over the whole run and clips; a per-segment
 *     re-fit shifts every dash edge after the first gap) — is graded
 *     directly against Chrome's paint. The S side expands the emitted
 *     `stroke-dasharray` analytically and intersects it with the emitted
 *     `<clipPath>` rects; the wavy S side reports the clip rects' intervals.
 *
 * Blind spots — what this oracle CANNOT see (kept honest on purpose):
 *   - spelling / grammar error lines are not graded.
 *   - the wavy PATTERN-RECT band (the floor/ceil'd stroke bounds that gate
 *     the skip-ink intercepts and crop the tile) is only observable through
 *     skip-ink gap edges, which depend on it weakly; its floor/ceil snap is
 *     pinned by unit tests on `emitDecorationLine` instead.
 *   - `from-font` cases feed the R leg from fontkit's post-table values,
 *     not from CoreText's answer — a face where the two disagree mis-grades
 *     the transcription leg for that case (reported per-case, so it is
 *     visible, but the disagreement is attributed to the wrong side).
 *   - skip-ink discrimination floor: the C-vs-S gap tolerance (0.9px) cannot
 *     see a pad error smaller than that; at auto thickness this means
 *     fonts <= ~18px cannot discriminate a halved pad on their own. The
 *     explicit-thickness cases (5px/8px) exist precisely to discriminate
 *     hard (2.5px+ per edge).
 *   - CJK / vertical writing modes, decorating-box propagation
 *     (decoration inherited from an ancestor), and multi-fragment
 *     (wrapped) runs are out of scope; every case here is a single
 *     fragment decorated on its own span.
 *   - platform: rules are platform-generic but validated against macOS
 *     paint; Linux/Windows metrics flow through the same formulas yet have
 *     not been measured by this tool.
 *
 * Usage:
 *   npx tsx tools/decoration-oracle.ts [--only <substr>] [--json <path>]
 *       [--no-gate-svg-geometry] [--no-gate-skip-ink] [--keep <dir>]
 *
 * Exit codes: 0 all armed gates pass; 1 an armed gate failed; 2 setup error.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureElementTree, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { resolveFont, setRenderTextMode } from "../src/render/font-resolution.js";

// ── Tolerances ──────────────────────────────────────────────────────────
/** C vs R: bar top / height, CSS px. Measurement noise at dsf 4 is ~0.06px
 *  and painted bars are y-snapped to integers, so 0.2 is generous. */
const TOL_TRANSCRIPTION = 0.2;
/** C vs R for the EXTENT-measured styles (dashed / dotted / wavy): the
 *  painted-ink extent is recovered by a 50%-coverage threshold on device
 *  rows, which quantizes each edge to 1/dsf CSS px (±0.25 worst case per
 *  edge, so ±0.5 on a height combining both). Coarser than the solid bars'
 *  coverage-weighted centroid, still far below the ~1px scale of any real
 *  rule error (a wrong snap, a rounded-vs-unrounded stroke width). */
const TOL_TRANSCRIPTION_EXTENT = 0.55;
/** R vs S: emitted coordinates are exact reals (rounded to 2 decimals in
 *  markup), so 0.3 covers serialization rounding only. */
const TOL_SVG_GEOMETRY = 0.3;
/** C vs S skip-ink gap edges, CSS px. Covers fontkit-vs-Skia outline
 *  intersection drift (the band-depth offset the renderer's former empirical
 *  constants added is gone since the decoration-geometry transcription).
 *  A halved dilation moves an edge by t/2 — 1.2px at 24px auto, 2.5px at
 *  explicit 5px — which this must catch. */
const TOL_GAP_EDGE = 0.9;
/** Painted segments narrower than this (CSS px) are ignored on both sides —
 *  Blink itself discards intercepts shallower than 0.5px via the band inset,
 *  and sub-pixel slivers are AA noise at the measurement side. */
const MIN_SEGMENT_WIDTH = 1.0;

const PAGE_WIDTH = 900;
const CASES_PER_CHUNK = 6;
const DSF = 4;

// ── Case grid ───────────────────────────────────────────────────────────
interface CaseSpec {
  id: string;
  family: string;
  fontSize: number;
  /** `text-decoration-line` value. */
  lines: string;
  style: "solid" | "double" | "dashed" | "dotted" | "wavy";
  thickness?: string;
  underlineOffset?: string;
  underlinePosition?: string;
  /** Real-text skip-ink case (skip-ink: auto). Geometry cases use
   *  descender-free text with skip-ink: none. */
  skipInk?: boolean;
  /** skip-ink:none control — must measure ZERO gaps. */
  expectNoGaps?: boolean;
  text?: string;
}

function buildCases(): CaseSpec[] {
  const cases: CaseSpec[] = [];
  const push = (c: Omit<CaseSpec, "id">) => {
    const bits = [
      c.family.toLowerCase().replace(/[^a-z0-9]+/g, ""),
      String(c.fontSize).replace(".", "_"),
      c.lines.replace(/ /g, "+"),
      c.style,
      c.thickness != null ? `t=${c.thickness}` : null,
      c.underlineOffset != null ? `o=${c.underlineOffset}` : null,
      c.underlinePosition != null ? `p=${c.underlinePosition}` : null,
      c.skipInk ? "skipink" : null,
      c.expectNoGaps ? "noskipink-ctrl" : null,
    ].filter((b) => b != null);
    cases.push({ id: bits.join("."), ...c });
  };
  const families = ["Helvetica", "Times", "Menlo"];
  const sizes = [12, 16, 24, 32.5, 48];
  // 1. underline auto/auto across the family x size grid.
  for (const family of families) for (const fontSize of sizes) {
    push({ family, fontSize, lines: "underline", style: "solid" });
  }
  // 2-3. line-through and overline.
  for (const family of families) for (const fontSize of [16, 24, 32.5]) {
    push({ family, fontSize, lines: "line-through", style: "solid" });
    push({ family, fontSize, lines: "overline", style: "solid" });
  }
  // 4. all three lines on one run.
  push({ family: "Helvetica", fontSize: 24, lines: "underline line-through overline", style: "solid" });
  // 5. double.
  push({ family: "Helvetica", fontSize: 16, lines: "underline", style: "double" });
  push({ family: "Helvetica", fontSize: 32.5, lines: "underline", style: "double" });
  push({ family: "Times", fontSize: 24, lines: "underline", style: "double" });
  push({ family: "Helvetica", fontSize: 24, lines: "line-through", style: "double" });
  push({ family: "Helvetica", fontSize: 24, lines: "overline", style: "double" });
  // 6-7. thickness variants (from-font and percentage included).
  for (const thickness of ["from-font", "5px", "10%", "0.2em"]) {
    for (const family of ["Helvetica", "Times"]) for (const fontSize of [16, 32.5]) {
      push({ family, fontSize, lines: "underline", style: "solid", thickness });
    }
  }
  push({ family: "Helvetica", fontSize: 24, lines: "line-through", style: "solid", thickness: "5px" });
  // 8. underline-offset variants.
  for (const underlineOffset of ["4px", "25%", "-2px", "0.15em"]) {
    for (const fontSize of [16, 32.5]) {
      push({ family: "Helvetica", fontSize, lines: "underline", style: "solid", underlineOffset });
    }
  }
  // 9. combined explicit thickness + offset; double with both.
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "solid", thickness: "4px", underlineOffset: "3px" });
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "double", thickness: "3px", underlineOffset: "2px" });
  // 10. text-underline-position: under.
  for (const family of ["Helvetica", "Times"]) for (const fontSize of [16, 32.5]) {
    push({ family, fontSize, lines: "underline", style: "solid", underlinePosition: "under" });
  }
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "solid", underlinePosition: "under", underlineOffset: "4px" });
  // 11. text-underline-position: from-font.
  for (const family of ["Helvetica", "Times"]) for (const fontSize of [16, 32.5]) {
    push({ family, fontSize, lines: "underline", style: "solid", underlinePosition: "from-font" });
  }
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "solid", underlinePosition: "from-font", underlineOffset: "3px" });
  // 12. thickness from-font + position from-font.
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "solid", thickness: "from-font", underlinePosition: "from-font" });
  // Skip-ink cases: real descender text, skip-ink auto.
  for (const fontSize of [16, 24, 32.5]) {
    push({ family: "Helvetica", fontSize, lines: "underline", style: "solid", skipInk: true, text: "jumping gaps" });
  }
  push({ family: "Times", fontSize: 24, lines: "underline", style: "solid", skipInk: true, text: "jumping gaps" });
  push({ family: "Helvetica", fontSize: 32.5, lines: "underline", style: "solid", thickness: "5px", skipInk: true, text: "jumping gaps" });
  push({ family: "Helvetica", fontSize: 48, lines: "underline", style: "solid", thickness: "8px", skipInk: true, text: "gyp jig" });
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "solid", expectNoGaps: true, text: "jumping gaps" });
  // 13. dashed / dotted geometry (no skip-ink): the snapped midline, the
  // unrounded stroke width, and the dash/dot layout — dash positions are
  // graded by the segment compare (every painted dash IS a segment on both
  // the C and S sides).
  for (const style of ["dashed", "dotted"] as const) {
    for (const fontSize of [16, 24, 32.5]) {
      push({ family: "Helvetica", fontSize, lines: "underline", style });
    }
  }
  push({ family: "Times", fontSize: 24, lines: "underline", style: "dashed" });
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "dashed", thickness: "5px" });
  // Thick dotted (rounded thickness > 3): round dots with endpoint insets.
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "dotted", thickness: "5px" });
  // 14. wavy geometry: painted ink extent = centerline ± (cpDist/(2√3) + t/2).
  for (const fontSize of [16, 24, 32.5, 48]) {
    push({ family: "Helvetica", fontSize, lines: "underline", style: "wavy" });
  }
  push({ family: "Times", fontSize: 24, lines: "underline", style: "wavy" });
  push({ family: "Helvetica", fontSize: 24, lines: "underline", style: "wavy", thickness: "4px" });
  // 15. patterned skip-ink: dash-phase continuity across gaps (the dash edges
  // AFTER a gap discriminate a per-segment re-fit from Blink's one-pattern-
  // plus-clip mechanism) and the wavy pattern-rect band's gap edges.
  for (const style of ["dashed", "dotted", "wavy"] as const) {
    push({ family: "Helvetica", fontSize: 24, lines: "underline", style, skipInk: true, text: "jumping gaps" });
    push({ family: "Helvetica", fontSize: 32.5, lines: "underline", style, skipInk: true, text: "jumping gaps" });
  }
  push({ family: "Helvetica", fontSize: 32.5, lines: "underline", style: "dashed", thickness: "5px", skipInk: true, text: "jumping gaps" });
  return cases;
}

// ── Sample HTML ─────────────────────────────────────────────────────────
const GEOMETRY_TEXT = "nommix unread"; // descender-free, ink never meets the bar

function caseHtml(c: CaseSpec, idx: number): string {
  const skip = c.skipInk ? "auto" : "none";
  const text = (c.text ?? GEOMETRY_TEXT).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const decl = [
    `font-family: ${c.family}`,
    `font-size: ${c.fontSize}px`,
    "color: #000",
    `text-decoration-line: ${c.lines}`,
    `text-decoration-style: ${c.style}`,
    "text-decoration-color: #ff0000",
    `text-decoration-skip-ink: ${skip}`,
    c.thickness != null ? `text-decoration-thickness: ${c.thickness}` : null,
    c.underlineOffset != null ? `text-underline-offset: ${c.underlineOffset}` : null,
    c.underlinePosition != null ? `text-underline-position: ${c.underlinePosition}` : null,
    "white-space: pre",
  ].filter((d) => d != null).join("; ");
  // Adjacent case margins COLLAPSE, so the effective separation between two
  // cases is max(marginA, marginB). Keep it comfortably larger than the
  // biggest per-case clip pad (fontSize*1.2 + 8, i.e. 66px at 48px) plus the
  // deepest decoration excursion, or a neighbor's bar bleeds into this
  // case's measurement window as a phantom bar.
  const margin = Math.max(120, Math.round(c.fontSize * 3));
  return `<div class="case" data-idx="${idx}" style="margin: ${margin}px 24px;">`
    + `<span class="t" style="${decl}">${text}</span>`
    + `<span class="bl" style="display:inline-block;width:0;height:0;"></span></div>`;
}

function chunkHtml(chunk: CaseSpec[]): string {
  // The trailing spacer is load-bearing: the last case's bottom margin
  // COLLAPSES out of <body>, so without real trailing content
  // `body.scrollHeight` ends at the last span and every screenshot clip that
  // reaches below it (an `under` underline, a second double bar) is silently
  // truncated — which measured as phantom "wrong thickness" / "missing bar"
  // failures on whichever case happened to be last in its chunk.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>`
    + `<body style="margin:0;background:#fff;">${chunk.map((c, i) => caseHtml(c, i)).join("\n")}`
    + `<div style="height:220px;"></div></body></html>`;
}

// ── In-page measurement (layout + canvas font metrics) ──────────────────
interface PageMeasure {
  rect: { x: number; y: number; w: number; h: number };
  baselineY: number;
  /** canvas measureText fontBoundingBoxAscent == FontMetrics::FloatAscent.
   *  Note FloatAscent is already integer-rounded with platform hacks applied
   *  (`platform/fonts/font_metrics.cc:117` SkScalarRoundToScalar, plus the
   *  macOS +15% ascent hack for Times/Helvetica/Courier at :135-148), so this
   *  carries the exact value every decoration rule consumes. */
  ascF: number;
  descF: number;
  fragments: number;
}

async function measureChunk(page: Page): Promise<PageMeasure[]> {
  return await page.evaluate(() => {
    // See analyzeClip: polyfill tsx/esbuild's `__name` helper for serialized
    // callbacks that contain named arrow constants.
    if (typeof (window as unknown as { __name?: unknown }).__name === "undefined") {
      (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
    }
    const out: PageMeasure[] = [];
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d");
    if (g == null) throw new Error("no 2d context");
    g.textBaseline = "alphabetic";
    for (const div of Array.from(document.querySelectorAll(".case"))) {
      const span = div.querySelector<HTMLElement>(".t");
      const bl = div.querySelector<HTMLElement>(".bl");
      if (span == null || bl == null) throw new Error("case structure");
      const rects = span.getClientRects();
      const r = rects[0];
      const cs = getComputedStyle(span);
      g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = g.measureText("x");
      out.push({
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        baselineY: bl.getBoundingClientRect().bottom,
        ascF: m.fontBoundingBoxAscent,
        descF: m.fontBoundingBoxDescent,
        fragments: rects.length,
      });
    }
    return out;
  });
}

// ── Rule prediction (leg R) ─────────────────────────────────────────────
interface Bar { top: number; height: number; }
interface Prediction {
  bars: Bar[];
  /** Unsnapped resolved thickness (feeds the skip-ink dilation report). */
  thickness: number;
  notes: string[];
}

const LU = (v: number) => Math.round(v * 64) / 64;
const roundHalfAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/**
 * NormalizedTypoDescent in px — `platform/fonts/simple_font_data.cc:360-410`:
 * take OS/2 sTypoAscender/sTypoDescender (font units; descender stored
 * negative, negated on read), normalize the pair so it sums to the em size
 * while keeping the ratio, LayoutUnit-round the ascent, and return
 * em - normalizedAscent. Falls back to FloatAscent/FloatDescent when the
 * typo ascender is missing or non-positive, exactly as Blink does.
 * (Canvas exposes this as `emHeightDescent`, but that TextMetrics member is
 * behind experimental-web-platform-features in the Chromium Playwright
 * ships, so the input comes from the font table via fontkit instead — a
 * documented from-font-style caveat.)
 */
function normalizedTypoDescent(
  fs: number, fk: ReturnType<typeof resolveFont>, ascF: number, descF: number, notes: string[],
): number {
  const tryNorm = (a: number, d: number): number | null => {
    const height = a + d;
    if (height <= 0 || a < 0 || a > height) return null;
    const normAsc = LU((a * fs) / height);
    return LU(fs) - normAsc;
  };
  const os2 = (fk as unknown as { "OS/2"?: { typoAscender?: number; typoDescender?: number } } | null)?.["OS/2"];
  if (os2?.typoAscender != null && os2.typoDescender != null && os2.typoAscender > 0) {
    const ntd = tryNorm(os2.typoAscender, -os2.typoDescender);
    if (ntd != null) return ntd;
  }
  const ntd = tryNorm(ascF, descF);
  if (ntd != null) {
    notes.push("under: OS/2 typo metrics unavailable — normalized from FloatAscent/FloatDescent");
    return ntd;
  }
  notes.push("under: no usable metrics — NTD=0");
  return 0;
}

/** CSS length value in px (em resolved against fs); null for keywords. */
function lengthPx(spec: string, fs: number): number | null {
  const m = /^(-?[\d.]+)(px|em|%)$/.exec(spec.trim());
  if (m == null) return null;
  const v = parseFloat(m[1]);
  if (m[2] === "px") return v;
  if (m[2] === "em") return v * fs;
  return (v / 100) * fs; // % of font size for both thickness and offset
}

function predictCase(c: CaseSpec, meas: PageMeasure): Prediction {
  const fs = c.fontSize;
  const ascF = meas.ascF;
  const ascI = Math.round(ascF); // lroundf — ascents are positive
  const notes: string[] = [];

  // from-font metrics via fontkit (post table) — documented blind spot.
  const fk = resolveFont(c.family, 400, fs);
  const upem = fk?.unitsPerEm ?? 1000;
  const fkThickPx = fk != null ? (fk.underlineThickness * fs) / upem : null;
  // Skia fUnderlinePosition is positive below baseline (macOS:
  // -CTFontGetUnderlinePosition, external/skia SkScalerContext_mac_ct.cpp,
  // rev ebf5052); fontkit's post value is negative below baseline.
  const fkPosPx = fk != null ? (-fk.underlinePosition * fs) / upem : null;
  if ((c.thickness === "from-font" || c.underlinePosition === "from-font") && fk == null) {
    notes.push("from-font metrics unavailable (font failed to resolve) — auto fallback used");
  }

  // Thickness — text_decoration_info.cc:65-92, then max(1,t) at :449-451.
  let t: number;
  const thSpec = c.thickness ?? "auto";
  if (thSpec === "auto") t = fs / 10;
  else if (thSpec === "from-font") t = fkThickPx ?? fs / 10;
  else t = roundHalfAway(lengthPx(thSpec, fs) ?? 0);
  t = Math.max(1, t);

  // text-underline-offset in px (auto -> 0) — text_decoration_offset.cc:123-135.
  const offSpec = c.underlineOffset ?? "auto";
  const offIsAuto = offSpec === "auto";
  const extra = offIsAuto ? 0 : (lengthPx(offSpec, fs) ?? 0);

  const bars: Bar[] = [];
  const snap = (top: number) => ({ top: meas.rect.y + Math.floor(top + 0.5), height: Math.max(Math.floor(t), 1) });
  const dblOffFor = (line: string) =>
    line === "underline" ? t + 1 : line === "overline" ? -(t + 1) : Math.floor(t + 1);
  const emit = (topRel: number, line: string) => {
    if (c.style === "dashed" || c.style === "dotted") {
      // GetSnappedPointsForTextLine: midY = floor(top + max(t/2, 0.5)), plus
      // the odd-rounded-thickness half-pixel shift of DrawLineAsStroke; the
      // painted stroke keeps the UNROUNDED width
      // (`decoration_line_painter.cc:47-53,55-76`).
      const yMid = Math.floor(topRel + Math.max(t / 2, 0.5)) + (Math.round(t) % 2 !== 0 ? 0.5 : 0);
      bars.push({ top: meas.rect.y + yMid - t / 2, height: t });
      return;
    }
    if (c.style === "wavy") {
      // Painted ink extent of the wavy ribbon: centerline at
      // top + wavy_offset + 0.5 (`WavyCenterlinePath` default start y=0.5,
      // tile placement in `PaintWavyTextDecoration`), reaching
      // ±(cpDist/(2√3) + t/2) — the cubic with control points ±cpDist has
      // visual amplitude cpDist/(2√3) (extremum of 3s(1−s)(1−2s)), and the
      // stroke extends it by t/2. The wave definition's thickness is clamped
      // ≥ 1 (`MakeWave`); the stroke width is not.
      const tw = Math.max(1, t);
      const cpDist = 0.5 + Math.round(3 * tw + 0.5);
      const amp = cpDist / (2 * Math.sqrt(3));
      const wavyOffset = line === "underline" ? t + 1 : line === "overline" ? -(t + 1) : 0;
      bars.push({ top: meas.rect.y + topRel + wavyOffset + 0.5 - (amp + t / 2), height: 2 * amp + t });
      return;
    }
    bars.push(snap(topRel));
    if (c.style === "double") bars.push(snap(topRel + dblOffFor(line)));
  };

  for (const line of c.lines.split(/\s+/)) {
    if (line === "underline") {
      const pos = c.underlinePosition ?? "auto";
      if (pos === "under") {
        // ComputeUnderlineOffsetForUnder, BottomOfEmHeight:
        // floor(LU(ascF - (-NTD)) + LU(extra)) + 1
        const ntd = normalizedTypoDescent(fs, fk, ascF, meas.descF, notes);
        emit(Math.floor(LU(ascF + ntd) + LU(extra)) + 1, line);
      } else if (pos === "from-font" && fkPosPx != null) {
        emit(roundHalfAway(ascF + fkPosPx + extra), line);
      } else {
        // auto (also from-font fallback when the metric is absent):
        const gap = offIsAuto ? Math.max(1, Math.ceil(t / 2)) : 0;
        emit(Math.trunc(ascI + gap + roundHalfAway(extra)), line);
      }
    } else if (line === "overline") {
      emit(Math.floor(LU(ascF - ascI)) - Math.floor(t), line);
    } else if (line === "line-through") {
      emit((2 * ascF) / 3 - t / 2, line);
    }
  }
  bars.sort((a, b) => a.top - b.top);
  return { bars, thickness: t, notes };
}

// ── Chrome paint measurement (leg C) ────────────────────────────────────
interface MeasuredBar extends Bar { x0: number; x1: number; segments: Array<[number, number]>; }

/** Decode a case's dsf-4 clip screenshot in a scratch page and recover red
 *  decoration bars by coverage-weighted row profiles, plus per-bar gap
 *  intervals from column profiles over the bar's core rows. */
async function analyzeClip(
  analysisPage: Page, pngBase64: string, clip: { x: number; y: number }, dsf: number,
  mode: "profile" | "extent" = "profile",
): Promise<MeasuredBar[]> {
  return await analysisPage.evaluate(async ({ b64, clip, dsf, mode }) => {
    // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
    // stack traces; that helper isn't in page.evaluate's serialized scope, so
    // polyfill it before the named consts below construct.
    if (typeof (window as unknown as { __name?: unknown }).__name === "undefined") {
      (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
    }
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (g == null) throw new Error("no 2d context");
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, img.width, img.height);
    const W = img.width, H = img.height;
    // Red coverage: pure-red decoration over white gives R=255, G=B=255(1-a);
    // black ink gives R~G~B. redness = (R - max(G,B))/255 recovers a in both
    // "red over white" and "red over black" (line-through paints over ink).
    const redAt = (x: number, y: number) => {
      const i = (y * W + x) * 4;
      return Math.max(0, (data[i] - Math.max(data[i + 1], data[i + 2])) / 255);
    };
    if (mode === "extent") {
      // Patterned styles (dashed / dotted / wavy): the coverage-weighted row
      // profile is meaningless (a round dot's row mass is a chord length, a
      // wave's is its slope density), so measure the PAINTED-INK EXTENT
      // instead — the rows and columns where red coverage crosses 50% — and
      // recover segments from any-red column runs separated by white.
      const redRow = new Array<boolean>(H).fill(false);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (redAt(x, y) > 0.5) { redRow[y] = true; break; }
      }
      let minY = -1, maxY = -1;
      for (let y = 0; y < H; y++) if (redRow[y]) { if (minY < 0) minY = y; maxY = y; }
      if (minY < 0) return [];
      // Column classification runs over the CORE rows (one device row trimmed
      // from each extent edge): when the rounded-thickness clip band sits
      // fractionally inside an odd-shifted unrounded stroke (e.g. t=3.25 →
      // band 3 at the snapped midline, stroke bottom 0.125px below the
      // outset clip rect), Chrome leaks a sub-device-pixel SLIVER of every
      // dash through the skip-ink gap — a half-coverage hairline at dsf 4
      // that flips the 50% threshold nondeterministically. Domotion's clip
      // rects cover the full stroke on purpose (the sliver is below AA
      // resolution at 1×), so the measurement ignores the edge rows on the
      // Chrome side rather than comparing noise.
      const coreY0 = maxY - minY >= 3 ? minY + 1 : minY;
      const coreY1 = maxY - minY >= 3 ? maxY - 1 : maxY;
      const colRed = new Array<boolean>(W).fill(false);
      const colWhite = new Array<number>(W).fill(0);
      for (let x = 0; x < W; x++) {
        let whites = 0;
        for (let y = coreY0; y <= coreY1; y++) {
          if (redAt(x, y) > 0.5) colRed[x] = true;
          const i = (y * W + x) * 4;
          const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (luma > 180 && data[i] - Math.max(data[i + 1], data[i + 2]) < 40) whites++;
        }
        colWhite[x] = whites / (coreY1 - coreY0 + 1);
      }
      const segments: Array<[number, number]> = [];
      let firstRed = -1, lastRed = -1;
      let x0 = -1, x1 = -1;
      for (let x = 0; x <= W; x++) {
        const isWhite = x === W || (!colRed[x] && colWhite[x] > 0.6);
        if (isWhite) {
          if (firstRed >= 0) segments.push([firstRed, lastRed + 1]);
          firstRed = -1; lastRed = -1;
        } else if (colRed[x]) {
          if (firstRed < 0) firstRed = x;
          lastRed = x;
          if (x0 < 0) x0 = x;
          x1 = x;
        }
      }
      const toCss = (v: number) => v / dsf;
      return [{
        top: clip.y + toCss(minY),
        height: toCss(maxY + 1 - minY),
        x0: clip.x + toCss(x0), x1: clip.x + toCss(x1 + 1),
        segments: segments.map(([a, b]) => [clip.x + toCss(a), clip.x + toCss(b)] as [number, number]),
      }];
    }
    // Row profile.
    const rowMass = new Array<number>(H).fill(0);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) s += redAt(x, y); rowMass[y] = s; }
    const maxMass = Math.max(...rowMass);
    if (maxMass < 4) return [];
    // Group contiguous rows above threshold into bars.
    const groups: Array<{ y0: number; y1: number }> = [];
    let start = -1;
    for (let y = 0; y < H; y++) {
      const on = rowMass[y] > maxMass * 0.35;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { groups.push({ y0: start, y1: y - 1 }); start = -1; }
    }
    if (start >= 0) groups.push({ y0: start, y1: H - 1 });
    const bars: Array<{ top: number; height: number; x0: number; x1: number; segments: Array<[number, number]> }> = [];
    for (const grp of groups) {
      // Band-local ink map: a column is "inky" if any pixel NEAR THE BAND is
      // dark and not red (glyph ink). Text paints OVER the underline, so
      // where the bar crosses glyph ink (e.g. a negative
      // text-underline-offset lifting the bar into the baseline region) the
      // red coverage is eaten and a raw row profile under-measures the bar.
      // Bar geometry is therefore refined over band-locally ink-free columns.
      // (Whole-column ink would disqualify every glyph column — x-height ink
      // always sits above a normal underline.)
      const inkY0 = Math.max(0, grp.y0 - 8), inkY1 = Math.min(H - 1, grp.y1 + 8);
      const colInky = new Array<boolean>(W).fill(false);
      for (let x = 0; x < W; x++) {
        for (let y = inkY0; y <= inkY1; y++) {
          const i = (y * W + x) * 4;
          const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (luma < 150 && data[i] - Math.max(data[i + 1], data[i + 2]) < 60) { colInky[x] = true; break; }
        }
      }
      // Coverage-weighted geometry over the group +/-1 row, restricted to
      // ink-free columns that carry the bar in the group's peak row (so
      // skip-ink gap columns don't dilute the profile either). Normalize each
      // row by the restricted peak: interior rows have full coverage, edge
      // rows carry the fractional overlap.
      let peakY = grp.y0;
      for (let y = grp.y0; y <= grp.y1; y++) if (rowMass[y] > rowMass[peakY]) peakY = y;
      const profileCols: number[] = [];
      for (let x = 0; x < W; x++) if (!colInky[x] && redAt(x, peakY) > 0.5) profileCols.push(x);
      const rowMassAt = (y: number) => {
        let s = 0; for (const x of profileCols) s += redAt(x, y);
        return s;
      };
      const useRestricted = profileCols.length >= 8;
      let peak = 0;
      for (let y = grp.y0; y <= grp.y1; y++) peak = Math.max(peak, useRestricted ? rowMassAt(y) : rowMass[y]);
      let mass = 0, centroid = 0;
      for (let y = Math.max(0, grp.y0 - 1); y <= Math.min(H - 1, grp.y1 + 1); y++) {
        const cov = (useRestricted ? rowMassAt(y) : rowMass[y]) / peak;
        mass += cov; centroid += (y + 0.5) * cov;
      }
      const center = centroid / mass;
      // Bar x-extent + gaps from column profile over core rows.
      const coreRows: number[] = [];
      for (let y = grp.y0; y <= grp.y1; y++) if (rowMass[y] > peak * 0.8) coreRows.push(y);
      const colRed = new Array<number>(W).fill(0);
      for (let x = 0; x < W; x++) {
        let s = 0; for (const y of coreRows) s += redAt(x, y);
        colRed[x] = coreRows.length > 0 ? s / coreRows.length : 0;
      }
      // Painted-SEGMENT extraction. "Gap intervals" break down in the
      // heavy-dilation regime (an 8px-thick underline under descender text
      // survives only as slivers), so the well-posed representation is the
      // positive space: what got painted. Column classes over the core rows:
      //   RED    the bar is painted here
      //   WHITE  background — the only class that SEPARATES segments (a real
      //          clip gap always carries a white dilation margin)
      //   INK    glyph ink — text paints OVER the underline, so ink joins
      //          whatever segment it interrupts (a skip-ink:none bar crossed
      //          by a descender is ONE continuous segment)
      // Segment edges are taken from the first/last RED column of a run, so
      // adjacent ink never smears an edge.
      const whiteAt = (x: number, y: number) => {
        const i = (y * W + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        return luma > 180 && data[i] - Math.max(data[i + 1], data[i + 2]) < 40 ? 1 : 0;
      };
      const colWhite = new Array<number>(W).fill(0);
      for (let x = 0; x < W; x++) {
        let s = 0; for (const y of coreRows) s += whiteAt(x, y);
        colWhite[x] = coreRows.length > 0 ? s / coreRows.length : 0;
      }
      let x0 = -1, x1 = -1;
      for (let x = 0; x < W; x++) if (colRed[x] > 0.6) { if (x0 < 0) x0 = x; x1 = x; }
      const segments: Array<[number, number]> = [];
      {
        let firstRed = -1, lastRed = -1;
        for (let x = 0; x <= W; x++) {
          const isWhite = x === W || (colRed[x] < 0.25 && colWhite[x] > 0.6);
          if (isWhite) {
            if (firstRed >= 0) segments.push([firstRed, lastRed + 1]);
            firstRed = -1; lastRed = -1;
          } else if (colRed[x] >= 0.25) {
            if (firstRed < 0) firstRed = x;
            lastRed = x;
          }
        }
      }
      const toCss = (v: number) => v / dsf;
      bars.push({
        top: clip.y + toCss(center - mass / 2),
        height: toCss(mass),
        x0: clip.x + toCss(x0), x1: clip.x + toCss(x1 + 1),
        segments: segments.map(([a, b]) => [clip.x + toCss(a), clip.x + toCss(b)] as [number, number]),
      });
    }
    bars.sort((a, b) => a.top - b.top);
    return bars;
  }, { b64: pngBase64, clip, dsf, mode });
}

// ── Domotion SVG parse (leg S) ──────────────────────────────────────────
interface SvgBar extends Bar { x0: number; x1: number; segments: Array<{ x0: number; x1: number }>; }

interface ParsedDecoLine {
  /** Kind: a horizontal `<line>` (solid / dashed / dotted) or a wavy `<path>`. */
  kind: "line" | "wavy";
  /** Centerline y (line y1 / wavy path start y), transforms applied. */
  y: number;
  /** stroke-width. */
  w: number;
  x0: number;
  x1: number;
  /** Parsed stroke-dasharray intervals (patterned lines only). */
  dash?: number[];
  /** stroke-linecap="round" (thick dotted round dots). */
  roundCaps?: boolean;
  /** clip-path id referenced by the element or an ancestor `<g>`. */
  clipId?: string;
  /** Wavy: the cubic's control-point distance, recovered from the first
   *  `C` control point (validates the emitted wave geometry, not a re-run
   *  of the renderer's own formula). */
  cpDist?: number;
}

interface ParsedSvgDecorations {
  lines: ParsedDecoLine[];
  /** clipPath id → clip rects (transforms applied). */
  clips: Map<string, Array<{ x0: number; x1: number; y0: number; y1: number }>>;
}

/** Parse red decoration `<line>`s / wavy `<path>`s and their `<clipPath>`s
 *  out of the emitted markup, accumulating ancestor translate() transforms
 *  and group-level clip-path references. Analytic by design. */
function parseSvgDecorations(svg: string): ParsedSvgDecorations {
  const lines: ParsedDecoLine[] = [];
  const clips = new Map<string, Array<{ x0: number; x1: number; y0: number; y1: number }>>();
  const tagRe = /<(g|line|clipPath|rect|path)\b([^>]*?)\/?>|<\/(?:g|clipPath)>/g;
  const stack: Array<{ tx: number; ty: number; clipId?: string }> = [{ tx: 0, ty: 0 }];
  let openClipId: string | null = null;
  const attr = (attrs: string, name: string): string | null => {
    const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return m != null ? m[1] : null;
  };
  const clipIdOf = (attrs: string): string | undefined => {
    const cp = attr(attrs, "clip-path");
    const m = cp != null ? /url\(#([^)]+)\)/.exec(cp) : null;
    return m != null ? m[1] : undefined;
  };
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) != null) {
    if (m[0] === "</g>") { if (stack.length > 1) stack.pop(); continue; }
    if (m[0] === "</clipPath>") { openClipId = null; continue; }
    const [, tag, attrs] = m;
    const cur = stack[stack.length - 1];
    if (tag === "g") {
      let { tx, ty } = cur;
      const tf = attr(attrs, "transform");
      if (tf != null) {
        const tr = /translate\(\s*(-?[\d.eE+]+)[ ,]*(-?[\d.eE+]+)?\s*\)/.exec(tf);
        if (tr != null) { tx += parseFloat(tr[1]); ty += parseFloat(tr[2] ?? "0"); }
      }
      // Self-closing <g/> never happens in our output; assume it opens scope.
      stack.push({ tx, ty, clipId: clipIdOf(attrs) ?? cur.clipId });
      continue;
    }
    if (tag === "clipPath") {
      const id = attr(attrs, "id");
      if (id != null) { openClipId = id; clips.set(id, clips.get(id) ?? []); }
      continue;
    }
    if (tag === "rect") {
      if (openClipId == null) continue;
      const x = parseFloat(attr(attrs, "x") ?? "NaN");
      const y = parseFloat(attr(attrs, "y") ?? "NaN");
      const w = parseFloat(attr(attrs, "width") ?? "NaN");
      const h = parseFloat(attr(attrs, "height") ?? "NaN");
      if ([x, y, w, h].every(Number.isFinite)) {
        clips.get(openClipId)!.push({ x0: cur.tx + x, x1: cur.tx + x + w, y0: cur.ty + y, y1: cur.ty + y + h });
      }
      continue;
    }
    const stroke = (attr(attrs, "stroke") ?? "").replace(/\s+/g, "").toLowerCase();
    const isRed = stroke === "#ff0000" || stroke === "#f00" || stroke === "rgb(255,0,0)" || stroke === "red";
    if (!isRed) continue;
    const w = parseFloat(attr(attrs, "stroke-width") ?? "1");
    const clipId = clipIdOf(attrs) ?? cur.clipId;
    if (tag === "path") {
      // Wavy: `M x0 y C cx1 cy1 cx2 cy2 x y …` — centerline at the start y,
      // control-point distance from the first control point.
      const d = attr(attrs, "d") ?? "";
      const dm = /M (-?[\d.]+) (-?[\d.]+) C (-?[\d.]+) (-?[\d.]+)/.exec(d);
      if (dm == null) continue;
      const xs = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((p) => parseFloat(p[1]));
      lines.push({
        kind: "wavy", y: cur.ty + parseFloat(dm[2]), w,
        x0: cur.tx + Math.min(...xs), x1: cur.tx + Math.max(...xs),
        cpDist: parseFloat(dm[4]) - parseFloat(dm[2]),
        clipId,
      });
      continue;
    }
    // <line>
    const y1 = parseFloat(attr(attrs, "y1") ?? "NaN");
    const y2 = parseFloat(attr(attrs, "y2") ?? "NaN");
    if (!Number.isFinite(y1) || Math.abs(y1 - y2) > 1e-6) continue;
    const x1 = parseFloat(attr(attrs, "x1") ?? "NaN");
    const x2 = parseFloat(attr(attrs, "x2") ?? "NaN");
    const dashStr = attr(attrs, "stroke-dasharray");
    lines.push({
      kind: "line", y: cur.ty + y1, w,
      x0: cur.tx + Math.min(x1, x2), x1: cur.tx + Math.max(x1, x2),
      dash: dashStr != null ? dashStr.trim().split(/[\s,]+/).map(Number) : undefined,
      roundCaps: attr(attrs, "stroke-linecap") === "round" ? true : undefined,
      clipId,
    });
  }
  return { lines, clips };
}

/** Expand a dashed/dotted line's painted segments analytically: walk the
 *  dasharray from the line's start (SVG dash phase 0), painting each dash —
 *  or, for zero-length round-cap dashes, a dot of diameter stroke-width
 *  centered on the pattern point — then keep the parts inside the clip
 *  rects' x-intervals. */
function expandDashSegments(l: ParsedDecoLine, clipXs: Array<{ x0: number; x1: number }> | null): Array<{ x0: number; x1: number }> {
  let painted: Array<{ x0: number; x1: number }>;
  if (l.dash == null || l.dash.length < 2 || l.dash.every((v) => !Number.isFinite(v))) {
    painted = [{ x0: l.x0, x1: l.x1 }];
  } else {
    painted = [];
    const period = l.dash.reduce((a, b) => a + b, 0);
    if (period <= 0) return [{ x0: l.x0, x1: l.x1 }];
    for (let x = l.x0; x <= l.x1 + 1e-6; x += period) {
      let cursor = x;
      for (let i = 0; i < l.dash.length; i += 2) {
        const dashLen = l.dash[i];
        if (dashLen === 0 && l.roundCaps) {
          // Zero-length dash with round caps = a dot of diameter w.
          painted.push({ x0: cursor - l.w / 2, x1: cursor + l.w / 2 });
        } else if (dashLen > 0) {
          painted.push({ x0: cursor, x1: Math.min(cursor + dashLen, l.x1) });
        }
        cursor += dashLen + (l.dash[i + 1] ?? 0);
      }
    }
    painted = painted.filter((s) => s.x0 < l.x1 && s.x1 - s.x0 > 0);
  }
  if (clipXs == null || clipXs.length === 0) return painted;
  const out: Array<{ x0: number; x1: number }> = [];
  for (const seg of painted) {
    for (const c of clipXs) {
      const a = Math.max(seg.x0, c.x0), b = Math.min(seg.x1, c.x1);
      if (b > a) out.push({ x0: a, x1: b });
    }
  }
  out.sort((a, b) => a.x0 - b.x0);
  return out;
}

/** Group parsed elements into bars with painted segments. Plain lines group
 *  by (y, stroke-width) — skip-ink sub-segment `<line>`s become one bar —
 *  while a dashed/dotted line expands its dash pattern (∩ clip) and a wavy
 *  path reports its painted-ink extent (centerline ± (cpDist/(2√3) + w/2))
 *  with the clip rects' x-intervals as segments. */
function svgBarsInWindow(
  parsed: ParsedSvgDecorations,
  win: { top: number; bottom: number },
): SvgBar[] {
  const inWin = parsed.lines.filter((l) => l.y >= win.top && l.y <= win.bottom);
  const clipXsOf = (l: ParsedDecoLine) => {
    const rects = l.clipId != null ? parsed.clips.get(l.clipId) : undefined;
    return rects != null ? rects.map((c) => ({ x0: c.x0, x1: c.x1 })) : null;
  };
  const bars: SvgBar[] = [];
  const plain = new Map<string, ParsedDecoLine[]>();
  for (const l of inWin) {
    if (l.kind === "wavy") {
      const amp = (l.cpDist ?? 0) / (2 * Math.sqrt(3));
      const clipXs = clipXsOf(l);
      bars.push({
        top: l.y - (amp + l.w / 2), height: 2 * amp + l.w,
        x0: clipXs != null && clipXs.length > 0 ? Math.min(...clipXs.map((c) => c.x0)) : l.x0,
        x1: clipXs != null && clipXs.length > 0 ? Math.max(...clipXs.map((c) => c.x1)) : l.x1,
        segments: clipXs ?? [{ x0: l.x0, x1: l.x1 }],
      });
      continue;
    }
    if (l.dash != null) {
      const segs = expandDashSegments(l, clipXsOf(l));
      bars.push({
        top: l.y - l.w / 2, height: l.w,
        x0: segs.length > 0 ? segs[0].x0 : l.x0,
        x1: segs.length > 0 ? segs[segs.length - 1].x1 : l.x1,
        segments: segs,
      });
      continue;
    }
    const key = `${l.y.toFixed(3)}|${l.w.toFixed(3)}`;
    const arr = plain.get(key) ?? [];
    arr.push(l); plain.set(key, arr);
  }
  for (const segs of plain.values()) {
    segs.sort((a, b) => a.x0 - b.x0);
    const { y, w } = segs[0];
    bars.push({
      top: y - w / 2, height: w,
      x0: segs[0].x0, x1: segs[segs.length - 1].x1,
      segments: segs.map((s) => ({ x0: s.x0, x1: s.x1 })),
    });
  }
  bars.sort((a, b) => a.top - b.top);
  return bars;
}


// ── Comparison ──────────────────────────────────────────────────────────
interface LegResult { ok: boolean; detail: string[]; }

function compareBars(a: Bar[], b: Bar[], tol: number, aName: string, bName: string): LegResult {
  const detail: string[] = [];
  let ok = true;
  if (a.length !== b.length) {
    return { ok: false, detail: [`bar count: ${aName}=${a.length} ${bName}=${b.length}`] };
  }
  for (let i = 0; i < a.length; i++) {
    const dTop = b[i].top - a[i].top;
    const dH = b[i].height - a[i].height;
    const line = `bar${i}: ${aName} top=${a[i].top.toFixed(3)} h=${a[i].height.toFixed(3)}  ${bName} top=${b[i].top.toFixed(3)} h=${b[i].height.toFixed(3)}  dTop=${dTop.toFixed(3)} dH=${dH.toFixed(3)}`;
    if (Math.abs(dTop) > tol || Math.abs(dH) > tol) { ok = false; detail.push(`FAIL ${line}`); }
    else detail.push(`ok   ${line}`);
  }
  return { ok, detail };
}

/** A one-sided segment narrower than this is forgiven rather than failed:
 *  a clip edge landing inside a dash produces a fragment whose width tracks
 *  the edge position, so a sub-tolerance edge drift (< TOL_GAP_EDGE) can
 *  push a fragment across the MIN_SEGMENT_WIDTH filter on one side only.
 *  Anything wider is a real segment one side is missing — a swallowed gap,
 *  a dropped dash — and fails. */
const SLIVER_FORGIVENESS = MIN_SEGMENT_WIDTH + TOL_GAP_EDGE;

/** Compare the two sides' PAINTED SEGMENT lists (positive space) per edge,
 *  matching segments by OVERLAP rather than index so a forgivable one-sided
 *  sliver doesn't misalign every later pair. */
function compareSegments(cSegs: Array<[number, number]>, sSegs: Array<[number, number]>): LegResult {
  const wide = (g: [number, number]) => g[1] - g[0] >= MIN_SEGMENT_WIDTH;
  const cw = cSegs.filter(wide), sw = sSegs.filter(wide);
  const detail: string[] = [];
  let ok = true;
  let i = 0, j = 0, pair = 0;
  while (i < cw.length || j < sw.length) {
    const c = i < cw.length ? cw[i] : null;
    const s = j < sw.length ? sw[j] : null;
    if (c != null && s != null && Math.min(c[1], s[1]) - Math.max(c[0], s[0]) > 0) {
      const dL = s[0] - c[0];
      const dR = s[1] - c[1];
      const line = `seg${pair++}: chrome=[${c[0].toFixed(2)}, ${c[1].toFixed(2)}] svg=[${s[0].toFixed(2)}, ${s[1].toFixed(2)}] dL=${dL.toFixed(2)} dR=${dR.toFixed(2)}`;
      if (Math.abs(dL) > TOL_GAP_EDGE || Math.abs(dR) > TOL_GAP_EDGE) { ok = false; detail.push(`FAIL ${line}`); }
      else detail.push(`ok   ${line}`);
      i++; j++;
      continue;
    }
    // Non-overlapping: consume whichever side comes first as a one-sided
    // segment; forgive it only at sliver width.
    const cFirst = s == null || (c != null && c[1] <= s[0]);
    const seg = cFirst ? c! : s!;
    const side = cFirst ? "chrome-only" : "svg-only";
    const width = seg[1] - seg[0];
    const line = `${side} segment [${seg[0].toFixed(2)}, ${seg[1].toFixed(2)}] (${width.toFixed(2)}px)`;
    if (width <= SLIVER_FORGIVENESS) detail.push(`ok   ${line} — forgiven as a filter-boundary sliver`);
    else { ok = false; detail.push(`FAIL ${line}`); }
    if (cFirst) i++; else j++;
  }
  return { ok, detail };
}

// ── Main ────────────────────────────────────────────────────────────────
interface CaseResult {
  id: string;
  transcription: LegResult;
  svgGeometry: LegResult;
  skipInk: LegResult | null;
  notes: string[];
  data: {
    predicted: Bar[];
    chrome: MeasuredBar[];
    svg: SvgBar[];
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const opt = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const only = opt("--only");
  const jsonPath = opt("--json");
  const keepDir = opt("--keep");
  // Default-armed since the decoration-geometry transcription landed
  // (`--gate-svg-geometry` still accepted as a no-op for older invocations).
  const gateSvgGeometry = !flag("--no-gate-svg-geometry");
  const gateSkipInk = !flag("--no-gate-skip-ink");
  if (keepDir != null) mkdirSync(keepDir, { recursive: true });

  let cases = buildCases();
  if (only != null) cases = cases.filter((c) => c.id.includes(only));
  if (cases.length === 0) { console.error(`no cases match --only ${only}`); return 2; }

  const t0 = Date.now();
  let browser: Browser | null = null;
  const results: CaseResult[] = [];
  try {
    browser = await chromium.launch();
    const ctxHi = await browser.newContext({ viewport: { width: PAGE_WIDTH, height: 800 }, deviceScaleFactor: DSF });
    const pageHi = await ctxHi.newPage();
    const ctxLo = await browser.newContext({ viewport: { width: PAGE_WIDTH, height: 800 } });
    const pageLo = await ctxLo.newPage();
    const analysisPage = await ctxLo.newPage();
    setRenderTextMode("paths");

    for (let base = 0; base < cases.length; base += CASES_PER_CHUNK) {
      const chunk = cases.slice(base, base + CASES_PER_CHUNK);
      const html = chunkHtml(chunk);

      // Leg C setup: layout + font-metric inputs, then per-case clips.
      await pageHi.setContent(html, { waitUntil: "load" });
      // Bottom slack matters: a non-fullPage screenshot clip is intersected
      // with the viewport, so the last case's below-baseline clip window is
      // silently truncated (losing its underline) unless the viewport extends
      // past the deepest possible clip bottom.
      const docHeight = await pageHi.evaluate(() => document.body.scrollHeight + 120);
      await pageHi.setViewportSize({ width: PAGE_WIDTH, height: Math.min(Math.max(docHeight, 400), 6000) });
      const measures = await measureChunk(pageHi);

      // Leg S: capture + render the same chunk at 1x, once.
      await pageLo.setViewportSize({ width: PAGE_WIDTH, height: Math.min(Math.max(docHeight, 400), 6000) });
      await pageLo.setContent(html, { waitUntil: "load" });
      const tree = await captureElementTree(pageLo, "body", { x: 0, y: 0, width: PAGE_WIDTH, height: docHeight });
      const svg = elementTreeToSvgInner(tree, PAGE_WIDTH, docHeight);
      const svgLines = parseSvgDecorations(svg);
      if (keepDir != null) writeFileSync(join(keepDir, `chunk-${base}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_WIDTH} ${docHeight}">${svg}</svg>`);

      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        const meas = measures[i];
        const pad = Math.ceil(c.fontSize * 1.2) + 8;
        const clip = {
          x: Math.max(0, Math.floor(meas.rect.x) - 8),
          y: Math.max(0, Math.floor(meas.rect.y) - pad),
          width: Math.ceil(meas.rect.w) + 16,
          height: Math.ceil(meas.rect.h) + 2 * pad,
        };
        const png = await pageHi.screenshot({ clip });
        if (keepDir != null) writeFileSync(join(keepDir, `${c.id}.png`), png);
        // Patterned styles measure the painted-ink EXTENT (a dot's or wave's
        // coverage profile is not a bar); solid/double keep the
        // coverage-weighted profile and its tighter tolerance.
        const isExtent = c.style === "dashed" || c.style === "dotted" || c.style === "wavy";
        const chromeBars = await analyzeClip(analysisPage, png.toString("base64"), clip, DSF, isExtent ? "extent" : "profile");
        const pred = predictCase(c, meas);
        const winTop = clip.y, winBottom = clip.y + clip.height;
        const sBars = svgBarsInWindow(svgLines, { top: winTop, bottom: winBottom });

        const notes = [...pred.notes];
        if (meas.fragments !== 1) notes.push(`span has ${meas.fragments} fragments (expected 1)`);

        const transcription = compareBars(pred.bars, chromeBars, isExtent ? TOL_TRANSCRIPTION_EXTENT : TOL_TRANSCRIPTION, "rule", "chrome");
        const svgGeometry = compareBars(pred.bars, sBars, TOL_SVG_GEOMETRY, "rule", "svg");
        let skipInk: LegResult | null = null;
        // Patterned styles grade painted segments even without skip-ink text:
        // every dash / dot IS a painted segment, so this leg is what grades
        // dash layout and — via the dash edges after a gap — phase
        // continuity across skip-ink gaps.
        if (c.skipInk || c.expectNoGaps || isExtent) {
          const cSegs = chromeBars.length > 0 ? chromeBars[0].segments : [];
          const sSegs: Array<[number, number]> = sBars.length > 0
            ? sBars[0].segments.map((s) => [s.x0, s.x1] as [number, number])
            : [];
          if (c.expectNoGaps) {
            skipInk = {
              ok: cSegs.length === 1 && sSegs.length === 1,
              detail: [`skip-ink:none control — chrome segments=${cSegs.length} svg segments=${sSegs.length} (both must be exactly 1: an uninterrupted bar)`],
            };
          } else {
            skipInk = compareSegments(cSegs, sSegs);
          }
        }
        results.push({
          id: c.id, transcription, svgGeometry, skipInk, notes,
          data: { predicted: pred.bars, chrome: chromeBars, svg: sBars },
        });
      }
    }
  } catch (err) {
    console.error("decoration-oracle: setup/measurement error:", err);
    return 2;
  } finally {
    await browser?.close();
  }

  // ── Report ──
  const failedTranscription = results.filter((r) => !r.transcription.ok);
  const failedSkipInk = results.filter((r) => r.skipInk != null && !r.skipInk.ok);
  const failedSvgGeometry = results.filter((r) => !r.svgGeometry.ok);
  const printLeg = (title: string, failed: CaseResult[], leg: (r: CaseResult) => LegResult | null) => {
    console.log(`\n── ${title}: ${failed.length} failing ──`);
    for (const r of failed) {
      console.log(`  ${r.id}`);
      for (const line of leg(r)?.detail ?? []) console.log(`    ${line}`);
      for (const n of r.notes) console.log(`    note: ${n}`);
    }
  };
  const skipInkCases = results.filter((r) => r.skipInk != null);
  console.log(`decoration-oracle: ${results.length} cases in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  transcription (chrome vs rule):   ${results.length - failedTranscription.length}/${results.length} pass  [gate: on]`);
  console.log(`  skip-ink gaps (chrome vs svg):    ${skipInkCases.length - failedSkipInk.length}/${skipInkCases.length} pass  [gate: ${gateSkipInk ? "on" : "off"}]`);
  console.log(`  svg geometry (rule vs svg):       ${results.length - failedSvgGeometry.length}/${results.length} pass  [gate: ${gateSvgGeometry ? "on" : "off"}]`);
  if (failedTranscription.length > 0) printLeg("transcription failures (oracle validity — must be zero)", failedTranscription, (r) => r.transcription);
  if (failedSkipInk.length > 0) printLeg("skip-ink gap failures", failedSkipInk, (r) => r.skipInk);
  if (failedSvgGeometry.length > 0 && (gateSvgGeometry || process.env.DOMOTION_ORACLE_VERBOSE === "1")) {
    printLeg("svg-geometry failures", failedSvgGeometry, (r) => r.svgGeometry);
  } else if (failedSvgGeometry.length > 0) {
    console.log(`\n(svg-geometry leg: ${failedSvgGeometry.length} failing cases — gate demoted; drop --no-gate-svg-geometry or set DOMOTION_ORACLE_VERBOSE=1 for detail)`);
  }
  if (jsonPath != null) {
    writeFileSync(jsonPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      tolerances: { transcription: TOL_TRANSCRIPTION, svgGeometry: TOL_SVG_GEOMETRY, gapEdge: TOL_GAP_EDGE, minSegmentWidth: MIN_SEGMENT_WIDTH },
      gates: { transcription: true, skipInk: gateSkipInk, svgGeometry: gateSvgGeometry },
      results,
    }, null, 2));
    console.log(`json report: ${jsonPath}`);
  }

  const gateFailed = failedTranscription.length > 0
    || (gateSkipInk && failedSkipInk.length > 0)
    || (gateSvgGeometry && failedSvgGeometry.length > 0);
  return gateFailed ? 1 : 0;
}

// Pure pieces exported for unit tests; `main` only runs when invoked as a CLI.
export { buildCases, predictCase, parseSvgDecorations, svgBarsInWindow, expandDashSegments, compareSegments, compareBars, LU, roundHalfAway, lengthPx, normalizedTypoDescent };
export type { CaseSpec, PageMeasure, Bar, Prediction, SvgBar, LegResult, ParsedDecoLine, ParsedSvgDecorations };

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
