/**
 * Native form-control chrome synthesis.
 *
 * Emulates the default appearance of Chromium on macOS for controls that
 * don't round-trip through pure DOM capture — radios, checkboxes, progress
 * bars, meters, select chevrons, and details disclosure triangles.
 *
 * These are the visible details that a bare <rect> + text capture misses.
 * For controls that authors have styled (background/border set to non-default
 * via CSS), the capture path already handles them; we only paint on top when
 * the captured element's appearance is essentially the UA default.
 */

import type { CapturedElement } from "../capture/types.js";
import { buildLinearGradientDef, buildRadialGradientDef, gradientCacheKey, parseGradient } from "./gradients.js";
import { r } from "./format.js";

/** Chrome's UA-default inset for the colored value bar inside a `<progress>` /
 *  `<meter>` groove: `floor(barHeight / 4)` on each edge (sampled from
 *  Chrome-on-macOS paint). DM-1434 — named so the five call sites agree. */
const uaBarInset = (barHeight: number): number => Math.floor(barHeight / 4);

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
    id: string, layer: string, x: number, y: number, w: number, h: number, sizeCss: string, posCss: string,
  ) => string;
  /**
   * DM-553: page-level color-scheme propagated from the captured tree's root
   * (`elements[0].styles.rootColorScheme`). The form-control synthesizers
   * resolve their stock palette via `stockPalette(defCtx?.colorScheme)` so
   * unstyled controls under `colorScheme: 'dark'` paint with dark borders /
   * fills / accent track instead of the light defaults. Author-styled paths
   * are unchanged — only the no-author-CSS stock path picks scheme-aware
   * colors. Defaults to `"light"` when missing for back-compat with pre-
   * DM-552 captures.
   */
  colorScheme?: "light" | "dark";
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
    const def = grad.kind === "linear"
      ? buildLinearGradientDef(grad, id, rect)
      : buildRadialGradientDef(grad, id, rect);
    ctx.defsParts.push(def);
    ctx.gradientCache.set(key, id);
  }
  return `url(#${id})`;
}

/**
 * Range slider thumb/track metric sizes. Shared by `renderRange` and the conic
 * raster pre-pass (`collectFormControlConicTiles`) so a conic layer is
 * rasterized at exactly the rect the synth fills. Native UA values: Chrome
 * paints a ~6px solid track and a 16px-diameter thumb regardless of bbox height
 * (verified via probe-range-native-track.mjs); styled (`appearance: none`)
 * controls take the author width/height (DM-338).
 */
