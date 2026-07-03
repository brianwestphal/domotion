/**
 * DM-1563 (docs/94 Option 2): hover-response auto-detection helpers.
 *
 * The `hoverDetect` sugar in `animate.ts` drives a real pointer (via forced
 * `:hover`), snapshots `getComputedStyle` (+ geometry) on the target and its
 * descendants before → after, and synthesizes a cross-engine transition from the
 * diff. This module holds the two BROWSER-FREE pieces so they're unit-testable:
 *   - `diffHoverSnapshots` — compare two style snapshots into paint / motion deltas;
 *   - `classifyHoverTransition` — pick the synthesis mode from the diff;
 * plus `captureStyleSnapshot`, the one Playwright call that reads the snapshot.
 *
 * The binding constraint (docs/84): output is cross-engine `@keyframes` only. So
 * PAINT deltas (color / background / border / box-shadow) can't keyframe cleanly
 * across engines — they degrade to a rest→hover opacity crossfade (which blends
 * them faithfully). MOTION deltas (transform / opacity on the target) DO map to a
 * keyframe, so they tween in place. That split is what `classifyHoverTransition`
 * decides.
 */

import type { Page } from "@playwright/test";

/**
 * Computed-style properties whose hover deltas a crossfade blends faithfully.
 * `getComputedStyle` reports these in camelCase; the resolved values (rgb(),
 * matrix(), px) are what we string-compare.
 */
export const HOVER_PAINT_PROPERTIES = [
  "color",
  "backgroundColor",
  "backgroundImage",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxShadow",
  "outlineColor",
  "outlineWidth",
] as const;

/** Computed-style properties that map to a cross-engine intra-frame keyframe. */
export const HOVER_MOTION_PROPERTIES = ["transform", "opacity"] as const;

/** The full allow-list read from the page (the union of paint + motion). */
export const HOVER_DIFF_PROPERTIES: readonly string[] = [
  ...HOVER_PAINT_PROPERTIES,
  ...HOVER_MOTION_PROPERTIES,
];

/** A per-element computed-style + geometry snapshot. `key` is `""` for the target
 *  and a stable descendant index (`"0"`, `"1"`, …) for its descendants, so a rest
 *  snapshot and a hover snapshot can be aligned element-for-element. */
