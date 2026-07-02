/**
 * SVG Animation Composer
 *
 * Takes captured SVG frame content and composes them into a single
 * animated SVG with CSS keyframe transitions.
 */

import { type CursorAtResolver, type CursorOverlay, type SelectorResolver, cursorOverlayMarkup, resolveCursorScript } from "./cursor-overlay.js";
import type { MagicMove } from "./magic-move.js";
// DM-1131: overlay / intra-frame-animation shapes are defined ONCE as zod
// schemas in `overlay-schema.ts`; the renderer-facing TS types are derived from
// them via `z.infer`, and the declarative-config layer extends the same base
// schemas. Re-exported below so the public `domotion-svg` surface is unchanged.
import type { AnimationOverlay, TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, IntraFrameAnimation } from "./overlay-schema.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { isTransparentBackground } from "../utils/transparent-background.js";
import { rootSvgA11y } from "../render/format.js";
import { getFontInstance, resolveFontKey } from "../render/font-resolution.js";
import { DEFAULT_TRANSITION_MS, frameAdvanceMs, transitionDurationMs } from "./frame-timeline.js";
import { offsetEmbeddedAnimatedSvgTimeline } from "./embed-timeline.js";
import { KEYFRAME_EPSILON, cullOverlapPct, padAfter, padBefore } from "../utils/keyframe-pad.js";
import { interpolateCssValue, resolveEasing } from "./easing.js";
import { resolveEasingPreset } from "./motion-presets.js";
import { buildShineSweep } from "./shine.js";

export interface AnimationFrame {
  /** SVG content for this frame (from dom-to-svg) */
  svgContent: string;
  /**
   * Per-element viewBox-cull keyframes CSS (DM-603). The caller runs
   * `cullElementsOutsideViewBox()` on the captured tree before `elementTreeToSvg()` — that
   * mutates `displayNone` / `cullClass` on each element (which the renderer
   * surfaces) and returns the keyframes blocks that map each `cull-N` class
   * to its visible window. The animator splices this CSS into the scene-wide
   * `<style>` block.
   *
   * When omitted, no culling happens — callers passing pre-rendered
   * `svgContent` strings without the cull CSS get unchanged behavior.
   */
  cullCss?: string;
  /** Duration this frame is shown (ms) */
  duration: number;
  /**
   * DM-1319: this frame's `svgContent` is itself a self-contained *animated* SVG
   * (a `cast` / `template` frame) whose internal timeline should start when the
   * frame becomes visible, not at the master-loop origin. Set to the embedded
   * content's own play length (ms); the animator re-anchors its keyframes into
   * the `[frameStart, frameStart + period]` window of the master loop (see
   * `offsetEmbeddedAnimatedSvgTimeline`). Omit for ordinary captured frames.
   */
  embeddedAnimationPeriodMs?: number;
  /** Transition to next frame */
  transition?: {
    /**
     * `crossfade` (default) overlaps fade-out and fade-in. `push-left` slides
     * the outgoing frame off and the incoming frame in from the right.
     * `scroll` keeps both visible during the transition. `cut` is instant —
     * no fade, no slide. For `cut`, `duration` is ignored. `magic-move` blends
     * shared elements between the two frames — matched elements slide from
     * their old position to their new one while added/removed elements
     * cross-fade (DM-898; see `docs/53-magic-move-transition.md`). It requires
     * the per-frame `magicMove` bridge layer (built caller-side from the
     * element trees); when that's absent it degrades to `crossfade`.
     *
     * DM-1524 adds the cross-engine-safe transition/effect expansion (docs/88):
     * directional pushes `push-right` / `push-up` / `push-down` (the vertical/
     * horizontal siblings of `push-left`; `push-up` is the alias of `scroll`'s
     * motion), the `wipe` (linear left→right `clip-path` reveal) and `iris`
     * (expanding-circle `clip-path` reveal) reveals, `zoom-in` / `zoom-out`
     * (scale dolly under a crossfade), and `shine` (a crossfade with a swept
     * gradient highlight over the handoff — the shared `buildShineSweep` helper).
     * All express motion in `transform` / `clip-path` / `opacity` / gradients
     * only — never an animated CSS `filter` (Chromium-only in `<img>`, docs/84).
     */
    type:
      | "crossfade" | "push-left" | "scroll" | "cut" | "magic-move"
      | "push-right" | "push-up" | "push-down"
      | "wipe" | "iris" | "zoom-in" | "zoom-out" | "shine";
    duration: number;
    /**
     * DM-1550: optional named easing (or a raw CSS easing string) for the
     * `wipe` / `iris` clip-path reveal and the `zoom-in` / `zoom-out` scale
     * dolly this transition drives into the NEXT frame. Resolved through the
     * motion-preset vocabulary (`resolveEasingPreset`) so the sampled
     * `spring-soft` / `spring-bouncy` `linear(...)` curves — and their visible
     * overshoot — apply to the reveal / dolly. Ignored by the other transition
     * types (their motion is fixed). Default: `linear`.
     */
    easing?: string;
  };
  /**
   * Magic-move bridge layer for this frame's transition to the next, built by
   * the caller via `buildMagicMove(prevTree, nextTree, …)`. Present only when
   * `transition.type === "magic-move"` and both frames' element trees were
   * available; the animator shows it during the transition window (moved
   * elements slide, added fade in, removed fade out) between the hard-cut prev
   * and next frame blobs. When `transition.type` is `magic-move` but this is
   * null, the animator falls back to `crossfade`.
   */
  magicMove?: MagicMove | null;
  /** Overlays: typing, tap ripple */
  overlays?: AnimationOverlay[];
  /**
   * Intra-frame property animations. Run during this frame's hold time.
   * The CLI / `DemoRecorder` resolves selectors against the DOM at capture
   * and sets `data-domotion-anim` on matching elements; this list is the
   * post-resolution form referencing those ids. See `IntraFrameAnimation`.
   */
  animations?: IntraFrameAnimation[];
}

// DM-1131: `TypingOverlay` / `TapOverlay` / `SvgOverlay` / `BlinkOverlay` /
// `AnimationOverlay` / `IntraFrameAnimation` are now derived (`z.infer`) from
// the single zod source of truth in `./overlay-schema.ts` and re-exported here
// so the public `domotion-svg` type surface is unchanged. The renderer-facing
// (resolved) shape lives there; the declarative config extends the same base.
export type { TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, AnimationOverlay, IntraFrameAnimation };

export interface AnimationConfig {
  width: number;
  height: number;
  frames: AnimationFrame[];
  /** DM-1488: accessible name → `role="img"` + `<title>` on the root `<svg>`
   *  (for inline-`<svg>` embedding). Omit to leave the output unchanged. */
  title?: string;
  /** DM-1488: accessible long description → `<desc>` on the root `<svg>`. */
  desc?: string;
  /**
   * Markup (e.g. `<path id="g0" d="..."/>...`) hoisted into the top-level
   * `<defs>`. Frames can reference these IDs via `<use href="#...">`. Use for
   * glyph paths and other assets that repeat across frames — avoids duplicating
   * them in every frame's local defs.
   */
  sharedDefs?: string;
  /**
   * DM-839: embedded-font `@font-face` rules collected once across all frames
   * (the caller renders each frame with `includeEmbeddedFontCss=false` and
   * passes the accumulated `getEmbeddedFontFaceCss()` here). Injected into the
   * top-level `<style>` so the base64 font bytes appear once, not per frame.
   */
  fontFaceCss?: string;
  /**
   * Optional cursor / click overlay (DM-277). Renders a macOS-style cursor
   * moving along the script timeline with QuickTime-style click pulses.
   * Off by default; opt-in per animation. See `docs/13-cursor-overlay.md`.
   */
  cursorOverlay?: CursorOverlay;
  /**
   * Resolver for selector-based cursor move events. Required if any event
   * uses `selector`; otherwise pass undefined / null.
   */
  resolveSelector?: SelectorResolver;
  /**
   * DM-1106: auto cursor-TYPE hit-tester — given a viewport point and frame
   * index, returns the cursor keyword under it (the caller builds this from the
   * per-frame captured trees via `cursorAtPoint`). When provided, the overlay
   * paints the matching glyph per element and switches at boundary crossings;
   * when omitted, the overlay paints the single arrow.
   */
  resolveCursorAt?: CursorAtResolver;
  /**
   * Canvas background color painted behind every frame (a full-viewport
   * `<rect>`). Mirrors the single-frame path's `transparentRootBgRect`
   * (DM-554): pass the captured page's root background so animated output
   * matches `capture` output. Omitted / `"transparent"` / `"rgba(0, 0, 0, 0)"`
   * → no rect, i.e. a transparent SVG that composites over a host background.
   */
  background?: string;
  /**
   * DM-1148: whether the LAST frame fades out (over its transition window) to
   * dissolve back into the loop's frame 0. Default `false` — the last frame
   * HOLDS solid to 100% and the loop hard-cuts to frame 0, so a one-shot video
   * ends on the final frame rather than fading to nothing. Set `true` to restore
   * the cross-dissolve loop (e.g. for a seamless background-loop SVG). Only
   * affects the crossfade path; cut transitions already hold-then-cut.
   */
  loopFade?: boolean;
}

/**
 * Emit one magic-move frame (DM-898): the frame-i blob (held [start..holdEnd],
 * hard-cut out), the bridge composite (visible only across [holdEnd..transEnd]),
 * the per-element slide / fade keyframes within that window, and the
 * `prefers-reduced-motion` pinning (DM-901 / DM-903). Returns the SVG group
 * fragments and the `@keyframes`/rule CSS for the caller to splice in.
 * Extracted from `generateAnimatedSvg`'s per-frame loop (DM-1089) — byte-identical.
 */
