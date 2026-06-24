/**
 * DOM-to-SVG Converter
 *
 * Uses Playwright to inspect DOM elements and recreate them as native SVG.
 */

import type { ElementHandle, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as fontkit from "fontkit";
import { renderSingleLineText, renderMultiSegmentText, renderMultiLineText, renderInputText } from "./text.js";
import { renderVerticalSegments, hasVerticalSegments } from "./vertical-text.js";
import { getEmbeddedFontFaceCss, getGlyphDefs, measureLastGlyphRsb, fontSpaceAdvancePx, renderRadicalGlyph } from "./text-to-path.js";
import { profAccum, profNow } from "./render-profile.js";
import type { DefCtx } from "./form-controls.js";
import { renderFormControl } from "./form-controls.js";
import { CAPTURE_SCRIPT } from "../capture/script.generated.js";
import { r, esc, stopFmt } from "./format.js";
import { translateClipPath } from "./clip-path.js";
import { buildImagePatternDef } from "./image-pattern.js";
import { buildLinearGradientDef, buildRadialGradientDef, parseBgPositionPx, type GradientStop } from "./gradient-defs.js";
import { isFlexOrGridContainerDisplay, establishesStackingContext, gatherStackingContextChildren, isOverflowOnlySC } from "./stacking.js";
export { parseGradientStops, buildRadialGradientDef, parseBgPositionPx } from "./gradient-defs.js"; // re-export for existing test importers
import { buildMaskDef, buildMaskBorder9Slice, positionFragmentMaskDef, positionFragmentClipPathDef, rewriteFragmentMaskDef } from "./mask.js";
// Re-exported for existing importers (mask.test.ts, mask-contain-align.test.ts) — public entry unchanged.
export { buildMaskDef, positionFragmentMaskDef, rewriteFragmentMaskDef, maskContainAlign } from "./mask.js";
import { parseColor, colorStr, sameColor, shadeColor, type RGBA } from "./colors.js";
import {
  parseCornerRadii,
  insetCornerRadii,
  outsetCornerRadiiForShadow,
  roundedRectPath,
  roundedRectSvg,
  parseSide,
  dashArrayForStyle,
  renderBorderImage,
  injectSvgSize,
  computeWedgeApexes,
  wedgePolygonPoints,
  findOffGridCollapsedCells,
  type CornerRadii,
  type CornerRadiusPair,
  type BorderSide,
} from "./borders.js";
import { parseBoxShadow, type BoxShadow } from "./box-shadow.js";
import { cssTransformToSvg } from "./transforms.js";
import { parseCssUrl, splitTopLevelCommas } from "./css-tokens.js";
import { convertLegacyWebkitGradient } from "./gradients.js";
import type { CapturedElement, TextSegment, MaskFragmentDef, MaskRasterRef, ClipPathFragmentDef, CaptureWarning } from "../capture/types.js";
import {
  _dataUriCache,
  _resizedDataUriCache,
  embedResizedDataUri,
  embedRemoteImages,
  setActiveHiDPIFactor,
  type EmbedRemoteImagesOptions,
} from "../capture/embed.js";
import { getLastCaptureWarnings, logCaptureWarnings, _resetLastCaptureWarnings } from "../capture/warnings.js";
import { rasterizeBitmapGlyphs } from "../capture/emoji.js";

// Public-API re-exports kept here for backward compatibility — older imports
// from `./render/element-tree-to-svg.js` keep resolving. Internal consumers
// should prefer importing from `../capture/{embed,warnings,index}.js` directly.
export { _dataUriCache, _resizedDataUriCache, embedResizedDataUri, embedRemoteImages, type EmbedRemoteImagesOptions } from "../capture/embed.js";
export { getLastCaptureWarnings, logCaptureWarnings } from "../capture/warnings.js";
export { captureElementTree, captureElementTreeWithWarnings, calibrateBaselines } from "../capture/index.js";

/**
 * @internal — DM-549. Per-conic-gradient-layer-text map of `${tileW}x${tileH}` →
 * data URI containing rasterized PNG bytes. Populated by `rasterizeConicGradients`
 * (the conic raster pre-pass) and read by `buildConicGradientDef` (DM-550) when
 * the renderer emits a `<pattern><image>` for a conic background layer. Empty
 * at module load — first capture with conic content fills it.
 */
export const _conicTileCache = new Map<string, Map<string, string>>();


/**
 * Wrap inner SVG markup (as returned by `elementTreeToSvg`) in a complete
 * `<svg>` document with the standard namespace, viewBox, and intrinsic size.
 * This is the boilerplate every standalone-capture user would otherwise write
 * themselves — call this when you want a self-contained SVG file.
 */
export function wrapSvg(inner: string, width: number, height: number, opts?: { tree?: CapturedElement[] }): string {
  const schemeAttr = opts?.tree != null ? rootSvgColorSchemeAttr(opts.tree) : "";
  // DM-554: when given the captured tree, emit a transparent-root body-bg
  // rect using the tree's resolved-by-Chromium `rootBgComputed`. Skipped
  // when `rootBgComputed` is missing (back-compat with pre-DM-552 trees) or
  // explicitly transparent (the page intends a transparent SVG output).
  const rootBgRect = opts?.tree != null ? transparentRootBgRect(opts.tree, width, height) : "";
  // Captured inline SVG subtrees may carry `xlink:href` (gradient stop
  // inheritance, `<use>`, mask/pattern refs). Without xmlns:xlink declared,
  // XML parsing fails with "Namespace prefix xlink for href is not defined"
  // and Chrome refuses to render past the first occurrence.
  const xlinkAttr = inner.includes("xlink:") ? ` xmlns:xlink="http://www.w3.org/1999/xlink"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlinkAttr} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${schemeAttr}>${rootBgRect}${inner}</svg>`;
}

/**
 * DM-552: returns ` color-scheme="dark"` (with leading space, suitable for
 * direct concatenation into an `<svg ...>` opening tag) when the captured
 * tree's root reports `rootColorScheme === "dark"`. Returns an empty string
 * for the light / no-scheme case so today's SVG output is byte-identical at
 * the default. Use from any code path that emits a root `<svg>` outside of
 * `wrapSvg` (e.g., `tests/runner.tsx` and `tests/real-world.tsx` build their
 * own opening tags so they can inject a body-bg `<rect>` underneath the
 * captured content).
 */
export function rootSvgColorSchemeAttr(elements: CapturedElement[]): string {
  if (elements.length === 0) return "";
  return elements[0].styles?.rootColorScheme === "dark" ? ` color-scheme="dark"` : "";
}

/**
 * DM-554: returns a body-bg `<rect>` markup string for the canvas when the
 * captured tree's root provides a `rootBgComputed` (set by CAPTURE_SCRIPT
 * from `getComputedStyle(document.documentElement).backgroundColor`).
 * Returns an empty string when the field is missing (pre-DM-552 captures)
 * or the resolved bg is transparent (pages that intend a transparent SVG).
 *
 * Used by `wrapSvg` and exported so external consumers that build their
 * own `<svg>` opening tag (because they need to inject a body-bg rect at a
 * specific position relative to other root-level rects, e.g. a frame
 * overlay) can produce the same markup without re-implementing the
 * fallback chain.
 */
export function transparentRootBgRect(elements: CapturedElement[], width: number, height: number): string {
  if (elements.length === 0) return "";
  const styles = elements[0].styles;
  const rootBg = styles?.rootBgComputed;
  if (rootBg == null || rootBg === "" || rootBg === "rgba(0, 0, 0, 0)" || rootBg === "transparent") {
    return "";
  }
  return `<rect width="${width}" height="${height}" fill="${rootBg}" />`;
}

/**
 * Convert a CapturedElement tree into the **inner** SVG body markup —
 * the `<defs>` + paint groups that go INSIDE a root `<svg>` tag, but
 * NOT the `<svg xmlns viewBox …>` opening tag itself. Returned string
 * is not a complete SVG document; either pass it to `wrapSvg()` or
 * call `elementTreeToSvg()` (the wrapper that combines the two).
 *
 * Use this directly only when composing multiple frames into one big
 * SVG (the animator + scroll composer use it that way), where the
 * outer `<svg>` is emitted once and each frame contributes inner
 * content with its own `idPrefix` to avoid clipPath ID collisions.
 *
 * Renamed in DM-950: the function used to be exported as
 * `elementTreeToSvg`, which was confusing because the returned string
 * wasn't actually a valid SVG document. Callers that want a complete
 * document should switch to the new `elementTreeToSvg()` below.
 */
// Outset box-shadow paint (the non-fragmented path), extracted from renderElement
// (DM-1306 / DM-1314). Iterates the shadow list deepest-first, routes blur through
// an SVG <filter feGaussianBlur>, outsets the corners per spread. clipIdx threaded
// in/out so the positional filter ids stay byte-identical.
function paintBoxShadow(
  el: CapturedElement,
  corners: ReturnType<typeof parseCornerRadii>,
  idPrefix: string,
  indent: string,
  clipIdx: number,
): { svg: string[]; defs: string[]; clipIdx: number } {
  const svg: string[] = [];
  const defs: string[] = [];
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
  for (let si = shadows.length - 1; si >= 0; si--) {
    const sh = shadows[si];
    if (sh.inset) continue;
    // Negative spread is allowed: per CSS Backgrounds 3 §6.4 the shadow
    // shape's width/height = box + 2*spread (so spread < 0 shrinks the
    // shadow). Chromium's `BoxShadowData::ApplyToBoxOuter` shrinks the
    // outer rect by `-spread` on each side and zero-clamps the result.
    // Rect inflated by spread and shifted by (x, y).
    const sx = el.x + sh.x - sh.spread;
    const sy = el.y + sh.y - sh.spread;
    const sw = el.width + sh.spread * 2;
    const sh2 = el.height + sh.spread * 2;
    if (sw <= 0 || sh2 <= 0) continue;
    // Outer shadow corners per CSS Backgrounds 3 §6.4 / Chromium
    // `FloatRoundedRect::Outset`: a non-zero source corner grows by
    // `spread`; a zero source corner STAYS sharp. The naive grow-all
    // path produced visibly rounded corners on the concentric-outline
    // pattern (box-shadow: 0 0 0 Npx on a 0-radius box).
    const shadowCorners = outsetCornerRadiiForShadow(corners, sh.spread);
    let filterAttr = "";
    if (sh.blur > 0) {
      const stdDev = sh.blur / 2;
      const fid = `${idPrefix}sh${clipIdx++}`;
      // Filter region needs to extend beyond the shadow rect by enough
      // padding to keep the Gaussian fall-off from clipping. Use a
      // generous 200% on each side; primitiveUnits inherits the default
      // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
      defs.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
      );
      filterAttr = ` filter="url(#${fid})"`;
    }
    svg.push(
      `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr}`)}`,
    );
  }
  return { svg, defs, clipIdx };
}

// Image (<img> / <input type=image>) paint, extracted from renderElement (DM-1306,
// DM-1312). object-fit placement inside the content box, scale-down resolution,
// and the rounded-content-box clip for border-radius'd images. clipIdx is threaded
// in and returned so the positional clipPath ids stay byte-identical.
function paintImage(
  el: CapturedElement,
  borderRadius: number,
  corners: ReturnType<typeof parseCornerRadii>,
  idPrefix: string,
  indent: string,
  clipIdx: number,
): { svg: string[]; defs: string[]; clipIdx: number } {
  const svg: string[] = [];
  const defs: string[] = [];
  // Caller guards `el.imageSrc != null`; restate it here to narrow the type
  // (the original block was nested inside that guard in renderElement).
  if (el.imageSrc == null) return { svg, defs, clipIdx };
  const fit = el.styles.objectFit ?? "fill";
  // CSS object-fit operates on the CONTENT BOX (inside borders + padding),
  // not the border box (DM-378). For an <img width:200; aspect-ratio:4/1;
  // border:2px; object-fit:contain> the captured rect is 204x54 (border
  // box) but the image content must paint inside the 200x50 content area.
  // Subtract per-side border + padding before placing the <image>.
  const _bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const _bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const _bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const _bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const _padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
  const _padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
  const _padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
  const _padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
  const contentX = el.x + _bwL + _padL;
  const contentY = el.y + _bwT + _padT;
  const contentW = Math.max(0, el.width - _bwL - _bwR - _padL - _padR);
  const contentH = Math.max(0, el.height - _bwT - _bwB - _padT - _padB);
  // DM-1239: `object-fit: scale-down` is the smaller of `none` and
  // `contain` — render at intrinsic size when the image fits inside the
  // content box, otherwise shrink it like `contain`. We capture the <img>
  // intrinsic size (`imageIntrinsic`), so resolve scale-down concretely
  // instead of always falling back to `contain`. With no intrinsic size
  // (broken / not-yet-loaded), leave it as scale-down → the contain fallback.
  let fitEffective = fit;
  if (fit === "scale-down" && el.imageIntrinsic != null && el.imageIntrinsic.w > 0 && el.imageIntrinsic.h > 0) {
    fitEffective = (el.imageIntrinsic.w <= contentW && el.imageIntrinsic.h <= contentH) ? "none" : "contain";
  }
  // DM-670 / DM-672: if the `<img>` carries a border-radius, the painted
  // image must clip to the rounded content area — otherwise a 40×40
  // `border-radius: 50%` avatar paints as a square photo. Build a
  // rounded-content-box clip once, reuse it whether we take the
  // object-fit:none branch or the standard branch below.
  const innerCorners = (borderRadius > 0 || (corners.tl.h + corners.tr.h + corners.bl.h + corners.br.h) > 0)
    ? insetCornerRadii(corners, _bwT, _bwR, _bwB, _bwL)
    : null;
  const roundedClipId = innerCorners != null
    ? `${idPrefix}irc${clipIdx++}` : null;
  if (innerCorners != null && roundedClipId != null) {
    defs.push(
      `<clipPath id="${roundedClipId}">${roundedRectSvg(contentX, contentY, contentW, contentH, innerCorners, "")}</clipPath>`,
    );
  }
  if (fitEffective === "none" && el.imageIntrinsic != null && el.imageIntrinsic.w > 0 && el.imageIntrinsic.h > 0) {
    // object-fit: none -> render image at intrinsic size, aligned via
    // object-position inside the element's content box, and clip overflow.
    const iw = el.imageIntrinsic.w;
    const ih = el.imageIntrinsic.h;
    const { hPct, vPct } = parseObjectPosition(el.styles.objectPosition ?? "50% 50%");
    const ix = contentX + (contentW - iw) * (hPct / 100);
    const iy = contentY + (contentH - ih) * (vPct / 100);
    // When a border-radius is present, prefer the rounded clip over the
    // plain content-box rect (a rounded clip subsumes the rect clip:
    // anything inside the rounded shape is also inside the box).
    let clipId: string;
    if (roundedClipId != null) {
      clipId = roundedClipId;
    } else {
      clipId = `${idPrefix}ifn${clipIdx++}`;
      defs.push(`<clipPath id="${clipId}"><rect x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" /></clipPath>`);
    }
    svg.push(
      `${indent}<image href="${esc(embedResizedDataUri(el.imageSrc, iw, ih))}" x="${r(ix)}" y="${r(iy)}" width="${r(iw)}" height="${r(ih)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`,
    );
  } else {
    const par = preserveAspectRatioFor(fitEffective, el.styles.objectPosition);
    const clipAttr = roundedClipId != null ? ` clip-path="url(#${roundedClipId})"` : "";
    // DM-819: Chrome doesn't honor `preserveAspectRatio` on `<image>`
    // when the href is an SVG data URI — the embedded SVG paints at its
    // own intrinsic size (viewBox or width/height) regardless of the
    // outer slice/meet directive. Workaround: rewrite the inner SVG's
    // top-level attrs to bake in our consumer width / height and the
    // matching preserveAspectRatio so the inner SVG self-aligns, then
    // emit the outer `<image>` with `preserveAspectRatio="none"` (which
    // Chrome does honor for SVG sources). Pass-through for raster images.
    const finalSrc = embedResizedDataUri(el.imageSrc, contentW, contentH);
    const reHomedSrc = rewriteSvgDataUriPreserveAspectRatio(finalSrc, contentW, contentH, par);
    const outerPar = reHomedSrc !== finalSrc ? "none" : par;
    svg.push(
      `${indent}<image href="${esc(reHomedSrc)}" x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" preserveAspectRatio="${outerPar}"${clipAttr} />`,
    );
  }
  return { svg, defs, clipIdx };
}

// Background-color rect paint, extracted from renderElement (DM-1306, DM-1311).
// The opaque background-color fill (and the DM-476 frosted-backdrop fallback
// fill) that paints under all background-image layers. When the element paints
// as inline fragments the per-fragment renderer owns the background, so this
// no-ops. Reads only el + corners + indent + the resolved bgColor + the two
// gating flags; appends to no shared accumulator, so it returns its <rect>
// markup for the caller to push. Behaviour-identical.
function paintBackgroundColor(
  el: CapturedElement,
  corners: ReturnType<typeof parseCornerRadii>,
  indent: string,
  bgColor: ReturnType<typeof parseColor>,
  useInlineFragments: boolean,
  suppressEmptyCell: boolean,
): string[] {
  const out: string[] = [];
  if (useInlineFragments) {
    // background painted per-fragment in renderInlineFragments above
  } else if (!suppressEmptyCell && bgColor != null && bgColor.a > 0.01) {
    out.push(
      `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="${colorStr(bgColor)}"`)}`,
    );
  } else if (!suppressEmptyCell && el.styles.frostedBgFallback != null) {
    // DM-476: backdrop-filter has no SVG equivalent, so when this element
    // would have read as a frosted-glass surface in Chromium (transparent
    // bg + non-trivial backdrop-filter), paint the captured body-bg color as
    // an opaque fill so the element at least covers what's behind it. See
    // docs/19-frosted-backdrop-fallback.md.
    out.push(
      `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="${el.styles.frostedBgFallback}"`)}`,
    );
  }
  return out;
}

// Rasterized-snapshot paint for replaced elements — <canvas> / <video> /
// <iframe> / <object> / <embed> — extracted from renderElement (DM-1306,
// DM-1312). The post-capture rasterizeReplacedElements pass hid everything
// else on the page and screenshotted the element's content box, so the data
// URI is exactly the pixels Chrome painted inside the element's borders +
// padding. Painted on top of the normal bg/border and inside the element's
// own borders, mirroring how <img> sits inside its element box.
// preserveAspectRatio="none" matches the captured content-box rect exactly.
//
// Skip when the element ALSO has imageSrc (DM-598): that means it's an <img>
// that picked up a sprite-icon snapshot, and the imageSrc branch already
// emitted the correctly aspected <image>. Capture-side has the same guard; the
// render-side check protects against any other future path that sets both.
//
// Reads only el + indent and appends no shared state, so it returns its
// <image> markup for the caller to push. Behaviour-identical.
function paintRasterSnapshot(el: CapturedElement, indent: string): string[] {
  const out: string[] = [];
  // Caller guards the same condition; restate it so this stays a standalone
  // leaf and to narrow el.replacedSnapshot / its dataUri for the type checker.
  if (el.replacedSnapshot == null || el.replacedSnapshot.dataUri == null || el.imageSrc != null) {
    return out;
  }
  const rs = el.replacedSnapshot;
  // DM-506: when this is an image-replacement icon (sprite + off-screen text),
  // wrap the painted raster with an SVG <title> so screen readers and tooltip
  // UAs still surface the suppressed accessible label.
  if (el.imageReplacement != null && el.imageReplacement.titleText !== "") {
    out.push(
      `${indent}<image href="${rs.dataUri}" x="${r(rs.x)}" y="${r(rs.y)}" width="${r(rs.width)}" height="${r(rs.height)}" preserveAspectRatio="none"><title>${esc(el.imageReplacement.titleText)}</title></image>`,
    );
  } else {
    out.push(
      `${indent}<image href="${rs.dataUri}" x="${r(rs.x)}" y="${r(rs.y)}" width="${r(rs.width)}" height="${r(rs.height)}" preserveAspectRatio="none" />`,
    );
  }
  return out;
}

// List-item ::marker paint, extracted from renderElement (DM-1306, DM-1313).
// Synthesizes the list-style-image marker, the disc/circle/square shape marker,
// and the text marker (decimal / lower-alpha / lower-roman / custom ::marker
// content), with baseline + inline-size geometry calibrated against Chromium's
// list_marker.cc. Reads only el + the resolved textColor + indent; appends to no
// shared accumulator (no clipIdx, no defs) and does not recurse, so it returns
// its marker markup for the caller to push. Behaviour-identical.
function paintListMarker(
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  indent: string,
): string[] {
  const out: string[] = [];
    const isListItem = el.tag !== "summary"
      && el.styles.display != null
      && el.styles.display.includes("list-item");
    if (isListItem) {
      const lsImage = el.styles.listStyleImage;
      const lsType = el.styles.listStyleType ?? "disc";
      const fontSizePx = parseFloat(el.styles.fontSize) || 14;
      const lineHeightPx = parseFloat(el.styles.lineHeight) || fontSizePx * 1.2;
      const outside = el.styles.listStylePosition !== "inside";
      if (lsImage != null && lsImage !== "none") {
        const urlMatch = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(lsImage);
        if (urlMatch != null) {
          const intrinsic = el.listMarkerIntrinsic;
          const markerW = intrinsic != null && intrinsic.w > 0 ? intrinsic.w : 16;
          const markerH = intrinsic != null && intrinsic.h > 0 ? intrinsic.h : 16;
          // Chrome's outside list-style-image marker positioning (DM-298):
          // - Horizontal: image right edge sits ~7px to the left of the li's
          //   inline-start edge — pixel probe of `03-lists-style-image-position`
          //   showed Chrome's painted gap is 7-8px, not the 4px we previously
          //   used; the previous 4 left the marker 3px too far right.
          // - Vertical: image TOP aligns with li.top, not (el.height - markerH)/2.
          //   Chrome stretches the li's height to fit the marker but does NOT
          //   center it vertically — the marker is top-aligned with whatever
          //   line box would have started there. Pixel probe confirmed the
          //   2px Y offset that centering introduced.
          const mx = outside ? el.x - markerW - 7 : el.x;
          const my = outside ? el.y : el.y + (el.height - markerH) / 2;
          out.push(
            `${indent}<image href="${esc(embedResizedDataUri(urlMatch[1], markerW, markerH))}" x="${r(mx)}" y="${r(my)}" width="${r(markerW)}" height="${r(markerH)}" preserveAspectRatio="xMidYMid meet" />`,
          );
        }
      } else if (lsType !== "none" && lsType !== "") {
        // Synthesize a text/shape marker per list-style-type. Numeric and
        // alpha-based markers use el.listItemIndex (captured below).
        // Author CSS can override the markers color / font-weight / font-size
        // via the ::marker pseudo (SK-1115). Use those when present, falling
        // back to the lis own text color and font-size when not set.
        const markerStyleColor = el.markerColor != null ? parseColor(el.markerColor) : null;
        const markerColor = markerStyleColor != null && markerStyleColor.a > 0.01
          ? colorStr(markerStyleColor)
          : (textColor != null ? colorStr(textColor) : "rgb(0,0,0)");
        const markerFontSize = parseFloat(el.markerFontSize ?? "") || fontSizePx;
        const markerFontWeight = el.markerFontWeight ?? el.styles.fontWeight;
        // Text-marker baseline = li's text baseline. When CAPTURE_SCRIPT
        // recorded fontAscent (canvas.measureText().fontBoundingBoxAscent),
        // textTop+fontAscent is exactly where Chrome painted the body text
        // baseline (DM-237). Falling back to a 0.72*lineHeight approximation
        // when we don't have either textTop or fontAscent — that path is rare
        // (li with empty direct text), and visually close enough.
        const my = (el.textTop != null && el.fontAscent != null)
          ? el.textTop + el.fontAscent
          : el.y + lineHeightPx * 0.72;
        const shapeY = el.y + lineHeightPx / 2;
        // Default gap between marker right edge and the li's content-left.
        // Verified vs Chromium source `list_marker.cc::InlineMarginsForOutside`:
        //   const int kCMarkerPaddingPx = 7;
        //   margin_end = offset + kCMarkerPaddingPx + 1 - marker_inline_size;
        //   offset = font_metrics.Ascent() * 2 / 3;
        // So for 16 px Helvetica (Ascent ≈ 12.32, disc size ≈ 4.5):
        //   margin_end = 12.32*2/3 + 8 - 4.5 = 11.7 ≈ 12
        // Use the source formula directly — gives the right gap across
        // font sizes (vs the previous constant 12 which was only tuned at
        // 16 px). DM-403 (verified vs Chromium source).
        // Marker inline size is approximated as the disc diameter
        // (markerFontSize * 0.28 from the existing 0.14em-radius probe).
        // Ascent estimated as 0.77 * fontSize (Helvetica HHEA ratio
        // 1577/2048; close enough for the 8 px constant to dominate).
        const ascentForGap = markerFontSize * 0.77;
        const markerInlineSize = markerFontSize * 0.28;
        const gap = (ascentForGap * 2 / 3) + 8 - markerInlineSize;
        const idx = el.listItemIndex ?? 1;
        // Custom `::marker { content: "..." }` (DM-447). When set, Chrome
        // replaces the list-style-type bullet/number with the content
        // string. getComputedStyle returns content as a quoted CSS-string
        // (e.g. '"➤ "') or 'normal' for the default. Take any non-default
        // content as the marker label.
        const rawContent = el.markerContent;
        const hasCustomContent = rawContent != null
          && rawContent !== ""
          && rawContent !== "normal"
          && rawContent !== "none";
        if (hasCustomContent) {
          // Parse CSS `<string>`: strip surrounding quotes, take the first
          // string token, unescape backslash sequences. Multiple tokens
          // ("..." attr(x) "...") aren't supported here — first token wins.
          let label = rawContent;
          const sm = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(label);
          if (sm != null) label = sm[1] ?? sm[2] ?? "";
          label = label.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
          // DM-452: Codepoints with Emoji=Yes / Emoji_Presentation=No (e.g.
          // ➤ U+27A4 in the Dingbats block) default to text presentation in
          // HTML, but our SVG <text> on macOS often falls through to Apple
          // Color Emoji which paints them wider/right. Appending VS-15
          // (U+FE0E) forces text presentation, matching Chrome's HTML
          // ::marker paint. We restrict to codepoints we have empirically
          // observed to coerce-to-emoji in our SVG output; the broader
          // "every text-default emoji char" list is intentionally NOT applied
          // here because it risks false positives on author-painted glyphs.
          const textPresDefault = /[➤]/g;
          label = label.replace(textPresDefault, (ch) => ch + "︎");
          // DM-1119: the UA `::marker` is `white-space: normal`, so a
          // `@counter-style` suffix like `":  "` (two spaces) collapses to a
          // SINGLE space in Chrome's paint. Mirror that — otherwise the earlier
          // DM-770 `xml:space="preserve"` rendered both spaces and pushed the
          // marker ~1 space-width left of Chrome (measured on `domo-step`).
          label = collapseMarkerWhitespace(label);
          const markerFontFamily = el.markerFontFamily ?? el.styles.fontFamily;
          // DM-790: SVG `<text text-anchor="end">` places the anchor at the
          // last glyph's advance-end, not its visible-right edge. Chromium
          // paints the marker so its visible right sits ~7 px from the
          // content edge (`kCMarkerPaddingPx` in
          // `list_marker.cc::InlineMarginsForOutside`). Shape the label
          // through fontkit and read the last non-whitespace glyph's rsb so
          // the anchor compensates exactly: `mx = el.x − 7 + rsb`. The
          // helper trims trailing whitespace before measuring because
          // Chrome's SVG renderer collapses trailing whitespace under
          // `xml:space="preserve"` (DM-789 probed this). Built-in numeric
          // markers ending in `.` resolve back to `el.x − 4` via this same
          // formula (period rsb ≈ 3 px in system-ui).
          const markerLastRsb = measureLastGlyphRsb(label, markerFontSize, markerFontFamily, markerFontWeight);
          const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
          const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          // DM-1154: Blink right-aligns the marker box with its END at the list
          // item's content edge (`margin_end = 0`, `list_marker.cc`), so a marker
          // whose suffix is a trailing SPACE (e.g. `@counter-style { suffix: " " }`)
          // has that space's advance as the marker→content gap. SVG drops trailing
          // whitespace, so anchor the trimmed text's advance-end at
          // `el.x − (trailing-space advance)`. This lands wide symbols where Chrome
          // paints them (the prior fixed visible-right-at-`el.x − 7` model lost the
          // space's width and slid them ~2–4px right). Markers WITHOUT a trailing
          // space keep that model (it already matches Chrome's `.`-suffix gap).
          const trailingWs = /[ \t]+$/.exec(label);
          const mx = outside
            ? (trailingWs != null
                ? el.x - [...trailingWs[0]].length * fontSpaceAdvancePx(markerFontSize, markerFontFamily, markerFontWeight)
                : el.x - 7 + markerLastRsb)
            : el.x + borderL + padL;
          const anchor = outside ? "end" : "start";
          const escLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          // DM-1119: after the whitespace collapse above the label never holds
          // a run of 2+ spaces, and Chrome's `white-space: normal` marker trims
          // its trailing space (verified: the single-suffix-space emoji markers
          // here match when we strip it). So no `xml:space="preserve"` — SVG's
          // default collapse/trim mirrors the marker's own white-space handling.
          // (The pre-DM-1119 `preserve` on doubled suffix spaces rendered both
          // and slid the marker ~1 space-width left of Chrome.)
          const xmlSpace = "";
          out.push(
            `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}"${xmlSpace}>${escLabel}</text>`,
          );
        } else if (lsType === "disc" || lsType === "circle" || lsType === "square") {
          // Chrome's `::marker` paints disc/circle/square at a hardcoded
          // size that's LARGER than the bullet glyph U+2022's natural bbox
          // in the inherited font: empirical pixel probe (DM-374) of `<ul
          // style="font-family:Helvetica;font-size:16px"><li>` shows the
          // painted disc diameter is ~4.5px (radius ~0.14em), while
          // canvas.measureText("•") reports a 3.45px bbox (the smaller
          // glyph the prior 0.11em multiplier was calibrated against). The
          // marker doesn't actually use the bullet GLYPH — Chrome draws a
          // separate filled circle at its own scale (Blink::LayoutListMarker).
          // Same scaling applies to circle (stroked, same diameter) and
          // square (rect, same side). Empirical at multiple sizes: 16px →
          // ~4.5px, 32px → ~8px (linear in fontSize), so 0.14em is a clean
          // single value that lands close to Chrome at every font size we
          // care about. Apple Times / Times New Roman / SF Pro probe all
          // produced indistinguishable disc paints at the same em-radius —
          // Chrome's marker isn't font-family-aware (DM-340/350/358/371/etc.).
          const r0 = markerFontSize * 0.165;
          // Inside markers paint inside the principal block at the content
          // edge, not at the border-box edge. Per Chromium
          // `list_marker.cc::InlineMarginsForInside`, the marker box is
          // followed by a 1em end-margin before the text — the captured
          // textLeft already encodes that, so we just need to anchor the
          // marker glyph at content-edge + half-symbol-width.
          const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
          const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          const contentEdge = el.x + borderL + padL;
          const mx = outside ? el.x - gap - r0 : contentEdge + r0;
          if (lsType === "disc") {
            out.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="${markerColor}" />`);
          } else if (lsType === "circle") {
            out.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="none" stroke="${markerColor}" stroke-width="1" />`);
          } else {
            out.push(`${indent}<rect x="${r(mx - r0)}" y="${r(shapeY - r0)}" width="${r(r0 * 2)}" height="${r(r0 * 2)}" fill="${markerColor}" />`);
          }
        } else {
          // Text-based marker (decimal / lower-alpha / lower-roman / etc.).
          // Chrome's painted ::marker right edge sits ~7px left of li.x for
          // 16px sans-serif (pixel-probed on 03-lists-style-types DM-678 — the
          // VISIBLE last-pixel-of-"." sits at li.x - 7).
          //
          // SVG `text-anchor="end"` aligns the END of the LAST GLYPH'S ADVANCE
          // at `x`, not the visible right edge of that glyph. DM-790: measure
          // the last glyph's right-side-bearing through fontkit and add it
          // back to the visible-right target (`el.x − 7`, Chromium's
          // `kCMarkerPaddingPx`). For "01." the `.` glyph has ~3 px rsb in
          // system-ui Helvetica so `mx = el.x − 7 + 3 = el.x − 4` — the
          // previous hardcoded constant; for other suffixes (e.g. Greek-
          // marker styles ending in `)` or `α`) the rsb floats to whatever
          // the actual last glyph dictates.
          const label = formatListMarker(lsType, idx) + listMarkerSuffix(lsType);
          const markerFontFamily = el.markerFontFamily ?? el.styles.fontFamily;
          const builtinLastRsb = measureLastGlyphRsb(label, markerFontSize, markerFontFamily, markerFontWeight);
          const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
          const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          const mx = outside ? el.x - 7 + builtinLastRsb : el.x + borderL + padL;
          const anchor = outside ? "end" : "start";
          out.push(
            `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}">${label}</text>`,
          );
        }
      }
    }
  return out;
}

