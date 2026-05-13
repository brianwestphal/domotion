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

import type { ScrollSegmentCapture } from "./scroll-executor.js";
import { elementTreeToSvg } from "./dom-to-svg.js";

export interface ScrollComposerOptions {
  /** Visible viewport width (output SVG width). */
  viewportW: number;
  /** Visible viewport height (output SVG height). */
  viewportH: number;
  /** Which axis the scroll moves along. Default `"y"`. */
  axis?: "x" | "y";
  /** Background colour painted behind the captures (visible at seams). */
  bgColor?: string;
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

  // ── Render each capture's content at its position offset ──
  const captureGroups: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const offset = (axis === "y" ? seg.scrollY : seg.scrollX) - minPos;
    const inner = elementTreeToSvg(seg.tree, W, VH, `seg${i}-`);
    const tx = axis === "x" ? offset : 0;
    const ty = axis === "y" ? offset : 0;
    captureGroups.push(
      `  <g transform="translate(${tx} ${ty})">` +
        `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
          inner +
        `</svg>` +
      `</g>`,
    );
  }

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
  const animClass = `scrl-${Math.random().toString(36).slice(2, 8)}`;
  const keyframes = dedupedStops
    .map((s) => `      ${s.pct.toFixed(3)}% { transform: translate${axis === "x" ? "X" : "Y"}(-${s.offset.toFixed(3)}px); }`)
    .join("\n");

  // ── Compose final SVG ──
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${VH}" width="${W}" height="${VH}">
  <defs>
    <clipPath id="${animClass}-clip"><rect width="${W}" height="${VH}"/></clipPath>
    <style>
      .${animClass} { animation: ${animClass} ${totalSec.toFixed(3)}s linear infinite; }
      @keyframes ${animClass} {
${keyframes}
      }
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
  </g>
</svg>`;
}
