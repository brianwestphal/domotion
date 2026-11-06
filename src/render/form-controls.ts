import { emitGaussianBlurFilter } from "./gaussian-blur.js";
/**
 * Source-owned structural form-control paint.
 *
 * Effective native appearances are painted from a captured Chromium surface
 * before this module is reached. These helpers consume only complete captured
 * author/UA-CSS pseudo facts; missing native paint fails closed at the route
 * boundary instead of substituting a platform-calibrated SVG approximation.
 */

import { renderWarn } from "./render-warn.js";
import { isPaintedColor, TRANSPARENT_BLACK } from "../utils/transparent-background.js";
import type { CapturedElement } from "../capture/types.js";
import { capturedFontFamilyCss } from "../font-family-stack.js";
import { isWholeHostNativeAppearance } from "../capture/effective-appearance.js";
import { buildLinearGradientDef, buildRadialGradientDef, gradientCacheKey, parseGradient } from "./gradients.js";
import { parseBoxShadow } from "./box-shadow.js";
import { paintBoxShadow, paintInsetBoxShadow } from "./box-shadow-paint.js";
import { insetCornerRadii, parseCornerRadii, roundedRectSvg } from "./borders.js";
import { paintBorder } from "./border-paint.js";
import type { PaintCtx } from "./element-tree-to-svg.js";
import { splitTopLevelCommas } from "./css-tokens.js";
import { esc, r } from "./format.js";
import { parseColor } from "./colors.js";
import { blinkSymbolMarkerGeometry, disclosureTriangle } from "./list-marker-geometry.js";
import { fontSizeOrDefault } from "./text-defaults.js";
import { renderMultiSegmentText } from "./text.js";
import { renderTextAsPath } from "./text-to-path.js";
import { hasVerticalSegments, renderVerticalSegments } from "./vertical-text.js";

/**
 * Per-render context for emitting <defs> entries. Form-controls populate
 * this when they need to register an SVG <linearGradient> for a captured
 * CSS gradient background; the calling renderer flushes the accumulated
 * defs into the top-level <defs> block (SK-1224).
 */
export interface DefCtx {
  /** Stable prefix for generated IDs (mirrors the existing clipPath idPrefix). */
  idPrefix: string;
  /** Mutable list the caller will splice into the top-level <defs>. */
  defsParts: string[];
  /** Dedup table: gradient cache key → already-registered id. */
  gradientCache: Map<string, string>;
  /** Allocate a new gradient id like `${idPrefix}grad${N}`. */
  nextGradId: () => string;
  /**
   * DM-1252: emit a `<pattern>` def for a conic-gradient layer rasterized at the
   * given consumer rect, or `""` on a cache miss. Injected by the renderer
   * (`buildConicGradientDef`, which reads the `_conicTileCache` populated by the
   * async raster pre-pass) so form-control pseudos can paint conic backgrounds
   * without form-controls.ts importing the renderer (avoids an import cycle).
   */
  buildConicTile?: (
    id: string,
    layer: string,
    x: number,
    y: number,
    w: number,
    h: number,
    sizeCss: string,
    posCss: string,
  ) => string;
}

/** Helper: parse a captured gradient text and register a gradient def, returning fill="url(#id)" or null. */
function gradientFillFor(
  bgImage: string | undefined,
  rect: { x: number; y: number; w: number; h: number },
  ctx: DefCtx | undefined,
): string | null {
  if (ctx == null || bgImage == null || bgImage === "" || bgImage === "none") return null;
  const grad = parseGradient(bgImage);
  if (grad == null) return null;
  // DM-1252: conic on a form-control pseudo. SVG has no native conic, so the
  // renderer rasterizes conic layers to a PNG `<pattern>` in the async pre-pass
  // (`rasterizeConicGradients`, which also walks form-control pseudo bgs via
  // `collectFormControlConicTiles` and keys tiles by the consumer rect size).
  // Emit the cached tile for THIS consumer rect via the injected builder; a
  // cache miss (pre-pass didn't run / size mismatch) falls back to flat color.
  if (grad.kind === "conic") {
    if (ctx.buildConicTile == null) return null;
    const id = ctx.nextGradId();
    const def = ctx.buildConicTile(id, bgImage, rect.x, rect.y, rect.w, rect.h, "auto", "0% 0%");
    if (def === "") return null;
    ctx.defsParts.push(def);
    return `url(#${id})`;
  }
  const key = gradientCacheKey(grad, rect);
  let id = ctx.gradientCache.get(key);
  if (id == null) {
    id = ctx.nextGradId();
    const def =
      grad.kind === "linear" ? buildLinearGradientDef(grad, id, rect) : buildRadialGradientDef(grad, id, rect);
    ctx.defsParts.push(def);
    ctx.gradientCache.set(key, id);
  }
  return `url(#${id})`;
}

/**
 * Resolve a pseudo's computed `background-image` list to one SVG fill per
 * renderable layer, in PAINT order (bottom layer first). Blink paints every
 * fill layer, last-listed first, over the background color
 * (`BoxPainterBase::PaintFillLayers`, Chromium 7d859f27). A layer that cannot
 * be painted here (a `url()` image, an unparseable value, a conic tile the
 * pre-pass did not produce) is omitted with a named warning rather than
 * silently replaced by the background color.
 */
function gradientLayerFills(
  bgImage: string | undefined,
  rect: { x: number; y: number; w: number; h: number },
  ctx: DefCtx | undefined,
  slot: string,
): LayerFills {
  if (ctx == null || bgImage == null || bgImage === "" || bgImage === "none")
    return { fills: [], bottomOccludes: false };
  const layers = splitTopLevelCommas(bgImage)
    .map((layer) => layer.trim())
    .filter((layer) => layer !== "" && layer !== "none");
  const fills: string[] = [];
  let bottomOccludes = false;
  for (let i = layers.length - 1; i >= 0; i--) {
    const fill = gradientFillFor(layers[i], rect, ctx);
    if (fill != null) {
      if (i === layers.length - 1) bottomOccludes = gradientKnownToBeOpaque(layers[i]);
      fills.push(fill);
      continue;
    }
    renderWarn(
      "form-control-background-layer",
      `${slot} background layer ${i + 1} of ${layers.length} is not a renderable gradient; that layer is omitted`,
      slot,
    );
  }
  return { fills, bottomOccludes };
}

/** A pseudo's renderable gradient layers, in paint order, plus whether the
 *  bottom (last-listed) layer hides the background color. */
interface LayerFills {
  fills: string[];
  bottomOccludes: boolean;
}

/**
 * Blink's `CSSGradientValue::KnownToBeOpaque` (core/css/css_gradient_value.cc:922,
 * Chromium 7d859f27): a gradient is opaque when every color stop (hints
 * excluded) resolves to an opaque color.
 */
function gradientKnownToBeOpaque(layer: string): boolean {
  const grad = parseGradient(layer);
  if (grad == null || grad.stops.length === 0) return false;
  return grad.stops.every((stop) => (parseColor(stop.color)?.a ?? 0) >= 1);
}

/**
 * The shapes painted BELOW a pseudo's top layer: the background color and then
 * every lower gradient layer, each in the same geometry as the top shape.
 * Blink paints the color under the fill layers (`BoxPainterBase::PaintFillLayers`,
 * core/paint/box_painter_base.cc:59-85, Chromium 7d859f27) on the bottom layer,
 * unless that layer's image occludes it: `should_paint_color` requires
 * `!layer.ImageOccludesNextLayers()` (box_painter_base.cc:697-700), which for a
 * default source-over, normal-blend, tiling layer is `KnownToBeOpaque`
 * (core/style/fill_layer.cc:445-464). The pseudo slots do not capture
 * `background-repeat` / `background-blend-mode`, so the initial `repeat` /
 * `normal` values are assumed. `baseColor` is null when the caller paints the
 * color itself or the pseudo has none. Empty when there are no layers, since
 * the caller then fills the top shape with the color directly.
 */