// Outline paint phase, extracted from elementTreeToSvgInner (DM-1306). Reads only
// el + the resolved borderRadius + indent; appends to no shared state, so it
// returns its <rect>/<line> markup for the caller to push. Behaviour-identical.
function paintOutline(el: CapturedElement, borderRadius: number, indent: string): string[] {
  const out: string[] = [];
  const ow = parseFloat(el.styles.outlineWidth ?? "0") || 0;
  const ostyle = el.styles.outlineStyle ?? "none";
  if (ow > 0 && ostyle !== "none" && ostyle !== "hidden") {
    const ocolor = parseColor(el.styles.outlineColor ?? el.styles.color);
    if (ocolor != null && ocolor.a > 0.01) {
      const offset = parseFloat(el.styles.outlineOffset ?? "0") || 0;
      // Outline rect outer edge is at border-box + offset. Stroke is
      // centered, so the rect goes at offset + ow/2 from the border-box.
      const inflate = offset + ow / 2;
      const ox = el.x - inflate;
      const oy = el.y - inflate;
      const owd = el.width + inflate * 2;
      const oh = el.height + inflate * 2;
      // Outline radius: CSS spec says rounded outlines follow the border
      // radius extended outward by the offset+width. Approximate.
      const oRadius = borderRadius > 0 ? borderRadius + inflate : 0;
      if (ostyle === "double" && ow >= 3) {
        // Chromium's PaintDoubleOutline (third_party/blink/renderer/core/
        // paint/outline_painter.cc): stroke_width = round(width / 3).
        // Outer stripe occupies the OUTER `sw` pixels of the outline rect,
        // inner stripe the INNER `sw` pixels, separated by `ow - 2*sw`.
        // The captured `ox / owd` is the centerline rect for a standard
        // ow-wide stroke (outer edge = ox - ow/2). Each stripe is `sw`
        // wide; the outer stripe's centerline sits at `outer_edge + sw/2`,
        // the inner stripe's at `inner_edge - sw/2 = outer_edge + ow -
        // sw/2`. Relative to ox that's −(ow-sw)/2 and +(ow-sw)/2. The
        // earlier formulation positioned both stripes inside the gap zone
        // and the inner stripe outside the border-box, producing one
        // visually-merged stroke. (DM-443.)
        const sw = Math.round(ow / 3);
        const half = (ow - sw) / 2;
        const outerR = Math.max(0, oRadius + half);
        const innerR = Math.max(0, oRadius - half);
        out.push(
          `${indent}<rect x="${r(ox - half)}" y="${r(oy - half)}" width="${r(owd + 2 * half)}" height="${r(oh + 2 * half)}" rx="${r(outerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
        );
        out.push(
          `${indent}<rect x="${r(ox + half)}" y="${r(oy + half)}" width="${r(owd - 2 * half)}" height="${r(oh - 2 * half)}" rx="${r(innerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
        );
      } else if ((ostyle === "dashed" || ostyle === "dotted") && oRadius === 0) {
        // DM-910 / DM-911: a single `<rect stroke-dasharray>` runs the
        // dash pattern unbroken across all four corners, so the dashes
        // phase differently from Chrome's `OutlinePainter::PaintOutline`
        // — Chrome paints each side as a separate path and starts a
        // fresh dash at each corner. Reproduce that by emitting four
        // `<line>`s with the same per-side adjusted dash math used for
        // dashed/dotted borders (`adjustedDashAttrs` → Chrome's
        // `SelectBestDashGap`), so each side begins flush at its
        // start corner. We only take this path when the outline is
        // NOT rounded (oRadius == 0) — for rounded outlines the
        // single-rect emit is still the closest SVG-native fit.
        const linecap = ostyle === "dotted" ? ` stroke-linecap="round"` : "";
        const oxR = ox + owd, oyB = oy + oh;
        const hLen = owd, vLen = oh;
        const hAttrs = (() => {
          const { array, offset } = adjustedDashAttrs(ostyle, ow, hLen);
          return array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
        })();
        const vAttrs = (() => {
          const { array, offset } = adjustedDashAttrs(ostyle, ow, vLen);
          return array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
        })();
        const strokeAttrs = `stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"`;
        // Four sides, each starting at its top-left corner so the
        // dash pattern phases identically per side.
        out.push(
          `${indent}<line x1="${r(ox)}" y1="${r(oy)}" x2="${r(oxR)}" y2="${r(oy)}" ${strokeAttrs}${hAttrs}${linecap} />`,
          `${indent}<line x1="${r(oxR)}" y1="${r(oy)}" x2="${r(oxR)}" y2="${r(oyB)}" ${strokeAttrs}${vAttrs}${linecap} />`,
          `${indent}<line x1="${r(ox)}" y1="${r(oyB)}" x2="${r(oxR)}" y2="${r(oyB)}" ${strokeAttrs}${hAttrs}${linecap} />`,
          `${indent}<line x1="${r(ox)}" y1="${r(oy)}" x2="${r(ox)}" y2="${r(oyB)}" ${strokeAttrs}${vAttrs}${linecap} />`,
        );
      } else {
        const dash = dashArrayForStyle(ostyle, ow);
        const linecap = "";
        out.push(
          `${indent}<rect x="${r(ox)}" y="${r(oy)}" width="${r(owd)}" height="${r(oh)}" rx="${r(oRadius)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
        );
      }
    }
  }
  return out;
}

export function elementTreeToSvgInner(
  elements: CapturedElement[],
  width: number,
  height: number,
  /** Prefix for clipPath IDs — required when combining multiple frames in one SVG to avoid ID collisions */
  idPrefix: string = "",
  /**
   * When true (default), include the shared glyph definitions in this frame's
   * <defs>. Multi-frame animated SVGs should pass false so glyph defs can be
   * hoisted to the top-level SVG <defs> and shared across frames.
   */
  includeGlyphDefs: boolean = true,
  /**
   * DM-540: hiDPI multiplier the renderer uses when looking up resized
   * variants in `_resizedDataUriCache`. Must match the value passed to
   * `resizeEmbeddedImages` for the same tree, or the lookup misses and
   * the renderer falls back to the source-resolution data URI. Default 2.
   */
  hiDPIFactor: number = 2,
  /**
   * DM-839: when true, emit the embedded-font `@font-face` rules
   * (`getEmbeddedFontFaceCss()`) as a `<style>` inside this frame's `<defs>`.
   * Defaults to `includeGlyphDefs` — single-frame standalone producers
   * (capture, CLI, the test harness) own their top-level defs and so should
   * carry their font CSS here. Multi-frame producers (animator, scroll
   * composer) pass `false` and collect the CSS once at the top level instead,
   * so the (potentially large) base64 font bytes aren't duplicated per frame.
   */
  includeEmbeddedFontCss: boolean = includeGlyphDefs,
): string {
  setActiveHiDPIFactor(hiDPIFactor);
  const svgParts: string[] = [];
  const defsParts: string[] = [];
  let clipIdx = 0;
  let gradIdx = 0;
  // Form-control gradient defs (SK-1224) — renderFormControl pushes
  // <linearGradient> entries into defsParts via this context.
  const defCtx: DefCtx = {
    idPrefix,
    defsParts,
    gradientCache: new Map<string, string>(),
    nextGradId: () => `${idPrefix}grad${gradIdx++}`,
    // DM-553: page-level color-scheme propagated to form-control synthesizers
    // so unstyled checkboxes / radios / progress / meter / range / text
    // inputs use scheme-aware UA defaults. Defaults to "light" (or undefined
    // → light) when the captured tree pre-dates DM-552.
    colorScheme: elements[0]?.styles?.rootColorScheme,
    // DM-1252: let form-control pseudos paint conic backgrounds via the cached
    // raster tiles (populated by the pre-pass), without form-controls.ts
    // importing this module (avoids an import cycle).
    buildConicTile: buildConicGradientDef,
  };
  // Viewport dims for background-attachment: fixed — passed down into layer def building.
  const captureViewport = { w: width, h: height };

  // DM-473: tracks descendants that have been hoisted into an ancestor
  // stacking context's flat paint list. Their natural-DFS render path is
  // suppressed via this set so we don't double-emit them. Populated by
  // `gatherStackingContextChildren()` whenever we cross into an SC root.
  const hoistedFromAncestor = new Set<CapturedElement>();

  // DM-673: maps a hoisted positioned descendant to the
  // `overflow != visible` ancestor it escaped through. Per CSS Overflow 3
  // §2.2 such ancestors clip their content. When we hoist the descendant
  // past the ancestor's `<g clip-path>` wrapper, we need to re-wrap the
  // descendant's emission in the same clip-path so the visual effect is
  // preserved. `position:fixed` descendants escape overflow clips per the
  // spec, so they aren't added here.
  const overflowClipForHoisted = new Map<CapturedElement, CapturedElement>();
  // DM-673: maps an overflow-clip ancestor element to the clip-path id that
  // its `renderElement` generated when emitting its own `<g clip-path>`
  // wrapper. The hoisted-descendant emission re-uses the same id so the
  // `<defs>` block isn't duplicated. The ancestor renders BEFORE its
  // hoisted descendants in `topLevelFlat` order (sections paint at body's
  // step 3 / base bucket; positioned descendants at step 6 / zeroOrAuto
  // bucket), so the id is populated before lookup.
  const overflowClipPathIds = new Map<CapturedElement, string>();

  // DM-493: top-level mask fragment defs collected at capture time. Map keyed
  // by the original DOM id; the renderer mints a per-element mask def whose
  // content is translated into the masked element's user-space coordinates,
  // so two elements at different positions both render the mask correctly.
  // Per-element copies are necessary because CSS mask-image positions the
  // mask source at the masked element's content-box origin, while SVG
  // `maskUnits=userSpaceOnUse` interprets coordinates absolutely against the
  // root SVG. We dedupe identical (fragId, elX, elY, elW, elH) tuples to
  // keep the output compact when many elements share a position.
  const fragmentMaskDefs = new Map<string, MaskFragmentDef>();
  for (const root of elements) {
    if (root.maskDefs == null) continue;
    for (const def of root.maskDefs) {
      if (!fragmentMaskDefs.has(def.id)) fragmentMaskDefs.set(def.id, def);
    }
  }
  // DM-494: top-level mask raster lookup table for `mask-image: element(#id)`.
  // Keyed by the referenced DOM id; `buildMaskDef` consults this to resolve
  // an `element()` layer to the painted snapshot screenshot.
  const elementMaskRasters = new Map<string, MaskRasterRef>();
  for (const root of elements) {
    if (root.maskRasters == null) continue;
    for (const mr of root.maskRasters) {
      if (!elementMaskRasters.has(mr.id)) elementMaskRasters.set(mr.id, mr);
    }
  }
  let fragmentMaskCounter = 0;
  const fragmentMaskOutputId = new Map<string, string>();

  // DM-826: top-level clip-path fragment defs (`clip-path: url("#id")`).
  // Unlike masks, clipPath fragments don't need per-element positioning when
  // `clipPathUnits="objectBoundingBox"` (SVG auto-scales into the masked
  // element's bbox natively) — so the resolver returns ONE output id per
  // source fragment and every consumer references the same def. For
  // `userSpaceOnUse` clipPaths we currently emit the def verbatim too;
  // faithful support across captured (x, y) origins is deferred (see
  // docs/39).
  const fragmentClipPathDefs = new Map<string, ClipPathFragmentDef>();
  for (const root of elements) {
    if (root.clipPathDefs == null) continue;
    for (const def of root.clipPathDefs) {
      if (!fragmentClipPathDefs.has(def.id)) fragmentClipPathDefs.set(def.id, def);
    }
  }
  // DM-934: collect inline <filter> defs from every root. Filters don't
  // need per-element coordinate rewriting: their default `filterUnits=
  // objectBoundingBox` makes the filter region relative to each consuming
  // element's bbox, and `primitiveUnits=userSpaceOnUse` only affects
  // primitive-internal coordinates (e.g. feTurbulence baseFrequency). The
  // captured outerHTML can be emitted verbatim with the ORIGINAL id (the
  // CSS `filter: url(#id)` value is passed through as an inline style on
  // the wrapping <g>, so it expects the id to match the captured page).
  // We collect once and emit eagerly into defsParts below.
  const fragmentFilterDefs = new Map<string, { id: string; outerHTML: string }>();
  for (const root of elements) {
    if (root.filterDefs == null) continue;
    for (const def of root.filterDefs) {
      if (!fragmentFilterDefs.has(def.id)) fragmentFilterDefs.set(def.id, def);
    }
  }
  // DM-1151: identify `border-collapse: collapse` cells that are laid out
  // OFF the shared table grid. Normally collapsed cells paint their borders
  // CENTERED on the shared grid line so adjacent cells overlap into a single
  // line (handled by the `collapse` branches below). But a cell whose border
  // is thicker than its neighbors can be laid out with a SMALLER box than its
  // row/column slot, so its rect edges sit ~1px inside the grid line. Chrome
  // then paints that cell's borders entirely INSIDE its own border-box (outer
  // edge flush to the cell rect) on every side, exactly like a non-collapsed
  // box — verified against painted pixels for the 6px-red interior cell in
  // `18-deep-borders-mixed-sides` (left 206-211, right 340-345, top 1175-1180,
  // bottom 1269-1274; all flush to the cell rect, not centered on the grid).
  //
  // Detection (consensus grid line) lives in `findOffGridCollapsedCells`: an
  // edge is "offset" when ≥2 OTHER collapsed cells share a same-orientation
  // edge coordinate >0.5px away (they define the real grid line; this cell is
  // the minority). A cell with any offset edge is treated as non-collapsed for
  // border painting so all its sides inset like a normal box. Grid-aligned
  // cells are untouched, so the calibrated collapsed-border fixtures keep their
  // centered painting.
  const offGridCollapsedCells = new Set<CapturedElement>();
  {
    const collapsedCells: CapturedElement[] = [];
    const collect = (el: CapturedElement) => {
      if (el.styles?.borderCollapse === "collapse" && (el.tag === "td" || el.tag === "th")) {
        collapsedCells.push(el);
      }
      for (const c of el.children) collect(c);
    };
    for (const root of elements) collect(root);
    const offGrid = findOffGridCollapsedCells(collapsedCells);
    for (let i = 0; i < collapsedCells.length; i++) {
      if (offGrid[i]) offGridCollapsedCells.add(collapsedCells[i]);
    }
  }

  let fragmentClipPathCounter = 0;
  const fragmentClipPathOutputId = new Map<string, string>();
  function resolveFragmentClipPathRef(
    clipPathCss: string,
    elX: number, elY: number,
  ): string | null {
    // Strip the optional <geometry-box> keyword so `url(#id) padding-box`
    // matches; it doesn't affect bbox-relative clipPaths, and for
    // userSpaceOnUse the border-box origin (the default) is what Chrome uses —
    // a non-default box keyword's origin offset is a rare edge left for later.
    const stripped = clipPathCss.replace(/\b(?:content-box|padding-box|border-box|margin-box|fill-box|stroke-box|view-box)\b/i, "").trim();
    const m = /^url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)$/i.exec(stripped);
    if (m == null) return null;
    const fragId = m[1];
    const def = fragmentClipPathDefs.get(fragId);
    if (def == null) return null;

    // The mask rewriter is element-name-agnostic (discovers ids, mints prefixed
    // aliases, rewrites href / url() refs); the outer `<clipPath>`'s id becomes
    // `outId`, descendants get the `${idPrefix}fragid-${original}` alias.
    if ((def.clipPathUnits ?? "userSpaceOnUse") === "objectBoundingBox") {
      // objectBoundingBox: coords are 0..1 fractions of the masked element's
      // bbox — SVG auto-scales natively, so one shared def serves every
      // consumer regardless of position (DM-826).
      const cached = fragmentClipPathOutputId.get(fragId);
      if (cached != null) return cached;
      const outId = `${idPrefix}cpfrag${fragmentClipPathCounter++}`;
      fragmentClipPathOutputId.set(fragId, outId);
      defsParts.push(rewriteFragmentMaskDef(def.outerHTML, outId, idPrefix));
      return outId;
    }

    // userSpaceOnUse (the SVG default): coords are element-local but the element
    // is drawn at absolute (elX, elY), so mint a per-position copy translated to
    // match. Dedupe identical positions, mirroring resolveFragmentMaskRef
    // (width/height don't matter for a clipPath — no bbox) — DM-828.
    const cacheKey = `${fragId}|${r(elX)}|${r(elY)}`;
    const cached = fragmentClipPathOutputId.get(cacheKey);
    if (cached != null) return cached;
    const outId = `${idPrefix}cpfrag${fragmentClipPathCounter++}`;
    fragmentClipPathOutputId.set(cacheKey, outId);
    const rewritten = rewriteFragmentMaskDef(def.outerHTML, outId, idPrefix);
    defsParts.push(positionFragmentClipPathDef(rewritten, elX, elY));
    return outId;
  }
  function resolveFragmentMaskRef(
    maskImage: string,
    elX: number, elY: number, elW: number, elH: number,
  ): string | null {
    const m = /^url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)$/i.exec(maskImage);
    if (m == null) return null;
    const fragId = m[1];
    const def = fragmentMaskDefs.get(fragId);
    if (def == null) return null;
    const cacheKey = `${fragId}|${r(elX)}|${r(elY)}|${r(elW)}|${r(elH)}`;
    const cached = fragmentMaskOutputId.get(cacheKey);
    if (cached != null) return cached;
    const outId = `${idPrefix}mkfrag${fragmentMaskCounter++}`;
    fragmentMaskOutputId.set(cacheKey, outId);
    // Rewrite the captured <mask>'s outerHTML: mint our output id, prefix
    // descendant ids and url(#…) refs to the domotion namespace, then
    // translate the mask's content into user-space at (elX, elY) so the
    // mask region aligns with the masked element. We do this by extracting
    // the mask's children, wrapping them in <g transform="translate(elX, elY)">
    // and re-emitting as a fresh <mask maskUnits="userSpaceOnUse">. The
    // captured mask's own x/y/width/height become the <mask> element's
    // bounds, shifted by (elX, elY).
    const rewritten = rewriteFragmentMaskDef(def.outerHTML, outId, idPrefix);
    const positioned = positionFragmentMaskDef(rewritten, elX, elY, elW, elH);
    defsParts.push(positioned);
    return outId;
  }

  // Resolve the element's CSS mask into an SVG <mask> def + the mask="url(#…)"
  // id. Mutates the shared clipIdx / defsParts via closure (exactly as the
  // inline code did). Handles mask-border simple-url / 9-slice (DM-758/793),
  // same-document fragment refs (DM-493), and gradient/url() mask-image with
  // mask-clip insets (DM-820). Returns the mask url id, or null when no mask
  // is emitted. Extracted from renderElement (DM-1092).
  const renderMaskPhase = (el: CapturedElement): string | null => {
    // mask: if mask-image is a gradient or url(), translate it to an SVG <mask>.
    // DM-758 / DM-793: `mask-border-source` (legacy `-webkit-mask-box-image`)
    // layers on top of `mask-image`. The two cases:
    //   1. Simple full-image (slice 0/1 [fill] + width 0 + outset 0): emit a
    //      single `<image preserveAspectRatio="none">` inside a `<mask>` so
    //      the source stretches to the element rect (matches Chrome for the
    //      `mb-grad` gradient case and the `mb-wide` URL case).
    //   2. True 9-slice (mb-1 / mb-2 / mb-3 / mb-outset — non-zero `width`,
    //      `outset`, or non-trivial `slice` with `round` / `space` / `stretch`
    //      repeat): construct a 9-piece mask from corner / edge / center
    //      slices, mirroring the existing `renderBorderImage` 9-slice logic
    //      in `borders.ts` but emitting the pieces inside a `<mask>` instead
    //      of as direct paint. `mask-border-mode` defaults to `alpha` per
    //      spec, so the source's alpha channel drives the mask.
    const mbSrc = el.styles.maskBorderSource;
    const mbHasSrc = mbSrc != null && mbSrc !== "" && mbSrc !== "none";
    const mbWidth = (el.styles.maskBorderWidth ?? "0").trim();
    const mbOutset = (el.styles.maskBorderOutset ?? "0").trim();
    const mbSlice = (el.styles.maskBorderSlice ?? "").trim();
    const mbWidthZero = mbWidth === "0" || mbWidth === "0px" || /^(0(?:px)?\s+){0,3}0(?:px)?$/.test(mbWidth);
    const mbOutsetZero = mbOutset === "0" || mbOutset === "0px" || /^(0(?:px)?\s+){0,3}0(?:px)?$/.test(mbOutset);
    const mbSliceFull = /^[01]\s+fill$/.test(mbSlice) || mbSlice === "1" || mbSlice === "0";
    const mbIsGradient = mbHasSrc && /-gradient\(/i.test(mbSrc);
    const mbUrlHref = mbHasSrc ? parseCssUrl(mbSrc) : null;
    const mbIsUrl = mbUrlHref != null;
    const mbIsSimple = mbHasSrc && mbWidthZero && mbOutsetZero && mbSliceFull;
    const usingMaskBorderUrlSimple = mbIsSimple && mbIsUrl && mbUrlHref != null;
    const usingMaskBorderGradient = mbIsSimple && mbIsGradient;
    const usingMaskBorder9Slice = mbHasSrc && mbIsUrl && mbUrlHref != null && !mbIsSimple
      && el.styles.maskBorderIntrinsicWidth != null && el.styles.maskBorderIntrinsicHeight != null
      && el.styles.maskBorderIntrinsicWidth > 0 && el.styles.maskBorderIntrinsicHeight > 0;
    const maskImage = usingMaskBorderGradient ? mbSrc : el.styles.maskImage;
    let maskUrlId: string | null = null;
    if (usingMaskBorderUrlSimple && mbUrlHref != null) {
      const dataUri = embedResizedDataUri(mbUrlHref, el.width, el.height);
      const mid = `${idPrefix}mk${clipIdx++}`;
      defsParts.push(
        `<mask id="${mid}" maskUnits="userSpaceOnUse" mask-type="alpha">`
          + `<image href="${esc(dataUri)}" x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" preserveAspectRatio="none" />`
          + `</mask>`,
      );
      maskUrlId = mid;
    } else if (usingMaskBorder9Slice && mbUrlHref != null) {
      const mid = `${idPrefix}mk${clipIdx++}`;
      const built = buildMaskBorder9Slice(
        el, mbUrlHref, mbSlice, mbWidth, mbOutset, el.styles.maskBorderRepeat ?? "stretch",
        mid, idPrefix, clipIdx,
      );
      if (built != null) {
        defsParts.push(built.def);
        clipIdx = built.nextClipIdx;
        maskUrlId = built.id;
      }
    } else if (maskImage != null && maskImage !== "none" && maskImage !== "") {
      // DM-493: same-document fragment refs (mask-image: url("#id")) emit the
      // captured inline <mask> verbatim with id rewriting, bypassing the
      // gradient/url() emission path.
      const fragRef = resolveFragmentMaskRef(maskImage, el.x, el.y, el.width, el.height);
      if (fragRef != null) {
        maskUrlId = fragRef;
      } else {
        // DM-758: when the source comes from `mask-border-source`, force
        // size 100% 100% / no-repeat so the mask stretches across the
        // element — matches Chrome's paint for `slice: 1 / 0` and
        // `slice: 0 fill / 0` patterns. The `mask-border-mode` defaults to
        // alpha vs the regular `mask-mode` default of `match-source`, but
        // `match-source` already does the right thing for gradient sources
        // (alpha-mode on grayscale gradients).
        const maskSize = usingMaskBorderGradient ? "100% 100%" : (el.styles.maskSize ?? "auto");
        const maskPosition = usingMaskBorderGradient ? "0% 0%" : (el.styles.maskPosition ?? "0% 0%");
        const maskRepeat = usingMaskBorderGradient ? "no-repeat" : (el.styles.maskRepeat ?? "repeat");
        // DM-820: honor `mask-clip` by insetting the mask paint region.
        // `border-box` (default) leaves the border-box rect; `padding-box`
        // insets by border widths; `content-box` insets by border + padding.
        // For uniform masks (e.g. `linear-gradient(black, black)`) this
        // matches Chrome's "mask is transparent outside the clip box" rule
        // exactly. For position-sensitive gradients the layer is still
        // sized to the clip box rather than the origin box (mask-origin
        // not yet captured), which is a visible diff only when both differ
        // — no fixtures exercise that combination today.
        const maskClip = el.styles.maskClip ?? "border-box";
        let maskX = el.x, maskY = el.y, maskW = el.width, maskH = el.height;
        if (maskClip === "padding-box" || maskClip === "content-box") {
          const bt = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
          const br = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
          const bb = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
          const bl = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          maskX += bl; maskY += bt; maskW -= bl + br; maskH -= bt + bb;
          if (maskClip === "content-box") {
            const pt = parseFloat(el.styles.paddingTop ?? "0") || 0;
            const pr = parseFloat(el.styles.paddingRight ?? "0") || 0;
            const pb = parseFloat(el.styles.paddingBottom ?? "0") || 0;
            const pl = parseFloat(el.styles.paddingLeft ?? "0") || 0;
            maskX += pl; maskY += pt; maskW -= pl + pr; maskH -= pt + pb;
          }
        }
        const maskDef = buildMaskDef(
          `${idPrefix}mk${clipIdx++}`,
          maskImage,
          maskX, maskY, Math.max(0, maskW), Math.max(0, maskH),
          el.styles.maskMode ?? "match-source",
          maskSize,
          maskPosition,
          maskRepeat,
          el.styles.maskComposite ?? "add",
          elementMaskRasters,
        );
        if (maskDef.def !== "") {
          maskUrlId = maskDef.id;
          defsParts.push(maskDef.def);
        }
      }
    }
    return maskUrlId;
  };

  // DM-934: emit captured inline <filter> defs eagerly into the output
  // SVG's top-level <defs>. The original id is preserved so the
  // pass-through-as-inline-style emit of `filter: url(#id)` on the
  // wrapping <g> resolves against this def. Filters are emitted as
  // verbatim outerHTML — feGaussianBlur / feTurbulence / feColorMatrix /
  // feComposite / feMerge / feFlood / feDisplacementMap / feConvolveMatrix
  // and the rest of the SVG filter primitive set all round-trip cleanly
  // since the browser's SVG renderer interprets them directly.
  for (const def of fragmentFilterDefs.values()) {
    defsParts.push(def.outerHTML);
  }

  // DM-673: wraps `renderElement` with a `<g clip-path>` group when `el`
  // was hoisted past an overflow-clip ancestor. The ancestor's clip-path
  // id is stashed in `overflowClipPathIds` by the ancestor's own
  // renderElement call (which runs first because sections paint at body's
  // step 3 / base bucket, BEFORE positioned descendants at step 6 /
  // zeroOrAuto bucket). `position:fixed` descendants are never added to
  // the map (CSS Overflow 3 §2.2 — fixed elements escape ancestor
  // overflow clipping), so they aren't wrapped here.
  function renderElementWithOverflowClip(el: CapturedElement, depth: number, parentDisplayForEl?: string): void {
    const overflowClipAncestor = overflowClipForHoisted.get(el);
    const clipId = overflowClipAncestor != null ? overflowClipPathIds.get(overflowClipAncestor) : undefined;
    if (clipId == null) {
      renderElement(el, depth, parentDisplayForEl);
      return;
    }
    const indent = "  ".repeat(depth);
    svgParts.push(`${indent}<g clip-path="url(#${clipId})">`);
    renderElement(el, depth, parentDisplayForEl);
    svgParts.push(`${indent}</g>`);
  }

  /**
   * Per-fragment paint for inline elements that wrap onto multiple line
   * boxes. Each entry in `el.inlineFragments` corresponds to one line-box
   * fragment of the inline element. The painted shape per fragment depends
   * on `box-decoration-break`:
   *   - `slice` (default): the inline's box is "cut" at line-box boundaries.
   *     The first fragment owns the LEFT side + TL/BL corners; the last owns
   *     the RIGHT side + TR/BR corners; intermediate fragments paint only
   *     top + bottom borders with no corner rounding.
   *   - `clone`: every fragment paints a full box (all four sides, all four
   *     corners). Outset box-shadow + background-image are also emitted
   *     per-fragment.
   * Matches Blink's `InlineBoxFragmentPainter::PaintBoxDecorationBackground`
   * pattern: a per-fragment slice of the inline's logical box, with the
   * non-edge sides suppressed in slice mode.
   */
  function renderInlineFragments(
    el: CapturedElement,
    indent: string,
    bgColor: { r: number; g: number; b: number; a: number } | null,
    corners: CornerRadii,
  ): void {
    const frags = el.inlineFragments!;
    const clone = (el.styles.boxDecorationBreak ?? "slice") === "clone";
    const bgImage = el.styles.backgroundImage;
    const hasBgImage = bgImage != null && bgImage !== "none" && bgImage !== "";
    const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");

    // DM-754: fragment axis comes from capture-side `display` inspection —
    // both inline-wrap and multi-column block-level fragmentation produce
    // vertically-stacked frag rects, so we can't reliably tell them apart
    // by geometry. `inline`: first owns LEFT + TL/BL, last owns RIGHT +
    // TR/BR, middle paints top + bottom only. `block`: first owns TOP +
    // TL/TR, last owns BOTTOM + BL/BR, middle paints left + right only.
    const fragsAxisIsBlock = el.fragmentAxis === "block";

    // Per-side captured borders. Uniformity tested for the simple stroke
    // path; mixed-per-side borders on wrapped inlines are rare and fall
    // back to the same per-side emit.
    const sbt = parseSide(el.styles.borderTopWidth, el.styles.borderTopStyle, el.styles.borderTopColor);
    const sbr = parseSide(el.styles.borderRightWidth, el.styles.borderRightStyle, el.styles.borderRightColor);
    const sbb = parseSide(el.styles.borderBottomWidth, el.styles.borderBottomStyle, el.styles.borderBottomColor);
    const sbl = parseSide(el.styles.borderLeftWidth, el.styles.borderLeftStyle, el.styles.borderLeftColor);

    // Per-side border-image-source styling on wrapped inlines is rare enough
    // that we skip it; the bbox path remains the only border-image-aware
    // emitter and is gated off when `useInlineFragments` is set.

    // Background-image layer setup — mirrors the bbox path but parameterised
    // on per-fragment box. background-clip: text isn't supported on inline
    // fragments here (uncommon and would require per-fragment glyph masks).
    const bgImageLayers = hasBgImage ? splitTopLevelCommas(bgImage!) : [];
    const bgSizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
    const bgPosLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
    const bgRepeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
    const bgClipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
    const bgOriginLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
    const bgAttachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
    const bgIntrinsicLayers = el.styles.backgroundIntrinsic ?? [];

    for (let fi = 0; fi < frags.length; fi++) {
      const f = frags[fi];
      const isFirst = fi === 0;
      const isLast = fi === frags.length - 1;
      // In slice mode the corner radii belong only to the entry/exit edges
      // — which edges, exactly, depends on the fragmentation axis:
      //   • inline-axis (wrapped inline): TL/BL on first, TR/BR on last
      //   • block-axis (multi-column block): TL/TR on first, BL/BR on last
      // Middle fragments collapse to sharp 90° on all four corners. Clone
      // treats every fragment as a complete box → keep all four corners.
      const fragCorners: CornerRadii = clone ? corners : (fragsAxisIsBlock ? {
        tl: isFirst ? corners.tl : { h: 0, v: 0 },
        tr: isFirst ? corners.tr : { h: 0, v: 0 },
        bl: isLast ? corners.bl : { h: 0, v: 0 },
        br: isLast ? corners.br : { h: 0, v: 0 },
        uniform: corners.uniform && isFirst && isLast,
      } : {
        tl: isFirst ? corners.tl : { h: 0, v: 0 },
        bl: isFirst ? corners.bl : { h: 0, v: 0 },
        tr: isLast ? corners.tr : { h: 0, v: 0 },
        br: isLast ? corners.br : { h: 0, v: 0 },
        uniform: corners.uniform && isFirst && isLast,
      });

      // Outset box-shadow. Clone applies shadow to each fragment; slice
      // applies it to the joined shape which would need per-fragment
      // clipping to express in SVG — skip for slice (rare on wrapped
      // inlines that aren't using `clone`).
      if (clone) {
        for (let si = shadows.length - 1; si >= 0; si--) {
          const sh = shadows[si];
          if (sh.inset) continue;
          const sx = f.x + sh.x - sh.spread;
          const sy = f.y + sh.y - sh.spread;
          const sw = f.width + sh.spread * 2;
          const sh2 = f.height + sh.spread * 2;
          if (sw <= 0 || sh2 <= 0) continue;
          const shadowCorners = outsetCornerRadiiForShadow(fragCorners, sh.spread);
          let filterAttr = "";
          if (sh.blur > 0) {
            const stdDev = sh.blur / 2;
            const fid = `${idPrefix}sh${clipIdx++}`;
            defsParts.push(
              `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
            );
            filterAttr = ` filter="url(#${fid})"`;
          }
          svgParts.push(
            `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr}`)}`,
          );
        }
      }

      // Background color.
      if (bgColor != null && bgColor.a > 0.01) {
        svgParts.push(
          `${indent}${roundedRectSvg(f.x, f.y, f.width, f.height, fragCorners, `fill="${colorStr(bgColor)}"`)}`,
        );
      }

      // Background image layers (clone only — slice would need cross-
      // fragment continuation of the gradient/image which is out of scope
      // here; the bbox path remains the slice-mode gradient owner via the
      // fallback emit when fragmentation isn't detected).
      if (clone && hasBgImage) {
        for (let li = bgImageLayers.length - 1; li >= 0; li--) {
          const layer = bgImageLayers[li].trim();
          const layerSize = (bgSizeLayers[li] ?? bgSizeLayers[0] ?? "auto").trim();
          const layerPos = (bgPosLayers[li] ?? bgPosLayers[0] ?? "0% 0%").trim();
          const layerRepeat = (bgRepeatLayers[li] ?? bgRepeatLayers[0] ?? "repeat").trim();
          const layerClip = (bgClipLayers[li] ?? bgClipLayers[0] ?? "border-box").trim();
          const layerIntrinsic = bgIntrinsicLayers[li] ?? null;
          const layerAttachment = (bgAttachmentLayers[li] ?? bgAttachmentLayers[0] ?? "scroll").trim();
          if (layerClip === "text") continue;
          const defId = `${idPrefix}bgf${clipIdx++}`;
          const out = buildBackgroundLayerDef(
            defId, layer, f.x, f.y, f.width, f.height,
            layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport,
          );
          if (out.def === "") continue;
          defsParts.push(out.def);
          svgParts.push(
            `${indent}${roundedRectSvg(f.x, f.y, f.width, f.height, fragCorners, `fill="url(#${defId})"`)}`,
          );
        }
      }

      // Per-side borders. The suppressed sides depend on fragmentation axis:
      //   • inline-axis slice: suppress LEFT on non-first, RIGHT on non-last;
      //     keep TOP + BOTTOM on every fragment (wrapped-inline behavior).
      //   • block-axis slice: suppress TOP on non-first, BOTTOM on non-last;
      //     keep LEFT + RIGHT on every fragment (multi-column block-level).
      // Clone always keeps all four sides. Solid-style only (the typical use
      // cases are solid); fall back to a single inset stroke for the
      // uniform-color case.
      const wantTop = clone || (fragsAxisIsBlock ? isFirst : true);
      const wantBottom = clone || (fragsAxisIsBlock ? isLast : true);
      const wantLeft = clone || (fragsAxisIsBlock ? true : isFirst);
      const wantRight = clone || (fragsAxisIsBlock ? true : isLast);

      const drawSide = (
        side: typeof sbt,
        x1: number, y1: number, x2: number, y2: number,
      ) => {
        if (side == null || side.w <= 0 || side.color.a < 0.01) return;
        if (side.style === "none" || side.style === "hidden") return;
        const dash = dashArrayForStyle(side.style, side.w);
        const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
        const linecap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
        svgParts.push(
          `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dashAttr}${linecap} />`,
        );
      };

      // Uniform border with rounded corners: emit a clipped <path> stroke
      // around the per-fragment outline (skipping the suppressed sides).
      // To keep it simple, only emit the rounded-rect stroke path when all
      // four sides are wanted (clone, or first-and-last). Otherwise fall
      // back to four `<line>` strokes which work correctly for square
      // corners (the slice path on middle fragments has square corners
      // anyway).
      const allFourWanted = wantTop && wantBottom && wantLeft && wantRight;
      const sidesUniformColor = sbt != null && sbr != null && sbb != null && sbl != null
        && sbt.w === sbr.w && sbr.w === sbb.w && sbb.w === sbl.w
        && sbt.style === sbr.style && sbr.style === sbb.style && sbb.style === sbl.style
        && sameColor(sbt.color, sbr.color) && sameColor(sbr.color, sbb.color) && sameColor(sbb.color, sbl.color);
      const anyCorner = fragCorners.tl.h > 0 || fragCorners.tr.h > 0 || fragCorners.br.h > 0 || fragCorners.bl.h > 0;
      if (sbt != null && sidesUniformColor && allFourWanted && anyCorner && sbt.w > 0 && sbt.style !== "none" && sbt.style !== "hidden") {
        const half = sbt.w / 2;
        const strokeCorners = insetCornerRadii(fragCorners, half, half, half, half);
        const dash = dashArrayForStyle(sbt.style, sbt.w);
        const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
        const linecap = sbt.style === "dotted" ? ` stroke-linecap="round"` : "";
        svgParts.push(
          `${indent}${roundedRectSvg(f.x + half, f.y + half, Math.max(0, f.width - sbt.w), Math.max(0, f.height - sbt.w), strokeCorners, `fill="none" stroke="${colorStr(sbt.color)}" stroke-width="${r(sbt.w)}"${dashAttr}${linecap}`)}`,
        );
      } else if (sbt != null && sidesUniformColor && anyCorner && sbt.w > 0 && sbt.style !== "none" && sbt.style !== "hidden"
          && ((wantTop && wantBottom && wantLeft && !wantRight) || (wantTop && wantBottom && !wantLeft && wantRight))) {
        // DM-937: inline-axis slice — the FIRST fragment owns top + left +
        // bottom (with TL + BL rounded), the LAST owns top + right + bottom
        // (with TR + BR rounded). Emit ONE open `<path>` stroke that traces
        // the 3 wanted sides with the rounded corners — replacing the
        // straight-line fallback that produced sharp 90° corners where
        // Chrome paints arcs. This visibly closes the rounded-drop-zone
        // outline (`<label>` wrapping block descendants in
        // `06-forms-style-file`'s `.drop`).
        const half = sbt.w / 2;
        const strokeCorners = insetCornerRadii(fragCorners, half, half, half, half);
        const fxL = f.x + half, fxR = f.x + f.width - half;
        const fyT = f.y + half, fyB = f.y + f.height - half;
        const tl = strokeCorners.tl, tr = strokeCorners.tr, br = strokeCorners.br, bl = strokeCorners.bl;
        let d: string;
        if (wantLeft && !wantRight) {
          // First frag: start at top-right (sharp), trace top → TL arc →
          // left → BL arc → bottom → end at bottom-right (sharp).
          d = `M${r(fxR)},${r(fyT)} L${r(fxL + tl.h)},${r(fyT)}`
            + (tl.h > 0 || tl.v > 0 ? ` A${r(tl.h)},${r(tl.v)} 0 0 0 ${r(fxL)},${r(fyT + tl.v)}` : "")
            + ` L${r(fxL)},${r(fyB - bl.v)}`
            + (bl.h > 0 || bl.v > 0 ? ` A${r(bl.h)},${r(bl.v)} 0 0 0 ${r(fxL + bl.h)},${r(fyB)}` : "")
            + ` L${r(fxR)},${r(fyB)}`;
        } else {
          // Last frag: start at top-left (sharp), trace top → TR arc →
          // right → BR arc → bottom → end at bottom-left (sharp).
          d = `M${r(fxL)},${r(fyT)} L${r(fxR - tr.h)},${r(fyT)}`
            + (tr.h > 0 || tr.v > 0 ? ` A${r(tr.h)},${r(tr.v)} 0 0 1 ${r(fxR)},${r(fyT + tr.v)}` : "")
            + ` L${r(fxR)},${r(fyB - br.v)}`
            + (br.h > 0 || br.v > 0 ? ` A${r(br.h)},${r(br.v)} 0 0 1 ${r(fxR - br.h)},${r(fyB)}` : "")
            + ` L${r(fxL)},${r(fyB)}`;
        }
        const dash = dashArrayForStyle(sbt.style, sbt.w);
        const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
        const linecap = sbt.style === "dotted" ? ` stroke-linecap="round"` : "";
        svgParts.push(
          `${indent}<path d="${d}" fill="none" stroke="${colorStr(sbt.color)}" stroke-width="${r(sbt.w)}"${dashAttr}${linecap} />`,
        );
      } else {
        // Per-side strokes anchored at the inner half-width inset so they
        // sit inside the border-box (matching Chrome). For slice-mode
        // middle fragments there are no corners so straight lines suffice.
        const tw = sbt?.w ?? 0;
        const rw = sbr?.w ?? 0;
        const bw = sbb?.w ?? 0;
        const lw = sbl?.w ?? 0;
        const xL = f.x, xR = f.x + f.width, yT = f.y, yB = f.y + f.height;
        // Top / bottom span the full fragment width.
        if (wantTop) drawSide(sbt, xL, yT + tw / 2, xR, yT + tw / 2);
        if (wantBottom) drawSide(sbb, xL, yB - bw / 2, xR, yB - bw / 2);
        if (wantLeft) drawSide(sbl, xL + lw / 2, yT, xL + lw / 2, yB);
        if (wantRight) drawSide(sbr, xR - rw / 2, yT, xR - rw / 2, yB);
      }
    }
  }

  function renderElement(el: CapturedElement, depth: number, parentDisplayForEl?: string): void {
    const indent = "  ".repeat(depth);
    const bgColor = parseColor(el.styles.backgroundColor);
    const textColor = parseColor(el.styles.color);
    const borderColor = parseColor(el.styles.borderColor);
    const borderWidth = parseFloat(el.styles.borderWidth) || 0;
    // Border-radius resolution (SK-1093 / DM-300): per-corner longhand values
    // come from the capture as "h v" axis-pair strings (e.g. "30px 30px" or
    // "50px 20px" for elliptical corners). Each corner can independently be
    // round or elliptical and have a different radius from its neighbours
    // (CSS `border-radius: 10px 30px 50px 70px` maps to TL=10, TR=30, BR=50,
    // BL=70). When all four corners are equal-and-circular, the renderer
    // emits `<rect rx>`; otherwise it emits an SVG `<path>` with explicit
    // per-corner arc commands via roundedRectSvg. `borderRadius` below is the
    // single-value fallback used by the few call sites that still emit a bare
    // `<rect rx>` directly — they degrade to sharp corners on non-uniform
    // captures, which is acceptable for now. DM-246 (the half-extent clamp
    // for the uniform fast path) is preserved by `roundedRectSvg`.
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    const _rawBorderRadius = parseFloat(el.styles.borderTopLeftRadius ?? el.styles.borderRadius ?? "0") || 0;
    const borderRadius = Math.min(_rawBorderRadius, el.width / 2, el.height / 2);
    const opacity = parseFloat(el.styles.opacity);

    if (opacity === 0) return;
    // empty-cells: hide — suppress bg + border on empty <td>/<th>.
    const suppressEmptyCell = el.styles.emptyCellsHidden === true;
    // Inline elements that wrap across multiple line boxes (CSS Backgrounds 3
    // §3.7 box-decoration-break): capture stashes per-fragment rects in
    // `el.inlineFragments`. When set, paint the background + border per
    // fragment instead of once across the bbox. `slice` (default) cuts the
    // box at fragment boundaries — the first fragment owns the left side and
    // the last owns the right; middle fragments paint only top + bottom.
    // `clone` paints a complete box on every fragment.
    const useInlineFragments = el.inlineFragments != null && el.inlineFragments.length > 1;

    // Element opacity applies to the background, border, text, and all descendants.
    // Emit a group wrapper when opacity < 1 so the whole subtree tints uniformly.
    // Also open a group to host CSS filter / mix-blend-mode — both are honored by
    // the browser's SVG renderer when passed through as inline styles, so we
    // don't need to translate filter functions into <filter> elements.
    // backdrop-filter has no equivalent in img-rendered SVG; it's captured but
    // not emitted (documented limitation).
    const filterCss = el.styles.filter && el.styles.filter !== "none" ? el.styles.filter : "";
    const blendCss = el.styles.mixBlendMode && el.styles.mixBlendMode !== "normal" ? el.styles.mixBlendMode : "";
    // clip-path: translate common CSS shape functions into an SVG <clipPath>
    // anchored at the element's absolute (x, y). A verbatim style-passthrough
    // does NOT work because CSS clip-path uses the element's local coord space
    // while our SVG group is drawn in absolute viewport coords, so a
    // 'circle(50% at center)' would clip around the viewport origin instead.
    const clipPathCss = el.styles.clipPath && el.styles.clipPath !== "none" ? el.styles.clipPath : "";
    let clipPathUrlId: string | null = null;
    if (clipPathCss !== "") {
      // DM-818: CSS clip-path accepts an optional `<geometry-box>` keyword
      // (`content-box` / `padding-box` / `border-box` / `margin-box` /
      // `fill-box` / `stroke-box` / `view-box`) that specifies which box
      // the shape is positioned relative to. Strip it before passing the
      // value to the shape translator and inset (x, y, w, h) accordingly.
      // `border-box` is the default and matches the captured element rect
      // — no inset. We don't model margin-box / fill-box / stroke-box /
      // view-box explicitly; the first falls back to border-box (close
      // enough for the html-test fixtures), the SVG-specific ones don't
      // apply to HTML elements.
      const shape = clipPathShapeForElement(el, clipPathCss);
      if (shape !== "") {
        clipPathUrlId = `${idPrefix}cp${clipIdx++}`;
        defsParts.push(`<clipPath id="${clipPathUrlId}">${shape}</clipPath>`);
      } else {
        // DM-826: shape translator returned "" — try the inline-`<clipPath>`
        // fragment-ref path next. `clip-path: url(#id)` resolves against the
        // top-level `clipPathDefs` collected at capture time; the def is
        // emitted into `<defs>` once and the masked element's wrapper `<g>`
        // gets `clip-path="url(#${outId})"`. See docs/39.
        const fragId = resolveFragmentClipPathRef(clipPathCss, el.x, el.y);
        if (fragId != null) clipPathUrlId = fragId;
      }
    }
    // DM-587: overflow != visible on either axis clips painted descendants
    // at the element's box. Chrome's captured tree faithfully records every
    // descendant rect even when it extends past an ancestor's box (e.g. the
    // Stripe `payments-graphic__checkout-payment-methods-item-label--card`
    // is a 22×6 box that flex-stacks multiple language-variant siblings
    // horizontally under `transform: scale(0.69)`; only the active-language
    // variant is meant to be visible). Without this clip the SVG painted
    // every variant on top of one another. clip-path takes priority when
    // both are present (CSS clip-path replaces overflow clipping per CSS
    // Masking 1 §5.1); border-radius rounding of the overflow rect is a
    // deliberate omission — rare in practice on elements small enough for
    // the bug to matter.
    if (clipPathUrlId == null) {
      const oxV = el.styles.overflowX;
      const oyV = el.styles.overflowY;
      const oxClips = oxV != null && oxV !== "visible";
      const oyClips = oyV != null && oyV !== "visible";
      // DM-650: per CSS Overflow Module Level 3 §3.3, when <body>'s overflow
      // is non-visible and <html>'s overflow is visible (the default), the
      // body's overflow is propagated to the viewport — i.e. body itself
      // renders WITHOUT clipping, and the page-level scroll handles the
      // overflow. This is what NYT desktop relies on: body { height: 100vh;
      // overflow: hidden auto } but the page scrolls at the document level
      // because <html> has overflow: visible. If we applied body's overflow
      // as a clip on body's own bbox, scroll-mode segments at scrollY > 0
      // would clip every descendant out (body.y becomes -scrollY < 0; the
      // clip rect ends at body.y + 100vh = 0, so anything below would be
      // hidden). DM-1244: <body>'s overflow only propagates to the viewport when
      // <html> is `overflow: visible`; we now capture <html>'s overflow on the
      // root element (`rootOverflowX/Y`), so skip the body clip only when <html>
      // really is visible. When <html> has a non-visible overflow it is the one
      // propagated to the viewport and <body> applies its OWN overflow clip. Old
      // captures (no rootOverflow) fall back to the prior assume-visible default.
      const rootOX = el.styles.rootOverflowX;
      const rootOY = el.styles.rootOverflowY;
      const htmlOverflowVisible = (rootOX == null && rootOY == null)
        || ((rootOX == null || rootOX === "visible") && (rootOY == null || rootOY === "visible"));
      const isBodyOverflowPropagated = el.tag === "body" && htmlOverflowVisible;
      if ((oxClips || oyClips) && !isBodyOverflowPropagated) {
        // The CSS `outline` is painted OUTSIDE the border box and is NOT
        // affected by the element's own overflow per CSS Backgrounds 3 §3 +
        // Basic UI 4 §8 — outline isn't part of the element's content area.
        // Inflate the overflow-clip rect by (outline-offset + outline-width)
        // so the outline rect (emitted later inside this same group) doesn't
        // get clipped out. Otherwise inputs with `:valid` / `:invalid`
        // outlines under the UA's implicit `overflow: clip` lose the entire
        // colored outline (DM-640 / 06-forms-validation-ui).
        const ow_ = parseFloat(el.styles.outlineWidth ?? "0") || 0;
        const ostyle_ = el.styles.outlineStyle ?? "none";
        const ohas = ow_ > 0 && ostyle_ !== "none" && ostyle_ !== "hidden";
        const oOffset_ = ohas ? (parseFloat(el.styles.outlineOffset ?? "0") || 0) : 0;
        const outlineInflate = ohas ? Math.max(0, oOffset_ + ow_) : 0;
        // DM-745: outset box-shadow paints OUTSIDE the element's box and is
        // also unaffected by the element's own overflow per CSS Backgrounds
        // 3 §6.4 — only the element's content / background is clipped to
        // its overflow region, not the decorative shadow. The popover in
        // `niche-command-invokers` has an implicit `overflow: auto` (UA
        // popover rule) and a `box-shadow: 0 30px 60px rgba(15, 23, 42,
        // 0.2)`; without inflating for the shadow's max extent, the clip
        // rect cropped the shadow ink down to a thin sliver inside the
        // popover box. Inflate per-side by `|offset| + spread + blur` so
        // the shadow's full painted area survives.
        const shadowsForClip = parseBoxShadow(el.styles.boxShadow ?? "none");
        let shadowInflateT = 0, shadowInflateR = 0, shadowInflateB = 0, shadowInflateL = 0;
        for (const sh of shadowsForClip) {
          if (sh.inset) continue;
          const reach = sh.spread + sh.blur;
          // Per-side ink extent: spread + blur, plus the shadow's offset
          // pushed in the matching direction. Clamp to 0 so an offset that
          // pulls the shadow away from a side doesn't shrink the inflate.
          shadowInflateT = Math.max(shadowInflateT, reach + Math.max(0, -sh.y));
          shadowInflateR = Math.max(shadowInflateR, reach + Math.max(0, sh.x));
          shadowInflateB = Math.max(shadowInflateB, reach + Math.max(0, sh.y));
          shadowInflateL = Math.max(shadowInflateL, reach + Math.max(0, -sh.x));
        }
        // DM-761: when `overflow: clip` is set with `overflow-clip-margin`,
        // the paint clip extends outward from a reference box (content /
        // padding / border) by a length. The outer clip emitted here wraps
        // the host's own paint (including overflow-clip-margin extension) so
        // a child that overflows past the border-box stays visible up to
        // (ref-box edge + margin). Inflate this outer rect by the part of
        // the margin that falls OUTSIDE the border-box; the inner per-axis
        // clip below applies the tight ref-box-relative bound.
        let ocmInflate = 0;
        const isClipOverflow_ = oxV === "clip" || oyV === "clip";
        const ocmRaw_ = el.styles.overflowClipMargin;
        if (isClipOverflow_ && ocmRaw_ != null && ocmRaw_ !== "" && ocmRaw_ !== "0px") {
          const m = /^(?:(content-box|padding-box|border-box)\s+)?(-?\d*\.?\d+)px$/i.exec(ocmRaw_.trim());
          if (m) {
            const refBox = (m[1] ?? "padding-box").toLowerCase();
            const margin = parseFloat(m[2]);
            const cbtv = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
            const cbrv = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
            const cbbv = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
            const cblv = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
            let offT = 0, offR = 0, offB = 0, offL = 0;
            if (refBox === "padding-box") {
              offT = cbtv; offR = cbrv; offB = cbbv; offL = cblv;
            } else if (refBox === "content-box") {
              offT = cbtv + (parseFloat(el.styles.paddingTop ?? "0") || 0);
              offR = cbrv + (parseFloat(el.styles.paddingRight ?? "0") || 0);
              offB = cbbv + (parseFloat(el.styles.paddingBottom ?? "0") || 0);
              offL = cblv + (parseFloat(el.styles.paddingLeft ?? "0") || 0);
            }
            ocmInflate = Math.max(0, margin - Math.min(offT, offR, offB, offL));
          }
        }
        const inflateT = Math.max(outlineInflate, shadowInflateT, ocmInflate);
        const inflateR = Math.max(outlineInflate, shadowInflateR, ocmInflate);
        const inflateB = Math.max(outlineInflate, shadowInflateB, ocmInflate);
        const inflateL = Math.max(outlineInflate, shadowInflateL, ocmInflate);
        // DM-787: per-axis `overflow-x: clip; overflow-y: visible` (or the
        // inverse) needs the outer clip to NOT bind on the visible axis. A
        // huge ±100000 extension lets descendants paint past the border-box
        // on that axis while the clipped axis stays bounded.
        const UNBOUNDED_CP = 100000;
        const xVisibleCp = oxV === "visible" && oyV === "clip";
        const yVisibleCp = oyV === "visible" && oxV === "clip";
        const cpX = xVisibleCp ? el.x - UNBOUNDED_CP : el.x - inflateL;
        const cpW = xVisibleCp ? el.width + UNBOUNDED_CP * 2 : el.width + inflateL + inflateR;
        const cpY = yVisibleCp ? el.y - UNBOUNDED_CP : el.y - inflateT;
        const cpH = yVisibleCp ? el.height + UNBOUNDED_CP * 2 : el.height + inflateT + inflateB;
        clipPathUrlId = `${idPrefix}cp${clipIdx++}`;
        defsParts.push(
          `<clipPath id="${clipPathUrlId}"><rect x="${r(cpX)}" y="${r(cpY)}" width="${r(cpW)}" height="${r(cpH)}"/></clipPath>`,
        );
      }
    }
    const maskUrlId = renderMaskPhase(el);
    // CSS 2D transform (SK-1134): wrap the elements rendered group in
    // <g transform=...> composed around the resolved transform-origin in
    // viewport coords. transform-origin is reported by Chrome in pixels
    // relative to the elements border box (e.g. "0px 0px" for top-left,
    // "Npx Mpx" for the 50%-50% default). Add el.x/el.y to convert to the
    // viewport coordinate system the SVG draws in. Chrome resolves every
    // CSS transform function to a matrix in computed style, so we only
    // need to translate matrix() / matrix3d() into SVG syntax.
    const transformAttr = svgTransformForElement(el);
    // DM-516: per CSS Compositing 1, an element with `isolation: isolate` (or
    // any implicit-isolation creator: `opacity < 1`, position+z-index SC root,
    // contain:paint, transform, filter…) must form an isolated group for
    // mix-blend-mode descendants. SVG2 honors `isolation:isolate` natively on
    // <g>, so emit it as inline style. Don't apply when this element ITSELF
    // uses mix-blend-mode — that group is the blender, not an isolator. The
    // explicit `isolation: isolate` value must always apply (even with
    // mix-blend-mode the group can be both blender and isolator for its own
    // descendants); but for implicit isolators, only honor when no blend mode
    // is set on the group, otherwise we'd convert intentional blends into
    // no-ops.
    const explicitIsolate = el.styles.isolation === "isolate";
    const implicitIsolate = blendCss === "" && (
      opacity < 1
      || (el.styles.position != null && el.styles.position !== "static"
          && el.styles.zIndex != null && el.styles.zIndex !== "" && el.styles.zIndex !== "auto")
      || (el.styles.contain != null && /\b(?:paint|strict|content)\b/i.test(el.styles.contain))
    );
    const needsIsolation = explicitIsolate || implicitIsolate;
    // DM-603: an element marked for viewBox culling forces a wrapping <g>
    // even if none of the above attributes would otherwise have demanded one,
    // since that's where `style="display:none"` / `class="cull-N"` lives.
    const needsCullWrapper = el.displayNone === true || (el.cullClass != null && el.cullClass !== "");
    const needsGroup = opacity < 1 || filterCss !== "" || blendCss !== "" || clipPathUrlId != null || maskUrlId != null || transformAttr !== "" || needsIsolation || needsCullWrapper;
    const groupAttrs: string[] = [];
    if (transformAttr !== "") groupAttrs.push(`transform="${transformAttr}"`);
    if (opacity < 1) groupAttrs.push(`opacity="${r(opacity)}"`);
    if (clipPathUrlId != null) groupAttrs.push(`clip-path="url(#${clipPathUrlId})"`);
    if (maskUrlId != null) groupAttrs.push(`mask="url(#${maskUrlId})"`);
    // animId (DM-209): elements tagged with `data-domotion-anim="<id>"` in the
    // source DOM get a `class="anim-<id>"` on an extra inner `<g>` wrapper so
    // the animator can target them via CSS keyframes for intra-frame motion.
    // The class lives on a SEPARATE wrapper from any merger-added visibility
    // class (which gets applied to the outer group) so the two `animation`
    // declarations don't clobber each other.
    const animClass = el.animId != null && el.animId !== "" ? `anim-${el.animId}` : "";
    // DM-603: viewBox-cull class (`cull-N`) goes on the OUTER group so it
    // composes with any inner animation/transform wrappers cleanly. Likewise
    // `style="display:none"` is on the outer group so the entire subtree is
    // skipped from paint.
    if (el.cullClass != null && el.cullClass !== "") groupAttrs.push(`class="${esc(el.cullClass)}"`);
    // DM-704: SVG applies `filter` BEFORE `clip-path` when both sit on the
    // same `<g>` (the spec: "the filter is applied to the source graphic
    // before the clip path"). For drop-shadow / blur, that means the
    // filter's ink area extends beyond the element box but then gets
    // clipped back to the box and never paints — the shadow vanishes. Hoist
    // `filter` onto an OUTER wrapper so it processes already-clipped
    // content; the unclipped ink area then renders.
    const needsFilterOuter = filterCss !== "" && (clipPathUrlId != null || maskUrlId != null);
    const styleParts: string[] = [];
    if (filterCss !== "" && !needsFilterOuter) styleParts.push(`filter:${filterCss}`);
    if (blendCss !== "") styleParts.push(`mix-blend-mode:${blendCss}`);
    if (needsIsolation) styleParts.push("isolation:isolate");
    if (el.displayNone === true) styleParts.push("display:none");
    // DM-486: HTML-escape the style attribute value. Chromium normalises
    // `filter: url(#id)` to `url("#id")` (with quotes) — emitting that raw
    // produced `style="filter:url("#id")"` and broke the SVG parser.
    if (styleParts.length > 0) groupAttrs.push(`style="${esc(styleParts.join(";"))}"`);
    const opened = needsGroup;
    if (needsFilterOuter) svgParts.push(`${indent}<g style="${esc(`filter:${filterCss}`)}">`);
    if (opened) svgParts.push(`${indent}<g ${groupAttrs.join(" ")}>`);
    // Inner anim-class wrapper sits INSIDE any visibility/transform group so
    // the merger's class (added on the outer group) and our anim class can
    // each carry their own `animation` shorthand without clobbering.
    if (animClass !== "") svgParts.push(`${indent}<g class="${animClass}">`);

    // Inline-fragment paint: when the element wraps across multiple line
    // boxes and the bbox-based paint would smear background + border across
    // the whole logical inline (typically the full container width), paint
    // each line fragment individually. The remaining bbox-based emissions
    // (outset shadow, bg color, bg image, inset shadow, border-image,
    // border) are gated below on `!useInlineFragments` so they don't double
    // up. Outline still paints around the bbox — it's outside the box and
    // CSS doesn't fragment it per inline line box.
    if (useInlineFragments) {
      renderInlineFragments(el, indent, bgColor, corners);
    }

    // Outset box-shadow (SK-1101 + SK-1113): paints BENEATH the element box.
    // CSS spec says the first shadow in the list is closest to the element;
    // later shadows sit further behind. SVG paints later in document order,
    // so to get the same stacking we iterate the list in REVERSE (deepest
    // first). Blur > 0 routes through an SVG <filter feGaussianBlur> with
    // stdDeviation ≈ blur/2 (matches Chromes blur-to-stdDev mapping).
    if (!useInlineFragments) {
      const _bs = paintBoxShadow(el, corners, idPrefix, indent, clipIdx);
      svgParts.push(..._bs.svg); defsParts.push(..._bs.defs); clipIdx = _bs.clipIdx;
    }

    // Background rect(s). CSS lets backgrounds stack via background-image with
    // a comma-separated list of linear/radial gradients and url() images. The
    // first layer paints on top — we emit in reverse so the rect order matches
    // CSS layering. The background-color paints *under* all layers.
    svgParts.push(...paintBackgroundColor(el, corners, indent, bgColor, useInlineFragments, suppressEmptyCell));
    // DM-462: when the element uses `background-clip: text`, the first
    // text-clipped layer's gradient/image is captured here and used as the
    // fill on the text glyph group (instead of painting it as a normal
    // <rect fill=url(#bg)> over the headline area). Initialized to null and
    // assigned in the bg-layer loop below.
    // DM-696: multiple `background-clip: text` layers must all composite into
    // the glyph shapes (top layer on top of lower layers, same as CSS bg
    // layering on a normal box). Collect them in CSS-source order (layer 0
    // = topmost) and emit each as its own masked rect at render time, in
    // REVERSE order so the topmost CSS layer is the last `<rect>` and paints
    // on top.
    const textBgClipFills: string[] = [];

    const bgImage = el.styles.backgroundImage;
    if (!useInlineFragments && bgImage != null && bgImage !== "none" && bgImage !== "") {
      const layers = splitTopLevelCommas(bgImage);
      const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
      const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
      const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
      const clipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
      const originLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
      const attachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
      const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
      // DM-817: background-blend-mode per CSS Compositing 2 §6.1 — each layer
      // blends with the composite below using its mode. Single value applies
      // to every layer; comma-separated values map per-layer. Capture
      // emit-time bg-layer indexing is reversed (later index = lower in
      // stack), so we look up by the ORIGINAL CSS layer index (`li`).
      const blendLayers = splitTopLevelCommas(el.styles.backgroundBlendMode ?? "normal").map((s) => s.trim());
      const hasNonNormalBlend = blendLayers.some((m) => m !== "normal" && m !== "");
      const bgGroupOpen = hasNonNormalBlend ? `${indent}<g style="isolation:isolate">\n` : "";
      const bgGroupClose = hasNonNormalBlend ? `\n${indent}</g>` : "";
      const bgGroupStart = svgParts.length;
      // Per-side borders + padding for clip/origin math.
      const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
      const padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
      const padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
      const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
      // Box helpers: border-box = captured rect, padding-box = border inset,
      // content-box = border+padding inset.
      const boxFor = (key: string): { x: number; y: number; w: number; h: number } => {
        if (key === "content-box") {
          return { x: el.x + bwL + padL, y: el.y + bwT + padT, w: el.width - bwL - bwR - padL - padR, h: el.height - bwT - bwB - padT - padB };
        }
        if (key === "padding-box") {
          return { x: el.x + bwL, y: el.y + bwT, w: el.width - bwL - bwR, h: el.height - bwT - bwB };
        }
        return { x: el.x, y: el.y, w: el.width, h: el.height };
      };
      // CSS: first layer paints on top of later layers. Emit in reverse order
      // so later SVG elements (= on top) correspond to first CSS layer.
      for (let li = layers.length - 1; li >= 0; li--) {
        const layer = layers[li].trim();
        const layerSize = (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim();
        const layerPos = (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim();
        const layerRepeat = (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim();
        const layerClip = (clipLayers[li] ?? clipLayers[0] ?? "border-box").trim();
        const layerOrigin = (originLayers[li] ?? originLayers[0] ?? "padding-box").trim();
        const layerIntrinsic = intrinsicLayers[li] ?? null;
        const layerAttachment = (attachmentLayers[li] ?? attachmentLayers[0] ?? "scroll").trim();
        const originBox = boxFor(layerOrigin);
        const clipBox = boxFor(layerClip);
        // DM-821: `background-attachment: local` positions and sizes the
        // layer against the element's full scrollable content area, not its
        // visible viewport. `background-size: contain` on a 936×220 panel
        // whose scroll content runs ~820px tall sizes the image to fit the
        // 936×820 box (one width-filling tile), but using just the visible
        // box sizes it to 660×220 instead and tiles horizontally with a
        // visible second copy at the right edge. Substitute the scroll
        // dimensions when the element actually scrolls.
        let posOriginX = originBox.x, posOriginY = originBox.y;
        let posOriginW = originBox.w, posOriginH = originBox.h;
        if (layerAttachment === "local" && el.styles.scrollHeight != null && el.styles.scrollWidth != null) {
          const sw = el.styles.scrollWidth as number;
          const sh = el.styles.scrollHeight as number;
          if (sw > posOriginW) posOriginW = sw;
          if (sh > posOriginH) posOriginH = sh;
        }
        const defId = `${idPrefix}bg${clipIdx++}`;
        // Pattern is positioned + sized relative to the origin box (where the image starts)
        // then painted into a rect clipped to the clip box. For fixed attachment
        // the origin is the viewport instead.
        const out = buildBackgroundLayerDef(defId, layer, posOriginX, posOriginY, posOriginW, posOriginH, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport);
        if (out.def === "") continue;
        defsParts.push(out.def);
        // DM-462: when this layer's clip is `text`, do NOT paint a rect over
        // the headline area — the gradient should appear inside the glyph
        // shapes only. Stash the def URL so the text-rendering block below
        // can use it as the glyph fill (the first text-clipped layer wins).
        // The non-text-clipped layers (if any) still emit normally.
        if (layerClip === "text") {
          // li counts down (loop iterates from layers.length-1 → 0). Storing at
          // index li lets us emit topmost layer last regardless of loop dir.
          textBgClipFills[li] = `url(#${defId})`;
          continue;
        }
        // Inner clip corners: subtract the corresponding border-side widths
        // so a per-corner border-radius becomes the inner radius the bg layer
        // is clipped to. For padding-box / content-box layers this matches
        // CSS's "the corner gets pulled in by the adjacent border widths"
        // semantics (rTL.h shrinks by bwL, rTL.v shrinks by bwT, etc.).
        const innerCorners = layerClip === "border-box"
          ? corners
          : insetCornerRadii(corners, bwT, bwR, bwB, bwL);
        // DM-817: per-layer mix-blend-mode. Bottom layer (CSS layer
        // layers.length-1) always paints normal; upper layers blend.
        const layerBlend = blendLayers[li] ?? blendLayers[0] ?? "normal";
        const blendAttr = (layerBlend !== "normal" && layerBlend !== "")
          ? ` style="mix-blend-mode:${layerBlend}"` : "";
        svgParts.push(
          `${indent}${roundedRectSvg(clipBox.x, clipBox.y, clipBox.w, clipBox.h, innerCorners, `fill="url(#${defId})"${blendAttr}`)}`,
        );
      }
      // DM-817: wrap the bg-layer rects we just emitted in an
      // isolation-isolate group so the multiply / screen / etc. doesn't
      // bleed into siblings painted above.
      if (hasNonNormalBlend && svgParts.length > bgGroupStart) {
        const wrapped = bgGroupOpen + svgParts.slice(bgGroupStart).join("\n") + bgGroupClose;
        svgParts.length = bgGroupStart;
        svgParts.push(wrapped);
      }
    }

    // DM-1053: a multi-line (inline-fragment) element with its OWN
    // `background-clip: text` gradient. The bg-layer loop above is gated on
    // `!useInlineFragments`, and `renderInlineFragments()` deliberately skips
    // text-clip layers (it can't per-fragment-mask glyphs), so a wrapped
    // gradient-text run would build NO self def and fall through to the
    // inherited-ancestor gradient (DM-749) — e.g. Resend's gold "this morning"
    // inside its white-gradient H2 painted flat white. Build the element's own
    // text-clip layer def(s) against its bbox and stash them in
    // `textBgClipFills` so the text-fill decision below prefers them over the
    // inherited gradient and routes through the glyph-mask path (which spans
    // all fragments correctly). Only the `text`-clipped layers are built here;
    // the box-painted layers stay owned by `renderInlineFragments()`.
    if (useInlineFragments && bgImage != null && bgImage !== "none" && bgImage !== "") {
      const layers = splitTopLevelCommas(bgImage);
      const clipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
      const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
      const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
      const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
      const attachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
      const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
      for (let li = layers.length - 1; li >= 0; li--) {
        const layerClip = (clipLayers[li] ?? clipLayers[0] ?? "border-box").trim();
        if (layerClip !== "text") continue;
        const layer = layers[li].trim();
        const layerSize = (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim();
        const layerPos = (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim();
        const layerRepeat = (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim();
        const layerAttachment = (attachmentLayers[li] ?? attachmentLayers[0] ?? "scroll").trim();
        const layerIntrinsic = intrinsicLayers[li] ?? null;
        const defId = `${idPrefix}bg${clipIdx++}`;
        const out = buildBackgroundLayerDef(defId, layer, el.x, el.y, el.width, el.height, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport);
        if (out.def === "") continue;
        defsParts.push(out.def);
        textBgClipFills[li] = `url(#${defId})`;
      }
    }

    // Inset box-shadow per CSS Backgrounds 3 §6.4 + Chromium
    // `BoxPainterBase::PaintInsetBoxShadow`: the shadow shape is the padding
    // box shifted by (x, y) and inset by `spread` on each side. The shadow
    // paints inside the padding box BUT OUTSIDE the shadow shape — like a
    // donut whose hole is the shadow shape. With offset, the donut becomes
    // asymmetric (e.g. `inset 0 -16px 32px` darkens the bottom strip and
    // fades upward); with pure spread, it becomes a uniform ring; with pure
    // blur centered, it becomes a soft inner glow.
    //
    // Implementation: emit two subpaths with `fill-rule="evenodd"` — outer =
    // padding box expanded outward by enough margin to contain the blur
    // halo, inner = padding box shifted by (sh.x, sh.y) and inset by
    // sh.spread on each side. Apply Gaussian blur (stdDev = blur/2). Clip
    // the whole thing to the padding box so the outer-margin overflow and
    // the parts of the halo outside the box don't leak.
    if (!useInlineFragments) {
      const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
      const sbwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const sbwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const sbwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const sbwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const ibLeft = el.x + sbwL;
      const ibTop = el.y + sbwT;
      const ibW = Math.max(0, el.width - sbwL - sbwR);
      const ibH = Math.max(0, el.height - sbwT - sbwB);
      const innerCorners = insetCornerRadii(corners, sbwT, sbwR, sbwB, sbwL);
      // DM-699: CSS Backgrounds 3 §6.4 stacks shadows with the FIRST shadow
      // ON TOP. The outer-shadow loop above already iterates in reverse so
      // the topmost CSS shadow emits last; this inset loop was iterating
      // FORWARD, so e.g. `box-shadow: inset 0 0 0 8px #b45309, inset 0 6px
      // 24px rgba(0,0,0,.4)` (brown ring on top of a dark glow) painted the
      // brown ring FIRST and the dark glow LAST — the glow then ended up on
      // top, darkening the brown ring at the top of the box.
      for (let si = shadows.length - 1; si >= 0; si--) {
        const sh = shadows[si];
        if (!sh.inset) continue;
        if (sh.spread === 0 && sh.blur === 0) continue;
        if (ibW <= 0 || ibH <= 0) continue;

        const shadowColor = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
        let filterAttr = "";
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}ish${clipIdx++}`;
          defsParts.push(
            `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
          );
          filterAttr = ` filter="url(#${fid})"`;
        }
        const cid = `${idPrefix}ishc${clipIdx++}`;
        defsParts.push(
          `<clipPath id="${cid}">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, "")}</clipPath>`,
        );

        // Pure-blur-centered inset (x=0, y=0, spread=0, blur>0): the donut
        // has zero area, so use the legacy stroked-rect approach which
        // produces the right soft glow on all sides. Stroke width = blur/2;
        // the Gaussian softens it into Chrome's inset-glow falloff. DM-366.
        if (sh.x === 0 && sh.y === 0 && sh.spread === 0) {
          const ringWidth = Math.max(sh.blur / 2, 1);
          svgParts.push(
            `${indent}<g clip-path="url(#${cid})">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, `fill="none" stroke="${shadowColor}" stroke-width="${r(ringWidth)}"${filterAttr}`)}</g>`,
          );
          continue;
        }

        // Donut path: outer subpath = padding box expanded by a margin
        // sized to contain the blur halo + spread; inner subpath = padding
        // box shifted by (sh.x, sh.y) and inset by sh.spread on each side.
        // Even-odd fill paints the frame between the two subpaths with the
        // shadow color; blur softens; the clip-path keeps the result inside
        // the padding box.
        const innerL = ibLeft + sh.x + sh.spread;
        const innerT = ibTop + sh.y + sh.spread;
        const innerW = ibW - 2 * sh.spread;
        const innerH = ibH - 2 * sh.spread;
        if (innerW <= 0 || innerH <= 0) {
          // Shadow shape collapsed: per spec the entire padding box fills
          // with shadow color (with blur halo) — emit a solid rect.
          svgParts.push(
            `${indent}<g clip-path="url(#${cid})">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, `fill="${shadowColor}"${filterAttr}`)}</g>`,
          );
          continue;
        }
        const innerC = insetCornerRadii(innerCorners, sh.spread, sh.spread, sh.spread, sh.spread);
        const margin = Math.max(Math.abs(sh.x), Math.abs(sh.y), sh.spread, sh.blur, 1) * 4;
        const outerX = Math.min(ibLeft, innerL) - margin;
        const outerY = Math.min(ibTop, innerT) - margin;
        const outerR = Math.max(ibLeft + ibW, innerL + innerW) + margin;
        const outerB = Math.max(ibTop + ibH, innerT + innerH) + margin;
        const sharp: CornerRadii = { tl: { h: 0, v: 0 }, tr: { h: 0, v: 0 }, br: { h: 0, v: 0 }, bl: { h: 0, v: 0 }, uniform: true };
        const outerD = roundedRectPath(outerX, outerY, outerR - outerX, outerB - outerY, sharp);
        const innerD = roundedRectPath(innerL, innerT, innerW, innerH, innerC);
        svgParts.push(
          `${indent}<g clip-path="url(#${cid})"><path d="${outerD} ${innerD}" fill="${shadowColor}" fill-rule="evenodd"${filterAttr}/></g>`,
        );
      }
    }

    // Border-image: if a URL source with intrinsic dimensions is present,
    // emit a 9-slice composition and SKIP the plain-border fallback below.
    // Gradient sources are not supported in this pass (tracked as follow-up).
    const borderImageMarkup = useInlineFragments
      ? { svg: "", usedIds: 0 }
      : renderBorderImage(el, indent, idPrefix, defsParts, clipIdx);
    if (borderImageMarkup.usedIds > 0) clipIdx += borderImageMarkup.usedIds;
    const borderImagePainted = borderImageMarkup.svg !== "";
    if (borderImagePainted) svgParts.push(borderImageMarkup.svg);

    // Border — uniform or per-side. Skipped when a border-image painted above.
    const bt = parseSide(el.styles.borderTopWidth, el.styles.borderTopStyle, el.styles.borderTopColor);
    const br = parseSide(el.styles.borderRightWidth, el.styles.borderRightStyle, el.styles.borderRightColor);
    const bb = parseSide(el.styles.borderBottomWidth, el.styles.borderBottomStyle, el.styles.borderBottomColor);
    const bl = parseSide(el.styles.borderLeftWidth, el.styles.borderLeftStyle, el.styles.borderLeftColor);
    const uniform = bt != null && br != null && bb != null && bl != null
      && bt.w === br.w && br.w === bb.w && bb.w === bl.w
      && bt.style === br.style && br.style === bb.style && bb.style === bl.style
      && sameColor(bt.color, br.color) && sameColor(br.color, bb.color) && sameColor(bb.color, bl.color);

    // <fieldset>+<legend> notch: clip the border drawing to exclude the
    // legend's bbox so the top border breaks behind the legend, matching
    // Chrome's UA fieldset paint. DM-342/DM-343.
    let notchedBorderOpen = false;
    if (el.fieldsetLegendNotch != null) {
      const ln = el.fieldsetLegendNotch;
      const notchId = `${idPrefix}fln${clipIdx++}`;
      defsParts.push(
        `<clipPath id="${notchId}" clip-rule="evenodd"><path d="M 0 0 L ${r(width)} 0 L ${r(width)} ${r(height)} L 0 ${r(height)} Z M ${r(ln.x)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y + ln.h)} L ${r(ln.x)} ${r(ln.y + ln.h)} Z" clip-rule="evenodd"/></clipPath>`,
      );
      svgParts.push(`${indent}<g clip-path="url(#${notchId})">`);
      notchedBorderOpen = true;
    }

    if (suppressEmptyCell) {
      // empty-cells: hide — suppress the border too.
    } else if (useInlineFragments) {
      // Border painted per-fragment in renderInlineFragments above.
    } else if (borderImagePainted) {
      // Border visual came from border-image. Skip the plain-border emission.
    } else if (uniform && bt != null && bt.w > 0) {
      const style = bt.style;
      if (style === "double" && bt.w >= 3) {
        // CSS double border: two parallel strokes each 1/3 of border-width,
        // separated by 1/3 gap. Our captured rect is the border box (outer
        // edge), so strokes need their centerlines at 1/6*w (outer) and
        // 5/6*w (inner) inside the border box.
        //
        // DM-689: In `border-collapse: collapse` mode Chrome paints the
        // border CENTERED on the cell's grid edge instead of inside the
        // cell box — half the border width sits outside the cell, half
        // inside. Match that by shifting the outer/inner offsets outward
        // by bt.w/2 in collapse mode (Blink's
        // `CollapsedBorderPainter::PaintCollapsedBorders` centers the
        // collapsed-border rect on the grid line).
        const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
        const collapseShift = collapse ? bt.w / 2 : 0;
        const strokeW = bt.w / 3;
        const outerInset = bt.w / 6 - collapseShift;
        const innerInset = bt.w * 5 / 6 - collapseShift;
        const outerCorners = insetCornerRadii(corners, outerInset, outerInset, outerInset, outerInset);
        const innerCorners = insetCornerRadii(corners, innerInset, innerInset, innerInset, innerInset);
        svgParts.push(
          `${indent}${roundedRectSvg(el.x + outerInset, el.y + outerInset, el.width - 2 * outerInset, el.height - 2 * outerInset, outerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
        );
        svgParts.push(
          `${indent}${roundedRectSvg(el.x + innerInset, el.y + innerInset, el.width - 2 * innerInset, el.height - 2 * innerInset, innerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
        );
      } else if ((style === "groove" || style === "ridge" || style === "inset" || style === "outset") && bt.w >= 1) {
        // 3D bevel borders (DM-280). Each side is painted as its own
        // trapezoid polygon so the four shade pairs miter cleanly at corners.
        // Inset / outset: solid shade per side. Groove / ridge: split each
        // side into outer and inner halves with inverted shades so the
        // border reads as a carved (groove) or raised (ridge) ridge.
        const w = bt.w;
        const x0 = el.x, y0 = el.y;
        const x1 = el.x + el.width, y1 = el.y + el.height;
        // Match Chromium's BoxBorderPainter: darker = base × 2/3 per channel,
        // lighter = the base color itself (no actual lightening). The
        // earlier symmetric ±22% lightness shift in HSL space produced too
        // much contrast vs Chromium's painted output (DM-293).
        const darker = colorStr({ r: Math.round(bt.color.r * 2 / 3), g: Math.round(bt.color.g * 2 / 3), b: Math.round(bt.color.b * 2 / 3), a: bt.color.a });
        const lighter = colorStr(bt.color);
        // tl = top + left (sharing one shade); br = bottom + right (other shade).
        const tlIsLighter = style === "outset" || style === "ridge";
        const tlColor = tlIsLighter ? lighter : darker;
        const brColor = tlIsLighter ? darker : lighter;
        // Trapezoid polygons for each side. Outer corners are the captured
        // border-box corners; inner corners are inset by w on each axis.
        const topPoly = `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`;
        const rightPoly = `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`;
        const bottomPoly = `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`;
        const leftPoly = `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`;
        if (style === "inset" || style === "outset") {
          svgParts.push(`${indent}<polygon points="${topPoly}" fill="${tlColor}" />`);
          svgParts.push(`${indent}<polygon points="${leftPoly}" fill="${tlColor}" />`);
          svgParts.push(`${indent}<polygon points="${rightPoly}" fill="${brColor}" />`);
          svgParts.push(`${indent}<polygon points="${bottomPoly}" fill="${brColor}" />`);
        } else {
          // Groove / ridge: split each trapezoid horizontally in half so the
          // outer half and inner half can carry inverse shades. The mid-line
          // for the top trapezoid runs from (x0+w/2, y0+w/2) to
          // (x1-w/2, y0+w/2) — i.e., w/2 inset on every axis.
          const halfW = w / 2;
          const xa = x0, xb = x1, ya = y0, yb = y1;
          // Outer halves: top, right, bottom, left — each is a 4-pt polygon.
          const topOuter = `${r(xa)},${r(ya)} ${r(xb)},${r(ya)} ${r(xb - halfW)},${r(ya + halfW)} ${r(xa + halfW)},${r(ya + halfW)}`;
          const rightOuter = `${r(xb)},${r(ya)} ${r(xb)},${r(yb)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - halfW)},${r(ya + halfW)}`;
          const bottomOuter = `${r(xa)},${r(yb)} ${r(xb)},${r(yb)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xa + halfW)},${r(yb - halfW)}`;
          const leftOuter = `${r(xa)},${r(ya)} ${r(xa)},${r(yb)} ${r(xa + halfW)},${r(yb - halfW)} ${r(xa + halfW)},${r(ya + halfW)}`;
          // Inner halves: top, right, bottom, left.
          const topInner = `${r(xa + halfW)},${r(ya + halfW)} ${r(xb - halfW)},${r(ya + halfW)} ${r(xb - w)},${r(ya + w)} ${r(xa + w)},${r(ya + w)}`;
          const rightInner = `${r(xb - halfW)},${r(ya + halfW)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - w)},${r(yb - w)} ${r(xb - w)},${r(ya + w)}`;
          const bottomInner = `${r(xa + halfW)},${r(yb - halfW)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - w)},${r(yb - w)} ${r(xa + w)},${r(yb - w)}`;
          const leftInner = `${r(xa + halfW)},${r(ya + halfW)} ${r(xa + halfW)},${r(yb - halfW)} ${r(xa + w)},${r(yb - w)} ${r(xa + w)},${r(ya + w)}`;
          // groove: outer is darker on top+left, lighter on bottom+right
          // (carved-in look); inner is the inverse so the inside of the
          // groove brightens on top+left.
          // ridge:  outer is lighter on top+left, darker on bottom+right
          // (raised look); inner is the inverse.
          const outerTL = style === "ridge" ? lighter : darker;
          const outerBR = style === "ridge" ? darker : lighter;
          const innerTL = outerBR;
          const innerBR = outerTL;
          svgParts.push(`${indent}<polygon points="${topOuter}" fill="${outerTL}" />`);
          svgParts.push(`${indent}<polygon points="${leftOuter}" fill="${outerTL}" />`);
          svgParts.push(`${indent}<polygon points="${rightOuter}" fill="${outerBR}" />`);
          svgParts.push(`${indent}<polygon points="${bottomOuter}" fill="${outerBR}" />`);
          svgParts.push(`${indent}<polygon points="${topInner}" fill="${innerTL}" />`);
          svgParts.push(`${indent}<polygon points="${leftInner}" fill="${innerTL}" />`);
          svgParts.push(`${indent}<polygon points="${rightInner}" fill="${innerBR}" />`);
          svgParts.push(`${indent}<polygon points="${bottomInner}" fill="${innerBR}" />`);
        }
      } else if ((style === "dashed" || style === "dotted") && corners.uniform && corners.tl.h === 0) {
        // Dashed/dotted uniform borders need per-side dash spacing — Chrome
        // adjusts the dash cycle so dashes start and end exactly at corners.
        // SVG `stroke-dasharray` on a single rect would use ONE pattern across
        // all 4 sides, but the top/bottom and left/right have different
        // lengths, so the pattern would mis-align at every corner. Emit 4
        // lines instead so each side gets its own adjusted pattern.
        const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
        const inset = collapse ? 0 : bt.w / 2;
        // For dotted, the dasharray is `0.01 period` and renders dots only
        // when the line has `stroke-linecap="round"` (each near-zero dash
        // becomes a circle of stroke-width diameter). Without it the dots
        // are invisible (DM-399). Round caps match Chromium's BoxBorderPainter
        // which paints dotted as "0 length dash strokes and round endcaps,
        // producing circles" (verified via Chromium source — DM-435 was
        // reverted, the earlier square-dots probe was misled by AA at 3 px
        // dot size; high-resolution probe confirms circles).
        const linecap = style === "dotted" ? ` stroke-linecap="round"` : "";
        // Round box edges to integer device pixels so the stroke center
        // lands on an integer (for even widths) and paints 2 solid rows
        // instead of 3 antialiased rows. Skip when border-collapse:collapse
        // because shared edges between adjacent cells must use the same
        // (un-rounded) coords to overlap exactly. DM-403/405.
        const bL = collapse ? el.x : Math.round(el.x);
        const bT = collapse ? el.y : Math.round(el.y);
        const bR = collapse ? el.x + el.width : Math.round(el.x + el.width);
        const bB = collapse ? el.y + el.height : Math.round(el.y + el.height);
        // Corner trim along the side's axis. Two reasons it applies:
        //   • Dotted (always): Chromium's `DrawLineWithStyle` moves the
        //     line endpoints IN by width/2 before stroking thick-dotted
        //     lines so the round endcap fits inside the line. Matching
        //     that is necessary for `adjustedDashAttrs` (which assumes a
        //     post-move sideLength) to compute Chrome-equivalent dot
        //     centres. The adjacent sides' first dots overlap at the
        //     corner, producing one visible corner dot. (DM-805.)
        //   • Dashed thick (≥ 8 px): legacy corner-overlap prevention so
        //     butt-cap dashes don't double-paint the corner pixel as a
        //     darker square (DM-402, visible on the 10 px dashed border
        //     in `17-bg-color-image`). Thin dashed borders use 0 trim
        //     so the dashes meet flush at the corner, matching Chrome
        //     for the common 1-3 px cases.
        const cornerTrim = style === "dotted" ? bt.w / 2 : (bt.w >= 8 ? inset : 0);
        // Each entry: [x1, y1, x2, y2, naturalLen]. naturalLen is the
        // PRE-cornerTrim side length — Chromium's `DrawLineWithStyle`
        // computes the dash pattern from the original `info.path_length`
        // BEFORE moving thick-dotted endpoints inward by width/2 (the move
        // shifts the painted line but the dash math sees the original).
        // For thin dashed borders cornerTrim = 0, so naturalLen == drawn
        // length; for dotted (cornerTrim = width/2) and thick dashed
        // (cornerTrim = width/2) the two differ.
        const sides: Array<[number, number, number, number, number]> = [
          [bL + cornerTrim, bT + inset, bR - cornerTrim, bT + inset, bR - bL],
          [bR - inset, bT + cornerTrim, bR - inset, bB - cornerTrim, bB - bT],
          [bL + cornerTrim, bB - inset, bR - cornerTrim, bB - inset, bR - bL],
          [bL + inset, bT + cornerTrim, bL + inset, bB - cornerTrim, bB - bT],
        ];
        for (const [x1, y1, x2, y2, len] of sides) {
          const { array: dash, offset } = adjustedDashAttrs(style, bt.w, len);
          // DM-912: the dash math computes pattern positions from `len` (the
          // OUTER corner-to-corner length, e.g. 300 for a 10 px border on a
          // 300 px box), but the SVG `<line>` is drawn from the INNER
          // cornerTrim'd endpoints (length len - 2·cornerTrim). SVG's
          // `stroke-dasharray` phases from the line START, so without a
          // shift the visible dashes land cornerTrim px ahead of where
          // Chrome's `BoxBorderPainter` paints them. Adding a
          // `stroke-dashoffset` equal to `cornerTrim` rewinds the pattern
          // so the visible portion aligns with Chrome's per-edge dash
          // positions.
          const phaseOffset = cornerTrim > 0 ? offset + cornerTrim : offset;
          const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${phaseOffset !== 0 ? ` stroke-dashoffset="${r(phaseOffset)}"` : ""}` : "";
          svgParts.push(
            `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttrs}${linecap} />`,
          );
        }
      } else {
        const dash = dashArrayForStyle(bt.style, bt.w);
        const linecap = "";
        // CSS paints borders INSIDE the border-box. SVG strokes are centered on
        // the path, so half would spill outside. Inset the rect by half the
        // stroke width so the stroke sits entirely inside the element box.
        // Exception: with border-collapse:collapse on the parent table, Chrome
        // collapses adjacent cell borders into a single shared line painted ON
        // the shared edge (not inset). If we kept the inset, two adjacent
        // cells'\'' borders would land ~1px apart and read as a doubled 2px line.
        // Centered painting (no inset) lets the two cells'\'' borders overlap
        // exactly, producing a single 1px line — matching Chrome'\''s collapsed
        // table grid.
        const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
        const half = collapse ? 0 : bt.w / 2;
        const strokeCorners = insetCornerRadii(corners, half, half, half, half);
        const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
        // Chrome paints borders aligned to device pixels: it rounds the box
        // edges to integers before stroking. Our captured `el.x / el.y` are
        // fractional from `getBoundingClientRect()`, so emitting the stroke
        // at `el.x + half` puts the stroke center at a fractional y, which
        // the SVG renderer then antialiases across 3 pixel rows instead of
        // 2 — producing a visibly thicker / blurrier border. Round the box
        // edges to integers (matching Chrome's per-edge `round`), then add
        // the half-stroke offset. Skip when collapse=true so shared cell
        // edges still overlap exactly. DM-403/405/406/407/410.
        const boxLeft = collapse ? el.x : Math.round(el.x);
        const boxTop = collapse ? el.y : Math.round(el.y);
        const boxRight = collapse ? el.x + el.width : Math.round(el.x + el.width);
        const boxBottom = collapse ? el.y + el.height : Math.round(el.y + el.height);
        svgParts.push(
          `${indent}${roundedRectSvg(boxLeft + half, boxTop + half, Math.max(0, boxRight - boxLeft - half * 2), Math.max(0, boxBottom - boxTop - half * 2), strokeCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttr}${linecap}`)}`,
        );
      }
    } else if (!uniform) {
      // Per-side border: emit 4 separate lines along the element edges. Lines
      // are drawn at the centerline of each border so stroke spills equally
      // inward/outward — visually close enough for typical 1-10px borders.
      // Mitered-corner trim (DM-329): Chrome's BoxBorderPainter paints each
      // side as a trapezoid; the corner pixels belong to whichever adjacent
      // side has the WIDER border (the wider trapezoid extends further into
      // the corner past the narrower one's miter line). To approximate that
      // with center-stroked lines, each side is trimmed at each end by the
      // adjacent side's WIDTH if that adjacent is wider — the wider side
      // then "owns" the corner unobstructed. When self ≥ adjacent we don't
      // trim, so this side wins the corner. Without this rule the painting
      // order alone (top → right → bottom → left) determined corner
      // ownership, painting the TR / BL corners with the wrong side when
      // top/bottom were thicker than right/left (e.g. box 3 of the
      // border-styles-variants fixture: top=4, right=2 — Chrome paints TR
      // red because top is thicker, but our right line covered it yellow).
      // border-collapse:collapse → paint each side ON the cell edge (not
      // inset by half-width), so two adjacent cells'\'' shared sides overlap
      // exactly and produce a single line instead of a doubled one.
      const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
      const inset = (w: number) => collapse ? 0 : w / 2;
      const tw = bt?.w ?? 0;
      const rw = br?.w ?? 0;
      const bw = bb?.w ?? 0;
      const lw = bl?.w ?? 0;
      const trimAdj = (self: number, adj: number) => collapse ? 0 : (adj > self ? adj : 0);
      // Round box edges to integer device pixels so each per-side stroke
      // lands on Chrome's pixel grid. Only when border-collapse !== collapse:
      // collapsed table cells share their borders with neighbors and rounding
      // would split the shared edge between two integer rows. DM-403/405/407.
      const roundEdges = !collapse;
      const bxL = roundEdges ? Math.round(el.x) : el.x;
      const bxT = roundEdges ? Math.round(el.y) : el.y;
      const bxR = roundEdges ? Math.round(el.x + el.width) : el.x + el.width;
      const bxB = roundEdges ? Math.round(el.y + el.height) : el.y + el.height;
      const sides: Array<[typeof bt, number, number, number, number, number]> = [
        [bt, bxL + trimAdj(tw, lw), bxT + inset(tw), bxR - trimAdj(tw, rw), bxT + inset(tw), Math.max(0, bxR - bxL - trimAdj(tw, lw) - trimAdj(tw, rw))],
        [br, bxR - inset(rw), bxT + trimAdj(rw, tw), bxR - inset(rw), bxB - trimAdj(rw, bw), Math.max(0, bxB - bxT - trimAdj(rw, tw) - trimAdj(rw, bw))],
        [bb, bxL + trimAdj(bw, lw), bxB - inset(bw), bxR - trimAdj(bw, rw), bxB - inset(bw), Math.max(0, bxR - bxL - trimAdj(bw, lw) - trimAdj(bw, rw))],
        [bl, bxL + inset(lw), bxT + trimAdj(lw, tw), bxL + inset(lw), bxB - trimAdj(lw, bw), Math.max(0, bxB - bxT - trimAdj(lw, tw) - trimAdj(lw, bw))],
      ];
      // For SOLID sides (and only when not collapsed), emit each side as a
      // `<polygon>` trapezoid that meets adjacent sides at a miter — this
      // produces Chrome's BoxBorderPainter taper exactly without needing
      // the trimAdj winner-takes-corner heuristic. The trapezoid'\\'s outer
      // edge sits flush with the box outer rect, and the inner edge is
      // inset by the side'\\'s width, with the corner points meeting the
      // adjacent sides' inner edges. Dashed / dotted / double / etc. sides
      // continue to use `<line>` because they'\\'d need a clip-path to
      // reproduce the trapezoid taper, which would clip the dashes
      // mid-pattern. DM-421.
      const useTrapezoid = (side: typeof bt) => !collapse && side != null && side.style === "solid" && side.w > 0;
      const trapezoids: Array<[typeof bt, string]> = [
        // top: outer L,T  outer R,T  inner R-rw,T+tw  inner L+lw,T+tw
        [bt, `${r(bxL)},${r(bxT)} ${r(bxR)},${r(bxT)} ${r(bxR - rw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxT + tw)}`],
        // right: outer R,T  outer R,B  inner R-rw,B-bw  inner R-rw,T+tw
        [br, `${r(bxR)},${r(bxT)} ${r(bxR)},${r(bxB)} ${r(bxR - rw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxT + tw)}`],
        // bottom: outer R,B  outer L,B  inner L+lw,B-bw  inner R-rw,B-bw
        [bb, `${r(bxR)},${r(bxB)} ${r(bxL)},${r(bxB)} ${r(bxL + lw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxB - bw)}`],
        // left: outer L,B  outer L,T  inner L+lw,T+tw  inner L+lw,B-bw
        [bl, `${r(bxL)},${r(bxB)} ${r(bxL)},${r(bxT)} ${r(bxL + lw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxB - bw)}`],
      ];
      // Per-side `double` style — emit two parallel strokes each w/3 wide
      // separated by a w/3 gap (CSS spec). DM-436. Each side has its own
      // perpendicular axis, so we offset along the inward normal.
      const doubleSides: Array<[number, number, number, number]> = [
        // For each side, the [outerOffsetX, outerOffsetY, innerOffsetX, innerOffsetY]
        // expressed as multipliers of the side's own width applied to its centerline.
        // Top: inward normal is +y. Outer stroke at center - w/3, inner at center + w/3.
        [0, -1, 0, 1], // top: outer up (toward outer edge), inner down
        [-1, 0, 1, 0], // right: outer right (outer edge), inner left
        [0, 1, 0, -1], // bottom: outer down, inner up
        [1, 0, -1, 0], // left: outer left, inner right
      ];
      // DM-697: non-solid sides (double / dashed / dotted) need the same
      // diagonal-miter clip at corners that solid sides get from the
      // trapezoid emit. Per Blink's `BoxBorderPainter::PaintOneBorderSide`,
      // each side paints into a 4-point clip region whose corners run from
      // the border-box outer rect to the inner rect — i.e., the same
      // trapezoid shape we use for solid sides. Without it our `<line>`
      // strokes spill into adjacent sides' wedges and produce square
      // corners instead of the diagonal cut Chrome paints. Build a
      // clipPath per non-solid side and wrap its emission in it.
      const sideClipForStyle = (i: number, side: typeof bt) => {
        if (collapse || side == null || side.w <= 0) return "";
        const cid = `${idPrefix}bs${clipIdx++}`;
        defsParts.push(
          `<clipPath id="${cid}"><polygon points="${trapezoids[i][1]}"/></clipPath>`,
        );
        return ` clip-path="url(#${cid})"`;
      };
      // DM-686: border-radius + per-side borders. The trapezoids and lines
      // above hit the sharp outer-rect corners. When the element has a
      // non-zero border-radius, wrap the per-side emit in a clip-path that
      // is the rounded outer border-box, so each side's polygon / line is
      // trimmed to follow the radius arc instead of squaring off. Matches
      // Blink, which paints sides into the rounded border outline clip.
      const hasOuterRadius = !collapse && (corners.tl.h > 0 || corners.tl.v > 0
        || corners.tr.h > 0 || corners.tr.v > 0
        || corners.br.h > 0 || corners.br.v > 0
        || corners.bl.h > 0 || corners.bl.v > 0);
      // DM-773: when the box has rounded corners AND per-side mixed widths,
      // the legacy trapezoid + outer-outline-clip approach paints each side
      // as a straight rectangular strip clipped to the rounded outline. For
      // large radii (`border-radius: 50%` / circle case, or any corner whose
      // radius dominates the side's width) the rectangular strip sits
      // entirely OUTSIDE the rounded outline at most y values — the clip
      // erases the side, leaving only a thin sliver near the side's
      // midpoint. Chrome's `BoxBorderPainter` paints each side as a wedge
      // of the BORDER RING (outer outline minus inner outline) cut to the
      // side's diagonal-to-center quadrant; that approach is geometry-
      // correct for any radius. For solid sides we switch to that approach
      // here when there's a rounded corner; the non-solid branches keep
      // their existing line / double-stroke emit with the outer-outline
      // clip wrapping.
      const outerRoundedPath = hasOuterRadius
        ? roundedRectPath(bxL, bxT, bxR - bxL, bxB - bxT, corners)
        : "";
      const innerCornersForAnnular = hasOuterRadius
        ? insetCornerRadii(corners, tw, rw, bw, lw)
        : corners;
      const innerRoundedPath = hasOuterRadius
        ? roundedRectPath(
            bxL + lw, bxT + tw,
            Math.max(0, bxR - bxL - lw - rw), Math.max(0, bxB - bxT - tw - bw),
            innerCornersForAnnular,
          )
        : "";
      const annularPath = hasOuterRadius
        ? `${outerRoundedPath} ${innerRoundedPath}`
        : "";
      // DM-803: per-side wedge apex = intersection of the two adjacent
      // corner MITER lines (not box centre). Each corner's miter line goes
      // from the outer corner inward along direction (lw_at_that_corner,
      // tw_at_that_corner) — for uniform widths this gives a 45° diagonal
      // and all 4 apices land at the box centre (matching the old behaviour);
      // for mixed widths the diagonal tilts toward the thicker adjacent
      // side, shifting where the colour-transition between adjacent sides
      // lands on the rounded-corner arc. Matches Chromium's
      // `box_border_painter.cc` miter-line construction (`miter_line` from
      // `corner.outer.Outer()` to `corner.unadjusted_inner_edge`). Without
      // this shift, e.g. the 8/2/8/2 border on a 50%-radius ellipse paints
      // the top blue and bottom green arcs narrower than Chrome (because
      // 45° diagonals from the rectangle corners hit the ellipse closer to
      // the cardinal axes than the wider-top miter lines would).
      // DM-803: per-side wedge apex = intersection of the two adjacent
      // corner MITER lines (not box centre). For mixed widths the apex
      // tilts toward the thicker side, shifting where the colour-transition
      // between adjacent sides lands on the rounded-corner arc. Matches
      // Chromium's `box_border_painter.cc` `miter_line` construction —
      // without it e.g. the 8/2/8/2 border on a 50%-radius ellipse paints
      // the top blue and bottom green arcs narrower than Chrome.
      //
      // DM-917 / DM-918: when a side's own apex falls OUTSIDE the box rect,
      // the triangular wedge extends across the box and bleeds into the
      // opposite side's region. In that case `wedgePolygonPoints` falls
      // back to a 4-point polygon using the perpendicular pair of apex
      // points (clamped to box bounds) as the inner corners, which caps
      // the wedge at the adjacent-side meeting points instead.
      const apexes = computeWedgeApexes(bxL, bxT, bxR, bxB, tw, rw, bw, lw);
      const wedgeWidths = { tw, rw, bw, lw };
      const annularWedges: string[] = hasOuterRadius ? [
        wedgePolygonPoints("top",    bxL, bxT, bxR, bxB, apexes, wedgeWidths),
        wedgePolygonPoints("right",  bxL, bxT, bxR, bxB, apexes, wedgeWidths),
        wedgePolygonPoints("bottom", bxL, bxT, bxR, bxB, apexes, wedgeWidths),
        wedgePolygonPoints("left",   bxL, bxT, bxR, bxB, apexes, wedgeWidths),
      ] : [];
      // The outer-outline group still wraps the non-solid branches so their
      // straight `<line>` strokes get trimmed to the rounded outline at the
      // corners. Solid sides emit their own annular wedge BEFORE the group
      // opens (and use their own per-side wedge clip), so they fall outside
      // this wrapping — the wedge clip is tighter than the outer outline
      // anyway.
      let roundedSideGroupOpen = false;
      if (hasOuterRadius) {
        // Emit solid sides as annular wedges first.
        for (let i = 0; i < sides.length; i++) {
          const side = sides[i][0];
          if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
          if (side.style !== "solid") continue;
          const wid = `${idPrefix}bw${clipIdx++}`;
          defsParts.push(
            `<clipPath id="${wid}"><polygon points="${annularWedges[i]}"/></clipPath>`,
          );
          svgParts.push(
            `${indent}<path d="${annularPath}" fill="${colorStr(side.color)}" fill-rule="evenodd" clip-path="url(#${wid})"/>`,
          );
        }
        const rcid = `${idPrefix}br${clipIdx++}`;
        defsParts.push(
          `<clipPath id="${rcid}"><path d="${roundedRectPath(el.x, el.y, el.width, el.height, corners)}"/></clipPath>`,
        );
        svgParts.push(`${indent}<g clip-path="url(#${rcid})">`);
        roundedSideGroupOpen = true;
      }
      for (let i = 0; i < sides.length; i++) {
        const [side, x1, y1, x2, y2, len] = sides[i];
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style === "none" || side.style === "hidden") continue;
        if (useTrapezoid(side)) {
          // DM-773: solid sides with rounded corners already emitted as
          // annular wedges above (geometry-correct for any radius). Skip
          // the legacy trapezoid emit so we don't double-paint.
          if (hasOuterRadius) continue;
          // Emit as a polygon trapezoid that tapers correctly at corners.
          svgParts.push(
            `${indent}<polygon points="${trapezoids[i][1]}" fill="${colorStr(side.color)}" />`,
          );
          continue;
        }
        if (side.style === "double" && side.w >= 3) {
          // Two parallel strokes, each w/3 wide, separated by a w/3 gap.
          // Outer stroke center sits at (sideCenter + outerNormal * w/3),
          // inner at (sideCenter + innerNormal * w/3). Each stroke = w/3 thick.
          // DM-689: works in both collapse and non-collapse modes — the
          // `(x1, y1) → (x2, y2)` side endpoints are already collapse-aware
          // upstream (inset=0 puts the side centerline ON the cell's grid
          // edge in collapse mode), so adding the ±w/3 perpendicular
          // offsets lands the outer stroke 1/3 of the way past the edge
          // and the inner stroke 1/3 of the way inside — matching Blink's
          // `CollapsedBorderPainter::PaintCollapsedDoubleBorder`.
          const strokeW = side.w / 3;
          const offset_ = side.w / 3;
          const [oxN, oyN, ixN, iyN] = doubleSides[i];
          const ox = oxN * offset_, oy = oyN * offset_;
          const ix = ixN * offset_, iy = iyN * offset_;
          const clipAttr = sideClipForStyle(i, side);
          svgParts.push(
            `${indent}<line x1="${r(x1 + ox)}" y1="${r(y1 + oy)}" x2="${r(x2 + ox)}" y2="${r(y2 + oy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
          );
          svgParts.push(
            `${indent}<line x1="${r(x1 + ix)}" y1="${r(y1 + iy)}" x2="${r(x2 + ix)}" y2="${r(y2 + iy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
          );
          continue;
        }
        const { array: dash, offset } = adjustedDashAttrs(side.style, side.w, len);
        // Dotted uses `0.01 period` dasharray that needs round linecaps to
        // render as circles (DM-399). Chromium'\\'s BoxBorderPainter draws
        // dotted as "0 length dash strokes and round endcaps, producing
        // circles" (verified via Chromium source). Dashed keeps default
        // butt caps so the dash:gap ratio paints flat-ended rectangles.
        const linecap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
        const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
        const clipAttr = sideClipForStyle(i, side);
        svgParts.push(
          `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dashAttrs}${linecap}${clipAttr} />`,
        );
      }
      if (roundedSideGroupOpen) svgParts.push(`${indent}</g>`);
    } else if (borderWidth > 0 && borderColor != null && borderColor.a > 0.01) {
      // Legacy path for elements whose per-side captures weren't parsed cleanly.
      svgParts.push(
        `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="none" stroke="${colorStr(borderColor)}" stroke-width="${r(borderWidth)}"`)}`,
      );
    }
    if (notchedBorderOpen) svgParts.push(`${indent}</g>`);

    // Outline (SK-1111): drawn outside the border-box and shifted further out
    // by outline-offset (which can be negative). Doesn't take layout space —
    // the captured rect is the border-box, so we inflate from that. Outline
    // styles (solid / dashed / dotted) reuse dashArrayForStyle.
    svgParts.push(...paintOutline(el, borderRadius, indent));

    // Inline SVG. The captured outerHTML preserves the source attributes,
    // including viewBox, but inline SVGs in the wild often omit width/height
    // (size is set by CSS on the element, e.g. width: 16px). Without explicit
    // width/height on the <svg> tag, browsers fall back to the 300x150 SVG
    // default, which produces giant rendering when we re-embed it. Inject
    // width/height from the captured rect so the SVG renders at its actual
    // on-page size.
    if (el.svgContent != null) {
      // The captured `el.x / el.y / el.width / el.height` are border-box
      // coords. The SVG draws into the CONTENT-BOX (CSS box-sizing default
      // for `<svg>` is content-box), so the actual paint area sits inside
      // the element's border. Without subtracting border + padding from
      // the translate offset, our SVG content paints 1-2 px up + left of
      // where Chrome paints it (DM-416). Subtract the left/top border +
      // padding so the SVG'\\'s (0, 0) lands at the content-box top-left.
      const blW = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const btW = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const plW = parseFloat(el.styles.paddingLeft ?? "0") || 0;
      const ptW = parseFloat(el.styles.paddingTop ?? "0") || 0;
      const contentW = Math.max(0, el.width - blW - (parseFloat(el.styles.borderRightWidth ?? "0") || 0) - plW - (parseFloat(el.styles.paddingRight ?? "0") || 0));
      const contentH = Math.max(0, el.height - btW - (parseFloat(el.styles.borderBottomWidth ?? "0") || 0) - ptW - (parseFloat(el.styles.paddingBottom ?? "0") || 0));
      // DM-499: hidden defs SVGs (style="position:absolute;width:0;height:0")
      // capture as 0×0 elements. Without this guard, `injectSvgSize` returns
      // the markup unchanged (its w<=0 / h<=0 short-circuit), the SVG falls
      // back to its 300×150 default viewport, and the defs contents paint
      // visibly in the output. Skip emission for 0×0 host elements — the
      // consumer-side `<use>` resolver has already inlined whatever the defs
      // SVG was holding into each consumer.
      if (contentW <= 0 || contentH <= 0) {
        if (animClass !== "") svgParts.push(`${indent}</g>`);
        if (opened) svgParts.push(`${indent}</g>`);
        if (needsFilterOuter) svgParts.push(`${indent}</g>`);
        return;
      }
      const sized = injectSvgSize(el.svgContent, contentW, contentH);
      // Inline SVG icons commonly use `fill="currentColor"` / `stroke="currentColor"`
      // so the icon picks up the button's text color. Set the wrapping group's
      // CSS `color` to the captured text color so currentColor resolves to
      // what Chrome painted, not the SVG document root's default black. DM-279.
      const iconColor = el.styles.color != null && el.styles.color !== "" ? el.styles.color : "currentColor";
      svgParts.push(`${indent}<g transform="translate(${r(el.x + blW + plW)}, ${r(el.y + btW + ptW)})" color="${iconColor}">${sized}</g>`);
      // Close the wrappers opened above (animClass + opacity/transform/clip/mask
      // group, plus the DM-704 filter-outer wrapper when present). Without
      // these closes, an inline-SVG element with `opacity < 1` (or any other
      // group-triggering style) emits an unbalanced `<g>` and breaks the
      // document — observable on resend/stripe whose nav chevrons sit
      // inside `opacity: 0.7` wrappers.
      if (animClass !== "") svgParts.push(`${indent}</g>`);
      if (opened) svgParts.push(`${indent}</g>`);
      if (needsFilterOuter) svgParts.push(`${indent}</g>`);
      return;
    }

    // Form control chrome (checkbox, radio, range, color, progress, meter,
    // select chevron, details disclosure). Paints on top of the element's
    // bg/border so the UA-default visuals are synthesized where the bare
    // capture missed them. Styled controls (author-set background/border)
    // still look like bare rects — the common case where authors match
    // Chromium defaults is handled here.
    const fc = renderFormControl(el, indent, defCtx);
    if (fc !== "") svgParts.push(fc);

    // Broken-image fallback (DM-372): when the img failed to load (or has
    // empty src), Chrome paints a small broken-image placeholder icon plus
    // the alt text in the host font. We approximate the icon with a 16×16
    // outlined box containing a small triangle (mountain glyph) — close
    // enough to Chrome's stock broken-image icon — and emit the alt text
    // as an inline <text> right after the icon.
    if (el.tag === "img" && el.imageBroken === true) {
      const ix = el.x;
      const iy = el.y;
      const iconSize = 16;
      const iconX = ix + 1;
      const iconY = iy + 1;
      // Icon: a rectangle with a tiny mountain inside (Chrome's broken-image
      // icon is more elaborate but a simple framed mountain is recognizable).
      svgParts.push(`${indent}<rect x="${r(iconX)}" y="${r(iconY)}" width="${iconSize - 2}" height="${iconSize - 2}" fill="none" stroke="rgb(128,128,128)" stroke-width="1" />`);
      svgParts.push(`${indent}<polyline points="${r(iconX + 2)},${r(iconY + iconSize - 4)} ${r(iconX + 5)},${r(iconY + iconSize / 2)} ${r(iconX + 8)},${r(iconY + iconSize - 6)} ${r(iconX + 12)},${r(iconY + iconSize - 4)}" fill="none" stroke="rgb(128,128,128)" stroke-width="0.8" />`);
      // Alt text emitted next to the icon. Use the element's font / color.
      if (el.imageAlt != null && el.imageAlt !== "") {
        const fontSizePx = parseFloat(el.styles.fontSize) || 14;
        const tx = ix + iconSize + 4;
        const ty = iy + Math.min(iconSize - 2, fontSizePx);
        const fillCol = textColor != null ? colorStr(textColor) : "rgb(0,0,0)";
        const escAlt = el.imageAlt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        svgParts.push(`${indent}<text x="${r(tx)}" y="${r(ty)}" font-size="${r(fontSizePx)}" font-family="${esc(el.styles.fontFamily)}" fill="${fillCol}">${escAlt}</text>`);
      }
    } else
    // Image (<img> or <input type="image">)
    if (el.imageSrc != null && (el.tag === "img" || (el.tag === "input" && el.styles.inputType === "image"))) {
      const _img = paintImage(el, borderRadius, corners, idPrefix, indent, clipIdx);
      svgParts.push(..._img.svg); defsParts.push(..._img.defs); clipIdx = _img.clipIdx;
    }

    // Rasterized snapshot for <canvas> / <video> / <iframe> / <object> /
    // <embed> (DM-457; DM-598 guards against double-paint when an <img> also
    // carries a snapshot). See paintRasterSnapshot for the full rationale.
    svgParts.push(...paintRasterSnapshot(el, indent));

    // List marker — render list-style-image at the marker position for <li>
    // elements. Per CSS spec, the marker image paints at its INTRINSIC size
    // (not scaled to fontSize). The li's own height is stretched by Chromium
    // to accommodate the marker, which means el.height for a large-image
    // marker is big — we position the marker vertically centered in the first
    // line box (top of li) and let it overflow left for outside markers.
    // <summary> has UA `display: list-item` with list-style-type
    // `disclosure-closed`/`disclosure-open` — those are painted by the
    // renderDetailsMarker pipeline on the <details> parent (DM-448), so
    // skip the generic list-item marker here to avoid double-painting.
    //
    // DM-597: marker paints when the element's `display` is `list-item` —
    // NOT just because the tag is `<li>`. Slashdot's social-icon strip uses
    // `<li>` with `display: inline-block` (no marker per CSS spec). The
    // previous `tag === "li" || ...` check painted spurious bullets in
    // front of every social icon.
    svgParts.push(...paintListMarker(el, textColor, indent));

    // CSS paint order: floats paint AFTER block descendants but BEFORE the
    // parent's inline content. The "inline content" here is `el.text` — when
    // a paragraph has a `float: left` span followed by text and the span's
    // `shape-outside` lets text wrap into the float's bounding box, the text
    // should paint ON TOP of the float (not be covered by it).
    //
    // Only hoist floats when this element actually has its own text. If we
    // hoisted floats unconditionally, a parent like `<main>` whose children
    // are all blocks (search/article/figure) plus a float (aside) would
    // paint the aside FIRST and then the block siblings would cover it.
    // Letting the float fall through to the normal child sort puts it last
    // (= on top of preceding block siblings) — matching Chrome for that case.
    const hasOwnText = el.text !== "";
    const floatChildren: CapturedElement[] = [];
    const nonFloatChildren: CapturedElement[] = [];
    if (hasOwnText) {
      for (const c of el.children) {
        const flt = c.styles.float ?? "none";
        const pos = c.styles.position;
        const positioned = pos != null && pos !== "static";
        if (!positioned && flt !== "none") floatChildren.push(c);
        else nonFloatChildren.push(c);
      }
      for (const child of floatChildren) {
        renderElement(child, depth + 1, el.styles.display);
      }
    }

    // Pseudo-element image content (::before / ::after with content: url(...)).
    // CSS atomic-inline-box paint order: the ::before's replaced-element box
    // paints BEFORE the parent's main-text inline content in the same line,
    // so subsequent text appears on top of any image overflow. Painting after
    // text put our SVG circles ON TOP of the paragraph in the 24-generated-content
    // fixture (DM-440 user feedback: 'z-index of svg is wrong'). Move the
    // emit ahead of the text block so text reliably wins z.
    if (el.pseudoImages != null) {
      for (const pi of el.pseudoImages) {
        svgParts.push(`${indent}<image href="${esc(embedResizedDataUri(pi.url, pi.width, pi.height))}" x="${r(pi.x)}" y="${r(pi.y)}" width="${r(pi.width)}" height="${r(pi.height)}" preserveAspectRatio="xMidYMid meet" />`);
      }
    }
    // Box-only pseudo-elements (DM-579): empty-content `::before` / `::after`
    // with non-zero borders or background act as decorative separators /
    // overlays. Capture pass records their effective rect + per-side
    // borders; we emit one `<rect>` for the background fill (if any) plus
    // up to four `<line>`s for the visible border sides. Per-side colors /
    // widths can differ so we can't collapse them into a single
    // stroke="..." attribute the way the regular-element border path does.
    if (el.pseudoBoxes != null) {
      for (const pb of el.pseudoBoxes) {
        // DM-1001: defer the FADE-OVERLAY `::after` pattern to AFTER all
        // descendant rendering so it paints on top of child text — NYT's
        // right-edge headline fade is `::after { background: linear-gradient
        // (transparent, white) }` on the carousel container; emitting it
        // here put the fade UNDER the inner headline text. Heuristic for
        // "this is a fade overlay, not a decorative caret / divider": the
        // box carries a backgroundImage (so it has a gradient or url() to
        // paint) AND has no own background color / borders (a real caret
        // would have a backgroundColor or per-side border to draw its
        // shape). Decorative pseudoBoxes (carets, dividers, dots) keep
        // the previous in-place emit so vertical-align caret placement
        // (`pseudo-after-down-caret-vertical-align`) stays correct.
        if (pb.pseudo === "::after") {
          const hasBgImage = pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "";
          const hasBgColor = pb.backgroundColor != null && pb.backgroundColor !== "" && pb.backgroundColor !== "rgba(0, 0, 0, 0)";
          const hasBorder = (pb.borderTopWidth ?? 0) > 0
            || (pb.borderRightWidth ?? 0) > 0
            || (pb.borderBottomWidth ?? 0) > 0
            || (pb.borderLeftWidth ?? 0) > 0;
          // DM-1051: a NEGATIVE z-index gradient `::after` is NOT a fade
          // overlay — it paints BEHIND the host's content (Resend's
          // `.rainbow-border::after` glow is `z-index: -10; filter: blur(20px)`,
          // a soft halo behind the dark pill). Don't defer it to the on-top
          // pass; emit it here in the early loop so it lands behind the child
          // dark fill. Only the auto / non-negative fade overlays defer.
          const paintsBehind = pb.zIndex != null && pb.zIndex < 0;
          if (hasBgImage && !hasBgColor && !hasBorder && !paintsBehind) continue;
        }
        // DM-783: snapshot svgParts.length so we can wrap THIS pb's emit in
        // a `<g transform="…">` when pb.transform is present. The wrap pre-
        // bakes the rotation/scale around the captured transform-origin so
        // a rotate(45deg) on a `::before { border-right; border-bottom }`
        // paints as a check-mark instead of a backwards-L (the rotation
        // pivots around the box center, not the origin). When pb.transform
        // is absent we splice nothing — the loop body's pushes flow through
        // unchanged.
        const pbStart = svgParts.length;
        if (pb.backgroundColor) {
          const rxAttr = pb.borderRadius && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}"` : "";
          svgParts.push(`${indent}<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="${pb.backgroundColor}" />`);
        }
        // DM-767: pseudoBox background-image (linear-/radial-gradient).
        // Emit each comma-separated layer in reverse order so layer 0 (first
        // in CSS source) ends up on top — same convention as the regular-
        // element background-image path. Each layer goes through
        // `buildBackgroundLayerDef` to produce an SVG paint server, then a
        // covering `<rect>` references it.
        if (pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "") {
          const pbLayers = splitTopLevelCommas(pb.backgroundImage);
          for (let li = pbLayers.length - 1; li >= 0; li--) {
            const layer = pbLayers[li].trim();
            const defId = `${idPrefix}pbg${clipIdx++}`;
            const out = buildBackgroundLayerDef(
              defId, layer, pb.x, pb.y, pb.width, pb.height,
              pb.backgroundSize ?? "auto", pb.backgroundPosition ?? "0% 0%", "repeat", null, "scroll", captureViewport,
            );
            if (out.def === "") continue;
            defsParts.push(out.def);
            const rxAttr = pb.borderRadius && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}"` : "";
            svgParts.push(`${indent}<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="url(#${defId})" />`);
          }
        }
        // CSS triangle: 0×0 box with one solid border and adjacent borders
        // transparent / zero. Borders meet at 45° corners and visually form
        // a right triangle in the solid color. Detect + emit as <polygon>
        // since per-side <line> emission would draw a stub the wrong shape.
        const isOpaque = (c?: string): boolean =>
          c != null && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" && !/^rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*0\s*\)/i.test(c);
        const bwT = pb.borderTopWidth ?? 0;
        const bwR = pb.borderRightWidth ?? 0;
        const bwB = pb.borderBottomWidth ?? 0;
        const bwL = pb.borderLeftWidth ?? 0;
        const opaqueSides = [
          bwT > 0 && isOpaque(pb.borderTopColor),
          bwR > 0 && isOpaque(pb.borderRightColor),
          bwB > 0 && isOpaque(pb.borderBottomColor),
          bwL > 0 && isOpaque(pb.borderLeftColor),
        ];
        const opaqueCount = opaqueSides.filter((s) => s).length;
        const totalBorderCount = [bwT, bwR, bwB, bwL].filter((w) => w > 0).length;
        // The content area (inside borders) collapses to ≤ 1px when borders
        // sum across the dimension to ≥ box dim. That's the CSS triangle
        // pattern. If the content area is non-trivial it's a normal box
        // and we'd want per-side <line> emission instead.
        const contentW = pb.width - bwL - bwR;
        const contentH = pb.height - bwT - bwB;
        const isTriangle = opaqueCount === 1
          && totalBorderCount >= 2
          && contentW <= 1 && contentH <= 1;
        if (isTriangle) {
          // Identify the solid side and compute the triangle vertices.
          // Outer-box corners: (x,y), (x+w,y), (x+w,y+h), (x,y+h).
          // The solid-border side's outer edge contributes two corners; the
          // apex is the opposite-side outer corner where the adjacent
          // transparent borders meet at 45°.
          const X = pb.x;
          const Y = pb.y;
          const W = pb.width;
          const H = pb.height;
          let pts: Array<[number, number]> = [];
          let color = "";
          if (opaqueSides[0]) {
            // Top solid: triangle pointing DOWN. The visible trapezoid
            // collapses to a triangle when content collapses; apex is the
            // inner-bottom corner where borderRight + borderLeft meet.
            // With our 0×0 case, apex = (bwL, H) so the triangle is
            // (0,0) → (W,0) → (bwL, H). But for symmetric tail (left=right
            // borders equal), apex = (W/2, H). We use bwL when borders
            // differ.
            pts = [[X, Y], [X + W, Y], [X + bwL, Y + H]];
            color = pb.borderTopColor!;
          } else if (opaqueSides[1]) {
            pts = [[X + W, Y], [X + W, Y + H], [X + W - bwR, Y + bwT]];
            color = pb.borderRightColor!;
          } else if (opaqueSides[2]) {
            pts = [[X + W, Y + H], [X, Y + H], [X + W - bwR, Y + H - bwB]];
            color = pb.borderBottomColor!;
          } else if (opaqueSides[3]) {
            pts = [[X, Y + H], [X, Y], [X + bwL, Y + bwT]];
            color = pb.borderLeftColor!;
          }
          if (pts.length === 3 && color !== "") {
            const polyPts = pts.map((p) => `${r(p[0])},${r(p[1])}`).join(" ");
            svgParts.push(`${indent}<polygon points="${polyPts}" fill="${color}" />`);
          }
          flushPbTransformWrap();
          continue;
        }
        // DM-765: when all four borders are uniform AND the pseudo has a
        // non-zero border-radius (e.g. the `.dot::before { width: 8px;
        // height: 8px; border: 2px solid; border-radius: 50% }` chip in
        // `24-deep-pseudo-shapes`), the four straight `<line>` strokes
        // would form a SQUARE outline around the rounded background fill,
        // making a green-square-with-darker-square instead of the
        // green-circle-with-darker-ring Chrome paints. Emit a single
        // stroked `<rect rx>` in that case so the outline follows the
        // background's curve.
        const uniformBorder = bwT > 0 && bwT === bwR && bwR === bwB && bwB === bwL
          && pb.borderTopColor != null
          && pb.borderTopColor === pb.borderRightColor
          && pb.borderRightColor === pb.borderBottomColor
          && pb.borderBottomColor === pb.borderLeftColor
          && (pb.borderTopStyle == null || pb.borderTopStyle === pb.borderRightStyle);
        if (uniformBorder && pb.borderRadius != null && pb.borderRadius > 0 && isOpaque(pb.borderTopColor)) {
          const style = pb.borderTopStyle ?? "solid";
          if (style !== "none" && style !== "hidden") {
            const w = bwT;
            const half = w / 2;
            // Inset the stroke rect by half the stroke width so the stroke
            // sits entirely inside the box (matches CSS, where borders paint
            // inside the border box).
            const sx = pb.x + half;
            const sy = pb.y + half;
            const sw = Math.max(0, pb.width - w);
            const sh = Math.max(0, pb.height - w);
            const sr = Math.max(0, pb.borderRadius - half);
            const dash = style === "dashed" ? ` stroke-dasharray="${r(w * 2)},${r(w * 2)}"` : style === "dotted" ? ` stroke-dasharray="${r(w)},${r(w)}"` : "";
            svgParts.push(`${indent}<rect x="${r(sx)}" y="${r(sy)}" width="${r(sw)}" height="${r(sh)}" rx="${r(sr)}" fill="none" stroke="${pb.borderTopColor}" stroke-width="${r(w)}"${dash} />`);
            flushPbTransformWrap();
            continue;
          }
        }
        // Per-side borders. Each painted side gets one <line> across the
        // appropriate edge. For h=0 / w=0 boxes this collapses to a single
        // visible hairline — the separator case.
        const side = (
          x1: number, y1: number, x2: number, y2: number,
          width: number | undefined, color: string | undefined, style: string | undefined,
        ): void => {
          if (!width || width <= 0 || !color || color === "rgba(0, 0, 0, 0)" || color === "transparent") return;
          if (style === "none" || style === "hidden") return;
          const dash = style === "dashed" ? ` stroke-dasharray="${r(width * 2)},${r(width * 2)}"` : style === "dotted" ? ` stroke-dasharray="${r(width)},${r(width)}"` : "";
          svgParts.push(`${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${color}" stroke-width="${r(width)}"${dash} />`);
        };
        side(pb.x, pb.y + (pb.borderTopWidth ?? 0) / 2, pb.x + pb.width, pb.y + (pb.borderTopWidth ?? 0) / 2, pb.borderTopWidth, pb.borderTopColor, pb.borderTopStyle);
        side(pb.x + pb.width - (pb.borderRightWidth ?? 0) / 2, pb.y, pb.x + pb.width - (pb.borderRightWidth ?? 0) / 2, pb.y + pb.height, pb.borderRightWidth, pb.borderRightColor, pb.borderRightStyle);
        side(pb.x, pb.y + pb.height - (pb.borderBottomWidth ?? 0) / 2, pb.x + pb.width, pb.y + pb.height - (pb.borderBottomWidth ?? 0) / 2, pb.borderBottomWidth, pb.borderBottomColor, pb.borderBottomStyle);
        side(pb.x + (pb.borderLeftWidth ?? 0) / 2, pb.y, pb.x + (pb.borderLeftWidth ?? 0) / 2, pb.y + pb.height, pb.borderLeftWidth, pb.borderLeftColor, pb.borderLeftStyle);
        // DM-783: wrap whatever this iteration emitted (rect / lines /
        // polygon / per-side strokes) in a `<g transform="…">` that pre-
        // bakes the rotation/scale around the captured transform-origin.
        // Defined inline here so it closes over `pb` and `svgParts` /
        // `pbStart` from the outer scope.
        function flushPbTransformWrap() {
          const hasTransform = pb.transform != null && pb.transform !== "" && pb.transform !== "none";
          // DM-1051: translate a `blur(<px>)` filter into an SVG feGaussianBlur.
          // CSS `blur(r)` uses r as the Gaussian standard deviation directly
          // (Filter Effects §4.4), so stdDeviation = the captured px value.
          const blurMatch = pb.filter != null ? /\bblur\(\s*([\d.]+)px\s*\)/.exec(pb.filter) : null;
          const blurStd = blurMatch != null ? parseFloat(blurMatch[1]) : null;
          // DM-1121: a `<g opacity>` wrap also counts as needing a flush so a
          // dimmed pseudo (e.g. a 45%-opacity glow) paints translucent.
          const hasOpacity = pb.opacity != null && pb.opacity < 1;
          if (!hasTransform && !hasOpacity && (blurStd == null || !(blurStd > 0))) return;
          const added = svgParts.splice(pbStart);
          if (added.length === 0) return;
          // The inner emits were already indented; we keep the same
          // indent for the wrapper and strip leading indent from each
          // inner part so the wrapping `<g>` doesn't double-indent.
          let inner = added.map((s) => s.startsWith(indent) ? s.slice(indent.length) : s).join("");
          // Blur is applied in the pseudo's own coordinate space (before its
          // transform scales the result), so the filter `<g>` nests INSIDE the
          // transform `<g>`. The filter region is generously over-sized so a
          // 20px blur on a short pill isn't clipped at the default -10%..110%.
          if (blurStd != null && blurStd > 0) {
            const fid = `${idPrefix}pbf${clipIdx++}`;
            defsParts.push(`<filter id="${fid}" x="-100%" y="-300%" width="300%" height="700%"><feGaussianBlur stdDeviation="${r(blurStd)}" /></filter>`);
            inner = `<g filter="url(#${fid})">${inner}</g>`;
          }
          if (hasTransform) {
            // transform-origin: resolved to px values relative to the
            // pseudo's box top-left (Chrome's getComputedStyle normalises
            // keywords / % to px). Default = box center (`50% 50%`).
            let ox = pb.width / 2;
            let oy = pb.height / 2;
            if (pb.transformOrigin != null && pb.transformOrigin !== "") {
              const oParts = pb.transformOrigin.split(/\s+/).map((p) => parseFloat(p));
              if (oParts.length >= 2 && Number.isFinite(oParts[0]) && Number.isFinite(oParts[1])) {
                ox = oParts[0]; oy = oParts[1];
              }
            }
            const tx = pb.x + ox;
            const ty = pb.y + oy;
            inner = `<g transform="translate(${r(tx)} ${r(ty)}) ${pb.transform} translate(${r(-tx)} ${r(-ty)})">${inner}</g>`;
          }
          // Opacity wraps OUTERMOST so it dims the transformed/blurred result as
          // a whole (matching how CSS `opacity` groups the pseudo's painting).
          if (hasOpacity) inner = `<g opacity="${Number(pb.opacity!.toFixed(2))}">${inner}</g>`;
          svgParts.push(`${indent}${inner}`);
        }
        flushPbTransformWrap();
      }
    }

    // Text rendering — delegated to text-renderer.ts based on configured mode
    if (el.text !== "") {
      // DM-462: `background-clip: text` + `-webkit-text-fill-color: transparent`
      // (or `color: transparent`) makes the bg-image paint inside the glyph
      // shapes — the gradient-headline pattern. When detected, swap the text
      // fill from the regular color to the gradient's def URL captured from
      // the text-clipped bg layer above. We honor this when the rendered text
      // is actually transparent (text-fill-color or color is alpha-zero); if
      // the author left text-fill-color opaque we just paint the color, which
      // is what Chrome would paint on top of the (clipped) gradient anyway.
      const tfcRaw = el.styles.webkitTextFillColor;
      const tfc = tfcRaw != null ? parseColor(tfcRaw) : null;
      const textIsTransparent = (tfc != null ? tfc.a < 0.01 : (textColor != null && textColor.a < 0.01));
      // Topmost text-clipped layer is the visible color over the glyphs when
      // we fall into the non-mask path; in the mask path below ALL layers
      // composite (DM-696). Find the topmost (lowest li) non-empty entry.
      // DM-749: when this element has no text-bg-clip layers of its own but
      // an ancestor has `background-clip: text` + a gradient (the Stripe
      // hds-heading pattern — span with gradient + bg-clip:text wraps a
      // child div with the actual text), build a gradient def from the
      // captured `inheritedTextFillGradient` and use it as the fill.
      let topmostTextBgClipFill = textBgClipFills.find((s) => s != null) ?? null;
      if (topmostTextBgClipFill == null && textIsTransparent && el.styles.inheritedTextFillGradient != null && el.styles.inheritedTextFillGradient !== "" && el.styles.inheritedTextFillGradient !== "none") {
        const layer = el.styles.inheritedTextFillGradient;
        const defId = `${idPrefix}bg${clipIdx++}`;
        // DM-908: resolve the gradient against the ANCESTOR's bbox (the
        // element that set `background-clip: text`), not this child's
        // bbox. Falling back to (el.x, el.y, el.width, el.height) for
        // legacy captures missing the new field would produce the
        // pre-fix behaviour where each child re-runs the gradient over
        // its own (smaller) area.
        const r = el.styles.inheritedTextFillGradientRect;
        const gx = r != null ? r.x : el.x;
        const gy = r != null ? r.y : el.y;
        const gw = r != null ? r.width : el.width;
        const gh = r != null ? r.height : el.height;
        const out = buildBackgroundLayerDef(defId, layer, gx, gy, gw, gh, "auto", "0% 0%", "no-repeat", null, "scroll", captureViewport);
        if (out.def !== "") {
          defsParts.push(out.def);
          topmostTextBgClipFill = `url(#${defId})`;
        }
      }
      const fillColor = (topmostTextBgClipFill != null && textIsTransparent)
        ? topmostTextBgClipFill
        : (textColor != null ? colorStr(textColor) : "#e6edf3");
      const cid = `${idPrefix}ct${clipIdx++}`;
      defsParts.push(`<clipPath id="${cid}"><rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" /></clipPath>`);

      // SK-1128: writing-mode != horizontal-tb activates the same element-
      // raster path used for textareas (SK-1108). The text region is
      // screenshotted via Playwright and stamped as <image>, bypassing the
      // path pipeline entirely. character-by-character rotation logic for
      // text-orientation: mixed (CJK upright vs Latin sideways) is a lot
      // more involved than the work we get from a faithful raster of what
      // Chrome painted, and the test corpus has only one vertical-mode
      // case for now.
      if (el.elementRaster != null && el.elementRaster.dataUri != null
          && el.styles.writingMode != null && el.styles.writingMode !== "horizontal-tb") {
        const er = el.elementRaster;
        // DM-957: the elementRaster rect was expanded outward in
        // `computeElementRaster` (DM-936) to capture the vertical-mode
        // text-decoration underlines that paint just outside the inline
        // content box. The default `cid` clip-path here is the element's
        // content rect (el.x / el.y / el.width / el.height) — which is
        // NARROWER than the captured screenshot, so the underline pixels
        // inside the expansion margin get CLIPPED OFF. Mint a dedicated
        // clip-path matching the expanded er rect so the screenshot
        // renders intact (the screenshot is already pixel-faithful to
        // Chrome's paint within its own clip; no need to re-clip here).
        const erCid = `${idPrefix}ct${clipIdx++}`;
        defsParts.push(`<clipPath id="${erCid}"><rect x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" /></clipPath>`);
        svgParts.push(`${indent}<image href="${er.dataUri}" x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${erCid})"/>`);
      } else {

      // DM-782: pseudoBox gradient/url() emitter. The text renderer can't
      // own defsParts / clipIdx (those live in the element-tree render loop)
      // so we hand it a closure that produces the gradient layer rects +
      // appends each layer's `<linearGradient>` / `<radialGradient>` paint
      // server to defsParts. Same emit shape as the empty-content pseudoBox
      // path below — comma-separated layers walked in reverse so layer 0
      // (first in CSS source) ends up on top.
      const emitPseudoBoxBgLayers = (pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number }): string => {
        const layers = splitTopLevelCommas(pb.backgroundImage);
        const out: string[] = [];
        for (let li = layers.length - 1; li >= 0; li--) {
          const layer = layers[li].trim();
          const defId = `${idPrefix}pbgt${clipIdx++}`;
          const built = buildBackgroundLayerDef(
            defId, layer, pb.x, pb.y, pb.width, pb.height,
            "auto", "0% 0%", "repeat", null, "scroll", captureViewport,
          );
          if (built.def === "") continue;
          defsParts.push(built.def);
          const rxAttr = pb.borderRadius != null && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}" ry="${r(pb.borderRadius)}"` : "";
          out.push(`<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="url(#${defId})" />`);
        }
        return out.join("");
      };
      const renderOneText = (opts: { el: CapturedElement; idPrefix: string; clipId: string; fillColor: string; overflowClip?: boolean }): string => {
        // DM-1029: time all text rendering (font resolution + shaping + glyph
        // outline / embedded-font build + markup) per element. The helper
        // `spawnSync` time accumulated separately is a sub-component of this;
        // `text − helper` is the in-process text cost. No-op unless DEMO_TIMING.
        const _tText = profNow();
        try {
        const optsWithEmit = { ...opts, emitPseudoBoxBgLayers };
        const hasMultipleSegments = opts.el.textSegments != null && opts.el.textSegments.length > 1;
        const isMultiLine = opts.el.text.includes("\n");
        // DM-990: vertical writing-mode dispatch BEFORE any other
        // branch. Vertical segments carry their per-char positions in
        // `yOffsets` (not `xOffsets`) and need per-char rotation for
        // text-orientation: mixed / sideways — the horizontal renderers
        // would mis-paint them along the wrong axis.
        if (hasVerticalSegments(opts.el)) return renderVerticalSegments(opts.el, opts.fillColor);
        // DM-799: input/textarea dispatch must come BEFORE the multi-line
        // branch. A textarea with newline-bearing value (`\n` in `el.text`)
        // would otherwise hit `renderMultiLineText`, which path-renders each
        // source line without word-wrap — Lorem-ipsum lines overflowed the
        // textarea's right edge instead of being painted from the captured
        // `elementRaster` PNG (which carries Chrome's own wrapping).
        if (opts.el.tag === "input" || opts.el.tag === "textarea") return renderInputText(optsWithEmit);
        if (hasMultipleSegments) return renderMultiSegmentText(optsWithEmit, opts.el.textSegments!);
        if (isMultiLine) return renderMultiLineText(optsWithEmit);
        return renderSingleLineText(optsWithEmit);
        } finally {
          profAccum("text-render", profNow() - _tText);
        }
      };

      // text-shadow (SK-1113): render each shadow as a recolored copy of
      // the same text, shifted by the shadows (x, y) and wrapped in a
      // Gaussian-blur filter when blur > 0. Shadows paint UNDER the main
      // text, with the FIRST listed shadow CLOSEST to the text — so emit
      // in REVERSE order (deepest first). Each shadow uses a fake element
      // with x/y shifted in place of the original; the renderers anchor
      // off el.textLeft/el.textTop/segment.x/y so this is enough to move
      // every glyph by the same delta.
      const textShadows = parseBoxShadow(el.styles.textShadow ?? "none");
      for (let si = textShadows.length - 1; si >= 0; si--) {
        const sh = textShadows[si];
        if (sh.inset) continue; // text-shadow has no inset; defensive
        const shadowFillColor = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
        const shifted: CapturedElement = {
          ...el,
          x: el.x + sh.x,
          y: el.y + sh.y,
          textLeft: el.textLeft != null ? el.textLeft + sh.x : undefined,
          textTop: el.textTop != null ? el.textTop + sh.y : undefined,
          textSegments: el.textSegments?.map((s) => ({
            ...s,
            x: s.x + sh.x,
            y: s.y + sh.y,
            xOffsets: s.xOffsets?.map((v) => v + sh.x),
            // The shadow shouldnt double-stamp emoji/raster overlays —
            // those already carry their own pixel-baked color and shifting
            // them paints the same emoji again. Drop them on the shadow
            // copy so only the path text gets shadowed.
            rasterRect: undefined,
            rasterDataUri: undefined,
            rasterGlyphs: undefined,
          })),
        };
        let body = renderOneText({ el: shifted, idPrefix, clipId: cid, fillColor: shadowFillColor });
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}tsh${clipIdx++}`;
          defsParts.push(
            `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
          );
          body = `<g filter="url(#${fid})">${body}</g>`;
        }
        svgParts.push(`${indent}${body}`);
      }
      // DM-993: per-segment text-shadow (DM-989 follow-up). When a styled
      // segment carries its own `seg.textShadow` (the DM-989 ::first-letter
      // pipeline captures this from the pseudo's computed text-shadow when
      // it differs from the host's), emit a shadow copy of JUST that
      // segment. Same shifted-and-recolored pattern as the element-level
      // loop above, but rendered with `renderMultiSegmentText([oneSeg])`
      // so only the target segment paints in shadow color — the rest of
      // the body text stays unshadowed (Chrome's cascade for
      // `::first-letter` overrides the parent's text-shadow only on the
      // selection chars).
      if (el.textSegments != null) {
        for (let segIdx = 0; segIdx < el.textSegments.length; segIdx++) {
          const seg = el.textSegments[segIdx];
          if (seg.textShadow == null || seg.textShadow === "" || seg.textShadow === "none") continue;
          const segShadows = parseBoxShadow(seg.textShadow);
          for (let si = segShadows.length - 1; si >= 0; si--) {
            const sh = segShadows[si];
            if (sh.inset) continue;
            const segShadowFill = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
            const shiftedSeg: TextSegment = {
              ...seg,
              x: seg.x + sh.x,
              y: seg.y + sh.y,
              xOffsets: seg.xOffsets?.map((v) => v + sh.x),
              rasterRect: undefined,
              rasterDataUri: undefined,
              rasterGlyphs: undefined,
              // Drop the pseudoBox on the shadow copy — backgrounds and
              // borders aren't part of the text shadow (they paint
              // separately via the pseudoBox path). Otherwise we'd stamp
              // a recolored gradient-pill rect underneath the shadow.
              pseudoBox: undefined,
            };
            let segBody = renderMultiSegmentText({ el, idPrefix, clipId: cid, fillColor: segShadowFill, emitPseudoBoxBgLayers }, [shiftedSeg]);
            if (sh.blur > 0) {
              const stdDev = sh.blur / 2;
              const fid = `${idPrefix}tssh${clipIdx++}`;
              defsParts.push(
                `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
              );
              segBody = `<g filter="url(#${fid})">${segBody}</g>`;
            }
            svgParts.push(`${indent}${segBody}`);
          }
        }
      }

      // Whether the element's own text needs clipping: only when overflow
      // is set on the element itself (overflow != visible on either axis).
      // Default `overflow: visible` lets text spill past the box, matching
      // Chrome (DM-305).
      const tox = el.styles.overflowX;
      const toy = el.styles.overflowY;
      const textOverflowClip = (tox != null && tox !== "visible") || (toy != null && toy !== "visible");
      const renderOpts = { el, idPrefix, clipId: cid, fillColor, overflowClip: textOverflowClip };
      const hasTextBgClip = textBgClipFills.some((s) => s != null);
      if (hasTextBgClip && textIsTransparent) {
        // DM-462: background-clip:text — the bg-image should fill the glyph
        // shapes, not the headline element rect. We render the text glyphs
        // INTO an SVG <mask> (with white fill so the mask reveals the bg
        // through the glyph silhouettes) and paint a <rect fill=url(#bg)>
        // through that mask. Couldn't use <clipPath> here because Chromium
        // does not honor <use href=...> references inside <clipPath>
        // (verified empirically) — and our text glyphs are emitted via
        // <use> for dedup. Setting fill=url(#bg) directly on the text <g>
        // was also wrong because userSpaceOnUse gradient coords get re-
        // interpreted in the post-transform coord system of the inner
        // scaled glyph group, compressing the gradient to ~6 px wide.
        // The mask-with-rect approach keeps the gradient in document
        // coordinates on a straight rect.
        const maskFillEl: CapturedElement = { ...el, styles: { ...el.styles, color: "rgb(255,255,255)", webkitTextFillColor: "rgb(255,255,255)" } };
        const maskBody = renderOneText({ el: maskFillEl, idPrefix, clipId: cid, fillColor: "rgb(255,255,255)", overflowClip: textOverflowClip });
        const mid = `${idPrefix}tbgm${clipIdx++}`;
        defsParts.push(
          `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}">${maskBody}</mask>`,
        );
        // Emit one masked rect per text-clipped layer, walking from BOTTOM
        // (highest li) to TOP (li = 0) so the topmost CSS layer paints last.
        // All rects share the same glyph mask; later rects paint over earlier
        // ones inside the glyph silhouettes, matching Chrome's compositing of
        // stacked `background-clip: text` layers (DM-696).
        for (let li = textBgClipFills.length - 1; li >= 0; li--) {
          const f = textBgClipFills[li];
          if (f == null) continue;
          svgParts.push(
            `${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" fill="${f}" mask="url(#${mid})" />`,
          );
        }
      } else {
        svgParts.push(`${indent}${renderOneText(renderOpts)}`);
      }
      }
    }

    // text-overflow truncation marker (DM-373). When an element has
    // text-overflow: ellipsis (or a custom string) AND overflow:hidden AND
    // white-space:nowrap, Chrome truncates the visible text and paints a
    // truncation marker (`…` by default, or the author-specified string)
    // at the right edge of the content box. Our text capture reads the
    // FULL source text and clips with SVG clip-path, so the marker is
    // missing visually. Approximate Chrome's behavior by emitting a
    // small `<text>` with the marker glyph at the right edge of the
    // visible content area when the truncation conditions are met.
    {
      const to = el.styles.textOverflow;
      const ws = el.styles.whiteSpace;
      const ox = el.styles.overflowX;
      // DM-469: skip the truncation marker when the captured text actually
      // wrapped onto multiple visual lines. CAPTURE_SCRIPT records one
      // TextSegment per line box, so `textSegments.length > 1` means
      // Chromium painted the text on multiple lines — even if the captured
      // computed style reports `white-space: nowrap` somewhere, our marker
      // logic for single-line truncation is wrong. Observed on the apple.com
      // country-switcher banner: the multi-line copy collapsed to a single
      // `…` because the conditions below tripped, but Chromium clearly
      // rendered three lines.
      const wrappedToMultipleLines = el.textSegments != null && el.textSegments.length > 1;
      // DM-484: don't paint a truncation marker when the captured text
      // actually fits within the content box. Apple's country-switcher
      // "Continue" button (and likewise the "Philippines" dropdown text)
      // has `text-overflow: ellipsis; overflow: hidden; white-space: nowrap`
      // even though "Continue" easily fits its 89×35 box — Chromium paints
      // no ellipsis there, but our previous code did. Compare the captured
      // text's right edge to the content-box right edge; only emit a marker
      // if the text would actually be clipped.
      const padRChk = parseFloat(el.styles.paddingRight ?? "") || 0;
      const padLChk = parseFloat(el.styles.paddingLeft ?? "") || 0;
      const brRChk = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const blLChk = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const contentBoxW = Math.max(0, el.width - padLChk - padRChk - blLChk - brRChk);
      const seg0Chk = el.textSegments?.[0];
      const xOffsetsChk = seg0Chk?.xOffsets;
      const lastEdgeX = xOffsetsChk != null && xOffsetsChk.length > 0
        ? xOffsetsChk[xOffsetsChk.length - 1]
        : null;
      const segWidth = seg0Chk?.width;
      const measuredTextW = lastEdgeX != null && seg0Chk != null
        ? lastEdgeX - (xOffsetsChk![0] ?? 0)
        : (segWidth ?? null);
      // Allow a 0.5 px tolerance for sub-pixel rounding so we don't paint
      // an ellipsis on a string that visually fits.
      const textFits = measuredTextW != null && measuredTextW <= contentBoxW + 0.5;
      const isTruncated = to != null && to !== "" && to !== "clip"
        && (ws === "nowrap" || ws === "pre")
        && ox != null && ox !== "visible"
        && el.text !== ""
        && !wrappedToMultipleLines
        && !textFits;
      if (isTruncated) {
        // text-overflow values: 'ellipsis' or a custom quoted string like '"…»"'.
        let marker = "…";
        if (to !== "ellipsis") {
          // Strip outer quotes if any, take the first string token.
          const m = /^"([^"]*)"|^'([^']*)'/.exec(to);
          if (m != null) marker = m[1] ?? m[2] ?? "…";
        }
        const fontSizePx = parseFloat(el.styles.fontSize) || 14;
        const fillCol = textColor != null ? colorStr(textColor) : "rgb(0,0,0)";
        const padR = parseFloat(el.styles.paddingRight ?? "") || 0;
        const brR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
        // Position: right edge of the content box. Baseline at the same y as
        // the element's text baseline (textTop + fontAscent if captured).
        const contentRightX = el.x + el.width - padR - brR;
        const tx = contentRightX;
        const ty = (el.textTop != null && el.fontAscent != null)
          ? el.textTop + el.fontAscent
          : el.y + fontSizePx * 1.1;
        const escMarker = marker.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // Paint a background rect under the marker so the overflowing text
        // behind it gets visually erased — mirrors Chrome where the
        // truncated text doesn't bleed past the marker. Extend the rect all
        // the way to the element's right edge so any clipped trailing chars
        // sitting inside the right padding are also covered.
        // markerW: per-char ~0.95 of fontSize is a conservative width for
        // "…" in Helvetica/Arial/SF Pro; custom strings may be slightly off
        // but this is much closer than the previous 0.55 ratio.
        const bgCol = el.styles.backgroundColor != null && el.styles.backgroundColor !== "rgba(0, 0, 0, 0)"
          ? el.styles.backgroundColor : "rgb(255,255,255)";
        // "…" in Helvetica/Arial/SF Pro has an advance of ~1000-1100 font
        // units / em (≈1.0× fontSize). Custom strings use length × 0.55 as
        // a generic ratio.
        const markerW = marker === "…" ? fontSizePx * 1.0 : marker.length * fontSizePx * 0.55;
        // Position the marker at Chrome's truncation point: just past the
        // right edge of the last char that fits with the marker after it.
        // xOffsets[i] is the captured viewport-x of char i's left edge, so
        // char k's right edge ≈ xOffsets[k+1]. Find max k such that
        // xOffsets[k+1] ≤ contentRightX - markerW; place the marker so its
        // left edge is at xOffsets[k+1].
        let markerRightX = contentRightX;
        const seg0 = el.textSegments?.[0];
        const xOffsets = seg0?.xOffsets;
        if (xOffsets != null && xOffsets.length > 1) {
          const limitX = contentRightX - markerW;
          let markerLeftAtX = xOffsets[0];
          for (let i = 1; i < xOffsets.length; i++) {
            if (xOffsets[i] <= limitX) markerLeftAtX = xOffsets[i];
            else break;
          }
          markerRightX = Math.min(markerLeftAtX + markerW, contentRightX);
        }
        // Clamp the bg-rect to the padding box (inside all four borders) so
        // it doesn't paint over the element's own borders. DM-449 fix: the
        // previous bgRightX = el.x + el.width covered the right border, and
        // a tall bgH could spill past the bottom border, leaving a faded /
        // missing border at the right and bottom corners.
        const btTop = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
        const bbBot = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
        const bgX = markerRightX - markerW;
        const bgRightX = el.x + el.width - brR;
        const bgYRaw = el.textTop != null ? el.textTop : ty - fontSizePx;
        const bgY = Math.max(bgYRaw, el.y + btTop);
        const bgBottomCap = el.y + el.height - bbBot;
        const bgH = Math.max(0, Math.min(fontSizePx * 1.4, bgBottomCap - bgY));
        svgParts.push(`${indent}<rect x="${r(bgX)}" y="${r(bgY)}" width="${r(bgRightX - bgX)}" height="${r(bgH)}" fill="${bgCol}" />`);
        svgParts.push(`${indent}<text x="${r(markerRightX)}" y="${r(ty)}" text-anchor="end" font-size="${r(fontSizePx)}" font-family="${esc(el.styles.fontFamily)}" fill="${fillCol}">${escMarker}</text>`);
      }
    }

    // Resize handle (DM-339): when CSS `resize` is non-none and the element
    // is a resizable type, Chrome paints a small ~7×7 diagonal-line pattern
    // in the bottom-right corner indicating the user can drag to resize.
    // Empirical: 3 diagonal lines from the corner extending up-left, ~1.5px
    // stroke, mid-gray (#999), inside the padding-box. Matches what Chrome
    // paints across resize: vertical / horizontal / both / inline / block
    // (only `none` suppresses).
    //
    // Per CSS UI spec §6.3 + Chrome's `LayoutBox::CanResize`: the handle
    // paints on any replaced element OR any block-level element with
    // `overflow` other than `visible` (the spec says `resize` only takes
    // effect when overflow != visible, and Chrome only renders the grippy
    // when the property is "in effect"). So textareas always qualify
    // (textarea UA style sets overflow:auto), but plain divs with
    // `overflow: auto; resize: both` qualify too.
    const resizeInEffect = el.styles.resize != null && el.styles.resize !== "none"
      && (el.tag === "textarea"
        || (el.styles.overflowX != null && el.styles.overflowX !== "visible")
        || (el.styles.overflowY != null && el.styles.overflowY !== "visible"));
    if (resizeInEffect) {
      const handleColor = "rgb(153,153,153)";
      const handleSize = 7;
      // Position the handle so its bottom-right corner sits just INSIDE the
      // inner (padding-box) corner — the diagonals then sweep up-left into
      // the padding area where they're visible against the content
      // background. Inset by the border widths plus a small 1 px gap.
      // (Matches Chrome's painted offset; previously we used a fixed 2 px
      // inset from the border-box which worked for thin-border textareas
      // but parked the handle on top of the dark border on thicker-bordered
      // divs in `30-resize`. DM-707.)
      const borderR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const borderB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const cx = el.x + el.width - borderR;
      const cy = el.y + el.height - borderB;
      // Three diagonal strokes 2px apart sloping from bottom-right to upper-left.
      for (let i = 0; i < 3; i++) {
        const off = i * 2.5;
        svgParts.push(`${indent}<line x1="${r(cx - handleSize + off)}" y1="${r(cy)}" x2="${r(cx)}" y2="${r(cy - handleSize + off)}" stroke="${handleColor}" stroke-width="1" />`);
      }
    }

    // Overflow clipping: when a parent has overflow != visible (hidden/scroll/
    // auto/clip on either axis), its children must be clipped to its box.
    // We wrap just the child recursion in a <g clip-path="..."> so the element's
    // own bg/border/text render unclipped.
    //
    // CSS spec (DM-363): overflow clips to the **padding edge**, not the
    // border-box edge. If we clip to the border-box, child fills extending to
    // the bottom of the box paint OVER the bottom border stroke and the
    // border disappears from the rendered output (e.g. 13-pos-sticky:
    // Section B's `.filler` rect was hiding the scroller's `border-bottom`).
    // Inset the clip rect by the per-side border widths so the border stroke
    // remains visible above the clipped children.
    const ox = el.styles.overflowX;
    const oy = el.styles.overflowY;
    // DM-522: `contain: paint | strict | content` clips descendants to the
    // principal (padding) box per the CSS Containment spec — same effective
    // clip as overflow:hidden, so route it through the same machinery. Without
    // this, a `contain:paint` ancestor lets descendants overflow visually
    // (regression observable on `13-deep-stacking-context-creators`'s
    // contain:paint stage: the blue inner z:9999 box paints past the dashed
    // ancestor instead of being trapped). The `containClips` test deliberately
    // excludes `contain: layout` / `size` / `inline-size` since those don't
    // imply paint clipping.
    const containVal = el.styles.contain;
    const containClips = containVal != null && containVal !== "" && containVal !== "none"
      && /\b(?:paint|strict|content)\b/i.test(containVal);
    const clipsOverflow = (ox != null && ox !== "visible") || (oy != null && oy !== "visible") || containClips;
    // DM-650: same body-overflow-propagation rule as the earlier clip-path
    // emission — when body has non-visible overflow it propagates to the
    // viewport rather than clipping body itself; skip the children-overflow
    // clip too so descendants positioned outside body's bbox (e.g. NYT
    // desktop's content wrapper, which extends below body's height: 100vh
    // box) stay visible after the document scroll moves body off-viewport.
    const isBodyOverflowPropagatedHere = el.tag === "body";
    let overflowClipId: string | null = null;
    if (clipsOverflow && !isBodyOverflowPropagatedHere && el.children.length > 0) {
      overflowClipId = `${idPrefix}ov${clipIdx++}`;
      const cbt = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const cbr = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const cbb = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const cbl = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      // DM-698: overflow clips to the inner border-radius (per CSS Backgrounds 3
      // — the rounded clip on the padding box uses radii inset by each side's
      // border width, clamped to zero). Previously we passed the OUTER `corners`
      // which made the clip too generous near each corner, exposing a sliver of
      // the parent's background between the border and the clipped child.
      // (e.g. `18-deep-radius-overflow` `.card` border-radius:32 / border:4 +
      // child `position:absolute inset:0`: 4 px gradient sliver visible inside
      // each rounded corner.)
      const overflowInnerCorners = insetCornerRadii(corners, cbt, cbr, cbb, cbl);
      // Default clip = padding box (border-inset). DM-761: when `overflow: clip`
      // (only — `hidden` ignores it) plus a non-zero `overflow-clip-margin`,
      // the clip extends outward from a reference box. The shorthand resolves
      // to either `"<length>"` (defaults to padding-box reference) or
      // `"<ref-box> <length>"` where ref-box is content-box / padding-box /
      // border-box. The clip rect grows by the length on every side from the
      // chosen ref-box edge. Corner radii on the expanded clip are left at
      // the inner-border-radius value — that's how Chrome paints it: the
      // outset region is a rectangular extension, not a radial expansion.
      let ocX = el.x + cbl;
      let ocY = el.y + cbt;
      let ocW = Math.max(0, el.width - cbl - cbr);
      let ocH = Math.max(0, el.height - cbt - cbb);
      const isClip = ox === "clip" || oy === "clip";
      // DM-787: CSS Overflow 3 allows mixing `overflow-x: clip; overflow-y:
      // visible` (only `clip` permits this — `hidden + visible` coerces to
      // `auto + hidden`). Chrome clips only the clipped axis; content can
      // still escape on the visible axis. The SVG clipPath is a single rect,
      // so to NOT clip on an axis we extend that axis past any plausible
      // paint area with `±UNBOUNDED`. Apply before the `overflow-clip-margin`
      // expansion so the per-axis grow happens AFTER ref-box adjustments.
      const UNBOUNDED = 100000;
      const xVisible = ox === "visible" && oy === "clip";
      const yVisible = oy === "visible" && ox === "clip";
      const ocmRaw = el.styles.overflowClipMargin;
      if (isClip && ocmRaw != null && ocmRaw !== "" && ocmRaw !== "0px") {
        const m = /^(?:(content-box|padding-box|border-box)\s+)?(-?\d*\.?\d+)px$/i.exec(ocmRaw.trim());
        if (m) {
          const refBox = (m[1] ?? "padding-box").toLowerCase();
          const margin = parseFloat(m[2]);
          // Reference-box edges relative to (el.x, el.y) border-box top-left:
          //   border-box  → 0
          //   padding-box → border width (cbl/cbt/cbr/cbb)
          //   content-box → border + padding
          let refL = 0, refT = 0, refR = 0, refB = 0;
          if (refBox === "padding-box") {
            refL = cbl; refT = cbt; refR = cbr; refB = cbb;
          } else if (refBox === "content-box") {
            const pT = parseFloat(el.styles.paddingTop ?? "0") || 0;
            const pR = parseFloat(el.styles.paddingRight ?? "0") || 0;
            const pB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
            const pL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
            refL = cbl + pL; refT = cbt + pT; refR = cbr + pR; refB = cbb + pB;
          }
          ocX = el.x + refL - margin;
          ocY = el.y + refT - margin;
          ocW = Math.max(0, el.width - refL - refR + margin * 2);
          ocH = Math.max(0, el.height - refT - refB + margin * 2);
        }
      }
      if (xVisible) {
        ocX = el.x - UNBOUNDED;
        ocW = el.width + UNBOUNDED * 2;
      }
      if (yVisible) {
        ocY = el.y - UNBOUNDED;
        ocH = el.height + UNBOUNDED * 2;
      }
      defsParts.push(`<clipPath id="${overflowClipId}">${roundedRectSvg(ocX, ocY, ocW, ocH, overflowInnerCorners, "")}</clipPath>`);
      svgParts.push(`${indent}<g clip-path="url(#${overflowClipId})">`);
      // DM-673: stash the clip-path id so hoisted descendants of this
      // overflow scroller can re-wrap their emission in the same clip.
      overflowClipPathIds.set(el, overflowClipId);
    }

    // Children — sorted by CSS paint order. Elements with position != static
    // and an explicit integer z-index paint in z-index order (negative below,
    // positive above); auto or static keeps DOM order. This is an approximation
    // of full CSS stacking context semantics but covers the common case of
    // positioned siblings jockeying for front/back. When we hoisted floats
    // above (text-bearing parents), exclude them here; otherwise sort all.
    // DM-473: when `el` is a stacking-context root, build the flat paint
    // list for its SC by hoisting positioned descendants of any non-SC
    // children up to this level. When `el` is NOT an SC root, just render
    // its direct children — but skip ones already hoisted to an ancestor
    // SC's flat list (they render at the ancestor's depth via that SC's
    // sort, and re-rendering here would double-emit).
    const baseChildren = hasOwnText ? nonFloatChildren : el.children;
    let childrenForSort: CapturedElement[];
    // DM-525: pass `el.styles.display` to flex/grid-aware checks so direct
    // children that are flex/grid items honor z-index ≠ auto as a stacking
    // context creator and z-sort accordingly.
    const childParentDisplay = el.styles.display;
    const hoistedAsInlineForEl = new Set<CapturedElement>();
    const hoistedAsZSortedForEl = new Set<CapturedElement>();
    if (establishesStackingContext(el, parentDisplayForEl)) {
      childrenForSort = gatherStackingContextChildren(baseChildren, hoistedFromAncestor, childParentDisplay, hoistedAsInlineForEl, overflowClipForHoisted, hoistedAsZSortedForEl);
    } else {
      childrenForSort = baseChildren.filter((c) => !hoistedFromAncestor.has(c));
    }
    // DM-1052: pass the SC root's actual direct children so a flex/grid
    // `order` / `*-reverse` reorder of a flattened paint list keeps each
    // hoisted descendant grouped with (and painting after) its direct-item
    // ancestor instead of being reversed ahead of it.
    let sortedChildren = sortChildrenByPaintOrder(childrenForSort, childParentDisplay, el.styles.flexDirection, hoistedAsInlineForEl, hoistedAsZSortedForEl, new Set(baseChildren));
    // DM-751: when this element establishes a 3D rendering context
    // (`transform-style: preserve-3d`), CSS Transforms 2 §6 sorts children
    // by their Z position in 3D space — translateZ — not by z-index. Re-
    // sort the already-positioned children by extracted translateZ
    // ascending, with DOM order tie-breaks, so a child with a small
    // z-index but a positive translateZ paints above siblings with bigger
    // z-index but translateZ=0. Approximation: ignore perspective effects
    // (which would also shrink / shift the painted box) and just use the
    // captured `matrix3d` `m43` translation. Without this the
    // `transform-style: preserve-3d` panel in `13-deep-cross-sc-z-index`
    // paints orange (`translateZ(20px)`, z=1) BEHIND purple (z=5) and sky
    // (z=10), instead of in front of both as Chrome paints.
    if (el.styles.transformStyle === "preserve-3d") {
      const zOf = (c: CapturedElement) => c.styles.translateZ ?? 0;
      sortedChildren = sortedChildren
        .map((c, idx) => ({ c, idx, z: zOf(c) }))
        .sort((a, b) => a.z - b.z || a.idx - b.idx)
        .map((x) => x.c);
    }
    for (const child of sortedChildren) {
      renderElementWithOverflowClip(child, depth + 1, childParentDisplay);
    }

    // DM-1001: emit deferred fade-overlay `::after` pseudoBoxes AFTER all
    // child recursion. The `::before` loop above skipped these so they paint
    // last and win z over child headline text — matches NYT's right-edge
    // mask-image-style fade pattern. Same filter as the skip condition above
    // so we don't double-emit decorative `::after` boxes (carets / dividers)
    // that the earlier loop already handled in CSS-correct inline position.
    if (el.pseudoBoxes != null) {
      for (const pb of el.pseudoBoxes) {
        if (pb.pseudo !== "::after") continue;
        const hasBgImage = pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "";
        const hasBgColor = pb.backgroundColor != null && pb.backgroundColor !== "" && pb.backgroundColor !== "rgba(0, 0, 0, 0)";
        const hasBorder = (pb.borderTopWidth ?? 0) > 0
          || (pb.borderRightWidth ?? 0) > 0
          || (pb.borderBottomWidth ?? 0) > 0
          || (pb.borderLeftWidth ?? 0) > 0;
        if (!(hasBgImage && !hasBgColor && !hasBorder)) continue;
        // DM-1051: a negative z-index glow was already painted behind in the
        // early loop — don't re-emit it on top here.
        if (pb.zIndex != null && pb.zIndex < 0) continue;
        // DM-1121: wrap the deferred fade-overlay's rects in a `<g opacity>`
        // when the pseudo dims itself. Stripe's keynote glow is a 45%-opacity
        // pink radial; emitting it opaque painted a hard magenta blob.
        const pbOpacityStart = svgParts.length;
        const pbLayers = splitTopLevelCommas(pb.backgroundImage!);
        for (let li = pbLayers.length - 1; li >= 0; li--) {
          const layer = pbLayers[li].trim();
          const defId = `${idPrefix}pbg${clipIdx++}`;
          const out = buildBackgroundLayerDef(
            defId, layer, pb.x, pb.y, pb.width, pb.height,
            pb.backgroundSize ?? "auto", pb.backgroundPosition ?? "0% 0%", "repeat", null, "scroll", captureViewport,
          );
          if (out.def === "") continue;
          defsParts.push(out.def);
          const rxAttr = pb.borderRadius && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}"` : "";
          svgParts.push(`${indent}<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="url(#${defId})" />`);
        }
        if (pb.opacity != null && pb.opacity < 1) {
          const added = svgParts.splice(pbOpacityStart);
          if (added.length > 0) {
            const inner = added.map((s) => s.startsWith(indent) ? s.slice(indent.length) : s).join("");
            svgParts.push(`${indent}<g opacity="${Number(pb.opacity.toFixed(2))}">${inner}</g>`);
          }
        }
      }
    }

    // DM-808: MathML `<mfrac>` needs a horizontal fraction bar between its
    // numerator (first child) and denominator (second child). Chrome's
    // MathML layout paints this from internal layout — there's no CSS
    // border on the children to capture. Synthesize the bar at the midpoint
    // between numerator bottom and denominator top, default 1px thickness
    // (matches MathML's `mfrac@linethickness="medium"`).
    //
    // DM-896: span the bar across the mfrac ELEMENT box (`el.x` … `el.x +
    // el.width`), NOT the children's content span. Chromium paints the
    // fraction rule across the full inline-size of the mfrac. For inline
    // fractions the mfrac shrink-wraps its content so the two are equal, but
    // a display-block fraction (`<math display="block">` quadratic formula)
    // is stretched to the block width — there the element box is 800 px wide
    // while the num/den content is ~135 px, and the old children-span bar was
    // far too short. PNG scan of the expected output confirms Chrome's bar
    // runs the full mfrac width.
    //
    // DM-832/DM-896: snap the 1-px bar to the device pixel row the math-axis
    // midpoint falls in via `round` (the previous fractional `midpoint - 0.5`
    // straddled two rows and rasterized to a blurred gray 2-px bar). `round`
    // matches Chrome's pixel snap on both the layout fixture (mid 1469.03 →
    // 1469) and the quadratic (mid 1372.85 → 1373, where `floor` gave 1372).
    if (el.tag === "mfrac" && el.children.length >= 2) {
      const num = el.children[0];
      const den = el.children[1];
      const barX = el.x;
      const barRight = el.x + el.width;
      const barY = Math.round((num.y + num.height + den.y) / 2);
      const fillCol = el.styles.color ? esc(el.styles.color) : "rgb(0,0,0)";
      svgParts.push(`${indent}<rect x="${r(barX)}" y="${r(barY)}" width="${r(barRight - barX)}" height="1" fill="${fillCol}" />`);
    }

    // DM-809 / DM-897: MathML `<msqrt>` / `<mroot>` need their radical sign +
    // overbar synthesised — Chrome's MathML layout paints them from internal
    // layout (no border / glyph capture). Preferred path (DM-897): render the
    // actual √ (U+221A) font glyph fitted to the captured radical box, so the
    // checkmark inherits the font's stroke-weight contrast and hook shape that
    // a uniform stroke can't reproduce; the overbar (vinculum) is extended
    // across the radicand separately. Falls back to the legacy uniform-stroke
    // 3-segment path when the √ glyph can't be resolved (e.g. a platform whose
    // fallback chain lacks it). For `<mroot>` the structure is `<mroot>
    // <radicand><index></mroot>` — the index renders normally as a child
    // glyph; only the radical + overbar are synthesised here.
    if ((el.tag === "msqrt" || el.tag === "mroot") && el.children.length >= 1) {
      const radicand = el.children[0];
      const strokeCol = el.styles.color ? esc(el.styles.color) : "rgb(0,0,0)";
      const radFontSize = parseFloat(el.styles.fontSize) || 16;
      const glyphRadical = renderRadicalGlyph(
        el.x, el.y, el.height, el.width,
        radFontSize, el.styles.fontFamily, el.styles.fontWeight, strokeCol, el.styles.fontStyle,
      );
      if (glyphRadical != null) {
        svgParts.push(`${indent}${glyphRadical}`);
      } else {
        const radX0 = el.x;
        const radX1 = radicand.x;
        const radTop = el.y;
        const radBottom = el.y + el.height;
        const radMid = el.y + el.height * 0.6;
        const radRight = el.x + el.width;
        // Radical checkmark: enter at (radX0, radMid), descend to bottom at
        // 40% across the radical-sign zone, climb to top-right at radicand
        // start. Then overbar across the top.
        const vertexX = radX0 + (radX1 - radX0) * 0.4;
        const path = `M${r(radX0)},${r(radMid)} L${r(vertexX)},${r(radBottom - 1)} L${r(radX1)},${r(radTop)} L${r(radRight)},${r(radTop)}`;
        svgParts.push(`${indent}<path d="${path}" fill="none" stroke="${strokeCol}" stroke-width="1" />`);
      }
    }

    if (overflowClipId != null) svgParts.push(`${indent}</g>`);

    // Scrollbar thumb indicator — only painted when the element has an
    // actual scroll offset (scrollTop > 0 or scrollLeft > 0). Chromium macOS
    // uses overlay scrollbars that are invisible at rest (verified: Playwright
    // captures show no scrollbar chrome for non-scrolled static frames), so
    // rendering one by default actually makes diffs worse. When content IS
    // scrolled, the thumb gives a useful visual cue.
    const scrollbarMarkup = renderScrollbarChrome(el, indent);
    if (scrollbarMarkup !== "") svgParts.push(scrollbarMarkup);

    if (animClass !== "") svgParts.push(`${indent}</g>`);
    if (opened) svgParts.push(`${indent}</g>`);
    if (needsFilterOuter) svgParts.push(`${indent}</g>`);
  }

  // Sort top-level siblings by CSS paint order too. captureElementTree
  // returns the root element's children as a flat array (body's children for
  // the default selector), and without this sort a fixed-positioned top-level
  // sibling painted before a following static one would end up BEHIND it —
  // visible on 13-pos-fixed where the .filler block was covering the .footbar
  // because both are body children and filler followed footbar in DOM.
  // DM-473: top-level element list is the implicit root stacking context —
  // flatten it the same way an SC root would, so cross-parent z-index
  // hoisting works at the document root.
  const topLevelHoistedAsInline = new Set<CapturedElement>();
  const topLevelHoistedAsZSorted = new Set<CapturedElement>();
  const topLevelFlat = gatherStackingContextChildren(elements, hoistedFromAncestor, undefined, topLevelHoistedAsInline, overflowClipForHoisted, topLevelHoistedAsZSorted);
  // DM-543: position:fixed elements paint relative to the viewport stacking
  // context and escape ALL ancestor overflow clips. The standard SC-by-SC
  // hoist halts at any SC ancestor (e.g. an overflow:auto section creates an
  // SC, so its fixed descendants get buried inside the section's <g
  // clip-path> wrapper and disappear). Pull viewport-anchored fixed
  // descendants up to the root SC so they paint at document root.
  // Constraint: stop bubbling at fixed-CB ancestors — when an ancestor
  // creates a containing block for fixed (transform / filter / will-change:
  // <transform|filter|perspective> / contain: <paint|strict|content|layout>),
  // the descendant is effectively absolute-positioned to that ancestor and
  // must respect the ancestor's clipping. See `13-deep-fixed-in-transform`:
  // the reference section's pin should hit the viewport; the pins under
  // .frame-transform / .frame-filter / .frame-will / .frame-contain stay
  // trapped to .frame.
  const collectViewportFixed = (parent: CapturedElement): void => {
    for (const c of parent.children) {
      if (c.styles.position === "fixed") {
        if (!hoistedFromAncestor.has(c)) {
          topLevelFlat.push(c);
          hoistedFromAncestor.add(c);
        }
        // c is its own SC root; descendants render via c's renderElement.
      } else if (!isFixedContainingBlock(c)) {
        collectViewportFixed(c);
      }
      // else: c is a fixed-CB; fixed descendants stay within c's subtree.
    }
  };
  for (const e of elements) {
    if (e.styles.position !== "fixed" && !isFixedContainingBlock(e)) {
      collectViewportFixed(e);
    }
  }
  const sortedTopLevel = sortChildrenByPaintOrder(topLevelFlat, undefined, undefined, topLevelHoistedAsInline, topLevelHoistedAsZSorted);
  for (const el of sortedTopLevel) {
    renderElementWithOverflowClip(el, 1);
  }

  // Prepend defs block: clipPaths + optional glyph path definitions. For
  // animated multi-frame SVGs the caller passes includeGlyphDefs=false and
  // collects glyph defs once at the top level via getGlyphDefs().
  // DM-652: embedded-font `@font-face` rules are NOT emitted here — the
  // base64-encoded font bytes can be megabytes each, so duplicating them
  // per-segment in a multi-frame SVG would balloon file size unmanageably.
  // Callers that drive embedded-font mode must call
  // `getEmbeddedFontFaceCss()` themselves once at the top level (see how
  // `composeScrollSvg` injects it into the outer <style>).
  const glyphDefsMarkup = includeGlyphDefs ? getGlyphDefs() : "";
  // DM-839: embedded-font `@font-face` rules for the text runs rendered above
  // (empty in paths mode, or when no run was embeddable). A `<style>` inside
  // `<defs>` is valid SVG. Single-frame producers emit it here; multi-frame
  // producers pass includeEmbeddedFontCss=false and inject once at the top.
  const embeddedFontCss = includeEmbeddedFontCss ? getEmbeddedFontFaceCss() : "";
  const fontStyleMarkup = embeddedFontCss !== "" ? `<style>${embeddedFontCss}</style>` : "";
  const allDefs = defsParts.join("") + glyphDefsMarkup + fontStyleMarkup;
  const defs = allDefs !== "" ? `  <defs>${allDefs}</defs>\n` : "";
  return defs + svgParts.join("\n");
}

