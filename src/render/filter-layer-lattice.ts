/**
 * Filter-layer parameter space under a non-axis-aligned transform.
 *
 * Blink emits a CSS `filter` as a `SaveLayerOp` in the filter effect's local
 * transform space, which is the nearest Transform node: the filtered box's own
 * when it has one (`UpdateFilter`: `state.local_transform_space =
 * context_.current.transform`, core/paint/paint_property_tree_builder.cc:2453;
 * `StartEffect` switches to that space before `push<cc::SaveLayerOp>`,
 * platform/graphics/compositing/paint_chunks_to_cc_layer.cc:689-743, Chromium
 * 7d859f27). Blur-based filters are only `kScaleTranslate`-capable
 * (`SkImageFilter_Base::onGetCTMCapability`, src/core/SkImageFilter_Base.h:225,
 * Skia 62efacd3), so when the CTM rotates or skews, `Mapping::decomposeCTM`
 * keeps only its scale as the layer matrix and applies the rest after
 * filtering (src/core/SkImageFilterTypes.cpp:274-283). The layer's pixel grid
 * is then the integer grid of that local space, scaled: content is rasterized
 * there first (glyph baselines snap to whole layer pixels, glyph x positions to
 * quarter pixels) and the layer is resampled into place afterwards.
 *
 * The renderer's SVG user space keeps page coordinates inside every transform
 * wrapper, so a filter on such a group rasterizes on the page grid instead.
 * Translating the filter group's user space to the origin of Blink's local
 * space, and counter-translating its content, puts the layer grid back where
 * Blink has it without moving anything.
 *
 * That origin, in page coordinates, is the nearest transformed box's layout
 * position minus whatever subpixel accumulation Blink kept inside its local
 * space. The accumulation is dropped on every axis the transform does not
 * leave alone (core/paint/paint_property_tree_builder.cc:652-686), and the
 * renderer records the rounding it folded there as `transformPaintShift`. The
 * origin is therefore congruent, modulo whole pixels, to minus the sum of the
 * folded shifts of every enclosing transform, and lies within half a pixel of
 * the transformed box: on an axis that dropped the accumulation it is the box
 * position itself, and on one that kept it, the box sits at its rounded paint
 * offset's fraction in [-0.5, 0.5).
 */
import type { CapturedElement, CapturedTextPaintAffine } from "../capture/types.js";
import {
  emittedElementTextAffine,
  IDENTITY_TEXT_AFFINE,
  TEXT_PAINT_MATRIX_EPSILON,
  textAffineEquals,
} from "./text-affine.js";

/** The nearest enclosing transform's box position and the folded rounding enclosing it. */
export interface FilterLayerBasis {
  /** Layout position (page coordinates) of the nearest ancestor-or-self transformed box. */
  transformBox: [number, number];
  /** Sum of `transformPaintShift` over every enclosing transform, including that box's. */
  paintShiftSum: [number, number];
}

/**
 * For each element inside at least one emitted transform wrapper, the basis of
 * the local space its content (and a filter on it) paints in.
 */
export function buildFilterLayerBasisMap(
  roots: readonly CapturedElement[],
): WeakMap<CapturedElement, FilterLayerBasis> {
  const output = new WeakMap<CapturedElement, FilterLayerBasis>();
  const visit = (el: CapturedElement, parent: FilterLayerBasis | undefined): void => {
    const affine = emittedElementTextAffine(el);
    const transformed = affine != null && !textAffineEquals(affine, IDENTITY_TEXT_AFFINE);
    const own = el.styles.transformPaintShift ?? [0, 0];
    const sum: [number, number] = [(parent?.paintShiftSum[0] ?? 0) + own[0], (parent?.paintShiftSum[1] ?? 0) + own[1]];
    const current: FilterLayerBasis | undefined = transformed
      ? { transformBox: [el.x, el.y], paintShiftSum: sum }
      : parent == null
        ? undefined
        : { transformBox: parent.transformBox, paintShiftSum: sum };
    if (current != null) output.set(el, current);
    for (const child of el.children ?? []) visit(child, current);
  };
  for (const root of roots) visit(root, undefined);
  return output;
}

/** Five-decimal matrix entries bound a unit column's length error by about 1e-5. */
const LAYER_UNIT_SCALE_TOLERANCE = 1e-4;

const signedFraction = (value: number): number => {
  const reduced = value - Math.round(value);
  return Math.abs(reduced) < 1e-9 ? 0 : reduced;
};

/**
 * Page-space origin of Blink's local space for a filter painted under `ctm`,
 * or null when the user space already rasterizes like Blink: the CTM is
 * scale+translate (Skia then keeps the whole CTM as the layer matrix, so the
 * layer is device space), unknown, or the filter is outside every transform.
 */
export function filterLayerParameterOrigin(
  ctm: CapturedTextPaintAffine | null | undefined,
  basis: FilterLayerBasis | undefined,
): [number, number] | null {
  if (ctm == null || basis == null) return null;
  if (Math.abs(ctm[1]) <= TEXT_PAINT_MATRIX_EPSILON && Math.abs(ctm[2]) <= TEXT_PAINT_MATRIX_EPSILON) return null;
  // `SkMatrix::decomposeScale` (src/core/SkMatrix.cpp:1479-1499) takes the
  // layer scale from the column lengths. Where it is 1, any origin congruent
  // to Blink's modulo whole pixels gives the same grid, and the smallest such
  // translation keeps the wrapper from adding scaled round-off of its own: the
  // emitted matrix entries carry five decimals, so a unit rotation's columns
  // are 1 only to about 1e-5. Elsewhere the grid is the scaled local space
  // itself and only Blink's exact origin reproduces it.
  const unitScale = (a: number, b: number) => Math.abs(Math.hypot(a, b) - 1) <= LAYER_UNIT_SCALE_TOLERANCE;
  const axis = (box: number, shiftSum: number, unit: boolean) => {
    const congruent = signedFraction(-shiftSum);
    const origin = unit ? congruent : box + signedFraction(congruent - box);
    // Keep the 1/64 LayoutUnit grid exact through float addition.
    return Math.round(origin * 64) / 64;
  };
  const x = axis(basis.transformBox[0], basis.paintShiftSum[0], unitScale(ctm[0], ctm[1]));
  const y = axis(basis.transformBox[1], basis.paintShiftSum[1], unitScale(ctm[2], ctm[3]));
  return x === 0 && y === 0 ? null : [x, y];
}

/** Six decimals hold the 1/64 LayoutUnit grid exactly. */
export function formatTranslation([x, y]: readonly [number, number]): string {
  const f = (value: number) => String(Number(value.toFixed(6)) + 0);
  return `translate(${f(x)} ${f(y)})`;
}
