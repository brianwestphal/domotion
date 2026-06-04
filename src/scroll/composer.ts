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
import { elementTreeToSvgInner } from "../render/element-tree-to-svg.js";
import {
  clearEmbeddedFonts,
  getEmbeddedFontFaceCss,
  getRenderTextMode,
  setRenderTextMode,
  type RenderTextMode,
} from "../render/text-to-path.js";
import { extractFixedSubtrees, dedupeFixedAcrossSegments } from "./hoist-fixed.js";
import { extractStickyWindows, type StickyOverlay } from "./hoist-sticky.js";

export interface ScrollComposerOptions {
  /** Visible viewport width (output SVG width). */
  viewportW: number;
  /** Visible viewport height (output SVG height). */
  viewportH: number;
  /** Which axis the scroll moves along. Default `"y"`. */
  axis?: "x" | "y";
  /**
   * Background color painted behind the captures (a full-viewport rect, visible
   * at seams). When omitted it defaults to the captured page's root background
   * (`rootBgComputed`), so a transparent page yields a transparent SVG and a
   * colored page keeps its color — matching the single-frame path (DM-894).
   * Pass `"transparent"` to force no background rect regardless of the capture.
   */
  bgColor?: string;
  /**
   * hiDPI multiplier passed through to `elementTreeToSvg` when rendering
   * each segment's captured tree. Must match what was passed to
   * `resizeEmbeddedImages` for the same trees, or the renderer falls back
   * to source-resolution data URIs. Default 2 (matches `elementTreeToSvg`).
   */
  hiDPIFactor?: number;
  /**
   * DM-648: number of consecutive segments to group inside one
   * `<g style="will-change: transform">` chunk wrapper. Each chunk gets its
   * own GPU backing store so tall composites don't blow Chromium's
   * per-layer raster budget (the 1280 × 6015 px apple-desktop-scroll capture
   * at hi-DPI 2 was ~30 MB of raster on a single layer). Default `2` —
   * meaning every two segments share one layer; a 16-segment scroll yields
   * 8 layers. `1` puts each segment on its own layer (more layers, smaller
   * each); higher values trade layer count for layer size. Must be ≥ 1.
   * See `docs/36-scroll-composite-layer-chunking.md`.
   */
  chunkSize?: number;
  /**
   * DM-652: text rendering mode. Default `"embedded-font"` emits `<text>`
   * elements with a single `@font-face` per used webfont — much faster
   * in WebKit (≈1.84× perf gain + 4.5× smaller file on text-heavy
   * fixtures per DM-651) and visually equivalent in Chromium. `"paths"`
   * is the legacy Chromium-faithful mode that emits `<use href="#gN">`
   * references to glyph path defs, useful when the consumer needs
   * per-pixel parity with the Chromium capture (e.g. visual-regression
   * diffing against the live page). System-font runs and bidi /
   * fallback-chain runs always stay in `"paths"` mode regardless of
   * this flag (MVP scope).
   */
  renderText?: RenderTextMode;
}

/**
 * Step-end `visibility` keyframes for a culled segment / sticky window (DM-641):
 * hidden until the content first enters [startPct], visible across the window,
 * hidden again after [endPct]. 0.001% pads keep each step-end snap off the exact
 * boundary. Returns the `@keyframes` rule plus the `.cls` animation binding.
 */
