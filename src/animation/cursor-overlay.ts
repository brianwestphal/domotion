/**
 * Cursor / click overlay for animated SVGs (DM-277).
 *
 * Paints a macOS-style cursor moving along a user-authored timeline and
 * QuickTime-style click pulses at click events. Single pointer at a time;
 * multi-touch is out of scope for v1.
 *
 * The overlay is opt-in via `AnimationConfig.cursorOverlay`. The emitted
 * markup goes inside the viewport-clipped group, after the frame groups,
 * so it paints above the frame content and is clipped to the viewport.
 *
 * Selector resolution: events that target a captured element via `selector`
 * are resolved by an optional `resolveSelector(sel, frameIndex)` callback
 * the caller supplies. The frame index is computed from the event's `t`
 * (each frame's start/end time is derived from the animation timing).
 *
 * See docs/13-cursor-overlay.md for the design.
 */

export interface CursorStyle {
  /** Pointer variant. v1: only `mouse` is rendered (touch falls through to the same arrow glyph). */
  pointer: "mouse" | "touch";
  /**
   * Inner ring + cursor stroke color. Defaults to white with a thin black
   * outline so the cursor reads on light and dark backgrounds alike.
   */
  cursorFill: string;
  cursorStroke: string;
  /** Click pulse stroke color. Default white with a black hairline. */
  pulseStroke: string;
  pulseStrokeOuter: string;
  /** Click pulse duration in ms. Default 500. */
  pulseDurationMs: number;
  /** Click pulse max radius (outer edge) in px. Default 32. */
  pulseRadius: number;
  /** Cursor scale (1 = the 18-px-tall macOS arrow). Default 1. */
  cursorScale: number;
}

export interface CursorMoveEvent {
  type: "move";
  /** Time when the move begins, ms from animation start. */
  t: number;
  /** Move duration in ms. Default 0 (instant jump). */
  duration?: number;
  /** Absolute viewport-coord target. */
  to?: { x: number; y: number };
  /** Relative offset from current cursor position. */
  by?: { dx: number; dy: number };
  /** CSS selector. Cursor moves to the center of the matched element's rect. */
  selector?: string;
  /** Optional offset added to `selector`'s resolved center. */
  offset?: { dx: number; dy: number };
}

export interface CursorClickEvent {
  type: "click";
  t: number;
  /** Default `primary`. `middle` renders identically to `primary`. */
  button?: "primary" | "secondary" | "middle";
  /** Per-event style override (merged on top of `CursorOverlay.style`). */
  style?: Partial<CursorStyle>;
}

export interface CursorShowEvent {
  type: "show";
  t: number;
  x: number;
  y: number;
}

export interface CursorHideEvent {
  type: "hide";
  t: number;
}

export type CursorEvent = CursorMoveEvent | CursorClickEvent | CursorShowEvent | CursorHideEvent;

export interface CursorOverlay {
  events: CursorEvent[];
  /** Default styles for every event. Per-event `style` overrides take precedence. */
  style?: Partial<CursorStyle>;
}

/** Optional resolver for `selector`-based move events. */
export type SelectorResolver = (sel: string, frameIndex: number) => { x: number; y: number; w: number; h: number } | null;

interface KeyframePoint { t: number; x: number; y: number; visible: boolean }
interface ResolvedClick { t: number; x: number; y: number; button: "primary" | "secondary" | "middle"; style: CursorStyle }

const DEFAULT_STYLE: CursorStyle = {
  pointer: "mouse",
  cursorFill: "rgb(255, 255, 255)",
  cursorStroke: "rgb(0, 0, 0)",
  pulseStroke: "rgba(255, 255, 255, 0.95)",
  pulseStrokeOuter: "rgba(0, 0, 0, 0.4)",
  pulseDurationMs: 500,
  pulseRadius: 32,
  cursorScale: 1,
};

/**
 * Resolve a script into absolute-coord position keyframes + click pulses.
 * Caller passes a `resolveSelector(sel, frameIndex)` if the script uses
 * selectors; otherwise pass `null` and selector events become no-ops with
 * a console warning.
 */
