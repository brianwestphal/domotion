/**
 * DOM-to-SVG Converter
 *
 * Uses Playwright to inspect DOM elements and recreate them as native SVG.
 */

import type { ElementHandle, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as fontkit from "fontkit";
import { renderSingleLineText, renderMultiSegmentText, renderMultiLineText, renderInputText } from "./text.js";
import { getGlyphDefs } from "./text-to-path.js";
import type { DefCtx } from "./form-controls.js";
import { renderFormControl } from "./form-controls.js";
import { CAPTURE_SCRIPT } from "../capture/script.generated.js";
import { r, esc, stopFmt } from "./format.js";
import { parseColor, colorStr, sameColor, shadeColor, type RGBA } from "./colors.js";
import {
  parseCornerRadii,
  insetCornerRadii,
  roundedRectPath,
  roundedRectSvg,
  parseSide,
  dashArrayForStyle,
  renderBorderImage,
  injectSvgSize,
  type CornerRadii,
  type CornerRadiusPair,
  type BorderSide,
} from "./borders.js";
import { parseBoxShadow, type BoxShadow } from "./box-shadow.js";
import { cssTransformToSvg } from "./transforms.js";
import { parseCssUrl, splitTopLevelCommas } from "./css-tokens.js";
import type { CapturedElement, TextSegment, MaskFragmentDef, MaskRasterRef, CaptureWarning } from "../capture/types.js";
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${schemeAttr}>${rootBgRect}${inner}</svg>`;
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
 * Convert a CapturedElement tree into SVG markup.
 */
export function elementTreeToSvg(
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
  };
  // Viewport dims for background-attachment: fixed — passed down into layer def building.
  const captureViewport = { w: width, h: height };

  // DM-473: tracks descendants that have been hoisted into an ancestor
  // stacking context's flat paint list. Their natural-DFS render path is
  // suppressed via this set so we don't double-emit them. Populated by
  // `gatherStackingContextChildren()` whenever we cross into an SC root.
  const hoistedFromAncestor = new Set<CapturedElement>();

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
      const shape = translateClipPath(clipPathCss, el.x, el.y, el.width, el.height);
      if (shape !== "") {
        clipPathUrlId = `${idPrefix}cp${clipIdx++}`;
        defsParts.push(`<clipPath id="${clipPathUrlId}">${shape}</clipPath>`);
      }
    }
    // mask: if mask-image is a gradient or url(), translate it to an SVG <mask>.
    const maskImage = el.styles.maskImage;
    let maskUrlId: string | null = null;
    if (maskImage != null && maskImage !== "none" && maskImage !== "") {
      // DM-493: same-document fragment refs (mask-image: url("#id")) emit the
      // captured inline <mask> verbatim with id rewriting, bypassing the
      // gradient/url() emission path.
      const fragRef = resolveFragmentMaskRef(maskImage, el.x, el.y, el.width, el.height);
      if (fragRef != null) {
        maskUrlId = fragRef;
      } else {
        const maskDef = buildMaskDef(
          `${idPrefix}mk${clipIdx++}`,
          maskImage,
          el.x, el.y, el.width, el.height,
          el.styles.maskMode ?? "match-source",
          el.styles.maskSize ?? "auto",
          el.styles.maskPosition ?? "0% 0%",
          el.styles.maskRepeat ?? "repeat",
          el.styles.maskComposite ?? "add",
          elementMaskRasters,
        );
        if (maskDef.def !== "") {
          maskUrlId = maskDef.id;
          defsParts.push(maskDef.def);
        }
      }
    }
    // CSS 2D transform (SK-1134): wrap the elements rendered group in
    // <g transform=...> composed around the resolved transform-origin in
    // viewport coords. transform-origin is reported by Chrome in pixels
    // relative to the elements border box (e.g. "0px 0px" for top-left,
    // "Npx Mpx" for the 50%-50% default). Add el.x/el.y to convert to the
    // viewport coordinate system the SVG draws in. Chrome resolves every
    // CSS transform function to a matrix in computed style, so we only
    // need to translate matrix() / matrix3d() into SVG syntax.
    const originParts = (el.styles.transformOrigin ?? "").trim().split(/\s+/);
    // parseFloat("0px") === 0, which is falsy — guarding with `||` would
    // silently substitute the bbox center for an explicit `transform-origin: 0 0`
    // (and rotate around the center instead of the top-left).
    const parsedOX = parseFloat(originParts[0] ?? "");
    const parsedOY = parseFloat(originParts[1] ?? "");
    const tOriginX = el.x + (Number.isFinite(parsedOX) ? parsedOX : el.width / 2);
    const tOriginY = el.y + (Number.isFinite(parsedOY) ? parsedOY : el.height / 2);
    const transformAttr = cssTransformToSvg(el.styles.transform, tOriginX, tOriginY);
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
    const styleParts: string[] = [];
    if (filterCss !== "") styleParts.push(`filter:${filterCss}`);
    if (blendCss !== "") styleParts.push(`mix-blend-mode:${blendCss}`);
    if (needsIsolation) styleParts.push("isolation:isolate");
    if (el.displayNone === true) styleParts.push("display:none");
    // DM-486: HTML-escape the style attribute value. Chromium normalises
    // `filter: url(#id)` to `url("#id")` (with quotes) — emitting that raw
    // produced `style="filter:url("#id")"` and broke the SVG parser.
    if (styleParts.length > 0) groupAttrs.push(`style="${esc(styleParts.join(";"))}"`);
    const opened = needsGroup;
    if (opened) svgParts.push(`${indent}<g ${groupAttrs.join(" ")}>`);
    // Inner anim-class wrapper sits INSIDE any visibility/transform group so
    // the merger's class (added on the outer group) and our anim class can
    // each carry their own `animation` shorthand without clobbering.
    if (animClass !== "") svgParts.push(`${indent}<g class="${animClass}">`);

    // Outset box-shadow (SK-1101 + SK-1113): paints BENEATH the element box.
    // CSS spec says the first shadow in the list is closest to the element;
    // later shadows sit further behind. SVG paints later in document order,
    // so to get the same stacking we iterate the list in REVERSE (deepest
    // first). Blur > 0 routes through an SVG <filter feGaussianBlur> with
    // stdDeviation ≈ blur/2 (matches Chromes blur-to-stdDev mapping).
    {
      const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
      for (let si = shadows.length - 1; si >= 0; si--) {
        const sh = shadows[si];
        if (sh.inset) continue;
        if (sh.spread < 0) continue;
        // Rect inflated by spread and shifted by (x, y).
        const sx = el.x + sh.x - sh.spread;
        const sy = el.y + sh.y - sh.spread;
        const sw = el.width + sh.spread * 2;
        const sh2 = el.height + sh.spread * 2;
        if (sw <= 0 || sh2 <= 0) continue;
        // Outer shadow corners: each axis grows by `spread` (clamped at 0)
        // since the shadow rect extends beyond the border-box by spread on
        // every side. Per-corner radii grow uniformly so each corner stays
        // proportional to its source.
        const shadowCorners = insetCornerRadii(corners, -sh.spread, -sh.spread, -sh.spread, -sh.spread);
        let filterAttr = "";
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}sh${clipIdx++}`;
          // Filter region needs to extend beyond the shadow rect by enough
          // padding to keep the Gaussian fall-off from clipping. Use a
          // generous 200% on each side; primitiveUnits inherits the default
          // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
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

    // Background rect(s). CSS lets backgrounds stack via background-image with
    // a comma-separated list of linear/radial gradients and url() images. The
    // first layer paints on top — we emit in reverse so the rect order matches
    // CSS layering. The background-color paints *under* all layers.
    if (!suppressEmptyCell && bgColor != null && bgColor.a > 0.01) {
      svgParts.push(
        `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="${colorStr(bgColor)}"`)}`,
      );
    } else if (!suppressEmptyCell && el.styles.frostedBgFallback != null) {
      // DM-476: backdrop-filter has no SVG equivalent, so when this element
      // would have read as a frosted-glass surface in Chromium (transparent
      // bg + non-trivial backdrop-filter), paint the captured body-bg
      // color as an opaque fill so the element at least covers what's
      // behind it. See docs/19-frosted-backdrop-fallback.md.
      svgParts.push(
        `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="${el.styles.frostedBgFallback}"`)}`,
      );
    }
    // DM-462: when the element uses `background-clip: text`, the first
    // text-clipped layer's gradient/image is captured here and used as the
    // fill on the text glyph group (instead of painting it as a normal
    // <rect fill=url(#bg)> over the headline area). Initialized to null and
    // assigned in the bg-layer loop below.
    let textBgClipFill: string | null = null;

    const bgImage = el.styles.backgroundImage;
    if (bgImage != null && bgImage !== "none" && bgImage !== "") {
      const layers = splitTopLevelCommas(bgImage);
      const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
      const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
      const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
      const clipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
      const originLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
      const attachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
      const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
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
        const defId = `${idPrefix}bg${clipIdx++}`;
        // Pattern is positioned + sized relative to the origin box (where the image starts)
        // then painted into a rect clipped to the clip box. For fixed attachment
        // the origin is the viewport instead.
        const out = buildBackgroundLayerDef(defId, layer, originBox.x, originBox.y, originBox.w, originBox.h, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport);
        if (out.def === "") continue;
        defsParts.push(out.def);
        // DM-462: when this layer's clip is `text`, do NOT paint a rect over
        // the headline area — the gradient should appear inside the glyph
        // shapes only. Stash the def URL so the text-rendering block below
        // can use it as the glyph fill (the first text-clipped layer wins).
        // The non-text-clipped layers (if any) still emit normally.
        if (layerClip === "text") {
          if (textBgClipFill == null) textBgClipFill = `url(#${defId})`;
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
        svgParts.push(
          `${indent}${roundedRectSvg(clipBox.x, clipBox.y, clipBox.w, clipBox.h, innerCorners, `fill="url(#${defId})"`)}`,
        );
      }
    }

    // Inset box-shadow (SK-1111): per CSS paint order this sits ON TOP of
    // the background layers but BEHIND the border. Outset shadows would sit
    // underneath the entire box and aren't supported in this pass — only
    // inset, no blur, with non-negative spread is handled (sufficient for the
    // common "padding visualizer" pattern: box-shadow: inset 0 0 0 NNpx
    // <color>). Anything fancier falls through silently and becomes a
    // follow-up. See SK-1111.
    {
      const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
      // Border widths — re-parse here because the bg-layer block above (where
      // bwL/bwR/bwT/bwB are computed) is conditional on backgroundImage.
      const sbwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const sbwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const sbwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const sbwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      // Border-inner box (where inset shadow paints).
      const ibLeft = el.x + sbwL;
      const ibTop = el.y + sbwT;
      const ibW = Math.max(0, el.width - sbwL - sbwR);
      const ibH = Math.max(0, el.height - sbwT - sbwB);
      // Border-inner per-corner radii: each corner shrinks by the adjacent
      // border-side widths. Used as the basis for the inset-shadow stroke
      // path; the final ring radius will subtract sp/2 for stroke centering.
      const innerCorners = insetCornerRadii(corners, sbwT, sbwR, sbwB, sbwL);
      for (const sh of shadows) {
        if (!sh.inset) continue;
        // Skip non-trivial shadows we cant emit accurately — anything with
        // an x/y offset (asymmetric inset glow not supported), negative
        // spread, or zero spread + zero blur (paints nothing).
        if (sh.x !== 0 || sh.y !== 0) continue;
        if (sh.spread < 0) continue;
        if (sh.spread === 0 && sh.blur === 0) continue;
        if (ibW <= 0 || ibH <= 0) continue;
        // Render the inset shadow as a stroked rect at the inside-the-border
        // edge, clipped to inside the border-box so the stroke (and the blur
        // halo, if any) only show on the inner side of the edge. Stroke is
        // centered on the path; the clipPath drops the outward half so the
        // visible thickness is half the stroke width. For pure-spread (no
        // blur) we want a sharp `spread`-wide ring, so stroke-width = 2 *
        // spread. For pure-blur (no spread) we use a thin baseline ring of
        // blur-width pixels — the blur then produces the visible falloff;
        // a larger ring overpaints, smaller produces too-faint output.
        // Combined spread + blur sums both: visible band = spread, with the
        // blur softening the inner edge. Previously the code used
        // max(spread, blur) as both stroke width AND inward offset, which
        // conflated blur with spread and painted pure-blur insets as a
        // thick solid ring. DM-304.
        // For pure-blur (no spread) we use a `blur`-wide ring centered on the
        // inner edge — half (blur/2) shows inside the clip, half is clipped
        // away on the outer side. The Gaussian then softens that band into
        // Chrome's characteristic inset glow falloff (DM-366). Previously the
        // ring was 1px wide and the blur made it nearly invisible.
        // For pure-blur (no spread) we use a `blur/2`-wide ring centered on
        // the inner edge. Half (blur/4) shows inside the clip; the Gaussian
        // (stdDev = blur/2) softens that band into Chrome's characteristic
        // inset-glow falloff. A 1px ring is too faint; a `blur`-wide ring is
        // too strong (DM-366).
        const ringWidth = Math.max(2 * sh.spread, sh.blur / 2, 1);
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
        const strokeColor = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
        svgParts.push(
          `${indent}<g clip-path="url(#${cid})">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, `fill="none" stroke="${strokeColor}" stroke-width="${r(ringWidth)}"${filterAttr}`)}</g>`,
        );
      }
    }

    // Border-image: if a URL source with intrinsic dimensions is present,
    // emit a 9-slice composition and SKIP the plain-border fallback below.
    // Gradient sources are not supported in this pass (tracked as follow-up).
    const borderImageMarkup = renderBorderImage(el, indent, idPrefix, defsParts, clipIdx);
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
    } else if (borderImagePainted) {
      // Border visual came from border-image. Skip the plain-border emission.
    } else if (uniform && bt != null && bt.w > 0) {
      const style = bt.style;
      if (style === "double" && bt.w >= 3) {
        // CSS double border: two parallel strokes each 1/3 of border-width,
        // separated by 1/3 gap. Our captured rect is the border box (outer
        // edge), so strokes need their centerlines at 1/6*w (outer) and
        // 5/6*w (inner) inside the border box.
        const strokeW = bt.w / 3;
        const outerInset = bt.w / 6;
        const innerInset = bt.w * 5 / 6;
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
        const collapse = el.styles.borderCollapse === "collapse";
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
        // For thick (≥ 5 px) dashed/dotted borders, shorten each side by
        // `inset` (= half stroke width) at both ends so adjacent sides
        // meet at corners without overlap. With butt linecaps the line
        // ink stops at exactly the line endpoint, so top + left don'\\'t
        // both paint the same corner pixel. Chrome'\\'s BoxBorderPainter
        // does the equivalent via per-side clipping — without this trim
        // our 4-line dashed/dotted emit double-paints the corners as a
        // darker square (DM-402, visible on the 10 px dashed border in
        // `17-bg-color-image`). Thin borders skip the trim because the
        // half-stroke gap (~1.5 px on a 3 px border) leaves a visible
        // hole at corners.
        const cornerTrim = bt.w >= 8 ? inset : 0;
        const sides: Array<[number, number, number, number, number]> = [
          [bL + cornerTrim, bT + inset, bR - cornerTrim, bT + inset, bR - bL - 2 * cornerTrim],
          [bR - inset, bT + cornerTrim, bR - inset, bB - cornerTrim, bB - bT - 2 * cornerTrim],
          [bL + cornerTrim, bB - inset, bR - cornerTrim, bB - inset, bR - bL - 2 * cornerTrim],
          [bL + inset, bT + cornerTrim, bL + inset, bB - cornerTrim, bB - bT - 2 * cornerTrim],
        ];
        for (const [x1, y1, x2, y2, len] of sides) {
          const { array: dash, offset } = adjustedDashAttrs(style, bt.w, len);
          const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
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
        const collapse = el.styles.borderCollapse === "collapse";
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
      const collapse = el.styles.borderCollapse === "collapse";
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
      for (let i = 0; i < sides.length; i++) {
        const [side, x1, y1, x2, y2, len] = sides[i];
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style === "none" || side.style === "hidden") continue;
        if (useTrapezoid(side)) {
          // Emit as a polygon trapezoid that tapers correctly at corners.
          svgParts.push(
            `${indent}<polygon points="${trapezoids[i][1]}" fill="${colorStr(side.color)}" />`,
          );
          continue;
        }
        if (side.style === "double" && side.w >= 3 && !collapse) {
          // Two parallel strokes, each w/3 wide, separated by a w/3 gap.
          // Outer stroke center sits at (sideCenter + outerNormal * w/3),
          // inner at (sideCenter + innerNormal * w/3). Each stroke = w/3 thick.
          const strokeW = side.w / 3;
          const offset_ = side.w / 3;
          const [oxN, oyN, ixN, iyN] = doubleSides[i];
          const ox = oxN * offset_, oy = oyN * offset_;
          const ix = ixN * offset_, iy = iyN * offset_;
          svgParts.push(
            `${indent}<line x1="${r(x1 + ox)}" y1="${r(y1 + oy)}" x2="${r(x2 + ox)}" y2="${r(y2 + oy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}" />`,
          );
          svgParts.push(
            `${indent}<line x1="${r(x1 + ix)}" y1="${r(y1 + iy)}" x2="${r(x2 + ix)}" y2="${r(y2 + iy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}" />`,
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
        svgParts.push(
          `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dashAttrs}${linecap} />`,
        );
      }
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
    {
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
            svgParts.push(
              `${indent}<rect x="${r(ox - half)}" y="${r(oy - half)}" width="${r(owd + 2 * half)}" height="${r(oh + 2 * half)}" rx="${r(outerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
            );
            svgParts.push(
              `${indent}<rect x="${r(ox + half)}" y="${r(oy + half)}" width="${r(owd - 2 * half)}" height="${r(oh - 2 * half)}" rx="${r(innerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
            );
          } else {
            const dash = dashArrayForStyle(ostyle, ow);
            const linecap = "";
            svgParts.push(
              `${indent}<rect x="${r(ox)}" y="${r(oy)}" width="${r(owd)}" height="${r(oh)}" rx="${r(oRadius)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
            );
          }
        }
      }
    }

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
      // group). Without these closes, an inline-SVG element with `opacity < 1`
      // (or any other group-triggering style) emits an unbalanced `<g>` and
      // breaks the document — observable on resend/stripe whose nav chevrons
      // sit inside `opacity: 0.7` wrappers.
      if (animClass !== "") svgParts.push(`${indent}</g>`);
      if (opened) svgParts.push(`${indent}</g>`);
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
      if (fit === "none" && el.imageIntrinsic != null && el.imageIntrinsic.w > 0 && el.imageIntrinsic.h > 0) {
        // object-fit: none -> render image at intrinsic size, aligned via
        // object-position inside the element's content box, and clip overflow.
        const iw = el.imageIntrinsic.w;
        const ih = el.imageIntrinsic.h;
        const { hPct, vPct } = parseObjectPosition(el.styles.objectPosition ?? "50% 50%");
        const ix = contentX + (contentW - iw) * (hPct / 100);
        const iy = contentY + (contentH - ih) * (vPct / 100);
        const clipId = `${idPrefix}ifn${clipIdx++}`;
        defsParts.push(`<clipPath id="${clipId}"><rect x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" /></clipPath>`);
        svgParts.push(
          `${indent}<image href="${esc(embedResizedDataUri(el.imageSrc, iw, ih))}" x="${r(ix)}" y="${r(iy)}" width="${r(iw)}" height="${r(ih)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`,
        );
      } else {
        const par = preserveAspectRatioFor(fit, el.styles.objectPosition);
        svgParts.push(
          `${indent}<image href="${esc(embedResizedDataUri(el.imageSrc, contentW, contentH))}" x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" preserveAspectRatio="${par}" />`,
        );
      }
    }

    // DM-457: rasterized snapshot for <canvas> / <video> / <iframe> /
    // <object> / <embed>. The post-capture rasterizeReplacedElements pass
    // hid everything else on the page and screenshot the element's content
    // box, so the data URI is exactly the painted pixels Chrome put inside
    // the element's borders + padding. Painted on top of the normal bg/border
    // and inside the element's own borders, mirroring how <img> sits inside
    // its element box. preserveAspectRatio="none" matches the captured
    // content-box rect dimensions exactly.
    //
    // DM-598: skip when the element ALSO has imageSrc — that means it's an
    // <img> that picked up a sprite-icon snapshot, and the imageSrc branch
    // above already emitted the correctly aspected <image>. Capture-side has
    // the same guard, but the render-side check protects against any other
    // future path that sets both.
    if (el.replacedSnapshot != null && el.replacedSnapshot.dataUri != null && el.imageSrc == null) {
      const rs = el.replacedSnapshot;
      // DM-506: when this is an image-replacement icon (sprite + off-screen
      // text), wrap the painted raster with an SVG <title> so screen readers
      // and tooltip UAs still surface the suppressed accessible label.
      if (el.imageReplacement != null && el.imageReplacement.titleText !== "") {
        svgParts.push(
          `${indent}<image href="${rs.dataUri}" x="${r(rs.x)}" y="${r(rs.y)}" width="${r(rs.width)}" height="${r(rs.height)}" preserveAspectRatio="none"><title>${esc(el.imageReplacement.titleText)}</title></image>`,
        );
      } else {
        svgParts.push(
          `${indent}<image href="${rs.dataUri}" x="${r(rs.x)}" y="${r(rs.y)}" width="${r(rs.width)}" height="${r(rs.height)}" preserveAspectRatio="none" />`,
        );
      }
    }

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
          svgParts.push(
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
          const markerFontFamily = el.markerFontFamily ?? el.styles.fontFamily;
          // Position: marker right-aligned just left of the li's content edge,
          // mirroring the text-marker branch below.
          const smallGap = 4;
          const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
          const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          const mx = outside ? el.x - smallGap : el.x + borderL + padL;
          const anchor = outside ? "end" : "start";
          const escLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          svgParts.push(
            `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}">${escLabel}</text>`,
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
            svgParts.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="${markerColor}" />`);
          } else if (lsType === "circle") {
            svgParts.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="none" stroke="${markerColor}" stroke-width="1" />`);
          } else {
            svgParts.push(`${indent}<rect x="${r(mx - r0)}" y="${r(shapeY - r0)}" width="${r(r0 * 2)}" height="${r(r0 * 2)}" fill="${markerColor}" />`);
          }
        } else {
          // Text-based marker (decimal / lower-alpha / lower-roman / etc.).
          // Chrome's default ::marker is right-aligned within the marker box
          // with a small UA-defined gap to the content (~4px on macOS Chrome).
          // Anchor to `el.x - smallGap` with text-anchor="end" so the marker's
          // right edge sits just left of the principal block — guessing the
          // marker's rendered width is unreliable across font fallbacks
          // ("1." is 11.5px in Helvetica, 13.6px in Inter, 18px in Courier),
          // and getting it ~10px wrong drives the entire visible offset.
          const label = formatListMarker(lsType, idx) + ".";
          // DM-447: numeric / alpha / roman markers are painted with a ~8px
          // gap from the principal-block edge in Chrome (vs the previous
          // 4px estimate, which placed the marker too far right). Empirical
          // pixel measurement vs Chrome's painted output on the
          // 03-lists-marker fixture (16px monospace bold "1.") shows the
          // marker right edge sits ~7-8px left of li.x. The fixed-width
          // approximation is safer than text_width × heuristic since
          // monospace vs proportional font advance varies widely.
          const smallGap = 8;
          const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
          const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
          const mx = outside ? el.x - smallGap : el.x + borderL + padL;
          const anchor = outside ? "end" : "start";
          const markerFontFamily = el.markerFontFamily ?? el.styles.fontFamily;
          svgParts.push(
            `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}">${label}</text>`,
          );
        }
      }
    }

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
      const fillColor = (textBgClipFill != null && textIsTransparent)
        ? textBgClipFill
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
        svgParts.push(`${indent}<image href="${er.dataUri}" x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${cid})"/>`);
      } else {

      const renderOneText = (opts: { el: CapturedElement; idPrefix: string; clipId: string; fillColor: string; overflowClip?: boolean }): string => {
        const hasMultipleSegments = opts.el.textSegments != null && opts.el.textSegments.length > 1;
        const isMultiLine = opts.el.text.includes("\n");
        if (hasMultipleSegments) return renderMultiSegmentText(opts, opts.el.textSegments!);
        if (isMultiLine) return renderMultiLineText(opts);
        if (opts.el.tag === "input" || opts.el.tag === "textarea") return renderInputText(opts);
        return renderSingleLineText(opts);
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

      // Whether the element's own text needs clipping: only when overflow
      // is set on the element itself (overflow != visible on either axis).
      // Default `overflow: visible` lets text spill past the box, matching
      // Chrome (DM-305).
      const tox = el.styles.overflowX;
      const toy = el.styles.overflowY;
      const textOverflowClip = (tox != null && tox !== "visible") || (toy != null && toy !== "visible");
      const renderOpts = { el, idPrefix, clipId: cid, fillColor, overflowClip: textOverflowClip };
      if (textBgClipFill != null && textIsTransparent) {
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
        svgParts.push(
          `${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" fill="${textBgClipFill}" mask="url(#${mid})" />`,
        );
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

    // Textarea resize handle (DM-339): when CSS `resize` is non-none on a
    // <textarea>, Chrome's UA stylesheet paints a small ~7×7 diagonal-line
    // pattern in the bottom-right corner indicating the user can drag to
    // resize. Empirical: 3 diagonal lines from the corner extending up-left,
    // ~1.5px stroke, mid-gray (#999), inside the padding-box. Matches what
    // Chrome paints across resize: vertical / horizontal / both / inline /
    // block (only `none` suppresses).
    if (el.tag === "textarea" && el.styles.resize != null && el.styles.resize !== "none") {
      const handleColor = "rgb(153,153,153)";
      const handleSize = 7;
      // Position the handle so its bottom-right corner sits at the textarea's
      // border-box bottom-right minus a 2px inset (matches Chrome's painted
      // offset).
      const cx = el.x + el.width - 2;
      const cy = el.y + el.height - 2;
      // Three diagonal strokes 2px apart sloping from bottom-right to upper-left.
      for (let i = 0; i < 3; i++) {
        const off = i * 2.5;
        svgParts.push(`${indent}<line x1="${r(cx - handleSize + off)}" y1="${r(cy)}" x2="${r(cx)}" y2="${r(cy - handleSize + off)}" stroke="${handleColor}" stroke-width="0.7" />`);
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
    let overflowClipId: string | null = null;
    if (clipsOverflow && el.children.length > 0) {
      overflowClipId = `${idPrefix}ov${clipIdx++}`;
      const cbt = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const cbr = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const cbb = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const cbl = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      defsParts.push(`<clipPath id="${overflowClipId}">${roundedRectSvg(el.x + cbl, el.y + cbt, Math.max(0, el.width - cbl - cbr), Math.max(0, el.height - cbt - cbb), corners, "")}</clipPath>`);
      svgParts.push(`${indent}<g clip-path="url(#${overflowClipId})">`);
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
    if (establishesStackingContext(el, parentDisplayForEl)) {
      childrenForSort = gatherStackingContextChildren(baseChildren, hoistedFromAncestor, childParentDisplay, true);
    } else {
      childrenForSort = baseChildren.filter((c) => !hoistedFromAncestor.has(c));
    }
    const sortedChildren = sortChildrenByPaintOrder(childrenForSort, childParentDisplay, el.styles.flexDirection);
    for (const child of sortedChildren) {
      renderElement(child, depth + 1, childParentDisplay);
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
  const topLevelFlat = gatherStackingContextChildren(elements, hoistedFromAncestor);
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
  const sortedTopLevel = sortChildrenByPaintOrder(topLevelFlat);
  for (const el of sortedTopLevel) {
    renderElement(el, 1);
  }

  // Prepend defs block: clipPaths + optional glyph path definitions. For
  // animated multi-frame SVGs the caller passes includeGlyphDefs=false and
  // collects glyph defs once at the top level via getGlyphDefs().
  const glyphDefsMarkup = includeGlyphDefs ? getGlyphDefs() : "";
  const allDefs = defsParts.join("") + glyphDefsMarkup;
  const defs = allDefs !== "" ? `  <defs>${allDefs}</defs>\n` : "";
  return defs + svgParts.join("\n");
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
/**
 * DM-525: parent's `display` decides whether this element is a flex/grid
 * item, which extends the z-index → stacking-context rule even when the
 * item is `position: static` (per CSS Flexbox 1 §5.4 / CSS Grid 1 §17).
 */
function isFlexOrGridContainerDisplay(display: string | undefined | null): boolean {
  if (display == null) return false;
  return display === "flex" || display === "inline-flex"
      || display === "grid" || display === "inline-grid";
}

/**
 * DM-473: does this element establish a CSS stacking context?
 *
 * Stacking-context creators we model:
 *   - positioned (`position` ≠ `static`) AND `z-index` ≠ `auto`
 *   - flex/grid item AND `z-index` ≠ `auto` (DM-525 — per CSS Flexbox 1 §5.4 /
 *     CSS Grid 1: z-index on a flex/grid item creates an SC even when
 *     position:static, behaving as if position were relative)
 *   - `position: fixed` / `position: sticky` (always create one in modern CSS)
 *   - `opacity` < 1
 *   - `transform` ≠ `none`
 *   - `filter` ≠ `none`
 *   - `mix-blend-mode` ≠ `normal`
 *   - `mask-image` ≠ `none` / `clip-path` ≠ `none` (we already wrap these in
 *     a `<g mask=...>` / `<g clip-path=...>`, which isolates paint)
 *   - `isolation: isolate`
 *
 * Not yet modeled (low real-world frequency):
 *   - `perspective` ≠ `none`
 *
 * Used by the paint-order flattening pass: a positioned descendant whose
 * nearest *real* SC ancestor is the parent SC root must be hoisted into
 * the parent SC's sort, not buried inside its non-SC direct parent.
 */
function establishesStackingContext(el: CapturedElement, parentDisplay?: string): boolean {
  const s = el.styles;
  const positioned = s.position != null && s.position !== "static";
  const zRaw = s.zIndex;
  if (positioned && zRaw != null && zRaw !== "" && zRaw !== "auto") return true;
  // DM-525: flex/grid item with explicit z-index — Chrome treats this as a
  // stacking context root even at position:static.
  if (isFlexOrGridContainerDisplay(parentDisplay)
      && zRaw != null && zRaw !== "" && zRaw !== "auto") return true;
  if (s.position === "fixed" || s.position === "sticky") return true;
  const op = parseFloat(s.opacity);
  if (Number.isFinite(op) && op < 1) return true;
  if (s.transform != null && s.transform !== "" && s.transform !== "none") return true;
  if (s.filter != null && s.filter !== "" && s.filter !== "none") return true;
  if (s.mixBlendMode != null && s.mixBlendMode !== "" && s.mixBlendMode !== "normal") return true;
  if (s.maskImage != null && s.maskImage !== "" && s.maskImage !== "none") return true;
  if (s.clipPath != null && s.clipPath !== "" && s.clipPath !== "none") return true;
  // DM-498: `will-change` listing any SC-creating property creates an SC.
  // Per CSS-Will-Change-1: "If any non-initial value of any of the listed
  // properties would create a stacking context on the element, the element
  // creates a stacking context." Real-world high-traffic case: apple.com's
  // hero carousel uses `will-change: transform` on the slide container, so
  // without this detection the hoist pass disrupts the natural paint order
  // and the buttons render BEHIND the artwork. Tokenize on comma+whitespace
  // and check exact name equality — substring matching would falsely flag
  // `scroll-position` (which doesn't create an SC) on the `position` token.
  if (s.willChange != null && s.willChange !== "" && s.willChange !== "auto") {
    const _scWcProps: ReadonlySet<string> = new Set([
      "transform", "opacity", "filter", "backdrop-filter",
      "mask", "mask-image", "clip-path", "perspective",
      "top", "right", "bottom", "left",
      "position", "z-index", "isolation", "mix-blend-mode", "contain",
    ]);
    const tokens = s.willChange.split(/[\s,]+/);
    for (const t of tokens) {
      if (_scWcProps.has(t.toLowerCase())) return true;
    }
  }
  // DM-498: `contain: paint | strict | content` creates an SC.
  if (s.contain != null && s.contain !== "" && s.contain !== "none") {
    if (/\b(?:paint|strict|content)\b/i.test(s.contain)) return true;
  }
  // DM-498: `isolation: isolate` creates an SC.
  if (s.isolation === "isolate") return true;
  // DM-487: `overflow != visible` (scroll container) creates a stacking
  // context — any of overflow / overflow-x / overflow-y in {auto, scroll,
  // hidden, clip}. Without this, sticky / positioned descendants of an
  // overflow:auto scroller get hoisted PAST the scroller's clip-path
  // wrapper into the implicit root SC, leaking out of the scroller's
  // viewport (observable on `13-deep-sticky-edges`: scroller 1's deep
  // sticky headers painted into scroller 2's area).
  const ox = s.overflowX;
  const oy = s.overflowY;
  if ((ox != null && ox !== "visible") || (oy != null && oy !== "visible")) return true;
  return false;
}

/**
 * DM-473: build the flat paint list for one stacking context.
 *
 * For each direct child of the SC root, walk into the child's subtree only
 * as long as the child is NOT itself an SC root, and pull every positioned
 * descendant (transitively) up into the flat list. Each hoisted descendant
 * is also added to `hoistedOut` so the renderer's normal DFS skips them at
 * their natural location and we don't double-emit. SC-root descendants
 * are NOT recursed into — they bring their own SC scope and their internal
 * paint order resolves independently when their renderElement runs.
 */
function gatherStackingContextChildren(
  children: CapturedElement[],
  hoistedOut: Set<CapturedElement>,
  parentDisplay?: string,
  hoistTargetIsRealSC: boolean = false,
): CapturedElement[] {
  const out: CapturedElement[] = [];
  const collectFromNonSC = (parent: CapturedElement): void => {
    const childParentDisplay = parent.styles.display;
    const parentIsFlexGrid = isFlexOrGridContainerDisplay(childParentDisplay);
    for (const c of parent.children) {
      // DM-543: skip elements already hoisted by a higher SC pass (e.g. a
      // root-level position:fixed pre-pass added this pin to topLevelFlat;
      // re-pushing it here would double-emit it inside the local clip group).
      if (hoistedOut.has(c)) continue;
      const positioned = c.styles.position != null && c.styles.position !== "static";
      // DM-558: also hoist a flex/grid item with explicit z-index even when
      // position:static — it's an SC root by CSS Flexbox 1 §5.4 / CSS Grid 1
      // §17 (already detected by `establishesStackingContext`'s flex/grid
      // branch), and SC roots paint atomically in their nearest parent SC
      // sort. Without this hoist, the SC stays nested inside its non-SC
      // ancestor's sub-tree and renders at that depth in DOM order — so a
      // flex-item button with z:4 inside `<div style="position:relative">`
      // ends up painting BEFORE a sibling positioned `<div>` that should be
      // beneath it. (Apple hero `tile-wrapper > tile-content > tile-ctas >
      // a.button` rendered BEHIND the captured background image because the
      // button's z:4 hoist never fired — position:static + the legacy
      // `if (positioned)` check skipped it.)
      //
      // Only hoist when the hoist target is a real SC: at the implicit
      // top-level (no enclosing SC element captured), the eventual sort
      // can't know `parentDisplay`, so a hoisted flex-item-z would lose
      // its z-bucket and paint in DOM order. In that case we leave the
      // element in place and let its parent's local flex sort handle the
      // z-ordering naturally — DM-525's local-sort path covers the
      // direct-flex-child case correctly.
      const zRaw = c.styles.zIndex;
      const hasExplicitZ = zRaw != null && zRaw !== "" && zRaw !== "auto";
      const flexGridItemSC = hoistTargetIsRealSC && parentIsFlexGrid && hasExplicitZ;
      if (positioned || flexGridItemSC) {
        out.push(c);
        hoistedOut.add(c);
      }
      if (!establishesStackingContext(c, childParentDisplay)) {
        collectFromNonSC(c);
      }
    }
  };
  for (const c of children) {
    if (hoistedOut.has(c)) continue;
    out.push(c);
    if (!establishesStackingContext(c, parentDisplay)) {
      collectFromNonSC(c);
    }
  }
  return out;
}

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
    const sorted = children
      .map((c, idx) => ({ c, idx, ord: parseInt(c.styles.order ?? "0", 10) || 0 }))
      .sort((a, b) => a.ord - b.ord || a.idx - b.idx)
      .map((x) => x.c);
    orderedChildren = reverseFlex ? sorted.slice().reverse() : sorted;
  } else {
    orderedChildren = children;
  }
  const negative: Array<{ z: number; idx: number; el: CapturedElement }> = [];
  const floats: CapturedElement[] = [];
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
    const treatAsZSorted = positioned || (isFlexGrid && !isNaN(z));
    if (!treatAsZSorted && flt !== "none") {
      floats.push(c);
    } else if (!treatAsZSorted) {
      base.push(c);
    } else if (isNaN(z)) {
      zeroOrAuto.push(c);
    } else if (z < 0) {
      negative.push({ z, idx: i, el: c });
    } else {
      positive.push({ z, idx: i, el: c });
    }
  }
  negative.sort((a, b) => a.z - b.z || a.idx - b.idx);
  positive.sort((a, b) => a.z - b.z || a.idx - b.idx);
  return [...negative.map((x) => x.el), ...base, ...floats, ...zeroOrAuto, ...positive.map((x) => x.el)];
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
  const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
  if (linear != null) {
    const repeating = /^repeating-/i.test(layer);
    return { def: buildLinearGradientDef(id, linear[1], repeating, w, h, elX, elY) };
  }
  const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
  if (radial != null) {
    const repeating = /^repeating-/i.test(layer);
    return { def: buildRadialGradientDef(id, radial[1], repeating, elX, elY, w, h) };
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

/** Compute the tile size + origin offset + effective repeat unit for a url() background layer. */
function buildImagePatternDef(
  id: string, href: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string, posCss: string, repeatCss: string,
  intrinsic: { w: number; h: number } | null,
  /**
   * background-attachment. When 'fixed' the image is anchored to the viewport,
   * not the element. For a static capture we don't need dynamic scroll-following —
   * we just need the right offset at t=0: viewport coords === SVG canvas coords,
   * so patX/patY should be viewport-relative instead of element-relative.
   * 'fixedViewport' is {w, h} of the capture viewport (needed for size keywords
   * like cover/contain/%).
   */
  attachment: string = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
): string {
  // When background-attachment is fixed, the sizing + positioning basis is
  // the viewport, not the elements box. Override w/h + origin for that path.
  const isFixed = attachment === "fixed" && fixedViewport != null;
  const basisW = isFixed ? fixedViewport!.w : w;
  const basisH = isFixed ? fixedViewport!.h : h;
  const originX = isFixed ? 0 : elX;
  const originY = isFixed ? 0 : elY;
  // Split repeat into per-axis (CSS: repeat-x/-y are shorthands).
  let repH = "repeat", repV = "repeat";
  const rTok = repeatCss.trim().split(/\s+/);
  if (rTok[0] === "repeat-x") { repH = "repeat"; repV = "no-repeat"; }
  else if (rTok[0] === "repeat-y") { repH = "no-repeat"; repV = "repeat"; }
  else {
    repH = rTok[0];
    repV = rTok[1] ?? rTok[0];
  }

  // Resolve background-size into a concrete tile w/h. For fixed backgrounds
  // the basis is the viewport, not the element.
  let tileW = basisW, tileH = basisH;
  const sizeTok = sizeCss.trim().split(/\s+/);
  if (sizeCss === "cover") {
    if (intrinsic != null) {
      const scale = Math.max(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else if (sizeCss === "contain") {
    if (intrinsic != null) {
      const scale = Math.min(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else {
    const resolveSizeToken = (tok: string, basis: number, intrinsicDim: number): number => {
      if (tok == null || tok === "auto") return intrinsicDim;
      if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
      return parseFloat(tok) || intrinsicDim;
    };
    const hasTwo = sizeTok.length > 1;
    const intrinsicW = intrinsic?.w ?? basisW;
    const intrinsicH = intrinsic?.h ?? basisH;
    tileW = resolveSizeToken(sizeTok[0], basisW, intrinsicW);
    if (hasTwo) {
      tileH = resolveSizeToken(sizeTok[1], basisH, intrinsicH);
    } else if (sizeTok[0] === "auto") {
      tileH = intrinsicH;
    } else if (intrinsic != null) {
      // Single value sizes width; height scales proportionally to intrinsic aspect.
      tileH = tileW * (intrinsicH / intrinsicW);
    } else {
      tileH = basisH;
    }
  }

  // Resolve background-position. Keywords: left/right/top/bottom/center; %/px.
  // For fixed backgrounds the basis is the viewport. Chrome normalizes the
  // 4-token form "right 20px bottom 20px" to calc() form — e.g.
  // "calc(100% - 20px) calc(100% - 20px)" — so our tokenizer must respect
  // parens and the resolver must evaluate simple calc expressions.
  const tokenizeTopLevel = (s: string): string[] => {
    const tokens: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of s) {
      if (ch === "(") { depth++; current += ch; continue; }
      if (ch === ")") { depth--; current += ch; continue; }
      if (/\s/.test(ch) && depth === 0) {
        if (current !== "") { tokens.push(current); current = ""; }
        continue;
      }
      current += ch;
    }
    if (current !== "") tokens.push(current);
    return tokens;
  };
  const posTok = tokenizeTopLevel(posCss.trim());
  const evalCalc = (t: string, basis: number, tile: number): number => {
    const m = /^calc\((.+)\)$/.exec(t);
    if (m == null) return NaN;
    const parts = m[1].trim().split(/\s+([+-])\s+/);
    if (parts.length !== 3) return NaN;
    const [a, op, c] = parts;
    const reso = (s: string): number => {
      if (/%$/.test(s)) return (parseFloat(s) / 100) * (basis - tile);
      return parseFloat(s) || 0;
    };
    const lhs = reso(a);
    const rhs = reso(c);
    return op === "+" ? lhs + rhs : lhs - rhs;
  };
  const resolveH = (t: string): number => {
    if (t === "left") return 0;
    if (t === "right") return basisW - tileW;
    if (t === "center") return (basisW - tileW) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisW, tileW);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisW - tileW));
    return parseFloat(t) || 0;
  };
  const resolveV = (t: string): number => {
    if (t === "top") return 0;
    if (t === "bottom") return basisH - tileH;
    if (t === "center") return (basisH - tileH) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisH, tileH);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisH - tileH));
    return parseFloat(t) || 0;
  };
  const isHoriz = (t: string): boolean => t === "left" || t === "right";
  const isVert = (t: string): boolean => t === "top" || t === "bottom";
  const isLen = (t: string): boolean => /^-?\d/.test(t) || t === "0";
  // Parse an explicit offset value (px or %) used after a side keyword in the
  // 4-token form. Percentages scale against the available space.
  const parseAxisOffset = (t: string, basis: number, tile: number): number => {
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basis - tile));
    return parseFloat(t) || 0;
  };
  let posX: number;
  let posY: number;
  // 4-token form: side offset side offset — e.g. "right 20px bottom 20px".
  // Each side keyword is anchored to the matching edge and the offset pushes
  // the tile inward.
  if (
    posTok.length >= 4
    && (isHoriz(posTok[0]) || isVert(posTok[0]))
    && isLen(posTok[1])
    && (isHoriz(posTok[2]) || isVert(posTok[2]))
    && isLen(posTok[3])
  ) {
    const aIsH = isHoriz(posTok[0]);
    const hSide = aIsH ? posTok[0] : posTok[2];
    const hOff = aIsH ? posTok[1] : posTok[3];
    const vSide = aIsH ? posTok[2] : posTok[0];
    const vOff = aIsH ? posTok[3] : posTok[1];
    posX = hSide === "right"
      ? basisW - tileW - parseAxisOffset(hOff, basisW, tileW)
      : parseAxisOffset(hOff, basisW, tileW);
    posY = vSide === "bottom"
      ? basisH - tileH - parseAxisOffset(vOff, basisH, tileH)
      : parseAxisOffset(vOff, basisH, tileH);
  } else {
    posX = resolveH(posTok[0] ?? "0%");
    posY = resolveV(posTok[1] ?? posTok[0] ?? "0%");
    // Swap when keywords are given in vertical-first order (e.g. "top 50%").
    if (posTok[0] === "top" || posTok[0] === "bottom") {
      posY = resolveV(posTok[0]);
      posX = resolveH(posTok[1] ?? "50%");
    }
  }

  // 'round' rebinds tile size so count is integer.
  if (repH === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisW / tileW));
    tileW = basisW / count;
  }
  if (repV === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisH / tileH));
    tileH = basisH / count;
  }
  const periodW = (repH === "repeat" || repH === "round") ? tileW
                : repH === "space" ? Math.max(tileW, basisW / Math.max(1, Math.floor(basisW / tileW)))
                : basisW * 2; // no-repeat: make pattern huge so only one tile fits
  const periodH = (repV === "repeat" || repV === "round") ? tileH
                : repV === "space" ? Math.max(tileH, basisH / Math.max(1, Math.floor(basisH / tileH)))
                : basisH * 2;

  // Pattern position in userSpaceOnUse — absolute SVG canvas coords. For scroll
  // backgrounds that's elX+posX (positioned within the element). For fixed
  // backgrounds the viewport IS the canvas, so patX = posX directly.
  const patX = originX + posX;
  const patY = originY + posY;

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${r(patX)}" y="${r(patY)}" width="${r(periodW)}" height="${r(periodH)}"><image href="${esc(embedResizedDataUri(href, tileW, tileH))}" x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" preserveAspectRatio="none" /></pattern>`;
}

interface GradientStop { color: RGBA; pos: number }

/** Parse the comma-separated 'args' inside a linear-gradient(...) and emit an SVG <linearGradient>.
 * w/h are the element box dimensions — needed to compute corner-to-corner
 * directional keywords ('to top right' etc.) which are aspect-ratio-dependent,
 * not always 45deg. */
function buildLinearGradientDef(id: string, args: string, repeating: boolean, w: number = 1, h: number = 1, elX: number = 0, elY: number = 0): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let angleDeg = 180; // default 'to bottom'
  let stopsStart = 0;
  const first = parts[0];
  const toMatch = /^to\s+(.+)$/i.exec(first);
  if (toMatch != null) {
    angleDeg = cssDirectionToAngle(toMatch[1], w, h);
    stopsStart = 1;
  } else {
    const angleMatch = /^(-?[\d.]+)(deg|rad|grad|turn)?$/i.exec(first);
    if (angleMatch != null) {
      const unit = (angleMatch[2] ?? "deg").toLowerCase();
      const n = parseFloat(angleMatch[1]);
      angleDeg = unit === "rad" ? (n * 180) / Math.PI : unit === "grad" ? n * 0.9 : unit === "turn" ? n * 360 : n;
      stopsStart = 1;
    }
  }
  const stops = parseGradientStops(parts.slice(stopsStart));
  if (stops.length === 0) return "";

  // CSS: 0deg points up. SVG coords: y grows down. Vector for CSS angle α is
  // (sin α, -cos α). Per the CSS Images L3 spec the gradient line passes
  // through the box center at the requested angle and its length is
  // `|W·sin α| + |H·cos α|` in real coordinates — NOT `1` in unit-square
  // coordinates. For non-square boxes the two are different: a 45° gradient
  // on a 180×120 box has gradient line length ≈ 212.13 (real px), with
  // endpoints at (15, 135) and (165, -15). The endpoint normalization to
  // the bounding box (which is what SVG's default `gradientUnits=
  // "objectBoundingBox"` consumes) lands at fractions outside [0, 1] —
  // (0.083, 1.125) and (0.917, -0.125) — which is valid SVG and renders
  // identically to Chrome. The previous `0.5 ± 0.5·sinα` / `0.5 ± 0.5·cosα`
  // formulation only matched a square box; on rectangular boxes the
  // gradient direction was stretched by the aspect ratio, producing a
  // visibly different angle than what Chrome paints. Surfaced via DM-395
  // probe of `mask-mode: alpha` / `mask-mode: luminance` cells in 23-mask
  // (180×120 boxes); 81% of pixels differed because the 45° gradient rotated
  // toward atan(W/H) ≈ 56.3° instead of staying at 45°.
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const halfL = length / 2;
  // Endpoints in absolute SVG coordinates. We emit `gradientUnits=
  // "userSpaceOnUse"` because the SVG default `objectBoundingBox` rescales
  // x/y independently to the bounding box — distorting the visible gradient
  // angle on non-square elements. For a 45° gradient on a 180×120 box,
  // objectBoundingBox would render the gradient at ~33° instead of 45°,
  // which DM-395's per-pixel probe of `mask-mode: alpha` showed as 75%
  // of pixels diffing against Chrome's paint. userSpaceOnUse preserves the
  // angle by keeping the gradient line in real-px coordinates so each
  // point in the box projects onto the line correctly.
  const x1 = elX + w / 2 - halfL * dx;
  const y1 = elY + h / 2 - halfL * dy;
  const x2 = elX + w / 2 + halfL * dx;
  const y2 = elY + h / 2 + halfL * dy;

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  // Stop offsets need 4 decimals of precision — rounding 0.33 to 0.3 would turn
  // three equal thirds into uneven bands. Use stopFmt, not r(), here.
  const stopsMarkup = stops.map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${stopFmt(x1)}" y1="${stopFmt(y1)}" x2="${stopFmt(x2)}" y2="${stopFmt(y2)}"${spread}>${stopsMarkup}</linearGradient>`;
}


