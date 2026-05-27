/**
 * Magic-move transition composer — phase 1 of the Keynote-style magic-move
 * transition (DM-898 / DM-112; spec in `docs/53-magic-move-transition.md`).
 *
 * Builds the "bridge" layer shown during a magic-move transition window: a
 * single composite, rendered from the NEXT frame's element tree, in which
 *   - elements that MOVED between the two frames (diff `translated`) slide from
 *     their previous position to their next one,
 *   - elements only in the NEXT frame (`added`) fade in,
 *   - elements only in the PREV frame (`removed`) — appended from the prev tree
 *     — fade out,
 *   - everything else (`static` / `modified`) renders in place.
 * At the window's start the composite matches the PREV frame's final state, and
 * at its end the NEXT frame's initial state, so the animator hard-cuts the prev
 * frame out at hold-end and the next frame in at the window end with no visible
 * jump (see `generateAnimatedSvg`'s magic-move branch).
 *
 * Rendering happens HERE (caller-side) rather than inside the animator because
 * the glyph/font `<defs>` are accumulated globally during rendering and emitted
 * once by the caller BEFORE `generateAnimatedSvg` runs — re-rendering inside the
 * animator would reference glyphs missing from the already-finalized defs. (This
 * refines the original "animator re-renders" sketch in docs/53.)
 *
 * v1 scope (DM-898): translate only. Size/style morph is DM-899; `data-magic-key`
 * author pairing is DM-900; reduced-motion + deeper nesting hardening is DM-901.
 */

import type { CapturedElement } from "../capture/types.js";
import { diffTrees, entriesOfKind } from "../tree-ops/tree-diff.js";

/** One element that slides during the transition. `(dx, dy)` is the
 *  prev→next shift (`next.x − prev.x`); the element renders at its next
 *  position and the animator interpolates `translate(−dx, −dy) → (0, 0)`. */
export interface MagicMoveSlide {
  /** CSS class the renderer stamped on the element (`anim-<id>`). */
  cls: string;
  dx: number;
  dy: number;
}

export interface MagicMove {
  /** Composite SVG markup shown for the transition window (no XML preamble). */
  compositeSvg: string;
  /** Elements that translate prev→next. */
  slides: MagicMoveSlide[];
  /** Classes that fade in over the window (`added`). */
  fadeIn: string[];
  /** Classes that fade out over the window (`removed`). */
  fadeOut: string[];
}

function asRoots(t: CapturedElement | CapturedElement[]): CapturedElement[] {
  return Array.isArray(t) ? t : [t];
}

/** Resolve a tree path (`[rootIdx, childIdx, …]`, per `diffTrees`) to its element. */
function elementAtPath(roots: CapturedElement[], path: number[]): CapturedElement | null {
  let el: CapturedElement | undefined = roots[path[0]];
  for (let i = 1; i < path.length && el != null; i++) el = el.children?.[path[i]];
  return el ?? null;
}

/** True iff `a` is a strict prefix of `b` (i.e. `a` is an ancestor path of `b`). */
function isAncestorPath(a: number[], b: number[]): boolean {
  if (a.length >= b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Build the magic-move bridge layer between two captured trees. Returns `null`
 * when there is nothing worth animating (no moved / added / removed elements) —
 * the caller then falls back to `crossfade`.
 *
 * `render` turns a list of element roots into SVG markup (the caller passes a
 * thin `elementTreeToSvg(roots, W, H, prefix, …)` wrapper); injecting it keeps
 * this module renderer-agnostic and unit-testable.
 */
export function buildMagicMove(
  prevTree: CapturedElement | CapturedElement[],
  nextTree: CapturedElement | CapturedElement[],
  render: (roots: CapturedElement[], idPrefix: string) => string,
  idPrefix: string,
): MagicMove | null {
  const prevRoots = asRoots(prevTree);
  const nextRoots = asRoots(nextTree);
  const diff = diffTrees(prevRoots, nextRoots);

  const translated = entriesOfKind(diff, "translated");
  const added = entriesOfKind(diff, "added");
  const removed = entriesOfKind(diff, "removed");

  // Only animate the HIGHEST translated ancestor of each moved subtree: when a
  // card and its children all shift by the same delta the diff reports every
  // node as `translated`, but the ancestor's slide already carries its
  // descendants — animating each would translate the children twice. Keep a
  // translated entry only when no other translated entry is its ancestor.
  const translatedPaths = translated
    .map((e) => e.nextPath)
    .filter((p): p is number[] => p != null);
  const rootMovers = translated.filter((e) => {
    if (e.nextPath == null || e.dx == null || e.dy == null) return false;
    if (Math.round(e.dx) === 0 && Math.round(e.dy) === 0) return false;
    return !translatedPaths.some((p) => isAncestorPath(p, e.nextPath!));
  });

  if (rootMovers.length === 0 && added.length === 0 && removed.length === 0) {
    return null; // nothing to magic-move → caller uses crossfade
  }

  // Clone the next tree so the `animId` annotations we add for the composite
  // don't leak into the next frame's own (already-rendered / to-be-rendered)
  // blob. CapturedElement is plain data, so structuredClone is a safe deep copy.
  const compositeNext = nextRoots.map((r) => structuredClone(r));

  const slides: MagicMoveSlide[] = [];
  let n = 0;
  for (const e of rootMovers) {
    const el = elementAtPath(compositeNext, e.nextPath!);
    if (el == null) continue;
    const id = `${idPrefix}mv${n++}`;
    el.animId = id;
    slides.push({ cls: `anim-${id}`, dx: e.dx!, dy: e.dy! });
  }

  const fadeIn: string[] = [];
  let a = 0;
  for (const e of added) {
    if (e.nextPath == null) continue;
    const el = elementAtPath(compositeNext, e.nextPath);
    if (el == null) continue;
    const id = `${idPrefix}in${a++}`;
    el.animId = id;
    fadeIn.push(`anim-${id}`);
  }

  // Removed elements aren't in the next tree — append their prev subtrees (at
  // their prev coordinates) so they render where the prev frame had them, and
  // fade them out. Skip a removed entry nested inside another removed subtree
  // (its ancestor already carries it).
  const removedPaths = removed.map((e) => e.prevPath).filter((p): p is number[] => p != null);
  const extraRoots: CapturedElement[] = [];
  const fadeOut: string[] = [];
  let o = 0;
  for (const e of removed) {
    if (e.prevPath == null || e.prev == null) continue;
    if (removedPaths.some((p) => isAncestorPath(p, e.prevPath!))) continue;
    const clone = structuredClone(e.prev);
    const id = `${idPrefix}out${o++}`;
    clone.animId = id;
    extraRoots.push(clone);
    fadeOut.push(`anim-${id}`);
  }

  const compositeSvg = render([...compositeNext, ...extraRoots], idPrefix);
  return { compositeSvg, slides, fadeIn, fadeOut };
}