function buildVisibilityKeyframes(cls: string, startPct: number, endPct: number, totalSec: number): string {
  return `      @keyframes ${cls} { 0% { visibility: hidden } ${Math.max(0, startPct - 0.001).toFixed(3)}% { visibility: hidden } ${startPct.toFixed(3)}% { visibility: visible } ${endPct.toFixed(3)}% { visibility: visible } ${Math.min(100, endPct + 0.001).toFixed(3)}% { visibility: hidden } 100% { visibility: hidden } }
      .${cls} { animation: ${cls} ${totalSec.toFixed(3)}s infinite; animation-timing-function: step-end; }`;
}

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
  // DM-894: paint the canvas background from the captured page's ROOT
  // background (`rootBgComputed`, stamped by the capture script — the same
  // value the single-frame `transparentRootBgRect` path and the DM-893 animator
  // fix use), not a hardcoded dark color. An explicit `opts.bgColor` still wins.
  // When the resolved background is transparent / absent we emit NO rect, so a
  // transparent capture stays transparent and composites over a host page.
  const bg = opts.bgColor ?? segments[0]?.tree?.[0]?.styles?.rootBgComputed;
  const paintBg = bg != null && bg !== "" && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";
  const hiDPIFactor = opts.hiDPIFactor ?? 2;
  const chunkSize = opts.chunkSize ?? 2;
  if (chunkSize < 1 || !Number.isInteger(chunkSize)) {
    throw new Error(`composeScrollSvg: chunkSize must be a positive integer, got ${chunkSize}`);
  }

  // DM-652: arm the text-render lifecycle. Default is "embedded-font" —
  // the per-segment text renderer emits `<text>` runs against a single
  // @font-face per used webfont, ~2× faster in WebKit and ~5× smaller
  // SVG payload than the legacy glyph-path output, visually equivalent
  // in Chromium. Callers that need per-pixel Chromium parity (e.g.
  // visual-regression diffing) opt back into "paths" explicitly. State
  // is module-global so every segment's `elementTreeToSvg` call shares
  // the same `@font-face` registry; we collect everything into one
  // top-level <style> block at the bottom of this function.
  const renderTextMode: RenderTextMode = opts.renderText ?? "embedded-font";
  const prevRenderTextMode = getRenderTextMode();
  clearEmbeddedFonts();
  setRenderTextMode(renderTextMode);
  // DM-1078: the whole body renders in the chosen mode (module-global);
  // restore on ANY exit — incl. a mid-segment elementTreeToSvgInner throw —
  // so the mode can't leak to the next caller. (Body left un-indented to
  // keep the multi-line template literals below byte-for-byte intact.)
  try {

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

  // DM-1073: derive the animation class from a stable signature of this
  // composite (axis, dimensions, segment scroll offsets) rather than
  // `Math.random()`, so the same input produces byte-identical output (stable
  // diffing / caching) while distinct composites in one document still differ.
  const animClass = `scrl-${fnv1aHex(`${axis}|${W}x${VH}|${positions.join(",")}`)}`;

  // ── Split each capture into "scrolling" + "fixed" subtrees ──
  // DM-643: `position: fixed` elements (site headers, cookie banners, etc.)
  // appear at the same viewport coordinates in every capture. If we leave
  // them inside the per-segment subtrees, the composer offsets each copy by
  // that segment's scrollY and the scrolling composite carries them past the
  // viewport — so the consumer sees the header "scroll" once per segment.
  // Strip the fixed subtrees from every segment and hoist them onto a single
  // viewport-level overlay below.
  const fixedStripped: typeof segments[number]["tree"][] = [];
  const perSegFixed: typeof segments[number]["tree"][] = [];
  for (const seg of segments) {
    const { stripped, fixed } = extractFixedSubtrees(seg.tree);
    fixedStripped.push(stripped);
    perSegFixed.push(fixed);
  }
  const fixedOverlay = dedupeFixedAcrossSegments(perSegFixed);

  // ── Sticky overlays (DM-647) ──
  // For each `position: sticky` element, find the runs of consecutive
  // segments where it stays at the same viewport-y (stuck windows) and
  // hoist each run onto the same overlay layer as the fixed overlay. The
  // element stays inline in segments where it's still scrolling.
  const { stripped: strippedTrees, overlays: stickyOverlays } = extractStickyWindows(fixedStripped);

  // ── Per-segment visibility windows (DM-642) ──
  // Each segment K is anchored at scroll-y = offsetK. Reading the keyframe
  // schedule, find the % of cycle at which the composite's scroll-y reaches
  // (offsetK - VH) [segment K enters viewport from below] and (offsetK + VH)
  // [segment K leaves viewport off the top]. Outside that window the segment
  // is `visibility: hidden` so the browser skips painting it. With ~8 segments
  // for an apple.com-style page only ~2 segments are visible at any moment;
  // hiding the other ~6 cuts per-frame paint cost dramatically.
  //
  // DM-641: we use `visibility` (not `display`) for the same reason the
  // animator does — an element whose 0% keyframe is `display: none`
  // never enters Chromium's render tree, so the animation engine never
  // ticks the keyframe that would bring it back in.
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
    const inner = elementTreeToSvgInner(strippedTrees[i], W, VH, `seg${i}-`, true, hiDPIFactor, false);
    const tx = axis === "x" ? offset : 0;
    const ty = axis === "y" ? offset : 0;
    // Visibility window: visible while scroll-y is in the rasterisation
    // window for this segment. The strict mathematical bound is
    // `offset ± VH` (segment content can intersect viewport), but using
    // exactly that triggers a Chromium compositor pop: the segment is
    // `visibility: hidden` until the moment its content first enters the
    // viewport, then `visible` snaps it on — but the GPU has zero time to
    // rasterise the segment before its first frame of "should be visible"
    // content is displayed, so for one or two frames the segment paints
    // empty while raster catches up. Users see "content pops in at the
    // viewport bottom" (DM-668 — reproducible on the NYT-desktop-scroll
    // fixture at the s5→s6 boundary, ~26.3% of cycle).
    //
    // Fix: make each segment visible one extra `dim` (viewport-height /
    // -width) earlier on enter and later on leave. Browsers get a full
    // viewport-height of scroll time to rasterise before the segment's
    // content actually needs to paint, and the segment stays rasterised
    // a viewport longer after it leaves so a rapid scroll reversal also
    // hits a warm GPU layer. Peak segments-visible-at-once roughly
    // doubles (2 → ~4 worst case), which doesn't materially affect file
    // size (the wrappers are hidden, not omitted) but does increase
    // resident raster memory by ~one extra viewport per layer chunk —
    // acceptable on every device we've profiled.
    const dim = axis === "y" ? VH : W;
    const rasterBuffer = dim;
    const enterPct = pctAtScrollY(offset - dim - rasterBuffer, "first");
    const leavePct = pctAtScrollY(offset + dim + rasterBuffer, "last");
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
      segmentCullCss.push(buildVisibilityKeyframes(cls, enterPct, leavePct, totalSec));
      captureGroups.push(
        `  <g class="${cls}" transform="translate(${tx} ${ty})">` +
          `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
            inner +
          `</svg>` +
        `</g>`,
      );
    }
  }
  // ── Sticky overlay markup + visibility keyframes ──
  // Each overlay is one stuck window for one sticky element. Wrap the
  // rendered subtree in a <g class="…"> whose visibility keyframe shows it
  // only during [firstSegmentStart, lastSegmentEnd] of the cycle and hides
  // it otherwise. DM-641 convention: visibility, never display.
  const stickyMarkup: string[] = [];
  const stickyCullCss: string[] = [];
  for (let i = 0; i < stickyOverlays.length; i++) {
    const o: StickyOverlay = stickyOverlays[i];
    const visStartPct = (segments[o.firstSegmentIdx].segmentStartMs / totalMs) * 100;
    const visEndPct = (segments[o.lastSegmentIdx].segmentEndMs / totalMs) * 100;
    const alwaysVisible = visStartPct <= 0 && visEndPct >= 100;
    const inner = elementTreeToSvgInner([o.subtree], W, VH, `stk${i}-`, true, hiDPIFactor, false);
    if (alwaysVisible) {
      stickyMarkup.push(
        `\n  <g><svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">${inner}</svg></g>`,
      );
    } else {
      const cls = `${animClass}-k${i}`;
      stickyCullCss.push(buildVisibilityKeyframes(cls, visStartPct, visEndPct, totalSec));
      stickyMarkup.push(
        `\n  <g class="${cls}"><svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">${inner}</svg></g>`,
      );
    }
  }

  const fixedMarkup = fixedOverlay.length === 0
    ? ""
    : `\n  <g>` +
        `<svg x="0" y="0" width="${W}" height="${VH}" viewBox="0 0 ${W} ${VH}">` +
          elementTreeToSvgInner(fixedOverlay, W, VH, "fix-", true, hiDPIFactor, false) +
        `</svg>` +
      `</g>`;
  const overlayMarkup = fixedMarkup + stickyMarkup.join("");

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

  // ── DM-648: chunked compositing layers ──
  // Group consecutive segment wrappers into chunks of `chunkSize`. Each
  // chunk wrapper carries `style="will-change: transform"` so Chromium gives
  // it its own GPU backing store, letting tall composites stay under the
  // per-layer raster cap. The chunk wrapper itself has NO `transform` (would
  // double-translate); the inner per-segment `translate(0 Y)` still places
  // content. The DM-642 cull classes on each inner segment are untouched.
  const chunks: string[] = [];
  for (let i = 0; i < captureGroups.length; i += chunkSize) {
    const slice = captureGroups.slice(i, i + chunkSize);
    chunks.push(`<g style="will-change: transform">\n${slice.join("\n")}\n      </g>`);
  }

  // DM-652: collect every `@font-face` rule the embedded-font path
  // registered during segment + overlay rendering above, into a single
  // top-level <style> block. Each font appears once (registry is keyed
  // per (family, weight, italic)) — segments referencing the same font
  // collapse onto one rule. Restore the default render mode now that
  // all per-segment rendering has finished.
  const fontFaceCss = getEmbeddedFontFaceCss();

  // ── Compose final SVG ──
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${VH}" width="${W}" height="${VH}">
  <defs>
    <clipPath id="${animClass}-clip"><rect width="${W}" height="${VH}"/></clipPath>
    <style>
${fontFaceCss !== "" ? fontFaceCss + "\n" : ""}      .${animClass} { animation: ${animClass} ${totalSec.toFixed(3)}s linear infinite; will-change: transform; }
      @keyframes ${animClass} {
${keyframes}
      }
${segmentCullCss.join("\n")}
${stickyCullCss.join("\n")}
    </style>
  </defs>
${paintBg ? `  <rect width="${W}" height="${VH}" fill="${bg}"/>\n` : ""}  <g clip-path="url(#${animClass}-clip)">
    <g class="${animClass}">
      <svg x="0" y="0" width="${compositeW}" height="${compositeH}" viewBox="0 0 ${compositeW} ${compositeH}">
${paintBg ? `        <rect width="${compositeW}" height="${compositeH}" fill="${bg}"/>\n` : ""}      ${chunks.join("\n      ")}
      </svg>
    </g>
  </g>${overlayMarkup}
</svg>`;
  } finally {
    setRenderTextMode(prevRenderTextMode);
  }
}

/** Small deterministic string hash (FNV-1a, 32-bit) → 6-char base36. Used to
 *  derive a stable per-composite animation-class suffix so identical input
 *  yields byte-identical SVG (DM-1073). */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}