function rangeMetricSizes(s: CapturedElement["styles"]): {
  styledTrack: boolean; styledThumb: boolean; trackThickness: number; thumbW: number; thumbH: number; thumbRadius: number;
} {
  const styledTrack = s.rangeTrackBg != null;
  const styledThumb = s.rangeThumbWidth != null;
  const trackThickness = styledTrack ? (parseFloat(s.rangeTrackHeight ?? "") || 4) : 6;
  const thumbW = styledThumb ? (parseFloat(s.rangeThumbWidth ?? "") || 14) : 16;
  const thumbH = styledThumb ? (parseFloat(s.rangeThumbHeight ?? "") || thumbW) : 16;
  const thumbRadius = styledThumb ? (parseFloat(s.rangeThumbRadius ?? "") || thumbW / 2) : thumbW / 2;
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
interface FcRect { x: number; y: number; w: number; h: number }

/**
 * DM-1254: `<progress>` track + value rects, shared by `renderProgress` and the
 * conic raster collector so the conic tile is rasterized at exactly the rect the
 * synth fills (the `_conicTileCache` is keyed by `${w}x${h}`). Mirrors the inline
 * geometry renderProgress used to compute: UA-default bars inset by floor(h/4),
 * value width = el.width·ratio (determinate) or a clamped band (indeterminate).
 */
function progressBarGeom(el: CapturedElement): {
  isAuthorStyled: boolean; barY: number; barH: number; isIndeterminate: boolean; ratio: number;
  trackRect: FcRect; valueRect: FcRect | null;
} {
  const s = el.styles;
  const value = s.progressValue;
  const max = s.progressMax ?? 1;
  const isIndeterminate = value == null;
  const ratio = !isIndeterminate && max > 0 ? Math.max(0, Math.min(1, (value as number) / max)) : 0;
  const customTrackFill = customPseudoFill(s.progressBarBg, s.progressBarBgImage);
  const customValueFill = customPseudoFill(s.progressValueBg, s.progressValueBgImage);
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (s.progressBarRadius != null && s.progressBarRadius !== "0px")
    || (s.progressValueRadius != null && s.progressValueRadius !== "0px");
  const inset = uaBarInset(el.height);
  const barH = isAuthorStyled ? el.height : el.height - 2 * inset;
  const barY = isAuthorStyled ? el.y : el.y + inset;
  const trackRect: FcRect = { x: el.x, y: barY, w: el.width, h: barH };
  let valueRect: FcRect | null = null;
  if (isIndeterminate) valueRect = { x: el.x + el.width * 0.1, y: barY, w: Math.min(el.width * 0.25, 60), h: barH };
  else if (ratio > 0) valueRect = { x: el.x, y: barY, w: el.width * ratio, h: barH };
  return { isAuthorStyled, barY, barH, isIndeterminate, ratio, trackRect, valueRect };
}

/**
 * DM-1254: `<meter>` track + value rects + the region-selected value bg image,
 * shared by `renderMeter` and the conic collector. The `trackRect` matches the
 * rect renderMeter passes to `gradientFillFor` (NOT the pixel-snapped drawn
 * groove rect). The `valueRect` differs between native-groove and author-styled
 * meters (mirrored here); the region (optimum/suboptimum/even-less-good) picks
 * which value-pseudo bg image applies.
 */
function meterBarGeom(el: CapturedElement): {
  isAuthorStyled: boolean; barY: number; barH: number; ratio: number;
  trackRect: FcRect; valueRect: FcRect | null; valueBgImage: string | undefined;
} {
  const s = el.styles;
  const value = s.meterValue ?? 0;
  const min = s.meterMin ?? 0;
  const max = s.meterMax ?? 1;
  const low = s.meterLow ?? min;
  const high = s.meterHigh ?? max;
  const optimum = s.meterOptimum ?? (min + max) / 2;
  const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const region = (v: number): 0 | 1 | 2 => (v < low ? 0 : v > high ? 2 : 1);
  const dist = Math.abs(region(value) - region(optimum));
  const valueBgImage = dist === 0 ? s.meterOptimumBgImage : dist === 1 ? s.meterSuboptimumBgImage : s.meterEvenLessGoodBgImage;
  const customTrackFill = customPseudoFill(s.meterBarBg, s.meterBarBgImage);
  const customValueFill = dist === 0 ? customPseudoFill(s.meterOptimumBg, s.meterOptimumBgImage)
    : dist === 1 ? customPseudoFill(s.meterSuboptimumBg, s.meterSuboptimumBgImage)
    : customPseudoFill(s.meterEvenLessGoodBg, s.meterEvenLessGoodBgImage);
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (s.meterBarRadius != null && s.meterBarRadius !== "0px");
  const inset = uaBarInset(el.height);
  const barH = isAuthorStyled ? el.height : el.height - 2 * inset;
  const barY = isAuthorStyled ? el.y : el.y + inset;
  const trackRect: FcRect = { x: el.x, y: barY, w: el.width, h: barH };
  let valueRect: FcRect | null = null;
  if (ratio > 0) {
    if (isAuthorStyled) {
      const top = Math.round(el.y);
      const fullH = Math.round(el.height);
      const vInset = uaBarInset(fullH);
      valueRect = { x: el.x, y: top + vInset, w: el.width * ratio, h: fullH - 2 * vInset };
    } else {
      const left = Math.floor(el.x);
      const top = Math.floor(barY);
      valueRect = { x: left + 1, y: top + 1, w: Math.max(0, Math.round(el.width * ratio) - 1), h: barH - 2 };
    }
  }
  return { isAuthorStyled, barY, barH, ratio, trackRect, valueRect, valueBgImage };
}

export function collectFormControlConicTiles(el: CapturedElement): Array<{ layer: string; w: number; h: number }> {
  const s = el.styles;
  const out: Array<{ layer: string; w: number; h: number }> = [];
  const isConic = (bg: string | undefined): bg is string =>
    bg != null && bg !== "" && bg !== "none" && /^(?:repeating-)?conic-gradient\(/i.test(bg.trim());
  const tag = el.tag;
  const inputType = s.inputType;
  if (tag === "input" && inputType === "range") {
    const { styledThumb, trackThickness, thumbW, thumbH, thumbRadius } = rangeMetricSizes(s);
    const elW = Math.round(el.x + el.width) - Math.round(el.x);
    const elH = Math.round(el.y + el.height) - Math.round(el.y);
    const isVertical = s.writingMode != null && s.writingMode !== "" && s.writingMode !== "horizontal-tb";
    if (isConic(s.rangeTrackBgImage)) {
      out.push({ layer: s.rangeTrackBgImage, w: isVertical ? trackThickness : elW, h: isVertical ? elH : trackThickness });
    }
    if (isConic(s.rangeThumbBgImage)) {
      // Mirror renderRange's thumb-shape branch: a non-circular / small-radius
      // styled thumb is a thumbW×thumbH rect; otherwise a thumbW-diameter circle.
      const ellipse = styledThumb && (thumbH !== thumbW || thumbRadius < Math.min(thumbW, thumbH) / 2);
      out.push({ layer: s.rangeThumbBgImage, w: thumbW, h: ellipse ? thumbH : thumbW });
    }
  } else if (tag === "input" && inputType === "color" && isConic(s.colorSwatchBgImage)) {
    // Mirror renderColorSwatch's `swatchRect`: the inner swatch is the element
    // box inset by the ::-webkit-color-swatch-wrapper padding (default 4px).
    let pad = 4;
    if (s.colorSwatchWrapperPadding != null && s.colorSwatchWrapperPadding !== "") {
      const tok = s.colorSwatchWrapperPadding.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
      if (tok.length >= 1) pad = tok[0];
    }
    out.push({ layer: s.colorSwatchBgImage, w: el.width - pad * 2, h: el.height - pad * 2 });
  } else if (tag === "progress") {
    // DM-1254: progress bar/value rects come from the shared progressBarGeom
    // (also used by renderProgress), so the conic tile size matches what's filled.
    const { trackRect, valueRect } = progressBarGeom(el);
    if (isConic(s.progressBarBgImage)) out.push({ layer: s.progressBarBgImage, w: trackRect.w, h: trackRect.h });
    if (valueRect != null && isConic(s.progressValueBgImage)) out.push({ layer: s.progressValueBgImage, w: valueRect.w, h: valueRect.h });
  } else if (tag === "meter") {
    // DM-1254: meter bar/value rects + the region-selected value bg image come
    // from the shared meterBarGeom (also used by renderMeter's gradient lookups).
    const { trackRect, valueRect, valueBgImage } = meterBarGeom(el);
    if (isConic(s.meterBarBgImage)) out.push({ layer: s.meterBarBgImage, w: trackRect.w, h: trackRect.h });
    if (valueRect != null && isConic(valueBgImage)) out.push({ layer: valueBgImage, w: valueRect.w, h: valueRect.h });
  }
  return out;
}

// ── Chromium macOS UA default palette (sampled from Playwright captures) ──
// Light values re-calibrated in DM-284; dark values added in DM-553.
// Probe methodology: paint each control with default chrome on a 1x viewport
// (with the page opted into the right scheme via `<meta name="color-scheme">`
// or `:root { color-scheme: dark }`), pixel-pick from a known position
// inside each painted region.
//
// Cross-platform (per CLAUDE.md): both palettes are macOS-only literals.
// Linux + Windows dark palettes are tracked under DM-258+ — Chromium's UA
// chrome differs slightly per platform (Linux uses Adwaita-ish defaults;
// Windows uses a cooler-toned dark palette), and each needs its own probe.
interface StockPalette {
  /** Border ring on unstyled checkbox / radio / text input. */
  border: string;
  /** Fill bg on unchecked checkbox / radio / text input. */
  fill: string;
  /** Accent (filled checkbox/radio, range thumb, range filled track, progress filled). */
  accent: string;
  /** Range track unfilled, progress unfilled. */
  trackBg: string;
  /** Track foreground (rare — used for dashes / overlays on the track). */
  trackFg: string;
  /** Meter optimum (green). */
  meterGreen: string;
  /** Meter sub-optimum (yellow). */
  meterYellow: string;
  /** Meter poor (red). */
  meterRed: string;
  /** Disabled-state border (alpha-blended with bg in light mode). */
  disabledBorder: string;
}

const STOCK_LIGHT: StockPalette = {
  border: "rgb(118,118,118)",
  fill: "rgb(255,255,255)",
  accent: "rgb(0,117,255)",
  trackBg: "rgb(239,239,239)",
  trackFg: "rgb(118,118,118)",
  meterGreen: "rgb(16,124,16)",
  meterYellow: "rgb(255,185,0)",
  meterRed: "rgb(216,59,1)",
  disabledBorder: "rgba(118,118,118,0.5)",
};

// DM-553: dark-mode UA defaults sampled from headless Chromium on macOS with
// `colorScheme: 'dark'` AND `:root { color-scheme: dark }` on the page (just
// the Playwright option isn't enough — it sets prefers-color-scheme but not
// the effective UA scheme). Border/fill/track all collapse to a single dark
// gray (rgb(59,59,59)), the accent shifts to a lighter blue
// (rgb(153,200,255)) for visibility against the dark canvas, and the meter
// states are desaturated. Disabled-border alpha increases to 0.7 to stay
// visible against the darker fill.
const STOCK_DARK: StockPalette = {
  border: "rgb(59,59,59)",
  fill: "rgb(59,59,59)",
  accent: "rgb(153,200,255)",
  trackBg: "rgb(59,59,59)",
  trackFg: "rgb(178,178,178)",
  meterGreen: "rgb(116,179,116)",
  meterYellow: "rgb(242,200,18)",
  meterRed: "rgb(232,107,86)",
  disabledBorder: "rgba(178,178,178,0.5)",
};

/**
 * DM-553: dispatch the per-scheme stock palette. `"light"` (default), missing,
 * or any value other than `"dark"` returns the light palette so today's
 * output stays byte-identical at default settings. `"dark"` returns the
 * dark palette for the form-control synthesizers to consume when rendering
 * an unstyled control on a page captured under `color-scheme: dark`.
 */
export function stockPalette(scheme: "light" | "dark" | undefined): StockPalette {
  return scheme === "dark" ? STOCK_DARK : STOCK_LIGHT;
}

// Back-compat aliases — the synthesizers below still reference the old
// constant names. These resolve to the LIGHT palette so any code that
// hasn't been routed through `stockPalette(defCtx?.colorScheme)` yet
// continues to behave as today. New synthesizer code should call
// `stockPalette(defCtx?.colorScheme)` directly and read from the returned
// object instead of importing these aliases.
const UA_BORDER = STOCK_LIGHT.border;
const UA_FILL = STOCK_LIGHT.fill;
const ACCENT_BLUE = STOCK_LIGHT.accent;
const TRACK_BG = STOCK_LIGHT.trackBg;
const TRACK_FG = STOCK_LIGHT.trackFg;
const METER_GREEN = STOCK_LIGHT.meterGreen;
const METER_YELLOW = STOCK_LIGHT.meterYellow;
const METER_RED = STOCK_LIGHT.meterRed;
const DISABLED_BORDER = STOCK_LIGHT.disabledBorder;
void UA_BORDER; void UA_FILL; void ACCENT_BLUE; void TRACK_BG; void TRACK_FG;
void METER_GREEN; void METER_YELLOW; void METER_RED; void DISABLED_BORDER;


/** Resolve CSS accent-color to a concrete fill. 'auto' (or missing) falls back
 *  to the Chromium macOS default blue (DM-553: scheme-aware via defCtx).
 *  Author-set values pass through. */
function resolveAccent(el: CapturedElement, defCtx?: DefCtx): string {
  const ac = el.styles.accentColor;
  if (ac == null || ac === "" || ac === "auto" || ac === "currentcolor") return stockPalette(defCtx?.colorScheme).accent;
  return ac;
}

/**
 * Pick the native UA color for the *unfilled* portion of a `<input type=range>`
 * track based on `accent-color`. Chrome ensures the unfilled track stays
 * visible against the accent: when the accent has relative luminance above
 * ~0.26 (CIE Y, sRGB → linear), Chrome darkens the unfilled track to
 * `rgb(59, 59, 59)` instead of the default `rgb(239, 239, 239)`. Empirical
 * probe (DM-320) of accents at 24 luminance points confirmed the threshold:
 * #888888 (Y=0.246) → light, #16a34a (Y=0.269) → dark; switch line ≈ Y=0.26.
 *
 * Returns `TRACK_BG` (light) when accent is unset / 'auto' / dark, the dark
 * variant when the accent is bright enough, and the original `TRACK_BG`
 * fallback when the color string can't be parsed.
 */
function unfilledTrackColor(accentCss: string | undefined, defCtx?: DefCtx): string {
  // DM-553: scheme-aware default — under dark mode the track is already
  // dark (rgb(59,59,59)), so the contrast-flip path collapses.
  const palette = stockPalette(defCtx?.colorScheme);
  if (accentCss == null || accentCss === "" || accentCss === "auto" || accentCss === "currentcolor") return palette.trackBg;
  // Extract sRGB triplet from rgb()/rgba() (Chrome canonicalises hex etc.).
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(accentCss);
  if (m == null) return palette.trackBg;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const Y = 0.2126 * lin(parseFloat(m[1])) + 0.7152 * lin(parseFloat(m[2])) + 0.0722 * lin(parseFloat(m[3]));
  return Y > 0.26 ? "rgb(59,59,59)" : palette.trackBg;
}

export function renderFormControl(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const tag = el.tag;
  if (tag === "input") return renderInputControl(el, indent, defCtx);
  if (tag === "progress") return renderProgress(el, indent, defCtx);
  if (tag === "meter") return renderMeter(el, indent, defCtx);
  // Closed-dropdown selects: emit the selected-option text always, but the
  // native chevron only when the page kept UA chrome (selectChevron). Pages
  // using `appearance: none` + a CSS background-image arrow get just the
  // text — the page's CSS chevron paints separately via the background-image
  // pipeline. (DM-308)
  if (tag === "select" && el.styles.selectDisplayText != null) return renderSelectChevron(el, indent, defCtx);
  if (tag === "select" && el.styles.selectListboxOptions != null) return renderListbox(el, indent);
  if (tag === "details") {
    const box = renderDetailsContentBox(el, indent);
    const marker = renderDetailsMarker(el, indent);
    return [box, marker].filter((s) => s !== "").join("\n");
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
  if (t === "checkbox") return renderCheckbox(el, indent, defCtx);
  if (t === "radio") return renderRadio(el, indent, defCtx);
  if (t === "range") return renderRange(el, indent, defCtx);
  if (t === "color") return renderColorSwatch(el, indent, defCtx);
  if (t === "file") return renderFileInput(el, indent, defCtx);
  if (t === "number") return renderNumberInput(el, indent, defCtx);
  if (t === "search") return renderSearchInput(el, indent, defCtx);
  if (t === "date" || t === "time" || t === "datetime-local" || t === "month" || t === "week") {
    return renderDatePicker(el, indent);
  }
  // text-like inputs already render via the normal border+bg path
  return "";
}

function renderCheckbox(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // appearance: none → author has opted out of UA chrome. The host's normal
  // element-rendering path already painted its bg + border with the captured
  // styles; we just overlay the :checked indicator. Switch-shape (wide,
  // pill-radius) renders as a toggle thumb instead of a checkmark. DM-285.
  if (el.styles.inputAppearance === "none") return renderCustomCheckboxOrSwitch(el, indent);
  // 13x13 square with 2px radius, blue+check when checked, dash when indeterminate.
  const palette = stockPalette(defCtx?.colorScheme);
  const size = Math.min(el.width, el.height);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const parts: string[] = [];
  const stroke = el.styles.disabled ? palette.disabledBorder : palette.border;

  const accent = resolveAccent(el, defCtx);
  if (el.styles.indeterminate === true) {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${accent}" />`);
    parts.push(`${indent}<rect x="${r(x + size * 0.2)}" y="${r(cy - size * 0.08)}" width="${r(size * 0.6)}" height="${r(size * 0.16)}" fill="#fff" />`);
  } else if (el.styles.checked === true) {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${accent}" />`);
    // Check mark path (two-segment tick).
    const p = (dx: number, dy: number): string => `${r(x + dx * size)},${r(y + dy * size)}`;
    parts.push(`${indent}<polyline points="${p(0.22, 0.55)} ${p(0.42, 0.74)} ${p(0.78, 0.3)}" fill="none" stroke="#fff" stroke-width="${r(size * 0.14)}" stroke-linecap="round" stroke-linejoin="round" />`);
  } else {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${palette.fill}" stroke="${stroke}" stroke-width="1" />`);
  }
  return parts.join("\n");
}

/**
 * Render an `appearance: none` custom checkbox or switch. Distinguishes the
 * switch shape (wide pill: aspect ratio > 1.5 + border-radius >= half-height)
 * from the rectangular checkbox shape (square-ish + border-radius < half).
 *
 * The host rect (background / border) is already painted by the normal
 * element-rendering path, so we only overlay the :checked indicator.
 */
function renderCustomCheckboxOrSwitch(el: CapturedElement, indent: string): string {
  const w = el.width;
  const h = el.height;
  const aspect = h > 0 ? w / h : 1;
  const radiusStr = el.styles.borderRadius ?? "0";
  const radius = parseFloat(radiusStr) || 0;
  const isSwitch = aspect > 1.5 && radius >= h / 2 - 1;
  if (isSwitch) {
    // Pill switch: thumb circle 2px inset from each edge, anchored left when
    // unchecked, right when checked. Thumb is white per common authoring
    // (the .sw fixture's ::before { background: white }).
    const inset = 2;
    const thumbR = (h - inset * 2) / 2;
    const cx = el.styles.checked === true
      ? el.x + el.width - inset - thumbR
      : el.x + inset + thumbR;
    const cy = el.y + el.height / 2;
    return `${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(thumbR)}" fill="#fff" />`;
  }
  // Custom checkbox. Indicator is a checkmark in the host's border color
  // (the :checked rule typically swaps both bg and border to the same
  // accent). Falls back to UA accent when the captured border is missing.
  if (el.styles.checked !== true) return "";
  const indicatorColor = el.styles.borderTopColor ?? resolveAccent(el);
  const size = Math.min(w, h);
  const cx = el.x + w / 2;
  const cy = el.y + h / 2;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const p = (dx: number, dy: number): string => `${r(x + dx * size)},${r(y + dy * size)}`;
  return `${indent}<polyline points="${p(0.22, 0.55)} ${p(0.42, 0.74)} ${p(0.78, 0.3)}" fill="none" stroke="${indicatorColor}" stroke-width="${r(Math.max(1.5, size * 0.14))}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function renderRadio(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // appearance: none → host rect already painted with author bg/border;
  // overlay only the :checked dot in the captured border color. DM-285.
  if (el.styles.inputAppearance === "none") {
    if (el.styles.checked !== true) return "";
    const size = Math.min(el.width, el.height);
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const dotColor = el.styles.borderTopColor ?? resolveAccent(el, defCtx);
    return `${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(size * 0.25)}" fill="${dotColor}" />`;
  }
  const palette = stockPalette(defCtx?.colorScheme);
  const size = Math.min(el.width, el.height);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rr = size / 2;
  const parts: string[] = [];
  const stroke = el.styles.disabled ? palette.disabledBorder : palette.border;
  const accent = resolveAccent(el, defCtx);
  if (el.styles.checked === true) {
    // Chrome's checked native radio is a donut: thin accent-colored outer
    // ring (~1px at 13px diameter), white middle, accent-colored center dot
    // (~0.5 of the radius). Three concentric circles. (DM-292)
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr)}" fill="${accent}" />`);
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr - 1)}" fill="#fff" />`);
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr * 0.5)}" fill="${accent}" />`);
  } else {
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr - 0.5)}" fill="${palette.fill}" stroke="${stroke}" stroke-width="1" />`);
  }
  return parts.join("\n");
}

