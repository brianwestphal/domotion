//
// Source-owned pixel-snapped border paint rectangle (CAPTURE_SCRIPT side).
//
// Blink paints box decorations from `ContouredBorderGeometry::
// PixelSnappedContouredBorder(style, paint_rect)` (Chromium 7d859f27,
// core/paint/contoured_border_geometry.cc:178-185), i.e. from
// `ToPixelSnappedRect(paint_rect)` (core/layout/geometry/physical_rect.h:228):
// the offset is `LayoutUnit::Round()`ed and each size is
// `SnapSizeToPixel(size, offset)` (platform/geometry/layout_unit.h:805-813).
// That snap happens in the box's LOCAL paint space, before any transform or
// scroll translation is applied — so the captured viewport rect is not the
// right input whenever a fractional translation sits between the two spaces.
//
// Local paint offsets keep their fractional part ("subpixel accumulation")
// through every PaintOffsetTranslation whose transform is identity or a pure
// translation (`UpdateForPaintOffsetTranslation` and
// `CanPropagateSubpixelAccumulation`, core/paint/paint_property_tree_builder.cc
// :652-779). Scroll offsets are applied as a separate ScrollTranslation node
// (`UpdateScrollTranslation`, :3556-3564), again after the snap. So when every
// element in the composed ancestor chain has an identity or pure 2D
// translation transform and every scroller's offset is integral, the local
// paint rect equals the captured viewport rect minus the summed translations,
// up to whole pixels — the only thing snapping depends on. A static transform
// the walk freezes (captured untransformed, re-applied by the renderer as a
// wrapper) contributes nothing here: the rect is already in its local space.
// The box's own transform never matters (its border snaps at its rounded
// paint offset either way); a frozen non-translation ANCESTOR does, because
// Blink drops the subpixel accumulation beneath it.
//
// Everything outside that proof fails closed (no record; the renderer keeps
// the captured geometry): live scale/rotate/skew/3D transforms, frozen
// non-translation ancestor transforms, `offset-path`,
// `will-change` transform-family properties (they discard subpixel
// accumulation, `kPreventingSubpixelAccumulationReasons`), paint or
// style+layout containment and `content-visibility` (they reset the paint
// offset, `NeedsIsolationNodes`, :570-589), sticky positioning (its own
// translation node), fractional scroll offsets, a non-unit device pixel ratio,
// or pinch zoom.
//
// CSS zoom keeps the proof: Blink lays out and snaps in zoomed LayoutUnits, and
// under standardized zoom getBoundingClientRect divides only by the frame's
// layout zoom factor (AdjustRectMaybeExcludingCSSZoom,
// core/layout/adjust_for_absolute_zoom.h), so the captured rect is already in
// that zoomed space. Computed translations and scrollLeft/scrollTop serialize
// unzoomed, so each is multiplied by its element's effective zoom here.
//
// The record is relative to the captured border box (edge deltas), so any
// later whole-tree translation of the captured coordinates keeps it valid.
// Self-contained: this runs inside the page via CAPTURE_SCRIPT.

import type { CapturedBorderPaintSnap } from "../../types.js";

/**
 * Frozen transforms whose subtree is being captured: `{x, y}` holds the box's
 * untransformed viewport origin on each axis that drops the subpixel
 * accumulation (null where it propagates); "unauthenticated" when that
 * transform's own paint offset could not be established.
 */
const frozenPaintBases = new WeakMap<Element, { x: number | null; y: number | null } | "unauthenticated">();
const frozenPaintShifts = new WeakMap<Element, { x: number; y: number }>();

