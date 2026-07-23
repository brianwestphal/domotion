/**
 * DM-1742: paint-order hit-testing over a captured tree.
 *
 * The auto cursor overlay needs "which element is visually topmost at (x, y)?"
 * to pick the pointer glyph (hand over a link, I-beam over text, arrow at
 * rest). The old `cursorAtPoint` answered with the LAST element in DFS
 * pre-order whose box contains the point — a z-index-agnostic approximation
 * that breaks on any layout where positioned elements overlap (stacked
 * windows switched via z-index, modals over content, dropdowns, sticky
 * headers): whatever happens to be later in the DOM answers the hit-test,
 * not what the viewer sees.
 *
 * This module walks the tree in the RENDERER'S OWN paint order — the same
 * `gatherStackingContextChildren` / `sortChildrenByPaintOrder` traversal
 * `elementTreeToSvg` uses to emit the SVG (stacking contexts, z-index
 * buckets, float/inline hoisting, viewport-fixed pulling, preserve-3d
 * re-sort) — and takes the last hit. So the glyph matches whatever OUR
 * rendered SVG paints topmost at that point, which is calibrated to match
 * Chrome's paint.
 *
 * Hit-test semantics beyond paint order:
 * - `pointer-events: none` elements are skipped (captured as
 *   `styles.pointerEvents`; the property inherits, so descendants carry the
 *   computed value themselves — no subtree bookkeeping needed here).
 * - `overflow != visible` ancestors clip: a descendant's box only hits where
 *   it intersects every enclosing overflow-clip rect (matching browser
 *   hit-testing, which never hits content scrolled/clipped out of view).
 *   Hoisted descendants keep the clip of the overflow ancestor they escaped
 *   (the renderer's `overflowClipForHoisted` map), and `position: fixed`
 *   escapes overflow clips entirely, mirroring the render path.
 * - `visibility: hidden` needs no handling — the capture script omits those
 *   elements from the tree entirely.
 *
 * The flattened sequence is memoized per tree (WeakMap on the roots array):
 * the cursor-timeline builder samples hundreds of points with bisection
 * refinement against the same per-frame trees.
 */

import type { CapturedElement } from "../capture/types.js";
import {
  establishesStackingContext,
  gatherStackingContextChildren,
  isFixedContainingBlock,
  sortChildrenByPaintOrder,
} from "./stacking.js";

interface ClipRect { x: number; y: number; w: number; h: number }

interface HitEntry {
  el: CapturedElement;
  /** Overflow-clip rects this element's hit box is constrained to. */
  clips: ClipRect[];
}

function overflowClips(el: CapturedElement): boolean {
  const s = el.styles;
  return (s.overflowX != null && s.overflowX !== "visible")
    || (s.overflowY != null && s.overflowY !== "visible");
}

function rectOf(el: CapturedElement): ClipRect {
  return { x: el.x, y: el.y, w: el.width, h: el.height };
}

/**
 * Flatten a captured tree into the renderer's paint order. Mirrors
 * `elementTreeToSvgInner`'s top-level pass (implicit-root SC gather +
 * viewport-fixed pull + sort) and `renderChildren` (per-element SC gather /
 * hoist-skip filter + sort + preserve-3d re-sort).
 */