function emitMagicMoveFrame(
  i: number,
  frame: AnimationFrame,
  mm: MagicMove,
  startPct: string,
  holdEndPct: string,
  transEndPct: string,
  totalSec: number,
): { groups: string[]; keyframes: string[] } {
  const groups: string[] = [];
  const keyframes: string[] = [];
  const sNum = parseFloat(startPct);
  const hNum = parseFloat(holdEndPct);
  const tNum = parseFloat(transEndPct);
  const beforeS = padBefore(sNum, KEYFRAME_EPSILON.cull, 3);
  const afterH = padAfter(hNum, KEYFRAME_EPSILON.cull, 3);
  const beforeH = padBefore(hNum, KEYFRAME_EPSILON.cull, 3);
  const afterT = padAfter(tNum, KEYFRAME_EPSILON.cull, 3);

  // Frame i blob: visible only during its hold, hard-cut out at hold end.
  // DM-1511: opacity does the cut; a SEPARATE wide-overlap `fd-` `visibility`
  // track handles paint-culling so Firefox can't flash a transparent gap at the
  // hand-off (it composites `visibility` off the opacity clock).
  groups.push(`  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`);
  keyframes.push(`
    @keyframes fv-${i} {
      0% { opacity: 0; }
      ${beforeS}% { opacity: 0; }
      ${sNum.toFixed(3)}% { opacity: 1; }
      ${hNum.toFixed(3)}% { opacity: 1; }
      ${afterH}% { opacity: 0; }
      100% { opacity: 0; }
    }${buildDisplayKeyframes(`fd-${i}`, startPct, holdEndPct, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s step-end infinite, fd-${i} ${totalSec.toFixed(2)}s step-end infinite; }`);

  // Bridge composite: visible during the transition window only.
  groups.push(`  <g class="f mm-${i}">\n${mm.compositeSvg}\n  </g>`);
  keyframes.push(`
    @keyframes mmv-${i} {
      0% { opacity: 0; }
      ${beforeH}% { opacity: 0; }
      ${hNum.toFixed(3)}% { opacity: 1; }
      ${tNum.toFixed(3)}% { opacity: 1; }
      ${afterT}% { opacity: 0; }
      100% { opacity: 0; }
    }${buildDisplayKeyframes(`mmd-${i}`, holdEndPct, transEndPct, totalSec)}
    .mm-${i} { animation: mmv-${i} ${totalSec.toFixed(2)}s step-end infinite, mmd-${i} ${totalSec.toFixed(2)}s step-end infinite; }`);

  // Per-element slide / fade keyframes within the window (linear interp).
  // The composite is only visible [holdEnd..transEnd], so the held values
  // outside that window are never painted — they just pin the endpoints.
  //
  // A dual-render cross-fade copy (DM-903) is BOTH a slide and a fade, so
  // its element needs two animations. They MUST go in one `animation:`
  // declaration (comma-joined) — two separate `.cls { animation: … }` rules
  // would have the later one silently override the former, dropping the
  // slide. Accumulate per-class animation entries and emit one rule each.
  const animEntries = new Map<string, string[]>();
  const addAnim = (cls: string, name: string): void => {
    const list = animEntries.get(cls) ?? [];
    list.push(`${name} ${totalSec.toFixed(2)}s infinite`);
    animEntries.set(cls, list);
  };
  for (const s of mm.slides) {
    keyframes.push(`
    @keyframes mms-${s.cls} {
      0%, ${hNum.toFixed(3)}% { transform: ${s.from}; }
      ${tNum.toFixed(3)}%, 100% { transform: ${s.to}; }
    }`);
    addAnim(s.cls, `mms-${s.cls}`);
  }
  for (const cls of mm.fadeIn) {
    keyframes.push(`
    @keyframes mmf-${cls} {
      0%, ${hNum.toFixed(3)}% { opacity: 0; }
      ${tNum.toFixed(3)}%, 100% { opacity: 1; }
    }`);
    addAnim(cls, `mmf-${cls}`);
  }
  for (const cls of mm.fadeOut) {
    keyframes.push(`
    @keyframes mmf-${cls} {
      0%, ${hNum.toFixed(3)}% { opacity: 1; }
      ${tNum.toFixed(3)}%, 100% { opacity: 0; }
    }`);
    addAnim(cls, `mmf-${cls}`);
  }
  for (const [cls, entries] of animEntries) {
    keyframes.push(`    .${cls} { animation: ${entries.join(", ")}; }`);
  }
  // DM-901: honor `prefers-reduced-motion: reduce` — pin everything to the
  // NEXT state instead of animating, so the transition degrades to a
  // cut-like reveal for motion-sensitive viewers.
  const reduceRules: string[] = [];
  if (mm.slides.length > 0) reduceRules.push(`${mm.slides.map((s) => `.${s.cls}`).join(", ")} { animation: none; transform: none; }`);
  if (mm.fadeIn.length > 0) reduceRules.push(`${mm.fadeIn.map((c) => `.${c}`).join(", ")} { animation: none; opacity: 1; }`);
  if (mm.fadeOut.length > 0) reduceRules.push(`${mm.fadeOut.map((c) => `.${c}`).join(", ")} { animation: none; opacity: 0; }`);
  if (reduceRules.length > 0) {
    keyframes.push(`
    @media (prefers-reduced-motion: reduce) {
      ${reduceRules.join("\n      ")}
    }`);
  }
  return { groups, keyframes };
}

/**
 * Emit one crossfade or cut frame (the default transition path): the frame
 * blob plus its opacity keyframes. `cut` (or zero-duration) uses disjoint
 * step-end keyframes so opacity flips instantly with no interpolation smear;
 * crossfade overlaps the fade-in with the previous frame's fade-out, with the
 * visible window driven by `fadeInStartPct` (precomputed by the caller, which
 * knows the overlap state). Extracted from `generateAnimatedSvg` (DM-1089).
 */
/** The keyframe-window percentages a crossfade/cut frame places its opacity CSS
 *  at. Grouped into one object (DM-1458) so these four same-typed string args
 *  can't be silently transposed at the call site. */
interface CrossfadeWindow {
  startPct: string;
  holdEndPct: string;
  transEndPct: string;
  /** Crossfade fade-in window opens here — overlaps the previous frame's
   *  fade-out, so the caller derives it from the loop's overlap state. */
  fadeInStartPct: string;
}

function emitCrossfadeOrCutFrame(
  i: number,
  frame: AnimationFrame,
  transType: string,
  transDur: number,
  win: CrossfadeWindow,
  totalSec: number,
  /** DM-1148: the last frame, when the loop must NOT cross-dissolve, holds
   *  opacity 1 to 100% instead of fading out over its transition window. */
  holdToEnd: boolean,
  /** DM-1524: a `zoom-*` predecessor gives THIS incoming frame a scale dolly over
   *  its entrance window, resting at scale(1). Null → plain crossfade/cut. */
  entranceScale: { fromScale: number; enterStartPct: string; startPct: string; width: number; height: number; easing?: string } | null = null,
): { groups: string[]; keyframes: string[] } {
  const { startPct, holdEndPct, transEndPct, fadeInStartPct } = win;
  const groups: string[] = [];
  const keyframes: string[] = [];
  // DM-1524: wrap in a scale-dolly group only when a zoom entrance is requested;
  // otherwise the group markup is byte-identical to the pre-DM-1524 output.
  const inner = entranceScale != null ? `<g class="fz-${i}">\n${frame.svgContent}\n  </g>` : frame.svgContent;
  groups.push(`  <g class="f f-${i}">\n${inner}\n  </g>`);
  if (entranceScale != null) {
    const cx = entranceScale.width / 2;
    const cy = entranceScale.height / 2;
    const esBefore = padBefore(parseFloat(entranceScale.enterStartPct), KEYFRAME_EPSILON.slide, 2);
    // DM-1550: ease the scale dolly SEGMENT (enter → start) via a per-keyframe
    // timing function on the `enterStartPct` stop; the surrounding holds stay
    // linear. A sampled spring overshoots scale(1) (e.g. up to ~1.1) then rings
    // down — a visible pop — and rests at scale(1) (identity).
    const esTf = entranceScale.easing != null ? ` animation-timing-function: ${entranceScale.easing};` : "";
    keyframes.push(`
    @keyframes fz-${i} {
      0%, ${esBefore}% { transform: scale(${entranceScale.fromScale}); }
      ${entranceScale.enterStartPct} { transform: scale(${entranceScale.fromScale});${esTf} }
      ${entranceScale.startPct} { transform: scale(1); }
      100% { transform: scale(1); }
    }
    .fz-${i} { animation: fz-${i} ${totalSec.toFixed(2)}s linear infinite; transform-origin: ${cx}px ${cy}px; }`);
  }

  const isCut = transType === "cut" || transDur === 0;
  if (isCut) {
    const startNum = parseFloat(startPct);
    const endNum = parseFloat(transEndPct);
    const beforeStart = padBefore(startNum, KEYFRAME_EPSILON.cull, 3);
    const afterEnd = padAfter(endNum, KEYFRAME_EPSILON.cull, 3);
    // DM-1511: opacity does the cut (tight overlap, Firefox-safe); `visibility`
    // is a SEPARATE wide-overlap paint-cull track so Firefox can't flash a
    // transparent gap at the hand-off. (Previously one combined keyframe.)
    keyframes.push(`
    @keyframes fv-${i} {
      0% { opacity: 0; }
      ${beforeStart}% { opacity: 0; }
      ${startNum.toFixed(3)}% { opacity: 1; }
      ${endNum.toFixed(3)}% { opacity: 1; }
      ${afterEnd}% { opacity: 0; }
      100% { opacity: 0; }
    }${buildDisplayKeyframes(`fd-${i}`, startPct, transEndPct, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s step-end infinite, fd-${i} ${totalSec.toFixed(2)}s step-end infinite; }`);
  } else {
    const prevEnd = i > 0
      ? `${padBefore(parseFloat(fadeInStartPct), KEYFRAME_EPSILON.display, 2)}%,`
      : "";
    if (holdToEnd) {
      // DM-1148: the final frame holds solid to 100% (no fade-out); the loop
      // hard-cuts back to frame 0. The `fd` display window also runs to 100%.
      // `prevEnd` (the prior frame's fade-out boundary) is empty for a lone
      // frame-0 animation, which then has no opacity:0 segment at all.
      const offSeg = prevEnd !== "" ? `0%, ${prevEnd.replace(/,$/, "")} { opacity: 0; }\n      ` : "";
      keyframes.push(`
    @keyframes fv-${i} {
      ${offSeg}${startPct}, 100% { opacity: 1; }
    }${buildDisplayKeyframes(`fd-${i}`, fadeInStartPct, "100", totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite, fd-${i} ${totalSec.toFixed(2)}s infinite step-end; }`);
    } else {
      keyframes.push(`
    @keyframes fv-${i} {
      0%, ${prevEnd} ${transEndPct}, 100% { opacity: 0; }
      ${startPct}, ${holdEndPct} { opacity: 1; }
    }${buildDisplayKeyframes(`fd-${i}`, fadeInStartPct, transEndPct, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite, fd-${i} ${totalSec.toFixed(2)}s infinite step-end; }`);
    }
  }
  return { groups, keyframes };
}

/**
 * DM-1145: re-namespace element ids that COLLIDE across frames. A caller that
 * reuses identical `svgContent` for multiple frames — e.g. caching a captured
 * frame and replaying it for a long hold — emits the same baked-in ids in two
 * frame groups. Duplicate ids are invalid SVG: a `clip-path="url(#id)"` / filter
 * / `<use href="#id">` resolves to the FIRST match, which for the later frame
 * lives in an earlier (now `visibility:hidden`) frame group. Chromium renders
 * that fine during continuous playback, but CLIPS THE ELEMENT AWAY when the
 * timeline is SEEKED to that frame (paused + `currentTime` set) — exactly what
 * svg-to-video does, so the element vanishes in the rendered video although the
 * SVG looks fine when played. Rename each frame's colliding ids (and their
 * in-frame references) to a frame-unique form. ONLY collisions are touched, so
 * frames whose ids are already unique are emitted byte-for-byte unchanged.
 */
