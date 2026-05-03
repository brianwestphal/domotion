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

import type { CapturedElement } from "./dom-to-svg.js";
import { buildLinearGradientDef, buildRadialGradientDef, gradientCacheKey, parseGradient } from "./gradients.js";

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

// ── Chromium macOS default colors (sampled from Playwright captures) ──
// Re-calibrated against headless Chromium-on-macOS screenshots in DM-284.
// Probe methodology: paint each control with default chrome on a 1x viewport,
// `magick info:` pixel-pick from a known position inside the fill region.
const UA_BORDER = "rgb(118,118,118)";
const UA_FILL = "rgb(255,255,255)";
const ACCENT_BLUE = "rgb(0,117,255)";
const TRACK_BG = "rgb(239,239,239)";
const TRACK_FG = "rgb(118,118,118)";
const METER_GREEN = "rgb(16,124,16)";
const METER_YELLOW = "rgb(255,185,0)";
const METER_RED = "rgb(216,59,1)";
const DISABLED_BORDER = "rgba(118,118,118,0.5)";

function r(n: number): string { return Number(n.toFixed(1)).toString(); }

/** Resolve CSS accent-color to a concrete fill. 'auto' (or missing) falls back
 *  to the Chromium macOS default blue. Author-set values pass through. */
function resolveAccent(el: CapturedElement): string {
  const ac = el.styles.accentColor;
  if (ac == null || ac === "" || ac === "auto" || ac === "currentcolor") return ACCENT_BLUE;
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
function unfilledTrackColor(accentCss: string | undefined): string {
  if (accentCss == null || accentCss === "" || accentCss === "auto" || accentCss === "currentcolor") return TRACK_BG;
  // Extract sRGB triplet from rgb()/rgba() (Chrome canonicalises hex etc.).
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(accentCss);
  if (m == null) return TRACK_BG;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const Y = 0.2126 * lin(parseFloat(m[1])) + 0.7152 * lin(parseFloat(m[2])) + 0.0722 * lin(parseFloat(m[3]));
  return Y > 0.26 ? "rgb(59,59,59)" : TRACK_BG;
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
  if (tag === "select" && el.styles.selectDisplayText != null) return renderSelectChevron(el, indent);
  if (tag === "select" && el.styles.selectListboxOptions != null) return renderListbox(el, indent);
  if (tag === "details") return renderDetailsMarker(el, indent);
  return "";
}

function renderInputControl(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const t = el.styles.inputType ?? "text";
  if (t === "checkbox") return renderCheckbox(el, indent);
  if (t === "radio") return renderRadio(el, indent);
  if (t === "range") return renderRange(el, indent, defCtx);
  if (t === "color") return renderColorSwatch(el, indent, defCtx);
  if (t === "file") return renderFileInput(el, indent);
  if (t === "number") return renderNumberInput(el, indent, defCtx);
  if (t === "search") return renderSearchInput(el, indent, defCtx);
  if (t === "date" || t === "time" || t === "datetime-local" || t === "month" || t === "week") {
    return renderDatePicker(el, indent);
  }
  // text-like inputs already render via the normal border+bg path
  return "";
}

function renderCheckbox(el: CapturedElement, indent: string): string {
  // appearance: none → author has opted out of UA chrome. The host's normal
  // element-rendering path already painted its bg + border with the captured
  // styles; we just overlay the :checked indicator. Switch-shape (wide,
  // pill-radius) renders as a toggle thumb instead of a checkmark. DM-285.
  if (el.styles.inputAppearance === "none") return renderCustomCheckboxOrSwitch(el, indent);
  // 13x13 square with 2px radius, blue+check when checked, dash when indeterminate.
  const size = Math.min(el.width, el.height);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const parts: string[] = [];
  const stroke = el.styles.disabled ? DISABLED_BORDER : UA_BORDER;

  const accent = resolveAccent(el);
  if (el.styles.indeterminate === true) {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${accent}" />`);
    parts.push(`${indent}<rect x="${r(x + size * 0.2)}" y="${r(cy - size * 0.08)}" width="${r(size * 0.6)}" height="${r(size * 0.16)}" fill="#fff" />`);
  } else if (el.styles.checked === true) {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${accent}" />`);
    // Check mark path (two-segment tick).
    const p = (dx: number, dy: number): string => `${r(x + dx * size)},${r(y + dy * size)}`;
    parts.push(`${indent}<polyline points="${p(0.22, 0.55)} ${p(0.42, 0.74)} ${p(0.78, 0.3)}" fill="none" stroke="#fff" stroke-width="${r(size * 0.14)}" stroke-linecap="round" stroke-linejoin="round" />`);
  } else {
    parts.push(`${indent}<rect x="${r(x)}" y="${r(y)}" width="${r(size)}" height="${r(size)}" rx="2" fill="${UA_FILL}" stroke="${stroke}" stroke-width="1" />`);
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

function renderRadio(el: CapturedElement, indent: string): string {
  // appearance: none → host rect already painted with author bg/border;
  // overlay only the :checked dot in the captured border color. DM-285.
  if (el.styles.inputAppearance === "none") {
    if (el.styles.checked !== true) return "";
    const size = Math.min(el.width, el.height);
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const dotColor = el.styles.borderTopColor ?? resolveAccent(el);
    return `${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(size * 0.25)}" fill="${dotColor}" />`;
  }
  const size = Math.min(el.width, el.height);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rr = size / 2;
  const parts: string[] = [];
  const stroke = el.styles.disabled ? DISABLED_BORDER : UA_BORDER;
  const accent = resolveAccent(el);
  if (el.styles.checked === true) {
    // Chrome's checked native radio is a donut: thin accent-colored outer
    // ring (~1px at 13px diameter), white middle, accent-colored center dot
    // (~0.5 of the radius). Three concentric circles. (DM-292)
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr)}" fill="${accent}" />`);
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr - 1)}" fill="#fff" />`);
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr * 0.5)}" fill="${accent}" />`);
  } else {
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr - 0.5)}" fill="${UA_FILL}" stroke="${stroke}" stroke-width="1" />`);
  }
  return parts.join("\n");
}