/** Parse radial-gradient args and emit an SVG <radialGradient>.
 *
 * Emits in userSpaceOnUse so we can honor CSS shape (circle vs ellipse),
 * size keywords (closest/farthest side/corner), explicit radii, and position
 * accurately in a non-square box. elX/elY are the element's absolute top-left.
 */
function buildRadialGradientDef(
  id: string, args: string, repeating: boolean,
  elX: number, elY: number, w: number, h: number,
): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let stopsStart = 0;
  let shape: "circle" | "ellipse" = "ellipse"; // CSS default
  let sizeKeyword: "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner" = "farthest-corner";
  let explicitRx: number | null = null;
  let explicitRy: number | null = null;
  let cxFrac = 0.5, cyFrac = 0.5;

  // First argument can be: 'circle' | 'ellipse' [size-keyword] [at <pos>], OR
  // explicit size (one length, or two lengths for ellipse), optionally with shape, at <pos>.
  // Example valid first-args:
  //   'circle'
  //   'ellipse at top'
  //   'circle closest-side at 30% 30%'
  //   '80px 60px at 70% 40%'
  //   '100px'
  const first = parts[0];
  // Try to detect if first arg is shape/size info (no parens / no color chars)
  const isLikelyStopsStart = /#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|transparent|[a-z]{3,}$/i.test(first) && !/\b(circle|ellipse|closest|farthest|at\b)/i.test(first);
  if (!isLikelyStopsStart) {
    stopsStart = 1;
    // Parse 'at <pos>' suffix.
    const mAt = /\bat\b/i.exec(first);
    const beforeAt = mAt != null ? first.slice(0, mAt.index).trim() : first.trim();
    const afterAt = mAt != null ? first.slice(mAt.index + 2).trim() : "";
    if (afterAt !== "") {
      const posTokens = afterAt.split(/\s+/);
      const p1 = posTokens[0] ?? "center";
      const p2 = posTokens[1] ?? "center";
      // Position can be keyword / % / px / plain number (treated as px in CSS).
      // resolvePosFraction (the linear-gradient helper) only understands keywords
      // + percent, so convert pixel values here against w/h.
      const toFrac = (tok: string, axis: "h" | "v"): number => {
        const t = tok.trim();
        if (t === "center") return 0.5;
        if (axis === "h" && t === "left") return 0;
        if (axis === "h" && t === "right") return 1;
        if (axis === "v" && t === "top") return 0;
        if (axis === "v" && t === "bottom") return 1;
        if (/%$/.test(t)) return parseFloat(t) / 100;
        // Pixels (or bare numbers treated as pixels per CSS spec).
        const px = parseFloat(t);
        if (!isNaN(px)) {
          const basis = axis === "h" ? w : h;
          return basis > 0 ? px / basis : 0;
        }
        return 0.5;
      };
      cxFrac = toFrac(p1, "h");
      cyFrac = toFrac(p2, "v");
    }
    // Parse shape / size keyword / explicit radii from beforeAt.
    const tokens = beforeAt.split(/\s+/).filter((t) => t !== "");
    for (const t of tokens) {
      if (t === "circle") shape = "circle";
      else if (t === "ellipse") shape = "ellipse";
      else if (t === "closest-side" || t === "closest-corner" || t === "farthest-side" || t === "farthest-corner") {
        sizeKeyword = t;
      } else if (/(px|%|em|rem)$/.test(t) || /^-?[\d.]+$/.test(t)) {
        const val = /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t);
        const isPct = /%$/.test(t);
        if (explicitRx == null) explicitRx = isPct ? val * w : val;
        else if (explicitRy == null) explicitRy = isPct ? val * h : val;
      }
    }
    if (explicitRx != null && explicitRy == null) {
      // Single length -> circle with that radius.
      explicitRy = explicitRx;
      shape = "circle";
    }
  }
  const stops = parseGradientStops(parts.slice(stopsStart));
  if (stops.length === 0) return "";

  // Compute center in absolute user-space coords.
  const cx = elX + cxFrac * w;
  const cy = elY + cyFrac * h;

  // Compute effective radii per shape + size keyword.
  const dxL = cxFrac * w;        // distance to left side
  const dxR = (1 - cxFrac) * w;  // to right
  const dyT = cyFrac * h;        // to top
  const dyB = (1 - cyFrac) * h;  // to bottom
  const closestX = Math.min(dxL, dxR);
  const farthestX = Math.max(dxL, dxR);
  const closestY = Math.min(dyT, dyB);
  const farthestY = Math.max(dyT, dyB);

  let rx: number, ry: number;
  if (explicitRx != null && explicitRy != null) {
    rx = explicitRx;
    ry = explicitRy;
  } else if (shape === "circle") {
    let r0: number;
    switch (sizeKeyword) {
      case "closest-side":   r0 = Math.min(closestX, closestY); break;
      case "farthest-side":  r0 = Math.max(farthestX, farthestY); break;
      case "closest-corner": r0 = Math.sqrt(closestX * closestX + closestY * closestY); break;
      case "farthest-corner":
      default:               r0 = Math.sqrt(farthestX * farthestX + farthestY * farthestY); break;
    }
    rx = r0;
    ry = r0;
  } else {
    // ellipse
    switch (sizeKeyword) {
      case "closest-side":
        rx = closestX; ry = closestY; break;
      case "farthest-side":
        rx = farthestX; ry = farthestY; break;
      case "closest-corner":
      case "farthest-corner":
      default: {
        // Ellipse that passes through the corner along the shape's aspect ratio.
        // For farthest-corner: radii (rx, ry) satisfy rx/ry = farthestX/farthestY
        // AND rx = farthestX*sqrt(2), ry = farthestY*sqrt(2) (since the corner
        // at (farthestX, farthestY) satisfies (farthestX/rx)^2 + (farthestY/ry)^2 = 1).
        const aspectX = sizeKeyword === "closest-corner" ? closestX : farthestX;
        const aspectY = sizeKeyword === "closest-corner" ? closestY : farthestY;
        rx = aspectX * Math.SQRT2;
        ry = aspectY * Math.SQRT2;
        break;
      }
    }
  }

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  const stopsMarkup = stops.map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");

  // SVG radialGradient has a single r — use rx as r and scale Y via gradientTransform
  // to stretch it into an ellipse matching (rx, ry).
  const rScale = rx > 0 ? ry / rx : 1;
  const gradientTransform = Math.abs(rScale - 1) > 0.001
    ? ` gradientTransform="translate(0 ${stopFmt(cy * (1 - rScale))}) scale(1 ${stopFmt(rScale)})"`
    : "";

  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${stopFmt(cx)}" cy="${stopFmt(cy)}" r="${stopFmt(Math.max(rx, 1))}"${spread}${gradientTransform}>${stopsMarkup}</radialGradient>`;
}

