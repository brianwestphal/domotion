/**
 * SVG Animation Composer
 *
 * Takes captured SVG frame content and composes them into a single
 * animated SVG with CSS keyframe transitions.
 */

import { mergeFrames } from "./frame-merge.js";
import { type CursorOverlay, type SelectorResolver, cursorOverlayMarkup, resolveCursorScript } from "./cursor-overlay.js";

export interface AnimationFrame {
  /** SVG content for this frame (from dom-to-svg) */
  svgContent: string;
  /** Duration this frame is shown (ms) */
  duration: number;
  /** Transition to next frame */
  transition?: {
    /**
     * `crossfade` (default) overlaps fade-out and fade-in. `push-left` slides
     * the outgoing frame off and the incoming frame in from the right.
     * `scroll` keeps both visible during the transition. `cut` is instant —
     * no fade, no slide. For `cut`, `duration` is ignored.
     */
    type: "crossfade" | "push-left" | "scroll" | "cut";
    duration: number;
  };
  /** Overlays: typing, tap ripple */
  overlays?: Overlay[];
  /**
   * Intra-frame property animations. Run during this frame's hold time.
   * The CLI / `DemoRecorder` resolves selectors against the DOM at capture
   * and sets `data-domotion-anim` on matching elements; this list is the
   * post-resolution form referencing those ids. See `IntraFrameAnimation`.
   */
  animations?: IntraFrameAnimation[];
}

export interface TypingOverlay {
  kind: "typing";
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  color?: string;
  /** Delay from frame start before typing begins (ms) */
  delay?: number;
  /** Speed per character (ms) */
  speed?: number;
  /** Background color to mask placeholder text */
  bgColor?: string;
  bgWidth?: number;
  bgHeight?: number;
}

export interface TapOverlay {
  kind: "tap";
  x: number;
  y: number;
  /** Delay from frame start (ms) */
  delay?: number;
}

/**
 * Frame-local SVG overlay: composites a separately-captured SVG (inlined as
 * markup, not referenced as `<image href>`) on top of the captured frame.
 * Used for picture-in-picture effects like sliding a phone-framed preview
 * into the corner of a terminal demo.
 *
 * The overlay is positioned at (x, y), clipped to (width, height), and
 * gets its own `class="ov-<animId>"` wrapper so intra-frame animations
 * (or `enter`/`exit` sugar) can target it without colliding with elements
 * inside the embedded SVG.
 */
export interface SvgOverlay {
  kind: "svg";
  /**
   * The SVG content to inline. The CLI resolves `src` paths from the
   * config file's directory and namespaces the embedded SVG's ids before
   * setting this field.
   */
  innerSvg: string;
  /** Top-left corner in the captured frame's coordinate space. */
  x: number;
  y: number;
  /** Render size — the embedded SVG's viewBox is preserved and scales to fit. */
  width: number;
  height: number;
  /**
   * Stable id used to key the overlay's wrapper class (`ov-<animId>`) so
   * `enter`/`exit` / `animations` can target it. The CLI assigns this.
   */
  animId: string;
  /** Slide-in entrance (DM-211). Sugar over `animations`. */
  enter?: { from: "top" | "bottom" | "left" | "right"; duration: number; easing?: string; delay?: number };
  /** Slide-out exit (DM-211). */
  exit?: { from: "top" | "bottom" | "left" | "right"; duration: number; easing?: string; delay?: number };
}

export type Overlay = TypingOverlay | TapOverlay | SvgOverlay;

/**
 * Animate a CSS property on captured elements that match a selector, while
 * the frame is held on screen. The selector is resolved against the source
 * DOM at capture time (see DM-209) and the matching elements get
 * `class="anim-<id>"` on their rendered SVG groups.
 *
 * Resolution requires the consumer (CLI / `DemoRecorder`) to set
 * `data-domotion-anim="<id>"` on matching DOM elements before capture; the
 * `id` referenced here must be the same id set on the DOM.
 */
export interface IntraFrameAnimation {
  /** Anim id — must match the `data-domotion-anim` value set on the DOM pre-capture. */
  animId: string;
  /**
   * CSS property to animate. `clipPath` takes raw CSS `clip-path` values
   * (e.g. `"inset(0 100% 0 0)"` -> `"inset(0 0 0 0)"`) and is the right
   * choice for left-to-right reveals like typing-into-captured-text. When
   * the captured element is wrapped in a `<g class="anim-<id>">`, the
   * keyframes apply `clip-path` to that wrapper.
   */
  property: "width" | "height" | "opacity" | "transform" | "translateX" | "translateY" | "clipPath";
  /** Start value (CSS string, e.g. `"0%"`, `"240px"`, `"0.3"`). */
  from: string;
  /** End value (same syntax as `from`). */
  to: string;
  /** Duration in ms. Must be ≤ the parent frame's `duration`. */
  duration: number;
  /** CSS easing string. Default `linear`. */
  easing?: string;
  /** Ms after the frame becomes visible before animation starts. Default 0. */
  delay?: number;
}

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
   * Optional cursor / click overlay (DM-277). Renders a macOS-style cursor
   * moving along the script timeline with QuickTime-style click pulses.
   * Off by default; opt-in per animation. See `docs/35-cursor-overlay.md`.
   */
  cursorOverlay?: CursorOverlay;
  /**
   * Resolver for selector-based cursor move events. Required if any event
   * uses `selector`; otherwise pass undefined / null.
   */
  resolveSelector?: SelectorResolver;
}

