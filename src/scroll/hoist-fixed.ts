/**
 * Hoist `position: fixed` elements out of scroll-segment trees so the scroll
 * composer doesn't render them once per segment.
 *
 * DM-643: each segment's capture sees the live page at a different scrollY but
 * a `position: fixed` element (e.g. a sticky-feeling site header) always
 * occupies the same viewport coordinates. The scroll composer stacks segments
 * vertically inside a translating composite, so the header from segment 0
 * ends up at composite-y = 0+headerY, the header from segment 1 at composite-y
 * = segment1.scrollY + headerY, and so on — producing the "fixed header
 * repeats every viewport-height" artifact described in the ticket.
 *
 * The fix is to recognise `position: fixed` during composition: strip those
 * subtrees from every per-segment capture and emit them once as a static
 * overlay above the scrolling composite (where they belong visually). They
 * stay in their captured viewport coordinates and never animate.
 */

import type { CapturedElement } from "../capture/types.js";
import { mapTreePruning } from "../tree-ops/prune-tree.js";

/**
 * Walk the tree, remove every subtree rooted at a `position: fixed` element
 * (matching what Chromium reports in `getComputedStyle`), and return the list
 * of removed subtrees. The input tree is shallow-copied at every level
 * touched by the strip so the caller's references aren't mutated.
 *
 * A subtree rooted at a fixed element is hoisted whole: descendants follow
 * their fixed ancestor. Inner fixed descendants of an already-hoisted subtree
 * are NOT separately extracted — they live inside their ancestor's hoisted
 * copy, which is the correct paint result (Chromium would paint them in the
 * same stacking context anyway).
 */
export function extractFixedSubtrees(tree: CapturedElement[]): {
  stripped: CapturedElement[];
  fixed: CapturedElement[];
} {
  const fixed: CapturedElement[] = [];
  const stripped = mapTreePruning(
    tree,
    (node) => node.styles?.position === "fixed",
    (node) => fixed.push(node),
  );
  return { stripped, fixed };
}

/**
 * Cross-segment dedupe: capture 0's fixed elements are typically present in
 * every segment too (the live page kept them fixed throughout the scroll).
 * Returns the union of fixed elements seen across all segments, keyed by a
 * coarse identity (tag + viewport position + size) so the same logical
 * element captured at slightly different times (e.g. with a small text-style
 * tweak) doesn't get emitted twice.
 *
 * v1 keeps the FIRST occurrence's subtree. Future work could pick the
 * occurrence whose neighbours match the largest fraction of segments, or
 * crossfade subtle variants — but for fixed site chrome the first occurrence
 * is already what consumers see at scrollY=0.
 */
export function dedupeFixedAcrossSegments(perSegment: CapturedElement[][]): CapturedElement[] {
  const seen = new Map<string, CapturedElement>();
  for (const seg of perSegment) {
    for (const el of seg) {
      const key = fixedKey(el);
      if (!seen.has(key)) seen.set(key, el);
    }
  }
  return [...seen.values()];
}

function fixedKey(el: CapturedElement): string {
  return `${el.tag}|${Math.round(el.x)},${Math.round(el.y)}|${Math.round(el.width)}x${Math.round(el.height)}`;
}
