/**
 * Element-tree diff (DM-606, design from DM-604).
 *
 * Best-effort heuristic diff between two `CapturedElement` trees. Produces a
 * per-element classification used by the scroll-segment composer (DM-608) to
 * pick the right animation per element: translate for matched-and-shifted,
 * crossfade for added/removed, animated property change for matched-and-
 * modified.
 *
 * Per DM-604 directive: *"the diff itself should be best-effort using the
 * same kind of heuristics a code diffing tool would use"*. Two-pass matcher:
 *
 *   Pass 1 (content fingerprint): walk both trees, hash each element by
 *     `(tag, text, children-fingerprints)`. Identical fingerprints between
 *     trees are matched in document order. bbox delta → static / translated.
 *
 *   Pass 2 (path fallback): among unmatched, match by tree-position path +
 *     same tag → modified.
 *
 *   Pass 3 (leftovers): anything still unmatched is added (only in next) or
 *     removed (only in prev).
 *
 * The composer uses these classifications to decide visual treatment. Match
 * confidence isn't reported in v1 — the heuristics are deliberately simple;
 * we can layer scoring on later if needed.
 */

import type { CapturedElement } from "../capture/types.js";

export type DiffEntryKind =
  | "static"      // matched, bbox identical (within tolerance)
  | "translated"  // matched, bbox shifted by (dx, dy)
  | "modified"    // matched by path + tag, content/styles differ
  | "added"       // only in `next`
  | "removed";    // only in `prev`

export interface DiffEntry {
  kind: DiffEntryKind;
  /** Tree path in `prev`. Undefined for `added`. */
  prevPath?: number[];
  /** Tree path in `next`. Undefined for `removed`. */
  nextPath?: number[];
  /** The captured element in `prev`. Undefined for `added`. */
  prev?: CapturedElement;
  /** The captured element in `next`. Undefined for `removed`. */
  next?: CapturedElement;
  /** Bbox shift, in viewport pixels. Only populated for `translated`. */
  dx?: number;
  dy?: number;
}

export interface TreeDiff {
  entries: DiffEntry[];
}

/** Sub-pixel drift below this magnitude (px) counts as `static`, not
 *  `translated`. Shared with magic-move's rect-change detection (DM-1073). */
export const BBOX_TOLERANCE = 0.5;

/**
 * Diff two captured-element trees. Either argument may be a single root or
 * an array of sibling roots (`captureElementTree` returns the latter).
 *
 * The diff is computed in document (pre-order) traversal order. Paths are
 * arrays of child-indices from the root list, e.g. `[0, 2, 1]` is the
 * second child of the third child of the first root.
 */
export function diffTrees(
  prev: CapturedElement | CapturedElement[],
  next: CapturedElement | CapturedElement[],
): TreeDiff {
  const prevRoots = Array.isArray(prev) ? prev : [prev];
  const nextRoots = Array.isArray(next) ? next : [next];

  const prevList = flatten(prevRoots, []);
  const nextList = flatten(nextRoots, []);

  // ── Pass 1: content fingerprint matching ─────────────────────────────────
  // Build a fingerprint → ordered list of prev entries, then walk `next` in
  // document order and consume the first unmatched candidate per fingerprint.
  // This naturally pairs elements in document order when there are duplicates
  // (e.g. a list of N identical rows).
  const prevByFingerprint = new Map<string, FlatEntry[]>();
  for (const fe of prevList) {
    const fp = capturedElementFingerprint(fe.el);
    if (!prevByFingerprint.has(fp)) prevByFingerprint.set(fp, []);
    prevByFingerprint.get(fp)!.push(fe);
  }

  // Cursors into each fingerprint bucket to advance through duplicates in order.
  const prevCursor = new Map<string, number>();

  const matchedPrev = new Set<string>();
  const matchedNext = new Set<string>();
  const entries: DiffEntry[] = [];

  for (const ne of nextList) {
    const fp = capturedElementFingerprint(ne.el);
    const bucket = prevByFingerprint.get(fp);
    if (bucket == null || bucket.length === 0) continue;
    const start = prevCursor.get(fp) ?? 0;
    let chosen: FlatEntry | null = null;
    let chosenIdx = -1;
    for (let i = start; i < bucket.length; i++) {
      if (!matchedPrev.has(pathKey(bucket[i].path))) {
        chosen = bucket[i];
        chosenIdx = i;
        break;
      }
    }
    if (chosen == null) continue;
    prevCursor.set(fp, chosenIdx + 1);
    matchedPrev.add(pathKey(chosen.path));
    matchedNext.add(pathKey(ne.path));
    const dx = ne.el.x - chosen.el.x;
    const dy = ne.el.y - chosen.el.y;
    const kind: DiffEntryKind =
      Math.abs(dx) <= BBOX_TOLERANCE && Math.abs(dy) <= BBOX_TOLERANCE
        ? "static"
        : "translated";
    entries.push({ kind, prevPath: chosen.path, nextPath: ne.path, prev: chosen.el, next: ne.el, dx, dy });
  }

  // ── Pass 2: path + tag fallback (modified) ────────────────────────────────
  // For each remaining `next` element, look for an unmatched `prev` element
  // at the EXACT same path with the SAME tag — and additionally require that
  // text matches (or both texts are empty) OR animId matches. This catches
  // the "same logical element, style or sub-tree changed" case while
  // refusing to falsely match two unrelated elements that happened to land at
  // the same tree position (e.g. an `<li>Drop</li>` replaced by an
  // `<li>New</li>`; those should be add + remove, not modified).
  const prevByPath = new Map<string, FlatEntry>();
  for (const fe of prevList) {
    if (!matchedPrev.has(pathKey(fe.path))) prevByPath.set(pathKey(fe.path), fe);
  }
  for (const ne of nextList) {
    const key = pathKey(ne.path);
    if (matchedNext.has(key)) continue;
    const pe = prevByPath.get(key);
    if (pe == null) continue;
    if (pe.el.tag !== ne.el.tag) continue;
    const textEqual = (pe.el.text ?? "") === (ne.el.text ?? "");
    const animEqual = pe.el.animId != null && pe.el.animId !== "" && pe.el.animId === ne.el.animId;
    if (!textEqual && !animEqual) continue;
    matchedPrev.add(key);
    matchedNext.add(key);
    entries.push({ kind: "modified", prevPath: pe.path, nextPath: ne.path, prev: pe.el, next: ne.el });
  }

  // ── Pass 3: leftovers → added / removed ──────────────────────────────────
  for (const fe of prevList) {
    if (!matchedPrev.has(pathKey(fe.path))) {
      entries.push({ kind: "removed", prevPath: fe.path, prev: fe.el });
    }
  }
  for (const fe of nextList) {
    if (!matchedNext.has(pathKey(fe.path))) {
      entries.push({ kind: "added", nextPath: fe.path, next: fe.el });
    }
  }

  return { entries };
}