/**
 * DM-950: render a CapturedElement tree into a **complete `<svg>`
 * document** — the obvious entry point for "I have a tree, give me a
 * standalone SVG file". Composes `elementTreeToSvgInner()` + `wrapSvg()`
 * (which adds the `xmlns`, `viewBox`, `width`/`height`, color-scheme,
 * and root-bg `<rect>` produced from the captured tree's resolved
 * `rootBgComputed`).
 *
 * For multi-frame composition (animator, scroll composer), call
 * `elementTreeToSvgInner()` directly and emit one outer `<svg>`
 * yourself so per-frame `idPrefix`-scoped clipPath ids don't collide
 * and the embedded-font CSS isn't duplicated per frame.
 *
 * Renamed in DM-950: the symbol previously called `elementTreeToSvg`
 * was renamed to `elementTreeToSvgInner` to reflect what it actually
 * emits. The new `elementTreeToSvg` below produces the full document
 * most callers actually want; if you were calling the old function
 * and wrapping the output in `wrapSvg()` yourself, switch to this.
 */
export function elementTreeToSvg(
  elements: CapturedElement[],
  width: number,
  height: number,
  opts?: {
    /** Forwarded to `elementTreeToSvgInner`. Single-frame producers
     *  can leave this default. Multi-frame producers should NOT use
     *  this wrapper — call `elementTreeToSvgInner` directly. */
    idPrefix?: string;
    /** Forwarded to `elementTreeToSvgInner`. */
    includeGlyphDefs?: boolean;
    /** Forwarded to `elementTreeToSvgInner`. */
    hiDPIFactor?: number;
    /** Forwarded to `elementTreeToSvgInner`. */
    includeEmbeddedFontCss?: boolean;
  },
): string {
  const inner = elementTreeToSvgInner(
    elements, width, height,
    opts?.idPrefix ?? "",
    opts?.includeGlyphDefs ?? true,
    opts?.hiDPIFactor ?? 2,
    opts?.includeEmbeddedFontCss ?? (opts?.includeGlyphDefs ?? true),
  );
  return wrapSvg(inner, width, height, { tree: elements });
}