export function resolveCursorScript(
  overlay: CursorOverlay,
  totalDurationMs: number,
  frameStartTimes: number[],
  resolveSelector: SelectorResolver | null,
): { positions: KeyframePoint[]; clicks: ResolvedClick[]; style: CursorStyle } {
  const baseStyle: CursorStyle = { ...DEFAULT_STYLE, ...overlay.style };
  const events = [...overlay.events].sort((a, b) => a.t - b.t);

  const positions: KeyframePoint[] = [];
  const clicks: ResolvedClick[] = [];
  let curX = 0;
  let curY = 0;
  let visible = false;

  const pushKey = (t: number, x: number, y: number, vis: boolean): void => {
    positions.push({ t, x, y, visible: vis });
    curX = x; curY = y; visible = vis;
  };

  const frameForT = (t: number): number => {
    let idx = 0;
    for (let i = 0; i < frameStartTimes.length; i++) {
      if (t >= frameStartTimes[i]) idx = i;
      else break;
    }
    return idx;
  };

  for (const ev of events) {
    if (ev.type === "show") {
      pushKey(ev.t, ev.x, ev.y, true);
    } else if (ev.type === "hide") {
      pushKey(ev.t, curX, curY, false);
    } else if (ev.type === "move") {
      const dur = ev.duration ?? 0;
      const target = resolveMoveTarget(ev, curX, curY, frameForT(ev.t), resolveSelector);
      if (target == null) continue;
      if (dur > 0) {
        // Anchor the cursor at its previous spot when the move begins, then
        // interpolate to the target over `dur`, so it slides rather than popping
        // in mid-frame. (Both the first-positioning and subsequent-move cases
        // emit the same start keyframe — DM-1073 collapsed a no-op branch here.)
        pushKey(ev.t, curX, curY, true);
        pushKey(ev.t + dur, target.x, target.y, true);
      } else {
        pushKey(ev.t, target.x, target.y, true);
      }
    } else if (ev.type === "click") {
      const button = ev.button ?? "primary";
      const style: CursorStyle = { ...baseStyle, ...(ev.style ?? {}) };
      clicks.push({ t: ev.t, x: curX, y: curY, button, style });
    }
  }

  // Always anchor an initial keyframe at t=0 with visibility `false` so the
  // animation doesn't accidentally show the cursor at (0, 0) before the
  // first `show` / `move`.
  if (positions.length === 0 || positions[0].t > 0) {
    positions.unshift({ t: 0, x: positions[0]?.x ?? 0, y: positions[0]?.y ?? 0, visible: false });
  }
  // Anchor a final keyframe at totalDurationMs so animateTransform interpolates
  // through the whole loop.
  if (positions[positions.length - 1].t < totalDurationMs) {
    const last = positions[positions.length - 1];
    positions.push({ t: totalDurationMs, x: last.x, y: last.y, visible: last.visible });
  }

  return { positions, clicks, style: baseStyle };
}

function resolveMoveTarget(
  ev: CursorMoveEvent,
  curX: number,
  curY: number,
  frameIndex: number,
  resolveSelector: SelectorResolver | null,
): { x: number; y: number } | null {
  if (ev.to != null) return { x: ev.to.x, y: ev.to.y };
  if (ev.by != null) return { x: curX + ev.by.dx, y: curY + ev.by.dy };
  if (ev.selector != null) {
    if (resolveSelector == null) {
      console.warn(`cursor-overlay: selector "${ev.selector}" used but no resolveSelector provided; skipping`);
      return null;
    }
    const rect = resolveSelector(ev.selector, frameIndex);
    if (rect == null) {
      console.warn(`cursor-overlay: selector "${ev.selector}" matched no element in frame ${frameIndex}; skipping`);
      return null;
    }
    const cx = rect.x + rect.w / 2 + (ev.offset?.dx ?? 0);
    const cy = rect.y + rect.h / 2 + (ev.offset?.dy ?? 0);
    return { x: cx, y: cy };
  }
  return null;
}

/**
 * Emit the `<g class="cursor-overlay">` markup for an already-resolved
 * timeline. Returns "" when the timeline has no positions or every keyframe
 * is invisible.
 */
