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
import type { AnimationOverlay, TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, InteractOverlay, IntraFrameAnimation } from "./overlay-schema.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { isTransparentBackground } from "../utils/transparent-background.js";
import { rootSvgA11y } from "../render/format.js";
import { getFontInstance, resolveFontKey, withRenderTextMode, glyphDefCount, getGlyphDefsSince, truncateGlyphDefs } from "../render/font-resolution.js";
import { renderTextAsPath } from "../render/text-to-path.js";
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
     *
     * DM-1547 adds the radial / clock wipes (docs/88): `wipe-radial` (an
     * expanding-circle reveal — the same geometry family as `iris`, kept as a
     * named alias so the "radial wipe" vocabulary is complete, mirroring how
     * `push-up` aliases `scroll`) and `wipe-clock` (an angular "clock hand" sweep
     * that reveals the incoming frame around the center via an animated
     * `clip-path: polygon()` with a fixed vertex count — NO animated conic mask,
     * NO animated filter, so it composites identically on Blink / WebKit / Gecko).
     *
     * All express motion in `transform` / `clip-path` / `opacity` / gradients
     * only — never an animated CSS `filter` (Chromium-only in `<img>`, docs/84).
     */
    type:
      | "crossfade" | "push-left" | "scroll" | "cut" | "magic-move"
      | "push-right" | "push-up" | "push-down"
      | "wipe" | "iris" | "zoom-in" | "zoom-out" | "shine"
      | "wipe-radial" | "wipe-clock";
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
export type { TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, ShineOverlay, InteractOverlay, AnimationOverlay, IntraFrameAnimation };

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

/** DM-1524 / DM-1547: reveal-on-top transitions — the outgoing frame HOLDS
 *  beneath and hard-cuts at the window end while the incoming frame unveils on
 *  top via an animated `clip-path` (`wipe` = linear inset, `iris` /
 *  `wipe-radial` = expanding circle, `wipe-clock` = angular polygon sweep). */
const REVEAL_KINDS = new Set(["wipe", "iris", "wipe-radial", "wipe-clock"]);

/** The clip-path reveal SHAPE a reveal transition unveils with. DM-1547 folds
 *  the two new radial/clock names in: `wipe-radial` is an alias of the `iris`
 *  expanding circle (same geometry, complete-vocabulary name — cf. `push-up`
 *  aliasing `scroll`), and `wipe-clock` is the distinct angular `polygon()`
 *  sweep. `wipe` stays the linear inset. */
type RevealShape = "wipe" | "iris" | "clock";
function revealShapeOf(transType: string): RevealShape {
  switch (transType) {
    case "wipe": return "wipe";
    case "wipe-clock": return "clock";
    // `iris` and its `wipe-radial` alias both reveal with the expanding circle.
    default: return "iris";
  }
}

/**
 * DM-1547: one `clip-path: polygon()` frame of the `wipe-clock` sweep at progress
 * `f` ∈ [0, 1] (0 → fully hidden, 1 → fully revealed). A "clock hand" sweeps
 * clockwise from 12 o'clock through 360°, and the revealed region is the swept
 * angular sector — clipped to the RECTANGLE (so the whole frame ends fully shown),
 * not a circle.
 *
 * The polygon has a FIXED 7 vertices at every `f` so CSS interpolates it smoothly
 * between keyframe stops (differing vertex counts would fall back to a discrete
 * jump). The vertices are: the center, the fixed 12-o'clock point, four "corner"
 * slots, and the current leading edge point. Each corner slot RIDES the leading
 * edge point until the sweep angle reaches that corner, then snaps to it — and
 * because `edgePoint(cornerAngle)` IS the corner, that snap is continuous. So a
 * handful of stops (the four corner angles + even subdivisions) reproduce a clean
 * clock wipe with plain linear interpolation. Cross-engine-safe: polygon clip-path
 * animates on Blink / WebKit / Gecko; no conic mask, no filter (docs/84).
 */
function clockWipeClip(f: number, w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const theta = 2 * Math.PI * f;
  const norm = (a: number): number => { let x = a % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x; };
  // Corner angles, measured clockwise from straight up (monotone TR<BR<BL<TL).
  const aTR = norm(Math.atan2(w / 2, h / 2));
  const aBR = norm(Math.atan2(w / 2, -h / 2));
  const aBL = norm(Math.atan2(-w / 2, -h / 2));
  const aTL = norm(Math.atan2(-w / 2, h / 2));
  // Where the ray from center at clockwise-from-up angle `t` hits the rect edge.
  const edgePoint = (t: number): [number, number] => {
    const dx = Math.sin(t);
    const dy = -Math.cos(t);
    let best = Infinity;
    if (dx > 1e-9) best = Math.min(best, (w - cx) / dx);
    else if (dx < -1e-9) best = Math.min(best, (0 - cx) / dx);
    if (dy > 1e-9) best = Math.min(best, (h - cy) / dy);
    else if (dy < -1e-9) best = Math.min(best, (0 - cy) / dy);
    if (!isFinite(best)) best = 0;
    return [cx + dx * best, cy + dy * best];
  };
  const lead = edgePoint(theta);
  const slot = (passed: boolean, corner: [number, number]): [number, number] => (passed ? corner : lead);
  const verts: [number, number][] = [
    [cx, cy],          // center
    [cx, 0],           // fixed 12 o'clock start
    slot(theta >= aTR, [w, 0]),
    slot(theta >= aBR, [w, h]),
    slot(theta >= aBL, [0, h]),
    slot(theta >= aTL, [0, 0]),
    lead,              // current leading edge
  ];
  return "polygon(" + verts.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(", ") + ")";
}

/**
 * DM-1547: the intermediate `clip-path` keyframe stops for a `wipe-clock` reveal,
 * spanning the entrance window `[enterNum, startNum]` (scene-clock percents). The
 * hidden (`f=0`) start and shown (`f=1`) end are emitted by the caller; this fills
 * the sweep between them. Stops land at even subdivisions PLUS the four exact
 * corner angles (so the polygon threads each corner precisely). Returns a CSS
 * fragment (one `pct% { clip-path: … }` per line).
 */