export interface ElementStyleSnapshot {
  key: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

/** One changed computed-style property on one element. */
export interface HoverPropDelta {
  key: string;
  property: string;
  from: string;
  to: string;
}

/** The paint / motion deltas between a rest and a hover snapshot. */
export interface HoverDiff {
  paint: HoverPropDelta[];
  motion: HoverPropDelta[];
}

/**
 * Diff two aligned snapshots into paint- and motion-property deltas. Elements are
 * matched by `key`; a property counts as changed when both sides report it and
 * the resolved strings differ. Descendants present in only one snapshot are
 * skipped (a hover rule that adds/removes a node is out of scope for this
 * style-diff — that's the MutationObserver path, docs/94 Option 3).
 */
export function diffHoverSnapshots(
  rest: ElementStyleSnapshot[],
  hover: ElementStyleSnapshot[],
): HoverDiff {
  const hoverByKey = new Map(hover.map((s) => [s.key, s]));
  const paint: HoverPropDelta[] = [];
  const motion: HoverPropDelta[] = [];
  for (const r of rest) {
    const h = hoverByKey.get(r.key);
    if (h == null) continue;
    for (const p of HOVER_PAINT_PROPERTIES) {
      const a = r.styles[p];
      const b = h.styles[p];
      if (a != null && b != null && a !== b) paint.push({ key: r.key, property: p, from: a, to: b });
    }
    for (const p of HOVER_MOTION_PROPERTIES) {
      const a = r.styles[p];
      const b = h.styles[p];
      if (a != null && b != null && a !== b) motion.push({ key: r.key, property: p, from: a, to: b });
    }
  }
  return { paint, motion };
}

export type HoverSynthesisMode = "none" | "paint" | "motion";

/**
 * A transform / opacity delta only rides the intra-frame keyframe path when its
 * REST baseline is the identity the captured paint already bakes in — otherwise
 * multiplying the animated group by the absolute value would double-apply. So
 * `transform` must start from `none` and `opacity` from `1`; anything else falls
 * back to the (always-faithful) crossfade.
 */
function isCleanMotionBaseline(d: HoverPropDelta): boolean {
  if (d.property === "transform") return d.from === "none";
  if (d.property === "opacity") return d.from === "1";
  return false;
}

/**
 * Pick the synthesis mode from a diff (docs/94 Option 2):
 *   - `none`   — nothing in the allow-list changed;
 *   - `motion` — ONLY transform/opacity on the TARGET changed, from clean
 *                baselines → an intra-frame tween animates it in place;
 *   - `paint`  — anything else (a color/background/border/box-shadow change, a
 *                descendant change, or a non-clean-baseline transform) → a
 *                rest→hover crossfade blends the deltas faithfully.
 */
export function classifyHoverTransition(diff: HoverDiff): HoverSynthesisMode {
  if (diff.paint.length === 0 && diff.motion.length === 0) return "none";
  const motionOnly =
    diff.paint.length === 0 &&
    diff.motion.length > 0 &&
    diff.motion.every((d) => d.key === "" && isCleanMotionBaseline(d));
  return motionOnly ? "motion" : "paint";
}

/** One fused intra-frame motion tween derived from a `motion` diff — the target's
 *  transform (primary) with opacity fused in, or an opacity-only track. The
 *  target-key field (`selector` for the config form, `animId` for the resolved
 *  form) is added by the caller, so this stays shape-agnostic (DM-1582). */
export interface MotionTweenTrack {
  property: "transform" | "opacity";
  from: string;
  to: string;
  duration: number;
  easing: string;
  transformOrigin?: string;
  delay?: number;
  fuse?: Array<{ property: "opacity"; from: string; to: string }>;
}

/**
 * DM-1582: the single shared motion-tween synthesizer for the `motion`-mode
 * synthesis (a clean transform/opacity delta). `hoverDetect` (forced `:hover`
 * diff) and `jsReveal` (JS-mutation diff) both call this and then attach their
 * own target key (`selector` / `animId`), so the transform-primary-with-fused-
 * opacity / opacity-only logic lives in ONE place. `transform` is the primary
 * track (centered origin, eases out into the state); an opacity change fuses in,
 * or an opacity-only delta becomes a plain opacity track. Returns `[]` when the
 * diff carries no target motion track.
 */
export function synthesizeMotionTween(diff: HoverDiff, durationMs: number, delayMs = 0): MotionTweenTrack[] {
  const target = diff.motion.filter((d) => d.key === "");
  const transform = target.find((d) => d.property === "transform");
  const opacity = target.find((d) => d.property === "opacity");
  const delayField = delayMs > 0 ? { delay: delayMs } : {};
  if (transform != null) {
    const primary: MotionTweenTrack = {
      property: "transform", from: transform.from, to: transform.to,
      duration: durationMs, easing: "ease-out", transformOrigin: "center", ...delayField,
    };
    if (opacity != null) primary.fuse = [{ property: "opacity", from: opacity.from, to: opacity.to }];
    return [primary];
  }
  if (opacity != null) {
    return [{ property: "opacity", from: opacity.from, to: opacity.to, duration: durationMs, easing: "ease-out", ...delayField }];
  }
  return [];
}

/**
 * Read a computed-style + geometry snapshot of `selector` and its descendants.
 * Throws (in page context) if the selector matches nothing. The lone browser
 * touch-point of this module — the diff / classify above are pure.
 */
export async function captureStyleSnapshot(
  page: Page,
  selector: string,
  properties: readonly string[],
): Promise<ElementStyleSnapshot[]> {
  // NB: the evaluate body must contain NO named inner functions — a
  // named function expression triggers the tsx/esbuild `keepNames` `__name(...)`
  // helper, which is undefined in the page context and throws "ReferenceError:
  // __name is not defined". So the per-element read is inlined into a flat loop.
  return page.evaluate(
    (args: { selector: string; properties: string[] }) => {
      const target = document.querySelector(args.selector);
      if (target == null) throw new Error(`hoverDetect selector "${args.selector}" matched no element`);
      const elements = [target, ...Array.from(target.querySelectorAll("*"))];
      const out: Array<{ key: string; styles: Record<string, string>; rect: { x: number; y: number; width: number; height: number } }> = [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const cs = getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (const p of args.properties) styles[p] = (cs as unknown as Record<string, string>)[p];
        const r = el.getBoundingClientRect();
        out.push({
          key: i === 0 ? "" : String(i - 1),
          styles,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        });
      }
      return out;
    },
    { selector, properties: [...properties] },
  );
}