function renderRange(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // DM-553: scheme-aware UA defaults — rangeUA fill / track inherit dark
  // palette when the page was captured under color-scheme: dark.
  const palette = stockPalette(defCtx?.colorScheme);
  // Horizontal track + circular thumb (UA default), or author-styled track
  // and thumb when CAPTURE_SCRIPT detected ::-webkit-slider-runnable-track
  // / ::-webkit-slider-thumb diverging from the unstyled-range reference
  // baseline (SK-1131 + SK-1137). The detection lives in CAPTURE_SCRIPT —
  // here we only react to which of rangeTrack* / rangeThumb* are populated.
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
  const trackR = styledTrack ? (parseFloat(s.rangeTrackRadius ?? "") || 0) : 2;
  // Unfilled-track color: author-set when the slider is `appearance: none` +
  // styled track, otherwise the UA default which depends on `accent-color`
  // (Chrome darkens the unfilled track when the accent is bright — DM-320).
  const trackBgColor = styledTrack && s.rangeTrackBg !== "rgba(0, 0, 0, 0)" ? s.rangeTrackBg! : unfilledTrackColor(s.accentColor, defCtx);
  const accent = resolveAccent(el, defCtx);
  const valStr = s.inputValue;
  const minStr = s.inputMin;
  const maxStr = s.inputMax;
  const val = valStr != null && valStr !== "" ? parseFloat(valStr) : NaN;
  const min = minStr != null && minStr !== "" ? parseFloat(minStr) : 0;
  const max = maxStr != null && maxStr !== "" ? parseFloat(maxStr) : 100;
  const ratio = !isNaN(val) && max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0.5;
  const isVertical = s.writingMode != null && s.writingMode !== "" && s.writingMode !== "horizontal-tb";
  const parts: string[] = [];

  // Geometry: in horizontal mode the track is along x (length = el.width),
  // thumb moves in x. In vertical mode track is along y (length = el.height),
  // thumb moves in y. `direction: rtl` flips the value axis so low is at
  // the visual end of the track (right for horizontal, bottom for vertical).
  // Round box edges to integer device pixels (DM-433) so the track / fill
  // rects land on Chrome's pixel grid — same alignment Chrome's UA paint
  // applies. `getBoundingClientRect()` returns fractional coords for inputs
  // laid out in flex / inline contexts; without rounding, even-thickness
  // tracks render across 3 antialiased rows instead of 2 solid rows.
  const elL = Math.round(el.x);
  const elT = Math.round(el.y);
  const elR = Math.round(el.x + el.width);
  const elB = Math.round(el.y + el.height);
  const elW = elR - elL;
  const elH = elB - elT;
  let trackRect: { x: number; y: number; w: number; h: number };
  let fillRect: { x: number; y: number; w: number; h: number };
  let thumbCx: number;
  let thumbCy: number;

  // Track spans the FULL element width / height in Chrome (verified via
  // probe-range-track.mjs against painted output for both UA and appearance:
  // none + custom track). Earlier we shortened the track by ±halfThumb on each
  // end, leaving it ~22 px narrower than Chrome's painted track for the gradient
  // sliders in DM-409. The thumb still travels within an inset range so its
  // center stays inside the track bounds at value=min/max.
  if (isVertical) {
    const halfThumb = thumbH / 2;
    const trackX = elL + elW / 2 - trackThickness / 2;
    const thumbTravelTop = elT + halfThumb;
    const thumbTravelBottom = elT + elH - halfThumb;
    const lowAtBottom = s.direction === "rtl";
    const fromTop = lowAtBottom ? (1 - ratio) : ratio;
    thumbCx = elL + elW / 2;
    thumbCy = thumbTravelTop + (thumbTravelBottom - thumbTravelTop) * fromTop;
    trackRect = { x: trackX, y: elT, w: trackThickness, h: elH };
    if (lowAtBottom) {
      fillRect = { x: trackX, y: thumbCy, w: trackThickness, h: Math.max(0, elB - thumbCy) };
    } else {
      fillRect = { x: trackX, y: elT, w: trackThickness, h: Math.max(0, thumbCy - elT) };
    }
  } else {
    const halfThumb = thumbW / 2;
    const cy = elT + elH / 2;
    const trackY = cy - trackThickness / 2;
    const thumbTravelLeft = elL + halfThumb;
    const thumbTravelRight = elR - halfThumb;
    thumbCy = cy;
    thumbCx = thumbTravelLeft + (thumbTravelRight - thumbTravelLeft) * ratio;
    trackRect = { x: elL, y: trackY, w: elW, h: trackThickness };
    fillRect = { x: elL, y: trackY, w: Math.max(0, thumbCx - elL), h: trackThickness };
  }

  const trackGradFill = gradientFillFor(s.rangeTrackBgImage, trackRect, defCtx);
  // CSS background layering: when both a gradient image and a background
  // color are declared, the color paints first and the gradient overlays.
  // For opaque non-repeating gradients this is invisible, but a repeating
  // gradient with transparent stops (e.g. tick-marks track) reveals the
  // color between stripes (DM-275).
  if (trackGradFill != null && styledTrack && s.rangeTrackBg !== "rgba(0, 0, 0, 0)" && s.rangeTrackBg != null && s.rangeTrackBg !== "") {
    parts.push(`${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(trackR)}" fill="${s.rangeTrackBg}" />`);
  }
  const trackFill = trackGradFill ?? trackBgColor;
  // Native UA range slider paints a 1px gray border around the track.
  // Empirical Chrome paint at 18px sans-serif: rgb(204,204,204) 1px stroke.
  // Author-styled tracks (rangeTrackBg set) skip this — the author owns
  // the visual chrome. DM-409.
  const trackStroke = !styledTrack ? ` stroke="rgb(204,204,204)" stroke-width="1"` : "";
  parts.push(`${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(trackR)}" fill="${trackFill}"${trackStroke} />`);
  // UA default paints an accent-colored fill from the track origin to the
  // thumb. Author-styled tracks usually replace this with their own
  // background, so skip the accent fill when the track was overridden.
  if (!styledTrack) {
    parts.push(`${indent}<rect x="${r(fillRect.x)}" y="${r(fillRect.y)}" width="${r(fillRect.w)}" height="${r(fillRect.h)}" rx="${r(trackR)}" fill="${accent}" />`);
  }
  // Parse author thumb border (e.g. "2px solid white") for styled sliders. When
  // the pseudo doesn't declare a border, fall through to the UA stroke for
  // unstyled UA thumbs and to no stroke for styled thumbs (Chrome paints the
  // styled thumb borderless unless the author asks for one). DM-273.
  const thumbBorder = parseBorderShorthand(s.rangeThumbBorder);
  // Author-styled non-square thumb: render as a rect (matches rectangular
  // and pill-shaped thumbs). Default UA thumb is a circle.
  if (styledThumb && (thumbH !== thumbW || thumbRadius < Math.min(thumbW, thumbH) / 2)) {
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : palette.fill;
    const thumbRect = { x: thumbCx - thumbW / 2, y: thumbCy - thumbH / 2, w: thumbW, h: thumbH };
    const thumbGradFill = gradientFillFor(s.rangeThumbBgImage, thumbRect, defCtx);
    const thumbFill = thumbGradFill ?? thumbBgColor;
    const strokeAttrs = thumbBorder != null ? ` stroke="${thumbBorder.color}" stroke-width="${thumbBorder.width}"` : "";
    parts.push(`${indent}<rect x="${r(thumbRect.x)}" y="${r(thumbRect.y)}" width="${r(thumbW)}" height="${r(thumbH)}" rx="${r(thumbRadius)}" fill="${thumbFill}"${strokeAttrs} />`);
  } else if (styledThumb) {
    const halfThumb = thumbW / 2;
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : palette.fill;
    const thumbRect = { x: thumbCx - halfThumb, y: thumbCy - halfThumb, w: thumbW, h: thumbW };
    const thumbGradFill = gradientFillFor(s.rangeThumbBgImage, thumbRect, defCtx);
    const thumbFill = thumbGradFill ?? thumbBgColor;
    // Donut-effect outer ring (DM-319). When the thumb pseudo has a
    // `box-shadow: 0 0 0 Npx <color>` (spread-only inset-less shadow), Chrome
    // paints an extra ring of width N around the thumb's outer edge — the
    // visible "green outer ring" on the tick-marks slider. Layering matches
    // CSS paint order: shadow (bottom) → background-fill → border (top).
    // SVG's `stroke` is path-centered, so to keep the border drawn ENTIRELY
    // inside the thumb's box (Chrome's behavior), we shrink the inner-fill
    // circle's path radius by `borderWidth/2` and add the same back to the
    // stroke width — that puts the stroke band between r=halfThumb-border and
    // r=halfThumb, leaving the outer-ring band (halfThumb..halfThumb+spread)
    // free for the box-shadow.
    // CSS paints the FIRST box-shadow on top; for spread-only outer rings a
    // larger spread sits further back, so draw largest-spread first and let the
    // smaller rings (and the thumb fill below) over-paint — yielding concentric
    // bands (DM-1240: stacked `0 0 0 1px white, 0 0 0 3px blue`).
    const rings = parseSpreadOnlyShadows(s.rangeThumbBoxShadow).sort((a, b) => b.spread - a.spread);
    for (const ring of rings) {
      const ringR = halfThumb + ring.spread;
      parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(ringR)}" fill="${ring.color}" />`);
    }
    if (thumbBorder != null) {
      const innerR = Math.max(0, halfThumb - thumbBorder.width / 2);
      parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(innerR)}" fill="${thumbFill}" stroke="${thumbBorder.color}" stroke-width="${thumbBorder.width}" />`);
    } else {
      parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(halfThumb)}" fill="${thumbFill}" />`);
    }
  } else {
    // Native (UA-default) range thumb. Chrome paints a filled accent-colored
    // circle, not a hollow white-with-gray-border one. Disabled state mutes
    // it via the host opacity Chrome already applies. DM-273.
    const halfThumb = thumbW / 2;
    parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(halfThumb)}" fill="${accent}" />`);
  }
  return parts.join("\n");
}