function clockWipeStops(w: number, h: number, enterNum: number, startNum: number): string {
  const norm = (a: number): number => { let x = a % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x; };
  const cornerFracs = [
    norm(Math.atan2(w / 2, h / 2)),
    norm(Math.atan2(w / 2, -h / 2)),
    norm(Math.atan2(-w / 2, -h / 2)),
    norm(Math.atan2(-w / 2, h / 2)),
  ].map((a) => a / (2 * Math.PI));
  const fracs = new Set<number>(cornerFracs);
  const SUBDIVISIONS = 16;
  for (let k = 1; k < SUBDIVISIONS; k++) fracs.add(k / SUBDIVISIONS);
  const sorted = [...fracs].filter((f) => f > 1e-4 && f < 1 - 1e-4).sort((a, b) => a - b);
  return sorted
    .map((f) => {
      const p = enterNum + (startNum - enterNum) * f;
      return `      ${p.toFixed(3)}% { clip-path: ${clockWipeClip(f, w, h)}; }`;
    })
    .join("\n");
}

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
  entranceReveal: RevealShape | null,
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
    const beforeEnter = padBefore(parseFloat(revealEnterStartPct), KEYFRAME_EPSILON.slide, 2);
    // DM-1550: apply the easing to the reveal SEGMENT only (enter → start) via a
    // per-keyframe `animation-timing-function` on the `revealEnterStartPct` stop
    // — the timing function declared at a keyframe governs the interval starting
    // there — leaving the surrounding holds linear. A sampled spring `linear(...)`
    // rings past full-reveal and back, so its overshoot shows as the wipe/iris
    // edge bouncing at the boundary before settling (rests at the identity clip).
    const revealTf = revealEasing != null ? ` animation-timing-function: ${revealEasing};` : "";
    if (entranceReveal === "clock") {
      // DM-1547: the angular "clock hand" sweep — fixed-vertex `polygon()` frames
      // (see `clockWipeClip`) interpolated between the hidden f=0 start and the
      // fully-revealed f=1 end, threading each corner. Rests at the full-rectangle
      // polygon (fully revealed — the reveal's identity). `clip-path` + opacity
      // only; no conic mask, no filter. (Easing on the clock sweep is a follow-up.)
      const enterNum = parseFloat(revealEnterStartPct);
      const startNum = parseFloat(startPct);
      const hidden = clockWipeClip(0, dims.width, dims.height);
      const shown = clockWipeClip(1, dims.width, dims.height);
      const midStops = clockWipeStops(dims.width, dims.height, enterNum, startNum);
      revealKf = `
    @keyframes fr-${i} {
      0%, ${beforeEnter}% { clip-path: ${hidden}; }
      ${revealEnterStartPct} { clip-path: ${hidden}; }
${midStops}
      ${startPct} { clip-path: ${shown}; }
      100% { clip-path: ${shown}; }
    }
    .fr-${i} { animation: fr-${i} ${totalSec.toFixed(2)}s linear infinite; }`;
    } else {
      const [hidden, shown] = entranceReveal === "wipe"
        ? ["inset(0 100% 0 0)", "inset(0 0 0 0)"]
        : [`circle(0px at ${cx}px ${cy}px)`, `circle(${r}px at ${cx}px ${cy}px)`];
      revealKf = `
    @keyframes fr-${i} {
      0%, ${beforeEnter}% { clip-path: ${hidden}; }
      ${revealEnterStartPct} { clip-path: ${hidden};${revealTf} }
      ${startPct} { clip-path: ${shown}; }
      100% { clip-path: ${shown}; }
    }
    .fr-${i} { animation: fr-${i} ${totalSec.toFixed(2)}s linear infinite; }`;
    }
    inner = `<g class="fr-${i}">\n${svgContent}\n  </g>`;
  }

  const group = `  <g class="f f-${i}">\n${inner}\n  </g>`;
  const keyframe = `${opacityKf}${buildDisplayKeyframes(`fd-${i}`, onStart, onEnd, totalSec)}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s step-end infinite, fd-${i} ${totalSec.toFixed(2)}s step-end infinite; }${revealKf}`;
  return { group, keyframe };
}

// ─── DM-1548: unified entrance/exit compositor ──────────────────────────────
//
// Every frame boundary has TWO independent halves: how the PREVIOUS frame LEAVES
// (its own transition type → an EXIT effect) and how the CURRENT frame ENTERS
// (the previous frame's transition type → an ENTRANCE effect). The original
// dispatch routed a frame down ONE family branch by its own type and let that
// branch handle both halves, so an entrance effect from a DIFFERENT family than
// the exit was silently dropped (e.g. a `zoom-out` predecessor handing off into
// a `wipe`-exit frame lost the dolly; a `wipe` predecessor into a `crossfade`-
// exit frame was forced to hold-then-cut instead of crossfading out).
//
// `emitComposedFrame` composes the two halves as independent, nestable CSS
// tracks on one frame group: a unified opacity/visibility track (`fv`/`fd`), an
// optional slide transform (`fp`, entrance and/or exit), an optional dolly scale
// (`fz`, entrance), and an optional reveal clip-path (`fr`, entrance). It is
// routed to ONLY for the genuinely mixed-family boundaries the single-branch
// paths get wrong (`composedBoundaryNeeded`); every same-type chain and every
// slide/fade mix the original branches already handle stays on those branches,
// so their output is byte-identical.

/** How the current frame ENTERS, derived from the PREVIOUS frame's transition. */
type EntranceKind = "fade" | "dolly" | "slide" | "reveal" | "cut";
/** How the current frame EXITS, derived from its OWN transition. `magic` is the
 *  special-cased magic-move exit — never composed here. */
type ExitKind = "fade" | "slide" | "hold" | "cut" | "magic";

interface ComposedEntrance {
  kind: EntranceKind;
  /** slide: the PREVIOUS push/scroll axis + sign (incoming enters from the
   *  opposite side, so its offset is `-sign · size`). */
  axis?: "X" | "Y";
  sign?: 1 | -1;
  /** dolly: the scale the incoming grows/settles FROM (zoom-in 0.9, zoom-out 1.1). */
  fromScale?: number;
  /** reveal: the clip-path shape the incoming unveils with. */
  reveal?: RevealShape;
  /** dolly / reveal: resolved CSS easing for the entrance segment (DM-1550). */
  easing?: string;
}
interface ComposedExit {
  kind: ExitKind;
  /** slide: the OWN push/scroll axis + sign (outgoing slides by `sign · size`). */
  axis?: "X" | "Y";
  sign?: 1 | -1;
}

/** Classify a frame's ENTRANCE from the previous frame's transition type. A push/
 *  scroll predecessor slides the incoming in; a crossfade/shine fades it in; a
 *  zoom dollies it in (a fade + scale); a wipe/iris/… reveals it on top; a cut /
 *  magic-move / first-frame appears at its own start. */
function classifyEntrance(prevType: string | undefined, prevMagicBridged: boolean, prevEasing: string | undefined): ComposedEntrance {
  if (prevType == null) return { kind: "cut" };
  const dir = PUSH_DIRS[prevType];
  if (dir != null) return { kind: "slide", axis: dir.axis, sign: dir.sign };
  if (REVEAL_KINDS.has(prevType)) return { kind: "reveal", reveal: revealShapeOf(prevType), easing: resolveEasingPreset(prevEasing) };
  if (prevType === "zoom-in" || prevType === "zoom-out") return { kind: "dolly", fromScale: prevType === "zoom-in" ? 0.9 : 1.1, easing: resolveEasingPreset(prevEasing) };
  if (prevType === "crossfade" || prevType === "shine") return { kind: "fade" };
  // magic-move WITH a built bridge: appears at its own start (the bridge covered
  // the window). WITHOUT a bridge it degraded to crossfade → fade.
  if (prevType === "magic-move") return { kind: prevMagicBridged ? "cut" : "fade" };
  return { kind: "cut" };
}

/** Classify a frame's EXIT from its OWN transition type. push/scroll slides out;
 *  crossfade/zoom/shine fade out (the dolly rides on the NEXT frame's entrance);
 *  wipe/iris/… hold beneath and hard-cut (the next frame reveals on top); cut
 *  hard-cuts; magic-move is special-cased elsewhere. */