function underlayerShapes(layers: LayerFills, baseColor: string | null, shape: (fill: string) => string): string[] {
  const { fills } = layers;
  if (fills.length === 0) return [];
  const out: string[] = [];
  if (baseColor != null && isPaintedColor(baseColor) && !layers.bottomOccludes) out.push(shape(baseColor));
  for (const fill of fills.slice(0, -1)) out.push(shape(fill));
  return out;
}

/**
 * Paint a slider pseudo box's `box-shadow` list through the general box-shadow
 * painters, exactly as for an element's border box: Blink paints a pseudo's
 * shadows with the same `BoxPainterBase::PaintNormalBoxShadow` /
 * `PaintInsetBoxShadow` code as any box (`box_painter_base.cc`, Chromium
 * 7d859f27), outer shadows before the background and inset shadows after it,
 * inside the padding box. Offset, blur, spread and inset all apply.
 */
function pseudoBoxShadowMarkup(
  kind: "outer" | "inset",
  boxShadow: string | undefined,
  box: { x: number; y: number; w: number; h: number },
  radius: number,
  borderWidth: number,
  indent: string,
  defCtx: DefCtx | undefined,
): string[] {
  if (defCtx == null || boxShadow == null || boxShadow === "" || boxShadow === "none") return [];
  const bw = `${borderWidth}px`;
  const shadowBox = {
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    styles: { boxShadow, borderTopWidth: bw, borderRightWidth: bw, borderBottomWidth: bw, borderLeftWidth: bw },
  };
  const corners = parseCornerRadii({ borderRadius: `${radius}px` }, box.w, box.h);
  const svgParts: string[] = [];
  const ctx = { svgParts, defsParts: defCtx.defsParts, nextClipId: () => defCtx.nextGradId() };
  if (kind === "outer") paintBoxShadow(ctx, shadowBox, corners, indent);
  else paintInsetBoxShadow(ctx, shadowBox, corners, indent);
  return svgParts;
}

/**
 * Range slider thumb/track metric sizes. Shared by `renderRange` and the conic
 * raster pre-pass (`collectFormControlConicTiles`) so a conic layer is
 * rasterized at exactly the rect the structural renderer fills. Every metric
 * comes from the captured track/thumb pseudo styles.
 */
function rangeMetricSizes(s: CapturedElement["styles"]): {
  styledTrack: boolean;
  styledThumb: boolean;
  trackThickness: number;
  thumbW: number;
  thumbH: number;
  thumbRadius: number;
} {
  const styledTrack = s.rangeTrackBg != null;
  const styledThumb = s.rangeThumbWidth != null;
  const trackThickness = parseFloat(s.rangeTrackHeight ?? "");
  const thumbW = parseFloat(s.rangeThumbWidth ?? "");
  const thumbH = parseFloat(s.rangeThumbHeight ?? "");
  const thumbRadius = parseFloat(s.rangeThumbRadius ?? "");
  return { styledTrack, styledThumb, trackThickness, thumbW, thumbH, thumbRadius };
}

/**
 * DM-1252: enumerate the conic-gradient layers a form-control's pseudo
 * backgrounds will paint, each with the consumer rect SIZE the synth fills, so
 * the async conic raster pre-pass (`rasterizeConicGradients`) can rasterize a
 * tile at the right dimensions. Sizes MUST match the rects the render
 * functions pass to `gradientFillFor` (the cache is keyed by `${w}x${h}`); the
 * shared `rangeMetricSizes` / `progressBarGeom` / `meterBarGeom` keep each case
 * in lockstep with its render function. Returns `[]` for controls with no conic
 * pseudo background. Covers the range thumb/track, color swatch, and
 * `<progress>` / `<meter>` bar + value pseudos (DM-1252 + DM-1254).
 */
interface FcRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * DM-1254: `<progress>` track + value rects, shared by `renderProgress` and the
 * conic raster collector so the conic tile is rasterized at exactly the rect the
 * renderer fills (the `_conicTileCache` is keyed by `${w}x${h}`).
 */
function progressBarGeom(el: CapturedElement): { trackRect: FcRect; valueRect: FcRect | null } {
  const trackRect = { x: el.x, y: el.y, w: el.width, h: el.height };
  const value = el.styles.progressValue;
  const max = el.styles.progressMax ?? 1;
  if (value == null || max <= 0) return { trackRect, valueRect: null };
  const ratio = Math.max(0, Math.min(1, value / max));
  if (ratio <= 0) return { trackRect, valueRect: null };
  const width = el.width * ratio;
  const x = el.styles.direction === "rtl" ? el.x + el.width - width : el.x;
  return { trackRect, valueRect: { x, y: el.y, w: width, h: el.height } };
}

/**
 * `<meter>` bar + value rects. Blink lays `::-webkit-meter-bar` out in the
 * middle row of the inner element's `1fr [line1] 2fr [line2] 1fr` grid
 * (`meter::-webkit-meter-inner-element` / `meter::-webkit-meter-bar`,
 * core/html/resources/html.css:1364-1386, Chromium 7d859f27), so the bar is
 * the middle half of the host's content box, and the value element is its
 * percentage inline-size inside the bar's content box. Capture reads both used
 * rects from the retained closed-UA-shadow nodes; the grid arithmetic below
 * only serves captures that predate that field.
 */
function meterBarGeom(el: CapturedElement): {
  trackRect: FcRect;
  valueRect: FcRect | null;
  valueBgImage: string | undefined;
} {
  const s = el.styles;
  const value = s.meterValue ?? 0;
  const min = s.meterMin ?? 0;
  const max = s.meterMax ?? 1;
  const low = s.meterLow ?? min;
  const high = s.meterHigh ?? max;
  const optimum = s.meterOptimum ?? (min + max) / 2;
  const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const region = (candidate: number): 0 | 1 | 2 => (candidate < low ? 0 : candidate > high ? 2 : 1);
  const distance = Math.abs(region(value) - region(optimum));
  const valueBgImage =
    distance === 0 ? s.meterOptimumBgImage : distance === 1 ? s.meterSuboptimumBgImage : s.meterEvenLessGoodBgImage;
  const capturedBar = s.meterBarGeometry;
  if (capturedBar != null) {
    const trackRect = { x: capturedBar.x, y: capturedBar.y, w: capturedBar.width, h: capturedBar.height };
    const v = s.meterValueGeometry;
    const valueRect = v != null && v.width > 0 && v.height > 0 ? { x: v.x, y: v.y, w: v.width, h: v.height } : null;
    return { trackRect, valueRect, valueBgImage };
  }
  const px = (value: string | undefined): number => Math.max(0, parseFloat(value ?? "") || 0);
  const contentX = el.x + px(s.borderLeftWidth) + px(s.paddingLeft);
  const contentY = el.y + px(s.borderTopWidth) + px(s.paddingTop);
  const contentW = Math.max(
    0,
    el.width - px(s.borderLeftWidth) - px(s.borderRightWidth) - px(s.paddingLeft) - px(s.paddingRight),
  );
  const contentH = Math.max(
    0,
    el.height - px(s.borderTopWidth) - px(s.borderBottomWidth) - px(s.paddingTop) - px(s.paddingBottom),
  );
  const inset = Math.floor(contentH / 4);
  const trackRect = { x: contentX, y: contentY + inset, w: contentW, h: Math.max(0, contentH - inset * 2) };
  if (ratio <= 0) return { trackRect, valueRect: null, valueBgImage };
  const bw = meterBarBorderWidths(s);
  const innerW = Math.max(0, trackRect.w - bw.left - bw.right);
  const width = innerW * ratio;
  const x = s.direction === "rtl" ? trackRect.x + bw.left + innerW - width : trackRect.x + bw.left;
  return {
    trackRect,
    valueRect: { x, y: trackRect.y + bw.top, w: width, h: Math.max(0, trackRect.h - bw.top - bw.bottom) },
    valueBgImage,
  };
}