function resolvePosFraction(token: string, axis: "h" | "v"): number {
  const t = token.trim();
  if (t === "center") return 0.5;
  if (axis === "h") {
    if (t === "left") return 0;
    if (t === "right") return 1;
  } else {
    if (t === "top") return 0;
    if (t === "bottom") return 1;
  }
  if (/%$/.test(t)) return parseFloat(t) / 100;
  return 0.5;
}

function parseGradientStops(tokens: string[]): GradientStop[] {
  // First pass: parse each token into {color, explicitPositions[]} OR {hint}.
  // A color-hint is a bare percentage between two color stops that shifts the
  // midpoint of the interpolation between them. We record hints inline so
  // they can apply to the neighboring colors after we finalize positions.
  type RawItem = { kind: "color"; color: RGBA; positions: number[] } | { kind: "hint"; pos: number };
  const raw: RawItem[] = [];
  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    if (tok === "") continue;
    if (/^-?[\d.]+%$/.test(tok)) {
      raw.push({ kind: "hint", pos: parseFloat(tok) / 100 });
      continue;
    }
    const posMatch = tok.match(/(\s+-?[\d.]+(%|px)?\s*){1,2}$/);
    let colorStr = tok;
    const positions: number[] = [];
    if (posMatch != null) {
      colorStr = tok.slice(0, posMatch.index).trim();
      for (const pt of posMatch[0].trim().split(/\s+/)) {
        if (/%$/.test(pt)) positions.push(parseFloat(pt) / 100);
        else positions.push(parseFloat(pt));
      }
    }
    const color = parseColor(colorStr) ?? { r: 0, g: 0, b: 0, a: 1 };
    raw.push({ kind: "color", color, positions });
  }
  // Filter hints out for the first-pass color expansion; we'll inject them after
  // stop positions are resolved.
  const hints: Array<{ pos: number; afterColorIdx: number }> = [];
  const colorRaw: Array<{ color: RGBA; positions: number[] }> = [];
  for (const r of raw) {
    if (r.kind === "color") colorRaw.push({ color: r.color, positions: r.positions });
    else hints.push({ pos: r.pos, afterColorIdx: colorRaw.length - 1 });
  }
  if (colorRaw.length === 0) return [];

  // Second pass: expand each color into 1+ stops (a color can have 2 positions
  // to form a hard stop). Track which stops came from which color-raw-index so
  // we can inject hint stops in the right spot.
  const stops: GradientStop[] = [];
  const stopColorIdx: number[] = [];
  for (let i = 0; i < colorRaw.length; i++) {
    const r = colorRaw[i];
    if (r.positions.length === 0) {
      stops.push({ color: r.color, pos: NaN });
      stopColorIdx.push(i);
    } else {
      for (const p of r.positions) { stops.push({ color: r.color, pos: p }); stopColorIdx.push(i); }
    }
  }
  if (isNaN(stops[0].pos)) stops[0].pos = 0;
  if (isNaN(stops[stops.length - 1].pos)) stops[stops.length - 1].pos = 1;

  // Fill interior NaN positions by evenly distributing between the nearest
  // resolved neighbors — matches CSS behavior for implicit stops.
  let i = 0;
  while (i < stops.length) {
    if (!isNaN(stops[i].pos)) { i++; continue; }
    let j = i;
    while (j < stops.length && isNaN(stops[j].pos)) j++;
    const left = stops[i - 1].pos;
    const right = j < stops.length ? stops[j].pos : 1;
    const count = j - i + 1;
    for (let k = 0; k < j - i; k++) stops[i + k].pos = left + ((k + 1) / count) * (right - left);
    i = j;
  }
  // Monotonic clamp: each stop >= previous (CSS rule).
  for (let k = 1; k < stops.length; k++) {
    if (stops[k].pos < stops[k - 1].pos) stops[k].pos = stops[k - 1].pos;
  }

  // Inject color hints: between two stops A (at posA) and B (at posB) with a
  // hint at posH, CSS shifts the 50% transition point to posH using a power
  // interpolation. We approximate by adding a single mid-color stop at posH.
  // This is close enough for visual fidelity on most hint use cases.
  if (hints.length > 0) {
    const out: GradientStop[] = [];
    let hintIdx = 0;
    for (let s = 0; s < stops.length; s++) {
      out.push(stops[s]);
      // Is there a hint between this color's last stop and the next color's first stop?
      if (s === stops.length - 1) continue;
      const thisColorIdx = stopColorIdx[s];
      const nextColorIdx = stopColorIdx[s + 1];
      if (thisColorIdx === nextColorIdx) continue; // inside same color (hard stop)
      while (hintIdx < hints.length && hints[hintIdx].afterColorIdx <= thisColorIdx) {
        const h = hints[hintIdx++];
        if (h.afterColorIdx !== thisColorIdx) continue;
        const a = stops[s];
        const b = stops[s + 1];
        if (h.pos > a.pos && h.pos < b.pos) {
          const mid: RGBA = {
            r: Math.round((a.color.r + b.color.r) / 2),
            g: Math.round((a.color.g + b.color.g) / 2),
            b: Math.round((a.color.b + b.color.b) / 2),
            a: (a.color.a + b.color.a) / 2,
          };
          out.push({ color: mid, pos: h.pos });
        }
      }
    }
    return out;
  }
  return stops;
}

