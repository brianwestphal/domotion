/**
 * Which blurred normal box-shadows the SVG producer reproduces byte-exactly.
 * Skia references are at 62efacd3, Chromium at 7d859f27; doc 277 ("Blurred
 * shadows") has the measurements.
 *
 * Blink paints a blurred normal shadow through a draw looper whose paint
 * carries `SkMaskFilter::MakeBlur(kNormal, σ)` and an `SkColorFilters::
 * Blend(color, kSrcIn)` (`cc/paint/draw_looper.cc:22-35`), with σ exactly half
 * the blur radius (`ShadowData::BlurRadiusToStdDev`, shadow_data.h:76-82). On
 * the CPU raster device Skia builds the shape's coverage as an A8 mask, blurs
 * it, and blits the color through it with the legacy ARGB32 blitter. The
 * producer blurs the shape's alpha with `feGaussianBlur` (the image-filter
 * blur engine) and recolors it with a component-transfer table
 * (`emitShadowMaskBlurFilter`). The two agree only where every stage is equal
 * by construction:
 *
 * 1. Kernel. Below σ = 2 the mask filter uses `small_blur`, a true Gaussian
 *    (`SkMaskBlurFilter.cpp:967-969`), while Chromium's image-filter blur
 *    always takes the three-box `ThreeBoxApproxPass`
 *    (`SK_AVOID_SLOW_RASTER_PIPELINE_BLURS`, Chromium `skia/config/
 *    SkUserConfig.h:142`; `SkBlurEngine.cpp:1240-1258`). From σ = 2 both run
 *    the same three boxes with the same window (`PlanGauss` /
 *    `SkBlurEngine::BoxBlurWindow`), buffers and border, but round each pass
 *    differently: `PlanGauss::Scan::finalScale` is
 *    `(round(2^32/d)·S + 2^31) >> 32`, `ScaledDividerU32` is
 *    `((S + (d+1)/2) · round(2^32/d)) >> 32` (`SkMaskBlurFilter.cpp:206-208`,
 *    `SkVx.h:880-897`). `boxWindowRoundingAgrees` checks every reachable sum.
 * 2. Shape. A sharp rect large enough for `SkBlurMaskFilterImpl::
 *    filterRectsToNine` is blurred by `SkBlurMask::BlurRect`, an analytic
 *    integral profile, not a box blur (`SkBlurMaskFilterImpl.cpp:124-130,
 *    432-520`); a smaller one falls back to the box-blurred mask
 *    (`SkMaskFilterBase::filterPath`, SkMaskFilterBase.cpp:262-322). A
 *    whole-pixel sharp rect has 0/255 coverage on both routes. Rounded shapes
 *    are not admitted: their antialiased coverage reaches the blur, and
 *    measured residuals remain that this analysis does not explain.
 * 3. Color. The legacy blitter writes `SkAlphaMulQ(pmColor, aa + 1)`, i.e.
 *    `(c·(aa+1)) >> 8` per premultiplied channel (`SkBlitter_ARGB32.cpp:1615`).
 *    The alpha table writes exactly that alpha; the color channels are a
 *    constant unpremultiplied value, which reproduces the native channel only
 *    when it is 0 or 255.
 */
/**
 * The σ written for a box-shadow's mask blur: half the radius, as Blink's
 * `BlurRadiusToStdDev`. Three decimals keep it exact for every radius a
 * computed style serializes to two decimals.
 */
export function shadowMaskBlurStdDeviation(blurRadius: number): number {
  return Math.round(blurRadius * 500) / 1000;
}

/** `SkBlurEngine::BoxBlurWindow` (SkBlurEngine.h:89-92), in float. */
export function skiaBoxBlurWindow(sigma: number): number {
  const root = Math.fround(Math.sqrt(Math.fround(2 * Math.fround(Math.PI))));
  const scaled = Math.fround(Math.fround(Math.fround(Math.fround(sigma) * 3) * root) / 4);
  return Math.max(1, Math.floor(Math.fround(scaled + 0.5)));
}

/** `PlanGauss`'s window, computed in double (SkMaskBlurFilter.cpp:28-29). */
function planGaussWindow(sigma: number): number {
  return Math.max(1, Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5));
}

/** `PlanGauss` border: how far the blurred mask extends past its source
 * (SkMaskBlurFilter.cpp:79). */
export function planGaussBorder(window: number): number {
  return window % 2 === 1 ? 3 * ((window - 1) / 2) : 3 * (window / 2) - 1;
}

const agreement = new Map<number, boolean>();

