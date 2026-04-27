/**
 * SVG Animation Composer
 *
 * Takes captured SVG frame content and composes them into a single
 * animated SVG with CSS keyframe transitions.
 */

import { mergeFrames } from "./frame-merge.js";
import { buildChrome, type DeviceChromeConfig } from "./chrome.js";

export interface AnimationFrame {
  /** SVG content for this frame (from dom-to-svg) */
  svgContent: string;
  /** Duration this frame is shown (ms) */
  duration: number;
  /** Transition to next frame */
  transition?: {
    type: "crossfade" | "push-left" | "scroll";
    duration: number;
  };
  /** Overlays: typing, tap ripple */
  overlays?: Overlay[];
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

export type Overlay = TypingOverlay | TapOverlay;

export interface AnimationConfig {
  width: number;
  height: number;
  frames: AnimationFrame[];
  /**
   * Optional device chrome wrapper. When set, the rendered SVG grows by
   * the chrome's outer dimensions and the captured frames are translated
   * into the chrome's content area. See `DeviceChromeConfig` for the
   * available styles (terminal / browser / phone).
   */
  chrome?: DeviceChromeConfig;
  /**
   * Markup (e.g. `<path id="g0" d="..."/>...`) hoisted into the top-level
   * `<defs>`. Frames can reference these IDs via `<use href="#...">`. Use for
   * glyph paths and other assets that repeat across frames — avoids duplicating
   * them in every frame's local defs.
   */
  sharedDefs?: string;
}

export function generateAnimatedSvg(config: AnimationConfig): string {
  const { width, height, frames } = config;

  const totalDuration = frames.reduce(
    (sum, f) => sum + f.duration + (f.transition?.duration ?? 300),
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
      const td = f.transition?.duration ?? 300;
      frameTiming.startPct.push((t / totalDuration) * 100);
      frameTiming.holdEndPct.push(((t + f.duration) / totalDuration) * 100);
      frameTiming.transEndPct.push(((t + f.duration + td) / totalDuration) * 100);
      t += f.duration + td;
    }
  }

  // Fast path: if every transition is crossfade (or default), merge all frames
  // into a single de-duplicated tree with per-element visibility timelines.
  // This is the common case — and where the flicker / file-size problems lived
  // (full-scene redraw per frame). For push-left / scroll transitions we stay
  // on the slower per-frame-atomic path below.
  const allCrossfade = frames.every((f) => {
    const type = f.transition?.type;
    return type == null || type === "crossfade";
  });

  const anyOverlays = frames.some((f) => f.overlays != null && f.overlays.length > 0);
  if (allCrossfade && frames.length > 1 && !anyOverlays) {
    return applyChromeIfSet(composeMergedSvg(config, frameTiming, totalSec), width, height, config.chrome);
  }

  const frameGroups: string[] = [];
  const keyframes: string[] = [];
  let timeOffset = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const transDur = frame.transition?.duration ?? 300;
    const transType = frame.transition?.type ?? "crossfade";

    const startPct = pct(timeOffset, totalDuration);
    const holdEndPct = pct(timeOffset + frame.duration, totalDuration);
    const transEndPct = pct(timeOffset + frame.duration + transDur, totalDuration);

    const prevFrame = i > 0 ? frames[i - 1] : null;
    const entersViaPush = prevFrame?.transition?.type === "push-left";
    const prevTransDur = prevFrame?.transition?.duration ?? 300;
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
      // Crossfade: opacity in/out. The fade-in must OVERLAP the previous
      // frame's fade-out so shared pixels stay visible (otherwise you get a
      // dark flash in the middle of the transition). Fade-in starts at the
      // previous frame's holdEndPct — i.e. when its fade-out begins.
      frameGroups.push(
        `  <g class="f f-${i}">\n${frame.svgContent}\n  </g>`,
      );

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

    // Overlays
    if (frame.overlays != null) {
      for (const overlay of frame.overlays) {
        if (overlay.kind === "typing") {
          const { svgMarkup, css } = renderTypingOverlay(
            overlay, i, timeOffset, totalDuration, totalSec,
          );
          frameGroups.push(svgMarkup);
          keyframes.push(css);
        } else if (overlay.kind === "tap") {
          const { svgMarkup, css } = renderTapOverlay(
            overlay, i, timeOffset, totalDuration, totalSec,
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
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
    .f { opacity: 0; }
    ${keyframes.join("\n")}
  </style>
  <g clip-path="url(#viewport-clip)">
  <rect width="${width}" height="${height}" fill="#0d1117" />
${frameGroups.join("\n")}
  </g>
</svg>`;
  return applyChromeIfSet(out, width, height, config.chrome);
}

/**
 * Wrap a complete `<svg>...</svg>` document in device chrome. Returns the
 * input unchanged when `chrome` is null/undefined.
 */
function applyChromeIfSet(svg: string, contentWidth: number, contentHeight: number, chrome?: DeviceChromeConfig): string {
  if (chrome == null) return svg;
  const openMatch = svg.match(/<svg[^>]*>/);
  const closeIdx = svg.lastIndexOf("</svg>");
  if (openMatch == null || closeIdx === -1 || openMatch.index == null) return svg;
  const innerStart = openMatch.index + openMatch[0].length;
  const inner = svg.slice(innerStart, closeIdx);
  const xmlPrefix = svg.startsWith("<?xml") ? svg.slice(0, svg.indexOf("?>") + 2) + "\n" : "";

  const f = buildChrome(chrome, contentWidth, contentHeight);
  return `${xmlPrefix}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.outerWidth} ${f.outerHeight}" width="${f.outerWidth}" height="${f.outerHeight}">${f.before}<g transform="translate(${f.contentX}, ${f.contentY})">${inner}</g>${f.after}</svg>`;
}

function renderTypingOverlay(
  overlay: TypingOverlay,
  frameIdx: number,
  frameStart: number,
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

  // Render full text with an animated clip that reveals characters one-by-one
  const textEndMs = typeStartMs + overlay.text.length * speed;
  const holdEndMs = frameStart + 3000;
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <clipPath id="viewport-clip"><rect width="${width}" height="${height}" /></clipPath>${sharedDefsMarkup}
  </defs>
  <style>
    :root { --scene-dur: ${totalSec.toFixed(2)}s; }
${css}
  </style>
  <g clip-path="url(#viewport-clip)">
  <rect width="${width}" height="${height}" fill="#0d1117" />
${merged}
  </g>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