/**
 * Emit a macOS-style overlay scrollbar thumb when the captured element has
 * been scrolled (scrollTop > 0 or scrollLeft > 0). Chromium macOS uses
 * overlay scrollbars that are invisible at rest — a screenshot capture of a
 * non-scrolled page shows no scrollbar chrome at all. So we ONLY paint the
 * thumb when the captured state reflects an active scroll; this matches
 * Chromium's captured appearance during/after a scroll gesture, and avoids
 * noise when the capture is a fresh page at scrollTop=0.
 *
 * Thumb: ~7px rounded-rect with rgba(0,0,0,0.4) fill. Positioned on the
 * inside-right edge (Y axis) / inside-bottom edge (X axis) of the element.
 */
function renderScrollbarChrome(el: CapturedElement, indent: string): string {
  const s = el.styles;
  const THUMB = 7;
  const THUMB_COLOR = "rgba(0,0,0,0.40)";

  const overflowYScroll = s.overflowY === "auto" || s.overflowY === "scroll";
  const overflowXScroll = s.overflowX === "auto" || s.overflowX === "scroll";
  const scrolledY = overflowYScroll && (s.scrollTop ?? 0) > 0 && s.scrollHeight != null && s.clientHeight != null && s.scrollHeight > s.clientHeight;
  const scrolledX = overflowXScroll && (s.scrollLeft ?? 0) > 0 && s.scrollWidth != null && s.clientWidth != null && s.scrollWidth > s.clientWidth;

  if (!scrolledY && !scrolledX) return "";

  const parts: string[] = [];
  if (scrolledY) {
    const trackH = el.height;
    const thumbH = Math.max(20, (trackH * s.clientHeight!) / s.scrollHeight!);
    const thumbY = el.y + ((trackH - thumbH) * s.scrollTop!) / Math.max(1, s.scrollHeight! - s.clientHeight!);
    parts.push(`${indent}<rect x="${r(el.x + el.width - THUMB - 2)}" y="${r(thumbY)}" width="${r(THUMB)}" height="${r(thumbH)}" rx="${r(THUMB / 2)}" fill="${THUMB_COLOR}" />`);
  }
  if (scrolledX) {
    const trackW = el.width;
    const thumbW = Math.max(20, (trackW * s.clientWidth!) / s.scrollWidth!);
    const thumbX = el.x + ((trackW - thumbW) * s.scrollLeft!) / Math.max(1, s.scrollWidth! - s.clientWidth!);
    parts.push(`${indent}<rect x="${r(thumbX)}" y="${r(el.y + el.height - THUMB - 2)}" width="${r(thumbW)}" height="${r(THUMB)}" rx="${r(THUMB / 2)}" fill="${THUMB_COLOR}" />`);
  }
  return parts.join("\n");
}