interface FlatEntry {
  el: CapturedElement;
  path: number[];
}

function flatten(roots: CapturedElement[], pathPrefix: number[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (let i = 0; i < roots.length; i++) {
    const path = pathPrefix.concat(i);
    out.push({ el: roots[i], path });
    const children = roots[i].children;
    if (children != null && children.length > 0) {
      const childEntries = flatten(children, path);
      for (const ce of childEntries) out.push(ce);
    }
  }
  return out;
}

function pathKey(path: number[]): string {
  return path.join(".");
}

/**
 * Structural fingerprint: tag + text + child fingerprints (joined). Bbox is
 * deliberately NOT part of the fingerprint — that's how we detect "same
 * element, translated". `animId` IS part of the fingerprint when present,
 * since it's the user's explicit "this is the same element across captures"
 * hint and we want it to dominate over coincidental text matches.
 */
function capturedElementFingerprint(el: CapturedElement): string {
  const childFP = (el.children ?? []).map(capturedElementFingerprint).join("|");
  const animPart = el.animId != null && el.animId !== "" ? `@${el.animId}` : "";
  return `${el.tag}${animPart}:${el.text ?? ""}:[${childFP}]`;
}

/**
 * Convenience: filter a diff to entries of specific kinds. Useful in the
 * composer when emitting per-kind animations.
 */
export function entriesOfKind(diff: TreeDiff, ...kinds: DiffEntryKind[]): DiffEntry[] {
  const kindSet = new Set(kinds);
  return diff.entries.filter((e) => kindSet.has(e.kind));
}

/**
 * Detect a uniform translate across most matched entries. Returns
 * `{ dx, dy, fraction }` where `fraction` is the share of matched-translated
 * entries that all moved by the same `(dx, dy)` (within `BBOX_TOLERANCE`).
 * Useful for the composer: when fraction ≈ 1, the whole subtree shifted as a
 * unit and the composer can apply a single group-level `translate` instead of
 * per-element keyframes.
 */
export function dominantTranslate(diff: TreeDiff): { dx: number; dy: number; fraction: number } | null {
  const movers = diff.entries.filter((e): e is DiffEntry & { dx: number; dy: number } =>
    e.kind === "translated" && typeof e.dx === "number" && typeof e.dy === "number",
  );
  if (movers.length === 0) return null;
  // Bucket by rounded (dx, dy) and pick the largest bucket.
  const buckets = new Map<string, { dx: number; dy: number; n: number }>();
  for (const m of movers) {
    const key = `${Math.round(m.dx)},${Math.round(m.dy)}`;
    const b = buckets.get(key);
    if (b == null) buckets.set(key, { dx: m.dx, dy: m.dy, n: 1 });
    else b.n++;
  }
  let best: { dx: number; dy: number; n: number } | null = null;
  for (const v of buckets.values()) {
    if (best == null || v.n > best.n) best = v;
  }
  if (best == null) return null;
  return { dx: best.dx, dy: best.dy, fraction: best.n / movers.length };
}
