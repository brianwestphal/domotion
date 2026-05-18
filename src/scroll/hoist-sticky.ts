/**
 * DM-647: hoist `position: sticky` elements out of per-segment captures
 * during the segments where they're actually pinned to the viewport.
 *
 * Sticky elements behave like in-flow content until scrolling crosses their
 * container's stick-edge — after which they pin to the viewport like
 * `position: fixed`. In a multi-segment scroll capture we want:
 *   - in-flow segments → element stays inline (scrolls with content as today)
 *   - stuck segments  → element renders once on the viewport overlay, with
 *                       a visibility keyframe gating it to those segments
 *
 * Detection is empirical, per `docs/35-scroll-sticky-hoisting.md`: a sticky
 * candidate captured at the same viewport-y across ≥2 consecutive segments
 * is "stuck" for that run. This avoids re-doing Chromium's stick-edge math
 * and matches the painted output that the composer is already trying to
 * reproduce.
 *
 * Cross-segment identity uses `(tag, rounded width/height, path-in-tree)`.
 * Path-in-tree is computed in this module (a list of child-indexes per
 * ancestor down to the root), so no new field is bolted onto
 * `CapturedElement`.
 */

import type { CapturedElement } from "../capture/types.js";

export interface StickyOverlay {
  /** The sticky subtree (captured at the FIRST segment in the stuck window). */
  subtree: CapturedElement;
  /** First segment index (inclusive) where this element is stuck. */
  firstSegmentIdx: number;
  /** Last segment index (inclusive) where this element is stuck. */
  lastSegmentIdx: number;
  /** Cross-segment identity key (mostly useful for tests / debugging). */
  key: string;
}

interface StickyCandidate {
  key: string;
  segmentIdx: number;
  node: CapturedElement;
  /** Path from the segment-tree roots to this node. */
  path: number[];
}

/** Tolerance for "same viewport-y" when classifying stuck-segment runs (px). */
const STICK_EPSILON = 1.0;

/**
 * Find all sticky candidates across segments, compute stuck windows, strip
 * the stuck-window occurrences out of the per-segment trees, and return
 * a list of overlay entries (one per stuck window per sticky element).
 *
 * Stuck-window criterion: ≥2 consecutive segments where the same sticky
 * element (matched by identity key) has `|y_i+1 − y_i| < 1 px`.
 */
export function extractStickyWindows(segmentTrees: CapturedElement[][]): {
  stripped: CapturedElement[][];
  overlays: StickyOverlay[];
} {
  // 1) Collect sticky candidates per segment, with their path-in-tree.
  const candidatesByKey = new Map<string, StickyCandidate[]>();
  for (let segIdx = 0; segIdx < segmentTrees.length; segIdx++) {
    walkCollect(segmentTrees[segIdx], [], segIdx, candidatesByKey);
  }

  // 2) For each unique sticky element, scan its per-segment occurrences for
  //    stuck windows (runs of consecutive segments where viewport-y is
  //    constant within STICK_EPSILON).
  const overlays: StickyOverlay[] = [];
  const strikeSet = new Map<number, Set<string>>(); // segmentIdx → set of paths to remove
  const markStrike = (segIdx: number, path: number[]): void => {
    let s = strikeSet.get(segIdx);
    if (s == null) { s = new Set(); strikeSet.set(segIdx, s); }
    s.add(path.join(","));
  };

  for (const [key, occurrences] of candidatesByKey) {
    occurrences.sort((a, b) => a.segmentIdx - b.segmentIdx);
    // Walk pairwise; a stuck window is a maximal run of consecutive segments
    // (segmentIdx strictly +1 each step) with |Δy| < STICK_EPSILON.
    let runStart = -1;
    for (let i = 0; i < occurrences.length; i++) {
      const cur = occurrences[i];
      const prev = i > 0 ? occurrences[i - 1] : null;
      const continuesRun = prev != null
        && cur.segmentIdx === prev.segmentIdx + 1
        && Math.abs(cur.node.y - prev.node.y) < STICK_EPSILON;
      if (continuesRun) {
        if (runStart === -1) runStart = i - 1;
      } else {
        if (runStart !== -1) {
          // close the run that ended at i - 1
          flushRun(key, occurrences, runStart, i - 1, overlays, markStrike);
          runStart = -1;
        }
      }
    }
    if (runStart !== -1) {
      flushRun(key, occurrences, runStart, occurrences.length - 1, overlays, markStrike);
    }
  }

  // 3) Strip the stuck-window occurrences from the per-segment trees.
  const stripped: CapturedElement[][] = segmentTrees.map((tree, segIdx) => {
    const strikes = strikeSet.get(segIdx);
    if (strikes == null || strikes.size === 0) return tree;
    return removeAtPaths(tree, strikes);
  });

  return { stripped, overlays };
}

function flushRun(
  key: string,
  occurrences: StickyCandidate[],
  startIdx: number,
  endIdx: number,
  overlays: StickyOverlay[],
  markStrike: (segIdx: number, path: number[]) => void,
): void {
  const first = occurrences[startIdx];
  const last = occurrences[endIdx];
  overlays.push({
    subtree: first.node,
    firstSegmentIdx: first.segmentIdx,
    lastSegmentIdx: last.segmentIdx,
    key,
  });
  // Strike every occurrence inside the window from its segment's tree.
  for (let i = startIdx; i <= endIdx; i++) {
    markStrike(occurrences[i].segmentIdx, occurrences[i].path);
  }
}

function walkCollect(
  list: CapturedElement[],
  parentPath: number[],
  segIdx: number,
  out: Map<string, StickyCandidate[]>,
): void {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    const path = parentPath.concat(i);
    if (node.styles?.position === "sticky") {
      const key = identityKey(node, path);
      let bucket = out.get(key);
      if (bucket == null) { bucket = []; out.set(key, bucket); }
      bucket.push({ key, segmentIdx: segIdx, node, path });
      // Do NOT recurse into a sticky element's descendants — they ride
      // along inside the hoisted subtree. A nested sticky-within-sticky
      // element would need stick-edge math relative to its parent's
      // stuck position; the current empirical detector reads viewport-y
      // and would incorrectly classify the inner element on its own.
      // See `docs/35-scroll-sticky-hoisting.md` ("Out of scope: sticky
      // inside a transformed/scrollable ancestor").
      continue;
    }
    if (node.children != null && node.children.length > 0) {
      walkCollect(node.children, path, segIdx, out);
    }
  }
}

function identityKey(node: CapturedElement, path: number[]): string {
  return `${node.tag}|${Math.round(node.width)}x${Math.round(node.height)}|${path.join(".")}`;
}

/** Build a shallow-copied tree with the nodes at the given paths removed. */
function removeAtPaths(tree: CapturedElement[], strikePaths: Set<string>): CapturedElement[] {
  function recur(list: CapturedElement[], parentPath: number[]): CapturedElement[] {
    const out: CapturedElement[] = [];
    for (let i = 0; i < list.length; i++) {
      const path = parentPath.concat(i);
      if (strikePaths.has(path.join(","))) {
        // Drop this subtree entirely.
        continue;
      }
      const node = list[i];
      if (node.children != null && node.children.length > 0) {
        const newKids = recur(node.children, path);
        if (newKids !== node.children) {
          out.push({ ...node, children: newKids });
          continue;
        }
      }
      out.push(node);
    }
    // Return same reference when nothing changed at this level.
    if (out.length === list.length && out.every((n, i) => n === list[i])) return list;
    return out;
  }
  return recur(tree, []);
}