/**
 * Parse a CSS `box-shadow` value into the spread-only rings it contains.
 * Each ring has the form `<color> 0px 0px 0px <Npx>` or `0px 0px 0px <Npx>
 * <color>` (Chrome canonicalizes either author syntax to the color-first form).
 * Used by `renderRange` to detect the donut-ring author pattern
 *   `box-shadow: 0 0 0 1px <color>`  (and stacked variants like
 *   `0 0 0 1px white, 0 0 0 3px blue`, DM-1240) on `::-webkit-slider-thumb`
 * (DM-319). Returns one `{ spread, color }` per spread-only shadow in source
 * order; a comma-separated list yields multiple rings, and non-spread-only
 * shadows (offset / blur / inset) are skipped. Empty when none qualify.
 */
export function parseSpreadOnlyShadows(value: string | undefined): Array<{ spread: number; color: string }> {
  if (value == null || value === "" || value === "none") return [];
  // Split the shadow LIST on top-level commas (parens in `rgb(...)` are nested,
  // so track depth and only split at depth 0).
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { items.push(value.slice(start, i)); start = i + 1; }
  }
  items.push(value.slice(start));
  const rings: Array<{ spread: number; color: string }> = [];
  // Per item: optional color prefix, four <length> tokens (x / y / blur /
  // spread), optional color suffix.
  const re = /^\s*(?:(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+)\s+)?(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+))?\s*$/;
  for (const item of items) {
    const m = re.exec(item.trim());
    if (m == null) continue;
    const color = m[1] ?? m[6];
    if (color == null || color === "" || /^(?:inset|none)$/i.test(color)) continue;
    if (parseFloat(m[2]) !== 0 || parseFloat(m[3]) !== 0 || parseFloat(m[4]) !== 0) continue; // offset/blur ⇒ not a ring
    const spread = parseFloat(m[5]);
    if (!isFinite(spread) || spread <= 0) continue;
    rings.push({ spread, color });
  }
  return rings;
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
  // Button-like rounded rect with a colored inner swatch. el.value is a
  // '#rrggbb' string (default #000000). Author CSS on the host or
  // ::-webkit-color-swatch / ::-webkit-color-swatch-wrapper pseudos
  // (captured via the SK-1223 stylesheet walker) overrides the default
  // wrapper border/radius and inner swatch styling when present.
  // DM-553: scheme-aware UA defaults.
  const palette = stockPalette(defCtx?.colorScheme);
  const parts: string[] = [];
  const s = el.styles;
  const value = s.inputValue && /^#[0-9a-f]{6}$/i.test(s.inputValue) ? s.inputValue : "#000000";
  // Outer wrapper: host bg/border (already painted by the normal element
  // path) provides the chrome, plus ::-webkit-color-swatch-wrapper padding
  // adjusts the inset of the inner swatch.
  let pad = 4;
  if (s.colorSwatchWrapperPadding != null && s.colorSwatchWrapperPadding !== "") {
    const tok = s.colorSwatchWrapperPadding.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
    if (tok.length >= 1) pad = tok[0];
  }
  // Author hasn't styled the wrapper via host CSS — paint UA defaults.
  const hostHasBg = (s.backgroundColor != null && s.backgroundColor !== "" && s.backgroundColor !== "transparent" && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(s.backgroundColor));
  if (!hostHasBg) {
    parts.push(`${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" rx="3" fill="${palette.fill}" stroke="${palette.border}" stroke-width="1" />`);
  }
  // Inner swatch: prefer ::-webkit-color-swatch background-color/image when
  // authored, otherwise paint the input's value color.
  const swatchRect = { x: el.x + pad, y: el.y + pad, w: el.width - pad * 2, h: el.height - pad * 2 };
  const swatchGrad = gradientFillFor(s.colorSwatchBgImage, swatchRect, defCtx);
  const swatchFill = swatchGrad ?? (s.colorSwatchBg != null && s.colorSwatchBg !== "" ? s.colorSwatchBg : value);
  const radius = s.colorSwatchRadius != null && s.colorSwatchRadius !== "" ? parseFloat(s.colorSwatchRadius) || 0 : 0;
  // Border on the swatch (e.g. authors set ::-webkit-color-swatch { border: 2px solid gray }).
  let borderAttrs = "";
  if (s.colorSwatchBorder != null && s.colorSwatchBorder !== "") {
    const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(s.colorSwatchBorder);
    if (m != null && m[2] !== "none") {
      borderAttrs = ` stroke="${m[3]}" stroke-width="${m[1]}"`;
    }
  }
  parts.push(`${indent}<rect x="${r(swatchRect.x)}" y="${r(swatchRect.y)}" width="${r(swatchRect.w)}" height="${r(swatchRect.h)}" rx="${r(radius)}" fill="${swatchFill}"${borderAttrs} />`);
  return parts.join("\n");
}