/**
 * Sort children into approximate paint order (CSS 2.1 §9.9 + §9.5):
 *   1. Positioned children with negative z-index (ascending).
 *   2. Non-positioned, non-floating children in DOM order (the 'block' layer).
 *   3. Floating children in DOM order (above block content).
 *   4. Positioned children with z-index: auto or 0 (DOM order).
 *   5. Positioned children with positive z-index (ascending, DOM order tie-break).
 *
 * Floats were previously lumped with base, which caused a floated <aside>
 * painted before the following <article> to be covered by the article's
 * own background rect. Promoting floats to layer 3 matches CSS painting rules.
 */
// Stacking-context analysis (establishesStackingContext / gatherStackingContextChildren / isOverflowOnlySC / isFlexOrGridContainerDisplay) moved to ./stacking.ts (DM-1305).

/**
 * DM-543: returns true when `el` creates a containing block for
 * position:fixed descendants. Per CSS Containment 1 / Transforms 2 / Will
 * Change 1: any non-trivial `transform`, `filter`, `will-change` listing
 * `transform` / `filter` / `perspective`, or `contain` value with `paint` /
 * `strict` / `content` / `layout` traps fixed descendants.
 *
 * `perspective` ≠ `none` also creates a fixed CB but `perspective` is not
 * captured today (low real-world frequency — see `establishesStackingContext`
 * comment); add to the captured-styles list when a fixture demands it.
 */
