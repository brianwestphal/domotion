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
// pinch zoom, or a non-unit CSS zoom.
//
// The record is relative to the captured border box (edge deltas), so any
// later whole-tree translation of the captured coordinates keeps it valid.
// Self-contained: this runs inside the page via CAPTURE_SCRIPT.

import type { CapturedBorderPaintSnap } from "../../types.js";
import { frozenTransformOwners } from "./transforms.js";

const isPureTranslationMatrix = (transform: string): boolean => {
  try {
    const m = new DOMMatrix(transform);
    return m.is2D && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
  } catch {
    return false;
  }
};

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
 * The captured border box's Blink pixel-snapped paint edges, or undefined when
 * the local paint space cannot be authenticated from the live page.
 */
export const captureBorderPaintSnap = (
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
  effectiveZoom: number,
): CapturedBorderPaintSnap | undefined => {
  const view = el.ownerDocument?.defaultView;
  if (view == null) return undefined;
  if (view.devicePixelRatio !== 1) return undefined;
  if (view.visualViewport != null && view.visualViewport.scale !== 1) return undefined;
  if (effectiveZoom !== 1) return undefined;
  let tx = 0,
    ty = 0;
  for (let node: Element | null = el; node != null; node = composedParent(node)) {
    const cs = view.getComputedStyle(node);
    if (cs.position === "sticky") return undefined;
    if (cs.offsetPath != null && cs.offsetPath !== "" && cs.offsetPath !== "none") return undefined;
    if (preventsSubpixelAccumulation(cs) || isolatesPaintOffset(cs)) return undefined;
    // A frozen transform reads as identity here and the captured rect is
    // already untransformed below it. Its own box still snaps at the rounded
    // paint offset, but under a non-translation ancestor transform Blink drops
    // the subpixel accumulation (`CanPropagateSubpixelAccumulation`), so
    // descendants snap relative to that ancestor's rounded offset: fail closed.
    const frozen = frozenTransformOwners.get(node);
    if (frozen != null && node !== el && !isPureTranslationMatrix(frozen)) return undefined;
    const translation = pureTranslation(cs);
    if (translation == null) return undefined;
    tx += translation.x;
    ty += translation.y;
    // A descendant's own scroll offset moves its contents, not itself.
    if (node !== el && (!Number.isInteger(node.scrollLeft) || !Number.isInteger(node.scrollTop))) return undefined;
  }
  const scroller = el.ownerDocument.scrollingElement;
  if (scroller != null && (!Number.isInteger(scroller.scrollLeft) || !Number.isInteger(scroller.scrollTop))) {
    return undefined;
  }
  // Local paint space up to whole pixels: undo the summed post-snap
  // translations and return each edge's LayoutUnit::Round delta there
  // (translation-invariant). LayoutUnit::Round (layout_unit.h:294-297) equals
  // Math.round on the 1/64 grid, and `round(x) + SnapSizeToPixelAllowingZero(
  // w, x)` (:815-818) is `round(x + w)`, so an edge delta serves both the
  // outer snap and every integer-outset snap derived from it; the renderer
  // applies SnapSizeToPixel's nonzero-size rule (:805-813) where Blink does.
  // Re-quantize to the 1/64 grid so float translation round-off cannot move a
  // half-pixel edge across the rounding boundary.
  const localLeft = Math.round((rect.left - tx) * 64) / 64,
    localTop = Math.round((rect.top - ty) * 64) / 64;
  const localRight = localLeft + rect.width,
    localBottom = localTop + rect.height;
  return {
    source: "blink-pixel-snapped-border-v1",
    left: Math.round(localLeft) - localLeft,
    top: Math.round(localTop) - localTop,
    right: Math.round(localRight) - localRight,
    bottom: Math.round(localBottom) - localBottom,
  };
};
