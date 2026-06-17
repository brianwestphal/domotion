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
import type { AnimationOverlay, TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, IntraFrameAnimation } from "./overlay-schema.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { DEFAULT_TRANSITION_MS, frameAdvanceMs, transitionDurationMs } from "./frame-timeline.js";
import { KEYFRAME_EPSILON, padAfter, padBefore } from "../utils/keyframe-pad.js";

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
     */
    type: "crossfade" | "push-left" | "scroll" | "cut" | "magic-move";
    duration: number;
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
export type { TypingOverlay, TapOverlay, SvgOverlay, BlinkOverlay, AnimationOverlay, IntraFrameAnimation };

export interface AnimationConfig {
  width: number;
  height: number;
  frames: AnimationFrame[];
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
  groups.push(`  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`);
  keyframes.push(`
    @keyframes fv-${i} {
      0% { opacity: 0; visibility: hidden; }
      ${beforeS}% { opacity: 0; visibility: hidden; }
      ${sNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${hNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${afterH}% { opacity: 0; visibility: hidden; }
      100% { opacity: 0; visibility: hidden; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; animation-timing-function: step-end; }`);

  // Bridge composite: visible during the transition window only.
  groups.push(`  <g class="f mm-${i}">\n${mm.compositeSvg}\n  </g>`);
  keyframes.push(`
    @keyframes mmv-${i} {
      0% { opacity: 0; visibility: hidden; }
      ${beforeH}% { opacity: 0; visibility: hidden; }
      ${hNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${tNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${afterT}% { opacity: 0; visibility: hidden; }
      100% { opacity: 0; visibility: hidden; }
    }
    .mm-${i} { animation: mmv-${i} ${totalSec.toFixed(2)}s infinite; animation-timing-function: step-end; }`);

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
function emitCrossfadeOrCutFrame(
  i: number,
  frame: AnimationFrame,
  transType: string,
  transDur: number,
  startPct: string,
  holdEndPct: string,
  transEndPct: string,
  fadeInStartPct: string,
  totalSec: number,
  /** DM-1148: the last frame, when the loop must NOT cross-dissolve, holds
   *  opacity 1 to 100% instead of fading out over its transition window. */
  holdToEnd: boolean,
): { groups: string[]; keyframes: string[] } {
  const groups: string[] = [];
  const keyframes: string[] = [];
  groups.push(`  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`);

  const isCut = transType === "cut" || transDur === 0;
  if (isCut) {
    const startNum = parseFloat(startPct);
    const endNum = parseFloat(transEndPct);
    const beforeStart = padBefore(startNum, KEYFRAME_EPSILON.cull, 3);
    const afterEnd = padAfter(endNum, KEYFRAME_EPSILON.cull, 3);
    keyframes.push(`
    @keyframes fv-${i} {
      0% { opacity: 0; visibility: hidden; }
      ${beforeStart}% { opacity: 0; visibility: hidden; }
      ${startNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${endNum.toFixed(3)}% { opacity: 1; visibility: visible; }
      ${afterEnd}% { opacity: 0; visibility: hidden; }
      100% { opacity: 0; visibility: hidden; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; animation-timing-function: step-end; }`);
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
    }${buildDisplayKeyframes(`fd-${i}`, fadeInStartPct, "100")}
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite, fd-${i} ${totalSec.toFixed(2)}s infinite step-end; }`);
    } else {
      keyframes.push(`
    @keyframes fv-${i} {
      0%, ${prevEnd} ${transEndPct}, 100% { opacity: 0; }
      ${startPct}, ${holdEndPct} { opacity: 1; }
    }${buildDisplayKeyframes(`fd-${i}`, fadeInStartPct, transEndPct)}
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

export function generateAnimatedSvg(config: AnimationConfig): string {
  const { width, height } = config;
  // DM-1145: guard against cross-frame id collisions (reused/cached svgContent).
  const frames = dedupeFrameIds(config.frames);

  const totalDuration = frames.reduce(
    (sum, f) => sum + frameAdvanceMs(f),
    0,
  );
  const totalSec = totalDuration / 1000;

  // Pre-compute per-frame timing windows (used by both the merge pipeline for
  // timeline keyframes and the atomic push/scroll fallbacks below).
  const frameTiming: { startPct: number[]; holdEndPct: number[]; transEndPct: number[] } = {
    startPct: [], holdEndPct: [], transEndPct: [],
  };
  {
    let t = 0;
    for (const f of frames) {
      const td = transitionDurationMs(f);
      frameTiming.startPct.push((t / totalDuration) * 100);
      frameTiming.holdEndPct.push(((t + f.duration) / totalDuration) * 100);
      frameTiming.transEndPct.push(((t + f.duration + td) / totalDuration) * 100);
      t += f.duration + td;
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
    const entersViaPush = prevFrame?.transition?.type === "push-left";
    const entersViaScroll = prevFrame?.transition?.type === "scroll";
    // DM-898: a frame entered from a magic-move transition appears at its own
    // start (= the predecessor's transition end), NOT overlap-faded — the
    // magic-move bridge layer already covered the window, so a crossfade
    // overlap here would double-show the next frame on top of the bridge.
    const entersViaMagicMove = prevFrame?.transition?.type === "magic-move" && prevFrame?.magicMove != null;
    // Both push-left and scroll overlap their transition with the next
    // frame's entry — the next frame is already sliding in while the current
    // one slides out, so its show window starts at `timeOffset - prevTransDur`
    // rather than at `startPct`.
    const entersViaOverlap = entersViaPush || entersViaScroll;
    const prevTransDur = prevFrame != null ? transitionDurationMs(prevFrame) : DEFAULT_TRANSITION_MS;
    const enterStartPct = entersViaOverlap
      ? pct(timeOffset - prevTransDur, totalDuration)
      : startPct;

    if (transType === "push-left") {
      // Push: slide in from right, slide out to left
      frameGroups.push(
        `  <g class="f f-${i}"><clipPath id="fc-${i}"><rect width="${width}" height="${height}" /></clipPath><g clip-path="url(#fc-${i})" class="fp fp-${i}">\n${frame.svgContent}\n  </g></g>`,
      );

      // DM-599: parallel `fd-${i}` animation snaps `display` between none /
      // inline at the visibility boundary so the browser can skip painting
      // this frame's content while it's fully off-screen between cycles.
      // Window is [enterStartPct .. transEndPct] (when the slide has fully
      // exited the viewBox); 0.01% pad on each side keeps the snap inside the
      // existing opacity:0 bookend.
      keyframes.push(slideKeyframes(i, "X", width, entersViaPush, enterStartPct, startPct, holdEndPct, transEndPct, enterStartPct, transEndPct, totalSec));

    } else if (transType === "scroll") {
      // DM-609: `scroll` now means real geometric scroll between two frames
      // (was opacity-only — see DM-604 §10a "replace with new geometric
      // semantics"). Vertical equivalent of `push-left`: incoming frame
      // slides up from the bottom of the viewport, outgoing slides up off
      // the top. Uses height instead of width and translateY instead of
      // translateX, otherwise identical machinery (incl. the cull-friendly
      // `fd-${i}` display animation). (`entersViaScroll` is already computed in
      // the outer scope above — same value, no need to redeclare/shadow it.)
      frameGroups.push(
        `  <g class="f f-${i}"><clipPath id="fc-${i}"><rect width="${width}" height="${height}" /></clipPath><g clip-path="url(#fc-${i})" class="fp fp-${i}">\n${frame.svgContent}\n  </g></g>`,
      );

      keyframes.push(slideKeyframes(i, "Y", height, entersViaScroll, enterStartPct, startPct, holdEndPct, transEndPct, enterStartPct, transEndPct, totalSec));

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
      const r = emitCrossfadeOrCutFrame(i, frame, transType, transDur, startPct, holdEndPct, transEndPct, fadeInStartPct, totalSec, holdToEnd);
      frameGroups.push(...r.groups);
      keyframes.push(...r.keyframes);
    }

    // Overlays
    if (frame.overlays != null) {
      for (const overlay of frame.overlays) {
        if (overlay.kind === "typing") {
          const { svgMarkup, css } = renderTypingOverlay(
            overlay, i, timeOffset, timeOffset + frame.duration, totalDuration, totalSec,
          );
          frameGroups.push(svgMarkup);
          keyframes.push(css);
        } else if (overlay.kind === "tap") {
          const { svgMarkup, css } = renderTapOverlay(
            overlay, i, timeOffset, totalDuration, totalSec,
          );
          frameGroups.push(svgMarkup);
          keyframes.push(css);
        } else if (overlay.kind === "svg") {
          const { svgMarkup, css } = renderSvgOverlay(
            overlay, i, timeOffset, frame.duration, totalDuration, totalSec,
          );
          frameGroups.push(svgMarkup);
          keyframes.push(css);
        } else if (overlay.kind === "blink") {
          const { svgMarkup, css } = renderBlinkOverlay(
            overlay, i, timeOffset, timeOffset + frame.duration, totalDuration, totalSec,
          );
          frameGroups.push(svgMarkup);
          keyframes.push(css);
        }
      }
    }

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
  const canvasBgRect = (bg != null && bg !== "" && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)")
    ? `  <rect width="${width}" height="${height}" fill="${bg}" />\n`
    : "";
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
${config.fontFaceCss != null && config.fontFaceCss !== "" ? config.fontFaceCss + "\n" : ""}    :root { --scene-dur: ${totalSec.toFixed(2)}s; }
    .f { opacity: 0; visibility: hidden; }
    ${keyframes.join("\n")}${animationCss}${cullCss === "" ? "" : "\n" + cullCss}
  </style>
  <g clip-path="url(#viewport-clip)">
${canvasBgRect}${frameGroups.join("\n")}${overlayMarkup}
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

function renderTypingOverlay(
  overlay: TypingOverlay,
  frameIdx: number,
  frameStart: number,
  frameEnd: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const delay = overlay.delay ?? 300;
  const speed = overlay.speed ?? 60;
  const fontSize = overlay.fontSize ?? 14;
  const charWidth = fontSize * 0.6;                 // monospace cell (overlay font is monospace)
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
  const visibleChars = Math.max(1, lines.reduce((n, l) => n + l.length, 0));
  const longestLineChars = lines.reduce((m, l) => Math.max(m, l.length), 0);

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
    const bgW = overlay.mask?.width ?? wrapWidth ?? longestLineChars * charWidth + 8;
    const bgH = Math.max(overlay.mask?.height ?? overlay.bgHeight ?? fontSize + 6, lines.length * lineHeight + 6);
    const bgStartPct = pct(typeStartMs, totalDuration);
    parts.push(
      `  <rect class="${id}-bg" x="${overlay.x - 2}" y="${overlay.y - fontSize + 2}" width="${bgW}" height="${bgH}" fill="${maskColor}" rx="2" />`,
    );
    cssRules.push(`
    @keyframes ${id}-bg { 0%, ${bgStartPct} { opacity: 0; } ${pct(typeStartMs + 50, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${disappearPct}, 100% { opacity: 0; } }
    .${id}-bg { animation: ${id}-bg ${totalSec.toFixed(2)}s infinite; }`);
  }

  // Typewriter reveal: one <text> per wrapped line, each unveiled by a
  // width-growing clip during the slice of the type timeline when that line's
  // characters are typed (line N starts after line N-1 finishes), so the caret
  // advances down the field exactly as it would in the browser.

  // DM-870: per-line type timing, collected for the optional caret below.
  const lineTimings: Array<{ li: number; startMs: number; endMs: number; len: number }> = [];

  let cumChars = 0;
  lines.forEach((line, li) => {
    const lineY = overlay.y + li * lineHeight;
    // +1 cell of slack so the last glyph never clips: the real monospace
    // advance is slightly wider than the 0.6em estimate, and the trailing cell
    // is where the caret would sit just after the typed character anyway.
    const lineWidth = line.length * charWidth + charWidth;
    const clipId = `${id}-clip${li}`;
    const lineStartMs = typeStartMs + (cumChars / visibleChars) * effTypeDur;
    const lineEndMs = typeStartMs + ((cumChars + line.length) / visibleChars) * effTypeDur;
    const lineStartPct = pct(lineStartMs, totalDuration);
    const lineEndPct = pct(lineEndMs, totalDuration);
    lineTimings.push({ li, startMs: lineStartMs, endMs: lineEndMs, len: line.length });
    cumChars += line.length;

    parts.push(`  <defs><clipPath id="${clipId}"><rect class="${id}-rev${li}" x="${overlay.x}" y="${lineY - fontSize}" width="0" height="${textHeight}" /></clipPath></defs>`);
    parts.push(
      `  <text class="${id}-text" x="${overlay.x}" y="${lineY}" fill="${color}" font-size="${fontSize}" font-family="'SF Mono', Menlo, Monaco, monospace" clip-path="url(#${clipId})">${escapeHtml(line)}</text>`,
    );
    // DM-1204: the reveal clip MUST sweep linearly so its right edge tracks the
    // caret (whose position track is `linear`). Without an explicit timing
    // function the width animation defaults to CSS `ease`, which races ~80%
    // through the sweep at the time-midpoint while the linear caret is only at
    // 50% — that desync read as the caret lagging ~10–20 chars behind the
    // revealed text mid-type, even though the endpoints (parked state) matched.
    cssRules.push(`
    @keyframes ${id}-rev${li} { 0%, ${lineStartPct} { width: 0; } ${lineEndPct} { width: ${lineWidth}px; } ${holdEndPct} { width: ${lineWidth}px; } ${disappearPct}, 100% { width: 0; } }
    .${id}-rev${li} { animation: ${id}-rev${li} ${totalSec.toFixed(2)}s linear infinite; }`);
  });

  // Whole-overlay visibility — shared by every line's <text>.
  const typeStartPct = pct(typeStartMs, totalDuration);
  cssRules.push(`
    @keyframes ${id}-vis { 0%, ${typeStartPct} { opacity: 0; } ${pct(typeStartMs + 30, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${disappearPct}, 100% { opacity: 0; } }
    .${id}-text { animation: ${id}-vis ${totalSec.toFixed(2)}s infinite; }`);

  // DM-870: blinking insertion caret. Sweeps the type position while typing
  // (one linear translate segment per wrapped line, jumping to the next line's
  // start), then parks at the end of the last line and blinks (step-end opacity
  // toggle) until the overlay disappears. Two animations on one rect: a linear
  // position track + a step-end opacity blink.
  if (overlay.caret != null && overlay.caret !== false && lineTimings.length > 0) {
    const caretOpts = typeof overlay.caret === "object" ? overlay.caret : {};
    const caretColor = caretOpts.color ?? color;
    const caretW = caretOpts.width ?? 2;
    const blinkMs = caretOpts.blinkMs ?? 530;
    const last = lineTimings[lineTimings.length - 1];
    const endX = last.len * charWidth;
    const endY = last.li * lineHeight;

    // Position track: hold at line 0 start until typing begins, then sweep each
    // line, then hold at the text end through the blink + disappear.
    //
    // DM-1204 (multi-line): a line ends and the next begins at the same instant
    // (type timing is contiguous — line N+1 starts the ms line N finishes). The
    // end-of-line stop (x = line width, row N) and the next line's left-margin
    // stop (x = 0, row N+1) would therefore round to the SAME keyframe percent;
    // CSS keeps the later declaration, dropping the end-of-line x so the caret
    // stays pinned at x=0 and merely slides down each row. We keep percentages
    // strictly increasing (nudging the carriage-return stop a hair past the
    // line-end stop) so both survive — the jump back to the margin then happens
    // over ~0.01% of the timeline, i.e. visually instant.
    const posStops: string[] = [`0%, ${typeStartPct} { transform: translate(0px, 0px); }`];
    let lastPctNum = pctNum(typeStartMs, totalDuration);
    const pushPosStop = (pn: number, x: number, y: number): void => {
      const p = Math.max(pn, lastPctNum + 0.01);
      posStops.push(`${p.toFixed(2)}% { transform: translate(${x}px, ${y}px); }`);
      lastPctNum = p;
    };
    for (const lt of lineTimings) {
      pushPosStop(pctNum(lt.startMs, totalDuration), 0, lt.li * lineHeight);
      pushPosStop(pctNum(lt.endMs, totalDuration), lt.len * charWidth, lt.li * lineHeight);
    }
    posStops.push(`${holdEndPct}, 100% { transform: translate(${endX}px, ${endY}px); }`);

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
    cssRules.push(`
    @keyframes ${id}-caret-pos { ${posStops.join(" ")} }
    @keyframes ${id}-caret-blink { ${blinkStops.join(" ")} }
    .${id}-caret { animation: ${id}-caret-pos ${totalSec.toFixed(2)}s linear infinite, ${id}-caret-blink ${totalSec.toFixed(2)}s step-end infinite; }`);
  }

  return { svgMarkup: parts.join("\n"), css: cssRules.join("") };
}

function renderTapOverlay(
  overlay: TapOverlay,
  frameIdx: number,
  frameStart: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const delay = overlay.delay ?? 50;
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

function renderBlinkOverlay(
  overlay: BlinkOverlay,
  frameIdx: number,
  frameStart: number,
  frameEnd: number,
  totalDuration: number,
  totalSec: number,
): { svgMarkup: string; css: string } {
  const id = `blink${frameIdx}`;
  const period = overlay.periodMs ?? 1000;
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
 */
function buildDisplayKeyframes(name: string, visibleStartPct: string | number, visibleEndPct: string | number): string {
  // DM-641: kept the function name for callers but the toggle is now on
  // `visibility`, not `display`, for the same reason as `fv-${i}` above —
  // animating `display` away from an element starting `display: none` never
  // ticks in Chromium.
  const start = parseFloat(String(visibleStartPct));
  const end = parseFloat(String(visibleEndPct));
  const startMinus = padBefore(start, KEYFRAME_EPSILON.display, 3);
  const endPlus = padAfter(end, KEYFRAME_EPSILON.display, 3);
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
  axis: "X" | "Y",
  size: number,
  entersSliding: boolean,
  enterStartPct: string,
  startPct: string,
  holdEndPct: string,
  transEndPct: string,
  visStart: string,
  visEnd: string,
  totalSec: number,
): string {
  return `
    @keyframes fp-${i} {
      0%, ${padBefore(parseFloat(enterStartPct), KEYFRAME_EPSILON.slide, 2)}% { transform: translate${axis}(${entersSliding ? size : 0}px); }
      ${startPct} { transform: translate${axis}(0); }
      ${holdEndPct} { transform: translate${axis}(0); }
      ${transEndPct} { transform: translate${axis}(-${size}px); }
      ${padAfter(parseFloat(transEndPct), KEYFRAME_EPSILON.slide, 2)}%, 100% { transform: translate${axis}(-${size}px); }
    }
    @keyframes fv-${i} {
      0%, ${padBefore(parseFloat(enterStartPct), KEYFRAME_EPSILON.slide, 2)}% { opacity: 0; }
      ${enterStartPct} { opacity: 1; }
      ${transEndPct} { opacity: 1; }
      ${padAfter(parseFloat(transEndPct), KEYFRAME_EPSILON.slide, 2)}%, 100% { opacity: 0; }
    }${buildDisplayKeyframes(`fd-${i}`, visStart, visEnd)}
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
    const fromStr = offsetForDirection(e.from, overlay.width, overlay.height, true);
    const enterStart = frameStart + enterDelay;
    const enterEnd = enterStart + e.duration;
    const enterId = `${id}-enter`;
    cssRules.push(`
    @keyframes ${enterId} { 0% { transform: ${fromStr}; } ${pct(enterStart, totalDuration)} { transform: ${fromStr}; } ${pct(enterEnd, totalDuration)} { transform: translate(0, 0); } 100% { transform: translate(0, 0); } }
    .${id}-enter { animation: ${enterId} ${totalSec.toFixed(2)}s infinite; animation-timing-function: ${easing}; }`);
  }

  // Slide-out exit. Mirror of enter — translate from (0,0) to off-screen.
  if (overlay.exit != null) {
    const e = overlay.exit;
    const easing = e.easing ?? "ease-in";
    const exitDelay = e.delay ?? 0;
    const toStr = offsetForDirection(e.from, overlay.width, overlay.height, false);
    const exitStart = overlayEnd - e.duration - exitDelay;
    const exitId = `${id}-exit`;
    cssRules.push(`
    @keyframes ${exitId} { 0%, ${pct(exitStart, totalDuration)} { transform: translate(0, 0); } ${pct(exitStart + e.duration, totalDuration)} { transform: ${toStr}; } 100% { transform: ${toStr}; } }
    .${id}-exit { animation: ${exitId} ${totalSec.toFixed(2)}s infinite; animation-timing-function: ${easing}; }`);
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
 * Offset string for a slide direction. When `outFrom` is true the offset is
 * the off-screen starting position (i.e. the overlay sits there before
 * animating to `(0,0)`). When false, it's the off-screen end position
 * (overlay animates from `(0,0)` to here on exit).
 */
function offsetForDirection(dir: "top" | "bottom" | "left" | "right", w: number, h: number, _outFrom: boolean): string {
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
      const propValue = (val: string): string => {
        if (a.property === "translateX") return `transform: translateX(${val});`;
        if (a.property === "translateY") return `transform: translateY(${val});`;
        if (a.property === "clipPath") return `clip-path: ${val};`;
        return `${a.property}: ${val};`;
      };
      const animName = `f${i}-${a.animId}-${ai}`;
      if (a.repeat != null) {
        // DM-869: repeating animation (blink / pulse / breathe). The keyframe is
        // a single from→to cycle on the animation's own `duration` clock, looped
        // via animation-iteration-count + (optional) direction:alternate. The
        // loop is only visible while the frame is on screen (the frame group's
        // visibility gating); `animation-delay` aligns the first cycle to the
        // frame's appearance. `fill-mode: both` holds `from` before the delay.
        const iterations = a.repeat === "infinite" ? "infinite" : String(a.repeat);
        const direction = a.alternate === true ? " alternate" : "";
        out.push(`    @keyframes ${animName} {
      0% { ${propValue(a.from)} }
      100% { ${propValue(a.to)} }
    }
    .anim-${a.animId} { animation: ${animName} ${a.duration}ms ${iterations}${direction}; animation-timing-function: ${easing}; animation-delay: ${startMs.toFixed(0)}ms; animation-fill-mode: both; }`);
      } else {
        // One-shot: hold `from` until startPct, animate from→to during
        // [startPct, endPct], hold `to` afterwards, mapped onto the global scene
        // clock so it replays in sync each scene loop.
        out.push(`    @keyframes ${animName} {
      0% { ${propValue(a.from)} }
      ${startPct.toFixed(3)}% { ${propValue(a.from)} }
      ${endPct.toFixed(3)}% { ${propValue(a.to)} }
      100% { ${propValue(a.to)} }
    }
    .anim-${a.animId} { animation: ${animName} ${totalSec.toFixed(2)}s infinite; animation-timing-function: ${easing}; }`);
      }
    }
  }
  return out.length === 0 ? "" : "\n" + out.join("\n");
}
