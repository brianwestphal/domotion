/**
 * Shared "shine / shimmer" sweep helper (DM-1542 + DM-1524).
 *
 * A single implementation of the classic moving-highlight sweep: a diagonal band
 * of a linear-gradient (transparent → highlight → transparent) that travels left
 * → right across an element's box, CLIPPED to that box so the glint only appears
 * over the element. It backs BOTH surfaces that want a shine, so there is exactly
 * one implementation:
 *
 *  - the `kind: "shine"` frame overlay (the `shine` motion preset — docs/08), and
 *  - the `shine` frame TRANSITION in the animator (docs/88), which sweeps the
 *    glint across the whole viewport as one frame hands off to the next.
 *
 * **Cross-engine-safe by construction (docs/84).** The only animated property is
 * `transform: translateX` on a gradient-filled `<rect>` — no animated CSS
 * `filter` (blur/glow is Chromium-only inside `<img>` and was rejected before).
 * `transform` + gradients composite identically on Blink and WebKit.
 *
 * **Rests at identity.** Outside its sweep window the band is parked fully off the
 * right edge of the clip, so it paints nothing — the underlying element is
 * untouched. A Domotion re-capture of a rested frame therefore sees no glint and
 * can't double-transform it.
 */

/** Accepts a numeric percent (`12.5`) or a percent string (`"12.5%"`). */
export type Pctish = number | string;

function pctNum(p: Pctish): number {
  return typeof p === "number" ? p : parseFloat(p);
}

export interface ShineSweepOptions {
  /** Unique id base for the emitted ids/classes (must be unique per scene). */
  id: string;
  /** Box the glint is clipped to, in the SVG's user space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Sweep window as scene-clock percents (start → end of the travel). */
  startPct: Pctish;
  endPct: Pctish;
  /** Scene length in seconds (the `animation-duration` every keyframe rides). */
  totalSec: number;
  /** Highlight color. Default a soft white. */
  color?: string;
  /** Peak opacity of the glint band. Default 0.55. */
  opacity?: number;
  /** Band width in px (the bright streak's thickness). Default ~28% of `width`. */
  bandWidth?: number;
  /** Skew of the band from vertical, in degrees, for a diagonal glint. Default 14. */
  skewDeg?: number;
  /**
   * When set, the sweep REPEATS on its own clock for an ambient shimmer (used by
   * the `shine` overlay preset). A number is the iteration count; `"infinite"`
   * loops for the frame's whole hold. Omit for a one-shot sweep (transitions).
   */
  repeat?: number | "infinite";
  /** Period of ONE ambient sweep in ms (only with `repeat`). Default 1400. */
  repeatPeriodMs?: number;
}

export interface ShineSweepResult {
  /** SVG markup: a clip def + the clipped, gradient-filled travelling band. */
  markup: string;
  /** The `@keyframes` + rule CSS driving the band's travel. */
  css: string;
}

/**
 * Build one shine sweep over `[startPct, endPct]` of the scene clock. Returns the
 * SVG markup (a `<clipPath>` + a `<g>` carrying the moving band) and the CSS.
 * The band travels from just off the LEFT edge of the box to just off the RIGHT
 * edge, so the highlight enters, crosses, and exits the clipped box exactly once
 * per sweep. Ids/classes are namespaced by `id` to avoid scene collisions.
 */
export function buildShineSweep(opts: ShineSweepOptions): ShineSweepResult {
  const { id, x, y, width, height, totalSec } = opts;
  const color = opts.color ?? "#ffffff";
  const peak = opts.opacity ?? 0.55;
  const band = opts.bandWidth ?? Math.max(24, Math.round(width * 0.28));
  const skew = opts.skewDeg ?? 14;
  const startNum = pctNum(opts.startPct);
  const endNum = pctNum(opts.endPct);

  const clipId = `shine-clip-${id}`;
  const gradId = `shine-grad-${id}`;
  const cls = `shine-${id}`;

  // Travel: the band's local x runs from `-band` (fully left of the box) to
  // `width + band` (fully right of it). Skewing the band would let its top/bottom
  // corners poke outside the sweep, so the band rect is over-tall (from -height to
  // +2·height) and the skew pivots about the box center; the clip trims the rest.
  const startX = -band;
  const endX = width + band;
  const bandH = height * 3;

  // A one-shot sweep parks off the right edge before/after the window (invisible,
  // clipped away) so it rests at identity. An ambient `repeat` sweep instead loops
  // on its own clock across the frame's whole hold.
  let css: string;
  if (opts.repeat != null) {
    const period = opts.repeatPeriodMs ?? 1400;
    const iterations = opts.repeat === "infinite" ? "infinite" : String(opts.repeat);
    // `startPct` positions the first sweep via a delay from the scene origin.
    const delayMs = (startNum / 100) * totalSec * 1000;
    css = `
    @keyframes ${cls} {
      0% { transform: translateX(${startX}px); }
      100% { transform: translateX(${endX}px); }
    }
    .${cls} { animation: ${cls} ${period}ms linear ${delayMs.toFixed(0)}ms ${iterations} both; }`;
  } else {
    // One-shot: hold parked-left until the window opens, sweep across, park right.
    const beforePct = Math.max(0, startNum - 0.001);
    css = `
    @keyframes ${cls} {
      0% { transform: translateX(${startX}px); }
      ${beforePct.toFixed(3)}% { transform: translateX(${startX}px); }
      ${endNum.toFixed(3)}% { transform: translateX(${endX}px); }
      100% { transform: translateX(${endX}px); }
    }
    .${cls} { animation: ${cls} ${totalSec.toFixed(2)}s linear infinite; }`;
  }

  const markup = `  <defs>
    <clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}" /></clipPath>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${color}" stop-opacity="0" />
      <stop offset="0.5" stop-color="${color}" stop-opacity="${peak}" />
      <stop offset="1" stop-color="${color}" stop-opacity="0" />
    </linearGradient>
  </defs>
  <g clip-path="url(#${clipId})">
    <g class="${cls}"><rect x="0" y="${y - height}" width="${band}" height="${bandH}" fill="url(#${gradId})" transform="translate(${x} 0) skewX(${-skew})" /></g>
  </g>`;

  return { markup, css };
}