type MeterBarBorderSide = { width: string; style: string; color: string };

/**
 * Blink's final `::-webkit-meter-bar` border sides: the per-side record when
 * the sides differ, otherwise the uniform `"<width> <style> <color>"` record
 * repeated. `null` when the bar has no border.
 */
function meterBarBorderSides(
  s: CapturedElement["styles"],
): { top: MeterBarBorderSide; right: MeterBarBorderSide; bottom: MeterBarBorderSide; left: MeterBarBorderSide } | null {
  if (s.meterBarBorderSides != null) return s.meterBarBorderSides;
  const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(s.meterBarBorder?.trim() ?? "");
  if (m == null) return null;
  const side = { width: m[1], style: m[2], color: m[3] };
  return { top: side, right: side, bottom: side, left: side };
}

function meterBarBorderWidths(s: CapturedElement["styles"]): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const sides = meterBarBorderSides(s);
  const w = (side: MeterBarBorderSide | undefined): number =>
    side == null || side.style === "none" || side.style === "hidden" ? 0 : Math.max(0, parseFloat(side.width) || 0);
  return { top: w(sides?.top), right: w(sides?.right), bottom: w(sides?.bottom), left: w(sides?.left) };
}
export function collectFormControlConicTiles(el: CapturedElement): Array<{ layer: string; w: number; h: number }> {
  const s = el.styles;
  const out: Array<{ layer: string; w: number; h: number }> = [];
  // A pseudo's `background-image` may be a layer list; each conic layer is
  // rasterized on its own at the consumer rect, as gradientLayerFills reads it.
  const conicLayers = (bg: string | undefined): string[] =>
    bg == null || bg === "" || bg === "none"
      ? []
      : splitTopLevelCommas(bg)
          .map((layer) => layer.trim())
          .filter((layer) => /^(?:repeating-)?conic-gradient\(/i.test(layer));
  const tag = el.tag;
  const inputType = s.inputType;
  if (tag === "input" && inputType === "range") {
    const { styledTrack, styledThumb, trackThickness, thumbW, thumbH, thumbRadius } = rangeMetricSizes(s);
    if (
      !styledTrack ||
      !styledThumb ||
      ![trackThickness, thumbW, thumbH, thumbRadius].every(Number.isFinite) ||
      trackThickness < 0 ||
      thumbW <= 0 ||
      thumbH <= 0 ||
      thumbRadius < 0
    )
      return out;
    const elW = Math.round(el.x + el.width) - Math.round(el.x);
    const elH = Math.round(el.y + el.height) - Math.round(el.y);
    const isVertical = s.writingMode != null && s.writingMode !== "" && s.writingMode !== "horizontal-tb";
    for (const layer of conicLayers(s.rangeTrackBgImage)) {
      out.push({
        layer,
        w: isVertical ? trackThickness : elW,
        h: isVertical ? elH : trackThickness,
      });
    }
    // Mirror renderRange's thumb-shape branch: a non-circular / small-radius
    // styled thumb is a thumbW×thumbH rect; otherwise a thumbW-diameter circle.
    const ellipse = styledThumb && (thumbH !== thumbW || thumbRadius < Math.min(thumbW, thumbH) / 2);
    for (const layer of conicLayers(s.rangeThumbBgImage)) out.push({ layer, w: thumbW, h: ellipse ? thumbH : thumbW });
  } else if (tag === "input" && inputType === "color" && conicLayers(s.colorSwatchBgImage).length > 0) {
    // Mirror renderColorSwatch's `swatchRect`; a missing wrapper padding fact
    // is not replaced with the former sampled 4px platform value.
    const tok = s.colorSwatchWrapperPadding
      ?.trim()
      .split(/\s+/)
      .map((p) => parseFloat(p));
    if (tok != null && tok.length >= 1 && tok.length <= 4 && tok.every(Number.isFinite)) {
      const top = tok[0];
      const right = tok.length === 1 ? tok[0] : tok[1];
      const bottom = tok.length < 3 ? tok[0] : tok[2];
      const left = tok.length < 2 ? tok[0] : tok.length < 4 ? tok[1] : tok[3];
      const w = el.width - left - right;
      const h = el.height - top - bottom;
      if (w > 0 && h > 0) for (const layer of conicLayers(s.colorSwatchBgImage)) out.push({ layer, w, h });
    }
  } else if (tag === "progress") {
    // DM-1254: progress bar/value rects come from the shared progressBarGeom
    // (also used by renderProgress), so the conic tile size matches what's filled.
    const { trackRect, valueRect } = progressBarGeom(el);
    for (const layer of conicLayers(s.progressBarBgImage)) out.push({ layer, w: trackRect.w, h: trackRect.h });
    if (valueRect != null)
      for (const layer of conicLayers(s.progressValueBgImage)) out.push({ layer, w: valueRect.w, h: valueRect.h });
  } else if (tag === "meter") {
    // DM-1254: meter bar/value rects + the region-selected value bg image come
    // from the shared meterBarGeom (also used by renderMeter's gradient lookups).
    const { trackRect, valueRect, valueBgImage } = meterBarGeom(el);
    for (const layer of conicLayers(s.meterBarBgImage)) out.push({ layer, w: trackRect.w, h: trackRect.h });
    if (valueRect != null)
      for (const layer of conicLayers(valueBgImage)) out.push({ layer, w: valueRect.w, h: valueRect.h });
  }
  return out;
}

export type FormControlRenderRoute = "not-form-control" | "native-raster" | "missing-native-raster" | "structural";

const STRUCTURAL_FORM_APPEARANCES = new Set(["none", "base", "base-select", "listbox", "menulist-button"]);

/**
 * Blink's EffectiveAppearance is the paint-ownership boundary. A materialized
 * native record terminates structural rendering; a native/unknown appearance
 * without its required record fails closed instead of reviving sampled chrome.
 */
export function formControlRenderRoute(el: CapturedElement): FormControlRenderRoute {
  const isControl =
    el.tag === "input" ||
    el.tag === "button" ||
    el.tag === "select" ||
    el.tag === "textarea" ||
    el.tag === "progress" ||
    el.tag === "meter";
  if (!isControl) return "not-form-control";
  if (el.nativeControlRaster != null) return "native-raster";
  const appearance = el.styles.effectiveAppearance;
  if (appearance == null || isWholeHostNativeAppearance(appearance)) {
    return "missing-native-raster";
  }
  return STRUCTURAL_FORM_APPEARANCES.has(appearance) ? "structural" : "missing-native-raster";
}

export function renderFormControl(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const route = formControlRenderRoute(el);
  if (route === "native-raster") return "";
  if (route === "missing-native-raster") {
    const type = el.styles.inputType == null ? "" : `[type=${el.styles.inputType}]`;
    renderWarn(
      "native-control",
      `required Chromium native-control surface unavailable for ${el.tag}${type}; sampled SVG chrome is disabled`,
    );
    return "";
  }
  const tag = el.tag;
  if (tag === "input") return renderInputControl(el, indent, defCtx);
  if (tag === "progress") return renderProgress(el, indent, defCtx);
  if (tag === "meter") return renderMeter(el, indent, defCtx);
  // Structural closed-dropdown selects retain source-captured value text.
  // Native menulist paint already terminated at the route boundary; author
  // background-image arrows paint through the ordinary background pipeline.
  if (tag === "select" && el.styles.selectDisplayText != null) return renderSelectContent(el, indent);
  if (tag === "select" && el.styles.selectListboxOptions != null) return renderListbox(el, indent);
  if (tag === "details") {
    return renderDetailsContentBox(el, indent);
  }
  return "";
}

/**
 * DM-1152: paint the `::details-content` separator for an OPEN `<details>`.
 * Chrome 131+ styles the disclosure body via the `::details-content` pseudo;
 * a `border-top` there draws a divider line between the summary and the
 * content. That line doesn't round-trip through element capture (the pseudo
 * wraps the real content children), so synthesize it here. The line sits in
 * the gap just below the summary — painting it after the content children is
 * safe (no text there). The pseudo's background is intentionally NOT painted
 * here: it would have to render BEHIND the content text (this synthesis paints
 * on top), and against the typical near-white body it's sub-perceptible.
 */
function renderDetailsContentBox(el: CapturedElement, indent: string): string {
  const box = el.styles.detailsContentBox;
  if (box == null || box.borderTopWidth <= 0 || box.borderTopColor == null) return "";
  const summaryChild = el.children?.find((c) => c.tag === "summary");
  if (summaryChild == null) return "";
  const boxTop = summaryChild.y + summaryChild.height; // summary bottom = content-box top
  const left = el.x + box.borderLeftWidth;
  const width = el.width - box.borderLeftWidth - box.borderRightWidth;
  if (width <= 0) return "";
  // Snap to the pixel grid so the 1px divider is crisp (matches Chrome's
  // border row at the summary's bottom edge).
  const y = Math.round(boxTop);
  return `${indent}<rect x="${r(left)}" y="${r(y)}" width="${r(width)}" height="${r(box.borderTopWidth)}" fill="${box.borderTopColor}" />`;
}

function renderInputControl(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const t = el.styles.inputType ?? "text";
  // Modern structural checkables paint captured ::before/::after/::checkmark
  // fragments. Native checkables were terminated by the route guard above.
  if (t === "checkbox" || t === "radio") return "";
  if (t === "range") return renderRange(el, indent, defCtx);
  if (t === "color") return renderColorSwatch(el, indent, defCtx);
  if (t === "file") return renderFileInput(el, indent, defCtx);
  // Search/spin/picker paint belongs to the retained closed-shadow
  // decoration reservation. The structural host/value path paints elsewhere.
  if (
    t === "number" ||
    t === "search" ||
    t === "date" ||
    t === "time" ||
    t === "datetime-local" ||
    t === "month" ||
    t === "week"
  )
    return "";
  // text-like inputs already render via the normal border+bg path
  return "";
}

function renderRange(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // Structural ranges consume the captured used track/thumb pseudo styles.
  // Native slider appearances terminate at the route guard above.
  // Gradient backgrounds (SK-1224) on track/thumb resolve through defCtx
  // into a top-level <linearGradient> def referenced via fill="url(#...)".
  //
  // Vertical writing-mode (DM-276) flips the layout axis: the track runs
  // top-to-bottom inside `el`, and `direction: rtl` puts low value at the
  // bottom (matching the test fixture and Chrome's painted behavior for
  // `<input type=range>` with `writing-mode: vertical-*`).
  const s = el.styles;
  // DM-1252: the thumb/track metric sizes are shared with the conic raster
  // pre-pass (`rangeMetricSizes`) so `collectFormControlConicTiles` rasterizes
  // each conic layer at exactly the rect the synth fills.
  const { styledTrack, styledThumb, trackThickness, thumbW, thumbH, thumbRadius } = rangeMetricSizes(s);
  if (
    !styledTrack ||
    !styledThumb ||
    ![trackThickness, thumbW, thumbH, thumbRadius].every(Number.isFinite) ||
    trackThickness < 0 ||
    thumbW <= 0 ||
    thumbH <= 0 ||
    thumbRadius < 0
  )
    return "";
  const trackR = parseFloat(s.rangeTrackRadius ?? "") || 0;
  const trackBgColor = s.rangeTrackBg != null && s.rangeTrackBg !== "" ? s.rangeTrackBg : "none";
  const valStr = s.inputValue;
  const minStr = s.inputMin;
  const maxStr = s.inputMax;
  const val = valStr != null && valStr !== "" ? parseFloat(valStr) : NaN;
  const min = minStr != null && minStr !== "" ? parseFloat(minStr) : 0;
  const max = maxStr != null && maxStr !== "" ? parseFloat(maxStr) : 100;
  const ratio = !isNaN(val) && max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
  const isVertical = s.writingMode != null && s.writingMode !== "" && s.writingMode !== "horizontal-tb";
  const parts: string[] = [];

  // Geometry: in horizontal mode the track is along x (length = el.width),
  // thumb moves in x. In vertical mode track is along y (length = el.height),
  // thumb moves in y. `direction: rtl` flips the value axis so low is at
  // the visual end of the track (right for horizontal, bottom for vertical).
  // Round box edges to integer device pixels (DM-433) so the track / fill
  // rects land on Chrome's pixel grid. `getBoundingClientRect()` returns
  // fractional coords for inputs
  // laid out in flex / inline contexts; without rounding, even-thickness
  // tracks render across 3 antialiased rows instead of 2 solid rows.
  const elL = Math.round(el.x);
  const elT = Math.round(el.y);
  const elR = Math.round(el.x + el.width);
  const elW = elR - elL;
  const elH = Math.round(el.y + el.height) - elT;
  let trackRect: { x: number; y: number; w: number; h: number };
  let thumbCx: number;
  let thumbCy: number;

  // The captured structural track spans the host axis. The thumb travels over
  // that source box minus its own captured size, matching Blink's
  // SliderThumbElement track-content calculation.
  if (isVertical) {
    const halfThumb = thumbH / 2;
    const trackX = elL + elW / 2 - trackThickness / 2;
    const thumbTravelTop = elT + halfThumb;
    const thumbTravelBottom = elT + elH - halfThumb;
    const lowAtBottom = s.direction === "rtl";
    const fromTop = lowAtBottom ? 1 - ratio : ratio;
    thumbCx = elL + elW / 2;
    thumbCy = thumbTravelTop + (thumbTravelBottom - thumbTravelTop) * fromTop;
    trackRect = { x: trackX, y: elT, w: trackThickness, h: elH };
  } else {
    const halfThumb = thumbW / 2;
    const cy = elT + elH / 2;
    const trackY = cy - trackThickness / 2;
    const thumbTravelLeft = elL + halfThumb;
    const thumbTravelRight = elR - halfThumb;
    thumbCy = cy;
    thumbCx = thumbTravelLeft + (thumbTravelRight - thumbTravelLeft) * ratio;
    trackRect = { x: elL, y: trackY, w: elW, h: trackThickness };
  }

  const trackBorder = parseBorderShorthand(s.rangeTrackBorder);
  const trackShadow = (kind: "outer" | "inset"): string[] =>
    pseudoBoxShadowMarkup(
      kind,
      s.rangeTrackBoxShadow,
      trackRect,
      Math.min(trackR, trackRect.w / 2, trackRect.h / 2),
      trackBorder?.width ?? 0,
      indent,
      defCtx,
    );
  parts.push(...trackShadow("outer"));
  const trackFills = gradientLayerFills(s.rangeTrackBgImage, trackRect, defCtx, "::-webkit-slider-runnable-track");
  const trackGradFill = trackFills.fills.at(-1) ?? null;
  const trackLayerShape = (fill: string): string =>
    `${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(trackR)}" fill="${fill}" />`;
  // CSS background layering: the color paints under the gradient layers, so
  // a repeating gradient with transparent stops (e.g. a tick-marks track)
  // reveals it between stripes (DM-275).
  parts.push(...underlayerShapes(trackFills, styledTrack ? (s.rangeTrackBg ?? null) : null, trackLayerShape));
  const trackFill = trackGradFill ?? trackBgColor;
  const trackStroke = trackBorder == null ? "" : ` stroke="${trackBorder.color}" stroke-width="${trackBorder.width}"`;
  parts.push(
    `${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(trackR)}" fill="${trackFill}"${trackStroke} />`,
  );
  // Inset shadows are clipped to the padding box, so painting them after the
  // path-centered border stroke cannot overlap it.
  parts.push(...trackShadow("inset"));
  // Parse the captured author thumb border (e.g. "2px solid white"). A missing
  // border remains missing; native thumbs never reach this branch.
  const thumbBorder = parseBorderShorthand(s.rangeThumbBorder);
  // Captured non-square/small-radius thumbs render as rects; a full-radius
  // square renders as a circle.
  if (styledThumb && (thumbH !== thumbW || thumbRadius < Math.min(thumbW, thumbH) / 2)) {
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" ? s.rangeThumbBg : "none";
    const thumbRect = { x: thumbCx - thumbW / 2, y: thumbCy - thumbH / 2, w: thumbW, h: thumbH };
    const thumbFills = gradientLayerFills(s.rangeThumbBgImage, thumbRect, defCtx, "::-webkit-slider-thumb");
    const thumbFill = thumbFills.fills.at(-1) ?? thumbBgColor;
    const strokeAttrs = thumbBorder != null ? ` stroke="${thumbBorder.color}" stroke-width="${thumbBorder.width}"` : "";
    const thumbShadow = (kind: "outer" | "inset"): string[] =>
      pseudoBoxShadowMarkup(
        kind,
        s.rangeThumbBoxShadow,
        thumbRect,
        Math.min(thumbRadius, thumbW / 2, thumbH / 2),
        thumbBorder?.width ?? 0,
        indent,
        defCtx,
      );
    parts.push(...thumbShadow("outer"));
    parts.push(
      ...underlayerShapes(
        thumbFills,
        s.rangeThumbBg ?? null,
        (fill) =>
          `${indent}<rect x="${r(thumbRect.x)}" y="${r(thumbRect.y)}" width="${r(thumbW)}" height="${r(thumbH)}" rx="${r(thumbRadius)}" fill="${fill}" />`,
      ),
    );
    parts.push(
      `${indent}<rect x="${r(thumbRect.x)}" y="${r(thumbRect.y)}" width="${r(thumbW)}" height="${r(thumbH)}" rx="${r(thumbRadius)}" fill="${thumbFill}"${strokeAttrs} />`,
    );
    parts.push(...thumbShadow("inset"));
  } else if (styledThumb) {
    const halfThumb = thumbW / 2;
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" ? s.rangeThumbBg : "none";
    const thumbRect = { x: thumbCx - halfThumb, y: thumbCy - halfThumb, w: thumbW, h: thumbW };
    const thumbFills = gradientLayerFills(s.rangeThumbBgImage, thumbRect, defCtx, "::-webkit-slider-thumb");
    const thumbFill = thumbFills.fills.at(-1) ?? thumbBgColor;
    // Outer shadows paint below the thumb (CSS paint order: shadow ->
    // background -> border). A spread-only shadow is the "donut ring" author
    // pattern (`box-shadow: 0 0 0 Npx <color>`, stacked rings included); the
    // general painter outsets the full-radius corners, so it stays a circle.
    // SVG's `stroke` is path-centered, so to keep the border drawn ENTIRELY
    // inside the thumb's box (Chrome's behavior), we shrink the inner-fill
    // circle's path radius by `borderWidth/2`, putting the stroke band between
    // r=halfThumb-border and r=halfThumb.
    const thumbShadow = (kind: "outer" | "inset"): string[] =>
      pseudoBoxShadowMarkup(kind, s.rangeThumbBoxShadow, thumbRect, halfThumb, thumbBorder?.width ?? 0, indent, defCtx);
    parts.push(...thumbShadow("outer"));
    // Lower layers fill the whole border box; the top shape's border stroke
    // still paints over them.
    parts.push(
      ...underlayerShapes(
        thumbFills,
        s.rangeThumbBg ?? null,
        (fill) => `${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(halfThumb)}" fill="${fill}" />`,
      ),
    );
    if (thumbBorder != null) {
      const innerR = Math.max(0, halfThumb - thumbBorder.width / 2);
      parts.push(
        `${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(innerR)}" fill="${thumbFill}" stroke="${thumbBorder.color}" stroke-width="${thumbBorder.width}" />`,
      );
    } else {
      parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(halfThumb)}" fill="${thumbFill}" />`);
    }
    parts.push(...thumbShadow("inset"));
  }
  return parts.join("\n");
}