export function cursorOverlayMarkup(
  positions: KeyframePoint[],
  clicks: ResolvedClick[],
  style: CursorStyle,
  totalDurationMs: number,
): string {
  if (positions.length === 0 || totalDurationMs <= 0) return "";
  const totalSec = totalDurationMs / 1000;
  // animateTransform with values + keyTimes drives the cursor's translate.
  const valueStrs: string[] = [];
  const keyTimes: string[] = [];
  for (const p of positions) {
    valueStrs.push(`${num(p.x)},${num(p.y)}`);
    keyTimes.push((p.t / totalDurationMs).toFixed(4));
  }
  // SMIL animateTransform requires keyTimes to start at 0 and end at 1; the
  // resolveCursorScript anchor at t=0 and t=totalDurationMs guarantees this.

  // Visibility timeline: opacity flips between 0 and 1 at keyframes whose
  // `visible` differs from the previous one. Use `discrete` calc-mode for
  // step-wise transitions (no interpolation between 0 and 1).
  const visValues: string[] = [];
  for (const p of positions) visValues.push(p.visible ? "1" : "0");

  const cursorPath = macosCursorPath(style.cursorScale);

  // Pulse SVG fragments — one per click, with timing keyed off `t`.
  const pulseMarkup = clicks.map((c, i) => buildPulseFragment(c, i, totalDurationMs)).join("\n");

  return `  <g class="cursor-overlay" pointer-events="none">
    <g class="cursor-arrow" opacity="0">
      <animateTransform attributeName="transform" type="translate" values="${valueStrs.join("; ")}" keyTimes="${keyTimes.join("; ")}" dur="${totalSec}s" repeatCount="indefinite" fill="freeze" />
      <animate attributeName="opacity" values="${visValues.join(";")}" keyTimes="${keyTimes.join(";")}" dur="${totalSec}s" repeatCount="indefinite" calcMode="discrete" fill="freeze" />
      ${cursorPath}
    </g>
${pulseMarkup}
  </g>`;
}

/** Build the SVG fragment for a single click pulse. */
function buildPulseFragment(c: ResolvedClick, idx: number, totalDurationMs: number): string {
  const beginSec = (c.t / 1000).toFixed(3);
  const durSec = (c.style.pulseDurationMs / 1000).toFixed(3);
  const r0 = 4;
  const r1 = c.style.pulseRadius;
  const innerR = r1 * 0.55;
  // Right-half-disc fill for secondary clicks.
  let secondaryHalf = "";
  if (c.button === "secondary") {
    const halfPath = `M ${num(c.x)} ${num(c.y - innerR)} A ${num(innerR)} ${num(innerR)} 0 0 1 ${num(c.x)} ${num(c.y + innerR)} Z`;
    secondaryHalf = `
    <path d="${halfPath}" fill="rgba(0,0,0,0.2)" opacity="0">
      <animate attributeName="opacity" values="0; 1; 0" keyTimes="0; 0.2; 1" dur="${durSec}s" begin="${beginSec}s" fill="freeze" />
    </path>`;
  }
  return `    <g class="cursor-click cursor-click-${idx}">
      <circle cx="${num(c.x)}" cy="${num(c.y)}" r="${r0}" fill="none" stroke="${c.style.pulseStrokeOuter}" stroke-width="2" opacity="0">
        <animate attributeName="r" values="${r0}; ${r1}" keyTimes="0; 1" dur="${durSec}s" begin="${beginSec}s" fill="freeze" />
        <animate attributeName="opacity" values="0; 0.9; 0" keyTimes="0; 0.15; 1" dur="${durSec}s" begin="${beginSec}s" fill="freeze" />
      </circle>
      <circle cx="${num(c.x)}" cy="${num(c.y)}" r="${r0}" fill="none" stroke="${c.style.pulseStroke}" stroke-width="1" opacity="0">
        <animate attributeName="r" values="${r0}; ${r1 - 1}" keyTimes="0; 1" dur="${durSec}s" begin="${beginSec}s" fill="freeze" />
        <animate attributeName="opacity" values="0; 0.95; 0" keyTimes="0; 0.15; 1" dur="${durSec}s" begin="${beginSec}s" fill="freeze" />
      </circle>${secondaryHalf}
    </g>`;
}

/** macOS-style cursor arrow path. The hot point (0, 0) sits at the tip. */
function macosCursorPath(scale: number): string {
  // Path approximates the macOS pointer: tip at (0, 0), tail extends down and
  // right with a small notch. Stroked white with a thin black outline so it
  // reads on any background.
  const d = "M 0 0 L 0 16 L 4 12 L 7 18 L 9 17 L 6 11 L 12 11 Z";
  const transform = scale !== 1 ? ` transform="scale(${num(scale)})"` : "";
  return `<path d="${d}" fill="rgb(255,255,255)" stroke="rgb(0,0,0)" stroke-width="1" stroke-linejoin="round"${transform} />`;
}

function num(n: number): string {
  return Number(n.toFixed(2)).toString();
}