/** Map 'to top', 'to right', 'to top right' etc. to a CSS gradient angle (deg).
 *
 * Corner-to-corner directions ('to top right', etc.) depend on the box's
 * aspect ratio per CSS spec — the gradient line is drawn between opposite
 * corners, so the angle is atan2(w, h) for a w×h box (not always 45°). This
 * matters for narrow/tall boxes: a 3:1 landscape 'to top right' is ~72°, not 45°.
 */
function cssDirectionToAngle(dir: string, w: number = 1, h: number = 1): number {
  const parts = dir.trim().toLowerCase().split(/\s+/);
  const set = new Set(parts);
  const hasTop = set.has("top");
  const hasBottom = set.has("bottom");
  const hasLeft = set.has("left");
  const hasRight = set.has("right");
  if (hasTop && !hasLeft && !hasRight) return 0;
  if (hasBottom && !hasLeft && !hasRight) return 180;
  if (hasRight && !hasTop && !hasBottom) return 90;
  if (hasLeft && !hasTop && !hasBottom) return 270;
  // Corner: angle from vertical axis to the line from opposite corner to this corner.
  const cornerAngle = Math.atan2(w, h) * 180 / Math.PI;
  if (hasTop && hasRight) return cornerAngle;
  if (hasBottom && hasRight) return 180 - cornerAngle;
  if (hasBottom && hasLeft) return 180 + cornerAngle;
  if (hasTop && hasLeft) return 360 - cornerAngle;
  return 180;
}

