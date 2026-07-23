/**
 * Caret + selection track (docs/101; designed in docs/100 "Primitive 2").
 *
 * A first-class, declarative caret / selection renderable anchored to CAPTURED
 * text: the author gives timed events addressing `{ target, charOffset }`
 * positions (resolved through `text-address.ts` against a captured tree), and
 * this module emits the SVG markup + CSS `@keyframes` — in GLOBAL timeline
 * percents — that `generateAnimatedSvg` layers above the frame content (and
 * below the cursor overlay).
 *
 * Two stages, mirroring the magic-move precedent (built caller-side from the
 * element trees, consumed by the animator as resolved data):
 *   1. `resolveTextTrack(roots, spec)` — resolve every event's address into
 *      concrete caret points / selection rects (needs the captured tree).
 *   2. `textTrackMarkup(track, totalDurationMs)` — pure emission (no tree),
 *      called by `generateAnimatedSvg` on `config.textTracks`.
 *
 * Emission model (the `buildCursor` / `buildTypingCaret` two-track pattern from
 * `src/terminal/incremental.ts` / `animator.ts`):
 *   - caret POSITION: `step-end` transform waypoints on the global timeline
 *     (carets jump, they don't glide);
 *   - caret VISIBILITY: a separate `step-end` opacity track (hidden before the
 *     first waypoint, toggled by hide/show);
 *   - caret BLINK: the standard ~1.06 s cycle on a nested group (the terminal
 *     cursor's `tcur-b` convention) — opacities compose through nesting, so
 *     vis × blink × position never fight over one property;
 *   - selection: one rect per covered text run, grown via `width` keyframes
 *     stepping through the per-character painted edges (the same width-keyframe
 *     machinery the typing overlay's reveal clips use), cleared on command.
 *
 * All motion is CSS opacity / transform / width — no SMIL (docs/84), no
 * animated filter. `@keyframes` names are namespaced with a content hash (the
 * cursor-overlay convention) so composited SVGs can't collide.
 *
 * Z-ORDER (documented contract): as a standalone overlay the selection rect
 * paints ABOVE the captured text — a translucent highlight-marker look, right
 * for walkthrough highlighting. True editor selection paints BEHIND the
 * glyphs; that arrives with the frame-sequence compressor's merged emission
 * (docs/100, Primitive 1), which owns the glyphs and can interleave layers.
 */

import type { CapturedElement } from "../capture/types.js";
import { caretShapeRect, DEFAULT_CARET_WIDTH_PX, type CaretShape } from "./caret-metrics.js";
import { resolveCaretPoint, resolveRangeRects, type CaretPoint, type SelectionRectPlan, type TextAddressTarget } from "./text-address.js";

/** The standard caret blink period (ms) — the terminal cursor's 1.06 s cycle. */
export const CARET_BLINK_MS = 1060;

/** Default selection fill — a translucent blue (#3b82f6 at ~2/3 alpha). */
export const DEFAULT_SELECTION_COLOR = "#3b82f6aa";

/** Above this many covered characters a selection sweep interpolates linearly
 *  between its endpoints instead of stepping per character — same bounded-CSS
 *  rationale as the typing overlay's `MAX_DISCRETE_TYPING_CHARS`. */
const MAX_DISCRETE_SWEEP_CHARS = 120;

// ── Authoring-level spec (address-based; resolved against a captured tree) ──

/** A text address within the track's (or the event's) target element. */
export interface TextTrackEventBase {
  /** Event time, ms on the animation's global timeline. */
  t: number;
  /** Per-event target override (defaults to the track's `target`). */
  target?: TextAddressTarget;
}

export type TextTrackSpecEvent =
  /** Place the caret at the address at `t` (shows it if hidden). While parked
   *  the caret blinks on the standard cycle. */
  | (TextTrackEventBase & { type: "park"; charOffset: number })
  /** Step-end jump to the address at `t` (identical geometry semantics to
   *  `park`; the distinct name keeps authored scripts readable). */
  | (TextTrackEventBase & { type: "move"; charOffset: number })
  /** Hide the caret at `t` (a later park/move re-shows it). */
  | { type: "hide"; t: number }
  /** Sweep a selection over `[charStart, charEnd)` starting at `t`, growing
   *  over `sweepMs` (default 0 = appears fully at `t`). */
  | (TextTrackEventBase & { type: "select"; charStart: number; charEnd: number; sweepMs?: number; color?: string })
  /** Clear any active selection at `t`. */
  | { type: "clearSelection"; t: number };

