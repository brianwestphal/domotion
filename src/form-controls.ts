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
const UA_BORDER = "rgb(118,118,118)";
const UA_FILL = "rgb(255,255,255)";
const ACCENT_BLUE = "rgb(0,122,255)";
const TRACK_BG = "rgb(237,237,237)";
const TRACK_FG = "rgb(118,118,118)";
const METER_GREEN = "rgb(48,160,63)";
const METER_YELLOW = "rgb(234,162,50)";
const METER_RED = "rgb(232,78,78)";
const DISABLED_BORDER = "rgba(118,118,118,0.5)";

function r(n: number): string { return Number(n.toFixed(1)).toString(); }

/** Resolve CSS accent-color to a concrete fill. 'auto' (or missing) falls back
 *  to the Chromium macOS default blue. Author-set values pass through. */
function resolveAccent(el: CapturedElement): string {
  const ac = el.styles.accentColor;
  if (ac == null || ac === "" || ac === "auto" || ac === "currentcolor") return ACCENT_BLUE;
  return ac;
}

export function renderFormControl(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const tag = el.tag;
  if (tag === "input") return renderInputControl(el, indent, defCtx);
  if (tag === "progress") return renderProgress(el, indent, defCtx);
  if (tag === "meter") return renderMeter(el, indent, defCtx);
  if (tag === "select" && el.styles.selectChevron === true) return renderSelectChevron(el, indent);
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

function renderRadio(el: CapturedElement, indent: string): string {
  const size = Math.min(el.width, el.height);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rr = size / 2;
  const parts: string[] = [];
  const stroke = el.styles.disabled ? DISABLED_BORDER : UA_BORDER;
  const accent = resolveAccent(el);
  if (el.styles.checked === true) {
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr)}" fill="${accent}" />`);
    parts.push(`${indent}<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr * 0.35)}" fill="#fff" />`);
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
  const s = el.styles;
  const styledTrack = s.rangeTrackBg != null;
  const styledThumb = s.rangeThumbWidth != null;
  const trackH = styledTrack ? (parseFloat(s.rangeTrackHeight ?? "") || 4) : 4;
  const trackR = styledTrack ? (parseFloat(s.rangeTrackRadius ?? "") || 0) : 2;
  const trackBgColor = styledTrack && s.rangeTrackBg !== "rgba(0, 0, 0, 0)" ? s.rangeTrackBg! : TRACK_BG;
  const thumbW = styledThumb ? (parseFloat(s.rangeThumbWidth ?? "") || 14) : 14;
  const thumbH = styledThumb ? (parseFloat(s.rangeThumbHeight ?? "") || thumbW) : 14;
  const thumbRadius = styledThumb ? (parseFloat(s.rangeThumbRadius ?? "") || thumbW / 2) : thumbW / 2;
  const cy = el.y + el.height / 2;
  const trackY = cy - trackH / 2;
  const halfThumb = thumbW / 2;
  const parts: string[] = [];
  const accent = resolveAccent(el);
  const valStr = s.inputValue;
  const minStr = s.inputMin;
  const maxStr = s.inputMax;
  const val = valStr != null && valStr !== "" ? parseFloat(valStr) : NaN;
  const min = minStr != null && minStr !== "" ? parseFloat(minStr) : 0;
  const max = maxStr != null && maxStr !== "" ? parseFloat(maxStr) : 100;
  const ratio = !isNaN(val) && max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0.5;
  const trackLeft = el.x + halfThumb;
  const trackRight = el.x + el.width - halfThumb;
  const thumbX = trackLeft + (trackRight - trackLeft) * ratio;
  const trackW = el.width - thumbW;
  const trackGradFill = gradientFillFor(s.rangeTrackBgImage, { x: trackLeft, y: trackY, w: trackW, h: trackH }, defCtx);
  const trackFill = trackGradFill ?? trackBgColor;
  parts.push(`${indent}<rect x="${r(trackLeft)}" y="${r(trackY)}" width="${r(trackW)}" height="${r(trackH)}" rx="${r(trackR)}" fill="${trackFill}" />`);
  // UA default paints an accent-colored fill from the track left to the
  // thumb. Author-styled tracks usually replace this with their own
  // background, so skip the accent fill when the track was overridden.
  if (!styledTrack) {
    parts.push(`${indent}<rect x="${r(trackLeft)}" y="${r(trackY)}" width="${r(Math.max(0, thumbX - trackLeft))}" height="${r(trackH)}" rx="${r(trackR)}" fill="${accent}" />`);
  }
  // Author-styled non-square thumb: render as a rect (matches rectangular
  // and pill-shaped thumbs). Default UA thumb is a circle.
  if (styledThumb && (thumbH !== thumbW || thumbRadius < thumbW / 2)) {
    const thumbBgColor = s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : UA_FILL;
    const thumbRect = { x: thumbX - thumbW / 2, y: cy - thumbH / 2, w: thumbW, h: thumbH };
    const thumbGradFill = gradientFillFor(s.rangeThumbBgImage, thumbRect, defCtx);
    const thumbFill = thumbGradFill ?? thumbBgColor;
    parts.push(`${indent}<rect x="${r(thumbRect.x)}" y="${r(thumbRect.y)}" width="${r(thumbW)}" height="${r(thumbH)}" rx="${r(thumbRadius)}" fill="${thumbFill}" />`);
  } else {
    const thumbBgColor = styledThumb && s.rangeThumbBg != null && s.rangeThumbBg !== "" && s.rangeThumbBg !== "rgba(0, 0, 0, 0)" ? s.rangeThumbBg : UA_FILL;
    const thumbRect = { x: thumbX - halfThumb, y: cy - halfThumb, w: thumbW, h: thumbW };
    const thumbGradFill = gradientFillFor(s.rangeThumbBgImage, thumbRect, defCtx);
    const thumbFill = thumbGradFill ?? thumbBgColor;
    parts.push(`${indent}<circle cx="${r(thumbX)}" cy="${r(cy)}" r="${r(halfThumb)}" fill="${thumbFill}" stroke="${UA_BORDER}" stroke-width="1" />`);
  }
  return parts.join("\n");
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
 * (the "X" reset button) on the right edge — only when the input value
 * is non-empty (matches Chromium's behavior). Author rules captured via
 * the SK-1223 walker override the UA defaults.
 */
function renderSearchInput(el: CapturedElement, indent: string, defCtx?: DefCtx): string {
  const s = el.styles;
  if (s.inputValue == null || s.inputValue === "") return "";
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
  // Resolve styles from the captured pseudo, with UA defaults as fallback.
  const bg = s.fileButtonBg != null && s.fileButtonBg !== "" ? s.fileButtonBg : "rgb(239,239,239)";
  const color = s.fileButtonColor != null && s.fileButtonColor !== "" ? s.fileButtonColor : "rgb(0,0,0)";
  const radius = s.fileButtonBorderRadius != null ? (parseFloat(s.fileButtonBorderRadius) || 3) : 3;
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
  const fontSize = 11;
  // Approximate "Choose File" width: ~6.5px/char at 11px font, plus padding.
  const labelText = "Choose File";
  const textW = labelText.length * fontSize * 0.6;
  const btnW = textW + padH * 2;
  const btnH = Math.min(fontSize + padV * 2, el.height);
  const bx = el.x + 2;
  const by = el.y + (el.height - btnH) / 2;
  const strokeAttrs = borderW > 0 ? ` stroke="${borderColor}" stroke-width="${borderW}"` : "";
  parts.push(`${indent}<rect x="${r(bx)}" y="${r(by)}" width="${r(btnW)}" height="${r(btnH)}" rx="${r(radius)}" fill="${bg}"${strokeAttrs} />`);
  parts.push(`${indent}<text x="${r(bx + btnW / 2)}" y="${r(by + btnH / 2 + 4)}" text-anchor="middle" font-size="${fontSize}" font-weight="${fontWeight}" font-family="-apple-system, system-ui, sans-serif" fill="${color}">${labelText}</text>`);
  const label = el.styles.inputFileName != null && el.styles.inputFileName !== "" ? el.styles.inputFileName : "No file chosen";
  parts.push(`${indent}<text x="${r(bx + btnW + 8)}" y="${r(by + btnH / 2 + 4)}" font-size="${fontSize}" font-family="-apple-system, system-ui, sans-serif" fill="rgb(0,0,0)">${label.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))}</text>`);
  return parts.join("\n");
}

/**
 * Date/time/datetime-local/month/week/color picker chrome: show the captured
 * value as text plus a small picker indicator on the right.
 */
function renderDatePicker(el: CapturedElement, indent: string): string {
  const parts: string[] = [];
  const val = el.styles.inputValue ?? "";
  const tx = el.x + 6;
  const ty = el.y + el.height / 2 + 4;
  if (val !== "") {
    parts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="11" font-family="-apple-system, system-ui, sans-serif" fill="rgb(0,0,0)">${val.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))}</text>`);
  }
  // Chevron on the right (like <select>).
  const size = Math.min(8, el.height * 0.4);
  const cx = el.x + el.width - 10;
  const cy = el.y + el.height / 2;
  const p = (dx: number, dy: number): string => `${r(cx + dx * size)},${r(cy + dy * size)}`;
  parts.push(`${indent}<polyline points="${p(-0.35, -0.18)} ${p(0, 0.18)} ${p(0.35, -0.18)}" fill="none" stroke="${TRACK_FG}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`);
  return parts.join("\n");
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
  // Chromium on macOS paints the unstyled progress bar as a THIN flat stripe
  // centered vertically in the element box — not a fully-rounded pill filling
  // the whole height. Match that by insetting to a small inner rect when no
  // custom pseudo styling is in play. Author-styled bars (pseudos with
  // explicit bg / border-radius) go through the full-height path so authors
  // still get what they asked for.
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (el.styles.progressBarRadius != null && el.styles.progressBarRadius !== "0px")
    || (el.styles.progressValueRadius != null && el.styles.progressValueRadius !== "0px");
  const barH = isAuthorStyled ? el.height : Math.min(6, el.height);
  const barY = el.y + (el.height - barH) / 2;
  const trackRadius = isAuthorStyled
    ? (el.styles.progressBarRadius != null && el.styles.progressBarRadius !== "0px"
        ? parseFloat(el.styles.progressBarRadius) || el.height / 2 : el.height / 2)
    : 0;
  const valueRadius = isAuthorStyled
    ? (el.styles.progressValueRadius != null && el.styles.progressValueRadius !== "0px"
        ? parseFloat(el.styles.progressValueRadius) || el.height / 2 : el.height / 2)
    : 0;
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
  // Same inset-thin-bar convention as <progress>: Chromium macOS paints the
  // unstyled meter as a thin flat stripe centered in the element box.
  const isAuthorStyled = customTrackFill != null || customValueFill != null
    || (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px");
  const barH = isAuthorStyled ? el.height : Math.min(6, el.height);
  const barY = el.y + (el.height - barH) / 2;
  const trackRadius = isAuthorStyled
    ? (el.styles.meterBarRadius != null && el.styles.meterBarRadius !== "0px"
        ? parseFloat(el.styles.meterBarRadius) || el.height / 2 : el.height / 2)
    : 0;

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

function renderSelectChevron(el: CapturedElement, indent: string): string {
  // Chromium macOS default: small down-chevron near the right edge.
  const size = Math.min(10, el.height * 0.5);
  const cx = el.x + el.width - 10;
  const cy = el.y + el.height / 2;
  const p = (dx: number, dy: number): string => `${r(cx + dx * size)},${r(cy + dy * size)}`;
  return `${indent}<polyline points="${p(-0.35, -0.18)} ${p(0, 0.18)} ${p(0.35, -0.18)}" fill="none" stroke="${TRACK_FG}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`;
}

function renderDetailsMarker(el: CapturedElement, indent: string): string {
  // Disclosure triangle left of the first line. 10x10, rotated 90deg when open.
  const size = 8;
  const x = el.x + 2;
  const y = el.y + 8;
  const open = el.styles.detailsOpen === true;
  const p = open
    ? `${r(x)},${r(y)} ${r(x + size)},${r(y)} ${r(x + size / 2)},${r(y + size * 0.8)}`
    : `${r(x)},${r(y)} ${r(x + size * 0.8)},${r(y + size / 2)} ${r(x)},${r(y + size)}`;
  return `${indent}<polygon points="${p}" fill="${TRACK_FG}" />`;
}