/**
 * Rewrite a captured `<mask>` element's `outerHTML` so it can be safely
 * inlined in the output SVG's `<defs>`. The mask's own `id` becomes
 * `outputId`, and every other DOM id referenced inside the subtree gets
 * prefixed with `idPrefix` so it can't collide with ids elsewhere in the
 * output (multi-frame animated SVGs reuse the same prefix model). Every
 * `url(#X)` reference inside the subtree is updated to point at the
 * rewritten id. DM-493.
 */
export function rewriteFragmentMaskDef(
  outerHTML: string,
  outputId: string,
  idPrefix: string,
): string {
  // Discover all ids defined inside the subtree (the outer <mask>'s own id
  // plus any descendants that carry an id="…"). The outer mask id maps to
  // `outputId`; every other id maps to `${idPrefix}fragid-${original}` so the
  // mapping is stable across multiple references and unique across captures.
  const idMap = new Map<string, string>();
  const idDefRe = /\sid\s*=\s*"([^"]+)"|\sid\s*=\s*'([^']+)'/g;
  let firstId: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = idDefRe.exec(outerHTML)) != null) {
    const id = m[1] ?? m[2] ?? "";
    if (id === "") continue;
    if (firstId == null) {
      firstId = id;
      idMap.set(id, outputId);
    } else if (!idMap.has(id)) {
      idMap.set(id, `${idPrefix}fragid-${id}`);
    }
  }
  // Substitute id="X" — only ids we discovered, to avoid touching id strings
  // that happen to appear inside attribute values that aren't id attributes.
  let out = outerHTML.replace(/(\sid\s*=\s*)("([^"]+)"|'([^']+)')/g, (_, prefix, _full, dq, sq) => {
    const original = dq ?? sq ?? "";
    const replaced = idMap.get(original);
    if (replaced == null) return prefix + (dq != null ? `"${original}"` : `'${original}'`);
    return prefix + `"${replaced}"`;
  });
  // Substitute url(#X) refs throughout the subtree.
  out = out.replace(/url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)/g, (full, ref) => {
    const replaced = idMap.get(ref);
    return replaced == null ? full : `url(#${replaced})`;
  });
  // Substitute href="#X" / xlink:href="#X" refs (e.g. <use href="#…">).
  out = out.replace(/(\s(?:xlink:)?href\s*=\s*)("#([^"]+)"|'#([^']+)')/g, (full, prefix, _q, dq, sq) => {
    const original = dq ?? sq ?? "";
    const replaced = idMap.get(original);
    return replaced == null ? full : prefix + `"#${replaced}"`;
  });
  return out;
}