/** Parse a CSS `border` shorthand like `"2px solid white"` into a width/color
 *  pair. Returns null when the input is missing, "none", or unparseable. */
function parseBorderShorthand(border: string | undefined): { width: number; color: string } | null {
  if (border == null || border === "" || /\bnone\b/.test(border)) return null;
  const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(border.trim());
  if (m == null || m[2] === "none") return null;
  const w = parseFloat(m[1]);
  if (!isFinite(w) || w <= 0) return null;
  return { width: w, color: m[3] };
}

function renderColorSwatch(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  const tokens = s.colorSwatchWrapperPadding
    ?.trim()
    .split(/\s+/)
    .map((part) => parseFloat(part));
  if (tokens == null || tokens.length < 1 || tokens.length > 4 || tokens.some((part) => !Number.isFinite(part)))
    return "";
  const top = tokens[0];
  const right = tokens.length === 1 ? tokens[0] : tokens[1];
  const bottom = tokens.length < 3 ? tokens[0] : tokens[2];
  const left = tokens.length < 2 ? tokens[0] : tokens.length < 4 ? tokens[1] : tokens[3];
  const swatchRect = {
    x: el.x + left,
    y: el.y + top,
    w: el.width - left - right,
    h: el.height - top - bottom,
  };
  if (swatchRect.w <= 0 || swatchRect.h <= 0) return "";
  const swatchFills = gradientLayerFills(s.colorSwatchBgImage, swatchRect, defCtx, "::-webkit-color-swatch");
  const swatchGrad = swatchFills.fills.at(-1) ?? null;
  const value = /^#[0-9a-f]{6}$/i.test(s.inputValue ?? "") ? s.inputValue : undefined;
  const swatchFill = swatchGrad ?? (s.colorSwatchBg != null && s.colorSwatchBg !== "" ? s.colorSwatchBg : value);
  if (swatchFill == null) return "";
  const radius = s.colorSwatchRadius != null && s.colorSwatchRadius !== "" ? parseFloat(s.colorSwatchRadius) || 0 : 0;
  // Border on the swatch (e.g. authors set ::-webkit-color-swatch { border: 2px solid gray }).
  let borderAttrs = "";
  if (s.colorSwatchBorder != null && s.colorSwatchBorder !== "") {
    const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(s.colorSwatchBorder);
    if (m != null && m[2] !== "none") {
      borderAttrs = ` stroke="${m[3]}" stroke-width="${m[1]}"`;
    }
  }
  const swatchShape = (fill: string, attrs = ""): string =>
    `${indent}<rect x="${r(swatchRect.x)}" y="${r(swatchRect.y)}" width="${r(swatchRect.w)}" height="${r(swatchRect.h)}" rx="${r(radius)}" fill="${fill}"${attrs} />`;
  return [
    ...underlayerShapes(swatchFills, s.colorSwatchBg ?? null, swatchShape),
    swatchShape(swatchFill, borderAttrs),
  ].join("\n");
}