export interface TextTrackSpec {
  /** Default target the events address (per-event `target` overrides). */
  target: TextAddressTarget;
  /** Caret shape (docs/97): `bar` (default) / `block` / `underscore`. */
  shape?: CaretShape;
  /** Caret color. Default `#111111`. */
  color?: string;
  /** Bar-caret width px (default 2). */
  barWidthPx?: number;
  /** Blink period ms (default {@link CARET_BLINK_MS}). */
  blinkMs?: number;
  /** Default selection fill (per-event `color` overrides). */
  selectionColor?: string;
  events: TextTrackSpecEvent[];
}

// ── Resolved track (concrete geometry; what the animator consumes) ──────────

export interface ResolvedCaretWaypoint {
  t: number;
  point: CaretPoint;
}

export interface ResolvedSelection {
  t: number;
  sweepMs: number;
  color: string;
  rects: SelectionRectPlan[];
  charCount: number;
  /** When set, the selection clears (hides) at this time. */
  clearT?: number;
}

export interface ResolvedTextTrack {
  shape: CaretShape;
  color: string;
  barWidthPx: number;
  blinkMs: number;
  /** Caret position waypoints in time order. Empty → no caret is drawn
   *  (selection-only track). */
  waypoints: ResolvedCaretWaypoint[];
  /** Times at which the caret hides (until the next waypoint at/after it). */
  hides: number[];
  selections: ResolvedSelection[];
}

/**
 * Resolve an address-based spec against a captured tree into concrete
 * geometry. Unresolvable addresses (missing target, out-of-range offsets) are
 * skipped with a console warning — the same soft-fail convention the cursor
 * overlay's selector resolution uses.
 */
export function resolveTextTrack(roots: CapturedElement[], spec: TextTrackSpec): ResolvedTextTrack {
  const waypoints: ResolvedCaretWaypoint[] = [];
  const hides: number[] = [];
  const selections: ResolvedSelection[] = [];
  const events = [...spec.events].sort((a, b) => a.t - b.t);
  for (const ev of events) {
    if (ev.type === "park" || ev.type === "move") {
      const point = resolveCaretPoint(roots, ev.target ?? spec.target, ev.charOffset);
      if (point == null) {
        console.warn(`caret-track: ${ev.type} at t=${ev.t} charOffset=${ev.charOffset} did not resolve; skipping`);
        continue;
      }
      waypoints.push({ t: ev.t, point });
    } else if (ev.type === "hide") {
      hides.push(ev.t);
    } else if (ev.type === "select") {
      const range = resolveRangeRects(roots, ev.target ?? spec.target, ev.charStart, ev.charEnd);
      if (range == null) {
        console.warn(`caret-track: select at t=${ev.t} [${ev.charStart}, ${ev.charEnd}) did not resolve; skipping`);
        continue;
      }
      selections.push({
        t: ev.t,
        sweepMs: Math.max(0, ev.sweepMs ?? 0),
        color: ev.color ?? spec.selectionColor ?? DEFAULT_SELECTION_COLOR,
        rects: range.rects,
        charCount: range.charCount,
      });
    } else {
      // clearSelection: applies to the most recent un-cleared selection.
      for (let i = selections.length - 1; i >= 0; i--) {
        if (selections[i].clearT == null && selections[i].t <= ev.t) {
          selections[i].clearT = ev.t;
          break;
        }
      }
    }
  }
  return {
    shape: spec.shape ?? "bar",
    color: spec.color ?? "#111111",
    barWidthPx: spec.barWidthPx ?? DEFAULT_CARET_WIDTH_PX,
    blinkMs: spec.blinkMs ?? CARET_BLINK_MS,
    waypoints,
    hides,
    selections,
  };
}

// ── Emission ────────────────────────────────────────────────────────────────

/** Deterministic 6-char base36 content hash (the cursor-overlay convention) so
 *  composited SVGs with several tracks can't collide on keyframe names. */