function isFixedContainingBlock(el: CapturedElement): boolean {
  const s = el.styles;
  if (s.transform != null && s.transform !== "" && s.transform !== "none") return true;
  // DM-587: see establishesStackingContext — transform info is split between
  // `styles.transform` (always 'none' after the live-rect-capture switch) and
  // `transformCreatesSc` (preserves the original "was non-none" bit). A
  // transformed element creates a containing block for its fixed-positioned
  // descendants regardless of the transform value, so honor the bit here too.
  if (s.transformCreatesSc) return true;
  if (s.filter != null && s.filter !== "" && s.filter !== "none") return true;
  if (s.willChange != null && s.willChange !== "" && s.willChange !== "auto") {
    const tokens = s.willChange.split(/[\s,]+/);
    for (const t of tokens) {
      const lt = t.toLowerCase();
      if (lt === "transform" || lt === "filter" || lt === "perspective") return true;
    }
  }
  if (s.contain != null && s.contain !== "" && s.contain !== "none") {
    if (/\b(?:paint|strict|content|layout)\b/i.test(s.contain)) return true;
  }
  return false;
}

function sortChildrenByPaintOrder(
  children: CapturedElement[],
  parentDisplay?: string,
  parentFlexDirection?: string,
  /**
   * DM-683: Set of children to route into the inline bucket (CSS 2.1
   * Appendix E step 5) rather than the block / base bucket (step 3).
   * Populated by `gatherStackingContextChildren` for flex/grid items
   * (which paint as inline blocks per CSS Flexbox 1 §5.4).
   */
  paintAsInline?: Set<CapturedElement>,
  /**
   * DM-712: Set of children that should be z-sorted using their captured
   * z-index, even when the immediate parent display isn't flex/grid
   * (e.g. because the child was hoisted out of a flex parent into a real
   * SC root for paint-order resolution). Populated by
   * `gatherStackingContextChildren`'s `hoistedAsZSorted` out-parameter.
   */
  paintAsZSorted?: Set<CapturedElement>,
  /**
   * DM-1052: when `children` is a *flattened* stacking-context paint list
   * (produced by `gatherStackingContextChildren` for an SC root), it can
   * contain hoisted DESCENDANTS of the SC root's direct flex/grid items
   * interleaved right after their ancestor — e.g. a flex-item badge and the
   * icon hoisted out of it both land in the list, in `[badge, icon]` order.
   * The flex `order` / `*-reverse` reordering below must only reorder the
   * DIRECT flex items, never flip an ancestor and its trailing descendants
   * (reversing `[badge, icon]` → `[icon, badge]` makes the badge background
   * paint OVER its own icon — resend.com's animated inbox widget). This set
   * holds the SC root's actual direct children so the reorder can group each
   * direct item with its trailing descendants and reorder the GROUPS. When
   * omitted (non-flattened call), every child is treated as a direct item,
   * giving the original element-wise behavior.
   */
  directChildren?: Set<CapturedElement>,
): CapturedElement[] {
  // DM-525: flex/grid items with z-index ≠ auto sort as if position:relative
  // even when position:static (per CSS Flexbox 1 §5.4 / CSS Grid 1 §17).
  const isFlexGrid = isFlexOrGridContainerDisplay(parentDisplay);
  // DM-537: flex/grid items paint in order-modified document order. Reorder
  // by ascending `order` (default 0), ties broken by source order, BEFORE
  // bucketing — the resulting indices then drive both base-bucket order and
  // z-index tie-breaking (CSS Flexbox 1 §5.4.1 / CSS Grid 1 §17).
  //
  // When the flex container's flex-direction is `row-reverse` or
  // `column-reverse`, Chrome reverses paint order so the visually-rightmost
  // (or visually-bottommost) item still paints LAST — matching what users
  // intuit from the reversed visual layout. Implement by reversing the
  // order-modified sequence when *-reverse is set; this preserves correct
  // ordering when both `order` AND a *-reverse direction are combined.
  const reverseFlex = isFlexGrid && parentFlexDirection != null
    && (parentFlexDirection === "row-reverse" || parentFlexDirection === "column-reverse");
  let orderedChildren: CapturedElement[];
  if (isFlexGrid) {
    // DM-1052: group the (possibly flattened) list into runs led by a direct
    // flex item; any following non-direct elements are hoisted descendants of
    // that item and trail it. Reorder the RUNS by the lead item's `order`
    // (and reverse them for `*-reverse`), then flatten — so flex ordering
    // affects only the items, never the ancestor→descendant paint sequence
    // within an item. For a non-flattened list `directChildren` is omitted, so
    // every element leads its own singleton run and this reduces to the
    // original element-wise order/reverse.
    type Run = { lead: CapturedElement; idx: number; ord: number; items: CapturedElement[] };
    const runs: Run[] = [];
    for (const c of children) {
      const isDirect = directChildren == null || directChildren.has(c);
      if (isDirect || runs.length === 0) {
        runs.push({ lead: c, idx: runs.length, ord: parseInt(c.styles.order ?? "0", 10) || 0, items: [c] });
      } else {
        runs[runs.length - 1].items.push(c);
      }
    }
    const sortedRuns = runs
      .slice()
      .sort((a, b) => a.ord - b.ord || a.idx - b.idx);
    const orderedRuns = reverseFlex ? sortedRuns.reverse() : sortedRuns;
    orderedChildren = orderedRuns.flatMap((rn) => rn.items);
  } else {
    orderedChildren = children;
  }
  const negative: Array<{ z: number; idx: number; el: CapturedElement }> = [];
  const floats: CapturedElement[] = [];
  const inlines: CapturedElement[] = [];
  const zeroOrAuto: CapturedElement[] = [];
  const positive: Array<{ z: number; idx: number; el: CapturedElement }> = [];
  const base: CapturedElement[] = [];
  for (let i = 0; i < orderedChildren.length; i++) {
    const c = orderedChildren[i];
    const pos = c.styles.position;
    const flt = c.styles.float ?? "none";
    const zRaw = c.styles.zIndex;
    const positioned = pos != null && pos !== "static";
    const z = zRaw === "auto" || zRaw === "" || zRaw == null ? NaN : parseInt(zRaw, 10);
    // DM-939: per CSS 2.1 Appendix E step 6 a non-positioned element that
    // STILL establishes a stacking context (transform, opacity < 1,
    // filter, mix-blend-mode, mask, clip-path, isolation, will-change, …)
    // paints at the same level as positioned z:0/auto descendants —
    // AFTER step-3 blocks and step-5 inlines, so it visually paints OVER
    // a later-in-document sibling that doesn't form an SC. Without this,
    // `<span class="card scale-2">` (transform: scale(2)) painted in
    // document order with its non-SC inline-block sibling, which then
    // covered it. Bucket non-positioned SCs into the z:0/auto bucket too.
    // `isOverflowOnlySC` keeps overflow scrollers atomic in normal flow
    // (DM-673), so exclude them from this hoisting.
    const isNonPosSc = !positioned
      && establishesStackingContext(c, parentDisplay)
      && !isOverflowOnlySC(c);
    const treatAsZSorted = positioned
      || (isFlexGrid && !isNaN(z))
      || (paintAsZSorted?.has(c) === true)
      || isNonPosSc;
    if (!treatAsZSorted && flt !== "none") {
      floats.push(c);
    } else if (!treatAsZSorted && paintAsInline?.has(c) === true) {
      // DM-683: hoisted flex/grid items paint at step 5 (inline-level) of
      // the SC, AFTER floats and AFTER step-3 blocks — matches CSS Flexbox
      // 1 §5.4 "Flex items paint exactly the same as inline blocks".
      inlines.push(c);
    } else if (!treatAsZSorted) {
      base.push(c);
    } else if (isNaN(z) || z === 0) {
      // DM-588: per CSS 2.1 Appendix E §6, z-index:0 and z-index:auto paint
      // at the SAME stack level in tree order. z-index:0 does NOT paint
      // above z-index:auto; only z-index >= 1 does. Treating z=0 as positive
      // caused stripe's billing-plan-graphic background gradient SC (z=0)
      // to render on top of its sibling white-card descendants (z=auto)
      // instead of beneath them.
      zeroOrAuto.push(c);
    } else if (z < 0) {
      negative.push({ z, idx: i, el: c });
    } else {
      positive.push({ z, idx: i, el: c });
    }
  }
  negative.sort((a, b) => a.z - b.z || a.idx - b.idx);
  positive.sort((a, b) => a.z - b.z || a.idx - b.idx);
  return [...negative.map((x) => x.el), ...base, ...floats, ...inlines, ...zeroOrAuto, ...positive.map((x) => x.el)];
}