export function dedupeFrameIds(frames: AnimationFrame[]): AnimationFrame[] {
  const seen = new Set<string>();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return frames.map((frame, i) => {
    const svg = frame.svgContent;
    if (svg == null || svg === "") return frame;
    const defined = new Set<string>();
    for (const m of svg.matchAll(/\sid="([^"]+)"/g)) defined.add(m[1]);
    const colliding = [...defined].filter((id) => seen.has(id));
    for (const id of defined) seen.add(id);
    if (colliding.length === 0) return frame;
    let out = svg;
    for (const id of colliding) {
      const nid = `d${i}-${id}`;
      const e = esc(id);
      out = out
        .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${nid}$2`)
        .replace(new RegExp(`url\\(#${e}\\)`, "g"), `url(#${nid})`)
        .replace(new RegExp(`((?:xlink:)?href=")#${e}(")`, "g"), `$1#${nid}$2`);
      seen.add(nid);
    }
    return { ...frame, svgContent: out };
  });
}

/**
 * DM-1414: how a slide frame ENTERS — driven by the PREVIOUS frame's transition
 * type, not this frame's own (exit) type. `slide` slides in from off-screen on
 * `axis` (the predecessor was a push/scroll); `fade` fades in (the predecessor
 * was a crossfade); `cut` appears at its own start (cut / magic-move / loop top).
 */
type SlideEnter =
  | { mode: "slide"; axis: "X" | "Y"; enterOffset: number }
  | { mode: "fade" }
  | { mode: "cut" };

/**
 * DM-1524: the directional-push family, mapping each transition type to its exit
 * AXIS and SIGN (the direction the outgoing frame slides). `sign` = -1 slides
 * toward the negative axis (left / up), +1 toward positive (right / down); the
 * incoming frame enters from the OPPOSITE side. `push-left` / `scroll` are the
 * pre-existing pair (`scroll` == `push-up`); `push-right` / `push-up` /
 * `push-down` are the DM-1524 additions. All route through the same slide
 * machinery (`emitSlideFrame`), which moves BOTH frames as one push.
 */
const PUSH_DIRS: Record<string, { axis: "X" | "Y"; sign: 1 | -1 }> = {
  "push-left": { axis: "X", sign: -1 },
  "push-right": { axis: "X", sign: 1 },
  "push-up": { axis: "Y", sign: -1 },
  "push-down": { axis: "Y", sign: 1 },
  scroll: { axis: "Y", sign: -1 },
};

/** DM-1524: reveal-on-top transitions — the outgoing frame HOLDS beneath and
 *  hard-cuts at the window end while the incoming frame unveils on top via an
 *  animated `clip-path` (`wipe` = linear inset, `iris` = expanding circle). */
const REVEAL_KINDS = new Set(["wipe", "iris"]);

/**
 * Push-left (horizontal) / scroll (vertical) slide frame. Both emit the SAME
 * clipped frame group and a `slideKeyframes` track — they differ only in the
 * EXIT slide axis (`X`/`Y`) and the slid extent (viewport width / height). The
 * group rect always spans `width × height`. The frame's ENTRANCE is composed
 * separately from `enter` (DM-1414): a slide frame after a crossfade fades in,
 * after a different-axis slide slides in on the predecessor's axis, etc.
 * Extracted from generateAnimatedSvg (DM-1375), mirroring emit*Frame.
 */
/** The keyframe-window percentages a slide (push-left / scroll) frame places its
 *  slide CSS at. Grouped into one object (DM-1458) alongside `dims` so the
 *  same-typed args can't be transposed — and so the frame-rect size (`dims`) is
 *  no longer confusable with the slide extent (`exitSize`), which previously read
 *  as `width` passed twice at the push-left call site. */
interface SlideWindow {
  enterStartPct: string;
  startPct: string;
  holdEndPct: string;
  transEndPct: string;
}

function emitSlideFrame(
  i: number, svgContent: string, exitAxis: "X" | "Y", exitDelta: number, enter: SlideEnter,
  dims: { width: number; height: number },
  win: SlideWindow,
  totalSec: number, holdLastFrame: boolean,
): { group: string; keyframe: string } {
  const group = `  <g class="f f-${i}"><clipPath id="fc-${i}"><rect width="${dims.width}" height="${dims.height}" /></clipPath><g clip-path="url(#fc-${i})" class="fp fp-${i}">\n${svgContent}\n  </g></g>`;
  const keyframe = slideKeyframes(i, exitAxis, exitDelta, enter, win.enterStartPct, win.startPct, win.holdEndPct, win.transEndPct, win.enterStartPct, win.transEndPct, totalSec, holdLastFrame);
  return { group, keyframe };
}

/**
 * DM-1524: emit a `wipe` / `iris` reveal frame. The frame is painted at full
 * opacity through its whole window and hard-cut out at the end (`step-end`), so
 * it HOLDS solid beneath whatever reveals on top NEXT. When it was itself entered
 * from a `wipe`/`iris` predecessor (`entranceReveal != null`), an inner
 * `<g class="fr-i">` wrapper unveils this frame on top of the (still-painted)
 * predecessor via an animated `clip-path` over the entrance window [enter..start]
 * — a linear `inset(...)` for `wipe`, an expanding `circle(...)` for `iris` — and
 * RESTS fully revealed (identity clip). `clip-path` + opacity only; no filter.
 */
function emitRevealFrame(
  i: number,
  svgContent: string,
  entranceReveal: "wipe" | "iris" | null,
  dims: { width: number; height: number },
  win: { revealEnterStartPct: string; startPct: string; holdEndPct: string; transEndPct: string },
  totalSec: number,
  holdLastFrame: boolean,
  /** DM-1550: named/raw CSS easing for the clip-path reveal segment. Default linear. */
  revealEasing?: string,
): { group: string; keyframe: string } {
  const { revealEnterStartPct, startPct, transEndPct } = win;
  // Opacity ON-window: visible from the entrance (or its own start) through the
  // transition end (or 100% for a held last frame), then hard-cut off.
  const onStart = entranceReveal != null ? revealEnterStartPct : startPct;
  const onStartNum = parseFloat(onStart);
  const beforeOn = padBefore(onStartNum, KEYFRAME_EPSILON.cull, 3);

  let opacityKf: string;
  let onEnd: string;
  if (holdLastFrame) {
    onEnd = "100";
    opacityKf = `
    @keyframes fv-${i} {
      0% { opacity: 0; }
      ${beforeOn}% { opacity: 0; }
      ${onStartNum.toFixed(3)}% { opacity: 1; }
      100% { opacity: 1; }
    }`;
  } else {
    onEnd = transEndPct;
    const onEndNum = parseFloat(transEndPct);
    const afterOn = padAfter(onEndNum, KEYFRAME_EPSILON.cull, 3);
    opacityKf = `
    @keyframes fv-${i} {
      0% { opacity: 0; }
      ${beforeOn}% { opacity: 0; }
      ${onStartNum.toFixed(3)}% { opacity: 1; }
      ${onEndNum.toFixed(3)}% { opacity: 1; }
      ${afterOn}% { opacity: 0; }
      100% { opacity: 0; }
    }`;
  }

  // Reveal clip on the inner wrapper (only when entered via a reveal).
  let revealKf = "";
  let inner = svgContent;
  if (entranceReveal != null) {
    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const r = Math.ceil(Math.hypot(dims.width / 2, dims.height / 2));
    const [hidden, shown] = entranceReveal === "wipe"
      ? ["inset(0 100% 0 0)", "inset(0 0 0 0)"]
      : [`circle(0px at ${cx}px ${cy}px)`, `circle(${r}px at ${cx}px ${cy}px)`];
    const beforeEnter = padBefore(parseFloat(revealEnterStartPct), KEYFRAME_EPSILON.slide, 2);
    // DM-1550: apply the easing to the reveal SEGMENT only (enter → start) via a
    // per-keyframe `animation-timing-function` on the `revealEnterStartPct` stop
    // — the timing function declared at a keyframe governs the interval starting
    // there — leaving the surrounding holds linear. A sampled spring `linear(...)`
    // rings past full-reveal and back, so its overshoot shows as the wipe/iris
    // edge bouncing at the boundary before settling (rests at the identity clip).
    const revealTf = revealEasing != null ? ` animation-timing-function: ${revealEasing};` : "";
    revealKf = `
    @keyframes fr-${i} {
      0%, ${beforeEnter}% { clip-path: ${hidden}; }
      ${revealEnterStartPct} { clip-path: ${hidden};${revealTf} }
      ${startPct} { clip-path: ${shown}; }
      100% { clip-path: ${shown}; }
    }
    .fr-${i} { animation: fr-${i} ${totalSec.toFixed(2)}s linear infinite; }`;
    inner = `<g class="fr-${i}">\n${svgContent}\n  </g>`;
  }

  const group = `  <g class="f f-${i}">\n${inner}\n  </g>`;
  const keyframe = `${opacityKf}${buildDisplayKeyframes(`fd-${i}`, onStart, onEnd, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s step-end infinite, fd-${i} ${totalSec.toFixed(2)}s step-end infinite; }${revealKf}`;
  return { group, keyframe };
}

/**
 * Render a frame's overlays (typing / tap / svg / blink), in declaration order,
 * to parallel group-markup + keyframe-css arrays. The cursor overlay is global
 * (one per scene) and stays in generateAnimatedSvg. Extracted from
 * generateAnimatedSvg (DM-1375).
 */
function emitFrameOverlays(
  frame: AnimationFrame, i: number, timeOffset: number, totalDuration: number, totalSec: number,
): { groups: string[]; keyframes: string[] } {
  const groups: string[] = [];
  const keyframes: string[] = [];
  if (frame.overlays != null) {
    for (const overlay of frame.overlays) {
      if (overlay.kind === "typing") {
        const { svgMarkup, css } = renderTypingOverlay(overlay, i, timeOffset, timeOffset + frame.duration, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      } else if (overlay.kind === "tap") {
        const { svgMarkup, css } = renderTapOverlay(overlay, i, timeOffset, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      } else if (overlay.kind === "svg") {
        const { svgMarkup, css } = renderSvgOverlay(overlay, i, timeOffset, frame.duration, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      } else if (overlay.kind === "blink") {
        const { svgMarkup, css } = renderBlinkOverlay(overlay, i, timeOffset, timeOffset + frame.duration, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      } else if (overlay.kind === "shine") {
        const { svgMarkup, css } = renderShineOverlay(overlay, i, timeOffset, frame.duration, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      }
    }
  }
  return { groups, keyframes };
}

export function generateAnimatedSvg(config: AnimationConfig): string {
  const { width, height } = config;
  // DM-1145: guard against cross-frame id collisions (reused/cached svgContent).
  let frames = dedupeFrameIds(config.frames);

  const totalDuration = frames.reduce(
    (sum, f) => sum + frameAdvanceMs(f),
    0,
  );
  const totalSec = totalDuration / 1000;

  // DM-1319: re-anchor any embedded-animation frame (a `cast` / `template` frame
  // whose svgContent is itself an animated SVG) so its internal timeline starts
  // when the frame becomes visible — at its cumulative master-loop offset — and
  // holds before/after, instead of running on the shared document origin (which
  // desyncs the recording to its back half). Done once now that the master
  // period (`totalDuration`) and per-frame offsets are known.
  if (frames.some((f) => f.embeddedAnimationPeriodMs != null)) {
    let offset = 0;
    frames = frames.map((f) => {
      const startMs = offset;
      offset += frameAdvanceMs(f);
      if (f.embeddedAnimationPeriodMs == null) return f;
      return {
        ...f,
        svgContent: offsetEmbeddedAnimatedSvgTimeline(f.svgContent, {
          periodMs: f.embeddedAnimationPeriodMs,
          startMs,
          masterMs: totalDuration,
        }),
      };
    });
  }

  // Pre-compute each frame's start-of-window percentage — the only field
  // `buildIntraFrameAnimationCss` reads. (The per-frame loop below recomputes the
  // hold / transition windows it needs locally via `pct()`, so they aren't
  // collected here.)
  const frameTiming: { startPct: number[] } = { startPct: [] };
  {
    let t = 0;
    for (const f of frames) {
      frameTiming.startPct.push((t / totalDuration) * 100);
      t += f.duration + transitionDurationMs(f);
    }
  }

  // Every sequence composites: each frame is emitted as a complete, internally
  // z-ordered `<g class="f f-N">` sub-SVG and switched/faded by opacity.
  //
  // There used to be an element-merge fast path (`mergeFrames`) for cut-only
  // sequences that flattened all frames into one de-duplicated tree to save
  // bytes. DM-854 took crossfade off it (it dropped per-frame z-order and
  // step-end-switched instead of fading); DM-865 then showed it also mis-renders
  // *near-identical* frames — the same DOM evolved across frames, as produced by
  // continuous-session capture — because differing text in a shared element slot
  // can't be gated per frame (a bare text node carries no class, and a `<tspan>`
  // with `visibility:hidden` still advances layout, shifting the surviving
  // glyph). Compositing has neither problem. The dedup size win can be recovered
  // later as `<defs>`/symbol-level glyph sharing across intact frame groups,
  // which preserves each frame's layout (tracked with DM-854/DM-865).
  const frameGroups: string[] = [];
  // DM-1524: shine-transition sweep overlays, painted ABOVE every frame group so
  // the glint reads on top of the cross-dissolve regardless of frame z-order.
  const shineTransitionGroups: string[] = [];
  const keyframes: string[] = [];
  let timeOffset = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const transDur = transitionDurationMs(frame);
    const transType = frame.transition?.type ?? "crossfade";

    const startPct = pct(timeOffset, totalDuration);
    const holdEndPct = pct(timeOffset + frame.duration, totalDuration);
    const transEndPct = pct(timeOffset + frame.duration + transDur, totalDuration);

    const prevFrame = i > 0 ? frames[i - 1] : null;
    const prevType = prevFrame?.transition?.type;
    // DM-1414: a frame's ENTRANCE is driven by the PREVIOUS frame's transition
    // type (how it hands off TO this frame), independently of this frame's OWN
    // type (how it exits TO the next). So a push/scroll frame entered from a
    // crossfade fades in; entered from a different-axis slide it slides in on the
    // predecessor's axis; entered from the same slide it slides in (unchanged).
    // Same-type chains stay byte-identical — only genuinely-mixed chains differ.
    // DM-1524: a directional-push predecessor hands off with the incoming frame
    // entering from the OPPOSITE side (enter offset = -sign·size). `crossfade`,
    // `shine`, and `zoom-*` all overlap-fade the incoming in. `wipe`/`iris`
    // predecessors reveal the incoming on top (handled in emitRevealFrame, not
    // here), so they appear at their own start → `cut`.
    const prevDir = prevType != null ? PUSH_DIRS[prevType] : undefined;
    const slideEnter: SlideEnter =
      prevDir != null
        ? { mode: "slide", axis: prevDir.axis, enterOffset: -prevDir.sign * (prevDir.axis === "X" ? width : height) }
      : prevType === "crossfade" || prevType === "shine" || prevType === "zoom-in" || prevType === "zoom-out"
        ? { mode: "fade" }
      : { mode: "cut" }; // cut / magic-move / wipe / iris / first frame — appears at its own start
    // DM-898: a frame entered from a magic-move transition appears at its own
    // start (= the predecessor's transition end), NOT overlap-faded — the
    // magic-move bridge layer already covered the window, so a crossfade
    // overlap here would double-show the next frame on top of the bridge.
    const entersViaMagicMove = prevType === "magic-move" && prevFrame?.magicMove != null;
    // A slide or fade entrance OVERLAPS the predecessor's transition window — the
    // next frame is already sliding/fading in while the current one slides/fades
    // out, so its show window opens at `timeOffset - prevTransDur`.
    const entersViaOverlap = slideEnter.mode === "slide" || slideEnter.mode === "fade";
    const prevTransDur = prevFrame != null ? transitionDurationMs(prevFrame) : DEFAULT_TRANSITION_MS;
    const enterStartPct = entersViaOverlap
      ? pct(timeOffset - prevTransDur, totalDuration)
      : startPct;

    // DM-1207: the last frame holds solid to 100% (no loop cross-dissolve)
    // unless `loopFade` is set — same rule the crossfade/cut path applies via
    // DM-1148 (see emitCrossfadeOrCutFrame). For the slide paths (push-left /
    // scroll) this means: slide in, then hold (no slide-out / fade-out).
    const holdLastFrame = i === frames.length - 1 && config.loopFade !== true;

    const ownDir = PUSH_DIRS[transType];
    const ownReveal = REVEAL_KINDS.has(transType);
    const prevReveal = prevType != null && REVEAL_KINDS.has(prevType);

    if (ownDir != null) {
      // DM-609 / DM-1524: directional push/scroll — exit slides out by the signed
      // `exitDelta` on `ownDir.axis` (push-left/right over width, scroll/push-up/
      // push-down over height); enter per `slideEnter`. The parallel `fd-${i}`
      // display snap (inside slideKeyframes) lets the browser skip painting this
      // frame while it's fully off-screen between cycles (DM-599).
      const size = ownDir.axis === "X" ? width : height;
      const exitDelta = ownDir.sign * size;
      const r = emitSlideFrame(i, frame.svgContent, ownDir.axis, exitDelta, slideEnter, { width, height }, { enterStartPct, startPct, holdEndPct, transEndPct }, totalSec, holdLastFrame);
      frameGroups.push(r.group);
      keyframes.push(r.keyframe);

    } else if (ownReveal || prevReveal) {
      // DM-1524: wipe / iris reveal-on-top. This frame HOLDS beneath (opacity 1
      // through its window) and hard-cuts out; a `wipe`/`iris` predecessor's
      // handoff instead UNVEILS this frame on top via an animated `clip-path`
      // over the entrance window. The reveal kind is the PREVIOUS type; the
      // hold-then-cut exit serves whatever reveals on top NEXT.
      const entranceReveal = prevReveal ? (prevType as "wipe" | "iris") : null;
      const revealEnterStartPct = entranceReveal != null ? pct(Math.max(0, timeOffset - prevTransDur), totalDuration) : startPct;
      // DM-1550: the reveal's easing is authored on the PREVIOUS frame's
      // transition (the one that unveils THIS frame). Resolve any named preset
      // (incl. the sampled springs) to a CSS easing string.
      const revealEasing = entranceReveal != null ? resolveEasingPreset(prevFrame?.transition?.easing) : undefined;
      const r = emitRevealFrame(i, frame.svgContent, entranceReveal, { width, height }, { revealEnterStartPct, startPct, holdEndPct, transEndPct }, totalSec, holdLastFrame, revealEasing);
      frameGroups.push(r.group);
      keyframes.push(r.keyframe);

    } else if (transType === "magic-move" && frame.magicMove != null) {
      // DM-898: magic-move. Frame i holds [start..holdEnd] then HARD-CUTS out;
      // a bridge composite covers the transition window [holdEnd..transEnd],
      // inside which matched elements slide prev→next, added elements fade in,
      // and removed elements fade out. The next frame cuts in at transEnd
      // (= its own start). The bridge's start state matches the prev frame's
      // final paint and its end state the next frame's initial paint, so both
      // hard cuts are seamless. (When `frame.magicMove` is null the type falls
      // through to the crossfade branch below — the documented fallback.)
      const r = emitMagicMoveFrame(i, frame, frame.magicMove, startPct, holdEndPct, transEndPct, totalSec);
      frameGroups.push(...r.groups);
      keyframes.push(...r.keyframes);

    } else {
      // Crossfade or cut: opacity in/out (see emitCrossfadeOrCutFrame). The
      // crossfade fade-in OVERLAPS the previous frame's fade-out, so its visible
      // window starts at fadeInStartPct — which depends on the loop's overlap
      // state (entersViaMagicMove / prevTransDur), so it's computed here.
      const fadeInStartPct = (i > 0 && !entersViaMagicMove)
        ? pct(Math.max(0, timeOffset - prevTransDur), totalDuration)
        : startPct;
      // DM-1148: the last frame holds solid to 100% (no loop cross-dissolve)
      // unless `loopFade` is set. Only the crossfade path fades — cut already
      // holds-then-cuts — so this is a no-op for cut frames.
      const isCutFrame = transType === "cut" || transDur === 0;
      const holdToEnd = i === frames.length - 1 && config.loopFade !== true && !isCutFrame;
      // DM-1524: `shine` and `zoom-*` ride the crossfade opacity machinery (the
      // frame fades in/out normally); the extra motion is layered on top. A
      // `zoom-*` PREDECESSOR gives THIS incoming frame a scale dolly over its
      // entrance window (`zoom-in` grows 0.9→1, `zoom-out` settles 1.1→1); the
      // element rests at scale(1). Passing the crossfade type through keeps
      // `isCut` false so the frame cross-dissolves.
      const entranceScale = (prevType === "zoom-in" || prevType === "zoom-out")
        ? { fromScale: prevType === "zoom-in" ? 0.9 : 1.1, enterStartPct, startPct, width, height,
            // DM-1550: the dolly easing is authored on the zoom transition that
            // drives THIS frame's entrance (the previous frame's transition).
            easing: resolveEasingPreset(prevFrame?.transition?.easing) }
        : null;
      const r = emitCrossfadeOrCutFrame(i, frame, transType, transDur, { startPct, holdEndPct, transEndPct, fadeInStartPct }, totalSec, holdToEnd, entranceScale);
      frameGroups.push(...r.groups);
      keyframes.push(...r.keyframes);

      // DM-1524: a `shine` transition sweeps a gradient highlight across the whole
      // viewport over the handoff window [holdEnd..transEnd] on TOP of the
      // cross-dissolve (the shared helper, also behind the `shine` overlay preset).
      if (transType === "shine") {
        const sweep = buildShineSweep({ id: `tr${i}`, x: 0, y: 0, width, height, startPct: holdEndPct, endPct: transEndPct, totalSec });
        shineTransitionGroups.push(sweep.markup);
        keyframes.push(sweep.css);
      }
    }

    // Overlays (typing / tap / svg / blink), in declaration order.
    const ov = emitFrameOverlays(frame, i, timeOffset, totalDuration, totalSec);
    frameGroups.push(...ov.groups);
    keyframes.push(...ov.keyframes);

    timeOffset += frame.duration + transDur;
  }

  // Compose final SVG with XML declaration for proper UTF-8
  const sharedDefsMarkup = config.sharedDefs ?? "";
  const animationCss = buildIntraFrameAnimationCss(frames, frameTiming, totalSec);
  // DM-603: per-frame viewBox-cull keyframes — each frame's caller pre-ran
  // `cullElementsOutsideViewBox()` and we splice the resulting blocks into the scene-wide
  // <style>. The keyframes reference `var(--scene-dur)`; we expose that
  // variable on the root selector below.
  const cullCss = frames.map((f) => f.cullCss ?? "").filter((s) => s !== "").join("\n");
  // Cursor overlay (DM-277). The frame start times let the resolver pick
  // which frame's selector matches apply at each event's timestamp.
  let overlayMarkup = "";
  if (config.cursorOverlay != null && config.cursorOverlay.events.length > 0) {
    const frameStarts: number[] = [];
    let acc = 0;
    for (const f of frames) {
      frameStarts.push(acc);
      acc += frameAdvanceMs(f);
    }
    const resolved = resolveCursorScript(
      config.cursorOverlay,
      totalDuration,
      frameStarts,
      config.resolveSelector ?? null,
      config.resolveCursorAt ?? null,
    );
    overlayMarkup = "\n" + cursorOverlayMarkup(resolved.positions, resolved.clicks, resolved.style, totalDuration, resolved.cursorTimeline);
  }
  // Canvas background rect — only when a non-transparent background is given.
  // Default (none / transparent) emits nothing so the SVG composites over the
  // host page, matching the single-frame `transparentRootBgRect` path (DM-554).
  const bg = config.background;
  const canvasBgRect = (bg != null && !isTransparentBackground(bg))
    ? `  <rect width="${width}" height="${height}" fill="${bg}" />\n`
    : "";
  const a11y = rootSvgA11y(config.title, config.desc);
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${a11y.roleAttr}>${a11y.markup}
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
${config.fontFaceCss != null && config.fontFaceCss !== "" ? config.fontFaceCss + "\n" : ""}    :root { --scene-dur: ${totalSec.toFixed(2)}s; }
    .f { opacity: 0; visibility: hidden; }
    ${keyframes.join("\n")}${animationCss}${cullCss === "" ? "" : "\n" + cullCss}
  </style>
  <g clip-path="url(#viewport-clip)">
${canvasBgRect}${frameGroups.join("\n")}${shineTransitionGroups.length > 0 ? "\n" + shineTransitionGroups.join("\n") : ""}${overlayMarkup}
  </g>
</svg>`;
  return out;
}

/**
 * Wrap `text` into lines no wider than `maxChars` monospace cells, the way a
 * browser textarea does: break on spaces, char-break a word longer than the
 * field, and honor explicit newlines. `maxChars === Infinity` → no wrap (one
 * line per explicit-newline paragraph), preserving the pre-DM-840 behavior for
 * overlays with no `bgWidth`. DM-840.
 */
function wrapTypingText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (maxChars === Infinity) { lines.push(paragraph); continue; }
    if (paragraph === "") { lines.push(""); continue; }
    let cur = "";
    for (let word of paragraph.split(" ")) {
      // A single word wider than the line char-breaks across lines.
      while (word.length > maxChars) {
        if (cur !== "") { lines.push(cur); cur = ""; }
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (cur === "") cur = word;
      else if ((cur + " " + word).length <= maxChars) cur += " " + word;
      else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  return lines;
}

// Default overlay timings/metrics, applied when the overlay omits them.
const DEFAULT_TYPING_DELAY_MS = 300;
const DEFAULT_TYPING_SPEED_CPS = 60;
const DEFAULT_OVERLAY_FONT_SIZE = 14;
/**
 * Monospace cell advance as a fraction of font size — the FALLBACK estimate,
 * used only when the overlay font can't be resolved for measurement (e.g. a
 * platform without the monospace face). When the font resolves, DM-1518 drives
 * both the reveal and the caret off fontkit-measured per-glyph advances so the
 * caret sits at the true text edge instead of ~0.5px/char behind it.
 */
const MONO_CHAR_WIDTH_RATIO = 0.6;
/** The `<text>` font stack the reveal paints — measured via `resolveFontKey`. */
const OVERLAY_TYPING_FONT = "'SF Mono', Menlo, Monaco, monospace";
/**
 * Above this typed-character count the per-keystroke discrete reveal falls back
 * to a linear sweep (2 stops/line) to keep the emitted CSS bounded. The caret
 * still lands exactly on the measured edge at each line boundary; only the
 * intra-line stepping is coarsened. Typing overlays are field entries (names,
 * emails, queries), so this ceiling is rarely reached.
 */
const MAX_DISCRETE_TYPING_CHARS = 300;
const DEFAULT_TAP_DELAY_MS = 50;
const DEFAULT_BLINK_PERIOD_MS = 1000;

/** Deterministic PRNG (mulberry32) so humanized jitter stays byte-stable per run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, used to seed the jitter PRNG off the text. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * DM-1518: measure per-glyph advances (px) for each wrapped line via fontkit
 * against the resolved overlay monospace font, returning cumulative x-offsets
 * (`cum[li][k]` = the caret x after `k` glyphs of line `li`). Falls back to the
 * uniform 0.6em estimate when the font can't be resolved. `chars` is the
 * per-line code-point array (so surrogate pairs count as one glyph, matching
 * the reveal + caret stepping).
 */
function measureTypingLines(
  chars: string[][], fontSize: number,
): { cum: number[][]; charWidth: number; measured: boolean } {
  const estimate = fontSize * MONO_CHAR_WIDTH_RATIO;
  let font: ReturnType<typeof getFontInstance> = null;
  try {
    font = getFontInstance(resolveFontKey(OVERLAY_TYPING_FONT), 400, fontSize, 0);
  } catch {
    font = null;
  }
  if (font == null) {
    const cum = chars.map((line) => {
      const c = [0];
      for (let i = 0; i < line.length; i++) c.push(c[i] + estimate);
      return c;
    });
    return { cum, charWidth: estimate, measured: false };
  }
  const scale = fontSize / font.unitsPerEm;
  const advOf = (ch: string): number => {
    const cp = ch.codePointAt(0);
    if (cp == null) return estimate;
    const g = font.glyphForCodePoint(cp);
    const adv = (g?.advanceWidth ?? 0) * scale;
    return adv > 0 ? adv : estimate;
  };
  const cum = chars.map((line) => {
    const c = [0];
    for (let i = 0; i < line.length; i++) c.push(c[i] + advOf(line[i]));
    return c;
  });
  return { cum, charWidth: estimate, measured: true };
}

/** One revealed glyph's placement + reveal time, precomputed once (DM-1518). */
interface TypedGlyph { li: number; edge: number; appearMs: number }

/**
 * DM-1518: the shared reveal plan the line clips AND the caret ride, so they
 * can never desync. One `TypedGlyph` per typed character, carrying the line it
 * lands on, the caret x AFTER it (its right edge, from the measured advances),
 * and the absolute time it appears. `mode: "paste"` reveals every glyph at
 * `typeStartMs`; `mode: "type"` spaces them by the (optionally jittered) speed,
 * scaled to fill `[typeStartMs, typeStartMs + effTypeDur]`.
 */
function buildTypingPlan(
  chars: string[][], cum: number[][], overlay: TypingOverlay,
  speed: number, typeStartMs: number, effTypeDur: number,
): TypedGlyph[] {
  const glyphs: TypedGlyph[] = [];
  const paste = overlay.mode === "paste";
  const jitter = paste ? 0 : Math.max(0, Math.min(1, overlay.jitter ?? 0));
  const rng = mulberry32(hashString(overlay.text) ^ 0x9e3779b9);
  // First pass: raw (jittered) per-glyph delays and their running sum.
  const delays: number[] = [];
  let rawTotal = 0;
  chars.forEach((line, li) => {
    for (let k = 0; k < line.length; k++) {
      const d = paste ? 0 : Math.max(speed * 0.25, speed * (1 + (rng() * 2 - 1) * jitter));
      rawTotal += d;
      delays.push(d);
      glyphs.push({ li, edge: cum[li][k + 1], appearMs: 0 });
    }
  });
  // Second pass: normalize delays into the effective type window so the last
  // glyph lands exactly at typeStartMs + effTypeDur (the measured text edge is
  // therefore reached precisely when typing "finishes").
  const scale = rawTotal > 0 ? effTypeDur / rawTotal : 0;
  let acc = 0;
  for (let i = 0; i < glyphs.length; i++) {
    acc += delays[i];
    glyphs[i].appearMs = paste ? typeStartMs : typeStartMs + acc * scale;
  }
  return glyphs;
}

/** Monotone keyframe-stop builder: nudges each stop past the previous so equal
 *  rounded percents don't collapse (later CSS declaration would win). */
function monotoneStops(): { push: (pn: number, decl: string) => void; stops: string[] } {
  const stops: string[] = [];
  let last = -Infinity;
  return {
    stops,
    push(pn: number, decl: string): void {
      const p = Math.max(pn, last + 0.01);
      stops.push(`${p.toFixed(2)}% { ${decl} }`);
      last = p;
    },
  };
}

/**
 * DM-1518 typewriter reveal: one `<text>` per wrapped line, each unveiled by a
 * width-growing clip. The clip's right edge steps to the fontkit-MEASURED
 * cumulative advance as each glyph is typed (character-by-character), so the
 * revealed text edge — and the caret riding the same plan — sit exactly where
 * the glyphs paint. Below `MAX_DISCRETE_TYPING_CHARS` the reveal steps per
 * keystroke (`step-end`); above it, it sweeps linearly between the line's
 * first/last glyph for bounded CSS.
 */
function buildTypingLines(
  chars: string[][], overlay: TypingOverlay, id: string,
  cum: number[][], glyphs: TypedGlyph[], discrete: boolean,
  lineHeight: number, fontSize: number, textHeight: number, hiddenW: string, color: string,
  totalDuration: number, holdEndPct: string, disappearPct: string, totalSec: number,
): { parts: string[]; cssRules: string[] } {
  const parts: string[] = [];
  const cssRules: string[] = [];

  chars.forEach((line, li) => {
    const lineText = line.join("");
    const lineY = overlay.y + li * lineHeight;
    const clipId = `${id}-clip${li}`;
    // +1px of slack so the last glyph's antialiased right edge never clips.
    const fullWidth = cum[li][line.length] + 1;
    const lineGlyphs = glyphs.filter((g) => g.li === li);

    parts.push(`  <defs><clipPath id="${clipId}"><rect class="${id}-rev${li}" x="${overlay.x}" y="${lineY - fontSize}" width="${hiddenW}" height="${textHeight}" /></clipPath></defs>`);
    parts.push(
      `  <text class="${id}-text" x="${overlay.x}" y="${lineY}" fill="${color}" font-size="${fontSize}" font-family="${OVERLAY_TYPING_FONT}" clip-path="url(#${clipId})">${escapeHtml(lineText)}</text>`,
    );

    if (lineGlyphs.length === 0) {
      // Empty wrapped line (blank paragraph) — nothing to reveal.
      cssRules.push(`
    @keyframes ${id}-rev${li} { 0%, 100% { width: ${hiddenW}; } }
    .${id}-rev${li} { animation: ${id}-rev${li} ${totalSec.toFixed(2)}s step-end infinite; }`);
      return;
    }

    const startPn = pctNum(lineGlyphs[0].appearMs, totalDuration);
    if (discrete) {
      const b = monotoneStops();
      // Hold hidden until this line's first glyph, then step the clip to each
      // glyph's measured edge as it is typed.
      b.push(0, `width: ${hiddenW};`);
      b.push(Math.max(0.01, startPn - 0.01), `width: ${hiddenW};`);
      for (const g of lineGlyphs) b.push(pctNum(g.appearMs, totalDuration), `width: ${(g.edge + 1).toFixed(2)}px;`);
      // step-end holds each width until the next stop, so the reveal is a clean
      // per-keystroke staircase locked to the caret (same plan, same edges).
      cssRules.push(`
    @keyframes ${id}-rev${li} { ${b.stops.join(" ")} ${holdEndPct} { width: ${fullWidth}px; } ${disappearPct}, 100% { width: ${hiddenW}; } }
    .${id}-rev${li} { animation: ${id}-rev${li} ${totalSec.toFixed(2)}s step-end infinite; }`);
    } else {
      // Bounded-CSS fallback: linear sweep between the line's first and last
      // glyph. Endpoints use the measured edges, so the parked caret is exact.
      const endPn = pctNum(lineGlyphs[lineGlyphs.length - 1].appearMs, totalDuration);
      const startPct = `${Math.max(0, startPn).toFixed(2)}%`;
      const endPct = `${Math.max(startPn + 0.01, endPn).toFixed(2)}%`;
      cssRules.push(`
    @keyframes ${id}-rev${li} { 0%, ${startPct} { width: ${hiddenW}; } ${endPct} { width: ${fullWidth}px; } ${holdEndPct} { width: ${fullWidth}px; } ${disappearPct}, 100% { width: ${hiddenW}; } }
    .${id}-rev${li} { animation: ${id}-rev${li} ${totalSec.toFixed(2)}s linear infinite; }`);
    }
  });
  return { parts, cssRules };
}

/**
 * DM-870 / DM-1518: blinking insertion caret. It rides the SAME reveal plan as
 * the text (`glyphs`), stepping to each glyph's measured right edge the instant
 * that glyph appears (`step-end`), so it is always glued to the true trailing
 * edge of the visible text — never lagging behind it. Parks at the text end and
 * blinks until the overlay disappears. Returns empty arrays when no caret is
 * requested.
 */
function buildTypingCaret(
  overlay: TypingOverlay, id: string, color: string,
  glyphs: TypedGlyph[], lineHeight: number, fontSize: number,
  typeStartPct: string, typeStartMs: number, textEndMs: number, holdEndMs: number, holdEndPct: string, disappearPct: string,
  totalDuration: number, totalSec: number,
): { parts: string[]; cssRules: string[] } {
  const parts: string[] = [];
  const cssRules: string[] = [];
  if (overlay.caret != null && overlay.caret !== false && glyphs.length > 0) {
    const caretOpts = typeof overlay.caret === "object" ? overlay.caret : {};
    const caretColor = caretOpts.color ?? color;
    const caretW = caretOpts.width ?? 2;
    const blinkMs = caretOpts.blinkMs ?? 530;
    const lastG = glyphs[glyphs.length - 1];
    const endX = lastG.edge;
    const endY = lastG.li * lineHeight;

    // Position track: hold at the first line's left margin until typing begins,
    // then jump to each glyph's measured edge as it appears (step-end), then
    // park at the text end through the blink + disappear.
    const b = monotoneStops();
    b.push(0, `transform: translate(0px, 0px);`);
    b.push(Math.max(0.01, pctNum(typeStartMs, totalDuration)), `transform: translate(0px, 0px);`);
    for (const g of glyphs) b.push(pctNum(g.appearMs, totalDuration), `transform: translate(${g.edge.toFixed(2)}px, ${(g.li * lineHeight).toFixed(2)}px);`);
    const posStops = [
      ...b.stops,
      `${holdEndPct}, 100% { transform: translate(${endX.toFixed(2)}px, ${endY.toFixed(2)}px); }`,
    ];

    // Blink: invisible until typing starts, solid through typing, then toggle
    // on/off every half-period until the overlay disappears.
    const blinkStops: string[] = [
      `0%, ${typeStartPct} { opacity: 0; }`,
      `${pct(typeStartMs + 30, totalDuration)} { opacity: 1; }`,
      `${pct(textEndMs, totalDuration)} { opacity: 1; }`,
    ];
    let t = textEndMs + blinkMs / 2;
    let on = false;
    while (t < holdEndMs) {
      blinkStops.push(`${pct(t, totalDuration)} { opacity: ${on ? 1 : 0}; }`);
      t += blinkMs / 2;
      on = !on;
    }
    blinkStops.push(`${disappearPct}, 100% { opacity: 0; }`);

    parts.push(
      `  <rect class="${id}-caret" x="${overlay.x}" y="${overlay.y - fontSize + 2}" width="${caretW}" height="${fontSize}" fill="${caretColor}" />`,
    );
    // The position track is step-end (per-keystroke jumps, matching real typing
    // and the discrete reveal); the blink is step-end too.
    cssRules.push(`
    @keyframes ${id}-caret-pos { ${posStops.join(" ")} }
    @keyframes ${id}-caret-blink { ${blinkStops.join(" ")} }
    .${id}-caret { animation: ${id}-caret-pos ${totalSec.toFixed(2)}s step-end infinite, ${id}-caret-blink ${totalSec.toFixed(2)}s step-end infinite; }`);
  }
  return { parts, cssRules };
}

function renderTypingOverlay(
  overlay: TypingOverlay,
  frameIdx: number,
  frameStart: number,
  frameEnd: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const delay = overlay.delay ?? DEFAULT_TYPING_DELAY_MS;
  const speed = overlay.speed ?? DEFAULT_TYPING_SPEED_CPS;
  const fontSize = overlay.fontSize ?? DEFAULT_OVERLAY_FONT_SIZE;
  const charWidth = fontSize * MONO_CHAR_WIDTH_RATIO;
  // DM-1205: the typewriter reveal hides not-yet-typed text with a width-0 clip
  // rect. Chrome renders a zero-area clip path as "clip everything" (text
  // hidden, correct), but WebKit/Safari treats an EMPTY clip as "no clip" and
  // paints the element in full — so on multi-line overlays every line past the
  // first showed its whole text immediately (the shared text opacity is already
  // 1 while the line waits its turn). Hiding with a tiny non-zero width keeps
  // the clip non-empty so WebKit clips it too; 0.01px reveals no visible pixel.
  const hiddenW = "0.01px";
  const lineHeight = Math.round(fontSize * 1.35);
  const color = overlay.color ?? "#e6edf3";
  const typeStartMs = frameStart + delay;
  const id = `t${frameIdx}`;

  // DM-840 / DM-1134: wrap to `wrapWidth` so typed text behaves like a browser
  // field (textarea) — wrapping to the next line instead of running off the
  // right edge. Text starts at overlay.x and the bg rect starts at overlay.x-2
  // with the mask width, so the usable text width is wrapWidth-4. With no wrap
  // width we keep the original single-line behavior (maxChars = Infinity).
  // `wrapWidth` supersedes the deprecated `bgWidth` (which fed both wrap + mask).
  const wrapWidth = overlay.wrapWidth ?? overlay.bgWidth;
  const maxLineWidth = wrapWidth != null ? wrapWidth - 4 : Infinity;
  const maxChars = maxLineWidth === Infinity ? Infinity : Math.max(1, Math.floor(maxLineWidth / charWidth));
  const lines = wrapTypingText(overlay.text, maxChars);
  // Per-line code-point arrays (astral pairs count as one glyph) drive both the
  // reveal stepping and the caret, so they can't desync.
  const chars = lines.map((l) => [...l]);
  // DM-1518: fontkit-measured cumulative advances per line — the caret + reveal
  // ride these exact edges instead of the old uniform 0.6em estimate.
  const { cum } = measureTypingLines(chars, fontSize);
  const visibleChars = Math.max(1, chars.reduce((n, l) => n + l.length, 0));
  const longestLineWidth = cum.reduce((m, c) => Math.max(m, c[c.length - 1]), 0);

  const parts: string[] = [];
  const cssRules: string[] = [];

  // ── Timeline — all stops clamped to the frame so the overlay can't leak
  // across the cut into the next frame. `naturalEnd` is when typing finishes
  // at the requested speed; if that runs past the frame we compress the reveal
  // to fit. The fully-typed text then HOLDS until just before the frame ends
  // (the old hard 3 s cap cut long text off mid-type), then fades out.
  const disappearGap = 150;
  const naturalEndMs = typeStartMs + visibleChars * speed;
  const textEndMs = Math.min(naturalEndMs, Math.max(typeStartMs + 1, frameEnd - disappearGap));
  const effTypeDur = Math.max(1, textEndMs - typeStartMs);
  const holdEndMs = Math.max(textEndMs, frameEnd - disappearGap);
  const disappearMs = Math.min(frameEnd, holdEndMs + 100);
  const textHeight = fontSize + 4;
  const holdEndPct = pct(holdEndMs, totalDuration);
  const disappearPct = pct(disappearMs, totalDuration);

  // Background mask — grown to cover every wrapped line so the typed text
  // always lands on a clean field instead of the captured placeholder.
  // DM-1134: the mask is sized by `mask: { width, height, color }`, independent
  // of the wrap width; the legacy `bgColor` / `bgWidth` / `bgHeight` are the
  // deprecated fallbacks (`bgWidth` also fed the wrap above). Mask width
  // defaults to the wrap width, then to the longest typed line.
  const maskColor = overlay.mask?.color ?? overlay.bgColor;
  if (maskColor != null) {
    const bgW = overlay.mask?.width ?? wrapWidth ?? longestLineWidth + 8;
    const bgH = Math.max(overlay.mask?.height ?? overlay.bgHeight ?? fontSize + 6, lines.length * lineHeight + 6);
    const bgStartPct = pct(typeStartMs, totalDuration);
    parts.push(
      `  <rect class="${id}-bg" x="${overlay.x - 2}" y="${overlay.y - fontSize + 2}" width="${bgW}" height="${bgH}" fill="${maskColor}" rx="2" />`,
    );
    cssRules.push(`
    @keyframes ${id}-bg { 0%, ${bgStartPct} { opacity: 0; } ${pct(typeStartMs + 50, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${disappearPct}, 100% { opacity: 0; } }
    .${id}-bg { animation: ${id}-bg ${totalSec.toFixed(2)}s infinite; }`);
  }

  // DM-1518: the shared reveal plan — one entry per typed glyph, carrying the
  // line, the caret x AFTER it (its measured right edge), and its reveal time.
  // Both the line clips and the caret ride this plan, so they can't desync.
  const glyphs = buildTypingPlan(chars, cum, overlay, speed, typeStartMs, effTypeDur);
  const discrete = overlay.mode !== "paste" && visibleChars <= MAX_DISCRETE_TYPING_CHARS;

  // Typewriter reveal — one <text> per wrapped line, each unveiled by a width-
  // growing clip stepping to each glyph's measured edge as it is typed.
  const ln = buildTypingLines(chars, overlay, id, cum, glyphs, discrete, lineHeight, fontSize, textHeight, hiddenW, color, totalDuration, holdEndPct, disappearPct, totalSec);
  parts.push(...ln.parts);
  cssRules.push(...ln.cssRules);

  // Whole-overlay visibility — shared by every line's <text>.
  const typeStartPct = pct(typeStartMs, totalDuration);
  cssRules.push(`
    @keyframes ${id}-vis { 0%, ${typeStartPct} { opacity: 0; } ${pct(typeStartMs + 30, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${disappearPct}, 100% { opacity: 0; } }
    .${id}-text { animation: ${id}-vis ${totalSec.toFixed(2)}s infinite; }`);

  // Optional blinking insertion caret glued to the growing text edge. In paste
  // mode only the final edge matters, so the caret rides a single end stop.
  const caretGlyphs = overlay.mode === "paste" ? glyphs.slice(-1) : glyphs;
  const cr = buildTypingCaret(overlay, id, color, caretGlyphs, lineHeight, fontSize, typeStartPct, typeStartMs, textEndMs, holdEndMs, holdEndPct, disappearPct, totalDuration, totalSec);
  parts.push(...cr.parts);
  cssRules.push(...cr.cssRules);

  return { svgMarkup: parts.join("\n"), css: cssRules.join("") };
}

function renderTapOverlay(
  overlay: TapOverlay,
  frameIdx: number,
  frameStart: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const delay = overlay.delay ?? DEFAULT_TAP_DELAY_MS;
  const tapMs = frameStart + delay;
  const rippleDur = 500;
  const id = `tap${frameIdx}`;

  const tapStartPct = pct(tapMs, totalDuration);
  const tapPeakPct = pct(tapMs + rippleDur * 0.3, totalDuration);
  const tapEndPct = pct(tapMs + rippleDur, totalDuration);

  const svgMarkup = [
    `  <circle class="${id}" cx="${overlay.x}" cy="${overlay.y}" r="0" fill="rgba(255,255,255,0.35)" />`,
    `  <circle class="${id}-dot" cx="${overlay.x}" cy="${overlay.y}" r="7" fill="rgba(255,255,255,0.5)" />`,
  ].join("\n");

  const css = `
    @keyframes ${id} { 0%, ${tapStartPct} { r: 0; opacity: 0.4; } ${tapPeakPct} { r: 28; opacity: 0.2; } ${tapEndPct}, 100% { r: 35; opacity: 0; } }
    .${id} { animation: ${id} ${totalSec.toFixed(2)}s infinite; }
    @keyframes ${id}-dot { 0%, ${tapStartPct} { opacity: 0; } ${pct(tapMs + 20, totalDuration)} { opacity: 0.6; } ${tapPeakPct} { opacity: 0.2; } ${tapEndPct}, 100% { opacity: 0; } }
    .${id}-dot { animation: ${id}-dot ${totalSec.toFixed(2)}s infinite; }`;

  return { svgMarkup, css };
}

/**
 * DM-1542: shine / shimmer overlay — a swept gradient highlight over the box,
 * via the shared `buildShineSweep` helper. A one-shot sweep runs over [delay,
 * delay + duration] from frame start; `repeat` turns it into an ambient shimmer.
 * The helper carries the cross-engine + rest-at-identity guarantees.
 */
function renderShineOverlay(
  overlay: ShineOverlay,
  frameIdx: number,
  frameStart: number,
  frameHoldMs: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const delay = overlay.delay ?? 200;
  const duration = overlay.duration ?? 900;
  const sweepStartMs = frameStart + delay;
  const sweep = buildShineSweep({
    id: `sh${frameIdx}`,
    x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
    startPct: pct(sweepStartMs, totalDuration),
    endPct: pct(Math.min(frameStart + frameHoldMs, sweepStartMs + duration), totalDuration),
    totalSec,
    color: overlay.color,
    opacity: overlay.opacity,
    bandWidth: overlay.bandWidth,
    skewDeg: overlay.skewDeg,
    // DM-1551: the glint follows the box's rounded corners when a radius is set
    // (auto-derived from the anchored element's border-radius by resolveOverlays).
    radius: overlay.radius,
    repeat: overlay.repeat,
    repeatPeriodMs: overlay.repeatPeriodMs,
  });
  return { svgMarkup: sweep.markup, css: sweep.css };
}

function renderBlinkOverlay(
  overlay: BlinkOverlay,
  frameIdx: number,
  frameStart: number,
  frameEnd: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const id = `blink${frameIdx}`;
  const period = overlay.periodMs ?? DEFAULT_BLINK_PERIOD_MS;
  const color = overlay.color ?? "#e6edf3";
  const startMs = frameStart + (overlay.delay ?? 0);
  const radiusAttr = overlay.radius != null ? ` rx="${overlay.radius}" ry="${overlay.radius}"` : "";

  // Toggle opacity on/off every half-period across the frame's hold, then off.
  // step-end keeps each state until the next stop (a hard blink, not a fade).
  const stops: string[] = [`0%, ${pct(startMs, totalDuration)} { opacity: 0; }`];
  let t = startMs;
  let on = true;
  while (t < frameEnd) {
    stops.push(`${pct(t, totalDuration)} { opacity: ${on ? 1 : 0}; }`);
    t += period / 2;
    on = !on;
  }
  stops.push(`${pct(frameEnd, totalDuration)}, 100% { opacity: 0; }`);

  const svgMarkup = `  <rect class="${id}" x="${overlay.x}" y="${overlay.y}" width="${overlay.width}" height="${overlay.height}"${radiusAttr} fill="${color}" />`;
  const css = `
    @keyframes ${id} { ${stops.join(" ")} }
    .${id} { animation: ${id} ${totalSec.toFixed(2)}s step-end infinite; }`;
  return { svgMarkup, css };
}

function pct(ms: number, total: number): string {
  return `${((ms / total) * 100).toFixed(2)}%`;
}

function pctNum(ms: number, total: number): number {
  return (ms / total) * 100;
}

/**
 * DM-599: build a step-end keyframes block that toggles `display` between
 * `none` and `inline` around a visible window. Used in parallel with the
 * opacity-controlling `fv-*` animation so the browser can skip painting the
 * frame entirely while it's outside its show window (the dominant cost on
 * long multi-frame demos with complex captured content).
 *
 * `visibleStartPct` / `visibleEndPct` accept either a numeric-style string
 * (`"12.34"`) or one with a trailing `%` (`"12.34%"`) — `pct()` returns the
 * latter and the unmerged-path keyframes feed either form.
 *
 * DM-1511: the visible window is padded OUTWARD by a wide wall-clock margin
 * (`cullOverlapPct`) so adjacent frames' paint windows OVERLAP. The visual cut
 * is driven by the sibling `opacity` animation (`fv-*`), which Firefox
 * composites in lock-step; `visibility` is only the paint-cull gate, and a
 * sub-millisecond visibility hand-off flashed a transparent gap in Firefox at
 * cut points. Over-wide visibility is harmless — the frame is `opacity:0`
 * outside its true window — but removes any instant where both neighbors are
 * `visibility:hidden`. `totalSec` is the scene length used to size the margin.
 */
function buildDisplayKeyframes(name: string, visibleStartPct: string | number, visibleEndPct: string | number, totalSec: number): string {
  // DM-641: kept the function name for callers but the toggle is now on
  // `visibility`, not `display`, for the same reason as `fv-${i}` above —
  // animating `display` away from an element starting `display: none` never
  // ticks in Chromium.
  const margin = cullOverlapPct(totalSec * 1000);
  const start = Math.max(0, parseFloat(String(visibleStartPct)) - margin);
  const end = Math.min(100, parseFloat(String(visibleEndPct)) + margin);
  const startMinus = padBefore(start, KEYFRAME_EPSILON.cull, 3);
  const endPlus = padAfter(end, KEYFRAME_EPSILON.cull, 3);
  return `
    @keyframes ${name} {
      0% { visibility: hidden; }
      ${startMinus}% { visibility: hidden; }
      ${start.toFixed(3)}% { visibility: visible; }
      ${end.toFixed(3)}% { visibility: visible; }
      ${endPlus}% { visibility: hidden; }
      100% { visibility: hidden; }
    }`;
}

/**
 * Slide-transition keyframes (push-left / scroll). The two transitions are the
 * same machinery on different axes: `push-left` slides horizontally (axis `X`,
 * `size` = width), `scroll` slides vertically (axis `Y`, `size` = height). The
 * incoming frame starts off-screen (`+size`) only when the predecessor was the
 * same slide type (`entersSliding`), holds at 0 across its show window, then
 * exits to `-size`. 0.1% pads on each bookend keep the snap inside the
 * opacity:0 frame. Emits the fp/fv/fd keyframes + the `.f-`/`.fp-` rules.
 */
function slideKeyframes(
  i: number,
  exitAxis: "X" | "Y",
  exitDelta: number,
  enter: SlideEnter,
  enterStartPct: string,
  startPct: string,
  holdEndPct: string,
  transEndPct: string,
  visStart: string,
  visEnd: string,
  totalSec: number,
  /** DM-1207: the last frame, when the loop must NOT cross-dissolve, slides in
   *  and then HOLDS solid (transform 0, opacity 1, visible) to 100% — no
   *  slide-out / fade-out — and the loop hard-cuts back to frame 0. Mirrors the
   *  crossfade/cut path's DM-1148 holdToEnd. Without it the slide-out keyframes
   *  ramp the last frame to opacity 0 across its whole hold, washing it out. */
  holdToEnd = false,
): string {
  const enterBound = padBefore(parseFloat(enterStartPct), KEYFRAME_EPSILON.slide, 2);

  // Transform stops. Single-axis form — byte-identical to the pre-DM-1414 output
  // — for same-axis slide / fade / cut entrances; the full translate(x,y) form is
  // used ONLY when the entrance and exit slides are on DIFFERENT axes (the one
  // genuinely-new mixed case), so its two stops interpolate cleanly.
  const crossAxis = enter.mode === "slide" && enter.axis !== exitAxis;
  let enterT: string;
  let midT: string;
  let exitT: string;
  if (crossAxis) {
    const ex = enter.axis === "X" ? enter.enterOffset : 0;
    const ey = enter.axis === "Y" ? enter.enterOffset : 0;
    const xx = exitAxis === "X" ? exitDelta : 0;
    const xy = exitAxis === "Y" ? exitDelta : 0;
    enterT = `translate(${ex}px, ${ey}px)`;
    midT = `translate(0px, 0px)`;
    exitT = `translate(${xx}px, ${xy}px)`;
  } else {
    // Same-axis slide: incoming starts at its signed `enterOffset`; a fade/cut
    // entrance starts in place (0). The outgoing exits by the signed `exitDelta`.
    const enterOffsetPx = enter.mode === "slide" ? enter.enterOffset : 0;
    enterT = `translate${exitAxis}(${enterOffsetPx}px)`;
    midT = `translate${exitAxis}(0)`;
    exitT = `translate${exitAxis}(${exitDelta}px)`;
  }

  // Opacity entrance: a `fade` entrance ramps 0→1 across the entrance window
  // [enterStart, frameStart] (cross-dissolving with the predecessor's fade-out);
  // a slide / cut entrance snaps to 1 at enterStart (the clip hides the still
  // off-screen content). Byte-identical to the old code for slide / cut.
  const fadeIn = enter.mode === "fade";
  const fvEnter = fadeIn
    ? `0%, ${enterBound}% { opacity: 0; }
      ${enterStartPct} { opacity: 0; }
      ${startPct} { opacity: 1; }`
    : `0%, ${enterBound}% { opacity: 0; }
      ${enterStartPct} { opacity: 1; }`;

  if (holdToEnd) {
    return `
    @keyframes fp-${i} {
      0%, ${enterBound}% { transform: ${enterT}; }
      ${startPct} { transform: ${midT}; }
      100% { transform: ${midT}; }
    }
    @keyframes fv-${i} {
      ${fvEnter}
      100% { opacity: 1; }
    }${buildDisplayKeyframes(`fd-${i}`, visStart, "100", totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite, fd-${i} ${totalSec.toFixed(2)}s infinite step-end; }
    .fp-${i} { animation: fp-${i} ${totalSec.toFixed(2)}s infinite; }`;
  }
  return `
    @keyframes fp-${i} {
      0%, ${enterBound}% { transform: ${enterT}; }
      ${startPct} { transform: ${midT}; }
      ${holdEndPct} { transform: ${midT}; }
      ${transEndPct} { transform: ${exitT}; }
      ${padAfter(parseFloat(transEndPct), KEYFRAME_EPSILON.slide, 2)}%, 100% { transform: ${exitT}; }
    }
    @keyframes fv-${i} {
      ${fvEnter}
      ${transEndPct} { opacity: 1; }
      ${padAfter(parseFloat(transEndPct), KEYFRAME_EPSILON.slide, 2)}%, 100% { opacity: 0; }
    }${buildDisplayKeyframes(`fd-${i}`, visStart, visEnd, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite, fd-${i} ${totalSec.toFixed(2)}s infinite step-end; }
    .fp-${i} { animation: fp-${i} ${totalSec.toFixed(2)}s infinite; }`;
}

/**
 * Render a frame-local SVG overlay. The embedded SVG markup is wrapped in a
 * `<g transform="translate(x y)" clip-path="..."/>` and an inner
 * `<g class="ov-<id>">` so `enter`/`exit` / explicit animations can target
 * the overlay without colliding with classes inside the embedded SVG.
 */
function renderSvgOverlay(
  overlay: SvgOverlay,
  frameIdx: number,
  frameStart: number,
  frameHoldMs: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const id = `ov-${frameIdx}-${overlay.animId}`;
  const clipId = `${id}-clip`;
  const visibilityId = `${id}-vis`;
  const overlayEnd = frameStart + frameHoldMs;
  const visStart = pct(frameStart, totalDuration);
  const visEnd = pct(overlayEnd, totalDuration);

  const cssRules: string[] = [];
  // Visibility timeline: hidden until frame start, visible during the hold.
  cssRules.push(`
    @keyframes ${visibilityId} { 0%, ${pct(Math.max(0, frameStart - 1), totalDuration)} { opacity: 0; } ${visStart} { opacity: 1; } ${visEnd} { opacity: 1; } ${pct(overlayEnd + 1, totalDuration)}, 100% { opacity: 0; } }
    .${id} { animation: ${visibilityId} ${totalSec.toFixed(2)}s infinite; }`);

  // Slide-in entrance (DM-211): translate from off-screen to (0, 0) over
  // duration ms, starting at frame start + delay.
  if (overlay.enter != null) {
    const e = overlay.enter;
    const easing = e.easing ?? "ease-out";
    const enterDelay = e.delay ?? 0;
    const fromStr = offsetForDirection(e.from, overlay.width, overlay.height);
    const enterStart = frameStart + enterDelay;
    const enterEnd = enterStart + e.duration;
    const enterId = `${id}-enter`;
    cssRules.push(`
    @keyframes ${enterId} { 0% { transform: ${fromStr}; } ${pct(enterStart, totalDuration)} { transform: ${fromStr}; } ${pct(enterEnd, totalDuration)} { transform: translate(0, 0); } 100% { transform: translate(0, 0); } }
    .${id}-enter { animation: ${enterId} ${totalSec.toFixed(2)}s ${easing} infinite; }`);
  }

  // Slide-out exit. Mirror of enter — translate from (0,0) to off-screen.
  if (overlay.exit != null) {
    const e = overlay.exit;
    const easing = e.easing ?? "ease-in";
    const exitDelay = e.delay ?? 0;
    const toStr = offsetForDirection(e.from, overlay.width, overlay.height);
    const exitStart = overlayEnd - e.duration - exitDelay;
    const exitId = `${id}-exit`;
    cssRules.push(`
    @keyframes ${exitId} { 0%, ${pct(exitStart, totalDuration)} { transform: translate(0, 0); } ${pct(exitStart + e.duration, totalDuration)} { transform: ${toStr}; } 100% { transform: ${toStr}; } }
    .${id}-exit { animation: ${exitId} ${totalSec.toFixed(2)}s ${easing} infinite; }`);
  }

  // Markup: outer wrapper translates to (x, y) and clips, inner wrapper
  // carries the visibility class, then the enter/exit transform wrapper, then
  // the inlined SVG content.
  const enterClass = overlay.enter != null ? ` ${id}-enter` : "";
  const exitClass = overlay.exit != null ? ` ${id}-exit` : "";
  const svgMarkup = `  <g transform="translate(${overlay.x} ${overlay.y})" clip-path="url(#${clipId})">
    <defs><clipPath id="${clipId}"><rect width="${overlay.width}" height="${overlay.height}"/></clipPath></defs>
    <g class="${id}${enterClass}${exitClass}">${overlay.innerSvg}</g>
  </g>`;

  return { svgMarkup, css: cssRules.join("") };
}

/**
 * Off-screen offset string for a slide direction — the point the overlay sits
 * at when fully off-screen on the given side. Enter animates from this offset to
 * `translate(0,0)`; exit animates from `translate(0,0)` back to it. The offset
 * is the same for both (the enter-vs-exit direction is carried by the keyframe
 * construction, not by this function), so it takes only the direction + size.
 */
function offsetForDirection(dir: "top" | "bottom" | "left" | "right", w: number, h: number): string {
  if (dir === "top")    return `translate(0, -${h}px)`;
  if (dir === "bottom") return `translate(0, ${h}px)`;
  if (dir === "left")   return `translate(-${w}px, 0)`;
  return `translate(${w}px, 0)`; // right
}

/**
 * Compile each frame's intra-frame animations into CSS. Each animation gets
 * a uniquely-named keyframe block whose timing is mapped onto the global
 * scene clock so the property holds at `from` until the frame becomes
 * visible (+ `delay`), animates to `to` over `duration`, then holds at `to`
 * until the loop restarts.
 */
/**
 * DM-1512/1513: compose one keyframe stop's declaration from several property
 * "parts" (a value per fused track). Transform-family tracks
 * (`translateX`/`translateY`/`scale`/raw `transform`) collapse into a SINGLE
 * `transform:` — two `transform:` declarations would clobber each other — while
 * other properties (`opacity`, `clip-path`, …) emit alongside.
 */
function composeAnimStop(parts: Array<{ property: string; val: string }>): string {
  const transforms: string[] = [];
  const others: string[] = [];
  for (const p of parts) {
    if (p.property === "translateX") transforms.push(`translateX(${p.val})`);
    else if (p.property === "translateY") transforms.push(`translateY(${p.val})`);
    else if (p.property === "scale") transforms.push(`scale(${p.val})`);
    else if (p.property === "transform") transforms.push(p.val);
    else if (p.property === "clipPath") others.push(`clip-path: ${p.val};`);
    else others.push(`${p.property}: ${p.val};`);
  }
  if (transforms.length > 0) others.push(`transform: ${transforms.join(" ")};`);
  return others.join(" ");
}

function buildIntraFrameAnimationCss(
  frames: AnimationFrame[],
  frameTiming: { startPct: number[] },
  totalSec: number,
): string {
  const totalMs = totalSec * 1000;
  const out: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const animations = frames[i].animations;
    if (animations == null || animations.length === 0) continue;
    const frameStartMs = (frameTiming.startPct[i] / 100) * totalMs;
    for (let ai = 0; ai < animations.length; ai++) {
      const a = animations[ai];
      const delay = a.delay ?? 0;
      const easing = a.easing ?? "linear";
      const startMs = frameStartMs + delay;
      const endMs = startMs + a.duration;
      const startPct = (startMs / totalMs) * 100;
      const endPct = (endMs / totalMs) * 100;
      // DM-1512/1513: an animation can fuse several property tracks that share
      // this entry's window + easing, so they emit into ONE @keyframes and stay
      // in perfect sync (one timeline — immune to Firefox's off-main-thread
      // desync; see docs/84). Track 0 is the primary property; `a.fuse` adds the
      // rest. Build the declaration for one keyframe stop by taking each track's
      // value for that phase, composing all transform-family tracks into a
      // single `transform:` (two `transform:` decls would clobber each other)
      // and emitting other properties alongside.
      type Track = { property: string; from: string; to: string; duration?: number; delay?: number; easing?: string };
      const tracks: Track[] = [{ property: a.property, from: a.from, to: a.to }, ...(a.fuse ?? [])];
      const declFrom = composeAnimStop(tracks.map((t) => ({ property: t.property, val: t.from })));
      const declTo = composeAnimStop(tracks.map((t) => ({ property: t.property, val: t.to })));
      // DM-1297: SVG transforms are origin-(0,0); a `transformOrigin` makes a
      // scale/rotate/translate resolve about the element's OWN box (e.g. a
      // center-origin scale-pop) instead of the SVG origin. `transform-box:
      // fill-box` switches the reference box to the element's bounding box.
      const originDecl = a.transformOrigin != null && a.transformOrigin !== ""
        ? ` transform-box: fill-box; transform-origin: ${a.transformOrigin};`
        : "";
      const animName = `f${i}-${a.animId}-${ai}`;
      // DM-1517: when a fused track carries its OWN duration/delay/easing, the
      // tracks no longer share one `animation-timing-function`, so we can't emit
      // a from/to pair. Instead SAMPLE each track's eased value over its own
      // window at many stops and emit them with `linear` timing (easing baked
      // in) — still ONE animation / one timeline. Only for one-shot reveals
      // (`repeat` loops keep the shared-timing cycle form).
      const sampledTracks = a.fuse ?? [];
      const needsSampling = a.repeat == null
        && sampledTracks.some((t) => t.duration != null || t.delay != null || t.easing != null);
      if (needsSampling) {
        const win = tracks.map((t) => {
          const tStart = frameStartMs + (t.delay ?? delay);
          const tEnd = tStart + (t.duration ?? a.duration);
          return {
            property: t.property, from: t.from, to: t.to,
            startPct: (tStart / totalMs) * 100,
            endPct: (tEnd / totalMs) * 100,
            ease: resolveEasing(t.easing ?? a.easing),
          };
        });
        const minStart = Math.min(...win.map((w) => w.startPct));
        const maxEnd = Math.max(...win.map((w) => w.endPct));
        // Stops: 0/100 + every track boundary + a fine grid across the active
        // span so each track's eased curve is well approximated.
        const stopSet = new Set<number>([0, 100]);
        for (const w of win) { stopSet.add(w.startPct); stopSet.add(w.endPct); }
        const STEP = 2;
        for (let p = minStart; p < maxEnd; p += STEP) stopSet.add(p);
        const stops = [...stopSet].filter((p) => p >= 0 && p <= 100).sort((x, y) => x - y);
        const seen = new Set<string>();
        const body = stops.map((p) => {
          const pctStr = p.toFixed(3);
          if (seen.has(pctStr)) return "";
          seen.add(pctStr);
          const parts = win.map((w) => {
            const span = w.endPct - w.startPct;
            const localT = span > 0 ? Math.min(1, Math.max(0, (p - w.startPct) / span)) : (p >= w.endPct ? 1 : 0);
            return { property: w.property, val: interpolateCssValue(w.from, w.to, w.ease(localT)) };
          });
          return `      ${pctStr}% { ${composeAnimStop(parts)} }`;
        }).filter((s) => s !== "").join("\n");
        out.push(`    @keyframes ${animName} {
${body}
    }
    .anim-${a.animId} { animation: ${animName} ${totalSec.toFixed(2)}s linear infinite;${originDecl} }`);
        continue;
      }
      if (a.repeat != null) {
        // DM-869: repeating animation (blink / pulse / breathe). The keyframe is
        // a single from→to cycle on the animation's own `duration` clock, looped
        // via animation-iteration-count + (optional) direction:alternate. The
        // loop is only visible while the frame is on screen (the frame group's
        // visibility gating).
        //
        // `animation-delay` positions the first cycle: a POSITIVE delay (after the
        // frame appears) holds `from` until it elapses then plays; a NEGATIVE delay
        // (a phase offset) starts the loop already mid-cycle so it never freezes —
        // the right choice for a seamless ambient loop (DM-1289).
        //
        // DM-1289: emit timing-function / delay / fill-mode INSIDE the `animation`
        // shorthand, not as trailing longhands. The optimizer (csso) merges shared
        // longhands into a separate, earlier grouped rule; a later `animation`
        // shorthand then resets `animation-fill-mode` back to `none`, so during a
        // positive delay the element showed its base value (not `from`) and SNAPPED
        // when the cycle began. Folding everything into the one shorthand leaves
        // nothing for the optimizer to hoist out of order.
        const iterations = a.repeat === "infinite" ? "infinite" : String(a.repeat);
        const direction = a.alternate === true ? " alternate" : "";
        out.push(`    @keyframes ${animName} {
      0% { ${declFrom} }
      100% { ${declTo} }
    }
    .anim-${a.animId} { animation: ${animName} ${a.duration}ms ${easing} ${startMs.toFixed(0)}ms ${iterations}${direction} both;${originDecl} }`);
      } else {
        // One-shot: hold `from` until startPct, animate from→to during
        // [startPct, endPct], hold `to` afterwards, mapped onto the global scene
        // clock so it replays in sync each scene loop.
        out.push(`    @keyframes ${animName} {
      0% { ${declFrom} }
      ${startPct.toFixed(3)}% { ${declFrom} }
      ${endPct.toFixed(3)}% { ${declTo} }
      100% { ${declTo} }
    }
    .anim-${a.animId} { animation: ${animName} ${totalSec.toFixed(2)}s ${easing} infinite;${originDecl} }`);
      }
    }
  }
  return out.length === 0 ? "" : "\n" + out.join("\n");
}