export function paintOrderHitSequence(elements: CapturedElement[]): HitEntry[] {
  // Defensive: hand-built trees (tests, library callers) may omit `styles` /
  // `children`; the shared stacking helpers dereference both. An empty styles
  // object means "all defaults" (static, z auto, overflow visible), which is
  // exactly the DFS-order behavior such minimal trees expect.
  const normalize = (el: CapturedElement): void => {
    if (el.styles == null) el.styles = {} as CapturedElement["styles"];
    if (el.children == null) el.children = [];
    for (const c of el.children) normalize(c);
  };
  for (const e of elements) normalize(e);
  const out: HitEntry[] = [];
  const hoisted = new Set<CapturedElement>();
  const clipForHoisted = new Map<CapturedElement, CapturedElement>();

  const topInline = new Set<CapturedElement>();
  const topZSorted = new Set<CapturedElement>();
  const topFlat = gatherStackingContextChildren(elements, hoisted, undefined, topInline, clipForHoisted, topZSorted);
  // Viewport-fixed pull — mirror of the renderer's collectViewportFixed
  // (position:fixed paints in the viewport SC and escapes ancestor clips,
  // unless trapped by a fixed-containing-block ancestor).
  const collectViewportFixed = (parent: CapturedElement): void => {
    for (const c of parent.children ?? []) {
      if (c.styles.position === "fixed") {
        if (!hoisted.has(c)) {
          topFlat.push(c);
          hoisted.add(c);
        }
      } else if (!isFixedContainingBlock(c)) {
        collectViewportFixed(c);
      }
    }
  };
  for (const e of elements) {
    if (e.styles.position !== "fixed" && !isFixedContainingBlock(e)) {
      collectViewportFixed(e);
    }
  }
  const sortedTop = sortChildrenByPaintOrder(topFlat, undefined, undefined, topInline, topZSorted);

  const visit = (el: CapturedElement, parentDisplay: string | undefined, clips: ClipRect[]): void => {
    out.push({ el, clips });
    if (el.children == null || el.children.length === 0) return;
    const childClips = overflowClips(el) ? [...clips, rectOf(el)] : clips;
    const display = el.styles.display;
    const inlineForEl = new Set<CapturedElement>();
    const zSortedForEl = new Set<CapturedElement>();
    let childrenForSort: CapturedElement[];
    if (establishesStackingContext(el, parentDisplay)) {
      childrenForSort = gatherStackingContextChildren(el.children, hoisted, display, inlineForEl, clipForHoisted, zSortedForEl);
    } else {
      childrenForSort = el.children.filter((c) => !hoisted.has(c));
    }
    let sorted = sortChildrenByPaintOrder(childrenForSort, display, el.styles.flexDirection, inlineForEl, zSortedForEl, new Set(el.children));
    if (el.styles.transformStyle === "preserve-3d") {
      sorted = sorted
        .map((c, idx) => ({ c, idx, z: c.styles.translateZ ?? 0 }))
        .sort((a, b) => a.z - b.z || a.idx - b.idx)
        .map((x) => x.c);
    }
    for (const c of sorted) {
      // A hoisted descendant that escaped an overflow-only scroller keeps
      // that scroller's clip (unless fixed, which escapes overflow clips).
      const escaped = clipForHoisted.get(c);
      const cClips = escaped != null && c.styles.position !== "fixed"
        ? [...childClips, rectOf(escaped)]
        : childClips;
      visit(c, display, cClips);
    }
  };
  for (const el of sortedTop) {
    const escaped = clipForHoisted.get(el);
    const clips = escaped != null && el.styles.position !== "fixed" ? [rectOf(escaped)] : [];
    visit(el, undefined, clips);
  }
  return out;
}

const sequenceCache = new WeakMap<CapturedElement[], HitEntry[]>();

/**
 * The visually-topmost captured element at viewport point (x, y), in true
 * paint order (last painted hit wins), skipping `pointer-events: none` and
 * honoring overflow clipping. Returns null when nothing hits.
 */
export function hitTestTopmost(elements: CapturedElement[], x: number, y: number): CapturedElement | null {
  let seq = sequenceCache.get(elements);
  if (seq == null) {
    seq = paintOrderHitSequence(elements);
    sequenceCache.set(elements, seq);
  }
  let best: CapturedElement | null = null;
  for (const { el, clips } of seq) {
    if (el.styles.pointerEvents === "none") continue;
    if (el.width <= 0 || el.height <= 0) continue;
    if (x < el.x || x >= el.x + el.width || y < el.y || y >= el.y + el.height) continue;
    let clipped = false;
    for (const c of clips) {
      if (x < c.x || x >= c.x + c.w || y < c.y || y >= c.y + c.h) { clipped = true; break; }
    }
    if (clipped) continue;
    best = el;
  }
  return best;
}
