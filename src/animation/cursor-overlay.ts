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
 * Cursor TYPE (DM-1106): by default the overlay paints the right cursor for
 * whatever is under it — arrow over body, hand over a link, I-beam over text,
 * resize arrows over a resizer, etc. — switching exactly at element boundaries
 * as the pointer moves, matching what the browser showed. The keyword comes
 * from the captured `cursor` field (resolved per Blink, including `auto`); the
 * caller supplies a `resolveCursorAt(x, y, frameIndex)` hit-tester (built from
 * the per-frame trees) and the glyphs come from `cursor-glyphs.ts`. A per-event
 * `cursor` override forces a specific glyph. Without a resolver the overlay
 * falls back to the single arrow (back-compat).
 *
 * See docs/13-cursor-overlay.md for the design.
 */

import type { CapturedElement } from "../capture/types.js";
import { cursorGlyphSvg } from "./cursor-glyphs.js";

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
  /** DM-1106: force a specific cursor keyword for this move (skip auto hit-test). */
  cursor?: string;
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
  /** DM-1106: force a specific cursor keyword from this point (skip auto hit-test). */
  cursor?: string;
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

/** DM-1106: hit-tester for the cursor TYPE at a viewport point in a given frame. */
export type CursorAtResolver = (x: number, y: number, frameIndex: number) => string;

interface KeyframePoint { t: number; x: number; y: number; visible: boolean; cursor?: string }
interface ResolvedClick { t: number; x: number; y: number; button: "primary" | "secondary" | "middle"; style: CursorStyle }
/** A cursor-keyword timeline entry: from time `t` the active glyph is `cursor`
 *  (or null = cursor hidden). DM-1106. */
export interface CursorTimelineEntry { t: number; cursor: string | null }

/**
 * DM-1106: the effective cursor keyword at viewport point (x, y) for a captured
 * tree — the LAST element in paint order (DFS pre-order) whose box contains the
 * point. `cursor` inherits and was resolved per element at capture, so the
 * topmost element's stored value (or `default` when omitted) is what Chrome
 * painted. A z-index-agnostic approximation: good for the nested-element and
 * later-sibling-on-top cases a cursor overlay cares about.
 */
export function cursorAtPoint(roots: CapturedElement[], x: number, y: number): string {
  let best: CapturedElement | null = null;
  const visit = (n: CapturedElement): void => {
    if (n.width > 0 && n.height > 0 && x >= n.x && x < n.x + n.width && y >= n.y && y < n.y + n.height) best = n;
    const kids = (n as { children?: CapturedElement[] }).children;
    if (kids != null) for (const c of kids) visit(c);
  };
  for (const r of roots) visit(r);
  return (best as CapturedElement | null)?.cursor ?? "default";
}

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
  /** DM-1106: auto cursor-type hit-tester. When provided, the result includes a
   *  `cursorTimeline` driving per-glyph switching; when null, the overlay paints
   *  the single arrow (back-compat). */
  resolveCursorAt: CursorAtResolver | null = null,
): { positions: KeyframePoint[]; clicks: ResolvedClick[]; style: CursorStyle; cursorTimeline: CursorTimelineEntry[] | null } {
  const baseStyle: CursorStyle = { ...DEFAULT_STYLE, ...overlay.style };
  const events = [...overlay.events].sort((a, b) => a.t - b.t);

  const positions: KeyframePoint[] = [];
  const clicks: ResolvedClick[] = [];
  let curX = 0;
  let curY = 0;
  let visible = false;

  const pushKey = (t: number, x: number, y: number, vis: boolean, cursor?: string): void => {
    positions.push({ t, x, y, visible: vis, cursor });
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
      pushKey(ev.t, ev.x, ev.y, true, ev.cursor);
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
        // The `cursor` override (if any) rides the whole slide.
        pushKey(ev.t, curX, curY, true, ev.cursor);
        pushKey(ev.t + dur, target.x, target.y, true, ev.cursor);
      } else {
        pushKey(ev.t, target.x, target.y, true, ev.cursor);
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
    positions.push({ t: totalDurationMs, x: last.x, y: last.y, visible: last.visible, cursor: last.cursor });
  }

  const cursorTimeline = resolveCursorAt != null
    ? buildCursorTimeline(positions, totalDurationMs, frameForT, resolveCursorAt)
    : null;

  return { positions, clicks, style: baseStyle, cursorTimeline };
}

/** Interpolated cursor state at time `t` from the position keyframes. Position
 *  lerps within a keyframe interval; visibility + the per-segment cursor
 *  override are step-held from the interval's start keyframe. */
function stateAtTime(positions: KeyframePoint[], t: number): { x: number; y: number; visible: boolean; cursor?: string } {
  if (t <= positions[0].t) return positions[0];
  const n = positions.length;
  for (let i = 0; i < n - 1; i++) {
    const a = positions[i], b = positions[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, visible: a.visible, cursor: a.cursor };
    }
  }
  return positions[n - 1];
}

