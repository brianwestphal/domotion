/**
 * Scroll-animated SVG composer (DM-608).
 *
 * Consumes the `ScrollSegmentCapture[]` produced by the scroll executor
 * (DM-607) and emits one self-contained animated SVG: a viewport-sized
 * outer SVG clipping a tall (or wide) inner composite that translates over
 * time per the segment timeline.
 *
 * v1 strategy: stack each capture's rendered content at its scroll-position
 * offset inside the composite; emit linear `translateY` (or `translateX`)
 * keyframes anchored at each segment's `(segmentStartMs, scrollY)`. This is
 * the natural generalisation of the test-harness `buildScrollAnimatedSvg`
 * helper to multiple captures, and it handles layout changes mid-scroll by
 * showing each capture's content at its own slice of the composite y-axis.
 *
 * Per DM-604 feedback ("we'll very likely refine this in the future"), the
 * fancier per-element translate-vs-crossfade-vs-modify-animation merge is
 * deferred. The diff is already computed (`ScrollSegmentCapture.diffFromPrev`)
 * — a future iteration can fold matched-and-translated elements across
 * adjacent captures so they render once with their own translate animation,
 * shrinking output size on mostly-static-content pages.
 */

import type { ScrollSegmentCapture } from "./executor.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { extractFixedSubtrees, dedupeFixedAcrossSegments } from "./hoist-fixed.js";

export interface ScrollComposerOptions {
  /** Visible viewport width (output SVG width). */
  viewportW: number;
  /** Visible viewport height (output SVG height). */
  viewportH: number;
  /** Which axis the scroll moves along. Default `"y"`. */
  axis?: "x" | "y";
  /** Background colour painted behind the captures (visible at seams). */
  bgColor?: string;
  /**
   * hiDPI multiplier passed through to `elementTreeToSvg` when rendering
   * each segment's captured tree. Must match what was passed to
   * `resizeEmbeddedImages` for the same trees, or the renderer falls back
   * to source-resolution data URIs. Default 2 (matches `elementTreeToSvg`).
   */
  hiDPIFactor?: number;
}

const DEFAULT_BG = "#0d1117";

/**
 * Compose a sequence of segment-captures into one animated SVG. The output
 * starts at the first capture's content (segment 0 anchor) and animates
 * through each subsequent segment's anchor at its `segmentStartMs` →
 * `segmentEndMs` time slot.
 */