/** Paint captured author `::file-selector-button` outset-shadow overflow. */
export function renderFileSelectorOutsetShadow(
  el: CapturedElement,
  indent: string,
  defCtx?: DefCtx,
  overflowOnly = false,
): string {
  const button = el.styles.fileSelectorButton;
  if (button == null || button.boxShadow === "" || button.boxShadow === "none") return "";
  const shadows = parseBoxShadow(button.boxShadow).filter((shadow) => !shadow.inset);
  if (shadows.length === 0) return "";

  let clipAttr = "";
  if (defCtx != null) {
    const clipId = defCtx.nextGradId();
    const hostPath = `M${r(el.x)},${r(el.y)}h${r(el.width)}v${r(el.height)}h${r(-el.width)}Z`;
    const buttonHole = overflowOnly
      ? `M${r(button.x)},${r(button.y)}h${r(button.width)}v${r(button.height)}h${r(-button.width)}Z`
      : "";
    defCtx.defsParts.push(
      `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${hostPath}${buttonHole}" clip-rule="evenodd" fill-rule="evenodd"/></clipPath>`,
    );
    clipAttr = ` clip-path="url(#${clipId})"`;
  }

  const rawRadius = parseFloat(button.borderRadius) || 0;
  const out: string[] = [];
  for (let i = shadows.length - 1; i >= 0; i--) {
    const shadow = shadows[i];
    const x = button.x + shadow.x - shadow.spread;
    const y = button.y + shadow.y - shadow.spread;
    const width = Math.max(0, button.width + shadow.spread * 2);
    const height = Math.max(0, button.height + shadow.spread * 2);
    if (width <= 0 || height <= 0) continue;
    const radius = Math.max(0, Math.min(rawRadius + shadow.spread, width / 2, height / 2));
    let filterAttr = "";
    if (shadow.blur > 0 && defCtx != null) {
      const filterId = defCtx.nextGradId();
      const pad = Math.max(1, shadow.blur * 2);
      defCtx.defsParts.push(
        emitGaussianBlurFilter(filterId, shadow.blur, {
          region: { x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 },
        }),
      );
      filterAttr = ` filter="url(#${filterId})"`;
    }
    out.push(
      `${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" rx="${r(radius)}" fill="${esc(shadow.color)}"${filterAttr}${clipAttr}/>`,
    );
  }
  return out.join("\n");
}