const composedParent = (node: Element): Element | null => {
  const slot = (node as HTMLElement).assignedSlot;
  if (slot != null) return slot;
  if (node.parentElement != null) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/** Pure 2D translation of one element's effective transform, or null. */
const pureTranslation = (cs: CSSStyleDeclaration): { x: number; y: number } | null => {
  const parts = [cs.transform, cs.translate, cs.rotate, cs.scale];
  if (parts.every((value) => value == null || value === "" || value === "none")) return { x: 0, y: 0 };
  if (cs.rotate !== "none" && cs.rotate !== "") return null;
  if (cs.scale !== "none" && cs.scale !== "") return null;
  let x = 0,
    y = 0;
  if (cs.translate !== "none" && cs.translate !== "") {
    // A computed percentage translate is not resolved to px; fail closed.
    if (cs.translate.indexOf("%") >= 0) return null;
    const ts = cs.translate.split(/\s+/).map((v) => parseFloat(v));
    if (ts.length > 2 && ts[2] !== 0) return null;
    if (!isFinite(ts[0])) return null;
    x += ts[0];
    y += ts.length > 1 && isFinite(ts[1]) ? ts[1] : 0;
  }
  if (cs.transform !== "none" && cs.transform !== "") {
    let m: DOMMatrix;
    try {
      m = new DOMMatrix(cs.transform);
    } catch {
      return null;
    }
    if (!m.is2D || m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return null;
    x += m.e;
    y += m.f;
  }
  return { x, y };
};

const isolatesPaintOffset = (cs: CSSStyleDeclaration): boolean => {
  const contain = cs.contain ?? "none";
  if (/\b(paint|strict|content)\b/.test(contain)) return true;
  if (/\bstyle\b/.test(contain) && /\blayout\b/.test(contain)) return true;
  const visibility = (cs as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility;
  return visibility != null && visibility !== "" && visibility !== "visible";
};

const preventsSubpixelAccumulation = (cs: CSSStyleDeclaration): boolean =>
  /\b(transform|translate|scale|rotate)\b/.test(cs.willChange ?? "auto");

/**
 * Which axes keep the subpixel accumulation through a transform
 * (`CanPropagateSubpixelAccumulation`, paint_property_tree_builder.cc:652-686):
 * both for identity or a translation, per axis for a scale-or-translation
 * (only where the scale is 1), neither otherwise or under a `will-change`
 * transform-family property (`kPreventingSubpixelAccumulationReasons`).
 */
export const subpixelPropagation = (transform: string, willChange: string): { x: boolean; y: boolean } => {
  if (/\b(transform|translate|scale|rotate)\b/.test(willChange)) return { x: false, y: false };
  let m: DOMMatrix;
  try {
    m = new DOMMatrix(transform);
  } catch {
    return { x: false, y: false };
  }
  if (!m.is2D || m.b !== 0 || m.c !== 0) return { x: false, y: false };
  return { x: m.a === 1, y: m.d === 1 };
};

/** Whole up to the float round-off of a zoom division and re-multiplication. */
const onWholePixel = (value: number): boolean => Math.abs(value - Math.round(value)) < 1 / 1024;

/**
 * The local paint offset of a box whose live (or frozen-untransformed) border
 * rect is `rect`, or undefined when it cannot be authenticated. Below a
 * non-propagating frozen transform the offset is relative to that transform's
 * own box (Blink resets the paint offset there, :758-776); elsewhere it is the
 * viewport rect minus the live translations, up to whole pixels. With
 * `includeSelf`, the box's own frozen transform counts (its box paints at local
 * 0); without it the offset is the one the transform's paint-offset
 * translation rounds.
 */
export const localPaintOffset = (
  el: Element,
  rect: { left: number; top: number },
  includeSelf: boolean,
): { x: number; y: number } | undefined => {
  const view = el.ownerDocument?.defaultView;
  if (view == null) return undefined;
  if (view.devicePixelRatio !== 1) return undefined;
  if (view.visualViewport != null && view.visualViewport.scale !== 1) return undefined;
  // Each chain member's effective zoom (the product of `zoom` from it to the
  // root): its computed translation serializes in unzoomed CSS px, while
  // Blink lays out and translates in zoomed px.
  const chain: Element[] = [];
  for (let node: Element | null = el; node != null; node = composedParent(node)) chain.push(node);
  const zooms = new Map<Element, number>();
  let suffix = 1;
  for (let index = chain.length - 1; index >= 0; index--) {
    const own = parseFloat(view.getComputedStyle(chain[index]).zoom);
    suffix *= isFinite(own) && own > 0 ? own : 1;
    zooms.set(chain[index], suffix);
  }
  let tx = 0,
    ty = 0;
  let localX: number | null = null,
    localY: number | null = null;
  for (const node of chain) {
    const cs = view.getComputedStyle(node);
    const zoom = zooms.get(node) ?? 1;
    const base = node === el && !includeSelf ? undefined : frozenPaintBases.get(node);
    if (base === "unauthenticated") return undefined;
    if (base != null) {
      if (localX == null && base.x != null) localX = rect.left - tx - base.x;
      if (localY == null && base.y != null) localY = rect.top - ty - base.y;
      if (localX != null && localY != null) break;
    }
    if (cs.position === "sticky") return undefined;
    if (cs.offsetPath != null && cs.offsetPath !== "" && cs.offsetPath !== "none") return undefined;
    // The box's own compositing or isolation only matters once its own
    // paint-offset translation applies (includeSelf); without it, P is the
    // offset that translation rounds.
    if ((node !== el || includeSelf) && (preventsSubpixelAccumulation(cs) || isolatesPaintOffset(cs))) return undefined;
    // A frozen transform reads as identity here (the rect below it is already
    // untransformed); a live one must be a pure translation.
    const translation = pureTranslation(cs);
    if (translation == null) return undefined;
    tx += translation.x * zoom;
    ty += translation.y * zoom;
    // A descendant's own scroll offset moves its contents, not itself. The
    // web-exposed offset is divided by the scroller's effective zoom
    // (`AdjustForAbsoluteZoom::AdjustScroll`, core/dom/element.cc:2757); the
    // ScrollTranslation applies the zoomed one.
    if (node !== el && (!onWholePixel(node.scrollLeft * zoom) || !onWholePixel(node.scrollTop * zoom))) {
      return undefined;
    }
  }
  if (localX == null || localY == null) {
    const scroller = el.ownerDocument.scrollingElement;
    if (scroller != null && (!Number.isInteger(scroller.scrollLeft) || !Number.isInteger(scroller.scrollTop))) {
      return undefined;
    }
  }
  // Re-quantize to the LayoutUnit 1/64 grid so float translation round-off
  // cannot move a half-pixel edge across the rounding boundary.
  const quantize = (value: number) => Math.round(value * 64) / 64;
  return { x: quantize(localX ?? rect.left - tx), y: quantize(localY ?? rect.top - ty) };
};

/**
 * Register a frozen transform's paint-offset basis and return the translation
 * to fold into the matrix the renderer re-applies. Blink rounds the box's paint
 * offset into a PaintOffsetTranslation (`ToRoundedVector2d`, :748) and resolves
 * the transform origin from the box's local rect (`ComputeReferenceBox` →
 * `fragment.LocalRect()`, core/layout/transform_utils.cc:38-40). On an axis that
 * keeps the subpixel accumulation that changes nothing; on one that drops it,
 * the whole subtree paints `round(P) - P` further along before the transform,
 * which is `T(d)` composed before the matrix about the renderer's layout-based
 * origin. Unauthenticated bases fold nothing and make descendants fail closed.
 */
export const registerFrozenPaintBase = (
  el: Element,
  transform: string,
  cs: CSSStyleDeclaration,
): { x: number; y: number } => {
  // Paint isolation resets the paint offset outright (:744-749).
  const propagation = isolatesPaintOffset(cs)
    ? { x: false, y: false }
    : subpixelPropagation(transform, cs.willChange ?? "auto");
  if (propagation.x && propagation.y) {
    frozenPaintBases.set(el, { x: null, y: null });
    return { x: 0, y: 0 };
  }
  const rect = el.getBoundingClientRect();
  const offset = localPaintOffset(el, rect, false);
  if (offset == null) {
    frozenPaintBases.set(el, "unauthenticated");
    return { x: 0, y: 0 };
  }
  frozenPaintBases.set(el, {
    x: propagation.x ? null : Math.round(rect.left * 64) / 64,
    y: propagation.y ? null : Math.round(rect.top * 64) / 64,
  });
  const shift = {
    x: propagation.x ? 0 : Math.round(offset.x) - offset.x,
    y: propagation.y ? 0 : Math.round(offset.y) - offset.y,
  };
  if (shift.x !== 0 || shift.y !== 0) frozenPaintShifts.set(el, shift);
  return shift;
};

export const releaseFrozenPaintBase = (el: Element): void => {
  frozenPaintBases.delete(el);
  frozenPaintShifts.delete(el);
};

/** The paint-offset rounding folded into a frozen transform being captured. */
export const frozenPaintShift = (el: Element): { x: number; y: number } | undefined => frozenPaintShifts.get(el);

/**
 * The captured border box's Blink pixel-snapped paint edges, or undefined when
 * the local paint space cannot be authenticated from the live page.
 */
export const captureBorderPaintSnap = (
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
): CapturedBorderPaintSnap | undefined => {
  const local = localPaintOffset(el, rect, true);
  if (local == null) return undefined;
  // Each edge's LayoutUnit::Round delta in local paint space
  // (translation-invariant). LayoutUnit::Round (layout_unit.h:294-297) equals
  // Math.round on the 1/64 grid, and `round(x) + SnapSizeToPixelAllowingZero(
  // w, x)` (:815-818) is `round(x + w)`, so an edge delta serves both the
  // outer snap and every integer-outset snap derived from it; the renderer
  // applies SnapSizeToPixel's nonzero-size rule (:805-813) where Blink does.
  const localLeft = local.x,
    localTop = local.y;
  const localRight = localLeft + rect.width,
    localBottom = localTop + rect.height;
  return {
    source: "blink-pixel-snapped-border-v1",
    left: Math.round(localLeft) - localLeft,
    top: Math.round(localTop) - localTop,
    right: Math.round(localRight) - localRight,
    bottom: Math.round(localBottom) - localBottom,
    width: rect.width,
    height: rect.height,
  };
};