export function generateAnimatedSvg(config: AnimationConfig): string {
  const { width, height, frames } = config;

  const totalDuration = frames.reduce(
    (sum, f) => sum + f.duration + transitionDuration(f),
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
      const td = transitionDuration(f);
      frameTiming.startPct.push((t / totalDuration) * 100);
      frameTiming.holdEndPct.push(((t + f.duration) / totalDuration) * 100);
      frameTiming.transEndPct.push(((t + f.duration + td) / totalDuration) * 100);
      t += f.duration + td;
    }
  }

  // Fast path: if every transition is crossfade (or default) or `cut`, merge
  // all frames into a single de-duplicated tree with per-element visibility
  // timelines. `cut` is just `crossfade` with duration 0 — same merge logic
  // applies; it ends up as step-end keyframes flipping at exact frame
  // boundaries.
  const allMergeable = frames.every((f) => {
    const type = f.transition?.type;
    return type == null || type === "crossfade" || type === "cut";
  });

  const anyOverlays = frames.some((f) => f.overlays != null && f.overlays.length > 0);
  if (allMergeable && frames.length > 1 && !anyOverlays) {
    return composeMergedSvg(config, frameTiming, totalSec);
  }

  const frameGroups: string[] = [];
  const keyframes: string[] = [];
  let timeOffset = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const transDur = transitionDuration(frame);
    const transType = frame.transition?.type ?? "crossfade";

    const startPct = pct(timeOffset, totalDuration);
    const holdEndPct = pct(timeOffset + frame.duration, totalDuration);
    const transEndPct = pct(timeOffset + frame.duration + transDur, totalDuration);

    const prevFrame = i > 0 ? frames[i - 1] : null;
    const entersViaPush = prevFrame?.transition?.type === "push-left";
    const prevTransDur = prevFrame != null ? transitionDuration(prevFrame) : 300;
    const enterStartPct = entersViaPush
      ? pct(timeOffset - prevTransDur, totalDuration)
      : startPct;

    if (transType === "push-left") {
      // Push: slide in from right, slide out to left
      frameGroups.push(
        `  <g class="f f-${i}"><clipPath id="fc-${i}"><rect width="${width}" height="${height}" /></clipPath><g clip-path="url(#fc-${i})" class="fp fp-${i}">\n${frame.svgContent}\n  </g></g>`,
      );

      keyframes.push(`
    @keyframes fp-${i} {
      0%, ${Math.max(0, parseFloat(enterStartPct) - 0.1).toFixed(2)}% { transform: translateX(${entersViaPush ? width : 0}px); }
      ${startPct}% { transform: translateX(0); }
      ${holdEndPct}% { transform: translateX(0); }
      ${transEndPct}% { transform: translateX(-${width}px); }
      ${Math.min(100, parseFloat(transEndPct) + 0.1).toFixed(2)}%, 100% { transform: translateX(-${width}px); }
    }
    @keyframes fv-${i} {
      0%, ${Math.max(0, parseFloat(enterStartPct) - 0.1).toFixed(2)}% { opacity: 0; }
      ${enterStartPct}% { opacity: 1; }
      ${transEndPct}% { opacity: 1; }
      ${Math.min(100, parseFloat(transEndPct) + 0.1).toFixed(2)}%, 100% { opacity: 0; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; }
    .fp-${i} { animation: fp-${i} ${totalSec.toFixed(2)}s infinite; }`);

    } else if (transType === "scroll") {
      // Scroll: keep visible, no fade during scroll, fade only at end
      frameGroups.push(
        `  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`,
      );

      const fadeEndPct = pct(timeOffset + frame.duration + transDur + 200, totalDuration);
      const prevEnd = i > 0 ? `${Math.max(0, parseFloat(startPct) - 0.1).toFixed(2)}%,` : "";

      keyframes.push(`
    @keyframes fv-${i} {
      0%, ${prevEnd} ${fadeEndPct}, 100% { opacity: 0; }
      ${startPct}, ${transEndPct} { opacity: 1; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; }`);

    } else {
      // Crossfade or cut: opacity in/out.
      //
      // For `cut` (transDur === 0): use disjoint keyframes with step-end timing
      // so opacity flips instantly at frame boundaries with no interpolation
      // smear — frame N is opaque from startPct to transEndPct EXCLUSIVE, and
      // 0 outside. Without step-end, linear interpolation between distant
      // keyframes makes adjacent frames bleed across the entire cycle.
      //
      // For crossfade: the fade-in OVERLAPS the previous frame's fade-out so
      // shared pixels stay visible during the transition. Linear interpolation
      // is what we want here.
      frameGroups.push(
        `  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`,
      );

      const isCut = transType === "cut" || transDur === 0;
      if (isCut) {
        const startNum = parseFloat(startPct);
        const endNum = parseFloat(transEndPct);
        const beforeStart = Math.max(0, startNum - 0.001).toFixed(3);
        const afterEnd = Math.min(100, endNum + 0.001).toFixed(3);
        keyframes.push(`
    @keyframes fv-${i} {
      0% { opacity: 0; }
      ${beforeStart}% { opacity: 0; }
      ${startNum.toFixed(3)}% { opacity: 1; }
      ${endNum.toFixed(3)}% { opacity: 1; }
      ${afterEnd}% { opacity: 0; }
      100% { opacity: 0; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; animation-timing-function: step-end; }`);
      } else {
        const fadeInStartPct = i > 0
          ? pct(Math.max(0, timeOffset - prevTransDur), totalDuration)
          : startPct;
        const prevEnd = i > 0
          ? `${Math.max(0, parseFloat(fadeInStartPct) - 0.01).toFixed(2)}%,`
          : "";
        keyframes.push(`
    @keyframes fv-${i} {
      0%, ${prevEnd} ${transEndPct}, 100% { opacity: 0; }
      ${startPct}, ${holdEndPct} { opacity: 1; }
    }
    .f-${i} { animation: fv-${i} ${totalSec.toFixed(2)}s infinite; }`);
      }
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
        }
      }
    }

    timeOffset += frame.duration + transDur;
  }

  // Compose final SVG with XML declaration for proper UTF-8
  const sharedDefsMarkup = config.sharedDefs ?? "";
  const animationCss = buildIntraFrameAnimationCss(frames, frameTiming, totalSec);
  // Cursor overlay (DM-277). The frame start times let the resolver pick
  // which frame's selector matches apply at each event's timestamp.
  let overlayMarkup = "";
  if (config.cursorOverlay != null && config.cursorOverlay.events.length > 0) {
    const frameStarts: number[] = [];
    let acc = 0;
    for (const f of frames) {
      frameStarts.push(acc);
      acc += f.duration + transitionDuration(f);
    }
    const resolved = resolveCursorScript(
      config.cursorOverlay,
      totalDuration,
      frameStarts,
      config.resolveSelector ?? null,
    );
    overlayMarkup = "\n" + cursorOverlayMarkup(resolved.positions, resolved.clicks, resolved.style, totalDuration);
  }
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
    .f { opacity: 0; }
    ${keyframes.join("\n")}${animationCss}
  </style>
  <g clip-path="url(#viewport-clip)">
  <rect width="${width}" height="${height}" fill="#0d1117" />