export function composeScrollSvg(
  segments: ScrollSegmentCapture[],
  opts: ScrollComposerOptions,
): string {
  if (segments.length === 0) {
    throw new Error("composeScrollSvg: at least one segment capture required");
  }
  const axis = opts.axis ?? "y";
  const W = opts.viewportW;
  const VH = opts.viewportH;
  const bg = opts.bgColor ?? DEFAULT_BG;
  const hiDPIFactor = opts.hiDPIFactor ?? 2;

  // ── Total scene duration ──
  // The last segment's endMs is the cycle length. For a single-segment input,
  // the scene is effectively static — emit a 1 s loop so the SVG renders
  // sensibly without a degenerate 0 s animation.
  const totalMs = Math.max(segments[segments.length - 1].segmentEndMs, 1);
  const totalSec = totalMs / 1000;

  // ── Compute composite dimensions ──
  // The composite spans the full scroll range. For axis=y, that's from min
  // scrollY (typically 0) to max scrollY + viewportH (covers the LAST
  // visible portion of the page).
  const positions = segments.map((s) => (axis === "y" ? s.scrollY : s.scrollX));
  const minPos = Math.min(...positions);
  const maxPos = Math.max(...positions);
  const compositeH = axis === "y" ? (maxPos - minPos) + VH : VH;
  const compositeW = axis === "x" ? (maxPos - minPos) + W  : W;

  const animClass = `scrl-${Math.random().toString(36).slice(2, 8)}`;

  // ── Split each capture into "scrolling" + "fixed" subtrees ──
  // DM-643: `position: fixed` elements (site headers, cookie banners, etc.)
  // appear at the same viewport coordinates in every capture. If we leave
  // them inside the per-segment subtrees, the composer offsets each copy by
  // that segment's scrollY and the scrolling composite carries them past the
  // viewport — so the consumer sees the header "scroll" once per segment.
  // Strip the fixed subtrees from every segment and hoist them onto a single
  // viewport-level overlay below.
  const strippedTrees: typeof segments[number]["tree"][] = [];
  const perSegFixed: typeof segments[number]["tree"][] = [];
  for (const seg of segments) {
    const { stripped, fixed } = extractFixedSubtrees(seg.tree);
    strippedTrees.push(stripped);
    perSegFixed.push(fixed);
  }
  const fixedOverlay = dedupeFixedAcrossSegments(perSegFixed);

  // ── Per-segment visibility windows (DM-642) ──
  // Each segment K is anchored at scroll-y = offsetK. Reading the keyframe
  // schedule, find the % of cycle at which the composite's scroll-y reaches
  // (offsetK - VH) [segment K enters viewport from below] and (offsetK + VH)
  // [segment K leaves viewport off the top]. Outside that window the segment
  // is `display: none` so the browser skips painting it. With ~8 segments
  // for an apple.com-style page only ~2 segments are visible at any moment;
  // hiding the other ~6 cuts per-frame paint cost dramatically.
  // The full-cycle anchors come from `dedupedStops` below; build a temporary
  // helper here that mirrors the same data shape.
  const segOffsets: number[] = segments.map((s) =>
    (axis === "y" ? s.scrollY : s.scrollX) - minPos,
  );
  const cycleStops: Array<{ pct: number; offset: number }> = [];
  cycleStops.push({ pct: 0, offset: segOffsets[0] });
  for (let i = 0; i < segments.length; i++) {
    const endPct = (segments[i].segmentEndMs / totalMs) * 100;
    cycleStops.push({ pct: endPct, offset: segOffsets[i] });
  }
  function pctAtScrollY(targetY: number, mode: "first" | "last"): number {
    // Linear interpolation across cycleStops to find when scroll-y crosses
    // targetY. With monotonic ascending scroll-y, "first" returns the first
    // crossing (entering); "last" returns the last crossing (leaving).
    // Out-of-range clamps to 0 / 100.
    let hit = mode === "first" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (let s = 0; s + 1 < cycleStops.length; s++) {
      const a = cycleStops[s], b = cycleStops[s + 1];
      const lo = Math.min(a.offset, b.offset);
      const hi = Math.max(a.offset, b.offset);
      if (targetY < lo - 0.001 || targetY > hi + 0.001) continue;
      const span = b.offset - a.offset;
      const t = span === 0 ? 0 : (targetY - a.offset) / span;
      const pct = a.pct + (b.pct - a.pct) * t;
      if (mode === "first" && pct < hit) hit = pct;
      if (mode === "last" && pct > hit) hit = pct;
    }
    if (!isFinite(hit)) return mode === "first" ? 0 : 100;
    return Math.max(0, Math.min(100, hit));
  }

  // ── Render each capture's content at its position offset ──
  const captureGroups: string[] = [];
  const segmentCullCss: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const offset = segOffsets[i];
    const inner = elementTreeToSvg(strippedTrees[i], W, VH, `seg${i}-`, true, hiDPIFactor);
    const tx = axis === "x" ? offset : 0;
    const ty = axis === "y" ? offset : 0;
    // Visibility window: from when scroll-y first reaches (offset - VH) to
    // when it last reaches (offset + VH). Add a small buffer to avoid
    // popping at the exact boundary where compositor sub-pixel rounding
    // could expose a 1-px seam.
    const dim = axis === "y" ? VH : W;
    const enterPct = pctAtScrollY(offset - dim, "first");
    const leavePct = pctAtScrollY(offset + dim, "last");
    const fullyVisible = enterPct <= 0 && leavePct >= 100;
    if (fullyVisible) {
      captureGroups.push(
        `  <g transform="translate(${tx} ${ty})">` +
          `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
            inner +
          `</svg>` +
        `</g>`,
      );
    } else {
      const cls = `${animClass}-s${i}`;
      // step-end so the segment snaps in/out at the boundary, no fractional
      // opacity that would force the browser to keep compositing it.
      segmentCullCss.push(
        `      @keyframes ${cls} { 0% { display: none } ${Math.max(0, enterPct - 0.001).toFixed(3)}% { display: none } ${enterPct.toFixed(3)}% { display: inline } ${leavePct.toFixed(3)}% { display: inline } ${Math.min(100, leavePct + 0.001).toFixed(3)}% { display: none } 100% { display: none } }
      .${cls} { animation: ${cls} ${totalSec.toFixed(3)}s infinite; animation-timing-function: step-end; }`,
      );
      captureGroups.push(
        `  <g class="${cls}" transform="translate(${tx} ${ty})">` +
          `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
            inner +
          `</svg>` +
        `</g>`,
      );
    }
  }
  const fixedMarkup = fixedOverlay.length === 0
    ? ""
    : `\n  <g>` +
        `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
          elementTreeToSvg(fixedOverlay, W, VH, "fix-", true, hiDPIFactor) +
        `</svg>` +
      `</g>`;

  // ── Keyframes — one stop per segment ──
  // Each segment anchors a (time-percent, position-offset) pair. Linear
  // interpolation between stops produces the smooth scroll; segments whose
  // start and end times match (effectively zero-duration) produce
  // step-end-style cuts naturally because the keyframe percentages collide.
  const stops: Array<{ pct: number; offset: number }> = [];
  stops.push({ pct: 0, offset: positions[0] - minPos });
  for (const seg of segments) {
    const endPct = (seg.segmentEndMs / totalMs) * 100;
    stops.push({ pct: endPct, offset: (axis === "y" ? seg.scrollY : seg.scrollX) - minPos });
  }
  // Dedupe trivially equal stops to keep CSS small.
  const dedupedStops = stops.filter((s, i, arr) => i === 0 || !(s.pct === arr[i - 1].pct && s.offset === arr[i - 1].offset));
  const translateFn = axis === "x" ? "X" : "Y";
  const keyframes = dedupedStops
    .map((s) =>
      // DM-642: use translate3d to coax the browser into promoting the
      // animated <g> onto its own compositing layer so per-frame motion is
      // a GPU paint rather than a CPU re-rasterisation of every embedded
      // image/path under the composite.
      `      ${s.pct.toFixed(3)}% { transform: translate3d(${translateFn === "X" ? `-${s.offset.toFixed(3)}px, 0` : `0, -${s.offset.toFixed(3)}px`}, 0); }`,
    )
    .join("\n");

  // ── Compose final SVG ──
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${VH}" width="${W}" height="${VH}">
  <defs>
    <clipPath id="${animClass}-clip"><rect width="${W}" height="${VH}"/></clipPath>
    <style>
      .${animClass} { animation: ${animClass} ${totalSec.toFixed(3)}s linear infinite; will-change: transform; }
      @keyframes ${animClass} {
${keyframes}
      }
${segmentCullCss.join("\n")}
    </style>
  </defs>
  <rect width="${W}" height="${VH}" fill="${bg}"/>
  <g clip-path="url(#${animClass}-clip)">
    <g class="${animClass}">
      <svg x="0" y="0" width="${compositeW}" height="${compositeH}" viewBox="0 0 ${compositeW} ${compositeH}">
        <rect width="${compositeW}" height="${compositeH}" fill="${bg}"/>
${captureGroups.join("\n")}
      </svg>
    </g>
  </g>${fixedMarkup}
</svg>`;
}