function renderRange(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
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
  const styledTrack = s.rangeTrackBg != null;
  const styledThumb = s.rangeThumbWidth != null;
  // Native UA range slider — empirically Chrome paints a ~6px solid track
  // (8px painted total with AA) and a 16px-diameter thumb regardless of bbox
  // height (verified via probe-range-native-track.mjs against bbox h=16/20).
  // Earlier values trackThickness=4 / thumbW=14 left a ~2-3px diff visible on
  // the accent-color re-hue sliders. DM-338.
  const trackThickness = styledTrack ? (parseFloat(s.rangeTrackHeight ?? "") || 4) : 6;
  const trackR = styledTrack ? (parseFloat(s.rangeTrackRadius ?? "") || 0) : 2;
  // Unfilled-track color: author-set when the slider is `appearance: none` +
  // styled track, otherwise the UA default which depends on `accent-color`
  // (Chrome darkens the unfilled track when the accent is bright — DM-320).
  const trackBgColor = styledTrack && s.rangeTrackBg !== "rgba(0, 0, 0, 0)" ? s.rangeTrackBg! : unfilledTrackColor(s.accentColor);
  const thumbW = styledThumb ? (parseFloat(s.rangeThumbWidth ?? "") || 14) : 16;
  const thumbH = styledThumb ? (parseFloat(s.rangeThumbHeight ?? "") || thumbW) : 16;
  const thumbRadius = styledThumb ? (parseFloat(s.rangeThumbRadius ?? "") || thumbW / 2) : thumbW / 2;
  const accent = resolveAccent(el);
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

  if (isVertical) {
    const halfThumb = thumbH / 2;
    const trackX = elL + elW / 2 - trackThickness / 2;
    const trackTop = elT + halfThumb;
    const trackBottom = elT + elH - halfThumb;
    const trackLen = trackBottom - trackTop;
    const lowAtBottom = s.direction === "rtl";
    const fromTop = lowAtBottom ? (1 - ratio) : ratio;
    thumbCx = elL + elW / 2;
    thumbCy = trackTop + trackLen * fromTop;
    trackRect = { x: trackX, y: trackTop, w: trackThickness, h: trackLen };
    // UA accent fill spans from the value end of the track to the thumb.
    if (lowAtBottom) {
      fillRect = { x: trackX, y: thumbCy, w: trackThickness, h: Math.max(0, trackBottom - thumbCy) };
    } else {
      fillRect = { x: trackX, y: trackTop, w: trackThickness, h: Math.max(0, thumbCy - trackTop) };
    }
  } else {
    const halfThumb = thumbW / 2;
    const cy = elT + elH / 2;
    const trackY = cy - trackThickness / 2;
    const trackLeft = elL + halfThumb;
    const trackRight = elR - halfThumb;
    const trackLen = trackRight - trackLeft;
    thumbCy = cy;
    thumbCx = trackLeft + trackLen * ratio;
    trackRect = { x: trackLeft, y: trackY, w: trackLen, h: trackThickness };
    fillRect = { x: trackLeft, y: trackY, w: Math.max(0, thumbCx - trackLeft), h: trackThickness };
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
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : UA_FILL;
    const thumbRect = { x: thumbCx - thumbW / 2, y: thumbCy - thumbH / 2, w: thumbW, h: thumbH };
    const thumbGradFill = gradientFillFor(s.rangeThumbBgImage, thumbRect, defCtx);
    const thumbFill = thumbGradFill ?? thumbBgColor;
    const strokeAttrs = thumbBorder != null ? ` stroke="${thumbBorder.color}" stroke-width="${thumbBorder.width}"` : "";
    parts.push(`${indent}<rect x="${r(thumbRect.x)}" y="${r(thumbRect.y)}" width="${r(thumbW)}" height="${r(thumbH)}" rx="${r(thumbRadius)}" fill="${thumbFill}"${strokeAttrs} />`);
  } else if (styledThumb) {
    const halfThumb = thumbW / 2;
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : UA_FILL;
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
    const ringShadow = parseSpreadOnlyShadow(s.rangeThumbBoxShadow);
    if (ringShadow != null) {
      const ringR = halfThumb + ringShadow.spread;
      parts.push(`${indent}<circle cx="${r(thumbCx)}" cy="${r(thumbCy)}" r="${r(ringR)}" fill="${ringShadow.color}" />`);
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
 * Parse a CSS `box-shadow` value of the spread-only form
 *   `<color> 0px 0px 0px <Npx>`  or  `0px 0px 0px <Npx> <color>`
 * (Chrome canonicalizes either author syntax to the color-first form). Used
 * by `renderRange` to detect the donut-ring author pattern
 *   `box-shadow: 0 0 0 1px <color>`
 * on `::-webkit-slider-thumb` (DM-319). Returns `{ spread, color }` for the
 * single-shadow spread-only case; null for missing / `none` / multi-shadow /
 * any-non-zero-offset / any-non-zero-blur.
 */
function parseSpreadOnlyShadow(value: string | undefined): { spread: number; color: string } | null {
  if (value == null || value === "" || value === "none") return null;
  // Multi-shadow lists are comma-separated; we only handle single-shadow so
  // bail when more than one comma at the top level (parens nesting in `rgb(...)`
  // is fine because we tokenize with a depth counter via the regex below).
  // Pattern: optional color prefix, then four <length> tokens, then optional
  // color suffix. The four lengths are x / y / blur / spread.
  const m = /^\s*(?:(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+)\s+)?(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+))?\s*$/.exec(value.trim());
  if (m == null) return null;
  const colorPrefix = m[1];
  const x = parseFloat(m[2]);
  const y = parseFloat(m[3]);
  const blur = parseFloat(m[4]);
  const spread = parseFloat(m[5]);
  const colorSuffix = m[6];
  const color = colorPrefix ?? colorSuffix;
  if (color == null || color === "" || /^(?:inset|none)$/i.test(color)) return null;
  if (x !== 0 || y !== 0 || blur !== 0) return null;
  if (!isFinite(spread) || spread <= 0) return null;
  return { spread, color };
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
    parts.push(`${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" rx="3" fill="${UA_FILL}" stroke="${UA_BORDER}" stroke-width="1" />`);
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
function renderFileInput(el: CapturedElement, indent: string): string {
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
  let borderColor = UA_BORDER;
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
  const tx = el.x + 6;
  const ty = el.y + el.height / 2 + 4;
  // Chrome renders date inputs with an en-US-formatted display value: dates
  // as MM/DD/YYYY, times as hh:mm AM/PM, etc. The captured `inputValue` is
  // the canonical ISO form (`2026-04-21`). DM-263.
  const display = formatDateInputDisplay(t, val);
  if (display !== "") {
    // Chrome paints date input values in a tabular monospaced face; we route
    // through the system mono fallback so the segments don't kern.
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="11" font-family="ui-monospace, Menlo, monospace" fill="rgb(0,0,0)">${display.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))}</text>`);
  }
  // Picker icon on the right edge: calendar for date / month / week / datetime-local,
  // clock for time. Chrome paints these monochrome at ~14px in the input's
  // line-height. DM-263.
  const cx = el.x + el.width - 12;
  const cy = el.y + el.height / 2;
  const iconSize = Math.min(11, el.height - 6);
  if (t === "time") {
    parts.push(renderClockIcon(indent, cx, cy, iconSize));
  } else {
    parts.push(renderCalendarIcon(indent, cx, cy, iconSize));
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

function renderCalendarIcon(indent: string, cx: number, cy: number, size: number): string {
  // Simple calendar glyph: rounded rect with two top "binders" and a grid line.
  const w = size;
  const h = size;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const stroke = TRACK_FG;
  return `${indent}<g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round"><rect x="${r(x + 0.5)}" y="${r(y + 1.5)}" width="${r(w - 1)}" height="${r(h - 2)}" rx="1" /><line x1="${r(x + 0.5)}" y1="${r(y + 4)}" x2="${r(x + w - 0.5)}" y2="${r(y + 4)}" /><line x1="${r(x + 3)}" y1="${r(y + 0.5)}" x2="${r(x + 3)}" y2="${r(y + 2.5)}" /><line x1="${r(x + w - 3)}" y1="${r(y + 0.5)}" x2="${r(x + w - 3)}" y2="${r(y + 2.5)}" /></g>`;
}

function renderClockIcon(indent: string, cx: number, cy: number, size: number): string {
  // Simple clock glyph: circle with two hands.
  const r1 = size / 2;
  const stroke = TRACK_FG;
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
  const value = el.styles.progressValue;
  const max = el.styles.progressMax ?? 1;
  const isIndeterminate = value == null;
  const ratio = !isIndeterminate && max > 0 ? Math.max(0, Math.min(1, (value as number) / max)) : 0;
  const parts: string[] = [];
  const accent = resolveAccent(el);
  // Custom pseudo-element fills override the UA defaults when present
  // (SK-1222: capture now flows through the stylesheet walker rather than
  // the broken getComputedStyle-on-pseudo path, so author rules round-trip).
  const customTrackFill = customPseudoFill(el.styles.progressBarBg, el.styles.progressBarBgImage);
  const customValueFill = customPseudoFill(el.styles.progressValueBg, el.styles.progressValueBgImage);
  const trackFill = customTrackFill ?? TRACK_BG;
  const valueFill = customValueFill ?? accent;
  // UA-default <progress>: empirical Chrome-on-macOS paint is a centered bar
  // inset by floor(h/4) top and bottom, with a small pill radius that only
  // appears once barH exceeds ~8px. Sampled blue value pseudo (DM-354):
  //   h=8  → barH=4  inset=2  rx=0  (square, AA only)
  //   h=14 → barH=8  inset=3  rx=0  (square, AA only)
  //   h=16 → barH=8  inset=4  rx=0  (square, AA only)
  //   h=40 → barH=20 inset=10 rx≈6 (partial pill, NOT full half-circle)
  // The previous DM-337 formula (barH=h/2, rx=barH/2) over-rounded at h≤16
  // and over-rounded at h=40 (full pill instead of partial).
  //
  // Author-styled <progress> (appearance:none with custom pseudo bg or
  // pseudo border-radius) — empirically Chrome does NOT propagate the host's
  // border-radius to the pseudos; only the pseudo's own border-radius rounds
  // them. So when no pseudo border-radius is set, default to 0 (square),
  // not el.height/2 (full pill).
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (el.styles.progressBarRadius != null && el.styles.progressBarRadius !== "0px")
    || (el.styles.progressValueRadius != null && el.styles.progressValueRadius !== "0px");
  const inset = Math.floor(el.height / 4);
  const barH = isAuthorStyled ? el.height : el.height - 2 * inset;
  const barY = isAuthorStyled ? el.y : el.y + inset;
  const trackRadius = isAuthorStyled
    ? (el.styles.progressBarRadius != null && el.styles.progressBarRadius !== "0px"
        ? parseFloat(el.styles.progressBarRadius) || 0 : 0)
    : Math.max(0, (barH - 8) / 2);
  const valueRadius = isAuthorStyled
    ? (el.styles.progressValueRadius != null && el.styles.progressValueRadius !== "0px"
        ? parseFloat(el.styles.progressValueRadius) || 0 : 0)
    : Math.max(0, (barH - 8) / 2);
  // Gradient fills (SK-1224 / SK-1225) for progress pseudos: when the
  // captured ::-webkit-progress-bar / -value bg-image parses as a gradient,
  // emit a <linearGradient> / <radialGradient> def and reference it via
  // fill="url(#...)". Fall back to the flat trackFill / valueFill above.
  const trackRect = { x: el.x, y: barY, w: el.width, h: barH };
  const trackGrad = gradientFillFor(el.styles.progressBarBgImage, trackRect, defCtx);
  parts.push(`${indent}<rect x="${r(el.x)}" y="${r(barY)}" width="${r(el.width)}" height="${r(barH)}" rx="${r(trackRadius)}" fill="${trackGrad ?? trackFill}" />`);
  if (isIndeterminate) {
    // Chromium indeterminate progress shows a short moving bar. For a static
    // frame, approximate with a ~25% bar near the left (matches a mid-cycle).
    const barW = Math.min(el.width * 0.25, 60);
    const barX = el.x + el.width * 0.1;
    const valueRect = { x: barX, y: barY, w: barW, h: barH };
    const valueGrad = gradientFillFor(el.styles.progressValueBgImage, valueRect, defCtx);
    parts.push(`${indent}<rect x="${r(barX)}" y="${r(barY)}" width="${r(barW)}" height="${r(barH)}" rx="${r(valueRadius)}" fill="${valueGrad ?? valueFill}" />`);
  } else if (ratio > 0) {
    const valueW = el.width * ratio;
    const valueRect = { x: el.x, y: barY, w: valueW, h: barH };
    const valueGrad = gradientFillFor(el.styles.progressValueBgImage, valueRect, defCtx);
    parts.push(`${indent}<rect x="${r(el.x)}" y="${r(barY)}" width="${r(valueW)}" height="${r(barH)}" rx="${r(valueRadius)}" fill="${valueGrad ?? valueFill}" />`);
  }
  return parts.join("\n");
}

function renderMeter(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
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
  let valueBgImage: string | undefined;
  let customValueFill: string | null;
  if (dist === 0) {
    customValueFill = customPseudoFill(el.styles.meterOptimumBg, el.styles.meterOptimumBgImage);
    valueBgImage = el.styles.meterOptimumBgImage;
  } else if (dist === 1) {
    customValueFill = customPseudoFill(el.styles.meterSuboptimumBg, el.styles.meterSuboptimumBgImage);
    valueBgImage = el.styles.meterSuboptimumBgImage;
  } else {
    customValueFill = customPseudoFill(el.styles.meterEvenLessGoodBg, el.styles.meterEvenLessGoodBgImage);
    valueBgImage = el.styles.meterEvenLessGoodBgImage;
  }
  const defaultFill = dist === 0 ? METER_GREEN : dist === 1 ? METER_YELLOW : METER_RED;
  const fill = customValueFill ?? defaultFill;
  const trackFill = customTrackFill ?? TRACK_BG;
  // Same UA-default formula as <progress> (DM-354): inset=floor(h/4) top
  // and bottom, with a partial pill radius that only emerges past barH≈8.
  // Author-styled <meter> (appearance:none with custom pseudo) uses the
  // pseudo's own border-radius, defaulting to 0 (Chrome doesn't propagate
  // the host's border-radius to the pseudos in styled mode).
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px");
  const inset = Math.floor(el.height / 4);
  const barH = isAuthorStyled ? el.height : el.height - 2 * inset;
  const barY = isAuthorStyled ? el.y : el.y + inset;
  const trackRadius = isAuthorStyled
    ? (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px"
        ? parseFloat(el.styles.meterBarRadius) || 0 : 0)
    : Math.max(0, (barH - 8) / 2);

  const parts: string[] = [];
  // Gradient fills (SK-1222 + SK-1224 / SK-1225) for meter pseudos.
  const trackRect = { x: el.x, y: barY, w: el.width, h: barH };
  const trackGrad = gradientFillFor(el.styles.meterBarBgImage, trackRect, defCtx);
  parts.push(`${indent}<rect x="${r(el.x)}" y="${r(barY)}" width="${r(el.width)}" height="${r(barH)}" rx="${r(trackRadius)}" fill="${trackGrad ?? trackFill}" />`);
  if (ratio > 0) {
    const valueW = el.width * ratio;
    const valueRect = { x: el.x, y: barY, w: valueW, h: barH };
    const valueGrad = gradientFillFor(valueBgImage, valueRect, defCtx);
    parts.push(`${indent}<rect x="${r(el.x)}" y="${r(barY)}" width="${r(valueW)}" height="${r(barH)}" rx="${r(trackRadius)}" fill="${valueGrad ?? fill}" />`);
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
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="${fontFamily}" fill="${color}"${fontStyleAttr}${fontWeightAttr}${opacityAttr}>${escaped}</text>`);
  }
  return parts.join("\n");
}

function renderSelectChevron(el: CapturedElement, indent: string): string {
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
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSize)}" font-family="${fontFamily}" font-weight="${fontWeight}" fill="${color}">${escaped}</text>`);
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
    parts.push(`${indent}<polyline points="${p(-0.35, -0.18)} ${p(0, 0.18)} ${p(0.35, -0.18)}" fill="none" stroke="${TRACK_FG}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`);
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
  const size = Math.max(8, fontSizePx * 0.6);
  // Vertically center the triangle on the first text line (line-height
  // typically = 1.2 × font-size, baseline ~0.8 × line-height down).
  const lineH = parseFloat(el.styles.lineHeight ?? "") || fontSizePx * 1.5;
  // Position: marker sits inside the summary at its content-start, which
  // is el.x + paddingL + borderL. Offset by half the marker size so the
  // glyph's center sits ~half-marker-width past the summary's left edge,
  // matching Chrome's painted offset (DM-448).
  const padL = parseFloat(el.styles.paddingLeft ?? "") || 0;
  const brL = parseFloat(el.styles.borderLeftWidth ?? "") || 0;
  const cx = el.x + padL + brL + size / 2;
  const cy = el.y + lineH / 2;
  const open = el.styles.detailsOpen === true;
  // Use the summary's text color when captured, else dark grey.
  const fill = (el.styles.color != null && el.styles.color !== "")
    ? el.styles.color : "rgb(0,0,0)";
  const half = size / 2;
  // Right-pointing (closed): ▶ — apex at right. Down-pointing (open): ▼ — apex at bottom.
  const p = open
    ? `${r(cx - half)},${r(cy - half * 0.6)} ${r(cx + half)},${r(cy - half * 0.6)} ${r(cx)},${r(cy + half * 0.7)}`
    : `${r(cx - half * 0.7)},${r(cy - half)} ${r(cx + half * 0.6)},${r(cy)} ${r(cx - half * 0.7)},${r(cy + half)}`;
  return `${indent}<polygon points="${p}" fill="${fill}" />`;
}