/**
 * <input type=number>: paint the ::-webkit-inner-spin-button chrome on the
 * right edge — a small box with up/down arrow chevrons. Author rules on
 * ::-webkit-inner-spin-button (captured via the SK-1223 stylesheet walker)
 * override the UA defaults for background / border / radius.
 */
function renderNumberInput(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  // Like the search-cancel button, Chrome only paints the spin buttons when
  // the input is hovered or focused. Static-screenshot captures see no
  // hover/focus, so by default the spin chrome must be invisible. Only emit
  // when the author put explicit rules on `::-webkit-inner-spin-button` —
  // those force the visibility on. (DM-289)
  const hasAuthorPseudo = (s.numberSpinButtonBg != null && s.numberSpinButtonBg !== "")
    || (s.numberSpinButtonBorder != null && s.numberSpinButtonBorder !== "")
    || (s.numberSpinButtonRadius != null && s.numberSpinButtonRadius !== "");
  if (!hasAuthorPseudo) return "";
  const parts: string[] = [];
  // Spin button geometry: ~14px wide, full input height minus 1px inset on
  // each edge so the box sits inside the input's border.
  const w = 14;
  const x = el.x + el.width - w - 1;
  const y = el.y + 1;
  const h = Math.max(0, el.height - 2);
  if (h <= 0) return "";
  const radius = s.numberSpinButtonRadius != null && s.numberSpinButtonRadius !== ""
    ? parseFloat(s.numberSpinButtonRadius) || 0 : 0;
  const bgColor = s.numberSpinButtonBg != null && s.numberSpinButtonBg !== ""
    ? s.numberSpinButtonBg : "rgb(244, 244, 244)";
  // Background: gradient (rare but supported via the shared gradient pipeline).
  const bgGrad = gradientFillFor(undefined, { x, y, w, h }, defCtx);
  const fill = bgGrad ?? bgColor;
  // Border parsing: "Wpx <style> <color>". 'none' suppresses the stroke.
  let strokeAttrs = "";
  if (s.numberSpinButtonBorder != null && s.numberSpinButtonBorder !== "") {
    const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(s.numberSpinButtonBorder);
    if (m != null && m[2] !== "none") {
      strokeAttrs = ` stroke="${m[3]}" stroke-width="${m[1]}"`;
    }
  }
  parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(radius)}" fill="${fill}"${strokeAttrs} />`);
  // Up + down arrow chevrons centered horizontally within the box, at the
  // 1/4 and 3/4 vertical positions. Subtle gray strokes.
  const cx = x + w / 2;
  const upY = y + h / 4;
  const downY = y + (h * 3) / 4;
  const arm = Math.min(3, h / 6);
  parts.push(`${indent}<polyline points="${r(cx - arm)},${r(upY + arm * 0.5)} ${r(cx)},${r(upY - arm * 0.5)} ${r(cx + arm)},${r(upY + arm * 0.5)}" fill="none" stroke="rgb(110,110,110)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />`);
  parts.push(`${indent}<polyline points="${r(cx - arm)},${r(downY - arm * 0.5)} ${r(cx)},${r(downY + arm * 0.5)} ${r(cx + arm)},${r(downY - arm * 0.5)}" fill="none" stroke="rgb(110,110,110)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />`);
  return parts.join("\n");
}

/**
 * <input type=search>: paint the ::-webkit-search-cancel-button chrome
 * (the "X" reset button) on the right edge. Chrome only shows the cancel
 * button when the input is hovered or focused — for a static-screenshot
 * capture neither state is in effect, so we only emit the chrome when the
 * page has explicit author rules on the pseudo (those override Chrome's
 * default visibility). Without this guard our default cancel button stamps
 * an "X" on every search input that has a value, while Chrome paints
 * nothing. (DM-289)
 */
function renderSearchInput(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  if (s.inputValue == null || s.inputValue === "") return "";
  const hasAuthorPseudo = (s.searchCancelButtonBg != null && s.searchCancelButtonBg !== "")
    || (s.searchCancelButtonBorder != null && s.searchCancelButtonBorder !== "")
    || (s.searchCancelButtonRadius != null && s.searchCancelButtonRadius !== "");
  if (!hasAuthorPseudo) return "";
  const parts: string[] = [];
  const size = Math.min(14, el.height - 4);
  if (size <= 0) return "";
  const x = el.x + el.width - size - 4;
  const y = el.y + (el.height - size) / 2;
  const radius = s.searchCancelButtonRadius != null && s.searchCancelButtonRadius !== ""
    ? parseFloat(s.searchCancelButtonRadius) || size / 2 : size / 2;
  const bgColor = s.searchCancelButtonBg != null && s.searchCancelButtonBg !== ""
    ? s.searchCancelButtonBg : "rgb(180, 180, 180)";
  const bgGrad = gradientFillFor(undefined, { x, y, w: size, h: size }, defCtx);
  const fill = bgGrad ?? bgColor;
  let strokeAttrs = "";
  if (s.searchCancelButtonBorder != null && s.searchCancelButtonBorder !== "") {
    const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(s.searchCancelButtonBorder);
    if (m != null && m[2] !== "none") {
      strokeAttrs = ` stroke="${m[3]}" stroke-width="${m[1]}"`;
    }
  }
  parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="${r(radius)}" fill="${fill}"${strokeAttrs} />`);
  // White "X" centered.
  const cx = x + size / 2;
  const cy = y + size / 2;
  const arm = size * 0.25;
  parts.push(`${indent}<line x1="${r(cx - arm)}" y1="${r(cy - arm)}" x2="${r(cx + arm)}" y2="${r(cy + arm)}" stroke="white" stroke-width="1.5" stroke-linecap="round" />`);
  parts.push(`${indent}<line x1="${r(cx + arm)}" y1="${r(cy - arm)}" x2="${r(cx - arm)}" y2="${r(cy + arm)}" stroke="white" stroke-width="1.5" stroke-linecap="round" />`);
  return parts.join("\n");
}

/**
 * <input type=file>: emit a 'Choose File' button + filename label. Styling
 * comes from the captured ::file-selector-button pseudo-element so author
 * CSS (background, color, border, padding, border-radius) carries through.
 * Falls back to the Chromium UA defaults when the pseudo isn't customized.
 */
function renderFileInput(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // DM-553: scheme-aware UA border default for the 'Choose File' chrome.
  const palette = stockPalette(defCtx?.colorScheme);
  const parts: string[] = [];
  const s = el.styles;
  // Visually-hidden file inputs (label-wrapped pattern: opacity:0 or
  // width/height clipped to 1px) shouldn't render the synthesized 'Choose
  // File' chrome — the label is the visible UI and our chrome would stamp
  // ugly overlapping text on top. DM-271.
  const isHidden = el.width <= 2 || el.height <= 2 || s.opacity === "0";
  if (isHidden) return "";
  // Resolve styles from the captured pseudo, with UA defaults as fallback.
  const bg = s.fileButtonBg != null && s.fileButtonBg !== "" ? s.fileButtonBg : "rgb(239,239,239)";
  const color = s.fileButtonColor != null && s.fileButtonColor !== "" ? s.fileButtonColor : "rgb(0,0,0)";
  const rawRadius = s.fileButtonBorderRadius != null ? (parseFloat(s.fileButtonBorderRadius) || 3) : 3;
  // Border: parse "Wpx <style> <color>" — only the width matters for our paint.
  let borderW = 1;
  let borderColor = palette.border;
  if (s.fileButtonBorder != null) {
    const m = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(s.fileButtonBorder);
    if (m != null) {
      borderW = parseFloat(m[1]) || 0;
      if (m[2] === "none") borderW = 0;
      else borderColor = m[3];
    }
  }
  // Padding: parse "Tpx Rpx Bpx Lpx" (or shorthand) for vertical/horizontal.
  let padV = 4, padH = 8;
  if (s.fileButtonPadding != null) {
    const tok = s.fileButtonPadding.trim().split(/\s+/).map((p) => parseFloat(p) || 0);
    if (tok.length >= 1) { padV = tok[0]; padH = tok[0]; }
    if (tok.length >= 2) { padH = tok[1]; }
    if (tok.length >= 4) { padH = (tok[1] + tok[3]) / 2; }
  }
  const fontWeight = s.fileButtonFontWeight != null && s.fileButtonFontWeight !== "" ? s.fileButtonFontWeight : "400";
  // Chrome's UA default font-size for ::file-selector-button is 13.333px (it
  // inherits from the input chrome, not from the page). When the author sets
  // `font: inherit` on the pseudo (the f-primary / f-outline patterns in
  // 06-forms-style-file), this becomes the body's font-size — typically 16px.
  // Reading the captured pseudo font-size makes us match either case.
  const fontSize = s.fileButtonFontSize != null && s.fileButtonFontSize !== ""
    ? (parseFloat(s.fileButtonFontSize) || 13)
    : 13;
  const fontFamily = s.fileButtonFontFamily != null && s.fileButtonFontFamily !== ""
    ? s.fileButtonFontFamily
    : "-apple-system, system-ui, sans-serif";
  // Chrome's UA ::file-selector-button has `margin-inline-end: 4px` (4px gap
  // before the trailing "No file chosen" placeholder), but the test fixture
  // overrides this to `margin-right: 12px`. Read the captured pseudo
  // marginRight and use it as the gap; default to 4 when unset. DM-288.
  const marginRight = s.fileButtonMarginRight != null && s.fileButtonMarginRight !== ""
    ? (parseFloat(s.fileButtonMarginRight) || 4)
    : 4;
  // <input type=file multiple> labels as "Choose Files" (Chrome).
  const labelText = s.inputMultiple === true ? "Choose Files" : "Choose File";
  // Use the canvas-measureText'\''d label width when the capture provided one
  // (it'\''s painted at sub-pixel exact width from Chrome'\''s actual font);
  // fall back to the cheap per-char ratio otherwise (e.g. animated frames
  // captured before measureText was available).
  const textW = s.fileButtonLabelWidth != null && s.fileButtonLabelWidth > 0
    ? s.fileButtonLabelWidth
    : labelText.length * fontSize * 0.6;
  const btnW = textW + padH * 2;
  const btnH = Math.min(fontSize + padV * 2, el.height);
  const bx = el.x + 2;
  const by = el.y + (el.height - btnH) / 2;
  // Clamp the captured border-radius to half-extents so a `border-radius: 999px`
  // pill doesn't become an ellipse via SVG's per-axis rx/ry default-equality
  // rule (rx=999 with ry unset → ry=999 → ry clamps to btnH/2 independent of
  // rx clamping to btnW/2 → ellipse ends, not semicircles). DM-271.
  const radius = Math.min(rawRadius, btnW / 2, btnH / 2);
  const strokeAttrs = borderW > 0 ? ` stroke="${borderColor}" stroke-width="${borderW}"` : "";
  parts.push(`${indent}<rect x="${r(bx)}" y="${r(by)}" width="${r(btnW)}" height="${r(btnH)}" rx="${r(radius)}" fill="${bg}"${strokeAttrs} />`);
  // Baseline offset inside the button: ~0.35*fontSize below the vertical center
  // matches Helvetica/sans-serif baseline placement at small sizes.
  const baselineOffset = fontSize * 0.35;
  parts.push(`${indent}<text x="${r(bx + btnW / 2)}" y="${r(by + btnH / 2 + baselineOffset)}" text-anchor="middle" font-size="${fontSize}" font-weight="${fontWeight}" font-family="${fontFamily.replace(/"/g, "&quot;")}" fill="${color}">${labelText}</text>`);
  const label = el.styles.inputFileName != null && el.styles.inputFileName !== "" ? el.styles.inputFileName : "No file chosen";
  parts.push(`${indent}<text x="${r(bx + btnW + marginRight)}" y="${r(by + btnH / 2 + baselineOffset)}" font-size="${fontSize}" font-family="${fontFamily.replace(/"/g, "&quot;")}" fill="rgb(0,0,0)">${label.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))}</text>`);
  return parts.join("\n");
}