/**
 * Reposition a (previously rewritten) `<mask>` outerHTML so its content lives
 * in the masked element's absolute user-space. CSS `mask-image: url("#id")`
 * positions the mask source at the masked element's content-box origin, but
 * SVG `<mask>` with `maskUnits="userSpaceOnUse"` interprets its content
 * absolutely against the root SVG — so the captured mask coords (which are
 * relative to the original `<mask>` element) need shifting by `(elX, elY)`.
 * We do this by:
 *   1. Forcing `maskUnits="userSpaceOnUse"` on the outer `<mask>`.
 *   2. Replacing the mask's `x/y/width/height` with the masked element's
 *      absolute box (so the mask region matches the element).
 *   3. Wrapping the mask's children in `<g transform="translate(elX, elY)">`.
 * DM-493.
 */
export function positionFragmentMaskDef(
  rewrittenOuterHTML: string,
  elX: number, elY: number, elW: number, elH: number,
): string {
  // Find the opening <mask …> tag (anchored at start of string, since
  // rewriteFragmentMaskDef preserves the outerHTML structure of the captured
  // <mask> element).
  const openMatch = /^<mask\b([^>]*)>/i.exec(rewrittenOuterHTML);
  if (openMatch == null) return rewrittenOuterHTML;
  const closeIdx = rewrittenOuterHTML.lastIndexOf("</mask>");
  if (closeIdx < 0) return rewrittenOuterHTML;
  const inner = rewrittenOuterHTML.slice(openMatch[0].length, closeIdx);
  // Strip existing maskUnits / x / y / width / height — we replace them.
  let attrs = openMatch[1]
    .replace(/\smaskUnits\s*=\s*"[^"]*"/gi, "")
    .replace(/\smaskUnits\s*=\s*'[^']*'/gi, "")
    .replace(/\smaskContentUnits\s*=\s*"[^"]*"/gi, "")
    .replace(/\smaskContentUnits\s*=\s*'[^']*'/gi, "")
    .replace(/\sx\s*=\s*"[^"]*"/gi, "")
    .replace(/\sx\s*=\s*'[^']*'/gi, "")
    .replace(/\sy\s*=\s*"[^"]*"/gi, "")
    .replace(/\sy\s*=\s*'[^']*'/gi, "")
    .replace(/\swidth\s*=\s*"[^"]*"/gi, "")
    .replace(/\swidth\s*=\s*'[^']*'/gi, "")
    .replace(/\sheight\s*=\s*"[^"]*"/gi, "")
    .replace(/\sheight\s*=\s*'[^']*'/gi, "");
  attrs += ` maskUnits="userSpaceOnUse" x="${r(elX)}" y="${r(elY)}" width="${r(elW)}" height="${r(elH)}"`;
  return `<mask${attrs}><g transform="translate(${r(elX)}, ${r(elY)})">${inner}</g></mask>`;
}