function classifyExit(ownType: string): ComposedExit {
  const dir = PUSH_DIRS[ownType];
  if (dir != null) return { kind: "slide", axis: dir.axis, sign: dir.sign };
  if (REVEAL_KINDS.has(ownType)) return { kind: "hold" };
  if (ownType === "magic-move") return { kind: "magic" };
  if (ownType === "cut") return { kind: "cut" };
  return { kind: "fade" }; // crossfade / zoom-in / zoom-out / shine / default
}

/**
 * Whether a boundary needs the unified compositor — i.e. the entrance and exit
 * are in DIFFERENT effect families and the single-branch paths would drop one of
 * them. Deliberately a POSITIVE whitelist: everything NOT listed here keeps its
 * original branch (and its byte-identical output). The listed combinations never
 * occur in a same-type chain nor in the slide/fade mixes the DM-1414 slide/
 * crossfade branches already compose correctly, so no committed golden hits this.
 */
function composedBoundaryNeeded(entrance: EntranceKind, exit: ExitKind): boolean {
  // A reveal ENTRANCE composed with a non-reveal EXIT (fade / cut / slide):
  // e.g. wipe → crossfade, wipe → push. The old reveal branch forced hold-cut.
  if (entrance === "reveal" && (exit === "fade" || exit === "cut" || exit === "slide")) return true;
  // A non-reveal ENTRANCE composed with a reveal EXIT (hold-then-cut): e.g.
  // crossfade → wipe, push → iris, zoom → wipe. The old reveal branch dropped
  // the fade/slide/dolly entrance and cut the frame in.
  if ((entrance === "fade" || entrance === "dolly" || entrance === "slide") && exit === "hold") return true;
  // A dolly ENTRANCE composed with a slide EXIT: zoom → push/scroll. The old
  // slide branch faded (dropping the scale dolly).
  if (entrance === "dolly" && exit === "slide") return true;
  return false;
}

/** The keyframe-window percentages the composed frame places its CSS at. */
interface ComposedWindow {
  enterStartPct: string;
  startPct: string;
  holdEndPct: string;
  transEndPct: string;
}

/**
 * DM-1548: emit one MIXED-family boundary frame — an independently-composed
 * entrance (from the previous transition) and exit (from its own). Produces one
 * `<g class="f f-i">` group with a unified `fv`/`fd` opacity+visibility track and
 * whichever of the entrance/exit tracks are needed: `fp` (slide transform, either
 * direction), `fz` (dolly scale), `fr` (reveal clip-path). All motion is
 * transform / clip-path / opacity — never an animated filter (docs/84).
 */
function emitComposedFrame(
  i: number,
  svgContent: string,
  entrance: ComposedEntrance,
  exit: ComposedExit,
  dims: { width: number; height: number },
  win: ComposedWindow,
  totalSec: number,
  holdToEnd: boolean,
): { group: string; keyframe: string } {
  const { width, height } = dims;
  const cx = width / 2;
  const cy = height / 2;
  const enterNum = parseFloat(win.enterStartPct);
  const startNum = parseFloat(win.startPct);
  const holdNum = parseFloat(win.holdEndPct);
  const transNum = parseFloat(win.transEndPct);
  const dur = `${totalSec.toFixed(2)}s`;

  const needSlide = entrance.kind === "slide" || exit.kind === "slide";
  const needScale = entrance.kind === "dolly";
  const needReveal = entrance.kind === "reveal";
  // A fade/dolly entrance RAMPS opacity in over [enter, start]; a slide/reveal
  // entrance SNAPS opacity to 1 at `enter` (the transform / clip does the hiding).
  const leadRamp = entrance.kind === "fade" || entrance.kind === "dolly";

  // ── Opacity track (fv) ───────────────────────────────────────────────────
  const preEnter = padBefore(enterNum, KEYFRAME_EPSILON.cull, 3);
  const opacityStops: string[] = [
    `0% { opacity: 0; }`,
    `${preEnter}% { opacity: 0; }`,
  ];
  if (leadRamp) {
    opacityStops.push(`${enterNum.toFixed(3)}% { opacity: 0; }`);
    opacityStops.push(`${startNum.toFixed(3)}% { opacity: 1; }`);
  } else {
    opacityStops.push(`${enterNum.toFixed(3)}% { opacity: 1; }`);
  }
  if (holdToEnd) {
    opacityStops.push(`100% { opacity: 1; }`);
  } else if (exit.kind === "fade") {
    // Crossfade/zoom/shine exit: hold, then dissolve out over the trans window.
    opacityStops.push(`${holdNum.toFixed(3)}% { opacity: 1; }`);
    opacityStops.push(`${transNum.toFixed(3)}% { opacity: 0; }`);
    opacityStops.push(`100% { opacity: 0; }`);
  } else {
    // Slide / reveal-hold / cut exit: hold solid to the trans end, then hard-cut.
    opacityStops.push(`${transNum.toFixed(3)}% { opacity: 1; }`);
    opacityStops.push(`${padAfter(transNum, KEYFRAME_EPSILON.cull, 3)}% { opacity: 0; }`);
    opacityStops.push(`100% { opacity: 0; }`);
  }
  const onEnd = holdToEnd ? "100" : win.transEndPct;
  let keyframe = `
    @keyframes fv-${i} {
      ${opacityStops.join("\n      ")}
    }${buildDisplayKeyframes(`fd-${i}`, win.enterStartPct, onEnd, totalSec)}
    .f-${i} { animation: fv-${i} ${dur} infinite, fd-${i} ${dur} infinite step-end; }`;

  // ── Reveal clip track (fr) — innermost ────────────────────────────────────
  let inner = svgContent;
  if (needReveal) {
    const shape = entrance.reveal ?? "iris";
    const rBefore = padBefore(enterNum, KEYFRAME_EPSILON.slide, 2);
    const tf = entrance.easing != null ? ` animation-timing-function: ${entrance.easing};` : "";
    if (shape === "clock") {
      const hidden = clockWipeClip(0, width, height);
      const shown = clockWipeClip(1, width, height);
      const mid = clockWipeStops(width, height, enterNum, startNum);
      keyframe += `
    @keyframes fr-${i} {
      0%, ${rBefore}% { clip-path: ${hidden}; }
      ${win.enterStartPct} { clip-path: ${hidden};${tf} }
${mid}
      ${win.startPct} { clip-path: ${shown}; }
      100% { clip-path: ${shown}; }
    }
    .fr-${i} { animation: fr-${i} ${dur} linear infinite; }`;
    } else {
      const r = Math.ceil(Math.hypot(cx, cy));
      const [hidden, shown] = shape === "wipe"
        ? ["inset(0 100% 0 0)", "inset(0 0 0 0)"]
        : [`circle(0px at ${cx}px ${cy}px)`, `circle(${r}px at ${cx}px ${cy}px)`];
      keyframe += `
    @keyframes fr-${i} {
      0%, ${rBefore}% { clip-path: ${hidden}; }
      ${win.enterStartPct} { clip-path: ${hidden};${tf} }
      ${win.startPct} { clip-path: ${shown}; }
      100% { clip-path: ${shown}; }
    }
    .fr-${i} { animation: fr-${i} ${dur} linear infinite; }`;
    }
    inner = `<g class="fr-${i}">\n${inner}\n  </g>`;
  }

  // ── Dolly scale track (fz) ─────────────────────────────────────────────────
  if (needScale) {
    const from = entrance.fromScale ?? 1;
    const esBefore = padBefore(enterNum, KEYFRAME_EPSILON.slide, 2);
    const tf = entrance.easing != null ? ` animation-timing-function: ${entrance.easing};` : "";
    keyframe += `
    @keyframes fz-${i} {
      0%, ${esBefore}% { transform: scale(${from}); }
      ${win.enterStartPct} { transform: scale(${from});${tf} }
      ${win.startPct} { transform: scale(1); }
      100% { transform: scale(1); }
    }
    .fz-${i} { animation: fz-${i} ${dur} linear infinite; transform-origin: ${cx}px ${cy}px; }`;
    inner = `<g class="fz-${i}">\n${inner}\n  </g>`;
  }

  // ── Slide transform track (fp) — entrance and/or exit; clipped ─────────────
  let clipDef = "";
  if (needSlide) {
    const off = (axis: "X" | "Y", d: number): string => `translate(${axis === "X" ? d : 0}px, ${axis === "Y" ? d : 0}px)`;
    const enterT = entrance.kind === "slide" && entrance.axis != null && entrance.sign != null
      ? off(entrance.axis, -entrance.sign * (entrance.axis === "X" ? width : height))
      : "translate(0px, 0px)";
    const exitT = exit.kind === "slide" && exit.axis != null && exit.sign != null
      ? off(exit.axis, exit.sign * (exit.axis === "X" ? width : height))
      : "translate(0px, 0px)";
    const enterBound = padBefore(enterNum, KEYFRAME_EPSILON.slide, 2);
    if (holdToEnd) {
      keyframe += `
    @keyframes fp-${i} {
      0%, ${enterBound}% { transform: ${enterT}; }
      ${win.startPct} { transform: translate(0px, 0px); }
      100% { transform: translate(0px, 0px); }
    }
    .fp-${i} { animation: fp-${i} ${dur} infinite; }`;
    } else {
      keyframe += `
    @keyframes fp-${i} {
      0%, ${enterBound}% { transform: ${enterT}; }
      ${win.startPct} { transform: translate(0px, 0px); }
      ${win.holdEndPct} { transform: translate(0px, 0px); }
      ${win.transEndPct} { transform: ${exitT}; }
      ${padAfter(transNum, KEYFRAME_EPSILON.slide, 2)}%, 100% { transform: ${exitT}; }
    }
    .fp-${i} { animation: fp-${i} ${dur} infinite; }`;
    }
    clipDef = `<clipPath id="fc-${i}"><rect width="${width}" height="${height}" /></clipPath>`;
    inner = `<g clip-path="url(#fc-${i})" class="fp-${i}">\n${inner}\n  </g>`;
  }

  const group = `  <g class="f f-${i}">${clipDef}\n${inner}\n  </g>`;
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
      } else if (overlay.kind === "interact") {
        const { svgMarkup, css } = renderInteractOverlay(overlay, i, timeOffset, timeOffset + frame.duration, totalDuration, totalSec);
        groups.push(svgMarkup);
        keyframes.push(css);
      }
    }
  }
  return { groups, keyframes };
}