/**
 * Date/time/datetime-local/month/week/color picker chrome: show the captured
 * value as text plus a small picker indicator on the right.
 */
function renderDatePicker(el: CapturedElement, indent: string): string {
  const parts: string[] = [];
  const t = el.styles.inputType ?? "date";
  const val = el.styles.inputValue ?? "";
  // DM-723: Chrome's UA stylesheet sets date/time/month/week/datetime-local
  // inputs to `font-family: monospace; font-size: ~13.333px` (small-control
  // form-control metric). Read the captured font-size so we match Chrome's
  // resolved metric instead of an under-scaled 11px literal — the previous
  // hardcoded size emitted glyphs noticeably narrower than the expected paint.
  const fontSize = parseFloat(el.styles.fontSize ?? "") || 13.333;
  const tx = el.x + 6;
  const ty = el.y + el.height / 2 + fontSize * 0.35;
  // DM-731: pick up the input's resolved color so the value text matches
  // the active color-scheme. Hardcoding `rgb(0,0,0)` made dark-mode date
  // inputs render with invisible black text on a dark background. Falls
  // back to black when the capture didn't supply a color.
  const textFill = (el.styles.color != null && el.styles.color !== "")
    ? el.styles.color
    : "rgb(0,0,0)";
  // Chrome renders date inputs with an en-US-formatted display value: dates
  // as MM/DD/YYYY, times as hh:mm AM/PM, etc. The captured `inputValue` is
  // the canonical ISO form (`2026-04-21`). DM-263.
  const display = formatDateInputDisplay(t, val);
  if (display !== "") {
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="ui-monospace, Menlo, monospace" fill="${textFill}">${display.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))}</text>`);
  }
  // Picker icon on the right edge: calendar for date / month / week / datetime-local,
  // clock for time. Chrome paints these monochrome at ~14px in the input's
  // line-height. DM-263.
  // DM-731: pass the input's text color through so the icon picks up the
  // dark-mode color (was hardcoded to TRACK_FG light-mode constant).
  const cx = el.x + el.width - 12;
  const cy = el.y + el.height / 2;
  const iconSize = Math.min(11, el.height - 6);
  if (t === "time") {
    parts.push(renderClockIcon(indent, cx, cy, iconSize, textFill));
  } else {
    parts.push(renderCalendarIcon(indent, cx, cy, iconSize, textFill));
  }
  return parts.join("\n");
}

/** Format an ISO date-input value into Chrome's en-US display string.
 *  Falls back to the raw value when parsing fails (preserves the original
 *  rendering for unrecognized inputs). DM-263. */
function formatDateInputDisplay(type: string, val: string): string {
  if (val === "") return "";
  if (type === "date") {
    // YYYY-MM-DD → MM/DD/YYYY
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    if (m == null) return val;
    return `${m[2]}/${m[3]}/${m[1]}`;
  }
  if (type === "time") {
    // HH:MM[:SS] (24h) → hh:mm AM/PM (12h)
    const m = /^(\d{2}):(\d{2})/.exec(val);
    if (m == null) return val;
    const h24 = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return `${h12.toString().padStart(2, "0")}:${mm} ${ampm}`;
  }
  if (type === "datetime-local") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(val);
    if (m == null) return val;
    const h24 = parseInt(m[4], 10);
    const ampm = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return `${m[2]}/${m[3]}/${m[1]}, ${h12.toString().padStart(2, "0")}:${m[5]} ${ampm}`;
  }
  if (type === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(val);
    if (m == null) return val;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const idx = parseInt(m[2], 10) - 1;
    if (idx < 0 || idx > 11) return val;
    return `${months[idx]} ${m[1]}`;
  }
  if (type === "week") {
    const m = /^(\d{4})-W(\d{2})$/.exec(val);
    if (m == null) return val;
    return `Week ${m[2]}, ${m[1]}`;
  }
  return val;
}

function renderCalendarIcon(indent: string, cx: number, cy: number, size: number, strokeOverride?: string): string {
  // Simple calendar glyph: rounded rect with two top "binders" and a grid line.
  const w = size;
  const h = size;
  const x = cx - w / 2;
  const y = cy - h / 2;
  // DM-731: caller supplies the stroke color so the icon picks up the
  // active color-scheme (was hardcoded to the light-mode `TRACK_FG`).
  const stroke = strokeOverride ?? TRACK_FG;
  return `${indent}<g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round"><rect x="${r(x + 0.5)}" y="${r(y + 1.5)}" width="${r(w - 1)}" height="${r(h - 2)}" rx="1" /><line x1="${r(x + 0.5)}" y1="${r(y + 4)}" x2="${r(x + w - 0.5)}" y2="${r(y + 4)}" /><line x1="${r(x + 3)}" y1="${r(y + 0.5)}" x2="${r(x + 3)}" y2="${r(y + 2.5)}" /><line x1="${r(x + w - 3)}" y1="${r(y + 0.5)}" x2="${r(x + w - 3)}" y2="${r(y + 2.5)}" /></g>`;
}

function renderClockIcon(indent: string, cx: number, cy: number, size: number, strokeOverride?: string): string {
  // Simple clock glyph: circle with two hands.
  const r1 = size / 2;
  const stroke = strokeOverride ?? TRACK_FG;
  return `${indent}<g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round"><circle cx="${r(cx)}" cy="${r(cy)}" r="${r(r1 - 0.5)}" /><line x1="${r(cx)}" y1="${r(cy)}" x2="${r(cx)}" y2="${r(cy - r1 * 0.55)}" /><line x1="${r(cx)}" y1="${r(cy)}" x2="${r(cx + r1 * 0.4)}" y2="${r(cy)}" /></g>`;
}

/**
 * If the captured pseudo-element background is something other than the
 * UA default (transparent / Chrome's default fill), return it as a paint
 * value. Solid colors return the rgb string. Gradients return the first
 * gradient color stop as a fallback (full gradient rendering would require
 * emitting an SVG <linearGradient> def, which we approximate here).
 *
 * NOTE: in headless Chromium getComputedStyle on ::-webkit-progress-value
 * etc. often returns transparent regardless of the CSS rule (because the
 * pseudo styles are not always exposed via the API even when they paint
 * correctly). So in practice this returns null for almost everything and
 * the renderer falls back to UA defaults.
 */
function customPseudoFill(bg: string | undefined, bgImage: string | undefined): string | null {
  if (bgImage != null && bgImage !== "none" && bgImage !== "") {
    // Try to extract the dominant color from a gradient string. Best-effort:
    // pull the first color literal that appears.
    const m = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/i.exec(bgImage);
    if (m != null) return m[1];
  }
  if (bg == null || bg === "" || bg === "transparent") return null;
  // Detect transparent rgba(...) regardless of inner spacing.
  const transparentRgba = /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i;
  if (transparentRgba.test(bg)) return null;
  return bg;
}

