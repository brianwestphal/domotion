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

/** One element that slides during the transition. The animator interpolates
 *  `transform: <from> → <to>` over the window. A `translate(dx,dy)` for a pure
 *  move, the full `translate · scale · translate` affine for a size change
 *  (DM-899). The next-appearance copy goes `<prev-rect map> → none`; a prev-
 *  appearance copy in a cross-fade pair goes `none → <next-rect map>` so both
 *  copies trace the same prev→next path while their opacities swap (DM-903). */
export interface MagicMoveSlide {
  /** CSS class the renderer stamped on the element (`anim-<id>`). */
  cls: string;
  /** CSS transform at the window start. */
  from: string;
  /** CSS transform at the window end (`"none"` for the next-appearance copy). */
  to: string;
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

/**
 * CSS `transform` that maps an element rendered at its NEXT rect back onto its
 * PREV rect — the window-start state the animator interpolates away to `none`.
 * The element's painted geometry sits at next-space coordinates, so the affine
 * is `translate(prevOrigin) · scale(prevSize/nextSize) · translate(-nextOrigin)`
 * (prepend-translate to next origin, scale about it, then place at prev origin).
 * Pure moves (size unchanged) collapse to a single `translate(dx, dy)` for
 * smaller, more legible output; a zero next-dimension can't be scaled, so it
 * also falls back to translate-only.
 */
function rectMapTransform(
  prev: { x: number; y: number; width: number; height: number },
  next: { x: number; y: number; width: number; height: number },
): string {
  const sizeChanged = Math.abs(prev.width - next.width) > 0.5 || Math.abs(prev.height - next.height) > 0.5;
  if (!sizeChanged || next.width <= 0 || next.height <= 0) {
    return `translate(${r(prev.x - next.x)}px, ${r(prev.y - next.y)}px)`;
  }
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  return `translate(${r(prev.x)}px, ${r(prev.y)}px) scale(${r5(sx)}, ${r5(sy)}) translate(${r(-next.x)}px, ${r(-next.y)}px)`;
}

/** Round to 2dp (px positions) / 5dp (scale factors), trimming trailing zeros. */
function r(n: number): number { return Number(n.toFixed(2)); }
function r5(n: number): number { return Number(n.toFixed(5)); }

/** True iff `a` is a strict prefix of `b` (i.e. `a` is an ancestor path of `b`). */
function isAncestorPath(a: number[], b: number[]): boolean {
  if (a.length >= b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A matched element that animates between frames. */
interface Mover {
  nextPath: number[];
  prev: CapturedElement;
  next: CapturedElement;
}

/**
 * Collect every element carrying a `data-magic-key` (`el.magicKey`), keyed by
 * the attribute value, with its tree path (`[rootIdx, childIdx, …]`, matching
 * `diffTrees`). First occurrence per key wins — a duplicate key within one
 * frame is author error; we pair the first. (DM-900)
 */
function collectKeyed(roots: CapturedElement[]): Map<string, { el: CapturedElement; path: number[] }> {
  const out = new Map<string, { el: CapturedElement; path: number[] }>();
  const walk = (el: CapturedElement, path: number[]): void => {
    const k = el.magicKey;
    if (k != null && k !== "" && !out.has(k)) out.set(k, { el, path });
    const kids = el.children ?? [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], [...path, i]);
  };
  for (let i = 0; i < roots.length; i++) walk(roots[i], [i]);
  return out;
}

/**
 * True iff a matched element's PAINT changed between frames — text content or
 * a visible style (`color` / `backgroundColor` / `borderColor` / `borderTopColor`
 * / `opacity`). Gates the DM-903 dual-render cross-fade: geometry-only movers
 * (same paint, just moved/resized) keep a single copy; paint-changed movers
 * render prev + next appearances and cross-fade. The fingerprint matcher keys
 * on (tag, text, children) not style, so a recolored-but-moved element stays
 * `translated` — style equality has to be checked here, not read off the kind.
 */
function appearanceChanged(prev: CapturedElement, next: CapturedElement): boolean {
  if ((prev.text ?? "") !== (next.text ?? "")) return true;
  const p = prev.styles;
  const q = next.styles;
  if (p == null || q == null) return false;
  return p.color !== q.color
    || (p.backgroundColor ?? "") !== (q.backgroundColor ?? "")
    || (p.borderColor ?? "") !== (q.borderColor ?? "")
    || (p.borderTopColor ?? "") !== (q.borderTopColor ?? "")
    || p.opacity !== q.opacity;
}

/** True iff the two rects differ in origin or size beyond the diff tolerance. */
function rectChanged(
  p: { x: number; y: number; width: number; height: number },
  q: { x: number; y: number; width: number; height: number },
): boolean {
  return Math.abs(q.x - p.x) > 0.5 || Math.abs(q.y - p.y) > 0.5
    || Math.abs(q.width - p.width) > 0.5 || Math.abs(q.height - p.height) > 0.5;
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

  // DM-900: author `data-magic-key` force-pairs the same logical element across
  // frames AHEAD of the fingerprint heuristic. A key present in BOTH trees is a
  // forced mover that supersedes whatever diffTrees decided for those elements
  // (the heuristic may have mis-paired them, or — when their content changed —
  // split them into add + remove, which would cross-fade instead of slide).
  const prevKeyed = collectKeyed(prevRoots);
  const nextKeyed = collectKeyed(nextRoots);
  const keyedMovers: Mover[] = [];
  const keyedNextPaths = new Set<string>();
  const keyedPrevPaths = new Set<string>();
  for (const [key, nx] of nextKeyed) {
    const pv = prevKeyed.get(key);
    if (pv == null) continue; // key only in next → genuinely added; leave to heuristic
    keyedMovers.push({ nextPath: nx.path, prev: pv.el, next: nx.el });
    keyedNextPaths.add(nx.path.join(","));
    keyedPrevPaths.add(pv.path.join(","));
  }

  // Heuristic movers: any element matched by diffTrees (static / translated /
  // modified all carry prev + next) whose rect changed in ORIGIN or SIZE —
  // re-derived from the rects since diffTrees keys its kind on origin only and
  // size isn't in its fingerprint (a grow-in-place lands as `static`). Skip
  // elements a key already claimed.
  const heuristicMovers: Mover[] = entriesOfKind(diff, "static", "translated", "modified")
    .filter((e) => e.nextPath != null && e.prev != null && e.next != null
      && !keyedNextPaths.has(e.nextPath.join(","))
      && rectChanged(e.prev, e.next))
    .map((e) => ({ nextPath: e.nextPath!, prev: e.prev!, next: e.next! }));

  // Keyed pairs animate only when their rect actually changed (a keyed but
  // unmoved element is just static — the key still guaranteed the pairing).
  const allMovers = [...keyedMovers.filter((m) => rectChanged(m.prev, m.next)), ...heuristicMovers];

  // Only animate the HIGHEST moved ancestor of each changed subtree: when a
  // card moves/grows the diff reports every descendant as changed too, but the
  // ancestor's transform already carries them — animating each would
  // double-apply. Keep a mover only when no other mover is its ancestor.
  const allMoverPaths = allMovers.map((m) => m.nextPath);
  const rootMovers = allMovers.filter(
    (m) => !allMoverPaths.some((p) => isAncestorPath(p, m.nextPath)),
  );

  // Added / removed, minus anything a key force-paired (those slide, not fade).
  const added = entriesOfKind(diff, "added")
    .filter((e) => e.nextPath == null || !keyedNextPaths.has(e.nextPath.join(",")));
  const removed = entriesOfKind(diff, "removed")
    .filter((e) => e.prevPath == null || !keyedPrevPaths.has(e.prevPath.join(",")));

  if (rootMovers.length === 0 && added.length === 0 && removed.length === 0) {
    return null; // nothing to magic-move → caller uses crossfade
  }

  // Clone the next tree so the `animId` annotations we add for the composite
  // don't leak into the next frame's own (already-rendered / to-be-rendered)
  // blob. CapturedElement is plain data, so structuredClone is a safe deep copy.
  const compositeNext = nextRoots.map((r) => structuredClone(r));

  const slides: MagicMoveSlide[] = [];
  const fadeIn: string[] = [];
  const fadeOut: string[] = [];
  // Prev-appearance copies + removed subtrees, appended after the next tree so
  // they render at their prev coordinates.
  const extraRoots: CapturedElement[] = [];

  let n = 0;
  for (const m of rootMovers) {
    const el = elementAtPath(compositeNext, m.nextPath);
    if (el == null) continue;
    const nextId = `${idPrefix}mv${n++}`;
    el.animId = nextId;
    // Next-appearance copy: slide from the prev rect to its final next rect.
    slides.push({ cls: `anim-${nextId}`, from: rectMapTransform(m.prev, m.next), to: "none" });

    // DM-903: when the element's PAINT also changed (text / color / background
    // / border / opacity), a single next-appearance copy would snap the new
    // look on at the window start. Render a SECOND copy at the PREV appearance,
    // co-moving along the same prev→next path, and cross-fade — prev fades out,
    // next fades in. Geometry-only movers keep the cheaper single copy (nothing
    // to cross-fade). The SVG children carry baked-in fills a wrapper can't
    // restyle, so dual-render + cross-fade is how the paint morph is expressed.
    if (appearanceChanged(m.prev, m.next)) {
      fadeIn.push(`anim-${nextId}`);
      const prevClone = structuredClone(m.prev);
      const prevId = `${nextId}p`;
      prevClone.animId = prevId;
      extraRoots.push(prevClone);
      // Prev copy renders at its prev rect; map it FORWARD onto the next rect
      // (rectMapTransform with args swapped) so it traces the same path as the
      // next copy while fading out.
      slides.push({ cls: `anim-${prevId}`, from: "none", to: rectMapTransform(m.next, m.prev) });
      fadeOut.push(`anim-${prevId}`);
    }
  }

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