/** Emit the actual closed-shadow status span through the normal shaped-text
 * renderer, preserving localized/multiple text, bidi, writing mode and clip. */
function renderCapturedFileStatus(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const status = el.styles.fileSelectorStatus;
  if (status == null || status.text === "") return "";
  const statusEl: CapturedElement = {
    ...el,
    tag: "span",
    text: status.text,
    x: status.x,
    y: status.y,
    width: status.width,
    height: status.height,
    children: [],
    textSegments: status.textSegments,
    fontAscent: status.fontAscent,
    fontDescent: status.fontDescent,
    nativeControlRaster: undefined,
    nativeControlDecorationRaster: undefined,
    styles: {
      ...el.styles,
      color: status.color,
      fontSize: `${status.fontSize}px`,
      fontFamily: status.fontFamily,
      fontFamilyStack: status.fontFamilyStack,
      fontWeight: status.fontWeight,
      fontStyle: status.fontStyle,
      writingMode: status.writingMode,
      textOrientation: status.textOrientation,
      direction: status.direction,
    },
  };

  let clipId = `${defCtx?.idPrefix ?? "dm"}file-status`;
  if (defCtx != null) {
    clipId = defCtx.nextGradId();
    const bt = parseFloat(el.styles.borderTopWidth) || 0;
    const br = parseFloat(el.styles.borderRightWidth) || 0;
    const bb = parseFloat(el.styles.borderBottomWidth) || 0;
    const bl = parseFloat(el.styles.borderLeftWidth) || 0;
    defCtx.defsParts.push(
      `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect x="${r(el.x + bl)}" y="${r(el.y + bt)}" width="${r(Math.max(0, el.width - bl - br))}" height="${r(Math.max(0, el.height - bt - bb))}"/></clipPath>`,
    );
  }

  const vertical = hasVerticalSegments(statusEl);
  let body = vertical
    ? renderVerticalSegments(statusEl, status.color)
    : renderMultiSegmentText(
        {
          el: statusEl,
          idPrefix: defCtx?.idPrefix ?? "dm",
          clipId,
          fillColor: status.color,
          overflowClip: defCtx != null,
        },
        status.textSegments,
      );
  if (body === "") {
    body = renderTextAsPath(status.text, status.x, status.y, {
      fontSize: status.fontSize,
      fontWeight: status.fontWeight,
      fontFamily: capturedFontFamilyCss(status.fontFamily, status.fontFamilyStack),
      fontStyle: status.fontStyle,
      fill: status.color,
      ascentOverride: status.fontAscent,
    });
  } else if (vertical && defCtx != null) {
    body = `<g clip-path="url(#${clipId})">${body}</g>`;
  }
  return body
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * <input type=file>: emit only the captured author-owned button and the
 * Chromium closed-shadow status text. No localized label, geometry, palette,
 * or font is invented when either source record is absent.
 */
function renderFileInput(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  if (el.width <= 2 || el.height <= 2 || s.opacity === "0") return "";
  const statusMarkup = renderCapturedFileStatus(el, indent, defCtx);
  // A reservation is authoritative even when its Chromium surface failed.
  if (el.nativeControlDecorationRaster?.kinds.includes("file-selector-button") === true) {
    return statusMarkup;
  }
  const button = s.fileSelectorButton;
  if (button == null) return statusMarkup;
  const background = s.fileButtonBg;
  const border = parseBorderShorthand(s.fileButtonBorder);
  // Missing source paint is not permission to substitute UA button colors.
  if ((background == null || background === "") && border == null) return statusMarkup;
  const parts: string[] = [];
  const shadow = renderFileSelectorOutsetShadow(el, indent, defCtx);
  if (shadow !== "") parts.push(shadow);
  const rawRadius = parseFloat(button.borderRadius);
  const radius = Number.isFinite(rawRadius) ? Math.max(0, Math.min(rawRadius, button.width / 2, button.height / 2)) : 0;
  const strokeAttrs = border == null ? "" : ` stroke="${border.color}" stroke-width="${r(border.width)}"`;
  parts.push(
    `${indent}<rect x="${r(button.x)}" y="${r(button.y)}" width="${r(button.width)}" height="${r(button.height)}" rx="${r(radius)}" fill="${background ?? "none"}"${strokeAttrs} />`,
  );
  const ascent = (button.height - button.fontAscent - button.fontDescent) / 2 + button.fontAscent;
  const labelPath = renderTextAsPath(button.text, button.x + (button.width - button.textWidth) / 2, button.y, {
    fontSize: button.fontSize,
    fontWeight: button.fontWeight,
    fontFamily: capturedFontFamilyCss(button.fontFamily, button.fontFamilyStack),
    fontStyle: button.fontStyle,
    fill: button.color,
    targetWidth: button.textWidth,
    ascentOverride: ascent,
  });
  parts.push(`${indent}${labelPath}`);
  if (statusMarkup !== "") parts.push(statusMarkup);
  return parts.join("\n");
}

function capturedPseudoColor(bg: string | undefined): string | null {
  return isPaintedColor(bg) ? bg : null;
}

function renderProgress(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const { trackRect, valueRect } = progressBarGeom(el);
  const parts: string[] = [];
  const trackColor = capturedPseudoColor(el.styles.progressBarBg);
  const trackFills = gradientLayerFills(el.styles.progressBarBgImage, trackRect, defCtx, "::-webkit-progress-bar");
  const trackGradient = trackFills.fills.at(-1) ?? null;
  if (trackColor != null || trackGradient != null) {
    const radius = Math.max(0, parseFloat(el.styles.progressBarRadius ?? "") || 0);
    parts.push(
      ...underlayerShapes(
        trackFills,
        trackColor,
        (fill) =>
          `${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(radius)}" fill="${fill}" />`,
      ),
    );
    parts.push(
      `${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(radius)}" fill="${trackGradient ?? trackColor!}" />`,
    );
  }
  if (valueRect != null) {
    const valueColor = capturedPseudoColor(el.styles.progressValueBg);
    const valueFills = gradientLayerFills(
      el.styles.progressValueBgImage,
      valueRect,
      defCtx,
      "::-webkit-progress-value",
    );
    const valueGradient = valueFills.fills.at(-1) ?? null;
    if (valueColor != null || valueGradient != null) {
      const radius = Math.max(0, parseFloat(el.styles.progressValueRadius ?? "") || 0);
      parts.push(
        ...underlayerShapes(
          valueFills,
          valueColor,
          (fill) =>
            `${indent}<rect x="${r(valueRect.x)}" y="${r(valueRect.y)}" width="${r(valueRect.w)}" height="${r(valueRect.h)}" rx="${r(radius)}" fill="${fill}" />`,
        ),
      );
      parts.push(
        `${indent}<rect x="${r(valueRect.x)}" y="${r(valueRect.y)}" width="${r(valueRect.w)}" height="${r(valueRect.h)}" rx="${r(radius)}" fill="${valueGradient ?? valueColor!}" />`,
      );
    }
  }
  return parts.join("\n");
}

function renderMeter(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  const value = s.meterValue ?? 0;
  const min = s.meterMin ?? 0;
  const max = s.meterMax ?? 1;
  const low = s.meterLow ?? min;
  const high = s.meterHigh ?? max;
  const optimum = s.meterOptimum ?? (min + max) / 2;
  const region = (candidate: number): 0 | 1 | 2 => (candidate < low ? 0 : candidate > high ? 2 : 1);
  const distance = Math.abs(region(value) - region(optimum));
  const valueColor =
    distance === 0
      ? capturedPseudoColor(s.meterOptimumBg)
      : distance === 1
        ? capturedPseudoColor(s.meterSuboptimumBg)
        : capturedPseudoColor(s.meterEvenLessGoodBg);
  const geometry = meterBarGeom(el);
  const track = geometry.trackRect;
  const parts: string[] = [];
  // The bar is an ordinary box in Blink (BoxPainter): outer shadow,
  // background, inset shadow, border, then its overflow-clipped child value.
  // Its shadow and border go through the same painters as an element's box,
  // on a synthetic box carrying the bar's captured final longhands.
  const radiusPx = `${Math.max(0, parseFloat(s.meterBarRadius ?? "") || 0)}px`;
  const sides = meterBarBorderSides(s);
  const bw = meterBarBorderWidths(s);
  const barBox: CapturedElement = {
    ...el,
    x: track.x,
    y: track.y,
    width: track.w,
    height: track.h,
    children: [],
    fieldsetLegendNotch: undefined,
    styles: {
      ...s,
      borderImageSource: "none",
      borderCollapse: "separate",
      collapsedBorderRects: undefined,
      borderTopWidth: `${bw.top}px`,
      borderRightWidth: `${bw.right}px`,
      borderBottomWidth: `${bw.bottom}px`,
      borderLeftWidth: `${bw.left}px`,
      borderTopStyle: sides?.top.style ?? "none",
      borderRightStyle: sides?.right.style ?? "none",
      borderBottomStyle: sides?.bottom.style ?? "none",
      borderLeftStyle: sides?.left.style ?? "none",
      borderTopColor: sides?.top.color ?? TRANSPARENT_BLACK,
      borderRightColor: sides?.right.color ?? TRANSPARENT_BLACK,
      borderBottomColor: sides?.bottom.color ?? TRANSPARENT_BLACK,
      borderLeftColor: sides?.left.color ?? TRANSPARENT_BLACK,
      borderRadius: radiusPx,
      borderTopLeftRadius: radiusPx,
      borderTopRightRadius: radiusPx,
      borderBottomRightRadius: radiusPx,
      borderBottomLeftRadius: radiusPx,
      cornerTopLeftShape: undefined,
      cornerTopRightShape: undefined,
      cornerBottomRightShape: undefined,
      cornerBottomLeftShape: undefined,
      boxShadow: s.meterBarBoxShadow ?? "none",
    },
  };
  // parseCornerRadii applies CSS corner-overlap scaling, so the UA-sized
  // radius on a short bar stays circular instead of an SVG rx/ry ellipse.
  const corners = parseCornerRadii(barBox.styles, track.w, track.h);
  const paintCtx: PaintCtx | null =
    defCtx == null
      ? null
      : {
          svgParts: parts,
          defsParts: defCtx.defsParts,
          idPrefix: defCtx.idPrefix,
          nextClipId: () => defCtx.nextGradId(),
          // Only renderBorderImage reads the shared counter, and the bar never
          // carries a border-image.
          peekClipIdx: () => 0,
          advanceClipIdx: () => undefined,
          emittedTextCtm: new WeakMap(),
        };
  if (paintCtx != null) paintBoxShadow(paintCtx, barBox, corners, indent);
  const trackShape = (fill: string): string =>
    `${indent}${roundedRectSvg(track.x, track.y, track.w, track.h, corners, `fill="${fill}"`)}`;
  const trackColor = capturedPseudoColor(s.meterBarBg);
  const trackFills = gradientLayerFills(s.meterBarBgImage, track, defCtx, "::-webkit-meter-bar");
  const trackGradient = trackFills.fills.at(-1) ?? null;
  if (trackColor != null || trackGradient != null) {
    parts.push(...underlayerShapes(trackFills, trackColor, trackShape));
    parts.push(trackShape(trackGradient ?? trackColor!));
  }
  if (paintCtx != null) {
    paintInsetBoxShadow(paintCtx, barBox, corners, indent);
    paintBorder(paintCtx, barBox, indent, corners, track.w, track.h, 0, null, false, false, new Set<CapturedElement>());
  }
  if (geometry.valueRect != null) {
    const valueRect = geometry.valueRect;
    const valueFills = gradientLayerFills(geometry.valueBgImage, valueRect, defCtx, "meter value pseudo");
    const valueGradient = valueFills.fills.at(-1) ?? null;
    if (valueColor != null || valueGradient != null) {
      // html.css gives the bar `overflow: hidden`, so the value paints inside
      // the bar's rounded padding box (outer radii pulled in by each border).
      const inner = {
        x: track.x + bw.left,
        y: track.y + bw.top,
        w: Math.max(0, track.w - bw.left - bw.right),
        h: Math.max(0, track.h - bw.top - bw.bottom),
      };
      const innerCorners = insetCornerRadii(corners, bw.top, bw.right, bw.bottom, bw.left);
      let clipAttr = "";
      let valueRadius = 0;
      if (defCtx != null) {
        const clipId = defCtx.nextGradId();
        defCtx.defsParts.push(
          `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${roundedRectSvg(inner.x, inner.y, inner.w, inner.h, innerCorners, "")}</clipPath>`,
        );
        clipAttr = ` clip-path="url(#${clipId})"`;
      } else {
        valueRadius = Math.min(innerCorners.tl.h, valueRect.w / 2, valueRect.h / 2);
      }
      const valueShape = (fill: string): string =>
        `${indent}<rect x="${r(valueRect.x)}" y="${r(valueRect.y)}" width="${r(valueRect.w)}" height="${r(valueRect.h)}" rx="${r(valueRadius)}" fill="${fill}"${clipAttr} />`;
      parts.push(...underlayerShapes(valueFills, valueColor, valueShape));
      parts.push(valueShape(valueGradient ?? valueColor!));
    }
  }
  return parts.join("\n");
}

/** Render listbox rows only from browser-resolved option geometry/paint. */
function renderListbox(el: CapturedElement, indent: string): string {
  const opts = el.styles.selectListboxOptions;
  if (opts == null || opts.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const measured =
      o.x != null &&
      o.y != null &&
      o.width != null &&
      o.height != null &&
      o.fontAscent != null &&
      o.width > 0 &&
      o.height > 0;
    if (!measured) continue;
    const rx = el.x + o.x!;
    const ry = el.y + o.y!;
    const rw = o.width!;
    const rh = o.height!;
    if (ry >= el.y + el.height - 0.01) continue;
    const selectedFill = capturedPseudoColor(o.backgroundColor);
    if (selectedFill != null) {
      const visibleHeight = Math.min(rh, el.y + el.height - ry);
      parts.push(
        `${indent}<rect x="${r(rx)}" y="${r(ry)}" width="${r(rw)}" height="${r(visibleHeight)}" fill="${selectedFill}" />`,
      );
    }
    const optionFontSize = o.fontSize ?? parseFloat(el.styles.fontSize ?? "");
    const fontFamily =
      o.fontFamily != null
        ? capturedFontFamilyCss(o.fontFamily, o.fontFamilyStack)
        : capturedFontFamilyCss(el.styles.fontFamily, el.styles.fontFamilyStack);
    const color = o.color ?? el.styles.color;
    if (!Number.isFinite(optionFontSize) || optionFontSize <= 0 || fontFamily == null || color == null) continue;
    const tx = rx + (o.paddingLeft ?? 0);
    const ty = ry + (o.paddingTop ?? 0) + o.fontAscent!;
    const fontStyle = o.fontStyle ?? "normal";
    const fontWeight = o.fontWeight ?? "400";
    const fontStyleAttr = fontStyle !== "normal" ? ` font-style="${fontStyle}"` : "";
    const fontWeightAttr = fontWeight !== "normal" && fontWeight !== "400" ? ` font-weight="${fontWeight}"` : "";
    const escaped = esc(o.text);
    parts.push(
      `${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(optionFontSize)}" font-family="${fontFamily.replace(/"/g, "&quot;")}" fill="${color}"${fontStyleAttr}${fontWeightAttr}>${escaped}</text>`,
    );
  }
  return parts.join("\n");
}

function renderSelectContent(el: CapturedElement, indent: string): string {
  const parts: string[] = [];
  // Selected-option text inside the closed dropdown's content rect (DM-246).
  // Chrome paints `selectedOptions[0]?.textContent` here; option/optgroup
  // children are otherwise textIsHiddenFallback and don't reach the renderer.
  const display = el.styles.selectDisplayText;
  if (display != null && display !== "") {
    const fontSize = parseFloat(el.styles.fontSize ?? "");
    const fontFamily = capturedFontFamilyCss(el.styles.fontFamily, el.styles.fontFamilyStack);
    const color = el.styles.color;
    const ascent = el.fontAscent;
    const descent = el.fontDescent;
    if (
      !Number.isFinite(fontSize) ||
      fontSize <= 0 ||
      fontFamily == null ||
      color == null ||
      ascent == null ||
      descent == null
    )
      return "";
    // Anchor the display text at the element's content-box left edge.
    // Pages style selects with `appearance: none; padding: 8px 34px 8px 12px`
    // and similar — the previous hardcoded `el.x + 6` ignored the captured
    // padding, so styled selects rendered the text 6-12px too far left
    // (DM-341). The route requires the resolved structural metrics; native
    // menulists never reach this helper.
    const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
    const padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
    const padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
    const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
    const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
    const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
    const measured = el.styles.selectDisplayTextGeometry;
    const tx = measured?.x ?? el.x + bwL + padL;
    const contentH = Math.max(0, el.height - bwT - bwB - padT - padB);
    // `-internal-select-inner-element` owns the shown option's line box in
    // Blink, including the UA's used line-height. Its Range top plus the
    // UA-shadow node's captured ascent is therefore the browser's baseline. Rebuilding
    // it by centering the font bounding box loses half-leading (and differs
    // across the native/base/appearance:none select routes). Keep that
    // arithmetic for old captures that predate the UA-shadow geometry field.
    const ty =
      measured?.y != null
        ? measured.y + measured.fontAscent
        : el.y + bwT + padT + Math.max(0, (contentH - ascent - descent) / 2) + ascent;
    const escaped = esc(display);
    parts.push(
      `${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="${fontFamily.replace(/"/g, "&quot;")}" font-weight="${el.styles.fontWeight ?? "400"}" fill="${color}">${escaped}</text>`,
    );
  }
  // Chromium's base-select UA style generates ::picker-icon as a disclosure
  // counter and pushes it to the inline end with margin-inline-start:auto.
  // It is structural paint, unlike the platform-owned menulist arrow sampled
  // by nativeControlDecorationRaster. Use the select's resolved currentColor,
  // which is also what the pseudo inherits unless the author overrides it.
  if (el.styles.selectChevron === true && el.nativeControlDecorationRaster == null) {
    const color = el.styles.selectChevronColor ?? el.styles.color;
    if (color != null) {
      const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
      const padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
      const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
      const padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
      const fontSizePx = fontSizeOrDefault(el.styles.fontSize);
      // `::picker-icon` is generated content `counter(..., disclosure-open)` pushed to the inline end
      // (html.css, `select::picker-icon`), and a disclosure counter is painted as a symbol marker, not a
      // glyph: a triangle in a square of 0.66 x font-size whose bottom sits on the baseline
      // (`ListMarker::RelativeSymbolMarkerRect`, core/layout/list/list_marker.cc, rev 7d859f27; the geometry
      // is shared with `<details>` markers in list-marker-geometry.ts). Measured against Chromium at four
      // font/padding combinations: the icon's right edge is the content-box edge, and its top is the line
      // top plus the truncated ascent minus the square's size.
      // The select's own ascent is not captured (its text lives in the UA shadow), so use the UA-shadow
      // text's; its Range top is the text line's top for the same first-line box the icon shares.
      const shadow = el.styles.selectDisplayTextGeometry;
      const ascent =
        shadow?.fontAscent ?? (el.fontAscent != null && el.fontAscent > 0 ? el.fontAscent : fontSizePx * 0.8);
      const descent = el.fontDescent != null && el.fontDescent > 0 ? el.fontDescent : fontSizePx * 0.2;
      const contentTop = el.y + bwT + padT;
      const contentH = Math.max(0, el.height - bwT - bwB - padT - padB);
      const lineH = el.normalLineHeight ?? ascent + descent;
      const lineTop = shadow?.y != null ? shadow.y : contentTop + Math.max(0, (contentH - lineH) / 2);
      const geometry = blinkSymbolMarkerGeometry(ascent, fontSizePx, "disclosure-open");
      const rtl = el.styles.direction === "rtl";
      const rect = {
        x: rtl ? el.x + bwL + padL : el.x + el.width - bwR - padR - geometry.inlineSize,
        y: lineTop + geometry.blockOffset,
        width: geometry.inlineSize,
        height: geometry.blockSize,
      };
      const points = disclosureTriangle(rect, "disclosure-open", el.styles.writingMode ?? "horizontal-tb", "ltr");
      parts.push(`${indent}<polygon points="${points}" fill="${color}" />`);
    }
  }
  return parts.join("\n");
}