/**
 * Turn a single background-image layer into an SVG <defs> entry. Returns
 * { def, stretchedImage? } where def is always a <pattern>/<linearGradient>/<radialGradient>
 * block that can be referenced via url(#id).
 *
 * For url() sources this honors background-size (auto, cover, contain,
 * explicit px/%/keywords, per-axis), background-position (keywords + %/px),
 * and background-repeat (repeat/no-repeat/repeat-x/repeat-y/round/space).
 */
function buildBackgroundLayerDef(
  id: string, layer: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string = "auto", posCss: string = "0% 0%", repeatCss: string = "repeat",
  intrinsic: { w: number; h: number } | null = null,
  attachment: string = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
): { def: string } {
  // Legacy `-webkit-gradient(linear, ...)` is still emitted by Chromium's
  // computed-style serializer for old CSS that uses it (e.g. the Slashdot
  // mobile header's black→#202020 titlebar). Normalize to modern
  // `linear-gradient(...)` text first so the existing parsers can consume it.
  const normalizedWebkit = convertLegacyWebkitGradient(layer);
  if (normalizedWebkit != null) layer = normalizedWebkit;
  // DM-717: `image-set(...)` / `-webkit-image-set(...)` resolution. Chrome's
  // computed-style serializer returns the FULL image-set string rather than
  // the single chosen candidate, so we have to pick one ourselves. Strategy:
  // prefer the lowest-density candidate (1dppx) since the offscreen capture
  // runs at deviceScaleFactor 1; among same-density candidates, prefer
  // `type("image/webp")` then `png` then `jpeg` then `gif`, matching what
  // Chrome would pick on a standard-density display. Falls back to the first
  // url(...) it finds if no density/type metadata is present.
  const imageSet = /^(?:-webkit-)?image-set\((.+)\)$/i.exec(layer);
  if (imageSet != null) {
    const args = splitTopLevelCommas(imageSet[1]);
    type Cand = { url: string; dppx: number; type: string };
    const cands: Cand[] = [];
    for (const a of args) {
      const t = a.trim();
      // The arg shape is `url(...) [<resolution>] [type(...)]` in any order
      // (per CSS Images 4); pull each piece out independently.
      const urlBlob = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s]+))\s*\)/i.exec(t);
      if (urlBlob == null) continue;
      const rawUrl = (urlBlob[1] ?? urlBlob[2] ?? urlBlob[3]).replace(/\\(.)/g, "$1");
      const dppxMatch = /(?<![a-z])([0-9.]+)\s*(?:dppx|x)\b/i.exec(t);
      const typeMatch = /type\(\s*["']?([^"')]+?)["']?\s*\)/i.exec(t);
      cands.push({
        url: `url("${rawUrl}")`,
        dppx: dppxMatch != null ? parseFloat(dppxMatch[1]) : 1,
        type: typeMatch != null ? typeMatch[1].toLowerCase() : "",
      });
    }
    const TYPE_RANK: Record<string, number> = {
      "image/webp": 4, "image/png": 3, "image/jpeg": 2, "image/jpg": 2, "image/gif": 1, "": 0,
    };
    cands.sort((a, b) => a.dppx - b.dppx || (TYPE_RANK[b.type] ?? 0) - (TYPE_RANK[a.type] ?? 0));
    if (cands.length > 0) layer = cands[0].url;
    else return { def: "" };
  }
  // DM-695: `background-attachment: fixed` anchors the bg image (gradient or
  // raster) to the viewport rather than the element. For gradients this
  // means the gradient axis spans the VIEWPORT box (0,0 → vw,vh); the
  // element rect with `fill="url(#…)"` then shows the portion of that
  // gradient that intersects the element. Previously we always computed
  // gradient axes off the element rect, so a `bg-attachment: fixed`
  // gradient looked identical to a `scroll` one — different from Chrome
  // which only shows a slice through the element's window onto the
  // viewport-spanning gradient (visible color-vibrancy diff on
  // `17-deep-bg-attachment-fixed` panel 1).
  const gradX = (attachment === "fixed" && fixedViewport != null) ? 0 : elX;
  const gradY = (attachment === "fixed" && fixedViewport != null) ? 0 : elY;
  const gradW = (attachment === "fixed" && fixedViewport != null) ? fixedViewport.w : w;
  const gradH = (attachment === "fixed" && fixedViewport != null) ? fixedViewport.h : h;
  const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
  if (linear != null) {
    const repeating = /^repeating-/i.test(layer);
    return { def: buildLinearGradientDef(id, linear[1], repeating, gradW, gradH, gradX, gradY) };
  }
  const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
  if (radial != null) {
    const repeating = /^repeating-/i.test(layer);
    // DM-1121: honor `background-position` for radial gradients. For an
    // auto-sized gradient the image fills the box, so a percentage / keyword
    // position resolves to a zero offset ((box − image) × pct = 0) and only the
    // px component slides the gradient. `parseBgPositionPx` extracts that px
    // component per axis; non-px tokens contribute 0.
    const [offX, offY] = parseBgPositionPx(posCss);
    return { def: buildRadialGradientDef(id, radial[1], repeating, gradX, gradY, gradW, gradH, offX, offY) };
  }
  // DM-550: conic. The raster pre-pass (DM-549) populated `_conicTileCache`
  // with PNG bytes for `(layerText, "${tileW}x${tileH}")` tuples; we look up
  // and embed as <pattern><image>. Parse failure or cache miss returns an
  // empty def → caller skips this layer.
  if (/^(?:repeating-)?conic-gradient\(/i.test(layer)) {
    return { def: buildConicGradientDef(id, layer, elX, elY, w, h, sizeCss, posCss) };
  }
  const urlContent = parseCssUrl(layer);
  if (urlContent != null) {
    return { def: buildImagePatternDef(id, urlContent, elX, elY, w, h, sizeCss, posCss, repeatCss, intrinsic, attachment, fixedViewport) };
  }
  return { def: "" };
}