/** Whether the mask-filter and image-filter three-box passes round every
 * reachable window sum (0 ..= 255·divisor) to the same byte. */
export function boxWindowRoundingAgrees(window: number): boolean {
  const cached = agreement.get(window);
  if (cached != null) return cached;
  const w2 = window * window;
  const divisor = window % 2 === 1 ? w2 * window : w2 * window + w2;
  const factor = Math.round((1 / divisor) * 2 ** 32);
  const half = (divisor + 1) >> 1;
  let agrees = true;
  // Every product stays below 2^53, so the doubles are exact.
  for (let sum = 0; sum <= 255 * divisor && agrees; sum++) {
    agrees = Math.floor((factor * sum + 2 ** 31) / 2 ** 32) === Math.floor(((sum + half) * factor) / 2 ** 32);
  }
  agreement.set(window, agrees);
  return agrees;
}

/**
 * The largest box window with a native full-RGBA control. Larger agreeing
 * windows stay refused: a 30px blur (window 28, which agrees) still differs
 * from Chromium at a handful of pixels on a rounded shape.
 */
export const MAX_VERIFIED_BOX_WINDOW = 14;

/** Whether native σ and the emitted σ select the same agreeing box blur. */
export function blurSigmaIsAuthentic(blurRadius: number): boolean {
  const native = Math.fround(blurRadius * 0.5);
  const emitted = shadowMaskBlurStdDeviation(blurRadius);
  if (native < 2 || emitted < 2) return false;
  const window = skiaBoxBlurWindow(native);
  if (window !== skiaBoxBlurWindow(emitted) || window !== planGaussWindow(native)) return false;
  return window <= MAX_VERIFIED_BOX_WINDOW && boxWindowRoundingAgrees(window);
}

/** Whether the alpha-table recolor reproduces the native blit for a color. */
export function shadowColorIsAuthentic(color: { r: number; g: number; b: number; a: number }): boolean {
  return color.a > 0 && [color.r, color.g, color.b].every((channel) => channel === 0 || channel === 255);
}

/** The native coverage→alpha byte table: `(ca·(aa+1)) >> 8`. */
export function legacyMaskBlitAlphaTable(alphaByte: number): number[] {
  return Array.from({ length: 256 }, (_, aa) => (alphaByte * (aa + 1)) >> 8);
}

export interface DeviceRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `SkBlurMaskFilterImpl::filterRectsToNine` for one rect: whether Skia takes
 * the analytic `BlurRect` profile (true) or returns `kUnimplemented` and
 * box-blurs the rasterized mask (SkBlurMaskFilterImpl.cpp:432-520,
 * SkBlurMask.cpp:405-435). σ is clamped to 128 (`computeXformedSigma`). */
export function sharpRectTakesAnalyticBlur(rect: DeviceRect, sigma: number): boolean {
  const profileSize = Math.ceil(6 * Math.min(Math.fround(sigma), 128));
  if (profileSize <= 0) return false;
  const pad = Math.floor(profileSize / 2);
  const roundInt = (v: number) => Math.floor(v + 0.5);
  const dstW = roundInt(rect.right + pad) - roundInt(rect.left - pad);
  const dstH = roundInt(rect.bottom + pad) - roundInt(rect.top - pad);
  const srcW = Math.ceil(rect.right) - Math.floor(rect.left);
  const srcH = Math.ceil(rect.bottom) - Math.floor(rect.top);
  const dx = srcW - (dstW - srcW + 3);
  const dy = srcH - (dstH - srcH + 3);
  if (dx < 0 || dy < 0) return false;
  return rect.right - dx - rect.left >= 2 && rect.bottom - dy - rect.top >= 2;
}

/** A sharp box's border rect and a blurred normal layer on it. */
export interface BlurredShadowCase {
  border: DeviceRect;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: { r: number; g: number; b: number; a: number };
}

/** Why a blurred normal layer is refused, or null when it is reproduced exactly. */
export function blurredNormalShadowRefusal(c: BlurredShadowCase): string | null {
  if (!blurSigmaIsAuthentic(c.blur)) return "box-window";
  if (!shadowColorIsAuthentic(c.color)) return "color";
  const rect = {
    left: c.border.left + c.x - c.spread,
    top: c.border.top + c.y - c.spread,
    right: c.border.right + c.x + c.spread,
    bottom: c.border.bottom + c.y + c.spread,
  };
  if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isInteger)) return "fractional";
  if (rect.right <= rect.left || rect.bottom <= rect.top) return "empty";
  if (sharpRectTakesAnalyticBlur(rect, Math.fround(c.blur * 0.5))) return "analytic-rect";
  return null;
}