function renderProgress(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // DM-553: scheme-aware UA default track + accent fill.
  const palette = stockPalette(defCtx?.colorScheme);
  // DM-1254: track/value rects come from the shared progressBarGeom (also used
  // by the conic raster collector). UA-default <progress> on Chrome-macOS is a
  // centered bar inset by floor(h/4) with a partial pill radius emerging past
  // barH≈8 (DM-354); author-styled (appearance:none) bars use the pseudo's own
  // radius (Chrome doesn't propagate the host radius to the pseudos).
  const { isAuthorStyled, barH, ratio: _ratio, trackRect, valueRect } = progressBarGeom(el);
  void _ratio;
  const parts: string[] = [];
  const accent = resolveAccent(el, defCtx);
  // Custom pseudo-element fills override the UA defaults when present (SK-1222).
  const customTrackFill = customPseudoFill(el.styles.progressBarBg, el.styles.progressBarBgImage);
  const customValueFill = customPseudoFill(el.styles.progressValueBg, el.styles.progressValueBgImage);
  const trackFill = customTrackFill ?? palette.trackBg;
  const valueFill = customValueFill ?? accent;
  const trackRadius = isAuthorStyled
    ? (el.styles.progressBarRadius != null && el.styles.progressBarRadius !== "0px"
        ? parseFloat(el.styles.progressBarRadius) || 0 : 0)
    : Math.max(0, (barH - 8) / 2);
  const valueRadius = isAuthorStyled
    ? (el.styles.progressValueRadius != null && el.styles.progressValueRadius !== "0px"
        ? parseFloat(el.styles.progressValueRadius) || 0 : 0)
    : Math.max(0, (barH - 8) / 2);
  // Gradient fills (SK-1224 / SK-1225 / DM-1254 conic) for progress pseudos:
  // a gradient bg-image emits a def referenced via fill="url(#...)"; flat fills
  // are the fallback. The <rect>s use the shared rects so the conic tile (keyed
  // by rect size) lines up with what's painted.
  const trackGrad = gradientFillFor(el.styles.progressBarBgImage, trackRect, defCtx);
  parts.push(`${indent}<rect x="${r(trackRect.x)}" y="${r(trackRect.y)}" width="${r(trackRect.w)}" height="${r(trackRect.h)}" rx="${r(trackRadius)}" fill="${trackGrad ?? trackFill}" />`);
  if (valueRect != null) {
    const valueGrad = gradientFillFor(el.styles.progressValueBgImage, valueRect, defCtx);
    parts.push(`${indent}<rect x="${r(valueRect.x)}" y="${r(valueRect.y)}" width="${r(valueRect.w)}" height="${r(valueRect.h)}" rx="${r(valueRadius)}" fill="${valueGrad ?? valueFill}" />`);
  }
  return parts.join("\n");
}

function renderMeter(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // DM-553: scheme-aware UA defaults — meter green/yellow/red palette + track.
  const palette = stockPalette(defCtx?.colorScheme);
  const value = el.styles.meterValue ?? 0;
  const min = el.styles.meterMin ?? 0;
  const max = el.styles.meterMax ?? 1;
  // CSS spec: low defaults to min, high defaults to max, optimum defaults to (min+max)/2.
  const low = el.styles.meterLow ?? min;
  const high = el.styles.meterHigh ?? max;
  const optimum = el.styles.meterOptimum ?? (min + max) / 2;
  const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;

  // Classify each point into low/medium/high region based on the bar's low/high
  // bounds. Then: same-region = optimal (green), adjacent = suboptimal (yellow),
  // opposite ends = worst (red). This matches the HTML <meter> color rules.
  const region = (v: number): 0 | 1 | 2 =>
    v < low ? 0 : v > high ? 2 : 1;
  const valR = region(value);
  const optR = region(optimum);
  const dist = Math.abs(valR - optR);
  // Pick the matching pseudo (optimum/suboptimum/even-less-good) for the
  // value's region. Author CSS on those pseudos overrides the UA-default
  // green/yellow/red palette. SK-1222 fixed the upstream capture so author
  // rules now round-trip via the stylesheet walker.
  const customTrackFill = customPseudoFill(el.styles.meterBarBg, el.styles.meterBarBgImage);
  // The region-selected value bg image is resolved in meterBarGeom (used for the
  // gradient lookup); here we only need the matching flat customValueFill.
  let customValueFill: string | null;
  if (dist === 0) {
    customValueFill = customPseudoFill(el.styles.meterOptimumBg, el.styles.meterOptimumBgImage);
  } else if (dist === 1) {
    customValueFill = customPseudoFill(el.styles.meterSuboptimumBg, el.styles.meterSuboptimumBgImage);
  } else {
    customValueFill = customPseudoFill(el.styles.meterEvenLessGoodBg, el.styles.meterEvenLessGoodBgImage);
  }
  const defaultFill = dist === 0 ? palette.meterGreen : dist === 1 ? palette.meterYellow : palette.meterRed;
  const fill = customValueFill ?? defaultFill;
  const trackFill = customTrackFill ?? palette.trackBg;
  // Same UA-default formula as <progress> (DM-354): inset=floor(h/4) top
  // and bottom, with a partial pill radius that only emerges past barH≈8.
  // Author-styled <meter> (appearance:none with custom pseudo) uses the
  // pseudo's own border-radius, defaulting to 0 (Chrome doesn't propagate
  // the host's border-radius to the pseudos in styled mode).
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px");
  const inset = uaBarInset(el.height);
  const barH = isAuthorStyled ? el.height : el.height - 2 * inset;
  const barY = isAuthorStyled ? el.y : el.y + inset;
  // Native (non-author-styled) <meter> on macOS Chrome paints a grooved
  // bar: the track and value sit inside a 1px gray border (rgb(203,203,203))
  // with small rounded corners (~2px), and the value fill is inset 1px
  // within that groove so the border shows around it. Sampled from Chromium
  // paint: 8px bar (inset floor(h/4)), track rgb(239,239,239), green fill
  // rgb(16,124,16), 1px groove border. Author-styled meters (appearance:none)
  // get no groove — only the pseudo's own border-radius rounds them.
  const trackRadius = isAuthorStyled
    ? (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px"
        ? parseFloat(el.styles.meterBarRadius) || 0 : 0)
    : Math.min(2, barH / 2);

  const parts: string[] = [];
  // Gradient fills (SK-1222 + SK-1224 / SK-1225 / DM-1254 conic) for meter
  // pseudos. DM-1254: route the gradient lookups through the shared meterBarGeom
  // so the conic raster collector and these calls compute the SAME consumer rect
  // (the conic tile cache is keyed by rect size). The drawn <rect>s below keep
  // their own pixel-snapped groove geometry, which equals the geom rects.
  const geom = meterBarGeom(el);
  const trackGrad = gradientFillFor(el.styles.meterBarBgImage, geom.trackRect, defCtx);
  if (isAuthorStyled) {
    // The track (`::-webkit-meter-bar`) fills the full element height, but
    // Chrome insets the VALUE pseudo to the center ~half-height (inset =
    // floor(h/4), same as the native bar) — sampled: h=16 value spans the
    // center 8px, h=28 value spans the center 14px. Snap the box top to the
    // pixel grid (Chrome paints the snapped border box) so the bar edges land
    // crisply instead of AA'ing across two rows.
    const top = Math.round(el.y);
    const fullH = Math.round(el.height);
    parts.push(`${indent}<rect x="${r(el.x)}" y="${r(top)}" width="${r(el.width)}" height="${r(fullH)}" rx="${r(trackRadius)}" fill="${trackGrad ?? trackFill}" />`);
    if (ratio > 0) {
      const vInset = uaBarInset(fullH);
      const valueH = fullH - 2 * vInset;
      const valueTop = top + vInset;
      const valueRadius = Math.min(trackRadius, valueH / 2);
      const valueW = el.width * ratio;
      const valueGrad = gradientFillFor(geom.valueBgImage, geom.valueRect!, defCtx);
      parts.push(`${indent}<rect x="${r(el.x)}" y="${r(valueTop)}" width="${r(valueW)}" height="${r(valueH)}" rx="${r(valueRadius)}" fill="${valueGrad ?? fill}" />`);
    }
  } else {
    // Native groove. Chrome paints a crisp 1px gray border (rgb(203,203,203))
    // around the bar with the track/value fills inside it. Snap to the pixel
    // grid so the 1px stroke lands on a single row/column instead of AA'ing
    // across two (sampled Chrome: border row at floor(barY), 6px fill inside,
    // border row at the bottom). The value fill is inset 1px so the groove
    // reads around it.
    const groove = "rgb(203,203,203)";
    const left = Math.floor(el.x);
    const top = Math.floor(barY);
    const fullW = Math.round(el.width);
    parts.push(`${indent}<rect x="${r(left + 0.5)}" y="${r(top + 0.5)}" width="${r(fullW - 1)}" height="${r(barH - 1)}" rx="${r(trackRadius)}" fill="${trackGrad ?? trackFill}" stroke="${groove}" stroke-width="1" />`);
    if (ratio > 0) {
      const valueW = Math.max(0, Math.round(el.width * ratio) - 1);
      const valueGrad = gradientFillFor(geom.valueBgImage, geom.valueRect!, defCtx);
      parts.push(`${indent}<rect x="${r(left + 1)}" y="${r(top + 1)}" width="${r(valueW)}" height="${r(barH - 2)}" rx="${r(Math.max(0, trackRadius - 1))}" fill="${valueGrad ?? fill}" />`);
    }
  }
  return parts.join("\n");
}