/**
 * DM-550: Emit a `<pattern><image href="data:image/png;base64,…"/></pattern>`
 * for a single conic-gradient background layer. Looks up the PNG bytes in
 * `_conicTileCache` (populated by `rasterizeConicGradients` in DM-549).
 *
 * Tile size resolves from `sizeCss` against the element rect (mirrors the
 * tile-sizing logic in `conic-raster.ts computeTileSize` so cache lookups
 * line up). Background-position offset is applied to the pattern's x/y attrs.
 *
 * Returns empty string when the cache misses (rasterizer didn't run, or
 * parse failed) — caller skips emission so the warning at line 1631 fires.
 */
function buildConicGradientDef(
  id: string, layer: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string, posCss: string,
): string {
  // Tile size: mirrors `computeTileSize` in conic-raster.ts.
  const trimmed = sizeCss.trim();
  let tileW = w, tileH = h;
  if (trimmed !== "" && trimmed !== "auto" && trimmed !== "cover" && trimmed !== "contain") {
    const parts = trimmed.split(/\s+/);
    const parseDim = (tok: string, basis: number): number => {
      if (tok === "auto") return basis;
      const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px)?$/.exec(tok);
      if (m == null) return basis;
      const v = parseFloat(m[1]);
      const unit = m[2] ?? "px";
      if (unit === "%") return (v / 100) * basis;
      return v;
    };
    tileW = parseDim(parts[0], w);
    tileH = parts.length > 1 ? parseDim(parts[1], h) : tileW;
  }
  const tileWInt = Math.max(1, Math.round(tileW));
  const tileHInt = Math.max(1, Math.round(tileH));
  const sizeKey = `${tileWInt}x${tileHInt}`;
  const sizeCache = _conicTileCache.get(layer);
  const dataUri = sizeCache?.get(sizeKey);
  if (dataUri == null) return "";

  // Background-position: shift the pattern origin so the first tile lands at
  // the right offset on the element. Single-axis tokens default the missing
  // axis to "center"; percent positions resolve against (elementSize - tileSize).
  const posTokens = posCss.trim().split(/\s+/);
  const resolvePos = (tok: string, basis: number, tile: number, axis: "h" | "v"): number => {
    const t = tok.trim();
    if (t === "" || t === "center") return (basis - tile) / 2;
    if (axis === "h" && t === "left") return 0;
    if (axis === "h" && t === "right") return basis - tile;
    if (axis === "v" && t === "top") return 0;
    if (axis === "v" && t === "bottom") return basis - tile;
    const pm = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px)?$/.exec(t);
    if (pm == null) return 0;
    const v = parseFloat(pm[1]);
    const unit = pm[2] ?? "px";
    if (unit === "%") return ((basis - tile) * v) / 100;
    return v;
  };
  const offX = resolvePos(posTokens[0] ?? "0%", w, tileWInt, "h");
  const offY = resolvePos(posTokens[1] ?? posTokens[0] ?? "0%", h, tileHInt, "v");

  const patX = elX + offX;
  const patY = elY + offY;
  return `<pattern id="${id}" x="${r(patX)}" y="${r(patY)}" width="${tileWInt}" height="${tileHInt}" patternUnits="userSpaceOnUse"><image href="${dataUri}" width="${tileWInt}" height="${tileHInt}" preserveAspectRatio="none"/></pattern>`;
}

// buildImagePatternDef (url() background → <pattern>) moved to ./image-pattern.ts (DM-1305).

// Gradient-def builders (buildLinearGradientDef / buildRadialGradientDef + stop parsing) moved to ./gradient-defs.ts (DM-1305).

// Mask + fragment-def builders (buildMaskDef, buildMaskBorder9Slice, rewriteFragmentMaskDef, positionFragment*Def, maskContainAlign) moved to ./mask.ts (DM-1305).

/**
 * Translate a CSS clip-path value into an SVG <clipPath> body anchored at the
 * element's absolute (x, y, w, h). Returns "" for unsupported shapes.
 *
 * Supported:
 *   inset(<t> <r> <b> <l>) — treats percentages as fractions of the element's box
 *   circle(<r> at <x> <y>) — cx/cy via keywords or percentages
 *   ellipse(<rx> <ry> at <x> <y>)
 *   polygon(<x1> <y1>, <x2> <y2>, ...) — supports percentages and px values
 *
 * Unsupported (returns ""): path(), geometry-box references, complex shape mixes.
 */
/**
 * Translate an element's CSS `clip-path` into an SVG clip-shape string, honoring
 * the optional `<geometry-box>` keyword (DM-818): the shape is positioned
 * relative to the named box, so `padding-box` / `content-box` inset the
 * reference rect by the element's border (and padding) widths before translating
 * the shape. Pure (no closure state). Returns "" when the value is a fragment
 * ref / untranslatable — the caller then tries the inline-`<clipPath>` path.
 */
function clipPathShapeForElement(el: CapturedElement, clipPathCss: string): string {
  const geoBoxMatch = /\b(content-box|padding-box|border-box|margin-box|fill-box|stroke-box|view-box)\b/i.exec(clipPathCss);
  const geoBox = geoBoxMatch != null ? geoBoxMatch[1].toLowerCase() : "border-box";
  const shapeValue = geoBoxMatch != null ? (clipPathCss.slice(0, geoBoxMatch.index) + clipPathCss.slice(geoBoxMatch.index + geoBoxMatch[0].length)).trim() : clipPathCss;
  const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const pdT = parseFloat(el.styles.paddingTop ?? "0") || 0;
  const pdR = parseFloat(el.styles.paddingRight ?? "0") || 0;
  const pdB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
  const pdL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
  let cpX = el.x, cpY = el.y, cpW = el.width, cpH = el.height;
  if (geoBox === "padding-box" || geoBox === "content-box") {
    cpX += bwL; cpY += bwT; cpW -= bwL + bwR; cpH -= bwT + bwB;
    if (geoBox === "content-box") {
      cpX += pdL; cpY += pdT; cpW -= pdL + pdR; cpH -= pdT + pdB;
    }
  }
  return translateClipPath(shapeValue, cpX, cpY, Math.max(0, cpW), Math.max(0, cpH));
}

/**
 * Compose an element's CSS 2D transform into the SVG `<g transform>` value,
 * resolved around the transform-origin in viewport coords (SK-1134). Chrome
 * reports `transform-origin` in px relative to the border box, so add el.x/el.y
 * to reach the viewport space the SVG draws in; an explicit `0px` origin must
 * survive (parseFloat("0px") === 0 is falsy, so guard on Number.isFinite, not
 * `||`, else the bbox center would silently replace `transform-origin: 0 0`).
 * Chrome resolves every transform function to a matrix in computed style, so
 * only matrix() / matrix3d() need translating. Pure (no closure state).
 */
function svgTransformForElement(el: CapturedElement): string {
  const originParts = (el.styles.transformOrigin ?? "").trim().split(/\s+/);
  const parsedOX = parseFloat(originParts[0] ?? "");
  const parsedOY = parseFloat(originParts[1] ?? "");
  const tOriginX = el.x + (Number.isFinite(parsedOX) ? parsedOX : el.width / 2);
  const tOriginY = el.y + (Number.isFinite(parsedOY) ? parsedOY : el.height / 2);
  return cssTransformToSvg(el.styles.transform, tOriginX, tOriginY);
}

// translateClipPath (CSS clip-path basic-shape → SVG) moved to ./clip-path.ts (DM-1305).

/**
 * Translate CSS object-fit + object-position to an SVG preserveAspectRatio
 * attribute. Best-effort — SVG does not cover every CSS combination exactly.
 *
 * Mapping:
 *   fill         -> 'none' (stretch both axes, may distort)
 *   contain      -> '<align> meet' (fit inside, letterbox)
 *   cover        -> '<align> slice' (fill, crop)
 *   none         -> not representable without intrinsic size info; 'none' stretch is the least-bad default
 *   scale-down   -> treated as 'contain' (common case; exact rule requires intrinsic size)
 *
 * object-position keywords (top/right/bottom/left/center) and '0% 0%' / '100% 100%'
 * map to xMin/xMid/xMax + yMin/yMid/yMax. Percentages are bucketed to thirds
 * since SVG has no finer-grained alignment.
 */
/**
 * DM-819: rewrite an SVG-source data URI so its top-level `<svg>` declares
 * `width=consumerW height=consumerH preserveAspectRatio="<par>"`. Chrome
 * ignores the outer `<image>`'s `preserveAspectRatio` when the source is
 * SVG (paints at the SVG's own intrinsic size), but it does honor the
 * embedded SVG's own preserveAspectRatio. Baking the alignment into the
 * inner SVG lets `object-fit: cover` on an `<img>` referencing an SVG file
 * actually slice. Returns the input unchanged for raster sources or when
 * the inner SVG can't be parsed.
 */
export function rewriteSvgDataUriPreserveAspectRatio(
  dataUri: string, w: number, h: number, par: string,
): string {
  if (!/^data:image\/svg\+xml/i.test(dataUri)) return dataUri;
  // Decode payload: support base64 or URL-encoded forms.
  const m = /^data:image\/svg\+xml(;base64)?,(.*)$/is.exec(dataUri);
  if (m == null) return dataUri;
  const isBase64 = m[1] != null;
  let svgText: string;
  try {
    svgText = isBase64 ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
  } catch { return dataUri; }
  // Find the first <svg ...> opening tag and rewrite its attrs.
  const tagMatch = /<svg\b([^>]*)>/i.exec(svgText);
  if (tagMatch == null) return dataUri;
  let attrs = tagMatch[1];
  const stripAttr = (name: string): void => {
    const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i");
    attrs = attrs.replace(re, "");
  };
  stripAttr("width");
  stripAttr("height");
  stripAttr("preserveAspectRatio");
  const newAttrs = `${attrs.replace(/\s+$/, "")} width="${r(w)}" height="${r(h)}" preserveAspectRatio="${par}"`;
  const newSvg = svgText.slice(0, tagMatch.index) + `<svg${newAttrs}>` + svgText.slice(tagMatch.index + tagMatch[0].length);
  return `data:image/svg+xml;base64,${Buffer.from(newSvg, "utf8").toString("base64")}`;
}

export function preserveAspectRatioFor(fit: string | undefined, pos: string | undefined): string {
  const f = (fit ?? "fill").trim();
  if (f === "fill" || f === "none") return "none";
  const align = alignFromObjectPosition(pos ?? "50% 50%");
  const mode = f === "cover" ? "slice" : "meet";
  return `${align} ${mode}`;
}

/**
 * Parse an object-position value into horizontal / vertical percentages.
 * Used by object-fit: none to position the intrinsic-size image inside the
 * element box.
 */
function parseObjectPosition(pos: string): { hPct: number; vPct: number } {
  const tokens = pos.trim().split(/\s+/);
  let hPct = 50, vPct = 50;
  const setH = (t: string): void => {
    if (t === "left") hPct = 0;
    else if (t === "right") hPct = 100;
    else if (t === "center") hPct = 50;
    else if (/%$/.test(t)) hPct = parseFloat(t);
  };
  const setV = (t: string): void => {
    if (t === "top") vPct = 0;
    else if (t === "bottom") vPct = 100;
    else if (t === "center") vPct = 50;
    else if (/%$/.test(t)) vPct = parseFloat(t);
  };
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t === "top" || t === "bottom") setV(t);
    else setH(t);
  } else if (tokens.length >= 2) {
    setH(tokens[0]);
    setV(tokens[1]);
  }
  return { hPct, vPct };
}

function alignFromObjectPosition(pos: string): string {
  // Parse up to two tokens. Accept keywords (top/right/bottom/left/center) or '<n>%'.
  const tokens = pos.trim().split(/\s+/);
  let hPct = 50;
  let vPct = 50;
  const setH = (t: string): void => {
    if (t === "left") hPct = 0;
    else if (t === "right") hPct = 100;
    else if (t === "center") hPct = 50;
    else if (/%$/.test(t)) hPct = parseFloat(t);
  };
  const setV = (t: string): void => {
    if (t === "top") vPct = 0;
    else if (t === "bottom") vPct = 100;
    else if (t === "center") vPct = 50;
    else if (/%$/.test(t)) vPct = parseFloat(t);
  };
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t === "top" || t === "bottom") setV(t);
    else setH(t);
  } else if (tokens.length >= 2) {
    setH(tokens[0]);
    setV(tokens[1]);
  }
  const xAlign = hPct < 33 ? "xMin" : hPct > 67 ? "xMax" : "xMid";
  const yAlign = vPct < 33 ? "YMin" : vPct > 67 ? "YMax" : "YMid";
  return `${xAlign}${yAlign}`;
}

/**
 * Format a list-item marker label for the given list-style-type + 1-based index.
 * Supports the most common values. Unknown types fall back to decimal.
 */
export function formatListMarker(type: string, n: number): string {
  switch (type) {
    case "decimal": return String(n);
    case "decimal-leading-zero": return n < 10 ? "0" + n : String(n);
    case "lower-alpha":
    case "lower-latin":
      return alphaMarker(n, /*upper*/ false);
    case "upper-alpha":
    case "upper-latin":
      return alphaMarker(n, /*upper*/ true);
    case "lower-roman":
      return romanMarker(n).toLowerCase();
    case "upper-roman":
      return romanMarker(n);
    case "lower-greek":
      return greekMarker(n);
    // DM-1114: non-decimal numbering systems from the CSS Counter Styles spec.
    // Falling through to `String(n)` painted plain `1 2 3` where Chrome paints
    // the script's numerals. armenian / georgian / hebrew are additive systems;
    // arabic-indic / cjk-decimal are positional digit substitutions.
    case "armenian":
    case "upper-armenian":
      return additiveMarker(n, ARMENIAN_UPPER, 1, 9999);
    case "lower-armenian":
      return additiveMarker(n, ARMENIAN_LOWER, 1, 9999);
    case "georgian":
      return additiveMarker(n, GEORGIAN, 1, 19999);
    case "hebrew":
      return additiveMarker(n, HEBREW, 1, 10999);
    case "arabic-indic":
      return digitSubstMarker(n, "٠١٢٣٤٥٦٧٨٩");
    case "cjk-decimal":
      return digitSubstMarker(n, "〇一二三四五六七八九");
    default:
      return String(n);
  }
}

// DM-1114: marker suffix per CSS Counter Styles. Most predefined styles use the
// default `. `; the CJK ideographic styles use the ideographic comma `、`. We
// only emit the visible suffix char (the trailing space is layout, already
// encoded in the captured marker x). Mirrors the per-style `suffix` descriptor.
// DM-1119: collapse runs of horizontal whitespace in a list-marker label to a
// single space, mirroring the `white-space: normal` of Chrome's `::marker`. A
// `@counter-style` `suffix: ":  "` reaches us as a label with a doubled space;
// Chrome paints only one, so without this the marker drifts left of Chrome.
export function collapseMarkerWhitespace(label: string): string {
  return label.replace(/[^\S\n]+/g, " ");
}

export function listMarkerSuffix(type: string): string {
  switch (type) {
    case "cjk-decimal":
    case "cjk-earthly-branch":
    case "cjk-heavenly-stem":
      return "、";
    default:
      return ".";
  }
}

// Positional (numeric-system) marker: substitute each base-10 digit of `n` with
// the matching glyph from a 10-char symbol set (index 0 = '0'). Used for
// arabic-indic and cjk-decimal.
function digitSubstMarker(n: number, digits: string): string {
  if (n < 0) return "-" + digitSubstMarker(-n, digits);
  const chars = [...digits];
  return String(n).split("").map((d) => chars[d.charCodeAt(0) - 48] ?? d).join("");
}

// Additive-system marker (CSS Counter Styles `system: additive`): greedily
// subtract the largest weight ≤ remaining, appending its symbol. Out-of-range
// values fall back to decimal, matching the spec's range clamp.
function additiveMarker(n: number, table: ReadonlyArray<readonly [number, string]>, lo: number, hi: number): string {
  if (n < lo || n > hi) return String(n);
  let v = n;
  let s = "";
  for (const [weight, sym] of table) {
    while (v >= weight && weight > 0) { s += sym; v -= weight; }
  }
  return s;
}

// Armenian uppercase numerals (U+0531…), descending additive weights 9000…1.
const ARMENIAN_UPPER: ReadonlyArray<readonly [number, string]> = [
  [9000, "Ք"], [8000, "Փ"], [7000, "Ւ"], [6000, "Ց"], [5000, "Ր"], [4000, "Տ"], [3000, "Վ"], [2000, "Ս"], [1000, "Ռ"],
  [900, "Ջ"], [800, "Պ"], [700, "Չ"], [600, "Ո"], [500, "Շ"], [400, "Ն"], [300, "Յ"], [200, "Մ"], [100, "Ճ"],
  [90, "Ղ"], [80, "Ձ"], [70, "Հ"], [60, "Կ"], [50, "Ծ"], [40, "Խ"], [30, "Լ"], [20, "Ի"], [10, "Ժ"],
  [9, "Թ"], [8, "Ը"], [7, "Է"], [6, "Զ"], [5, "Ե"], [4, "Դ"], [3, "Գ"], [2, "Բ"], [1, "Ա"],
];
// Armenian lowercase is the uppercase set shifted +0x30 (U+0561…).
const ARMENIAN_LOWER: ReadonlyArray<readonly [number, string]> = ARMENIAN_UPPER.map(
  ([w, sym]) => [w, String.fromCodePoint(sym.codePointAt(0)! + 0x30)] as const,
);
// Georgian numerals (Mkhedruli), descending additive weights 10000…1.
const GEORGIAN: ReadonlyArray<readonly [number, string]> = [
  [10000, "ჵ"], [9000, "ჰ"], [8000, "ჯ"], [7000, "ჴ"], [6000, "ხ"], [5000, "ჭ"], [4000, "წ"], [3000, "ძ"], [2000, "ც"], [1000, "ჩ"],
  [900, "შ"], [800, "ყ"], [700, "ღ"], [600, "ქ"], [500, "ფ"], [400, "ჳ"], [300, "ტ"], [200, "ს"], [100, "რ"],
  [90, "ჟ"], [80, "პ"], [70, "ო"], [60, "ჲ"], [50, "ნ"], [40, "მ"], [30, "ლ"], [20, "კ"], [10, "ი"],
  [9, "თ"], [8, "ჱ"], [7, "ზ"], [6, "ვ"], [5, "ე"], [4, "დ"], [3, "გ"], [2, "ბ"], [1, "ა"],
];
// Hebrew numerals, descending additive weights. 15 and 16 use טו / טז (not יה /
// יו) to avoid spelling forms of the divine name — explicit entries so the
// greedy walk picks them over 10+5 / 10+6.
const HEBREW: ReadonlyArray<readonly [number, string]> = [
  [400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"],
  [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"], [40, "מ"], [30, "ל"], [20, "כ"],
  [19, "יט"], [18, "יח"], [17, "יז"], [16, "טז"], [15, "טו"], [10, "י"],
  [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"],
];

function alphaMarker(n: number, upper: boolean): string {
  if (n <= 0) return String(n);
  const base = upper ? 65 : 97;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(base + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// CSS `lower-greek` walks the 24 letters of the Greek alphabet (α..ω, no
// final-sigma ς), then doubles up (αα, αβ, αγ, …) just like lower-alpha.
function greekMarker(n: number): string {
  if (n <= 0) return String(n);
  // U+03B1 α through U+03C9 ω, but skip U+03C2 ς (final sigma) — only 24
  // letters in the CSS counter style. Build the explicit alphabet so we
  // don't have to special-case the U+03C2 hole.
  const greek = "αβγδεζηθικλμνξοπρστυφχψω"; // 24 chars
  let s = "";
  let v = n;
  while (v > 0) {
    v--;
    s = greek.charAt(v % 24) + s;
    v = Math.floor(v / 24);
  }
  return s;
}

function romanMarker(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let s = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { s += syms[i]; n -= vals[i]; }
  }
  return s;
}




/**
 * Per-side adjusted dash array. Chrome'\''s dashed/dotted border rasterizer
 * (see Blink `BoxPainterBase::PaintBorderSides`) sizes each side'\''s dash
 * cycle so dashes start and end exactly at the corners — otherwise the last
 * dash before a corner is partial and the pattern looks ragged.
 *
 * Algorithm: ideal period (dash + gap) is `4 * width` for dashed, `2 * width`
 * for dotted. Compute cycle count `N = round(sideLength / period)` (clamped
 * to ≥1), then scale dash and gap by `sideLength / (N * period)` so
 * `N * (dash + gap) === sideLength` exactly.
 *
 * Returns "" when style isn'\''t dashed/dotted, or when the side is too short
 * to fit even one cycle (renderer falls back to solid).
 */
function adjustedDashArray(style: string, width: number, sideLength: number): string {
  return adjustedDashAttrs(style, width, sideLength).array;
}

/**
 * Returns the `stroke-dasharray` value AND the matching `stroke-dashoffset`
 * needed to center the dash pattern within the side so it visually matches
 * Chromium's BoxBorderPainter (DM-318).
 *
 * For dotted: Chromium centres each dot in its half-period slot — i.e. dots
 *   are inset from each corner by half a period rather than starting flush.
 *   In SVG terms, the dasharray is `0.01 period` with linecap=round (so each
 *   "dash" renders as a single dot), and stroke-dashoffset is set to half a
 *   period so the line starts mid-gap and the first dot appears at period/2.
 *
 * For dashed: Chromium also tends to center the dash pattern — the first
 *   dash starts at gap/2 from the corner so each side has equal margin. The
 *   prior implementation started the cycle with a full dash flush at the
 *   corner, which left a visible phase offset vs Chrome's painted output.
 *
 * Returns offset as a number (0 if no shift needed), the caller emits a
 * `stroke-dashoffset` attribute when offset !== 0.
 */
function adjustedDashAttrs(style: string, width: number, sideLength: number): { array: string; offset: number } {
  if (sideLength <= 0 || width <= 0) return { array: "", offset: 0 };
  // DM-805: faithful port of Chromium's `DashEffectFromStrokeStyle` +
  // `SelectBestDashGap` from
  // `third_party/blink/renderer/platform/graphics/styled_stroke_data.cc`.
  // The previous implementation scaled the dash/gap pair to fit a whole
  // number of cycles AND offset the start by gap/2 — visually close but not
  // pixel-matching Chrome (Chrome keeps the natural dash size + only adjusts
  // the gap + starts flush at the corner). Verified against painted output
  // on the `18-border-styles` fixture: 6 px dashed on a 188 px side paints
  // 11 dashes (dash=12 / gap=5.6, flush at corner), NOT 10 dashes (12.53 /
  // 6.27 / mid-gap-offset) as the old algorithm emitted.
  const selectBestDashGap = (strokeLength: number, dashLength: number, gapLength: number): number => {
    // Open path only (closed_path = false in BoxBorderPainter — each side
    // is drawn as a separate line, even for rounded-corner borders which
    // use a curved path and handle that path-length math separately).
    const availableLength = strokeLength + gapLength;
    const minNumDashes = Math.floor(availableLength / (dashLength + gapLength));
    const maxNumDashes = minNumDashes + 1;
    const minNumGaps = Math.max(1, minNumDashes - 1);
    const maxNumGaps = Math.max(1, maxNumDashes - 1);
    const minGap = (strokeLength - minNumDashes * dashLength) / minNumGaps;
    const maxGap = (strokeLength - maxNumDashes * dashLength) / maxNumGaps;
    if (maxGap <= 0) return minGap;
    return Math.abs(minGap - gapLength) < Math.abs(maxGap - gapLength) ? minGap : maxGap;
  };
  if (style === "dashed") {
    // dash_length = width * (width >= 3 ? 2 : 3); gap_length similarly.
    const dashLen = width * (width >= 3 ? 2 : 3);
    const gapTarget = width * (width >= 3 ? 1 : 2);
    if (sideLength <= dashLen * 2) {
      // Chrome's "no space for dashes" branch — emit a continuous solid
      // line (no dasharray). Below that, "exactly 2 dashes proportionally
      // sized" is a sub-case but the visual is nearly identical to the
      // pixel diff harness; collapse to solid here.
      return { array: "", offset: 0 };
    }
    const gap = selectBestDashGap(sideLength, dashLen, gapTarget);
    if (gap <= 0) return { array: "", offset: 0 };
    // Start flush at the corner — matches Chrome's `MakeDash` with phase 0.
    return { array: `${r(dashLen)} ${r(gap)}`, offset: 0 };
  }
  if (style === "dotted") {
    // Chrome's thick-dotted branch (`!StrokeIsDashed(width, kDottedStroke)`
    // — true for width > 3):
    //   1. The line endpoints are first moved IN by width/2 (round endcap
    //      fits inside the line). Caller is responsible for that inward
    //      move via cornerTrim = width/2 (see element-tree-to-svg's per-
    //      side emit loop) so `sideLength` here is the POST-move length.
    //   2. SelectBestDashGap with dash_length = gap_length = width.
    //   3. dasharray = [0, gap + width - epsilon] with round caps —
    //      produces a dot of diameter `width` per cycle.
    // Note: the legacy `cornerTrim = bt.w >= 8 ? inset : 0` rule meant
    // thin (< 8 px) dotted borders skipped the inward move; the per-side
    // emit loop now insets dotted always so this entry point sees the
    // chromy effective length.
    if (sideLength < width * 2) {
      // Chrome's "Not enough space for 2 dots" branch — single dot via a
      // gap longer than the line.
      return { array: `0.01 ${r(width * 2)}`, offset: 0 };
    }
    const gap = selectBestDashGap(sideLength, width, width);
    if (gap <= 0) return { array: "", offset: 0 };
    const kEpsilon = 0.01;
    return { array: `0.01 ${r(gap + width - kEpsilon)}`, offset: 0 };
  }
  return { array: "", offset: 0 };
}