/**
 * Translate a CSS mask-image value + mask-* siblings into an SVG <mask>.
 * Handles single-layer gradients and url() sources. Position/size/repeat are
 * applied via an internal <pattern> for url sources; gradients use direct
 * gradient fills sized to the element box.
 *
 * SVG <mask> uses luminance by default (bright pixels visible). CSS mask-mode
 * 'alpha' makes the alpha channel control visibility. We set mask-type on the
 * <mask> element accordingly. Note: Chromium may render mask-mode:'match-source'
 * differently depending on the source; we pick alpha for gradients and url()
 * (common case) and respect explicit mask-mode when given.
 */
export function buildMaskDef(
  id: string, maskImage: string,
  elX: number, elY: number, w: number, h: number,
  maskMode: string, sizeCss: string, posCss: string, repeatCss: string,
  compositeCss: string,
  /** DM-494: lookup table for `mask-image: element(#id)` references. Optional —
   *  callers without element() refs can omit it. The renderer's main caller
   *  threads through `elementMaskRasters` (collected from tree[0].maskRasters);
   *  unit tests can pass undefined to exercise the non-element() branches. */
  elementRasters?: ReadonlyMap<string, MaskRasterRef>,
): { id: string; def: string } {
  const layers = splitTopLevelCommas(maskImage);
  const sizeLayers = splitTopLevelCommas(sizeCss);
  const posLayers = splitTopLevelCommas(posCss);
  const repeatLayers = splitTopLevelCommas(repeatCss);
  const compositeLayers = splitTopLevelCommas(compositeCss);

  // Determine mask-type per CSS mask-mode.
  //   - alpha: explicit author opt-in to alpha-channel masking.
  //   - luminance: explicit author opt-in to RGB-luminance masking.
  //   - match-source (default): the source type drives the mode. Per CSS Masking:
  //     gradient + bitmap url() sources → alpha (the practical behavior we
  //     already emit), but element() paint references → luminance (the painted
  //     RGB drives mask alpha; this is what Chromium implements for `element()`
  //     under `match-source`). DM-494: when ANY layer in this mask is an
  //     element() ref AND the author hasn't picked a mode explicitly, switch
  //     to luminance for spec compliance.
  const hasElementLayer = layers.some((l) => /^element\(\s*#/i.test(l.trim()));
  let maskType: "alpha" | "luminance";
  if (maskMode === "luminance") maskType = "luminance";
  else if (maskMode === "alpha") maskType = "alpha";
  else maskType = hasElementLayer ? "luminance" : "alpha";

  // Per-layer contents. contents[li] = array of SVG strings (gradient defs
  // + painted rect/image) for layer li. We keep each layer separate so
  // mask-composite: intersect can emit one <mask> per layer and chain them
  // via the `mask` attribute on nested content (intersection). For plain
  // mask-composite: add (the default) we flatten all layers into a single
  // <mask> — SVG's native layer-stacking is additive.
  const layerContents: string[][] = [];
  for (let li = 0; li < layers.length; li++) layerContents.push([]);
  // Set when we encountered an SVG url() mask source that we deliberately
  // contribute no content for (SK-859/SK-860). An empty <mask> hides the
  // element entirely in SVG, matching Chrome's observed behavior for these
  // sources. Without this flag an all-empty layer list would skip mask
  // emission altogether and the element would show UNMASKED (opposite of
  // what we want), so force emission of an empty mask when it's set.
  let forceHide = false;
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li].trim();
    const layerSize = (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim();
    const layerPos = (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim();
    const layerRepeat = (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim();
    const contents = layerContents[li];
    const gradient = /^(?:repeating-)?(linear|radial)-gradient\(/i.test(layer);
    if (gradient) {
      // Resolve mask-size (defaults to 'auto' = full element box) and
      // mask-position (defaults to 0% 0%) so gradient masks honor the same
      // positioning model as url() masks. mask-size:80px+mask-position:25% 25%
      // means the gradient is painted in an 80x80 patch positioned 25%/25% of
      // the available space — not stretched to fill the whole element.
      let gradW = w, gradH = h;
      const sizeTok = layerSize.trim().split(/\s+/);
      const resolveSize = (tok: string, basis: number, fallback: number): number => {
        if (tok == null || tok === "auto" || tok === "") return fallback;
        if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
        return parseFloat(tok) || fallback;
      };
      if (layerSize === "contain" || layerSize === "cover" || layerSize === "auto" || layerSize === "") {
        gradW = w; gradH = h;
      } else {
        gradW = resolveSize(sizeTok[0], w, w);
        gradH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : gradW;
      }
      const posTok = layerPos.trim().split(/\s+/);
      const resolveH = (t: string): number => {
        if (t === "left") return 0;
        if (t === "right") return w - gradW;
        if (t === "center") return (w - gradW) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - gradW);
        return parseFloat(t) || 0;
      };
      const resolveV = (t: string): number => {
        if (t === "top") return 0;
        if (t === "bottom") return h - gradH;
        if (t === "center") return (h - gradH) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - gradH);
        return parseFloat(t) || 0;
      };
      const gx = elX + resolveH(posTok[0] ?? "0%");
      const gy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
      const gradId = `${id}g${li}`;
      const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
      const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
      let def = "";
      if (linear != null) def = buildLinearGradientDef(gradId, linear[1], /^repeating-/i.test(layer), gradW, gradH, gx, gy);
      else if (radial != null) def = buildRadialGradientDef(gradId, radial[1], /^repeating-/i.test(layer), gx, gy, gradW, gradH);
      if (def === "") continue;
      contents.push(def);
      contents.push(`<rect x="${r(gx)}" y="${r(gy)}" width="${r(gradW)}" height="${r(gradH)}" fill="url(#${gradId})" />`);
      continue;
    }
    // DM-494: `element(#id)` paint reference — emit the post-capture
    // rasterized <image> directly into the <mask>. Position + size honor
    // mask-position / mask-size on the consuming element; mask-size:auto
    // uses the referenced element's painted box dimensions (the spec's
    // "natural size" for element()).
    const elementMatch = /^element\(\s*#([^)\s]+)\s*\)$/i.exec(layer);
    if (elementMatch != null) {
      if (elementRasters == null) continue;
      const refId = elementMatch[1];
      const raster = elementRasters.get(refId);
      if (raster == null || raster.dataUri == null) continue;
      const intrinsic = { w: raster.width, h: raster.height };
      let imgW = intrinsic.w, imgH = intrinsic.h;
      const sizeTok = layerSize.trim().split(/\s+/);
      const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
        if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
        if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
        return parseFloat(tok) || intrinsicDim;
      };
      let par: "meet" | "slice" = "meet";
      if (layerSize === "contain") {
        const scale = Math.min(w / intrinsic.w, h / intrinsic.h);
        imgW = intrinsic.w * scale;
        imgH = intrinsic.h * scale;
        par = "meet";
      } else if (layerSize === "cover") {
        const scale = Math.max(w / intrinsic.w, h / intrinsic.h);
        imgW = intrinsic.w * scale;
        imgH = intrinsic.h * scale;
        par = "slice";
      } else {
        imgW = resolveSize(sizeTok[0], w, intrinsic.w);
        imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, intrinsic.h) : imgW * (intrinsic.h / intrinsic.w);
      }
      const posTok = layerPos.trim().split(/\s+/);
      const resolveH = (t: string): number => {
        if (t === "left") return 0;
        if (t === "right") return w - imgW;
        if (t === "center") return (w - imgW) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - imgW);
        return parseFloat(t) || 0;
      };
      const resolveV = (t: string): number => {
        if (t === "top") return 0;
        if (t === "bottom") return h - imgH;
        if (t === "center") return (h - imgH) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - imgH);
        return parseFloat(t) || 0;
      };
      const ix = elX + resolveH(posTok[0] ?? "0%");
      const iy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
      contents.push(`<image href="${raster.dataUri}" x="${r(ix)}" y="${r(iy)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="xMidYMid ${par}" />`);
      continue;
    }
    const url = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(layer);
    if (url != null) {
      // Chrome hides the element entirely for `mask-image: url(*.svg)` —
      // whether no-repeat + contain (SK-860) or repeat + sized (SK-859). The
      // likely cause is mask-mode: match-source resolving to luminance for
      // SVG sources and the common icon SVG (transparent background + a
      // colored shape) computing near-zero luminance over most of the tile,
      // so the mask alpha is effectively zero. Reproducing that ourselves
      // would need embedding an <image> inside the mask with mask-type
      // sampling logic that matches Chrome's exact source-type resolution,
      // which is complex and variable across renderer versions. User
      // guidance on SK-859/SK-860: match Chrome by rendering nothing.
      // Contribute no mask content for this layer — the element gets hidden
      // wherever an SVG url() mask layer claims it, matching Chrome.
      const urlHref = url[1];
      if (/\.svg(\?|#|$)/i.test(urlHref)) { forceHide = true; continue; }
      // For no-repeat mask images, emit the image DIRECTLY inside the mask —
      // not wrapped in a pattern + filled rect. The pattern+rect path paints
      // the rect opaque where the pattern is transparent, defeating alpha
      // masking. Direct <image> makes the sources alpha channel propagate
      // cleanly: opaque pixels = mask visible, transparent pixels = hidden.
      const isNoRepeat = /\bno-repeat\b/i.test(layerRepeat);
      if (isNoRepeat) {
        // Resolve mask-size + mask-position to a concrete image rect.
        let imgW = w, imgH = h;
        const sizeTok = layerSize.trim().split(/\s+/);
        const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
          if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
          if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
          return parseFloat(tok) || intrinsicDim;
        };
        if (layerSize === "contain" || layerSize === "cover") {
          // We don't have intrinsic mask-image dims without new Image(). For
          // now approximate with element box (contain = fit inside, cover = fill).
          // This is close enough for the common icon-mask case.
          imgW = w; imgH = h;
        } else {
          imgW = resolveSize(sizeTok[0], w, w);
          imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : imgW;
        }
        const posTok = layerPos.trim().split(/\s+/);
        const resolveH = (t: string): number => {
          if (t === "left") return 0;
          if (t === "right") return w - imgW;
          if (t === "center") return (w - imgW) / 2;
          if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - imgW);
          return parseFloat(t) || 0;
        };
        const resolveV = (t: string): number => {
          if (t === "top") return 0;
          if (t === "bottom") return h - imgH;
          if (t === "center") return (h - imgH) / 2;
          if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - imgH);
          return parseFloat(t) || 0;
        };
        const ix = elX + resolveH(posTok[0] ?? "0%");
        const iy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
        contents.push(`<image href="${esc(embedResizedDataUri(url[1], imgW, imgH))}" x="${r(ix)}" y="${r(iy)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="xMidYMid ${layerSize === "contain" ? "meet" : layerSize === "cover" ? "slice" : "meet"}" />`);
      } else {
        // Repeating mask: fall back to pattern. Since mask-type=alpha, the
        // pattern itself needs to be backed by an <image> that's clipped to
        // the tile size so outside-tile pixels are transparent.
        const patId = `${id}p${li}`;
        const patDef = buildImagePatternDef(patId, url[1], elX, elY, w, h, layerSize, layerPos, layerRepeat, null);
        if (patDef === "") continue;
        contents.push(patDef);
        contents.push(`<rect x="${r(elX)}" y="${r(elY)}" width="${r(w)}" height="${r(h)}" fill="url(#${patId})" />`);
      }
    }
  }
  // Drop empty layers (e.g. unsupported layer values) to simplify downstream.
  const nonEmpty = layerContents.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) {
    if (forceHide) {
      // Empty <mask> hides the referenced element — matches Chrome's empty
      // rendering for SVG url() mask sources.
      return { id, def: `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}"></mask>` };
    }
    return { id, def: "" };
  }

  // Resolve per-layer composite operator. CSS accepts one value applied to
  // all layers or a comma-separated list. Only `intersect` needs special
  // handling — add is the SVG default, subtract/exclude aren't representable
  // with nested masks alone (would need filter feComposite) so we fall back
  // to add for those and warn via the captureWarnings pipeline.
  const composite = (compositeLayers[0] ?? "add").trim();
  const isIntersect = composite === "intersect"
    && compositeLayers.every((c) => c.trim() === "intersect");

  // For the default add case (single layer OR all-add), flatten every
  // layer's contents into one <mask>. SVG stacks them additively — alpha
  // accumulates where layers overlap.
  if (!isIntersect || nonEmpty.length === 1) {
    const flat = nonEmpty.flat().join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${flat}</mask>`;
    return { id, def };
  }

  // Intersect: chain N masks so each layer gates the next. Layer 0 is the
  // outer mask (the one the element references); each layer's painted rect
  // carries a mask="url(#inner)" attribute pointing at layer i+1, so its
  // pixels only show where layer i+1 is also opaque. Walk from the innermost
  // layer outward so we can reference already-built inner mask ids.
  const defs: string[] = [];
  let innerId: string | null = null;
  for (let li = nonEmpty.length - 1; li >= 0; li--) {
    const isOuter = li === 0;
    const layerMaskId = isOuter ? id : `${id}i${li}`;
    // The last item in each layer's contents is the rect/image that PAINTS
    // the mask source (earlier entries are supporting defs like <pattern>
    // or <linearGradient>). Attach mask=url(#innerId) to that paint so it's
    // clipped by the inner mask.
    const items = nonEmpty[li].slice();
    if (innerId != null && items.length > 0) {
      const last = items[items.length - 1];
      // Inject mask="..." before the closing /> (works for <rect .../> and
      // <image .../>). Safe because these are single self-closing tags we
      // emit ourselves earlier in this function.
      items[items.length - 1] = last.replace(/\/>$/, ` mask="url(#${innerId})"/>`);
    }
    defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${items.join("")}</mask>`);
    innerId = layerMaskId;
  }
  return { id, def: defs.join("") };
}

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
function translateClipPath(value: string, x: number, y: number, w: number, h: number): string {
  const resolvePx = (tok: string, basis: number): number => {
    const t = tok.trim();
    if (t === "center") return basis / 2;
    if (t === "top" || t === "left") return 0;
    if (t === "bottom" || t === "right") return basis;
    if (/%$/.test(t)) return (parseFloat(t) / 100) * basis;
    return parseFloat(t) || 0;
  };
  const inset = /^inset\(([^)]+)\)$/i.exec(value);
  if (inset != null) {
    // CSS: inset(top [right [bottom [left]]] [round <border-radius>]).
    // Split off the optional `round R...` suffix first; what's left is the
    // inset offsets.
    const innerStr = inset[1].trim();
    const roundIdx = innerStr.search(/\bround\b/i);
    const insetStr = roundIdx >= 0 ? innerStr.slice(0, roundIdx).trim() : innerStr;
    const radiusStr = roundIdx >= 0 ? innerStr.slice(roundIdx + 5).trim() : "";
    const parts = insetStr.split(/\s+/);
    const top = resolvePx(parts[0], h);
    const right = resolvePx(parts[1] ?? parts[0], w);
    const bottom = resolvePx(parts[2] ?? parts[0], h);
    const left = resolvePx(parts[3] ?? parts[1] ?? parts[0], w);
    let rx = 0, ry = 0;
    if (radiusStr !== "") {
      // border-radius shorthand here can be 1-4 values, optionally with a `/`
      // separator for rx/ry pairs. Common cases: single value, two values.
      // We collapse to a uniform rx=ry using the first horizontal radius.
      const slashIdx = radiusStr.indexOf("/");
      const hPart = (slashIdx >= 0 ? radiusStr.slice(0, slashIdx) : radiusStr).trim();
      const vPart = (slashIdx >= 0 ? radiusStr.slice(slashIdx + 1) : hPart).trim();
      const hTok = hPart.split(/\s+/);
      const vTok = vPart.split(/\s+/);
      rx = resolvePx(hTok[0] ?? "0", w);
      ry = resolvePx(vTok[0] ?? hTok[0] ?? "0", h);
    }
    const rectAttrs = `x="${r(x + left)}" y="${r(y + top)}" width="${r(w - left - right)}" height="${r(h - top - bottom)}"`;
    const radiusAttrs = rx > 0 || ry > 0 ? ` rx="${r(rx)}" ry="${r(ry)}"` : "";
    return `<rect ${rectAttrs}${radiusAttrs} />`;
  }
  const circle = /^circle\(([^)]*)\)$/i.exec(value);
  if (circle != null) {
    const inner = circle[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiusPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const radiusBasis = Math.sqrt((w * w + h * h) / 2);
    const radius = radiusPart === "" ? Math.min(w, h) / 2 : resolvePx(radiusPart, radiusBasis);
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    return `<circle cx="${r(x + cx)}" cy="${r(y + cy)}" r="${r(radius)}" />`;
  }
  const ellipse = /^ellipse\(([^)]*)\)$/i.exec(value);
  if (ellipse != null) {
    const inner = ellipse[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiiPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const radii = radiiPart === "" ? [w / 2, h / 2] : radiiPart.split(/\s+/).map((s, i) => resolvePx(s, i === 0 ? w : h));
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    return `<ellipse cx="${r(x + cx)}" cy="${r(y + cy)}" rx="${r(radii[0])}" ry="${r(radii[1] ?? radii[0])}" />`;
  }
  const polygon = /^polygon\(([^)]+)\)$/i.exec(value);
  if (polygon != null) {
    const pts = polygon[1].split(",").map((pair) => {
      const [px, py] = pair.trim().split(/\s+/);
      return `${r(x + resolvePx(px, w))},${r(y + resolvePx(py, h))}`;
    });
    return `<polygon points="${pts.join(" ")}" />`;
  }
  // path("M ... Z") — coordinates are in the element's reference box (border-
  // box by default), so apply a translate(x,y) transform directly on the
  // <path> element. SVG's <clipPath> doesn't accept <g> wrappers — only basic
  // shapes, <path>, and <use> — so the transform has to live on the path
  // itself, not on a group.
  const pathFn = /^path\(\s*(?:"([^"]+)"|'([^']+)')\s*\)$/i.exec(value);
  if (pathFn != null) {
    const d = pathFn[1] ?? pathFn[2] ?? "";
    if (d === "") return "";
    const transform = (x === 0 && y === 0) ? "" : ` transform="translate(${r(x)},${r(y)})"`;
    return `<path d="${d}"${transform} />`;
  }
  return "";
}

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
function formatListMarker(type: string, n: number): string {
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
    default:
      return String(n);
  }
}

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
  if (style === "dashed") {
    // Chromium's `StyledStrokeData::DashLengthRatio` / `DashGapRatio` (in
    // `third_party/blink/renderer/platform/graphics/styled_stroke_data.cc`):
    //   dash = thickness >= 3 ? 2.0 * width : 3.0 * width
    //   gap  = thickness >= 3 ? 1.0 * width : 2.0 * width
    // So thick borders (≥ 3 px) get 2:1 dash:gap, thin borders (1-2 px)
    // get 3:2. Verified directly from Chromium source — DM-437 / DM-420.
    const idealDash = width >= 3 ? width * 2 : width * 3;
    const idealGap = width >= 3 ? width : width * 2;
    const idealPeriod = idealDash + idealGap;
    const cycles = Math.max(1, Math.round(sideLength / idealPeriod));
    const scale = sideLength / (cycles * idealPeriod);
    const dash = idealDash * scale;
    const gap = idealGap * scale;
    // Center the dash pattern so each side has gap/2 of margin at each
    // corner. stroke-dashoffset specifies the distance into the cycle where
    // the line starts; cycle is `dash gap`, so an offset of `dash + gap/2`
    // places the line start mid-gap and the first dash visible at gap/2 —
    // matching Chromium's BoxBorderPainter (DM-318).
    return { array: `${r(dash)} ${r(gap)}`, offset: dash + gap / 2 };
  }
  if (style === "dotted") {
    // Dot diameter = width (round-cap on near-zero dash). Dot center spacing
    // = `2 * width`, so each cycle (dot + gap) = 2 * width.
    // Empirical re-probe (DM-419): Chrome paints `ceil(sideLength / period)`
    // cycles, not `round`. For a 3 px dotted border on an 80 px side,
    // Chrome paints 14 dots while our `round(80/6) = 13` was off-by-one.
    const idealPeriod = width * 2;
    const cycles = Math.max(1, Math.ceil(sideLength / idealPeriod));
    const adjustedPeriod = sideLength / cycles;
    // Shift the cycle so the first dot is at adjustedPeriod / 2 from the
    // start, matching Chrome's centered-dot painting. The cycle is
    // `0.01 adjustedPeriod`, total ≈ adjustedPeriod; an offset of
    // adjustedPeriod / 2 starts mid-gap.
    return { array: `0.01 ${r(adjustedPeriod)}`, offset: adjustedPeriod / 2 };
  }
  return { array: "", offset: 0 };
}