/**
 * Render a listbox-mode `<select>` (size > 1 or multiple). The host rect
 * (border + bg) is already painted by the normal element-rendering path;
 * this overlays one text row per option, with `:checked` rows highlighted
 * in the Chrome-on-macOS selection-blue band. Optgroup labels render in
 * italic + bold and are not selectable. DM-282.
 */
function renderListbox(el: CapturedElement, indent: string): string {
  const opts = el.styles.selectListboxOptions;
  if (opts == null || opts.length === 0) return "";
  const fontSize = parseFloat(el.styles.fontSize ?? "13") || 13;
  const fontFamily = el.styles.fontFamily ?? "-apple-system, system-ui, sans-serif";
  const color = el.styles.color ?? "rgb(0,0,0)";
  // Chrome's listbox option row is line-height ≈ fontSize × 1.16. The first
  // row is offset by 1px (border inset) plus a thin top padding.
  const rowH = fontSize * 1.16;
  const innerX = el.x + 5;
  const innerY = el.y + 1;
  const innerW = el.width - 6;
  const parts: string[] = [];
  // Selection-row highlight (Chrome-on-macOS). We overlay an opaque rect
  // BEHIND the text. Disabled rows aren't highlighted even when selected.
  const SELECTION_BG = "rgb(180, 215, 255)";
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const ry = innerY + i * rowH;
    if (ry + rowH > el.y + el.height - 1) break;
    if (o.selected && !o.disabled && !o.isOptgroupLabel) {
      parts.push(`${indent}<rect x="${r(innerX - 4)}" y="${r(ry)}" width="${r(innerW + 4)}" height="${r(rowH)}" fill="${SELECTION_BG}" />`);
    }
    const tx = innerX + (o.isOptgroupChild ? 8 : 0);
    const ty = ry + rowH * 0.78;
    const fontStyleAttr = o.isOptgroupLabel ? ` font-style="italic"` : "";
    const fontWeightAttr = o.isOptgroupLabel ? ` font-weight="bold"` : "";
    const opacityAttr = o.disabled ? ` opacity="0.5"` : "";
    const escaped = o.text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="${fontFamily.replace(/"/g, "&quot;")}" fill="${color}"${fontStyleAttr}${fontWeightAttr}${opacityAttr}>${escaped}</text>`);
  }
  return parts.join("\n");
}

function renderSelectChevron(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  // DM-553: scheme-aware chevron stroke.
  const palette = stockPalette(defCtx?.colorScheme);
  const parts: string[] = [];
  // Selected-option text inside the closed dropdown's content rect (DM-246).
  // Chrome paints `selectedOptions[0]?.textContent` here; option/optgroup
  // children are otherwise textIsHiddenFallback and don't reach the renderer.
  const display = el.styles.selectDisplayText;
  if (display != null && display !== "") {
    const fontSize = parseFloat(el.styles.fontSize ?? "13") || 13;
    const fontFamily = el.styles.fontFamily ?? "-apple-system, system-ui, sans-serif";
    const fontWeight = el.styles.fontWeight ?? "400";
    const color = el.styles.color ?? "rgb(0,0,0)";
    // Anchor the display text at the element's content-box left edge.
    // Pages style selects with `appearance: none; padding: 8px 34px 8px 12px`
    // and similar — the previous hardcoded `el.x + 6` ignored the captured
    // padding, so styled selects rendered the text 6-12px too far left
    // (DM-341). UA-default selects (where padding is empty) still resolve to
    // a reasonable position via Chrome's small computed padding.
    const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
    const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
    const tx = el.x + bwL + padL;
    const ty = el.y + el.height / 2 + fontSize * 0.35;
    const escaped = display.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="${fontFamily.replace(/"/g, "&quot;")}" fill="${color}">${escaped}</text>`);
  }
  // Chromium macOS default: small down-chevron near the right edge. Skip
  // when the page set appearance: none — the chevron is the page's
  // responsibility (drawn via background-image) and stacking ours produces
  // a double-arrow. DM-308.
  if (el.styles.selectChevron === true) {
    const size = Math.min(10, el.height * 0.5);
    const cx = el.x + el.width - 10;
    const cy = el.y + el.height / 2;
    const p = (dx: number, dy: number): string => `${r(cx + dx * size)},${r(cy + dy * size)}`;
    parts.push(`${indent}<polyline points="${p(-0.35, -0.18)} ${p(0, 0.18)} ${p(0.35, -0.18)}" fill="none" stroke="${palette.trackFg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`);
  }
  return parts.join("\n");
}

function renderDetailsMarker(el: CapturedElement, indent: string): string {
  // When author CSS hides the UA disclosure marker (::marker { color:
  // transparent } or ::-webkit-details-marker { color: transparent }),
  // skip painting — the author has supplied a replacement (typically a
  // ::before pseudo) and stacking our triangle on top double-paints. DM-448.
  if (el.styles.summaryMarkerSuppressed === true) return "";
  // Chrome's UA stylesheet for `<details><summary>` paints a disclosure
  // triangle to the LEFT of the summary's first text line. Empirical
  // probe (DM-370): triangle size scales roughly with font-size at
  // ~0.6em per side, painted in the summary's text color (NOT the
  // greyed-out TRACK_FG we used previously — that left a barely-visible
  // ghost where Chrome paints a clean black caret). Closed state uses
  // the right-pointing triangle ▶ (U+25B6); open state uses the
  // down-pointing triangle ▼ (U+25BC).
  const fontSizePx = parseFloat(el.styles.fontSize ?? "") || 14;
  // Chrome's UA disclosure triangle is rendered via the ▶ / ▼ glyphs in the
  // summary's font at the summary's font-size. Glyph advance is ~0.7em for
  // U+25B6 / U+25BC in the system sans fonts (DM-448 follow-up). The
  // previous 0.6em multiplier produced a triangle that read visibly small
  // vs Chrome's painted output.
  // DM-1123: when the author styled the `::marker` font-size
  // (`summary::marker { font-size: 14px }`), the triangle scales with the
  // marker's size, not the summary's. Falls back to the summary font-size
  // (the marker inherits it) for unstyled markers, so plain summaries are
  // byte-identical to before.
  const markerPx = el.styles.summaryMarkerFontSize ?? fontSizePx;
  const size = Math.max(8, markerPx * 0.7);
  // DM-746: prefer the captured <summary> child's actual y / height when
  // available — that's the line box Chrome paints the marker into. The
  // previous fallback computed `cy` from `el.y + paddingT + borderT +
  // lineH/2` with `lineH = parseFloat(lineHeight) || fontSize*1.5`, which
  // overshoots by ~3 px when lineHeight is "normal" (Chrome's "normal"
  // resolves to ~1.15× fontSize via the font's intrinsic ascent+descent
  // +linegap, not the 1.5× literal). The drift was visible as a downward
  // shift of the disclosure triangle on `niche-command-invokers`.
  const summaryChild = el.children?.find((c) => c.tag === "summary");
  const padL = parseFloat(el.styles.paddingLeft ?? "") || 0;
  const brL = parseFloat(el.styles.borderLeftWidth ?? "") || 0;
  const padT = parseFloat(el.styles.paddingTop ?? "") || 0;
  const brT = parseFloat(el.styles.borderTopWidth ?? "") || 0;
  // Position: marker sits inside the summary at its content-start, which
  // is el.x + paddingL + borderL. Offset by half the marker size so the
  // glyph's center sits ~half-marker-width past the summary's left edge,
  // matching Chrome's painted offset (DM-448).
  // DM-1123: for `list-style-position: inside` (the UA default for
  // `<summary>`) the marker is the first inline box INSIDE the summary's
  // padding box, so it starts after the summary's own `padding-left`. The
  // `.with-marker` fixture sets `summary { padding-left: 24px }`, which shifted
  // Chrome's triangle ~24px right of where the legacy border-box-left placement
  // painted it. Plain summaries have no padding, so this reduces to the prior
  // position (no regression).
  const summaryPadL = el.styles.summaryMarkerInside === true && summaryChild != null
    ? (parseFloat(summaryChild.styles.paddingLeft ?? "") || 0)
    : 0;
  const cx = (summaryChild != null ? summaryChild.x : el.x + padL + brL) + summaryPadL + size / 2;
  // Vertical center: the summary is the first child of <details>; use its
  // captured line-box center when available. Fallback computes from the
  // details' padding/border + a corrected line-height ratio.
  const cy = summaryChild != null
    ? summaryChild.y + summaryChild.height / 2
    : el.y + padT + brT + (parseFloat(el.styles.lineHeight ?? "") || fontSizePx * 1.15) / 2;
  const open = el.styles.detailsOpen === true;
  // DM-1123: paint in the computed `::marker` color when captured (Chrome paints
  // the triangle in the marker color, e.g. `summary::marker { color: #6d28d9 }`
  // → purple). For an unstyled marker the captured color equals the summary's
  // text color (the marker inherits it), so this also covers the plain case;
  // fall back to the summary text color / dark gray for pre-DM-1123 captures.
  const fill = (el.styles.summaryMarkerColor != null && el.styles.summaryMarkerColor !== "")
    ? el.styles.summaryMarkerColor
    : (el.styles.color != null && el.styles.color !== "")
      ? el.styles.color : "rgb(0,0,0)";
  const half = size / 2;
  // Right-pointing (closed): ▶ — apex at right. Down-pointing (open): ▼ — apex at bottom.
  const p = open
    ? `${r(cx - half)},${r(cy - half * 0.6)} ${r(cx + half)},${r(cy - half * 0.6)} ${r(cx)},${r(cy + half * 0.7)}`
    : `${r(cx - half * 0.7)},${r(cy - half)} ${r(cx + half * 0.6)},${r(cy)} ${r(cx - half * 0.7)},${r(cy + half)}`;
  return `${indent}<polygon points="${p}" fill="${fill}" />`;
}