/**
 * Build the cursor-keyword timeline (DM-1106). Samples the position timeline,
 * resolving the cursor at each sample (an override wins; otherwise hit-test the
 * frame under the point); emits an entry whenever the keyword changes, with the
 * change time bisection-refined so the glyph switches AT the element boundary
 * the pointer crosses (not at the next coarse sample). `null` = cursor hidden.
 */
function buildCursorTimeline(
  positions: KeyframePoint[],
  totalDurationMs: number,
  frameForT: (t: number) => number,
  resolveCursorAt: CursorAtResolver,
): CursorTimelineEntry[] {
  const cursorAtTime = (t: number): string | null => {
    const s = stateAtTime(positions, t);
    if (!s.visible) return null;
    return s.cursor ?? resolveCursorAt(s.x, s.y, frameForT(t));
  };
  const step = Math.max(8, Math.min(40, totalDurationMs / 400));
  const timeline: CursorTimelineEntry[] = [];
  let prev = cursorAtTime(0);
  timeline.push({ t: 0, cursor: prev });
  for (let t = step; t <= totalDurationMs; t += step) {
    const c = cursorAtTime(t);
    if (c !== prev) {
      // Refine the crossing time in (t-step, t] so the switch lands on the
      // boundary, not the sample grid.
      let lo = t - step, hi = t;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (cursorAtTime(mid) === prev) lo = mid; else hi = mid;
      }
      timeline.push({ t: Math.min(totalDurationMs, hi), cursor: c });
      prev = c;
    }
  }
  if (timeline[timeline.length - 1].t < totalDurationMs) {
    timeline.push({ t: totalDurationMs, cursor: prev });
  }
  return timeline;
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
 *
 * When `cursorTimeline` is provided (DM-1106), the pointer's GLYPH switches over
 * time to match what was under it: each distinct keyword gets a glyph drawn
 * hotspot-at-origin inside the shared position-animated group, with a discrete
 * opacity track that turns it on only during its windows (and visibility folds
 * in as the all-glyphs-off `null` state). Without a timeline, the single white
 * arrow paints (back-compat).
 */
export function cursorOverlayMarkup(
  positions: KeyframePoint[],
  clicks: ResolvedClick[],
  style: CursorStyle,
  totalDurationMs: number,
  cursorTimeline: CursorTimelineEntry[] | null = null,
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
  const posAnim = `<animateTransform attributeName="transform" type="translate" values="${valueStrs.join("; ")}" keyTimes="${keyTimes.join("; ")}" dur="${totalSec}s" repeatCount="indefinite" fill="freeze" />`;

  // Pulse SVG fragments — one per click, with timing keyed off `t`.
  const pulseMarkup = clicks.map((c, i) => buildPulseFragment(c, i, totalDurationMs)).join("\n");

  let pointerGroup: string;
  if (cursorTimeline != null && cursorTimeline.length > 0) {
    // DM-1106: one glyph per distinct keyword, each toggled by a discrete
    // opacity track derived from the keyword timeline. The shared parent group
    // carries the position animation; glyphs are hotspot-at-origin so each lands
    // correctly regardless of its own hotspot.
    const size = 22 * (style.cursorScale || 1);
    const tKeyTimes = cursorTimeline.map((e) => (e.t / totalDurationMs).toFixed(4));
    const kinds = Array.from(new Set(cursorTimeline.map((e) => e.cursor).filter((c): c is string => c != null)));
    const glyphLayers = kinds.map((kind) => {
      const glyph = cursorGlyphSvg(kind, 0, 0, size, style.cursorStroke);
      const opVals = cursorTimeline.map((e) => (e.cursor === kind ? "1" : "0"));
      return `      <g opacity="0">
        <animate attributeName="opacity" values="${opVals.join(";")}" keyTimes="${tKeyTimes.join(";")}" dur="${totalSec}s" repeatCount="indefinite" calcMode="discrete" fill="freeze" />
        ${glyph}
      </g>`;
    }).join("\n");
    pointerGroup = `    <g class="cursor-pointer">
      ${posAnim}
${glyphLayers}
    </g>`;
  } else {
    // Legacy single-arrow path (no auto cursor-type resolver supplied).
    const visValues = positions.map((p) => (p.visible ? "1" : "0"));
    pointerGroup = `    <g class="cursor-arrow" opacity="0">
      ${posAnim}
      <animate attributeName="opacity" values="${visValues.join(";")}" keyTimes="${keyTimes.join(";")}" dur="${totalSec}s" repeatCount="indefinite" calcMode="discrete" fill="freeze" />
      ${macosCursorPath(style.cursorScale)}
    </g>`;
  }

  return `  <g class="cursor-overlay" pointer-events="none">
${pointerGroup}
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