export function generateAnimatedSvg(config: AnimationConfig): string {
  const { width, height } = config;
  // DM-1557: snapshot the glyph-defs registry so we can emit ONLY the glyphs the
  // typing overlays (rendered below as glyph paths) add — without re-emitting
  // (and duplicating the ids of) any glyphs the caller already registered for
  // the frames it passed in. The registry is append-only until the next clear.
  const glyphDefsStart = glyphDefCount();
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

    // DM-1548: unified entrance/exit composition. Classify the two halves of this
    // boundary independently — the entrance from the previous transition, the exit
    // from this frame's own — and route MIXED-family boundaries (the ones a single
    // branch would drop half of) through `emitComposedFrame`. Same-type chains and
    // the slide/fade mixes the DM-1414 branches already compose stay on those
    // branches, so their output is byte-identical (see `composedBoundaryNeeded`).
    const composedEntrance = classifyEntrance(prevType, entersViaMagicMove, prevFrame?.transition?.easing);
    const composedExit = classifyExit(transType);
    const useComposed = composedBoundaryNeeded(composedEntrance.kind, composedExit.kind);

    if (useComposed) {
      // Mixed-family boundary: compose the entrance (from prevType) and the exit
      // (from ownType) as independent tracks. The entrance overlaps the
      // predecessor's transition window, opening at `timeOffset - prevTransDur`.
      const composedEnterStartPct = pct(Math.max(0, timeOffset - prevTransDur), totalDuration);
      const r = emitComposedFrame(
        i, frame.svgContent, composedEntrance, composedExit, { width, height },
        { enterStartPct: composedEnterStartPct, startPct, holdEndPct, transEndPct }, totalSec, holdLastFrame,
      );
      frameGroups.push(r.group);
      keyframes.push(r.keyframe);
      // A `shine` EXIT still sweeps its gradient highlight over the handoff window
      // on top of the composed dissolve (same helper as the crossfade branch).
      if (transType === "shine") {
        const sweep = buildShineSweep({ id: `tr${i}`, x: 0, y: 0, width, height, startPct: holdEndPct, endPct: transEndPct, totalSec });
        shineTransitionGroups.push(sweep.markup);
        keyframes.push(sweep.css);
      }

    } else if (ownDir != null) {
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
      // DM-1524 / DM-1547: wipe / iris / wipe-radial / wipe-clock reveal-on-top.
      // This frame HOLDS beneath (opacity 1 through its window) and hard-cuts out;
      // a reveal predecessor's handoff instead UNVEILS this frame on top via an
      // animated `clip-path` over the entrance window. The reveal SHAPE is derived
      // from the PREVIOUS type (`revealShapeOf` folds `wipe-radial` into the iris
      // circle and `wipe-clock` into the polygon sweep); the hold-then-cut exit
      // serves whatever reveals on top NEXT.
      const entranceReveal = prevReveal && prevType != null ? revealShapeOf(prevType) : null;
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
  // DM-1557: glyph-path defs the typing overlays registered while rendering
  // above (only the ones added since our snapshot), for their `<use href="#gN">`.
  // Then roll the registry back to the snapshot so this call is self-contained —
  // a repeat call re-assigns the same ids and the output stays byte-stable.
  const overlayGlyphDefs = getGlyphDefsSince(glyphDefsStart);
  truncateGlyphDefs(glyphDefsStart);
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${a11y.roleAttr}>${a11y.markup}
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}${overlayGlyphDefs}
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
 * DM-1557: pixel-accurate wrap. Break `text` into lines no wider than
 * `maxWidthPx`, measuring each character's real advance via `advOf` — so a
 * PROPORTIONAL font wraps where it actually overflows, not at a coarse char
 * count. Same textarea semantics as `wrapTypingText`: break on spaces, char-
 * break a word wider than the whole line, honor explicit newlines.
 * `maxWidthPx === Infinity` → no wrap (one line per explicit-newline paragraph).
 */
function wrapTypingTextPx(text: string, maxWidthPx: number, advOf: (ch: string) => number): string[] {
  const wordPx = (w: string): number => { let s = 0; for (const ch of w) s += advOf(ch); return s; };
  const spacePx = advOf(" ");
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (maxWidthPx === Infinity) { lines.push(paragraph); continue; }
    if (paragraph === "") { lines.push(""); continue; }
    let cur = "";
    let curPx = 0;
    for (let word of paragraph.split(" ")) {
      // A single word wider than the line char-breaks across lines.
      while (wordPx(word) > maxWidthPx) {
        if (cur !== "") { lines.push(cur); cur = ""; curPx = 0; }
        const cps = [...word];
        let take = "";
        let takePx = 0;
        let i = 0;
        for (; i < cps.length; i++) {
          const a = advOf(cps[i]);
          if (take !== "" && takePx + a > maxWidthPx) break;
          take += cps[i];
          takePx += a;
        }
        lines.push(take);
        word = cps.slice(i).join("");
      }
      if (word === "") continue;
      const wpx = wordPx(word);
      if (cur === "") { cur = word; curPx = wpx; }
      else if (curPx + spacePx + wpx <= maxWidthPx) { cur += " " + word; curPx += spacePx + wpx; }
      else { lines.push(cur); cur = word; curPx = wpx; }
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
/** DM-1555: default "think" pause (ms) between typing a wrong glyph and
 *  backspacing it — the beat a real typist takes to notice the slip. */
const DEFAULT_MISTAKE_THINK_MS = 400;
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
 * DM-1518 / DM-1557: resolve the overlay font once and return a per-character
 * advance function (px) measured via fontkit, plus whether the font actually
 * resolved. Proportional fonts fall out for free — `glyphForCodePoint().
 * advanceWidth` differs per glyph, so a variable-width family measures
 * correctly, not just the monospace default. Falls back to the uniform 0.6em
 * estimate when the font can't be resolved (a platform without the face), so
 * the caret/reveal stay self-consistent even without a measurable font. DM-1558
 * routes an author `fontFamily` here.
 */
function overlayAdvances(
  fontFamily: string, fontSize: number,
): { advOf: (ch: string) => number; measured: boolean } {
  const estimate = fontSize * MONO_CHAR_WIDTH_RATIO;
  let font: ReturnType<typeof getFontInstance> = null;
  try {
    font = getFontInstance(resolveFontKey(fontFamily), 400, fontSize, 0);
  } catch {
    font = null;
  }
  if (font == null) return { advOf: () => estimate, measured: false };
  const scale = fontSize / font.unitsPerEm;
  const advOf = (ch: string): number => {
    const cp = ch.codePointAt(0);
    if (cp == null) return estimate;
    const g = font.glyphForCodePoint(cp);
    const adv = (g?.advanceWidth ?? 0) * scale;
    return adv > 0 ? adv : estimate;
  };
  return { advOf, measured: true };
}

/**
 * Cumulative per-line x-offsets from the measured advances: `cum[li][k]` = the
 * caret x after `k` glyphs of line `li`. `chars` is the per-line code-point
 * array (astral pairs count as one glyph, matching the reveal + caret stepping).
 */
function cumFromChars(chars: string[][], advOf: (ch: string) => number): number[][] {
  return chars.map((line) => {
    const c = [0];
    for (let i = 0; i < line.length; i++) c.push(c[i] + advOf(line[i]));
    return c;
  });
}

/** One revealed glyph's placement + reveal time, precomputed once (DM-1518). */
interface TypedGlyph { li: number; edge: number; appearMs: number }

/** A caret waypoint — the caret steps to `edge` (on line `li`) at `appearMs`.
 *  Distinct from `TypedGlyph` because a mistake makes the caret RETREAT
 *  (backspace) and re-advance, so its path has more waypoints than the text has
 *  glyphs (DM-1555). */
interface CaretStep { li: number; edge: number; appearMs: number }

/** A temporarily-painted wrong glyph (DM-1555): shown at `[showMs, hideMs)` at
 *  `leftEdge` on line `li`, then backspaced away. `ch` is the mistyped char. */
interface MistakeGlyph { li: number; leftEdge: number; ch: string; showMs: number; hideMs: number }

/** QWERTY neighbor of each lowercase letter — the plausible "fat-finger" slip a
 *  typist makes. Used for the default wrong character when `mistakes` doesn't
 *  spell one out (DM-1555). */
const QWERTY_NEIGHBORS: Record<string, string> = {
  a: "s", b: "v", c: "x", d: "f", e: "r", f: "g", g: "h", h: "j", i: "o",
  j: "k", k: "l", l: "k", m: "n", n: "m", o: "i", p: "o", q: "w", r: "e",
  s: "d", t: "y", u: "i", v: "b", w: "e", x: "z", y: "u", z: "x",
};

/** Deterministically choose a wrong glyph to mistype for `correct`: a QWERTY
 *  neighbor (case-preserved) for letters, the next digit for digits, else a
 *  PRNG-picked common letter. Never returns `correct` itself. DM-1555. */
function pickWrongChar(correct: string, rng: () => number): string {
  const lower = correct.toLowerCase();
  const neighbor = QWERTY_NEIGHBORS[lower];
  if (neighbor != null) return correct === lower ? neighbor : neighbor.toUpperCase();
  if (/[0-9]/.test(correct)) return String((parseInt(correct, 10) + 1) % 10);
  const letters = "etaoinshrdlu";
  let pick = letters[Math.floor(rng() * letters.length)];
  if (pick === correct) pick = letters[(letters.indexOf(pick) + 1) % letters.length];
  return pick;
}

/**
 * DM-1555: decide WHERE typos fire. Returns a map from flattened character index
 * (0-based over the whole typed string, across wrapped lines) to the wrong glyph
 * to type there. Both the rate spelling and the explicit-list spelling are
 * deterministic (seeded off the text), so the emitted SVG is byte-stable. Only
 * alphanumeric characters get rate-driven typos, never two adjacent, never the
 * final character. Returns an empty map for paste mode or no `mistakes`.
 */
function planMistakes(chars: string[][], overlay: TypingOverlay): Map<number, string> {
  const map = new Map<number, string>();
  if (overlay.mode === "paste" || overlay.mistakes == null) return map;
  const flat: string[] = [];
  for (const line of chars) for (const ch of line) flat.push(ch);
  const rng = mulberry32(hashString(overlay.text) ^ 0x5bd1e995);
  const m = overlay.mistakes;
  if (typeof m === "number") {
    const rate = Math.max(0, Math.min(1, m));
    for (let i = 0; i < flat.length - 1; i++) {
      const ch = flat[i];
      if (!/[A-Za-z0-9]/.test(ch)) continue;
      if (map.has(i - 1)) continue; // never two typos back-to-back
      if (rng() < rate) map.set(i, pickWrongChar(ch, rng));
    }
  } else {
    for (const spec of m) {
      if (spec.at < 0 || spec.at >= flat.length) continue;
      map.set(spec.at, spec.wrong != null && spec.wrong.length > 0 ? spec.wrong : pickWrongChar(flat[spec.at], rng));
    }
  }
  return map;
}

/** How many extra keystroke-equivalents a typo costs, for sizing the natural
 *  type window: a wrong glyph + a backspace + the "think" pause between them
 *  (DM-1555). One per mistake. Used to grow `naturalEndMs` so mistakes don't
 *  over-compress the rest of the typing. */
function mistakeOverheadMs(mistakes: Map<number, string>, speed: number, thinkMs: number): number {
  return mistakes.size * (2 * speed + thinkMs);
}

/**
 * DM-1518 / DM-1555: the shared reveal plan the line clips, the mistake glyphs,
 * AND the caret ride, so they can never desync. Walks the typed characters in
 * order building a stream of timed events, normalized into
 * `[typeStartMs, typeStartMs + effTypeDur]`, then splits them into:
 *   - `glyphs` — one `TypedGlyph` per FINAL character (drives the line clips);
 *     a mistyped position's correct glyph appears only AFTER its detour.
 *   - `mistakes` — the temporarily-painted wrong glyphs (`[showMs, hideMs)`).
 *   - `caretSteps` — the caret's full path, including the RETREAT to the prefix
 *     edge on backspace and the re-advance on retype (DM-1555).
 * `mode: "paste"` reveals every glyph at `typeStartMs` (no mistakes); `type`
 * spaces them by the (optionally jittered) speed. Determinism: same PRNG seed
 * off the text as `planMistakes`, so the whole thing stays byte-stable.
 */
function buildTypingPlan(
  chars: string[][], cum: number[][], overlay: TypingOverlay,
  speed: number, typeStartMs: number, effTypeDur: number,
  advOf: (ch: string) => number, mistakes: Map<number, string>, thinkMs: number,
): { glyphs: TypedGlyph[]; mistakeGlyphs: MistakeGlyph[]; caretSteps: CaretStep[] } {
  const glyphs: TypedGlyph[] = [];
  const mistakeGlyphs: MistakeGlyph[] = [];
  const caretSteps: CaretStep[] = [];
  const paste = overlay.mode === "paste";
  const jitter = paste ? 0 : Math.max(0, Math.min(1, overlay.jitter ?? 0));
  const rng = mulberry32(hashString(overlay.text) ^ 0x9e3779b9);
  const nextDelay = (): number => (paste ? 0 : Math.max(speed * 0.25, speed * (1 + (rng() * 2 - 1) * jitter)));

  // First pass: build the timed event stream with RAW (jittered) delays. Each
  // event carries a callback that stamps the finalized `appearMs` in pass two.
  interface Ev { rawDelay: number; apply: (t: number) => void }
  const evs: Ev[] = [];
  let gi = 0;
  chars.forEach((line, li) => {
    for (let k = 0; k < line.length; k++) {
      const wrong = mistakes.get(gi);
      if (wrong != null && !paste) {
        const leftEdge = cum[li][k];
        const wrongEdge = leftEdge + advOf(wrong);
        const mis: MistakeGlyph = { li, leftEdge, ch: wrong, showMs: 0, hideMs: 0 };
        mistakeGlyphs.push(mis);
        // Type the wrong glyph — caret jumps past it.
        evs.push({ rawDelay: nextDelay(), apply: (t) => { mis.showMs = t; caretSteps.push({ li, edge: wrongEdge, appearMs: t }); } });
        // Notice it (think pause), then backspace — caret RETREATS to the prefix.
        evs.push({ rawDelay: thinkMs + nextDelay(), apply: (t) => { mis.hideMs = t; caretSteps.push({ li, edge: leftEdge, appearMs: t }); } });
      }
      // Type the correct glyph — caret advances to its measured right edge.
      const edge = cum[li][k + 1];
      evs.push({ rawDelay: nextDelay(), apply: (t) => { glyphs.push({ li, edge, appearMs: t }); caretSteps.push({ li, edge, appearMs: t }); } });
      gi++;
    }
  });

  // Second pass: normalize the raw delays into the effective type window so the
  // last CORRECT glyph lands exactly at typeStartMs + effTypeDur.
  let rawTotal = 0;
  for (const e of evs) rawTotal += e.rawDelay;
  const scale = rawTotal > 0 ? effTypeDur / rawTotal : 0;
  let acc = 0;
  for (const e of evs) {
    acc += e.rawDelay;
    e.apply(paste ? typeStartMs : typeStartMs + acc * scale);
  }
  return { glyphs, mistakeGlyphs, caretSteps };
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
 * DM-1557: paint one run of typed text. Renders it as GLYPH PATHS via
 * `renderTextAsPath` (forced into `paths` mode) so the painted advances equal
 * the measured ones on EVERY viewer — no dependency on the viewer having the
 * font, and proportional families lay out correctly. `xOffsets` (the measured
 * per-glyph left edges) pin each glyph exactly where the caret/clip expect it,
 * so the whole system stays locked regardless of the font's own kerning. The
 * baseline is pinned by `ascentOverride: 0` (so `baselineY === y`). Returns
 * `null` when the font can't be resolved (e.g. a platform without the face), so
 * the caller falls back to a native `<text>` element. The returned `<g>` carries
 * `aria-label` for accessibility.
 */
function typedGlyphMarkup(
  text: string, x: number, baselineY: number, fontSize: number, fontFamily: string, color: string, xOffsets?: number[],
): string | null {
  if (text === "") return null;
  return withRenderTextMode("paths", () =>
    renderTextAsPath(text, x, baselineY, fontSize, fontFamily, "400", color, undefined, undefined, xOffsets, undefined, 0));
}

/**
 * DM-1518 / DM-1557 typewriter reveal: one wrapped line per group, each unveiled
 * by a width-growing clip. The clip's right edge steps to the fontkit-MEASURED
 * cumulative advance as each glyph is typed (character-by-character), so the
 * revealed text edge — and the caret riding the same plan — sit exactly where
 * the glyphs paint. The text is painted as glyph paths (DM-1557) for viewer-
 * independent advances, falling back to a native `<text>` when the font can't be
 * resolved. Below `MAX_DISCRETE_TYPING_CHARS` the reveal steps per keystroke
 * (`step-end`); above it, it sweeps linearly between the line's first/last glyph
 * for bounded CSS.
 */
function buildTypingLines(
  chars: string[][], overlay: TypingOverlay, id: string,
  cum: number[][], glyphs: TypedGlyph[], discrete: boolean,
  lineHeight: number, fontSize: number, textHeight: number, hiddenW: string, color: string, fontFamily: string,
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
    // DM-1557: paint the line as glyph paths (advances match on every viewer),
    // pinning each glyph at its measured left edge so the reveal clip + caret
    // stay locked. Fall back to a native <text> when the font can't resolve.
    const xOffsets = cum[li].slice(0, line.length);
    const glyphMarkup = typedGlyphMarkup(lineText, overlay.x, lineY, fontSize, fontFamily, color, xOffsets);
    if (glyphMarkup != null) {
      parts.push(`  <g class="${id}-text" clip-path="url(#${clipId})">${glyphMarkup}</g>`);
    } else {
      parts.push(
        `  <text class="${id}-text" x="${overlay.x}" y="${lineY}" fill="${color}" font-size="${fontSize}" font-family="${escapeHtml(fontFamily)}" clip-path="url(#${clipId})">${escapeHtml(lineText)}</text>`,
      );
    }

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
 * DM-870 / DM-1518 / DM-1555: blinking insertion caret. It rides the SAME reveal
 * plan as the text (`caretSteps`), stepping to each waypoint the instant it is
 * reached (`step-end`), so it is always glued to the true trailing edge of the
 * visible text — never lagging behind it. With a mistake (DM-1555) the waypoints
 * include a RETREAT (backspace) to the prefix edge and a re-advance on retype,
 * so the caret visibly steps back then forward. Parks at the final text end and
 * blinks until the overlay disappears. Returns empty arrays when no caret is
 * requested.
 */
function buildTypingCaret(
  overlay: TypingOverlay, id: string, color: string,
  caretSteps: CaretStep[], lineHeight: number, fontSize: number,
  typeStartPct: string, typeStartMs: number, textEndMs: number, holdEndMs: number, holdEndPct: string, disappearPct: string,
  totalDuration: number, totalSec: number,
): { parts: string[]; cssRules: string[] } {
  const parts: string[] = [];
  const cssRules: string[] = [];
  if (overlay.caret != null && overlay.caret !== false && caretSteps.length > 0) {
    const caretOpts = typeof overlay.caret === "object" ? overlay.caret : {};
    const caretColor = caretOpts.color ?? color;
    const caretW = caretOpts.width ?? 2;
    const blinkMs = caretOpts.blinkMs ?? 530;
    const lastG = caretSteps[caretSteps.length - 1];
    const endX = lastG.edge;
    const endY = lastG.li * lineHeight;

    // Position track: hold at the first line's left margin until typing begins,
    // then jump to each waypoint's measured edge as it is reached (step-end),
    // then park at the text end through the blink + disappear.
    const b = monotoneStops();
    b.push(0, `transform: translate(0px, 0px);`);
    b.push(Math.max(0.01, pctNum(typeStartMs, totalDuration)), `transform: translate(0px, 0px);`);
    for (const g of caretSteps) b.push(pctNum(g.appearMs, totalDuration), `transform: translate(${g.edge.toFixed(2)}px, ${(g.li * lineHeight).toFixed(2)}px);`);
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

/**
 * DM-1555: paint the mistyped glyphs. Each wrong glyph is a standalone element
 * anchored at the prefix edge on its line, shown across `[showMs, hideMs)` and
 * hidden otherwise (a `step-end` opacity toggle). It sits OUTSIDE the line clip
 * (which reveals only the correct text), so it can appear over the held prefix
 * during the typo and vanish on backspace without disturbing the reveal. Returns
 * empty arrays when there are no mistakes.
 */
function buildTypingMistakes(
  overlay: TypingOverlay, id: string, color: string, fontFamily: string,
  fontSize: number, lineHeight: number, mistakeGlyphs: MistakeGlyph[],
  totalDuration: number, totalSec: number,
): { parts: string[]; cssRules: string[] } {
  const parts: string[] = [];
  const cssRules: string[] = [];
  mistakeGlyphs.forEach((m, n) => {
    const cls = `${id}-mis${n}`;
    const lineY = overlay.y + m.li * lineHeight;
    // DM-1557: paint the wrong glyph as a glyph path (viewer-independent), same
    // as the line text; fall back to <text> when the font can't be resolved.
    const glyphMarkup = typedGlyphMarkup(m.ch, overlay.x + m.leftEdge, lineY, fontSize, fontFamily, color);
    if (glyphMarkup != null) {
      parts.push(`  <g class="${cls}">${glyphMarkup}</g>`);
    } else {
      parts.push(
        `  <text class="${cls}" x="${(overlay.x + m.leftEdge).toFixed(2)}" y="${lineY}" fill="${color}" font-size="${fontSize}" font-family="${escapeHtml(fontFamily)}">${escapeHtml(m.ch)}</text>`,
      );
    }
    // step-end opacity: 0 until showMs, 1 through the typo, 0 on backspace.
    const showPct = pct(m.showMs, totalDuration);
    const hidePct = pct(Math.max(m.hideMs, m.showMs + 1), totalDuration);
    cssRules.push(`
    @keyframes ${cls} { 0% { opacity: 0; } ${showPct} { opacity: 1; } ${hidePct} { opacity: 0; } 100% { opacity: 0; } }
    .${cls} { animation: ${cls} ${totalSec.toFixed(2)}s step-end infinite; }`);
  });
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
  // DM-1558: the family the reveal measures + paints. Defaults to the monospace
  // field stack; an author `fontFamily` (e.g. the captured field's own family)
  // overrides it and — via the glyph-path renderer (DM-1557) — measures, wraps,
  // and paints proportionally.
  const fontFamily = overlay.fontFamily ?? OVERLAY_TYPING_FONT;
  const thinkMs = overlay.mistakeThinkMs ?? DEFAULT_MISTAKE_THINK_MS;
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
  // DM-1518 / DM-1557: resolve the font's per-character advances up front —
  // proportional-aware — and wrap by MEASURED PIXEL WIDTH (not a coarse char
  // count), so a proportional field-matching family breaks where it actually
  // overflows. Falls back to the uniform estimate when the font can't resolve.
  const { advOf } = overlayAdvances(fontFamily, fontSize);
  const lines = wrapTypingTextPx(overlay.text, maxLineWidth, advOf);
  // Per-line code-point arrays (astral pairs count as one glyph) drive both the
  // reveal stepping and the caret, so they can't desync.
  const chars = lines.map((l) => [...l]);
  // DM-1518: fontkit-measured cumulative advances per line — the caret + reveal
  // ride these exact edges instead of the old uniform 0.6em estimate.
  const cum = cumFromChars(chars, advOf);
  const visibleChars = Math.max(1, chars.reduce((n, l) => n + l.length, 0));
  const longestLineWidth = cum.reduce((m, c) => Math.max(m, c[c.length - 1]), 0);
  const discrete = overlay.mode !== "paste" && visibleChars <= MAX_DISCRETE_TYPING_CHARS;
  // DM-1555: mistakes are per-keystroke detours — only meaningful in the
  // discrete (per-glyph) reveal, never in paste or the coarse linear sweep.
  const mistakes = discrete ? planMistakes(chars, overlay) : new Map<number, string>();

  const parts: string[] = [];
  const cssRules: string[] = [];

  // ── Timeline — all stops clamped to the frame so the overlay can't leak
  // across the cut into the next frame. `naturalEnd` is when typing finishes
  // at the requested speed; if that runs past the frame we compress the reveal
  // to fit. The fully-typed text then HOLDS until just before the frame ends
  // (the old hard 3 s cap cut long text off mid-type), then fades out.
  const disappearGap = 150;
  // DM-1555: grow the natural window by each typo's cost (wrong glyph +
  // backspace + think pause) so mistakes don't over-compress the rest.
  const naturalEndMs = typeStartMs + visibleChars * speed + mistakeOverheadMs(mistakes, speed, thinkMs);
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

  // DM-1518 / DM-1555: the shared reveal plan — the final glyphs (drive the line
  // clips), the temporary mistake glyphs, and the caret waypoints (including
  // backspace retreats). All three ride one plan, so they can't desync.
  const { glyphs, mistakeGlyphs, caretSteps } = buildTypingPlan(
    chars, cum, overlay, speed, typeStartMs, effTypeDur, advOf, mistakes, thinkMs,
  );

  // Typewriter reveal — one <text> per wrapped line, each unveiled by a width-
  // growing clip stepping to each glyph's measured edge as it is typed.
  const ln = buildTypingLines(chars, overlay, id, cum, glyphs, discrete, lineHeight, fontSize, textHeight, hiddenW, color, fontFamily, totalDuration, holdEndPct, disappearPct, totalSec);
  parts.push(...ln.parts);
  cssRules.push(...ln.cssRules);

  // DM-1555: the mistyped glyphs — painted just long enough to be seen, then
  // backspaced away (opacity 1 over [showMs, hideMs), 0 otherwise).
  const mis = buildTypingMistakes(overlay, id, color, fontFamily, fontSize, lineHeight, mistakeGlyphs, totalDuration, totalSec);
  parts.push(...mis.parts);
  cssRules.push(...mis.cssRules);

  // Whole-overlay visibility — shared by every line's <text>.
  const typeStartPct = pct(typeStartMs, totalDuration);
  cssRules.push(`
    @keyframes ${id}-vis { 0%, ${typeStartPct} { opacity: 0; } ${pct(typeStartMs + 30, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${disappearPct}, 100% { opacity: 0; } }
    .${id}-text { animation: ${id}-vis ${totalSec.toFixed(2)}s infinite; }`);

  // Optional blinking insertion caret glued to the growing text edge. In paste
  // mode only the final edge matters, so the caret rides a single end stop.
  const caretRide = overlay.mode === "paste" ? caretSteps.slice(-1) : caretSteps;
  const cr = buildTypingCaret(overlay, id, color, caretRide, lineHeight, fontSize, typeStartPct, typeStartMs, textEndMs, holdEndMs, holdEndPct, disappearPct, totalDuration, totalSec);
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

/** DM-1565: per-treatment defaults for the synthetic interaction overlay. */
const INTERACT_DEFAULTS: Record<"hover" | "focus" | "press", { fill: string; fillOpacity: number; ring: string | null; scale: number }> = {
  hover: { fill: "#ffffff", fillOpacity: 0.18, ring: null, scale: 1.03 },
  focus: { fill: "#4c9ffe", fillOpacity: 0.10, ring: "#4c9ffe", scale: 1.0 },
  press: { fill: "#000000", fillOpacity: 0.18, ring: null, scale: 0.96 },
};

/**
 * DM-1565 (docs/94 Option 4): render a SYNTHETIC interaction-feedback overlay —
 * a fake `:hover` / `:focus` / `:active` treatment over a region that has no real
 * CSS state to force. A translucent fill and/or a focus ring live inside one
 * `<g>` whose OPACITY and `transform: scale` (about the box center) animate as
 * ONE fused keyframe animation (a single timeline that can't desync across
 * engines — docs/84): fade + pop IN over [appear, peak], HOLD at peak, then
 * RELEASE back to opacity 0 / scale(1) before the frame ends. So it appears, then
 * RESTS at identity (a re-capture of a rested frame sees nothing). `opacity` +
 * `transform` only — no animated filter.
 */
function renderInteractOverlay(
  overlay: InteractOverlay,
  frameIdx: number,
  frameStart: number,
  frameEnd: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const id = `ix${frameIdx}`;
  const treatment = overlay.treatment ?? "hover";
  const d = INTERACT_DEFAULTS[treatment];
  const fill = overlay.fill ?? d.fill;
  const fillOpacity = overlay.fillOpacity ?? d.fillOpacity;
  // `ring` defaults to the treatment ring (a focus ring for `focus`); an explicit
  // color adds one to any treatment, `"none"` forces it off.
  const ring = overlay.ring ?? d.ring;
  const ringWidth = overlay.ringWidth ?? 2;
  const radius = overlay.radius ?? 6;
  const scaleTo = overlay.scale ?? d.scale;
  const delay = overlay.delay ?? 200;
  const duration = overlay.duration ?? 240;
  const releaseMs = overlay.releaseMs ?? 180;

  // Timeline (all clamped to the frame so the treatment can't leak past the cut).
  const appearMs = Math.min(frameStart + delay, frameEnd);
  const peakMs = Math.min(appearMs + duration, frameEnd);
  // `press` is a quick tap by default; hover/focus hold until just before the
  // frame ends. An explicit `holdMs` overrides either.
  const defaultHold = treatment === "press" ? 120 : Math.max(0, frameEnd - releaseMs - peakMs);
  const holdMs = overlay.holdMs ?? defaultHold;
  const holdEndMs = Math.min(Math.max(peakMs, peakMs + holdMs), Math.max(peakMs, frameEnd - releaseMs));
  const releaseEndMs = Math.min(holdEndMs + releaseMs, frameEnd);

  const cx = overlay.x + overlay.width / 2;
  const cy = overlay.y + overlay.height / 2;
  const rAttr = radius > 0 ? ` rx="${radius}" ry="${radius}"` : "";

  const layers: string[] = [];
  if (fill !== "none") {
    layers.push(`    <rect x="${overlay.x}" y="${overlay.y}" width="${overlay.width}" height="${overlay.height}"${rAttr} fill="${fill}" fill-opacity="${fillOpacity}" />`);
  }
  if (ring != null && ring !== "none") {
    // Inset by half the stroke so the ring stays inside the region's bounds.
    const hw = ringWidth / 2;
    layers.push(`    <rect x="${overlay.x + hw}" y="${overlay.y + hw}" width="${Math.max(0, overlay.width - ringWidth)}" height="${Math.max(0, overlay.height - ringWidth)}"${rAttr} fill="none" stroke="${ring}" stroke-width="${ringWidth}" />`);
  }
  const svgMarkup = `  <g class="${id}">\n${layers.join("\n")}\n  </g>`;

  // One fused animation: opacity + transform at each stop (single timeline). The
  // in-segment eases out (decelerates into peak); the release eases in.
  const s = (ms: number): string => pct(ms, totalDuration);
  const css = `
    @keyframes ${id} {
      0% { opacity: 0; transform: scale(1); }
      ${s(appearMs)} { opacity: 0; transform: scale(1); animation-timing-function: ease-out; }
      ${s(peakMs)} { opacity: 1; transform: scale(${scaleTo}); }
      ${s(holdEndMs)} { opacity: 1; transform: scale(${scaleTo}); animation-timing-function: ease-in; }
      ${s(releaseEndMs)} { opacity: 0; transform: scale(1); }
      100% { opacity: 0; transform: scale(1); }
    }
    .${id} { animation: ${id} ${totalSec.toFixed(2)}s linear infinite; transform-origin: ${cx}px ${cy}px; }`;
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