function trackUid(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function pct(ms: number, totalMs: number): string {
  return `${Number(Math.max(0, Math.min(100, (ms / totalMs) * 100)).toFixed(4))}%`;
}

function num(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/**
 * Emit one resolved track as a self-contained `<g class="text-track">` with a
 * local `<style>`. Selection rects paint first, the caret last (so a parked
 * caret reads over its own selection). Returns "" for an empty track.
 * `index` distinguishes multiple tracks in one animation (part of the uid seed).
 */
export function textTrackMarkup(track: ResolvedTextTrack, totalDurationMs: number, index = 0): string {
  if (totalDurationMs <= 0) return "";
  if (track.waypoints.length === 0 && track.selections.length === 0) return "";
  const totalSec = totalDurationMs / 1000;
  const uid = trackUid(
    `${index}|${totalDurationMs}|${track.waypoints.map((w) => `${w.t},${w.point.x},${w.point.baselineY}`).join(";")}|` +
    `${track.selections.map((s) => `${s.t},${s.rects[0]?.x}`).join(";")}`,
  );
  const kf: string[] = [];
  const parts: string[] = [];

  for (let si = 0; si < track.selections.length; si++) {
    parts.push(selectionMarkup(track.selections[si], si, uid, kf, totalDurationMs, totalSec));
  }
  if (track.waypoints.length > 0) {
    parts.push(caretMarkup(track, uid, kf, totalDurationMs, totalSec));
  }
  return `  <g class="text-track" pointer-events="none">
    <style>${kf.join("")}</style>
${parts.join("\n")}
  </g>`;
}

/**
 * The caret: a rect sized by `caretShapeRect` from the FIRST waypoint's
 * metrics, drawn with its top-left at the origin and walked by a `step-end`
 * transform track. Waypoints whose metrics differ (another font size /
 * element) fold a `scale(...)` into their transform — exact for a solid rect.
 * Visibility windows come from the hide times; the blink rides a nested group
 * on its own short cycle (`CARET_BLINK_MS`), exactly like the terminal cursor.
 */
function caretMarkup(track: ResolvedTextTrack, uid: string, kf: string[], totalDurationMs: number, totalSec: number): string {
  const wps = track.waypoints;
  const base = caretGeom(track, wps[0].point);
  // Transform per waypoint: translate to the shape rect's top-left, scaling
  // when that waypoint's geometry differs from the base rect.
  const at = (p: CaretPoint): string => {
    const g = caretGeom(track, p);
    const sx = base.width > 0 ? g.width / base.width : 1;
    const sy = base.height > 0 ? g.height / base.height : 1;
    const scale = Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3 ? ` scale(${num(sx)},${num(sy)})` : "";
    return `translate(${num(g.x)}px,${num(g.y)}px)${scale}`;
  };

  const pos: string[] = [`0%{transform:${at(wps[0].point)}}`];
  for (const w of wps) pos.push(`${pct(w.t, totalDurationMs)}{transform:${at(w.point)}}`);
  pos.push(`100%{transform:${at(wps[wps.length - 1].point)}}`);

  // Visibility: hidden until the first waypoint; each hide turns it off until
  // the next waypoint at/after the hide time; holds its final state to 100%.
  const changes: Array<{ t: number; on: boolean }> = [
    ...wps.map((w) => ({ t: w.t, on: true })),
    ...track.hides.map((t) => ({ t, on: false })),
  ].sort((a, b) => a.t - b.t || (a.on ? 1 : -1));
  const vis: string[] = [`0%{opacity:0}`];
  for (const c of changes) vis.push(`${pct(c.t, totalDurationMs)}{opacity:${c.on ? 1 : 0}}`);
  vis.push(`100%{opacity:${changes[changes.length - 1].on ? 1 : 0}}`);

  const posName = `tt-pos-${uid}`;
  const visName = `tt-vis-${uid}`;
  const blinkName = `tt-blink-${uid}`;
  kf.push(`@keyframes ${posName}{${pos.join("")}}`);
  kf.push(`@keyframes ${visName}{${vis.join("")}}`);
  // The standard blink: solid the first half-period, off the second (step-end).
  kf.push(`@keyframes ${blinkName}{0%{opacity:1}50%{opacity:0}100%{opacity:1}}`);
  const blinkSec = track.blinkMs / 1000;

  const fillOpacity = base.opacity < 1 ? ` fill-opacity="${base.opacity}"` : "";
  return `    <g class="tt-vis" opacity="0" style="animation:${visName} ${totalSec.toFixed(2)}s step-end infinite"><g class="tt-pos" style="animation:${posName} ${totalSec.toFixed(2)}s step-end infinite"><rect class="tt-caret" width="${num(base.width)}" height="${num(base.height)}" fill="${track.color}"${fillOpacity} style="animation:${blinkName} ${blinkSec}s step-end infinite"/></g></g>`;
}

/** The shape rect for a caret point under this track's shape settings. */
function caretGeom(track: ResolvedTextTrack, p: CaretPoint): { x: number; y: number; width: number; height: number; opacity: number } {
  return caretShapeRect({
    shape: track.shape,
    x: p.x,
    baselineY: p.baselineY,
    ascentPx: p.ascentPx,
    descentPx: p.descentPx,
    cellWidthPx: p.cellWidthPx,
    fontSize: p.fontSize,
    barWidthPx: track.barWidthPx,
  });
}

/**
 * One selection event: a rect per covered run, each grown by `width` keyframes.
 * The event's `sweepMs` is distributed across the covered characters in order,
 * so a range spanning runs sweeps run 1 fully, then run 2, etc. Under
 * {@link MAX_DISCRETE_SWEEP_CHARS} covered characters the width steps through
 * every painted char edge (`step-end` — exact per-char sweep); above it each
 * rect sweeps linearly between its endpoints. Cleared rects step back to the
 * hidden width at `clearT`; otherwise they hold to the loop end.
 *
 * Rects hide at width 0.01px, not 0 — WebKit treats a zero-area rect specially
 * in some paint paths (the typing overlay learned this for clip rects), and a
 * 0.01px fill shows no visible pixel.
 */
function selectionMarkup(sel: ResolvedSelection, si: number, uid: string, kf: string[], totalDurationMs: number, totalSec: number): string {
  const discrete = sel.charCount <= MAX_DISCRETE_SWEEP_CHARS;
  const perCharMs = sel.charCount > 0 ? sel.sweepMs / sel.charCount : 0;
  const parts: string[] = [];
  let sweptBefore = 0;
  for (let ri = 0; ri < sel.rects.length; ri++) {
    const rect = sel.rects[ri];
    const name = `tt-sel-${uid}-${si}-${ri}`;
    const startMs = sel.t + sweptBefore * perCharMs;
    const stops: string[] = [`0%{width:0.01px}`];
    if (startMs > 0) stops.push(`${pct(startMs, totalDurationMs)}{width:0.01px}`);
    if (sel.sweepMs > 0 && rect.edges.length > 0) {
      if (discrete) {
        for (let k = 0; k < rect.edges.length; k++) {
          const t = sel.t + (sweptBefore + k + 1) * perCharMs;
          stops.push(`${pct(t, totalDurationMs)}{width:${num(rect.edges[k] - rect.x)}px}`);
        }
      } else {
        const endMs = sel.t + (sweptBefore + rect.edges.length) * perCharMs;
        stops.push(`${pct(endMs, totalDurationMs)}{width:${num(rect.width)}px}`);
      }
    } else {
      stops.push(`${pct(startMs, totalDurationMs)}{width:${num(rect.width)}px}`);
    }
    // Discrete sweeps (and instant selections) step per stop; the coarse
    // fallback interpolates linearly between its endpoints. Under `linear`
    // timing, a clear must still SNAP — so a full-width hold stop lands just
    // before the clear time (duplicate adjacent values hold under linear).
    const timing = discrete || sel.sweepMs === 0 ? "step-end" : "linear";
    if (sel.clearT != null) {
      if (timing === "linear") stops.push(`${pct(Math.max(sel.t, sel.clearT - 1), totalDurationMs)}{width:${num(rect.width)}px}`);
      stops.push(`${pct(sel.clearT, totalDurationMs)}{width:0.01px}`);
      stops.push(`100%{width:0.01px}`);
    } else {
      stops.push(`100%{width:${num(rect.width)}px}`);
    }
    kf.push(`@keyframes ${name}{${stops.join("")}}`);
    parts.push(`    <rect class="tt-sel" x="${num(rect.x)}" y="${num(rect.y)}" width="0.01" height="${num(rect.height)}" fill="${sel.color}" style="animation:${name} ${totalSec.toFixed(2)}s ${timing} infinite"/>`);
    sweptBefore += rect.edges.length;
  }
  return parts.join("\n");
}