${frameGroups.join("\n")}${overlayMarkup}
  </g>
</svg>`;
  return out;
}

/**
 * Effective transition duration for a frame. `cut` is always 0 — the type
 * means "instant" so any duration on the input is meaningless. Default
 * (no transition specified) is 300ms (legacy crossfade duration).
 */
function transitionDuration(f: AnimationFrame): number {
  if (f.transition == null) return 300;
  if (f.transition.type === "cut") return 0;
  return f.transition.duration;
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
  const charWidth = fontSize * 0.6;
  const color = overlay.color ?? "#e6edf3";
  const typeStartMs = frameStart + delay;

  const parts: string[] = [];
  const cssRules: string[] = [];
  const id = `t${frameIdx}`;

  // Background mask
  if (overlay.bgColor != null) {
    const bgW = overlay.bgWidth ?? overlay.text.length * charWidth + 8;
    const bgH = overlay.bgHeight ?? fontSize + 6;
    const bgStartPct = pct(typeStartMs, totalDuration);
    const bgEndPct = pct(frameStart + overlay.text.length * speed + delay + 500, totalDuration);

    parts.push(
      `  <rect class="${id}-bg" x="${overlay.x - 2}" y="${overlay.y - fontSize + 2}" width="${bgW}" height="${bgH}" fill="${overlay.bgColor}" rx="2" />`,
    );
    cssRules.push(`
    @keyframes ${id}-bg { 0%, ${bgStartPct} { opacity: 0; } ${pct(typeStartMs + 50, totalDuration)} { opacity: 1; } ${bgEndPct}, 100% { opacity: 0; } }
    .${id}-bg { animation: ${id}-bg ${totalSec.toFixed(2)}s infinite; }`);
  }

  // Render full text with an animated clip that reveals characters one-by-one.
  // The overlay must disappear by the time the frame ends — otherwise it'll
  // leak across the cut boundary and overlap the next frame's content.
  const textEndMs = typeStartMs + overlay.text.length * speed;
  const holdEndMs = Math.min(frameStart + 3000, frameEnd);
  const fullTextWidth = overlay.text.length * charWidth + 4;
  const textHeight = fontSize + 4;
  const clipId = `${id}-clip`;

  // Clip rect animation: width grows from 0 to full text width
  parts.push(`  <defs><clipPath id="${clipId}"><rect class="${id}-reveal" x="${overlay.x}" y="${overlay.y - fontSize}" width="0" height="${textHeight}" /></clipPath></defs>`);
  parts.push(
    `  <text class="${id}-text" x="${overlay.x}" y="${overlay.y}" fill="${color}" font-size="${fontSize}" font-family="'SF Mono', Menlo, Monaco, monospace" clip-path="url(#${clipId})">${escapeXml(overlay.text)}</text>`,
  );

  const typeStartPct = pct(typeStartMs, totalDuration);
  const typeEndPct = pct(textEndMs, totalDuration);
  const holdEndPct = pct(holdEndMs, totalDuration);

  cssRules.push(`
    @keyframes ${id}-reveal { 0%, ${typeStartPct} { width: 0; } ${typeEndPct} { width: ${fullTextWidth}px; } ${holdEndPct} { width: ${fullTextWidth}px; } ${pct(holdEndMs + 100, totalDuration)}, 100% { width: 0; } }
    .${id}-reveal { animation: ${id}-reveal ${totalSec.toFixed(2)}s infinite; }
    @keyframes ${id}-vis { 0%, ${typeStartPct} { opacity: 0; } ${pct(typeStartMs + 30, totalDuration)} { opacity: 1; } ${holdEndPct} { opacity: 1; } ${pct(holdEndMs + 100, totalDuration)}, 100% { opacity: 0; } }
    .${id}-text { animation: ${id}-vis ${totalSec.toFixed(2)}s infinite; }`);

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

function pct(ms: number, total: number): string {
  return `${((ms / total) * 100).toFixed(2)}%`;
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
 * Compose the animated SVG using the frame-merge pipeline. Every element in
 * every frame is reduced to one render with a visibility timeline. Stable
 * elements (prompt, background, typed characters that stay on screen) emit
 * once with opacity: 1 throughout; changing elements get step-end keyframes
 * that flip their opacity at the appropriate frame boundaries.
 */
function composeMergedSvg(
  config: AnimationConfig,
  frameTiming: { startPct: number[]; holdEndPct: number[]; transEndPct: number[] },
  totalSec: number,
): string {
  const { width, height, frames } = config;
  const framesSvg = frames.map((f) => f.svgContent);
  const { css, merged } = mergeFrames(framesSvg, frameTiming, "t");
  const sharedDefsMarkup = config.sharedDefs ?? "";
  const animationCss = buildIntraFrameAnimationCss(frames, frameTiming, totalSec);
  // Cursor overlay (DM-277). Same emission as the unmerged path — the
  // overlay sits above the merged frame group, clipped to the viewport.
  const totalDuration = totalSec * 1000;
  let overlayMarkup = "";
  if (config.cursorOverlay != null && config.cursorOverlay.events.length > 0) {
    const frameStarts: number[] = [];
    let acc = 0;
    for (const f of frames) {
      frameStarts.push(acc);
      acc += f.duration + transitionDuration(f);
    }
    const resolved = resolveCursorScript(
      config.cursorOverlay,
      totalDuration,
      frameStarts,
      config.resolveSelector ?? null,
    );
    overlayMarkup = "\n" + cursorOverlayMarkup(resolved.positions, resolved.clicks, resolved.style, totalDuration);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
    :root { --scene-dur: ${totalSec.toFixed(2)}s; }
${css}${animationCss}
  </style>
  <g clip-path="url(#viewport-clip)">
  <rect width="${width}" height="${height}" fill="#0d1117" />
${merged}${overlayMarkup}
  </g>
</svg>`;
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
      // Hold `from` until startPct, animate from→to during [startPct, endPct],
      // hold `to` afterwards. Pre-frame holds use 0% as the from anchor.
      out.push(`    @keyframes ${animName} {
      0% { ${propValue(a.from)} }
      ${startPct.toFixed(3)}% { ${propValue(a.from)} }
      ${endPct.toFixed(3)}% { ${propValue(a.to)} }
      100% { ${propValue(a.to)} }
    }
    .anim-${a.animId} { animation: ${animName} ${totalSec.toFixed(2)}s infinite; animation-timing-function: ${easing}; }`);
    }
  }
  return out.length === 0 ? "" : "\n" + out.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
