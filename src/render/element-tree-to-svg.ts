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
import { renderPseudoFragmentSlot, type PseudoFragmentPaintSlot } from "./pseudo-fragments.js";
import { getEmbeddedFontFaceCss, getGlyphDefs, renderRadicalGlyph, renderSourceOwnedTextBoundary, pushBaselineSnapSuppression, popBaselineSnapSuppression } from "./text-to-path.js";
import { beginCharacterFallbackDocument, endCharacterFallbackDocument } from "./font-resolution.js";
import { profAccum, profNow } from "./render-profile.js";
import type { DefCtx } from "./form-controls.js";
import { renderFileSelectorOutsetShadow, renderFormControl } from "./form-controls.js";
import { CAPTURE_SCRIPT } from "../capture/script.generated.js";
import { r, esc, stopFmt, rootSvgA11y } from "./format.js";
import { clipPathShapeForElement, translateClipPath } from "./clip-path.js";
import { buildImagePatternDef, cyclicBackgroundLayer } from "./image-pattern.js";
import { buildLinearGradientDef, buildRadialGradientDef, parseBgPositionPx, type GradientStop } from "./gradient-defs.js";
import { advancedGradientTile, needsChromiumGradientRaster } from "./advanced-gradient-raster.js";
import { computeTileSize } from "./conic-raster.js";
import { isFlexOrGridContainerDisplay, establishesStackingContext, gatherStackingContextChildren, isOverflowOnlySC, isFixedContainingBlock, paintOrderBuckets, paintsAtomicallyAsInlineBox, type PaintOrderBuckets } from "./stacking.js";
export { parseGradientStops, buildRadialGradientDef, parseBgPositionPx } from "./gradient-defs.js"; // re-export for existing test importers
import { buildMaskDef, buildMaskBorder9Slice, positionFragmentMaskDef, positionFragmentClipPathDef, rewriteFragmentMaskDef } from "./mask.js";
// Re-export mask helpers used by focused geometry/emission tests.
export { buildMaskDef, maskPaintAreas, positionFragmentMaskDef, rewriteFragmentMaskDef } from "./mask.js";
export { resolveMaskContainCoverRect, resolveMaskPosition, resolveMaskPositionAxis } from "./mask-position.js";
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
  roundBorderSideClipPolygon,
  hyperellipseBorderSideClipPolygon,
  contouredRectIntersectionPaths,
  findOffGridCollapsedCells,
  doubleBorderStripeGeometry,
  selectBestDashGap,
  type CornerRadii,
  type CornerRadiusPair,
  type BorderSide,
} from "./borders.js";
import { parseBoxShadow, type BoxShadow } from "./box-shadow.js";
import {
  capturedBoxRespectsCssOverflow,
  isOverflowReplacedElement,
  isOverflowRespectingReplacedElement,
  overflowClipMarginGeometry,
  overflowClipMarginOuterExtension,
  usedOverflowClipMargin,
  type OverflowClipMarginGeometry,
} from "./overflow-clip.js";
import { cssTransformToSvg } from "./transforms.js";
import { parseCssUrl, splitTopLevelCommas } from "./css-tokens.js";
import { buildLinearGradientDef as buildExactLinearGradientDef, parseLegacyWebkitLinearGradient } from "./gradients.js";
import { blinkPhysicalSymbolMarkerRect, blinkSymbolMarkerGeometry, disclosureTriangle, pixelSnapRect, type SymbolMarkerType } from "./list-marker-geometry.js";
import type { CapturedBackgroundImage, CapturedElement, TextSegment, MaskFragmentDef, MaskRasterRef, ClipPathFragmentDef, CaptureWarning } from "../capture/types.js";
import {
  _dataUriCache,
  _resizedDataUriCache,
  embedResizedDataUri,
  embedRemoteImages,
  resolveSvgSource,
  setActiveHiDPIFactor,
  type EmbedRemoteImagesOptions,
} from "../capture/embed.js";
import { inlineImgSvg, prefixSvgClasses, prefixSvgIds } from "./svg-inline.js";
import { hoistDuplicateImagePayloads } from "../post-processing/hoist-image-payloads.js";
import { propagateTextDecorations } from "../tree-ops/decoration-propagation.js";
import { getLastCaptureWarnings, logCaptureWarnings, _resetLastCaptureWarnings } from "../capture/warnings.js";
import { rasterizeBitmapGlyphs } from "../capture/emoji.js";
import { blinkPlatformResizerStrokes } from "./resize-handle.js";
import { wrapPseudoPaintEffects } from "./pseudo-filter.js";
import { paintCustomScrollbars, type CustomScrollbarVectorPart } from "./custom-scrollbar.js";
import { paintNativeScrollbarRasters } from "./native-scrollbar-raster.js";
import { intersectBackgroundRects, resolveBackgroundAttachment } from "./background-attachment.js";
import { renderBrokenImageFallback } from "./broken-image-fallback.js";
import {
  buildEmittedTextCtmMap,
  prepareAffineTextPaint,
  wrapAffineTextPaint,
} from "./text-affine.js";

// Public-API re-exports kept here for backward compatibility — older imports
// from `./render/element-tree-to-svg.js` keep resolving. Internal consumers
// should prefer importing from `../capture/{embed,warnings,index}.js` directly.
export { _dataUriCache, _resizedDataUriCache, embedResizedDataUri, embedRemoteImages, resolveSvgSource, type EmbedRemoteImagesOptions } from "../capture/embed.js";
export { getLastCaptureWarnings, logCaptureWarnings } from "../capture/warnings.js";
export { captureElementTree, captureElementTreeWithWarnings, calibrateBaselines } from "../capture/index.js";

/** Resolve Blink's used overflow-clip-margin and its corrected paint contour. */
function resolvedOverflowClipMarginGeometry(
  el: CapturedElement,
  corners: CornerRadii,
): OverflowClipMarginGeometry | null {
  const isReplaced = isOverflowReplacedElement(el.tag, el.styles.inputType);
  const respectsCssOverflow = isReplaced
    ? isOverflowRespectingReplacedElement(el.tag)
    : capturedBoxRespectsCssOverflow(
        el.tag,
        el.styles.display,
        el.styles.rootOverflowX,
        el.styles.rootOverflowY,
      );
  const value = usedOverflowClipMargin(el.styles.overflowClipMargin, {
    overflowX: el.styles.overflowX,
    overflowY: el.styles.overflowY,
    contain: el.styles.contain,
    isReplaced,
    respectsCssOverflow,
  });
  if (value == null) return null;
  const side = (value: string | undefined): number => parseFloat(value ?? "0") || 0;
  return overflowClipMarginGeometry(
    { x: el.x, y: el.y, width: el.width, height: el.height },
    {
      top: side(el.styles.borderTopWidth),
      right: side(el.styles.borderRightWidth),
      bottom: side(el.styles.borderBottomWidth),
      left: side(el.styles.borderLeftWidth),
    },
    {
      top: side(el.styles.paddingTop),
      right: side(el.styles.paddingRight),
      bottom: side(el.styles.paddingBottom),
      left: side(el.styles.paddingLeft),
    },
    corners,
    value,
  );
}

/**
 * @internal — DM-549. Per-conic-gradient-layer-text map of `${tileW}x${tileH}` →
 * data URI containing rasterized PNG bytes. Normally populated from the live
 * page by `rasterizeAdvancedGradients`; `rasterizeConicGradients` fills only
 * missing entries for direct-tree/helper-absent callers. Read by
 * `buildConicGradientDef` (DM-550) when
 * the renderer emits a `<pattern><image>` for a conic background layer. Empty
 * at module load — first capture with conic content fills it.
 */
export const _conicTileCache = new Map<string, Map<string, string>>();


/**
 * Wrap inner SVG markup (as returned by `elementTreeToSvg`) in a complete
 * `<svg>` document with the standard namespace, viewBox, and intrinsic size.
 * This is the boilerplate every standalone-capture user would otherwise write
 * themselves — call this when you want a self-contained SVG file.
 *
 * Also shares repeated raster payloads (`hoistDuplicateImagePayloads`): the
 * `<image>` emit is per-element, so a logo used in six places used to serialize
 * its bytes six times. No-op for a document with nothing repeated.
 */
export function wrapSvg(inner: string, width: number, height: number, opts?: { tree?: CapturedElement[]; title?: string; desc?: string }): string {
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
  const a11y = rootSvgA11y(opts?.title, opts?.desc);
  return hoistDuplicateImagePayloads(
    `<svg xmlns="http://www.w3.org/2000/svg"${xlinkAttr} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${schemeAttr}${a11y.roleAttr}>${a11y.markup}${rootBgRect}${inner}</svg>`,
  );
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
// Shared paint context threaded through the per-phase paint helpers (DM-1317).
// Bundles the two output accumulators + the clip-id allocator so the helpers
// push directly instead of each returning { svg, defs, clipIdx } for the caller
// to merge. `nextClipId` / `peekClipIdx` / `advanceClipIdx` close over the
// single `clipIdx` counter in elementTreeToSvgInner, so the inline render code
// (which still uses that counter directly) and the helpers stay on ONE globally
// ordered id sequence — making a mis-threaded counter structurally impossible.
interface PaintCtx {
  svgParts: string[];
  defsParts: string[];
  idPrefix: string;
  // Allocate the next clip/filter/gradient id: `${idPrefix}${prefix}${n++}`.
  nextClipId(prefix: string): string;
  // Read the current counter (to seed a sub-allocator like renderBorderImage).
  peekClipIdx(): number;
  // Advance the counter by n (after a sub-allocator consumed n ids).
  advanceClipIdx(n: number): void;
  /** Static SVG CTM already surrounding each text branch (DM-2470). */
  emittedTextCtm: ReturnType<typeof buildEmittedTextCtmMap>;
}

// DM-1342: explicit render-context struct threaded through the lifted render
// functions (`renderElement`, `renderElementWithOverflowClip`,
// `renderInlineFragments`, `renderMaskPhase`, `resolveFragmentMaskRef`,
// `resolveFragmentClipPathRef`). These were nested closures inside
// `elementTreeToSvgInner` capturing ~18 shared `let`/`const` locals; lifting
// them to module scope makes that shared state explicit. The `svgParts` /
// `defsParts` arrays and every Map/Set are passed by reference so the lifted
// functions and the remaining `elementTreeToSvgInner` driver code mutate the
// same objects. The two fragment counters are by-value, so they live ON the
// struct (`state.fragmentMaskCounter++`) rather than being destructured.
interface RenderState {
  svgParts: string[];
  defsParts: string[];
  paintCtx: PaintCtx;
  defCtx: DefCtx;
  /** Viewport dims for `background-attachment: fixed`. */
  captureViewport: { w: number; h: number };
  /** Capture dims, passed to `paintBorder` for fieldset/legend notch math. */
  width: number;
  height: number;
  idPrefix: string;
  hoistedFromAncestor: Set<CapturedElement>;
  overflowClipForHoisted: Map<CapturedElement, CapturedElement>;
  overflowClipPathIds: Map<CapturedElement, string>;
  offGridCollapsedCells: Set<CapturedElement>;
  elementMaskRasters: Map<string, MaskRasterRef>;
  fragmentMaskDefs: Map<string, MaskFragmentDef>;
  fragmentMaskOutputId: Map<string, string>;
  fragmentMaskCounter: number;
  fragmentClipPathDefs: Map<string, ClipPathFragmentDef>;
  fragmentClipPathOutputId: Map<string, string>;
  fragmentClipPathCounter: number;
  /**
   * Per-element results that must survive the block→inline phase split: an
   * element painted in two passes (see `PaintPhase`) resolves each of these
   * ONCE, in whichever pass reaches it first, and reuses it in the other.
   * Re-resolving would mint a second `<clipPath>` / `<mask>` id, shift the
   * positional id counter, and — for the child plan, whose builder marks
   * hoisted descendants in a shared set — return a different answer the
   * second time.
   */
  elementClipPathIds: Map<CapturedElement, string | null>;
  elementMaskIds: Map<CapturedElement, string | null>;
  childPlans: Map<CapturedElement, ChildPaintPlan>;
  /**
   * `background-clip: text` fills, produced with the element's background
   * layers in the box phase and consumed by its text in the inline phase.
   */
  bgClipTextFills: Map<CapturedElement, {
    fills: ReturnType<typeof paintBackgroundImageLayers>["fills"];
    fragmentFills: ReturnType<typeof paintBackgroundImageLayers>["fragmentFills"];
  }>;
}

/**
 * Which half of an element's paint this `renderElement` call emits.
 *
 * CSS 2.1 Appendix E orders a stacking context's paint so that the background
 * and border of EVERY in-flow block-level descendant (step 3) precede EVERY
 * non-positioned float (step 4), which in turn precede EVERY piece of in-flow
 * inline content — text, inline boxes, replaced content (step 5). Steps 3-5
 * are context-wide, not per-element: a float in the first paragraph paints
 * below the third paragraph's text, and above a later block sibling's
 * background.
 *
 * An element's box and its inline content therefore cannot be emitted in one
 * pass — the context's floats belong between them. So a stacking context walks
 * its in-flow block descendants TWICE:
 *   - `"box"` emits only box decorations (shadows, background layers, border,
 *     outline) and recurses into block-level children in the same phase.
 *   - `"inline"` emits only inline content (text, replaced content, markers,
 *     pseudo content) and recurses into block-level children in the same
 *     phase, then paints the positioned / stacking-context children.
 *   - `"all"` is one atomic unit — box phase then inline phase back to back,
 *     with the context's floats in between. Used for a stacking-context root,
 *     an inline-level box, a float, and anything else CSS paints "as if it
 *     created a new stacking context".
 */
type PaintPhase = "all" | "box" | "inline";

/**
 * A stacking context's children, bucketed by paint step and resolved once per
 * element (see `RenderState.childPlans`).
 */
interface ChildPaintPlan {
  buckets: PaintOrderBuckets;
  /** `el.styles.display`, passed down as the children's parent display. */
  childDisplay: string | undefined;
  /**
   * DM-751: under `transform-style: preserve-3d` children are re-sorted by
   * their translateZ, which interleaves the paint-step buckets. Such a
   * context keeps the pre-split behavior: one flat list, each child painted
   * atomically, at the position children have always been emitted (after the
   * parent's own inline content).
   */
  flat3d: CapturedElement[] | null;
}

function paintBoxShadow(
  ctx: PaintCtx,
  el: CapturedElement,
  corners: ReturnType<typeof parseCornerRadii>,
  indent: string,
): void {
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
      const fid = ctx.nextClipId("sh");
      // Filter region needs to extend beyond the shadow rect by enough
      // padding to keep the Gaussian fall-off from clipping. Use a
      // generous 200% on each side; primitiveUnits inherits the default
      // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
      ctx.defsParts.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
      );
      filterAttr = ` filter="url(#${fid})"`;
    }
    ctx.svgParts.push(
      `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr}`)}`,
    );
  }
  return;
}

// Image (<img> / <input type=image>) paint, extracted from renderElement (DM-1306,
// DM-1312). object-fit placement inside the content box, scale-down resolution,
// and the rounded-content-box clip for border-radius'd images. clipIdx is threaded
// in and returned so the positional clipPath ids stay byte-identical.
function paintImage(
  ctx: PaintCtx,
  el: CapturedElement,
  borderRadius: number,
  corners: ReturnType<typeof parseCornerRadii>,
  indent: string,
): void {
  // Caller guards `el.imageSrc != null`; restate it here to narrow the type
  // (the original block was nested inside that guard in renderElement).
  if (el.imageSrc == null) return;
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
  const intrinsic = el.imageIntrinsic;
  const objectRect = intrinsic != null && intrinsic.w > 0 && intrinsic.h > 0
    ? computeObjectFitRect(contentX, contentY, contentW, contentH, intrinsic.w, intrinsic.h, fit, el.styles.objectPosition)
    : null;
  // DM-670 / DM-672: if the `<img>` carries a border-radius, the painted
  // image must clip to the rounded content area — otherwise a 40×40
  // `border-radius: 50%` avatar paints as a square photo. Build a
  // rounded-content-box clip once, reuse it whether we take the
  // object-fit:none branch or the standard branch below.
  const innerCorners = (borderRadius > 0 || (corners.tl.h + corners.tr.h + corners.bl.h + corners.br.h) > 0)
    ? insetCornerRadii(corners, _bwT, _bwR, _bwB, _bwL)
    : null;
  // DM-2419: replaced elements that respect CSS overflow use the same
  // corrected overflow-clip-margin contour as ordinary rounded boxes. This
  // also covers the UA's `img { overflow:clip; overflow-clip-margin:
  // content-box }`: ref-box-only zero is active and contracts the padding-edge
  // contour to the content box. Without this branch object-fit:none was still
  // hard-clipped to the old rectangular content edge.
  const overflowMarginClip = resolvedOverflowClipMarginGeometry(el, corners);
  const imageClip = overflowMarginClip ?? (innerCorners == null ? null : {
    x: contentX, y: contentY, width: contentW, height: contentH, corners: innerCorners,
  });
  const roundedClipId = imageClip != null ? ctx.nextClipId("irc") : null;
  if (imageClip != null && roundedClipId != null) {
    ctx.defsParts.push(
      `<clipPath id="${roundedClipId}">${roundedRectSvg(imageClip.x, imageClip.y, imageClip.width, imageClip.height, imageClip.corners, "")}</clipPath>`,
    );
  }
  if (objectRect != null) {
    // Blink's LayoutReplaced computes one concrete paint rectangle for every
    // object-fit value, then resolves object-position against the remaining
    // free space. Emitting that rectangle directly preserves arbitrary
    // percentages/calc lengths and scale-down's none-vs-contain choice; SVG's
    // preserveAspectRatio alignment only has min/mid/max buckets.
    const { x: ix, y: iy, width: iw, height: ih } = objectRect;
    // When a border-radius is present, prefer the rounded clip over the
    // plain content-box rect (a rounded clip subsumes the rect clip:
    // anything inside the rounded shape is also inside the box).
    let clipId: string;
    if (roundedClipId != null) {
      clipId = roundedClipId;
    } else {
      clipId = ctx.nextClipId("ifn");
      ctx.defsParts.push(`<clipPath id="${clipId}"><rect x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" /></clipPath>`);
    }
    // DM-1592: an SVG source under `object-fit: none` inlines as a native
    // `<svg>` at its intrinsic size (iw×ih), positioned by object-position and
    // clipped to the content box — the object-fit:none counterpart of the
    // standard-branch native path (DM-1588). iw×ih IS the SVG's intrinsic size,
    // so its own viewBox maps 1:1; `xMidYMid meet` (the SVG default) keeps that
    // exact with no distortion. Falls back to the raster `<image>` when the
    // source isn't SVG or has no usable coordinate system.
    const svgTextNone = resolveSvgSource(el.imageSrc);
    const inlinedNone = svgTextNone != null
      ? inlineImgSvg(svgTextNone, {
          x: ix, y: iy, w: iw, h: ih,
          par: "none", intrinsic: el.imageIntrinsic, idPrefix: ctx.nextClipId("svgimg"),
        })
      : null;
    if (inlinedNone != null) {
      ctx.svgParts.push(`${indent}<g clip-path="url(#${clipId})">${inlinedNone}</g>`);
    } else {
      ctx.svgParts.push(
        `${indent}<image href="${esc(embedResizedDataUri(el.imageSrc, iw, ih))}" x="${r(ix)}" y="${r(iy)}" width="${r(iw)}" height="${r(ih)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`,
      );
    }
  } else {
    const par = preserveAspectRatioFor(fit, el.styles.objectPosition);
    const clipAttr = roundedClipId != null ? ` clip-path="url(#${roundedClipId})"` : "";
    // DM-1588: an `<img src="*.svg">` embeds today as a `data:image/svg+xml`
    // `<image>`, which Chromium rasterizes at the layout size then scales —
    // so it softens/aliases at high zoom. Inline the SVG as a native, truly
    // vector nested `<svg>` instead (also drops the ~33% base64 bloat). Only
    // SVG sources take this path; raster `<img>` (PNG/JPEG/…) stays `<image>`.
    // A source with no usable coordinate system returns null → raster fallback.
    const svgText = resolveSvgSource(el.imageSrc);
    if (svgText != null) {
      const inlined = inlineImgSvg(svgText, {
        x: contentX, y: contentY, w: contentW, h: contentH,
        par, intrinsic: el.imageIntrinsic, idPrefix: ctx.nextClipId("svgimg"),
      });
      if (inlined != null) {
        ctx.svgParts.push(
          roundedClipId != null
            ? `${indent}<g clip-path="url(#${roundedClipId})">${inlined}</g>`
            : `${indent}${inlined}`,
        );
        return;
      }
    }
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
    ctx.svgParts.push(
      `${indent}<image href="${esc(reHomedSrc)}" x="${r(contentX)}" y="${r(contentY)}" width="${r(contentW)}" height="${r(contentH)}" preserveAspectRatio="${outerPar}"${clipAttr} />`,
    );
  }
  return;
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
/**
 * Synthesize + emit a list-item marker for a non-image `list-style-type`
 * (extracted from `paintListMarker`, DM-1458). Handles a custom `::marker`
 * content string, the disc/circle/square shape markers, and the text markers
 * (decimal / alpha / roman / etc.), each resolving its own ::marker color /
 * font / position before emitting. The body is unchanged from the inline
 * branch, so output is byte-identical.
 */
function paintSyntheticListMarker(
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  indent: string,
  fontSizePx: number,
  lineHeightPx: number,
  outside: boolean,
  lsType: string,
): string[] {
  const out: string[] = [];
  // Synthesize a text/shape marker per list-style-type. Numeric and
  // alpha-based markers use el.listItemIndex (captured below).
  // Author CSS can override the markers color / font-weight / font-size
  // via the ::marker pseudo (SK-1115). Use those when present, falling
  // back to the lis own text color and font-size when not set.
  const markerColorSource = el.summaryMarkerGeometry?.color ?? el.markerColor;
  const markerStyleColor = markerColorSource != null ? parseColor(markerColorSource) : null;
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
  // DM-1270: the marker aligns to the FIRST line of text. Prefer the
  // captured first-line box (handles a li whose border box is raised by a
  // tall inline on the first line — e.g. an emoji `::after` — so the text
  // line sits below `el.y`); fall back to `el.y` + the line-height guess.
  const firstLineTop = el.markerFirstLineDy != null ? el.y + el.markerFirstLineDy : el.y;
  const firstLineH = el.markerFirstLineHeight != null && el.markerFirstLineHeight > 0
    ? el.markerFirstLineHeight : lineHeightPx;
  const my = (el.textTop != null && el.fontAscent != null && el.fontAscent > 0)
    ? el.textTop + el.fontAscent
    : firstLineTop + firstLineH * 0.72;
  // Symbol geometry below consumes the ::marker primary font's captured
  // ascent, matching ListMarker's FontMetrics input. Element ascent and the
  // old ratio remain compatibility fallbacks for pre-DM-2192 trees only.
  const markerAscent = el.markerFontAscent ?? el.fontAscent ?? markerFontSize * 0.77;
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
    const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
    const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
    const contentEdge = el.x + borderL + padL;
    // DM-1258: an OUTSIDE `::marker` is `white-space: pre` (style_adjuster.cc
    // SetWhiteSpace(kPre): "Do not break inside the marker, and honor the
    // trailing spaces"), and Blink right-aligns the marker box with its END
    // FLUSH at the content edge (`margin_end = 0` — the kLanguage / default
    // branch of `list_marker.cc::InlineMarginsForOutside`, where
    // `margin_start = -marker_inline_size`). So the FULL marker text — prefix
    // + value + suffix, with EVERY space PRESERVED — has its advance-end at the
    // content edge; the suffix spaces ARE the marker→content gap. Verified at
    // 4× against Chrome: `domo-step` "Step 01:  " colon lands at
    // contentEdge − 2×space (visible-right 87.3px at content 96), and a cyclic
    // " " suffix shifts the symbol left by exactly one space. The earlier
    // collapse + `el.x − 7 + rsb` / trailing-space-subtraction models
    // (DM-790 / DM-1119 / DM-1154) were curve-fit to noisy 1× probes and
    // over/under-shot wide or multi-space suffixes. `xml:space="preserve"`
    // makes SVG honor the suffix spaces exactly as the `white-space: pre`
    // marker does. INSIDE markers join the content line (white-space: normal),
    // so their suffix whitespace collapses — keep the collapse + start-anchor.
    const renderLabel = outside ? label : collapseMarkerWhitespace(label);
    const mx = contentEdge;
    const anchor = outside ? "end" : "start";
    const escLabel = renderLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // DM-1258: outside markers preserve their suffix spaces (white-space: pre);
    // inside markers fold into the content line, so let SVG collapse there.
    const xmlSpace = outside ? ' xml:space="preserve"' : "";
    // Chrome's UA stylesheet gives ::marker `font-variant-numeric:
    // tabular-nums` — digits render at the wider tabular advance. Without it
    // the "Step 01:" prefixed markers painted ~3px condensed vs Chrome.
    out.push(
      `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}" style="font-variant-numeric:tabular-nums"${xmlSpace}>${escLabel}</text>`,
    );
  } else if (lsType === "disc" || lsType === "circle" || lsType === "square"
      || lsType === "disclosure-open" || lsType === "disclosure-closed") {
    // DM-2192: literal transcription of ListMarker::WidthOfSymbol /
    // RelativeSymbolMarkerRect and TextFragmentPainter's edge snapping.
    const geometry = blinkSymbolMarkerGeometry(markerAscent, markerFontSize, lsType as SymbolMarkerType);
    // Inside markers paint inside the principal block at the content
    // edge, not at the border-box edge. Per Chromium
    // `list_marker.cc::InlineMarginsForInside`, the marker box is
    // followed by a 1em end-margin before the text — the captured
    // textLeft already encodes that, so we just need to anchor the
    // marker glyph at content-edge + half-symbol-width.
    const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
    const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
    const contentEdge = el.x + borderL + padL;
    const markerBoxX = outside
      ? contentEdge - geometry.outsideEndMargin - geometry.markerInlineSize
      : contentEdge + 1; // InlineMarginsForInside: margin_start = -1.
    const sourceRect = el.tag === "summary" && el.summaryMarkerGeometry != null
      ? blinkPhysicalSymbolMarkerRect(
          el.summaryMarkerGeometry.fragmentRect,
          el.summaryMarkerGeometry.fontAscent,
          el.summaryMarkerGeometry.specifiedFontSize,
          el.summaryMarkerGeometry.effectiveZoom,
          lsType as SymbolMarkerType,
          el.summaryMarkerGeometry.writingMode,
        )
      : {
          x: markerBoxX + geometry.inlineOffset,
          y: firstLineTop + geometry.blockOffset,
          width: geometry.inlineSize,
          height: geometry.blockSize,
        };
    // TextFragmentPainter computes a snapped rect for disc/circle/square, but
    // disclosure paths intentionally consume the LayoutUnit marker rect
    // directly. Keeping the fractional path is observable at DPR 2 and avoids
    // moving one antialiased edge by a device pixel.
    const paintRect = lsType === "disclosure-open" || lsType === "disclosure-closed"
      ? sourceRect
      : pixelSnapRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    const mx = paintRect.x + paintRect.width / 2;
    const markerY = paintRect.y + paintRect.height / 2;
    if (lsType === "disc") {
      out.push(`${indent}<ellipse cx="${r(mx)}" cy="${r(markerY)}" rx="${r(paintRect.width / 2)}" ry="${r(paintRect.height / 2)}" fill="${markerColor}" />`);
    } else if (lsType === "circle") {
      out.push(`${indent}<ellipse cx="${r(mx)}" cy="${r(markerY)}" rx="${r(paintRect.width / 2)}" ry="${r(paintRect.height / 2)}" fill="none" stroke="${markerColor}" stroke-width="1" />`);
    } else if (lsType === "square") {
      out.push(`${indent}<rect x="${r(paintRect.x)}" y="${r(paintRect.y)}" width="${r(paintRect.width)}" height="${r(paintRect.height)}" fill="${markerColor}" />`);
    } else {
      const points = disclosureTriangle(
        paintRect,
        lsType,
        el.summaryMarkerGeometry?.writingMode ?? el.styles.writingMode ?? "horizontal-tb",
        el.summaryMarkerGeometry?.direction ?? el.styles.direction ?? "ltr",
      );
      out.push(`${indent}<polygon points="${points}" fill="${markerColor}" />`);
    }
  } else {
    // Text-based marker (decimal / lower-alpha / lower-roman / etc.).
    // Blink generates the complete counter-style representation, including
    // its suffix (`CounterStyle::GenerateRepresentationWithPrefixAndSuffix`).
    // For an ordinary outside text marker, `InlineMarginsForOutside` sets
    // margin_start to exactly -marker_inline_size and margin_end to zero, so
    // the marker's ADVANCE END is flush with the list item's border-box edge.
    // Preserve the suffix whitespace and let SVG's end anchor implement that
    // same geometry; do not reconstruct its width from a fitted pixel gap.
    const label = formatListMarker(lsType, idx) + listMarkerSuffix(lsType);
    const markerFontFamily = el.markerFontFamily ?? el.styles.fontFamily;
    const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
    const borderL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
    const mx = outside ? el.x : el.x + borderL + padL;
    const anchor = outside ? "end" : "start";
    const xmlSpace = outside ? ' xml:space="preserve"' : "";
    out.push(
      `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${esc(markerFontFamily)}" fill="${markerColor}" style="font-variant-numeric:tabular-nums"${xmlSpace}>${label}</text>`,
    );
  }
  return out;
}

function paintListMarker(
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  indent: string,
): string[] {
  const out: string[] = [];
    const isListItem = el.styles.display != null
      && el.styles.display.includes("list-item")
      && (el.tag !== "summary" || el.summaryMarkerGeometry?.source === "blink-list-marker-v1");
    if (isListItem) {
      const lsImage = el.styles.listStyleImage;
      const lsType = el.summaryMarkerGeometry?.listStyleType ?? el.styles.listStyleType ?? "disc";
      const fontSizePx = parseFloat(el.styles.fontSize) || 14;
      const lineHeightPx = parseFloat(el.styles.lineHeight) || fontSizePx * 1.2;
      const outside = (el.summaryMarkerGeometry?.listStylePosition ?? el.styles.listStylePosition) !== "inside";
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
        out.push(...paintSyntheticListMarker(el, textColor, indent, fontSizePx, lineHeightPx, outside, lsType));
      }
    }
  return out;
}

// Vertical writing-mode text (SK-1128 / DM-990): writing-mode != horizontal-tb
// is captured as an element-raster screenshot and stamped as an <image>,
// bypassing the path pipeline entirely (per-char rotation for
// text-orientation: mixed is more involved than the faithful raster of what
// Chrome painted buys us). DM-957: the raster rect was expanded outward in
// `computeElementRaster` (DM-936) to capture the vertical-mode text-decoration
// underlines that paint just outside the inline content box, so mint a
// dedicated clip-path matching the EXPANDED rect — the element's content-rect
// clip would crop those underline pixels off. Extracted from paintText
// (DM-1369) — pure code move, byte-identical.
function emitVerticalRasterText(ctx: PaintCtx, el: CapturedElement, indent: string): void {
  const er = el.elementRaster!;
  const dataUri = er.dataUri!;
  const erCid = ctx.nextClipId("ct");
  ctx.defsParts.push(`<clipPath id="${erCid}"><rect x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" /></clipPath>`);
  ctx.svgParts.push(`${indent}<image href="${dataUri}" x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${erCid})"/>`);
}

// DM-782: pseudoBox gradient/url() emitter for the text renderers. They can't
// own defsParts / clipIdx (those live on the paint ctx), so paintText hands the
// downstream renderers a closure that produces the gradient layer rects +
// appends each layer's paint server to defsParts. Comma-separated layers are
// walked in reverse so layer 0 (first in CSS source) ends up on top. Lifted out
// of paintText to module scope (DM-1369), ctx + captureViewport threaded in.
function buildPseudoBoxBgLayers(
  ctx: PaintCtx,
  captureViewport: { w: number; h: number },
  pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number },
): string {
  const layers = splitTopLevelCommas(pb.backgroundImage);
  const out: string[] = [];
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li].trim();
    const defId = ctx.nextClipId("pbgt");
    const built = buildBackgroundLayerDef(
      defId, layer, pb.x, pb.y, pb.width, pb.height,
      "auto", "0% 0%", "repeat", null, "scroll", captureViewport,
    );
    if (built.def === "") continue;
    ctx.defsParts.push(built.def);
    const rxAttr = pb.borderRadius != null && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}" ry="${r(pb.borderRadius)}"` : "";
    out.push(`<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="url(#${defId})" />`);
  }
  return out.join("");
}

// Single text element → SVG markup, dispatching to the vertical / input /
// multi-segment / multi-line / single-line renderer based on captured shape.
// `emit` is the bound pseudoBox layer emitter (binds ctx + captureViewport).
// Lifted out of paintText to module scope (DM-1369). DM-1029: timed per element
// (font resolution + shaping + outline/embedded-font build + markup).
function renderOneText(
  ctx: PaintCtx,
  opts: { el: CapturedElement; idPrefix: string; clipId: string; fillColor: string; overflowClip?: boolean; affineMatrix?: import("../capture/types.js").CapturedTextPaintAffine },
  emit: (pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number }) => string,
): string {
  const _tText = profNow();
  try {
    const optsWithEmit = { ...opts, emitPseudoBoxBgLayers: emit };
    const hasMultipleSegments = opts.el.textSegments != null && opts.el.textSegments.length > 1;
    const isMultiLine = opts.el.text.includes("\n");
    // DM-990: vertical writing-mode dispatch BEFORE any other branch. Vertical
    // segments carry their per-char positions in `yOffsets` (not `xOffsets`)
    // and need per-char rotation for text-orientation: mixed / sideways — the
    // horizontal renderers would mis-paint them along the wrong axis.
    if (hasVerticalSegments(opts.el)) return wrapAffineTextPaint(opts.affineMatrix, renderVerticalSegments(opts.el, opts.fillColor));
    // DM-2417: clamp-owned source fragments must stay on their captured
    // per-line geometry even when filtering leaves exactly one segment.  The
    // single-line fallback reads the full DOM text and would resurrect hidden
    // post-clamp content.  The generated marker itself is also a segment when
    // the clamp root has no direct text of its own.
    if (opts.el.lineClampTextFragments && opts.el.textSegments != null) {
      return wrapAffineTextPaint(opts.affineMatrix, renderMultiSegmentText(optsWithEmit, opts.el.textSegments));
    }
    // DM-799: input/textarea dispatch must come BEFORE the multi-line branch. A
    // textarea with newline-bearing value (`\n` in `el.text`) would otherwise
    // hit `renderMultiLineText`, which path-renders each source line without
    // word-wrap — Lorem-ipsum lines overflowed the textarea's right edge
    // instead of being painted from the captured `elementRaster` PNG (which
    // carries Chrome's own wrapping).
    if (opts.el.tag === "input" || opts.el.tag === "textarea") return wrapAffineTextPaint(opts.affineMatrix, renderInputText(optsWithEmit));
    if (hasMultipleSegments) return wrapAffineTextPaint(opts.affineMatrix, renderMultiSegmentText(optsWithEmit, opts.el.textSegments!));
    if (isMultiLine) return wrapAffineTextPaint(opts.affineMatrix, renderMultiLineText(optsWithEmit));
    return wrapAffineTextPaint(opts.affineMatrix, renderSingleLineText(optsWithEmit));
  } catch (e) {
    // DM-1713: a fontkit exception on a SINGLE element's text — a null glyph
    // outline point (`reading 'xCoordinate'`), an unsupported bitmap size
    // (`Not a fixed size`), etc., typically on an unsupported-script / color
    // font that only resolves on Linux/Windows — must NOT abort the WHOLE
    // document render. Chrome paints tofu for these; it never crashes. Keep the
    // failure at a labeled source-owned boundary so every other element still
    // renders without asking the consumer browser to select and shape a face.
    const el = opts.el;
    console.warn(
      `[element-tree-to-svg] text render failed for <${el.tag}> "${el.text.slice(0, 24)}" ` +
      `(${e instanceof Error ? e.message : String(e)}) — source-owned boundary`,
    );
    return wrapAffineTextPaint(opts.affineMatrix, `<g clip-path="url(#${opts.clipId})">${renderSourceOwnedTextBoundary(el.text, "element-render-failed")}</g>`);
  } finally {
    profAccum("text-render", profNow() - _tText);
  }
}

// Resolve the fill for an element's text, handling the `background-clip: text`
// gradient-headline pattern. Returns the SVG fill string plus whether the text
// itself is transparent (the caller needs the latter to choose between the
// glyph-mask compositing path and a plain fill).
//
// DM-462: `background-clip: text` + `-webkit-text-fill-color: transparent` (or
// `color: transparent`) makes the bg-image paint inside the glyph shapes — the
// gradient-headline pattern. When detected, swap the text fill from the regular
// color to the gradient's def URL captured from the text-clipped bg layer above.
// We honor this when the rendered text is actually transparent (text-fill-color
// or color is alpha-zero); if the author left text-fill-color opaque we just
// paint the color, which is what Chrome would paint on top of the (clipped)
// gradient anyway.
//
// This is the leading sub-phase of paintText (extracted in DM-1436 item 1 as a
// pure code move). It may allocate a "bg" gradient def via ctx.nextClipId and
// push to ctx.defsParts; paintText calls it at the same point as before — ahead
// of the "ct" text-clip id — so the id allocation order is unchanged.
function resolveTextFill(
  ctx: PaintCtx,
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  textBgClipFills: string[],
  captureViewport: { w: number; h: number },
): { fillColor: string; textIsTransparent: boolean } {
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
    const defId = ctx.nextClipId("bg");
    // DM-908: resolve the gradient against the ANCESTOR's bbox (the
    // element that set `background-clip: text`), not this child's
    // bbox. Falling back to (el.x, el.y, el.width, el.height) for
    // legacy captures missing the new field would produce the
    // pre-fix behaviour where each child re-runs the gradient over
    // its own (smaller) area.
    const gradRect = el.styles.inheritedTextFillGradientRect;
    const gx = gradRect != null ? gradRect.x : el.x;
    const gy = gradRect != null ? gradRect.y : el.y;
    const gw = gradRect != null ? gradRect.width : el.width;
    const gh = gradRect != null ? gradRect.height : el.height;
    const out = buildBackgroundLayerDef(defId, layer, gx, gy, gw, gh, "auto", "0% 0%", "no-repeat", null, "scroll", captureViewport);
    if (out.def !== "") {
      ctx.defsParts.push(out.def);
      topmostTextBgClipFill = `url(#${defId})`;
    }
  }
  const fillColor = (topmostTextBgClipFill != null && textIsTransparent)
    ? topmostTextBgClipFill
    : (textColor != null ? colorStr(textColor) : "#e6edf3");
  return { fillColor, textIsTransparent };
}

// Text + text-shadow rendering dispatch, extracted from renderElement (DM-1306,
// DM-1315). Chooses single-line / multi-segment / multi-line / input rendering
// (delegating the glyph work to text-renderer.ts), paints the element-level and
// per-segment text-shadow layers beneath the text, and handles the
// background-clip:text mask path. HIGH coupling: it mints many clip / filter /
// gradient ids, so clipIdx is threaded in and the advanced value returned, and it
// consumes the textBgClipFills collected by the background-image layer phase.
// Returns { svg, defs, clipIdx } so the positional ids stay byte-identical.
function paintText(
  ctx: PaintCtx,
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  indent: string,
  textBgClipFills: string[],
  captureViewport: { w: number; h: number },
  textBgClipFragmentFills: (string[] | null)[] = [],
): void {
  const sourceEl = el;
  const affine = prepareAffineTextPaint(el, ctx.emittedTextCtm.get(el));
  if (affine.failureReason != null) {
    // A present geometry record is authoritative. Re-entering the legacy
    // post-transform DOMRect route would silently double/misapply transforms.
    console.warn(`[element-tree-to-svg] affine text paint failed closed for <${el.tag}>: ${affine.failureReason}`);
    return;
  }
  el = affine.element;
  const affineMatrix = affine.residualMatrix;
  const paintsClampFragments = el.lineClampTextFragments === true;
  const hasCapturedClampFragment = (el.textSegments?.length ?? 0) > 0;
  if (paintsClampFragments ? hasCapturedClampFragment : el.text !== "") {
    const { fillColor, textIsTransparent } = resolveTextFill(ctx, el, textColor, textBgClipFills, captureViewport);
    const cid = ctx.nextClipId("ct");
    // DM-1266: a form field's value text clips to the element's CONTENT box
    // (inside border + padding), not the border box. Chrome paints an
    // overflowing <input> value clipped at the content edge — a long value shows
    // "…cu" with the next glyph cut at the content/padding boundary, ~border+
    // padding px inside the right border. Clipping to the border box (the default
    // here) let the overflowing glyph paint into the padding strip. Inset only
    // HORIZONTALLY: the value is single-line and vertically centered, and our
    // captured input baseline can sit a hair outside a padding-tight vertical
    // box, so a vertical inset risks clipping text Chrome shows. Other elements
    // keep the border-box text clip (it only applies when overflow != visible,
    // where the padding-box children clip already bounds descendants).
    let ctX = el.x, ctW = el.width;
    if (el.tag === "input" || el.tag === "textarea") {
      const bl = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const br = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const pl = parseFloat(el.styles.paddingLeft ?? "0") || 0;
      const pr = parseFloat(el.styles.paddingRight ?? "0") || 0;
      ctX = el.x + bl + pl;
      ctW = Math.max(0, el.width - bl - br - pl - pr);
    }
    ctx.defsParts.push(`<clipPath id="${cid}"><rect x="${r(ctX)}" y="${r(el.y)}" width="${r(ctW)}" height="${r(el.height)}" /></clipPath>`);

    // SK-1128: writing-mode != horizontal-tb activates the same element-raster
    // path used for textareas (SK-1108) — screenshot stamped as <image>,
    // bypassing the path pipeline. See `emitVerticalRasterText`.
    if (el.elementRaster != null && el.elementRaster.dataUri != null
        && el.styles.writingMode != null && el.styles.writingMode !== "horizontal-tb") {
      emitVerticalRasterText(ctx, el, indent);
    } else {

    // Bound pseudoBox layer emitter handed to the downstream text renderers
    // (binds ctx + captureViewport to the module-scope `buildPseudoBoxBgLayers`).
    const emit = (pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number }): string =>
      buildPseudoBoxBgLayers(ctx, captureViewport, pb);

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
      let body = renderOneText(ctx, { el: shifted, idPrefix: ctx.idPrefix, clipId: cid, fillColor: shadowFillColor, affineMatrix }, emit);
      if (sh.blur > 0) {
        const stdDev = sh.blur / 2;
        const fid = ctx.nextClipId("tsh");
        ctx.defsParts.push(
          `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
        );
        body = `<g filter="url(#${fid})">${body}</g>`;
      }
      ctx.svgParts.push(`${indent}${body}`);
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
          let segBody = wrapAffineTextPaint(affineMatrix, renderMultiSegmentText({ el, idPrefix: ctx.idPrefix, clipId: cid, fillColor: segShadowFill, emitPseudoBoxBgLayers: emit }, [shiftedSeg]));
          if (sh.blur > 0) {
            const stdDev = sh.blur / 2;
            const fid = ctx.nextClipId("tssh");
            ctx.defsParts.push(
              `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
            );
            segBody = `<g filter="url(#${fid})">${segBody}</g>`;
          }
          ctx.svgParts.push(`${indent}${segBody}`);
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
    const renderOpts = { el, idPrefix: ctx.idPrefix, clipId: cid, fillColor, overflowClip: textOverflowClip, affineMatrix };
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
      // The mask must be the pure FILL silhouette: strip the element's
      // `-webkit-text-stroke` from the mask copy. Keeping it painted a dark
      // (luminance-0) stroke ring into the mask, and — worse — no stroke was
      // ever painted VISIBLY: Chrome paints the text stroke in its own color
      // around the gradient-filled glyphs (under the fill for `paint-order:
      // stroke fill`, over it otherwise). The stroke pass is emitted below,
      // ordered by paint-order, with a transparent fill so only the stroke
      // paints.
      const maskFillEl: CapturedElement = { ...el, styles: { ...el.styles, color: "rgb(255,255,255)", webkitTextFillColor: "rgb(255,255,255)", webkitTextStrokeWidth: "0px" } };
      const maskBody = renderOneText(ctx, { el: maskFillEl, idPrefix: ctx.idPrefix, clipId: cid, fillColor: "rgb(255,255,255)", overflowClip: textOverflowClip, affineMatrix }, emit);
      const mid = ctx.nextClipId("tbgm");
      ctx.defsParts.push(
        `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${r(sourceEl.x)}" y="${r(sourceEl.y)}" width="${r(sourceEl.width)}" height="${r(sourceEl.height)}">${maskBody}</mask>`,
      );
      // Visible `-webkit-text-stroke` pass for gradient-filled (bg-clip:text)
      // glyphs: render the SAME text with a fully transparent fill so only the
      // stroke ink is emitted. The gradient is the element's BACKGROUND
      // (clipped to the text ink); the stroke belongs to the text's foreground
      // paint, which Chrome always draws on top of the background — and with a
      // transparent text fill, `paint-order` has nothing to reorder (it only
      // sequences the text's own fill vs stroke). So the stroke pass paints
      // AFTER the masked gradient rects unconditionally.
      const bgClipStrokeW = parseFloat(el.styles.webkitTextStrokeWidth ?? "0") || 0;
      let bgClipStrokeBody = "";
      if (bgClipStrokeW > 0) {
        bgClipStrokeBody = renderOneText(ctx, { el, idPrefix: ctx.idPrefix, clipId: cid, fillColor: "rgba(0,0,0,0)", overflowClip: textOverflowClip, affineMatrix }, emit);
      }
      // Emit one masked rect per text-clipped layer, walking from BOTTOM
      // (highest li) to TOP (li = 0) so the topmost CSS layer paints last.
      // All rects share the same glyph mask; later rects paint over earlier
      // ones inside the glyph silhouettes, matching Chrome's compositing of
      // stacked `background-clip: text` layers (DM-696).
      for (let li = textBgClipFills.length - 1; li >= 0; li--) {
        const f = textBgClipFills[li];
        if (f == null) continue;
        // DM-1420: wrapped inline — paint one masked rect PER line fragment, each
        // with its own per-fragment gradient (built over that fragment's box), so
        // each line's glyphs sample their own fragment's gradient (matching how
        // Chromium restarts an inline's bg-clip:text gradient per fragment).
        // Block elements have no per-fragment fills and keep the single rect.
        const fragFills = textBgClipFragmentFills[li];
        if (fragFills != null && sourceEl.inlineFragments != null) {
          for (let fi = 0; fi < sourceEl.inlineFragments.length; fi++) {
            const fr = sourceEl.inlineFragments[fi];
            ctx.svgParts.push(
              `${indent}<rect x="${r(fr.x)}" y="${r(fr.y)}" width="${r(fr.width)}" height="${r(fr.height)}" fill="${fragFills[fi] ?? f}" mask="url(#${mid})" />`,
            );
          }
        } else {
          ctx.svgParts.push(
            `${indent}<rect x="${r(sourceEl.x)}" y="${r(sourceEl.y)}" width="${r(sourceEl.width)}" height="${r(sourceEl.height)}" fill="${f}" mask="url(#${mid})" />`,
          );
        }
      }
      if (bgClipStrokeBody !== "") {
        ctx.svgParts.push(`${indent}${bgClipStrokeBody}`);
      }
    } else {
      ctx.svgParts.push(`${indent}${renderOneText(ctx, renderOpts, emit)}`);
    }
    }
  }
  return;
}

// 3D bevel border (DM-280): groove / ridge / inset / outset. Each side is a
// trapezoid polygon so the shade pairs miter cleanly at corners; groove/ridge
// split each trapezoid into outer/inner halves with inverted shades. Extracted
// from paintBorder's uniform branch (DM-1342) — pure code move, byte-identical.
function paintBevelBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  bt: NonNullable<ReturnType<typeof parseSide>>,
): void {
  const style = bt.style;
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
    ctx.svgParts.push(`${indent}<polygon points="${topPoly}" fill="${tlColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftPoly}" fill="${tlColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightPoly}" fill="${brColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomPoly}" fill="${brColor}" />`);
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
    ctx.svgParts.push(`${indent}<polygon points="${topOuter}" fill="${outerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftOuter}" fill="${outerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightOuter}" fill="${outerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomOuter}" fill="${outerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${topInner}" fill="${innerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftInner}" fill="${innerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightInner}" fill="${innerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomInner}" fill="${innerBR}" />`);
  }
}

// The four CSS border styles that paint a light/dark 3D bevel.
function isBevelStyle(style: string): boolean {
  return style === "groove" || style === "ridge" || style === "inset" || style === "outset";
}

// Per-side 3D bevel border (DM-1275): the SAME Chrome-calibrated shading as
// paintBevelBorder (darker = base × 2/3, lighter = base — DM-293) and identical
// trapezoid geometry, but each side renders its OWN 3D style. This covers the
// mixed case paintBevelBorder's uniform-STYLE guard skips — e.g. `ridge` top/
// bottom + `groove` left/right ("3D pair flip") — which otherwise fell through to
// paintPerSideBorder and painted as a flat solid border with no bevel at all.
// The caller gates on uniform width + color + square corners (the single base
// color + trapezoid geometry assume that); anything else falls back.
function paintMixedBevelBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  w: number,
  color: { r: number; g: number; b: number; a: number },
  styles: { top: string; right: string; bottom: string; left: string },
): void {
  const x0 = el.x, y0 = el.y, x1 = el.x + el.width, y1 = el.y + el.height;
  const darker = colorStr({ r: Math.round(color.r * 2 / 3), g: Math.round(color.g * 2 / 3), b: Math.round(color.b * 2 / 3), a: color.a });
  const lighter = colorStr(color);
  const halfW = w / 2;
  // Full trapezoids (inset/outset) + outer/inner halves (groove/ridge) — same
  // geometry as paintBevelBorder, keyed per side.
  const full = {
    top: `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`,
    right: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
    bottom: `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`,
    left: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
  };
  const outer = {
    top: `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - halfW)},${r(y0 + halfW)} ${r(x0 + halfW)},${r(y0 + halfW)}`,
    right: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - halfW)},${r(y0 + halfW)}`,
    bottom: `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x0 + halfW)},${r(y1 - halfW)}`,
    left: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + halfW)},${r(y1 - halfW)} ${r(x0 + halfW)},${r(y0 + halfW)}`,
  };
  const inner = {
    top: `${r(x0 + halfW)},${r(y0 + halfW)} ${r(x1 - halfW)},${r(y0 + halfW)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`,
    right: `${r(x1 - halfW)},${r(y0 + halfW)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
    bottom: `${r(x0 + halfW)},${r(y1 - halfW)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`,
    left: `${r(x0 + halfW)},${r(y0 + halfW)} ${r(x0 + halfW)},${r(y1 - halfW)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
  };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const style = styles[side];
    const isTL = side === "top" || side === "left";
    if (style === "inset" || style === "outset") {
      const fill = style === "outset" ? (isTL ? lighter : darker) : (isTL ? darker : lighter);
      ctx.svgParts.push(`${indent}<polygon points="${full[side]}" fill="${fill}" />`);
    } else {
      // groove / ridge: outer + inner halves carry inverse shades (matches the
      // uniform path's TL/BR grouping, applied per-side).
      const outerFill = style === "ridge" ? (isTL ? lighter : darker) : (isTL ? darker : lighter);
      const innerFill = style === "ridge" ? (isTL ? darker : lighter) : (isTL ? lighter : darker);
      ctx.svgParts.push(`${indent}<polygon points="${outer[side]}" fill="${outerFill}" />`);
      ctx.svgParts.push(`${indent}<polygon points="${inner[side]}" fill="${innerFill}" />`);
    }
  }
}

// Uniform `double` border: two parallel strokes each 1/3 of border-width with a
// 1/3 gap, collapse-aware. Extracted from paintBorder (DM-1342) — byte-identical.
function paintUniformDoubleBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
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
  const { stripe: strokeW, offset } = doubleBorderStripeGeometry(bt.w);
  const outerInset = bt.w / 2 - offset - collapseShift;
  const innerInset = bt.w / 2 + offset - collapseShift;
  const outerCorners = insetCornerRadii(corners, outerInset, outerInset, outerInset, outerInset);
  const innerCorners = insetCornerRadii(corners, innerInset, innerInset, innerInset, innerInset);
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(el.x + outerInset, el.y + outerInset, el.width - 2 * outerInset, el.height - 2 * outerInset, outerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
  );
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(el.x + innerInset, el.y + innerInset, el.width - 2 * innerInset, el.height - 2 * innerInset, innerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
  );
}

// Uniform `dashed` / `dotted` border with square (non-rounded) corners: 4 lines,
// each with its own corner-adjusted dash cycle. Extracted from paintBorder
// (DM-1342) — byte-identical.
function paintUniformDashedDottedBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  const style = bt.style;
  const thinDotted = style === "dotted" && Math.round(bt.w) <= 3;
  // Dashed/dotted uniform borders need per-side dash spacing — Chrome
  // adjusts the dash cycle so dashes start and end exactly at corners.
  // SVG `stroke-dasharray` on a single rect would use ONE pattern across
  // all 4 sides, but the top/bottom and left/right have different
  // lengths, so the pattern would mis-align at every corner. Emit 4
  // lines instead so each side gets its own adjusted pattern.
  const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
  const inset = collapse ? 0 : bt.w / 2;
  // Chromium has two dotted branches: widths 1--3 use square {w,w}
  // intervals plus explicit endpoint dots; thicker strokes use zero-length
  // dashes with round caps. `paintThinDottedLine` owns the former branch.
  const linecap = style === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
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
  //   • Thick dotted: Chromium's `DrawLineWithStyle` moves the
  //     line endpoints IN by width/2 before stroking round-dotted
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
  const cornerTrim = style === "dotted" && !thinDotted ? bt.w / 2 : (bt.w >= 8 ? inset : 0);
  // Each entry: [x1, y1, x2, y2, naturalLen]. naturalLen is the
  // PRE-cornerTrim side length — Chromium's `DrawLineWithStyle`
  // computes the dash pattern from the original `info.path_length`
  // BEFORE moving thick-dotted endpoints inward by width/2 (the move
  // shifts the painted line but the dash math sees the original).
  // For thin dashed/dotted borders cornerTrim = 0, so naturalLen == drawn
  // length; for thick dotted (cornerTrim = width/2) and thick dashed
  // (cornerTrim = width/2) the two differ.
  const sides: Array<[number, number, number, number, number]> = [
    [bL + cornerTrim, bT + inset, bR - cornerTrim, bT + inset, bR - bL],
    [bR - inset, bT + cornerTrim, bR - inset, bB - cornerTrim, bB - bT],
    [bL + cornerTrim, bB - inset, bR - cornerTrim, bB - inset, bR - bL],
    [bL + inset, bT + cornerTrim, bL + inset, bB - cornerTrim, bB - bT],
  ];
  for (const [x1, y1, x2, y2, len] of sides) {
    if (thinDotted) {
      ctx.svgParts.push(...paintThinDottedLine(x1, y1, x2, y2, bt.w, colorStr(bt.color), indent));
      continue;
    }
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
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttrs}${linecap} />`,
    );
  }
}

function createContouredRingMask(
  ctx: PaintCtx,
  outerPath: string,
  x: number,
  y: number,
  width: number,
  height: number,
  innerCorners: CornerRadii,
): string | null {
  const constraints = contouredRectIntersectionPaths(x, y, width, height, innerCorners);
  if (constraints == null) return null;
  const clipIds = constraints.map(() => ctx.nextClipId("cci"));
  constraints.forEach((path, index) => ctx.defsParts.push(`<clipPath id="${clipIds[index]}"><path d="${path}"/></clipPath>`));
  const nestedOpen = clipIds.map(id => `<g clip-path="url(#${id})">`).join("");
  const nestedClose = "</g>".repeat(clipIds.length);
  const maskId = ctx.nextClipId("crm");
  const pad = Math.max(width, height, 1) * 4 + 1;
  ctx.defsParts.push(
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" mask-type="luminance" x="${r(x - pad)}" y="${r(y - pad)}" width="${r(width + pad * 2)}" height="${r(height + pad * 2)}"><path d="${outerPath}" fill="white"/>${nestedOpen}<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" fill="black"/>${nestedClose}</mask>`,
  );
  return maskId;
}

// Uniform solid border (also the fallback for dashed/dotted with rounded corners
// or non-uniform radii): a single inset, device-pixel-rounded rounded-rect stroke.
// Extracted from paintBorder (DM-1342) — byte-identical.
function paintUniformSolidBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  const dash = dashArrayForStyle(bt.style, bt.w);
  const linecap = "";
  // CSS paints borders INSIDE the border-box. SVG strokes are centered on
  // the path, so half would spill outside. Inset the rect by half the
  // stroke width so the stroke sits entirely inside the element box.
  // Exception: with border-collapse:collapse on the parent table, Chrome
  // collapses adjacent cell borders into a single shared line painted ON
  // the shared edge (not inset). If we kept the inset, two adjacent
  // cells' borders would land ~1px apart and read as a doubled 2px line.
  // Centered painting (no inset) lets the two cells' borders overlap
  // exactly, producing a single 1px line — matching Chrome's collapsed
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
  const hasNonRoundContour = corners.curvature != null
    && Object.values(corners.curvature).some(value => value !== 2);
  // Blink paints non-round borders as the area between its outer and aligned
  // inner ContouredRects. An SVG centerline stroke cannot represent a concave
  // contour (it protrudes on the wrong side of a scoop/notch), so preserve the
  // same two vector boundaries and fill the annulus with even-odd winding.
  if (hasNonRoundContour && !collapse && bt.style === "solid") {
    const outer = roundedRectPath(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, corners);
    const innerCorners = insetCornerRadii(corners, bt.w, bt.w, bt.w, bt.w);
    const innerX = boxLeft + bt.w, innerY = boxTop + bt.w;
    const innerW = Math.max(0, boxRight - boxLeft - bt.w * 2), innerH = Math.max(0, boxBottom - boxTop - bt.w * 2);
    const maskId = createContouredRingMask(ctx, outer, innerX, innerY, innerW, innerH, innerCorners);
    if (maskId != null) {
      ctx.svgParts.push(`${indent}<path d="${outer}" fill="${colorStr(bt.color)}" mask="url(#${maskId})"/>`);
    } else {
      const inner = roundedRectPath(innerX, innerY, innerW, innerH, innerCorners);
      ctx.svgParts.push(`${indent}<path d="${outer} ${inner}" fill="${colorStr(bt.color)}" fill-rule="evenodd"/>`);
    }
    return;
  }
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(boxLeft + half, boxTop + half, Math.max(0, boxRight - boxLeft - half * 2), Math.max(0, boxBottom - boxTop - half * 2), strokeCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttr}${linecap}`)}`,
  );
}

// Border paint phase — border-image 9-slice composition plus the plain per-side
// border — extracted from renderElement (DM-1306, DM-1316). Handles uniform and
// per-side borders: solid annular wedges for rounded corners, trapezoid tapers,
// double strokes, 3D bevel (groove/ridge/inset/outset) polygons, and dashed /
// dotted per-side line emission, plus the <fieldset>+<legend> notch clip. Highest-
// coupling phase: it mints many per-side clip ids (and the border-image pass mints
// its own), so clipIdx is threaded in and the advanced value returned, keeping the
// positional id sequence byte-identical. Returns { svg, defs, clipIdx }.
function paintCollapsedBorderRects(ctx: PaintCtx, el: CapturedElement, indent: string): boolean {
  const rects = el.styles.collapsedBorderRects;
  if (rects == null) return false;
  for (const rect of rects) {
    const color = parseColor(rect.color);
    if (color == null || color.a < 0.01 || rect.width <= 0 || rect.height <= 0) continue;
    const fill = colorStr(color);
    const horizontal = rect.width >= rect.height;
    const thickness = horizontal ? rect.height : rect.width;
    const length = horizontal ? rect.width : rect.height;
    if (rect.style === "solid" || thickness < 1) {
      ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${fill}" />`);
      continue;
    }
    if (rect.style === "double" && thickness >= 3) {
      const stripe = thickness / 3;
      if (horizontal) {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness - stripe)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`);
      } else {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x + thickness - stripe)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`);
      }
      continue;
    }
    if (rect.style === "dashed" || rect.style === "dotted") {
      const clipId = ctx.nextClipId("cb");
      ctx.defsParts.push(`<clipPath id="${clipId}"><rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}"/></clipPath>`);
      const { array, offset } = adjustedDashAttrs(rect.style, thickness, length);
      const dash = array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
      const cap = rect.style === "dotted" ? ` stroke-linecap="round"` : "";
      const x1 = horizontal ? rect.x : rect.x + thickness / 2;
      const y1 = horizontal ? rect.y + thickness / 2 : rect.y;
      const x2 = horizontal ? rect.x + rect.width : x1;
      const y2 = horizontal ? y1 : rect.y + rect.height;
      ctx.svgParts.push(`${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${fill}" stroke-width="${r(thickness)}"${dash}${cap} clip-path="url(#${clipId})" />`);
      continue;
    }
    if (isBevelStyle(rect.style)) {
      const dark = colorStr({ r: Math.round(color.r * 2 / 3), g: Math.round(color.g * 2 / 3), b: Math.round(color.b * 2 / 3), a: color.a });
      const first = rect.style === "outset" || rect.style === "ridge" ? fill : dark;
      const second = rect.style === "groove" || rect.style === "ridge" ? (first === fill ? dark : fill) : first;
      if (rect.style === "inset" || rect.style === "outset") {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${first}" />`);
      } else if (horizontal) {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${first}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness / 2)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${second}" />`);
      } else {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${first}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x + thickness / 2)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${second}" />`);
      }
    }
  }
  return true;
}

function paintBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  width: number,
  height: number,
  borderWidth: number,
  borderColor: ReturnType<typeof parseColor>,
  suppressEmptyCell: boolean,
  useInlineFragments: boolean,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  // Border-image: if a URL source with intrinsic dimensions is present,
  // emit a 9-slice composition and SKIP the plain-border fallback below.
  // Gradient sources are not supported in this pass (tracked as follow-up).
  const borderImageMarkup = useInlineFragments
    ? { svg: "", usedIds: 0 }
    : renderBorderImage(el, indent, ctx.idPrefix, ctx.defsParts, ctx.peekClipIdx());
  if (borderImageMarkup.usedIds > 0) ctx.advanceClipIdx(borderImageMarkup.usedIds);
  const borderImagePainted = borderImageMarkup.svg !== "";
  if (borderImagePainted) ctx.svgParts.push(borderImageMarkup.svg);

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
    const notchId = ctx.nextClipId("fln");
    ctx.defsParts.push(
      `<clipPath id="${notchId}" clip-rule="evenodd"><path d="M 0 0 L ${r(width)} 0 L ${r(width)} ${r(height)} L 0 ${r(height)} Z M ${r(ln.x)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y + ln.h)} L ${r(ln.x)} ${r(ln.y + ln.h)} Z" clip-rule="evenodd"/></clipPath>`,
    );
    ctx.svgParts.push(`${indent}<g clip-path="url(#${notchId})">`);
    notchedBorderOpen = true;
  }

  // Collapsed table borders belong to TablePainter, after all table-part
  // backgrounds. The post-child inline phase emits their table-owned rects;
  // suppress the ordinary per-box border here without painting them early.
  if (!borderImagePainted && el.styles.collapsedBorderRects != null) {
    if (notchedBorderOpen) ctx.svgParts.push(`${indent}</g>`);
    return;
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
      paintUniformDoubleBorder(ctx, el, indent, corners, bt, offGridCollapsedCells);
    } else if ((style === "groove" || style === "ridge" || style === "inset" || style === "outset") && bt.w >= 1) {
      paintBevelBorder(ctx, el, indent, bt);
    } else if ((style === "dashed" || style === "dotted") && corners.uniform && corners.tl.h === 0) {
      paintUniformDashedDottedBorder(ctx, el, indent, bt, offGridCollapsedCells);
    } else {
      paintUniformSolidBorder(ctx, el, indent, corners, bt, offGridCollapsedCells);
    }
  } else if (!uniform) {
    // Mixed per-side 3D bevel (e.g. ridge top/bottom + groove left/right): same
    // width + color, all four styles 3D-bevel. paintBevelBorder's uniform-STYLE
    // guard above skips it, so without this it falls through to a flat solid
    // per-side border with no bevel (DM-1275). Requires square corners (the
    // bevel trapezoid geometry assumes no radius).
    const allBevel = bt != null && br != null && bb != null && bl != null
      && bt.w > 0 && bt.w === br.w && br.w === bb.w && bb.w === bl.w
      && sameColor(bt.color, br.color) && sameColor(br.color, bb.color) && sameColor(bb.color, bl.color)
      && isBevelStyle(bt.style) && isBevelStyle(br.style) && isBevelStyle(bb.style) && isBevelStyle(bl.style)
      && corners.uniform && corners.tl.h === 0;
    if (allBevel && bt != null && br != null && bb != null && bl != null) {
      paintMixedBevelBorder(ctx, el, indent, bt.w, bt.color, { top: bt.style, right: br.style, bottom: bb.style, left: bl.style });
    } else {
      paintPerSideBorder(ctx, el, indent, corners, bt, br, bb, bl, offGridCollapsedCells);
    }
  } else if (borderWidth > 0 && borderColor != null && borderColor.a > 0.01) {
    // Legacy path for elements whose per-side captures weren't parsed cleanly.
    ctx.svgParts.push(
      `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="none" stroke="${colorStr(borderColor)}" stroke-width="${r(borderWidth)}"`)}`,
    );
  }
  if (notchedBorderOpen) ctx.svgParts.push(`${indent}</g>`);
  return;
}

// Per-side border (mixed widths / styles / colors): the highest-coupling border
// strategy. Solid sides become mitered trapezoids (or annular wedges when the box
// has rounded corners); double/dashed/dotted sides become clipped <line>s. Mints
// many per-side clip ids via ctx. Extracted verbatim from paintBorder (DM-1342) —
// byte-identical (only `'\''` comment-escape artifacts cleaned to `'`).
/**
 * Emit ONE per-side border (extracted from `paintPerSideBorder`'s main emit
 * loop, DM-1458; called once per side index). Solid sides without a rounded
 * corner paint as a mitered trapezoid <polygon>; `double` sides paint two
 * parallel inset/outset <line> strokes; dashed / dotted / solid-collapsed sides
 * paint a single <line> with the right dash + linecap. Sides with a rounded
 * outer corner are skipped here — they were already emitted as annular wedges
 * by the caller. Body unchanged (the loop's `continue` becomes an early
 * `return`), so output is byte-identical.
 */
function emitBorderSide(
  ctx: PaintCtx,
  indent: string,
  i: number,
  sides: Array<[ReturnType<typeof parseSide>, number, number, number, number, number]>,
  trapezoids: Array<[ReturnType<typeof parseSide>, string]>,
  doubleSides: Array<[number, number, number, number]>,
  useTrapezoid: (side: ReturnType<typeof parseSide>) => boolean,
  hasOuterRadius: boolean,
  curvedStyledSide: boolean,
  sideClipForStyle: (i: number, side: ReturnType<typeof parseSide>) => string,
): void {
  const [side, x1, y1, x2, y2, len] = sides[i];
  if (side == null || side.w <= 0 || side.color.a < 0.01) return;
  if (side.style === "none" || side.style === "hidden") return;
  if (curvedStyledSide && (side.style === "dashed" || side.style === "dotted")) return;
  if (useTrapezoid(side)) {
    // DM-773: solid sides with rounded corners already emitted as
    // annular wedges above (geometry-correct for any radius). Skip
    // the legacy trapezoid emit so we don't double-paint.
    if (hasOuterRadius) return;
    // Emit as a polygon trapezoid that tapers correctly at corners.
    ctx.svgParts.push(
      `${indent}<polygon points="${trapezoids[i][1]}" fill="${colorStr(side.color)}" />`,
    );
    return;
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
    const { stripe: strokeW, offset: offset_ } = doubleBorderStripeGeometry(side.w);
    const [oxN, oyN, ixN, iyN] = doubleSides[i];
    const ox = oxN * offset_, oy = oyN * offset_;
    const ix = ixN * offset_, iy = iyN * offset_;
    const clipAttr = sideClipForStyle(i, side);
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ox)}" y1="${r(y1 + oy)}" x2="${r(x2 + ox)}" y2="${r(y2 + oy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ix)}" y1="${r(y1 + iy)}" x2="${r(x2 + ix)}" y2="${r(y2 + iy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    return;
  }
  const thinDotted = side.style === "dotted" && Math.round(side.w) <= 3;
  const thickDotted = side.style === "dotted" && !thinDotted;
  const vertical = x1 === x2;
  // Blink computes the dash effect from the full side length. Only after that
  // does DrawLineWithStyle move thick-dotted endpoints inward by width / 2 so
  // the round endpoint dots remain inside the side path. The miter clip, not a
  // shortened centerline, owns mixed-side corner partitioning.
  const endpointInset = thickDotted ? side.w / 2 : 0;
  const drawX1 = vertical ? x1 : x1 + endpointInset;
  const drawY1 = vertical ? y1 + endpointInset : y1;
  const drawX2 = vertical ? x2 : x2 - endpointInset;
  const drawY2 = vertical ? y2 - endpointInset : y2;
  const { array: dash, offset } = adjustedDashAttrs(side.style, side.w, len);
  // Dotted uses `0.01 period` dasharray that needs round linecaps to
  // render as circles (DM-399). Chromium's BoxBorderPainter draws
  // dotted as "0 length dash strokes and round endcaps, producing
  // circles" (verified via Chromium source). Dashed keeps default
  // butt caps so the dash:gap ratio paints flat-ended rectangles.
  const linecap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
  const clipAttr = sideClipForStyle(i, side);
  if (thinDotted) {
    ctx.svgParts.push(...paintThinDottedLine(x1, y1, x2, y2, side.w, colorStr(side.color), indent)
      .map(markup => markup.replace(" />", `${clipAttr} />`)));
    return;
  }
  const phaseOffset = endpointInset > 0 ? offset + endpointInset : offset;
  const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${phaseOffset !== 0 ? ` stroke-dashoffset="${r(phaseOffset)}"` : ""}` : "";
  ctx.svgParts.push(
    `${indent}<line x1="${r(drawX1)}" y1="${r(drawY1)}" x2="${r(drawX2)}" y2="${r(drawY2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dashAttrs}${linecap}${clipAttr} />`,
  );
}

function paintPerSideBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: ReturnType<typeof parseSide>,
  br: ReturnType<typeof parseSide>,
  bb: ReturnType<typeof parseSide>,
  bl: ReturnType<typeof parseSide>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
    const collapsedSegments = el.styles.collapsedBorderSegments;
    if (collapsedSegments != null) {
      for (const seg of collapsedSegments) {
        const side = parseSide(`${seg.width}px`, seg.style, seg.color);
        if (side == null || side.w <= 0 || side.style === "none" || side.style === "hidden") continue;
        const horizontal = seg.side === "top" || seg.side === "bottom";
        const x1 = horizontal ? el.x + el.width * seg.start : (seg.side === "left" ? el.x : el.x + el.width);
        const y1 = horizontal ? (seg.side === "top" ? el.y : el.y + el.height) : el.y + el.height * seg.start;
        const x2 = horizontal ? el.x + el.width * seg.end : x1;
        const y2 = horizontal ? y1 : el.y + el.height * seg.end;
        const len = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
        const { array, offset } = adjustedDashAttrs(side.style, side.w, len);
        const dash = array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
        const cap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
        ctx.svgParts.push(`${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dash}${cap} />`);
      }
      return;
    }
    // Per-side border: emit 4 separate lines along the element edges. Lines
    // are drawn at the centerline of each border so stroke spills equally
    // inward/outward — visually close enough for typical 1-10px borders.
    // Blink constructs every straight side path across the full outer side
    // rectangle, then assigns corner ownership with the miter clip polygon.
    // Do not shorten a side because an adjacent width is larger: that retired
    // approximation changes the path length (and therefore dash phase) before
    // clipping, which is especially visible on mixed dashed/dotted joints.
    // border-collapse:collapse → paint each side ON the cell edge (not
    // inset by half-width), so two adjacent cells' shared sides overlap
    // exactly and produce a single line instead of a doubled one.
    const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
    const inset = (w: number) => collapse ? 0 : w / 2;
    const tw = bt?.w ?? 0;
    const rw = br?.w ?? 0;
    const bw = bb?.w ?? 0;
    const lw = bl?.w ?? 0;
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
      [bt, bxL, bxT + inset(tw), bxR, bxT + inset(tw), Math.max(0, bxR - bxL)],
      [br, bxR - inset(rw), bxT, bxR - inset(rw), bxB, Math.max(0, bxB - bxT)],
      [bb, bxL, bxB - inset(bw), bxR, bxB - inset(bw), Math.max(0, bxR - bxL)],
      [bl, bxL + inset(lw), bxT, bxL + inset(lw), bxB, Math.max(0, bxB - bxT)],
    ];
    // For SOLID sides (and only when not collapsed), emit each side as a
    // `<polygon>` trapezoid that meets adjacent sides at a miter — this
    // produces Chrome's BoxBorderPainter taper exactly without needing
    // the trimAdj winner-takes-corner heuristic. The trapezoid's outer
    // edge sits flush with the box outer rect, and the inner edge is
    // inset by the side's width, with the corner points meeting the
    // adjacent sides' inner edges. Dashed / dotted / double / etc. sides
    // continue to use `<line>` because they'd need a clip-path to
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
      const cid = ctx.nextClipId("bs");
      ctx.defsParts.push(
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
    const hasNonRoundContour = corners.curvature != null
      && Object.values(corners.curvature).some(value => value !== 2);
    const contouredRingMaskId = hasOuterRadius && hasNonRoundContour
      ? createContouredRingMask(
          ctx, outerRoundedPath,
          bxL + lw, bxT + tw,
          Math.max(0, bxR - bxL - lw - rw), Math.max(0, bxB - bxT - tw - bw),
          innerCornersForAnnular,
        )
      : null;
    // Hyperellipses use Blink's general miter/bevel-hull quad. Round and
    // concave contours use the close-edge miter/opposite-bound branch; the
    // non-renderable concave path-intersection prerequisite is DM-2317.
    const hyperellipse = corners.curvature != null
      && Object.values(corners.curvature).every(value => value >= 2);
    const annularWedges: string[] = !hasOuterRadius ? [] : hyperellipse ? [
      hyperellipseBorderSideClipPolygon("top", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("right", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("bottom", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("left", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
    ] : [
      roundBorderSideClipPolygon("top", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("right", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("bottom", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("left", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
    ];
    const curvedStyledSide = hasOuterRadius && !hasNonRoundContour;
    if (curvedStyledSide) {
      // Blink's curved dashed/dotted branch does not stroke four independent
      // straight sides. It strokes the complete closed border centerline for
      // every side, then clips that stroke to the side's rounded miter wedge.
      // This preserves dash continuity through the corner arc and lets the
      // side clip, rather than a line endpoint, own each mixed-color joint.
      const centerCorners = insetCornerRadii(corners, tw / 2, rw / 2, bw / 2, lw / 2);
      const centerX = bxL + lw / 2;
      const centerY = bxT + tw / 2;
      const centerW = Math.max(0, bxR - bxL - (lw + rw) / 2);
      const centerH = Math.max(0, bxB - bxT - (tw + bw) / 2);
      const centerPath = roundedRectPath(centerX, centerY, centerW, centerH, centerCorners);
      const centerLength = roundedRectPerimeter(centerW, centerH, centerCorners);
      const ringMaskId = ctx.nextClipId("bm");
      ctx.defsParts.push(`<mask id="${ringMaskId}"><path d="${annularPath}" fill="white" fill-rule="evenodd"/></mask>`);
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i][0];
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style !== "dashed" && side.style !== "dotted") continue;
        const thinDotted = side.style === "dotted" && Math.round(side.w) <= 3;
        // Blink expands this stroke to 2.2 * max-adjacent-width solely so its
        // raster clip can antialias the border-ring edges. SVG clips/masks are
        // vector-antialiased themselves, so preserve the resulting logical
        // ink thickness here rather than copying that Skia overdraw width.
        const strokeWidth = side.w;
        const dash = adjustedClosedDashArray(side.style, side.w, centerLength, thinDotted);
        const cid = ctx.nextClipId("bc");
        ctx.defsParts.push(`<clipPath id="${cid}"><polygon points="${annularWedges[i]}"/></clipPath>`);
        const linecap = side.style === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
        const dashAttr = dash === "" ? "" : ` stroke-dasharray="${dash}"`;
        ctx.svgParts.push(`${indent}<path d="${centerPath}" fill="none" stroke="${colorStr(side.color)}" stroke-width="${r(strokeWidth)}"${dashAttr}${linecap} clip-path="url(#${cid})" mask="url(#${ringMaskId})" />`);
      }
    }
    // The outer-outline group still wraps the remaining non-solid branches
    // (notably double) so their straight strokes get trimmed to the rounded
    // outline. Dashed/dotted sides were emitted as closed curved paths above.
    // Solid sides emit their own annular wedge BEFORE the group
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
        const wid = ctx.nextClipId("bw");
        ctx.defsParts.push(
          `<clipPath id="${wid}"><polygon points="${annularWedges[i]}"/></clipPath>`,
        );
        ctx.svgParts.push(
          `${indent}<path d="${contouredRingMaskId == null ? annularPath : outerRoundedPath}" fill="${colorStr(side.color)}"${contouredRingMaskId == null ? ' fill-rule="evenodd"' : ` mask="url(#${contouredRingMaskId})"`} clip-path="url(#${wid})"/>`,
        );
      }
      const rcid = ctx.nextClipId("br");
      ctx.defsParts.push(
        `<clipPath id="${rcid}"><path d="${roundedRectPath(el.x, el.y, el.width, el.height, corners)}"/></clipPath>`,
      );
      ctx.svgParts.push(`${indent}<g clip-path="url(#${rcid})">`);
      roundedSideGroupOpen = true;
    }
    for (let i = 0; i < sides.length; i++) {
      emitBorderSide(ctx, indent, i, sides, trapezoids, doubleSides, useTrapezoid, hasOuterRadius, curvedStyledSide, sideClipForStyle);
    }
    if (roundedSideGroupOpen) ctx.svgParts.push(`${indent}</g>`);
}

// Background-image layer paint, extracted from renderElement (DM-1306, DM-1311).
// Emits the comma-separated background-image layers (gradients + url() images)
// as clipped rects, honoring per-layer size / position / repeat / clip / origin /
// attachment and per-layer background-blend-mode values. The caller owns the
// isolation group because the background color must share that paint stack.
// Also collects the
// background-clip:text layer fills into textBgClipFills, which the caller threads
// into paintText so the gradient paints inside the glyph shapes. Handles both the
// box element (the !useInlineFragments loop) and the wrapped-inline element's own
// text-clip layers (the useInlineFragments loop). clipIdx is threaded in and the
// advanced value returned so the positional ids stay byte-identical.
function paintBackgroundImageLayers(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  useInlineFragments: boolean,
  captureViewport: { w: number; h: number },
): { fills: string[]; fragmentFills: (string[] | null)[] } {
  const textBgClipFills: string[] = [];
  // DM-1420: per-line-fragment fills for a wrapped inline's bg-clip:text layers
  // (parallel to `textBgClipFills`; null for layers/elements painted single-box).
  const textBgClipFragmentFills: (string[] | null)[] = [];

  const bgImage = el.styles.backgroundImage;
  if (!useInlineFragments && bgImage != null && bgImage !== "none" && bgImage !== "") {
    const layers = splitTopLevelCommas(bgImage);
    const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
    const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
    const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
    const clipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
    const originLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
    const attachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
    const selectedImageLayers = el.styles.backgroundImages ?? [];
    const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
    // DM-817: background-blend-mode per CSS Compositing 2 §6.1 — each layer
    // blends with the composite below using its mode. Single value applies
    // to every layer; comma-separated values map per-layer. Capture
    // emit-time bg-layer indexing is reversed (later index = lower in
    // stack), so we look up by the ORIGINAL CSS layer index (`li`).
    const blendLayers = splitTopLevelCommas(el.styles.backgroundBlendMode ?? "normal").map((s) => s.trim());
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
    const borderBox = { x: el.x, y: el.y, width: el.width, height: el.height };
    // CSS: first layer paints on top of later layers. Emit in reverse order
    // so later SVG elements (= on top) correspond to first CSS layer.
    for (let li = layers.length - 1; li >= 0; li--) {
      const layer = layers[li].trim();
      const layerSize = cyclicBackgroundLayer(sizeLayers, li, "auto").trim();
      const layerPos = cyclicBackgroundLayer(posLayers, li, "0% 0%").trim();
      const layerRepeat = cyclicBackgroundLayer(repeatLayers, li, "repeat").trim();
      const layerClip = cyclicBackgroundLayer(clipLayers, li, "border-box").trim();
      const layerOrigin = cyclicBackgroundLayer(originLayers, li, "padding-box").trim();
      const layerIntrinsic = intrinsicLayers[li] ?? null;
      const selectedImage = selectedImageLayers[li] ?? null;
      const layerAttachment = cyclicBackgroundLayer(attachmentLayers, li, "scroll").trim();
      const originBox = boxFor(layerOrigin);
      const clipBox = boxFor(layerClip);
      const isUrlBacked = /^\s*(?:url\(|(?:-webkit-)?image-set\()/i.test(layer);
      // DM-2479: attachment selection happens before tile geometry. URL layers
      // consume the live Blink ownership record; gradients retain their
      // established path until they gain the same source-selected image
      // contract. Feeding the resolved positioning box as an ordinary box
      // prevents buildImagePatternDef from re-applying a viewport transform.
      const attachmentGeometry = isUrlBacked
        ? resolveBackgroundAttachment(
            layerAttachment,
            borderBox,
            { x: originBox.x, y: originBox.y, width: originBox.w, height: originBox.h },
            { x: clipBox.x, y: clipBox.y, width: clipBox.w, height: clipBox.h },
            el.styles.backgroundAttachmentGeometry,
            captureViewport,
          )
        : null;
      const positioningBox = attachmentGeometry?.positioningBox
        ?? { x: originBox.x, y: originBox.y, width: originBox.w, height: originBox.h };
      const paintingBox = attachmentGeometry?.paintingBox
        ?? { x: clipBox.x, y: clipBox.y, width: clipBox.w, height: clipBox.h };
      const defId = ctx.nextClipId("bg");
      // Pattern is positioned + sized relative to the origin box (where the image starts)
      // then painted into a rect clipped to the clip box. For fixed attachment
      // the origin is the viewport instead.
      const out = buildBackgroundLayerDef(
        defId, layer,
        positioningBox.x, positioningBox.y, positioningBox.width, positioningBox.height,
        layerSize, layerPos, layerRepeat, layerIntrinsic,
        attachmentGeometry == null ? layerAttachment : "scroll",
        attachmentGeometry == null ? captureViewport : null,
        selectedImage,
        paintingBox,
      );
      if (out.def === "") continue;
      ctx.defsParts.push(out.def);
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
      // CSS Compositing §6.1: every image layer uses its corresponding
      // background-blend-mode, including the bottom image layer as it blends
      // with the background color painted beneath it.
      const layerBlend = cyclicBackgroundLayer(blendLayers, li, "normal");
      const blendAttr = (layerBlend !== "normal" && layerBlend !== "")
        ? ` style="mix-blend-mode:${layerBlend}"` : "";
      ctx.svgParts.push(
        `${indent}${roundedRectSvg(paintingBox.x, paintingBox.y, paintingBox.width, paintingBox.height, innerCorners, `fill="url(#${defId})"${blendAttr}`)}`,
      );
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
    const selectedImageLayers = el.styles.backgroundImages ?? [];
    const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
    for (let li = layers.length - 1; li >= 0; li--) {
      const layerClip = cyclicBackgroundLayer(clipLayers, li, "border-box").trim();
      if (layerClip !== "text") continue;
      const layer = layers[li].trim();
      const layerSize = cyclicBackgroundLayer(sizeLayers, li, "auto").trim();
      const layerPos = cyclicBackgroundLayer(posLayers, li, "0% 0%").trim();
      const layerRepeat = cyclicBackgroundLayer(repeatLayers, li, "repeat").trim();
      const layerAttachment = cyclicBackgroundLayer(attachmentLayers, li, "scroll").trim();
      const layerIntrinsic = intrinsicLayers[li] ?? null;
      const selectedImage = selectedImageLayers[li] ?? null;
      const defId = ctx.nextClipId("bg");
      const out = buildBackgroundLayerDef(defId, layer, el.x, el.y, el.width, el.height, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport, selectedImage);
      if (out.def === "") continue;
      ctx.defsParts.push(out.def);
      textBgClipFills[li] = `url(#${defId})`;
      // DM-1420: a wrapped inline's `background-clip:text` background is painted
      // PER LINE FRAGMENT, not once over the union bbox. Over the union box a
      // `to right bottom` gradient puts the first-line text (top-right) mid-axis
      // (e.g. orange instead of yellow) and the second-line text (bottom-left)
      // too early — verified against Chromium-on-Linux paint (the gradient
      // restarts each fragment). Build one def per fragment over that fragment's
      // own box; the caller paints a masked rect per fragment so each line's
      // glyphs sample their own fragment's gradient. (Block elements have no
      // `inlineFragments`, so they keep the single union-box def above.)
      const frags = el.inlineFragments;
      if (frags != null && frags.length > 1) {
        // DM-1420: `box-decoration-break: slice` (the default) treats the wrapped
        // inline as ONE imaginary un-broken box: the bg image is positioned over
        // that continuous box and each line fragment shows its slice. So the
        // gradient must CONTINUE across fragments along inline flow, not restart
        // per line — confirmed against Chromium-on-Linux paint (line-2 "morning"
        // begins ~25-30% along the gradient where line-1 "this" left off, not at
        // 0%). Model each fragment's def over a VIRTUAL box of the concatenated
        // total inline width, shifted left by the cumulative width of prior
        // fragments, so fragment fi samples the gradient over [Σw<fi, Σw≤fi].
        // `clone` instead paints a complete box per fragment → gradient restarts,
        // so use each fragment's own box there.
        const clone = (el.styles.boxDecorationBreak ?? "slice") === "clone";
        const totalW = frags.reduce((s, fr) => s + fr.width, 0);
        const perFrag: string[] = [];
        let cumW = 0;
        for (const fr of frags) {
          const fid = ctx.nextClipId("bg");
          const gx = clone ? fr.x : fr.x - cumW;
          const gw = clone ? fr.width : totalW;
          const fout = buildBackgroundLayerDef(fid, layer, gx, fr.y, gw, fr.height, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport, selectedImage);
          cumW += fr.width;
          if (fout.def === "") { perFrag.push(textBgClipFills[li]!); continue; } // fall back to union fill
          ctx.defsParts.push(fout.def);
          perFrag.push(`url(#${fid})`);
        }
        textBgClipFragmentFills[li] = perFrag;
      }
    }
  }
  return { fills: textBgClipFills, fragmentFills: textBgClipFragmentFills };
}

// Inline-SVG content paint, extracted from renderElement (DM-1306, DM-1312).
// Injects width/height from the captured content box (inline SVGs in the wild
// often omit them, falling back to the 300x150 default) and translates to the
// content-box top-left, with the wrapping group's `color` set to the captured
// text color so `currentColor` icons resolve to Chrome's paint. Replaced
// elements suppress text/children, so when el.svgContent is present this is the
// element's entire content: the helper returns `handled: true` and the caller
// closes the open wrapper groups and returns. The DM-499 0x0-host skip emits no
// markup but still reports handled (the consumer-side <use> resolver already
// inlined the defs SVG's contents). Reads only el + indent.
function paintInlineSvg(el: CapturedElement, indent: string, allocClassPrefix?: () => string, idPrefix = ""): { svg: string[]; handled: boolean } {
  const svg: string[] = [];
  if (el.svgContent == null) return { svg, handled: false };
  // The captured el.x/y/width/height are border-box coords. The SVG draws into
  // the CONTENT-BOX, so subtract the left/top border + padding from the
  // translate offset so the SVG's (0, 0) lands at the content-box top-left
  // (DM-416 — otherwise it paints 1-2 px up + left of Chrome).
  const blW = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const btW = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const plW = parseFloat(el.styles.paddingLeft ?? "0") || 0;
  const ptW = parseFloat(el.styles.paddingTop ?? "0") || 0;
  const contentW = Math.max(0, el.width - blW - (parseFloat(el.styles.borderRightWidth ?? "0") || 0) - plW - (parseFloat(el.styles.paddingRight ?? "0") || 0));
  const contentH = Math.max(0, el.height - btW - (parseFloat(el.styles.borderBottomWidth ?? "0") || 0) - ptW - (parseFloat(el.styles.paddingBottom ?? "0") || 0));
  // DM-499: hidden defs SVGs (position:absolute;width:0;height:0) capture as
  // 0x0. injectSvgSize would no-op (its w<=0/h<=0 short-circuit), the SVG would
  // fall back to its 300x150 default viewport, and the defs contents would
  // paint visibly. Skip emission for 0x0 host elements.
  if (contentW <= 0 || contentH <= 0) return { svg, handled: true };
  let sized = injectSvgSize(el.svgContent, contentW, contentH);
  const referencePrefix = el.svgReferenceScope != null ? `${idPrefix}svgscope${el.svgReferenceScope}-` : allocClassPrefix?.();
  if (referencePrefix != null) sized = prefixSvgIds(sized, referencePrefix);
  // DM-1595: namespace CSS class names when this inline SVG carries a `<style>`
  // block, so two DOM inline SVGs that both define e.g. `.cls-1` can't cross-
  // contaminate (an SVG `<style>` applies document-wide once emitted). Gated on
  // `<style>` presence — the common presentation-attribute icon has none, so it
  // stays byte-identical AND allocates no prefix id (no counter shift). IDs are
  // intentionally NOT namespaced here: this path relies on the consumer-side
  // `<use>` resolver, which matches `<use href="#id">` by id ACROSS sibling SVGs
  // (DM-499), so prefixing ids would break those cross-SVG references.
  if (allocClassPrefix != null && /<style[\s>]/i.test(sized)) {
    sized = prefixSvgClasses(sized, `${referencePrefix ?? allocClassPrefix()}class-`);
  }
  // Inline SVG icons commonly use fill/stroke="currentColor" so the icon picks
  // up the host's text color. Set the wrapping group's `color` to the captured
  // text color so currentColor resolves to what Chrome painted (DM-279).
  const iconColor = el.styles.color != null && el.styles.color !== "" ? el.styles.color : "currentColor";
  svg.push(`${indent}<g transform="translate(${r(el.x + blW + plW)}, ${r(el.y + btW + ptW)})" color="${iconColor}">${sized}</g>`);
  return { svg, handled: true };
}

// Inset box-shadow paint, extracted from renderElement (DM-1306) — the inset
// counterpart to paintBoxShadow. Per CSS Backgrounds 3 6.4 / Chromium
// BoxPainterBase::PaintInsetBoxShadow: the shadow shape is the padding box
// shifted by (x, y) and inset by spread, painted as an even-odd donut clipped to
// the padding box (a stroked-rect glow for the pure-blur-centered case). Mints a
// filter + clip id per shadow, so clipIdx is threaded in and the advanced value
// returned. Returns { svg, defs, clipIdx }.
function paintInsetBoxShadow(
  ctx: PaintCtx,
  el: CapturedElement,
  corners: ReturnType<typeof parseCornerRadii>,
  indent: string,
): void {
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
      const fid = ctx.nextClipId("ish");
      ctx.defsParts.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
      );
      filterAttr = ` filter="url(#${fid})"`;
    }
    const cid = ctx.nextClipId("ishc");
    ctx.defsParts.push(
      `<clipPath id="${cid}">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, "")}</clipPath>`,
    );

    // Pure-blur-centered inset (x=0, y=0, spread=0, blur>0): the donut
    // has zero area, so use the legacy stroked-rect approach which
    // produces the right soft glow on all sides. Stroke width = blur/2;
    // the Gaussian softens it into Chrome's inset-glow falloff. DM-366.
    if (sh.x === 0 && sh.y === 0 && sh.spread === 0) {
      const ringWidth = Math.max(sh.blur / 2, 1);
      ctx.svgParts.push(
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
      ctx.svgParts.push(
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
    ctx.svgParts.push(
      `${indent}<g clip-path="url(#${cid})"><path d="${outerD} ${innerD}" fill="${shadowColor}" fill-rule="evenodd"${filterAttr}/></g>`,
    );
  }
  return;
}

// text-overflow truncation marker paint, extracted from renderElement (DM-1306,
// DM-373). When an element has text-overflow ellipsis (or a custom string) +
// overflow:hidden + white-space:nowrap and the captured text would actually be
// clipped, Chrome paints a truncation marker at the content-box right edge (we
// read the full source text and clip with SVG, so the marker is otherwise
// missing). Emits a background rect that erases the overflowing text plus the
// marker glyph. Reads only el + textColor + indent; appends to no shared state.
function paintTruncationMarker(el: CapturedElement, textColor: ReturnType<typeof parseColor>, indent: string): string[] {
  const out: string[] = [];
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
    out.push(`${indent}<rect x="${r(bgX)}" y="${r(bgY)}" width="${r(bgRightX - bgX)}" height="${r(bgH)}" fill="${bgCol}" />`);
    out.push(`${indent}<text x="${r(markerRightX)}" y="${r(ty)}" text-anchor="end" font-size="${r(fontSizePx)}" font-family="${esc(el.styles.fontFamily)}" fill="${fillCol}">${escMarker}</text>`);
  }
  return out;
}

function customResizerRadius(value: string | undefined, size: number, zoom: number): number {
  if (value == null || value === "") return 0;
  const token = value.trim().split(/[\s/]+/)[0] ?? "0";
  const amount = parseFloat(token) || 0;
  return Math.max(0, Math.min(size / 2, token.endsWith("%") ? size * amount / 100 : amount * zoom));
}

function customResizerBorder(
  value: string | undefined,
  zoom: number,
): { width: number; style: string; color: string } | null {
  if (value == null || value === "" || value === "none") return null;
  const match = /^\s*([\d.]+)px\s+(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)\s+(.+?)\s*$/i.exec(value);
  if (match == null || match[2] === "none" || match[2] === "hidden") return null;
  return { width: (parseFloat(match[1]) || 0) * zoom, style: match[2], color: match[3] };
}

function customScrollbarBorderSide(
  value: { width: string; style: string; color: string } | undefined,
  zoom: number,
): { width: string; style: string; color: string } {
  return {
    width: `${r((parseFloat(value?.width ?? "0") || 0) * zoom)}px`,
    style: value?.style || "none",
    color: value?.color || "rgba(0, 0, 0, 0)",
  };
}

function scaledScrollbarCornerLonghands(
  value: string | undefined,
  zoom: number,
): {
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
} {
  const [horizontalText = "0px", verticalText] = (value ?? "0px").split("/").map((part) => part.trim());
  const expand = (text: string): string[] => {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) return [tokens[0] ?? "0px", tokens[0] ?? "0px", tokens[0] ?? "0px", tokens[0] ?? "0px"];
    if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
    if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
    return tokens.slice(0, 4);
  };
  const scale = (token: string): string => `${r((parseFloat(token) || 0) * zoom)}px`;
  const horizontal = expand(horizontalText).map(scale);
  const vertical = expand(verticalText ?? horizontalText).map(scale);
  const pair = (index: number): string => `${horizontal[index]} ${vertical[index]}`;
  return {
    borderTopLeftRadius: pair(0),
    borderTopRightRadius: pair(1),
    borderBottomRightRadius: pair(2),
    borderBottomLeftRadius: pair(3),
  };
}

function scaledScrollbarBoxShadow(value: string | undefined, zoom: number): string {
  return parseBoxShadow(value ?? "none").map((shadow) => (
    `${shadow.color} ${r(shadow.x * zoom)}px ${r(shadow.y * zoom)}px ${r(shadow.blur * zoom)}px ${r(shadow.spread * zoom)}px${shadow.inset ? " inset" : ""}`
  )).join(", ");
}

function paintCustomScrollbarVectorPart(
  ctx: PaintCtx,
  captureViewport: { w: number; h: number },
  owner: CapturedElement,
  item: CustomScrollbarVectorPart,
  indent: string,
): string[] {
  const style = item.part.finalPseudoStyle;
  if (style == null || style.display === "none" || style.visibility !== "visible") return [];
  if (style.filter !== "" && style.filter !== "none") return [];
  const opacity = Number.parseFloat(style.opacity || "1");
  if (!Number.isFinite(opacity) || opacity <= 0) return [];

  const zoom = item.effectiveZoom > 0 ? item.effectiveZoom : 1;
  const border = customResizerBorder(style.border, zoom);
  const topBorder = customScrollbarBorderSide(style.borderSides?.top, zoom);
  const rightBorder = customScrollbarBorderSide(style.borderSides?.right, zoom);
  const bottomBorder = customScrollbarBorderSide(style.borderSides?.bottom, zoom);
  const leftBorder = customScrollbarBorderSide(style.borderSides?.left, zoom);
  const uniformBorderWidth = `${border?.width ?? 0}px`;
  const uniformBorderStyle = border?.style ?? "none";
  const uniformBorderColor = border?.color ?? "rgba(0, 0, 0, 0)";
  const perSideBorder = style.borderSides != null;
  const radiusLonghands = scaledScrollbarCornerLonghands(style.borderRadius, zoom);
  const rect = item.part.rect;
  const fake: CapturedElement = {
    ...owner,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    children: [],
    fieldsetLegendNotch: undefined,
    styles: {
      ...owner.styles,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      borderImageSource: "none",
      borderWidth: uniformBorderWidth,
      borderTopWidth: perSideBorder ? topBorder.width : uniformBorderWidth,
      borderRightWidth: perSideBorder ? rightBorder.width : uniformBorderWidth,
      borderBottomWidth: perSideBorder ? bottomBorder.width : uniformBorderWidth,
      borderLeftWidth: perSideBorder ? leftBorder.width : uniformBorderWidth,
      borderTopStyle: perSideBorder ? topBorder.style : uniformBorderStyle,
      borderRightStyle: perSideBorder ? rightBorder.style : uniformBorderStyle,
      borderBottomStyle: perSideBorder ? bottomBorder.style : uniformBorderStyle,
      borderLeftStyle: perSideBorder ? leftBorder.style : uniformBorderStyle,
      borderColor: uniformBorderColor,
      borderTopColor: perSideBorder ? topBorder.color : uniformBorderColor,
      borderRightColor: perSideBorder ? rightBorder.color : uniformBorderColor,
      borderBottomColor: perSideBorder ? bottomBorder.color : uniformBorderColor,
      borderLeftColor: perSideBorder ? leftBorder.color : uniformBorderColor,
      borderRadius: radiusLonghands.borderTopLeftRadius,
      ...radiusLonghands,
      boxShadow: scaledScrollbarBoxShadow(style.boxShadow, zoom),
      opacity: "1",
      filter: "none",
    },
  };
  const corners = parseCornerRadii(fake.styles, rect.width, rect.height);
  const localCtx: PaintCtx = { ...ctx, svgParts: [] };
  const contentIndent = opacity < 1 ? `${indent}  ` : indent;

  paintBoxShadow(localCtx, fake, corners, contentIndent);
  const color = parseColor(style.backgroundColor || "transparent");
  if (color != null && color.a > 0) {
    localCtx.svgParts.push(`${contentIndent}${roundedRectSvg(rect.x, rect.y, rect.width, rect.height, corners, `fill="${colorStr(color)}"`)}`);
  }
  if (style.backgroundImage !== "" && style.backgroundImage !== "none") {
    const layers = buildPseudoBoxBgLayers(localCtx, captureViewport, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      backgroundImage: style.backgroundImage,
    });
    if (layers !== "") {
      const clipId = ctx.nextClipId("customscrollpartbg");
      ctx.defsParts.push(`<clipPath id="${clipId}">${roundedRectSvg(rect.x, rect.y, rect.width, rect.height, corners, "")}</clipPath>`);
      localCtx.svgParts.push(`${contentIndent}<g clip-path="url(#${clipId})">${layers}</g>`);
    }
  }
  paintInsetBoxShadow(localCtx, fake, corners, contentIndent);
  paintBorder(
    localCtx,
    fake,
    contentIndent,
    corners,
    captureViewport.w,
    captureViewport.h,
    border?.width ?? 0,
    parseColor(border?.color ?? "transparent"),
    false,
    false,
    new Set<CapturedElement>(),
  );
  if (localCtx.svgParts.length === 0) return [];
  return opacity < 1
    ? [`${indent}<g opacity="${r(opacity)}">`, ...localCtx.svgParts, `${indent}</g>`]
    : localCtx.svgParts;
}

/**
 * ScrollableAreaPainter::PaintResizer / DrawPlatformResizerImage at
 * Chromium 7d859f271c. Activation, theme thickness, snapped CornerRect, and
 * custom-pseudo ownership are browser-captured facts; this stage only paints.
 */
function paintResizeHandle(
  ctx: PaintCtx,
  captureViewport: { w: number; h: number },
  el: CapturedElement,
  indent: string,
): string[] {
  const handle = el.resizeHandle;
  if (handle == null || handle.width <= 0 || handle.height <= 0) return [];

  const out: string[] = [];
  const custom = handle.custom;
  if (custom != null) {
    const zoom = custom.effectiveZoom > 0 ? custom.effectiveZoom : 1;
    const radius = customResizerRadius(custom.borderRadius, Math.min(handle.width, handle.height), zoom);
    const parsedShadows = parseBoxShadow(custom.boxShadow ?? "none");
    const scaledShadowCss = parsedShadows.map((shadow) => `${shadow.color} ${r(shadow.x * zoom)}px ${r(shadow.y * zoom)}px ${r(shadow.blur * zoom)}px ${r(shadow.spread * zoom)}px${shadow.inset ? " inset" : ""}`).join(", ");
    const border = customResizerBorder(custom.border, zoom);
    const shadowElement = {
      ...el,
      x: handle.x, y: handle.y, width: handle.width, height: handle.height,
      styles: {
        ...el.styles,
        boxShadow: scaledShadowCss,
        borderRadius: `${radius}px`,
        borderTopLeftRadius: `${radius}px`, borderTopRightRadius: `${radius}px`,
        borderBottomRightRadius: `${radius}px`, borderBottomLeftRadius: `${radius}px`,
        borderLeftWidth: `${border?.width ?? 0}px`, borderRightWidth: `${border?.width ?? 0}px`,
        borderTopWidth: `${border?.width ?? 0}px`, borderBottomWidth: `${border?.width ?? 0}px`,
      },
    } as CapturedElement;
    const shadowCorners = parseCornerRadii(shadowElement.styles, handle.width, handle.height);
    const shadowCtx: PaintCtx = { ...ctx, svgParts: [] };
    paintBoxShadow(shadowCtx, shadowElement, shadowCorners, "");
    const outerShadows = shadowCtx.svgParts.splice(0);

    const color = parseColor(custom.backgroundColor ?? "transparent");
    if (color != null && color.a > 0) {
      out.push(`${indent}<rect x="${r(handle.x)}" y="${r(handle.y)}" width="${r(handle.width)}" height="${r(handle.height)}"${radius > 0 ? ` rx="${r(radius)}" ry="${r(radius)}"` : ""} fill="${colorStr(color)}" />`);
    }
    if (custom.backgroundImage != null && custom.backgroundImage !== "" && custom.backgroundImage !== "none") {
      const layers = buildPseudoBoxBgLayers(ctx, captureViewport, {
        x: handle.x,
        y: handle.y,
        width: handle.width,
        height: handle.height,
        backgroundImage: custom.backgroundImage,
        borderRadius: radius,
      });
      if (layers !== "") out.push(`${indent}${layers}`);
    }
    const backgroundParts = out.splice(0);
    paintInsetBoxShadow(shadowCtx, shadowElement, shadowCorners, "");
    const insetShadows = shadowCtx.svgParts.splice(0);
    if (border != null && border.width > 0 && border.style !== "none") {
      const half = border.width / 2;
      const dash = dashArrayForStyle(border.style, border.width);
      const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
      out.push(`${indent}<rect x="${r(handle.x + half)}" y="${r(handle.y + half)}" width="${r(Math.max(0, handle.width - border.width))}" height="${r(Math.max(0, handle.height - border.width))}"${radius > 0 ? ` rx="${r(Math.max(0, radius - half))}" ry="${r(Math.max(0, radius - half))}"` : ""} fill="none" stroke="${esc(border.color)}" stroke-width="${r(border.width)}"${dashAttr} />`);
    }
    if (parsedShadows.length > 0) {
      const clipId = ctx.nextClipId("resizersh");
      ctx.defsParts.push(`<clipPath id="${clipId}">${roundedRectSvg(handle.x, handle.y, handle.width, handle.height, shadowCorners, "")}</clipPath>`);
      return [`${indent}<g clip-path="url(#${clipId})">`, ...outerShadows.map((part) => `${indent}  ${part}`), ...backgroundParts.map((part) => `  ${part}`), ...insetShadows.map((part) => `${indent}  ${part}`), ...out.map((part) => `  ${part}`), `${indent}</g>`];
    }
    return [...backgroundParts, ...out];
  }

  const strokes = blinkPlatformResizerStrokes(
    { x: handle.x, y: handle.y, width: handle.width, height: handle.height },
    handle.scaleFromDIP,
    handle.logicalLeft,
  );
  const pathData = (points: typeof strokes.dark): string =>
    `M${r(points[0].x)},${r(points[0].y)} L${r(points[1].x)},${r(points[1].y)} M${r(points[2].x)},${r(points[2].y)} L${r(points[3].x)},${r(points[3].y)}`;
  out.push(`${indent}<path d="${pathData(strokes.dark)}" fill="none" stroke="rgb(0,0,0)" stroke-opacity="0.6" stroke-width="${r(strokes.strokeWidth)}" />`);
  out.push(`${indent}<path d="${pathData(strokes.light)}" fill="none" stroke="rgb(255,255,255)" stroke-opacity="0.6" stroke-width="${r(strokes.strokeWidth)}" />`);

  if (handle.hasScrollbar) {
    // Blink clips a (w+1)x(h+1) outline to CornerRect, excluding its right and
    // bottom edges. Emit the two surviving edges directly.
    out.push(`${indent}<path d="M${r(handle.x + 0.5)},${r(handle.y + handle.height)} L${r(handle.x + 0.5)},${r(handle.y + 0.5)} L${r(handle.x + handle.width)},${r(handle.y + 0.5)}" fill="none" stroke="rgb(217,217,217)" stroke-width="1" />`);
  }
  return out;
}

export interface ThinDottedEndpointPlan {
  startDotGrowth: number | null;
  endDotGrowth: number | null;
  lineStart: number;
  lineEnd: number;
}

/**
 * Chromium `EnforceDotsAtEndpoints`, expressed along one increasing axis.
 * The caller supplies the already-rounded integer path length and stroke
 * width used by BoxBorderPainter. A non-null growth means that endpoint dot
 * is painted explicitly; zero is an ordinary width-by-width square.
 */
export function thinDottedEndpointPlan(pathLength: number, width: number): ThinDottedEndpointPlan {
  const length = Math.round(pathLength);
  const w = Math.round(width);
  let startDotGrowth: number | null = null;
  let startLineOffset = 0;
  let endDotGrowth: number | null = null;
  const mod4 = length % 4;
  const mod6 = length % 6;
  if ((w === 1 && length % 2 === 0) || (w === 3 && mod6 === 0)) {
    startDotGrowth = 1;
    startLineOffset = 1;
  }
  if ((w === 2 && (mod4 === 0 || mod4 === 1)) ||
      (w === 3 && (mod6 === 1 || mod6 === 2))) {
    startDotGrowth = 0;
    startLineOffset = -1;
  }
  if ((w === 2 && mod4 === 0) || (w === 3 && mod6 === 1)) endDotGrowth = 0;
  if ((w === 2 && mod4 === 3) || (w === 3 && (mod6 === 4 || mod6 === 5))) {
    startDotGrowth = 0;
    startLineOffset = 1;
  }
  if (w === 3 && mod6 === 5) endDotGrowth = 0;
  else if (w === 3 && mod6 === 0) endDotGrowth = 1;
  return {
    startDotGrowth,
    endDotGrowth,
    lineStart: startDotGrowth == null ? 0 : 2 * w + startLineOffset,
    lineEnd: endDotGrowth == null ? length : length - (w + endDotGrowth + 1),
  };
}

function paintThinDottedLine(
  x1: number, y1: number, x2: number, y2: number,
  width: number, color: string, indent: string,
): string[] {
  const vertical = x1 === x2;
  const w = Math.round(width);
  const length = Math.round(vertical ? y2 - y1 : x2 - x1);
  const plan = thinDottedEndpointPlan(length, w);
  const out: string[] = [];
  if (plan.startDotGrowth != null) {
    out.push(vertical
      ? `${indent}<rect x="${r(x1 - w / 2)}" y="${r(y1)}" width="${r(w)}" height="${r(w + plan.startDotGrowth)}" fill="${color}" />`
      : `${indent}<rect x="${r(x1)}" y="${r(y1 - w / 2)}" width="${r(w + plan.startDotGrowth)}" height="${r(w)}" fill="${color}" />`);
  }
  if (plan.endDotGrowth != null) {
    out.push(vertical
      ? `${indent}<rect x="${r(x2 - w / 2)}" y="${r(y2 - w - plan.endDotGrowth)}" width="${r(w)}" height="${r(w + plan.endDotGrowth)}" fill="${color}" />`
      : `${indent}<rect x="${r(x2 - w - plan.endDotGrowth)}" y="${r(y2 - w / 2)}" width="${r(w + plan.endDotGrowth)}" height="${r(w)}" fill="${color}" />`);
  }
  // The caller passes the visible centerline (Chromium's integer center path
  // plus DrawLineWithStyle's odd-width 0.5 adjustment). Keeping that boundary
  // here also makes the explicit endpoint rectangles integral for odd widths.
  const sx = vertical ? x1 : x1 + plan.lineStart;
  const sy = vertical ? y1 + plan.lineStart : y1;
  const ex = vertical ? x2 : x1 + plan.lineEnd;
  const ey = vertical ? y1 + plan.lineEnd : y2;
  if (plan.lineEnd >= plan.lineStart) {
    out.push(`${indent}<line x1="${r(sx)}" y1="${r(sy)}" x2="${r(ex)}" y2="${r(ey)}" stroke="${color}" stroke-width="${r(w)}" stroke-dasharray="${r(w)} ${r(w)}" />`);
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
      let ox = el.x - inflate;
      let oy = el.y - inflate;
      let owd = el.width + inflate * 2;
      let oh = el.height + inflate * 2;
      // DM-2324: ComplexOutlinePainter builds its right-angle region from
      // integer gfx::Rects, outsets that region by the integer outline offset
      // and width, then derives the center path.  getBoundingClientRect() is
      // fractional, so retaining its edges here put otherwise-crisp 1--3 px
      // dotted outlines between device pixels under CSS zoom.
      if (borderRadius === 0) {
        const width = Math.round(ow);
        const outset = Math.round(offset) + width;
        const outerLeft = Math.round(el.x) - outset;
        const outerTop = Math.round(el.y) - outset;
        const outerRight = Math.round(el.x + el.width) + outset;
        const outerBottom = Math.round(el.y + el.height) + outset;
        ox = outerLeft + width / 2;
        oy = outerTop + width / 2;
        owd = outerRight - outerLeft - width;
        oh = outerBottom - outerTop - width;
      }
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
        const thinDotted = ostyle === "dotted" && Math.round(ow) <= 3;
        const linecap = ostyle === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
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
        if (thinDotted) {
          const color = colorStr(ocolor);
          out.push(
            ...paintThinDottedLine(ox, oy, oxR, oy, ow, color, indent),
            ...paintThinDottedLine(oxR, oy, oxR, oyB, ow, color, indent),
            ...paintThinDottedLine(ox, oyB, oxR, oyB, ow, color, indent),
            ...paintThinDottedLine(ox, oy, ox, oyB, ow, color, indent),
          );
        } else {
          out.push(
            `${indent}<line x1="${r(ox)}" y1="${r(oy)}" x2="${r(oxR)}" y2="${r(oy)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${indent}<line x1="${r(oxR)}" y1="${r(oy)}" x2="${r(oxR)}" y2="${r(oyB)}" ${strokeAttrs}${vAttrs}${linecap} />`,
            `${indent}<line x1="${r(ox)}" y1="${r(oyB)}" x2="${r(oxR)}" y2="${r(oyB)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${indent}<line x1="${r(ox)}" y1="${r(oy)}" x2="${r(ox)}" y2="${r(oyB)}" ${strokeAttrs}${vAttrs}${linecap} />`,
          );
        }
      } else {
        let dash = dashArrayForStyle(ostyle, ow);
        const linecap = ostyle === "dotted" ? ` stroke-linecap="round"` : "";
        if ((ostyle === "dashed" || ostyle === "dotted") && oRadius > 0) {
          const perimeter = 2 * (owd + oh - 4 * oRadius) + 2 * Math.PI * oRadius;
          if (ostyle === "dashed") {
            const dashLen = ow * (ow >= 3 ? 2 : 3);
            const gap = selectBestDashGap(perimeter, dashLen, ow * (ow >= 3 ? 1 : 2), true);
            dash = gap > 0 ? `${r(dashLen)} ${r(gap)}` : "";
          } else {
            const gap = selectBestDashGap(perimeter, ow, ow, true);
            dash = gap > 0 ? `0.01 ${r(gap + ow - 0.01)}` : "";
          }
        }
        out.push(
          `${indent}<rect x="${r(ox)}" y="${r(oy)}" width="${r(owd)}" height="${r(oh)}" rx="${r(oRadius)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
        );
      }
    }
  }
  return out;
}

/**
 * Assemble the per-render `RenderState` + paint contexts (extracted from
 * `elementTreeToSvgInner`, DM-1458). Builds the SVG/defs accumulators, the
 * clip/gradient id allocators, the hoisting + overflow-clip bookkeeping, the
 * captured fragment mask/clip-path/filter def tables, and the off-grid
 * collapsed-cell set, returning the `state` struct the lifted render functions
 * read. `fragmentFilterDefs` is returned alongside because the caller emits
 * those verbatim into the top-level <defs> right after building state.
 */
function buildRenderState(
  elements: CapturedElement[],
  width: number,
  height: number,
  idPrefix: string,
  hiDPIFactor: number,
): { state: RenderState; fragmentFilterDefs: Map<string, { id: string; outerHTML: string }> } {
  setActiveHiDPIFactor(hiDPIFactor);
  // DM-1723: annotate in-flow descendants of decorating boxes with their
  // ancestor's propagated text-decoration (CSS Text Decoration 3 §2 —
  // decoration propagates without inheriting, so a <strong> inside an
  // underlined span computes `none` yet Chrome paints the parent's line
  // beneath it). Idempotent, so re-rendering a shared tree is safe.
  propagateTextDecorations(elements);
  const svgParts: string[] = [];
  const defsParts: string[] = [];
  let clipIdx = 0;
  let gradIdx = 0;
  // DM-1317: context handed to the per-phase paint helpers. Its allocators
  // close over `clipIdx` above, so helpers and the inline render code share the
  // one counter, keeping the positional id sequence byte-identical.
  const paintCtx: PaintCtx = {
    svgParts,
    defsParts,
    idPrefix,
    nextClipId: (prefix) => `${idPrefix}${prefix}${clipIdx++}`,
    peekClipIdx: () => clipIdx,
    advanceClipIdx: (n) => { clipIdx += n; },
    emittedTextCtm: buildEmittedTextCtmMap(elements),
  };
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
  // DM-1342: fragmentMaskCounter / fragmentClipPathCounter live on `state`
  // below (they are mutated by the lifted resolver functions).
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
    // DM-1260: scope the off-grid detection PER TABLE. The shifted-consensus
    // heuristic compares cell edges against each other, so running it over every
    // collapsed cell in the document lets cells in one table falsely "vote" a cell
    // in a DIFFERENT table off-grid whenever their unrelated x/y coordinates land
    // 1-2px apart — which disabled collapsed-border centering on innocent tables
    // (e.g. the conflict-resolution fixture's tie-test). Group by the owning
    // <table> first, then detect within each.
    const groups = new Map<CapturedElement, CapturedElement[]>();
    const collect = (el: CapturedElement, table: CapturedElement | null) => {
      const t = el.tag === "table" ? el : table;
      if (t != null && el.styles?.borderCollapse === "collapse" && (el.tag === "td" || el.tag === "th")) {
        const arr = groups.get(t); if (arr) arr.push(el); else groups.set(t, [el]);
      }
      for (const c of el.children) collect(c, t);
    };
    for (const root of elements) collect(root, null);
    for (const cells of groups.values()) {
      const offGrid = findOffGridCollapsedCells(cells);
      for (let i = 0; i < cells.length; i++) {
        if (offGrid[i]) offGridCollapsedCells.add(cells[i]);
      }
    }
  }

  const fragmentClipPathOutputId = new Map<string, string>();

  // DM-1342: bundle the render-loop's shared mutable state into one struct so
  // the render functions below can live at module scope instead of as nested
  // closures. Arrays/Maps/Sets are shared by reference; the two fragment
  // counters are owned here (mutated via `state.fragment*Counter++`).
  const state: RenderState = {
    svgParts,
    defsParts,
    paintCtx,
    defCtx,
    captureViewport,
    width,
    height,
    idPrefix,
    hoistedFromAncestor,
    overflowClipForHoisted,
    overflowClipPathIds,
    offGridCollapsedCells,
    elementMaskRasters,
    fragmentMaskDefs,
    fragmentMaskOutputId,
    fragmentMaskCounter: 0,
    fragmentClipPathDefs,
    fragmentClipPathOutputId,
    fragmentClipPathCounter: 0,
    elementClipPathIds: new Map(),
    elementMaskIds: new Map(),
    childPlans: new Map(),
    bgClipTextFills: new Map(),
  };

  return { state, fragmentFilterDefs };
}

function elementTreeToSvgInnerImpl(
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
  const { state, fragmentFilterDefs } = buildRenderState(elements, width, height, idPrefix, hiDPIFactor);
  const { svgParts, defsParts, hoistedFromAncestor, overflowClipForHoisted } = state;

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
  // <transform|filter|perspective> / computed perspective / computed
  // transform-style:preserve-3d / contain:<paint|strict|content|layout>),
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
  // The implicit document root stacking context paints in the same phased
  // order as any other: every in-flow block's box (step 3), then the floats
  // (step 4), then all the inline content (step 5), then the positioned and
  // stacking-context children (steps 6-7). Splitting the two block passes is
  // what lets a float in the first section paint below the text of the last
  // one — CSS 2.1 Appendix E's float step is context-wide.
  const topBuckets = paintOrderBuckets(topLevelFlat, undefined, undefined, topLevelHoistedAsInline, topLevelHoistedAsZSorted);
  const topPlan: ChildPaintPlan = { buckets: topBuckets, childDisplay: undefined, flat3d: null };
  renderChildBoxPhase(state, topPlan, 0);
  renderChildInlinePhase(state, topPlan, 0);

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
 * Body of the frame renderer, wrapped in a document scope for the macOS
 * ideograph fallback cache. Chrome's per-character fallback cache for
 * ideographs lives on the renderer process's FontCache (Blink
 * mac/font_cache_mac.mm — see `beginCharacterFallbackDocument` in
 * font-resolution.ts for the full transcription), so its state spans one
 * captured document and never leaks into the next. Mirroring that scope here —
 * a fresh scope per top-level render, `finally`-closed — is what keeps the
 * modeled order dependence DOCUMENT order rather than sweep order across
 * renders in one Node process. Multi-frame composers (animator, scroll
 * composer) open a single spanning scope of their own; the per-frame scope
 * here then nests inside it as a no-op, matching Chrome, where all frames of
 * one capture session share one renderer cache.
 */
export function elementTreeToSvgInner(
  ...args: Parameters<typeof elementTreeToSvgInnerImpl>
): string {
  beginCharacterFallbackDocument();
  try {
    return elementTreeToSvgInnerImpl(...args);
  } finally {
    endCharacterFallbackDocument();
  }
}

// DM-1342: render functions lifted out of `elementTreeToSvgInner` to module
// scope. They were nested closures capturing ~18 shared locals; they now take
// an explicit `state: RenderState` (built once per render) and destructure the
// fields they need. Function declarations, so call order is hoist-independent.
function resolveFragmentClipPathRef(
  state: RenderState,
  clipPathCss: string,
  elX: number, elY: number,
): string | null {
  const { fragmentClipPathDefs, fragmentClipPathOutputId, defsParts, idPrefix } = state;
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
    const outId = `${idPrefix}cpfrag${state.fragmentClipPathCounter++}`;
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
  const outId = `${idPrefix}cpfrag${state.fragmentClipPathCounter++}`;
  fragmentClipPathOutputId.set(cacheKey, outId);
  const rewritten = rewriteFragmentMaskDef(def.outerHTML, outId, idPrefix);
  defsParts.push(positionFragmentClipPathDef(rewritten, elX, elY));
  return outId;
}
function resolveFragmentMaskRef(
  state: RenderState,
  maskImage: string,
  elX: number, elY: number, elW: number, elH: number,
): string | null {
  const { fragmentMaskDefs, fragmentMaskOutputId, defsParts, idPrefix } = state;
  const m = /^url\(\s*(?:"|')?#([^"')\s]+)(?:"|')?\s*\)$/i.exec(maskImage);
  if (m == null) return null;
  const fragId = m[1];
  const def = fragmentMaskDefs.get(fragId);
  if (def == null) return null;
  const cacheKey = `${fragId}|${r(elX)}|${r(elY)}|${r(elW)}|${r(elH)}`;
  const cached = fragmentMaskOutputId.get(cacheKey);
  if (cached != null) return cached;
  const outId = `${idPrefix}mkfrag${state.fragmentMaskCounter++}`;
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
// id. Allocates clip ids and pushes defs via `state.paintCtx` / `state.defsParts`
// (exactly as the inline code did). Handles mask-border simple-url / 9-slice (DM-758/793),
// same-document fragment refs (DM-493), and gradient/url() mask-image with
// mask-clip insets (DM-820). Returns the mask url id, or null when no mask
// is emitted. Extracted from renderElement (DM-1092).
function renderMaskPhase(state: RenderState, el: CapturedElement): string | null {
  const { paintCtx, defsParts, idPrefix, elementMaskRasters } = state;
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
    const mid = paintCtx.nextClipId("mk");
    defsParts.push(
      `<mask id="${mid}" maskUnits="userSpaceOnUse" mask-type="alpha">`
        + `<image href="${esc(dataUri)}" x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" preserveAspectRatio="none" />`
        + `</mask>`,
    );
    maskUrlId = mid;
  } else if (usingMaskBorder9Slice && mbUrlHref != null) {
    const mid = paintCtx.nextClipId("mk");
    const built = buildMaskBorder9Slice(
      el, mbUrlHref, mbSlice, mbWidth, mbOutset, el.styles.maskBorderRepeat ?? "stretch",
      mid, idPrefix, paintCtx.peekClipIdx(),
    );
    if (built != null) {
      defsParts.push(built.def);
      paintCtx.advanceClipIdx(built.nextClipIdx - paintCtx.peekClipIdx());
      maskUrlId = built.id;
    }
  } else if (maskImage != null && maskImage !== "none" && maskImage !== "") {
    // DM-493: same-document fragment refs (mask-image: url("#id")) emit the
    // captured inline <mask> verbatim with id rewriting, bypassing the
    // gradient/url() emission path.
    const fragRef = resolveFragmentMaskRef(state, maskImage, el.x, el.y, el.width, el.height);
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
      // DM-2472: Blink resolves mask-origin (positioning) independently from
      // mask-clip (painting intersection). Keep the border box intact here;
      // buildMaskDef cycles each list and threads both rectangles through its
      // URL/gradient/fragment/composite paths. Older captures fall back to the
      // legacy physical fields (exact at zoom:1).
      const side = (value: string | undefined): number => parseFloat(value ?? "0") || 0;
      const maskInsets = el.styles.maskBoxInsets ?? {
        border: {
          top: side(el.styles.borderTopWidth), right: side(el.styles.borderRightWidth),
          bottom: side(el.styles.borderBottomWidth), left: side(el.styles.borderLeftWidth),
        },
        padding: {
          top: side(el.styles.paddingTop), right: side(el.styles.paddingRight),
          bottom: side(el.styles.paddingBottom), left: side(el.styles.paddingLeft),
        },
      };
      const maskDef = buildMaskDef(
        paintCtx.nextClipId("mk"),
        maskImage,
        el.x, el.y, el.width, el.height,
        el.styles.maskMode ?? "match-source",
        maskSize,
        maskPosition,
        maskRepeat,
        el.styles.maskComposite ?? "add",
        elementMaskRasters,
        el.styles.maskIntrinsic,
        el.inlineFragments != null && el.inlineFragments.length > 1
          ? {
              fragments: el.inlineFragments,
              writingMode: el.styles.writingMode,
              direction: el.styles.direction,
              boxDecorationBreak: el.styles.boxDecorationBreak,
              fragmentAxis: el.fragmentAxis,
            }
          : undefined,
        {
          originCss: el.styles.maskOrigin ?? "border-box",
          clipCss: el.styles.maskClip ?? "border-box",
          border: maskInsets.border,
          padding: maskInsets.padding,
          noClipPaintingArea: { x: 0, y: 0, width: state.width, height: state.height },
        },
      );
      if (maskDef.def !== "") {
        maskUrlId = maskDef.id;
        defsParts.push(maskDef.def);
      }
    }
  }
  return maskUrlId;
}

// DM-673: wraps `renderElement` with a `<g clip-path>` group when `el`
// was hoisted past an overflow-clip ancestor. The ancestor's clip-path
// id is stashed in `overflowClipPathIds` by the ancestor's own
// renderElement call (which runs first because sections paint at body's
// step 3 / base bucket, BEFORE positioned descendants at step 6 /
// zeroOrAuto bucket). `position:fixed` descendants are never added to
// the map (CSS Overflow 3 §2.2 — fixed elements escape ancestor
// overflow clipping), so they aren't wrapped here.
function renderElementWithOverflowClip(state: RenderState, el: CapturedElement, depth: number, parentDisplayForEl?: string, phase: PaintPhase = "all"): void {
  const { overflowClipForHoisted, overflowClipPathIds, svgParts } = state;
  const overflowClipAncestor = overflowClipForHoisted.get(el);
  const clipId = overflowClipAncestor != null ? overflowClipPathIds.get(overflowClipAncestor) : undefined;
  if (clipId == null) {
    renderElement(state, el, depth, parentDisplayForEl, phase);
    return;
  }
  const indent = "  ".repeat(depth);
  svgParts.push(`${indent}<g clip-path="url(#${clipId})">`);
  renderElement(state, el, depth, parentDisplayForEl, phase);
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
/**
 * Per-fragment corner radii for a wrapped inline / multi-column block fragment
 * (extracted from `renderInlineFragments`, DM-1458). In slice mode the radii
 * belong only to the entry/exit edges — which edges depends on the fragmentation
 * axis: inline-axis keeps TL/BL on the first fragment + TR/BR on the last;
 * block-axis keeps TL/TR on the first + BL/BR on the last. Middle fragments
 * collapse to sharp 90° corners. Clone treats every fragment as a complete box,
 * keeping all four corners.
 */
function deriveFragmentCorners(
  corners: CornerRadii,
  isFirst: boolean,
  isLast: boolean,
  clone: boolean,
  fragsAxisIsBlock: boolean,
): CornerRadii {
  if (clone) return corners;
  return fragsAxisIsBlock ? {
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
  };
}

/** Per-element invariants a wrapped-inline / multi-column block needs to paint
 *  each of its fragments (extracted from `renderInlineFragments`, DM-1458). */
interface InlineFragmentCtx {
  element: CapturedElement;
  clone: boolean;
  fragsAxisIsBlock: boolean;
  hasBgImage: boolean;
  shadows: ReturnType<typeof parseBoxShadow>;
  bgColor: { r: number; g: number; b: number; a: number } | null;
  sbt: ReturnType<typeof parseSide>;
  sbr: ReturnType<typeof parseSide>;
  sbb: ReturnType<typeof parseSide>;
  sbl: ReturnType<typeof parseSide>;
  bgImageLayers: string[];
  bgSizeLayers: string[];
  bgPosLayers: string[];
  bgRepeatLayers: string[];
  bgClipLayers: string[];
  bgOriginLayers: string[];
  bgBlendLayers: string[];
  bgSelectedImageLayers: Array<CapturedBackgroundImage | null>;
  bgIntrinsicLayers: Array<{ w: number; h: number } | null>;
  bgAttachmentLayers: string[];
}

/** Paint one inline/block fragment: outset shadow (clone), background color +
 *  image layers (clone), and the per-side borders with axis-aware edge
 *  suppression. Extracted from `renderInlineFragments`'s per-fragment loop
 *  (DM-1458); the body is unchanged, reading its inputs off `state` + `ctx`. */
function paintInlineFragment(
  state: RenderState,
  indent: string,
  f: NonNullable<CapturedElement["inlineFragments"]>[number],
  fragCorners: CornerRadii,
  isFirst: boolean,
  isLast: boolean,
  ctx: InlineFragmentCtx,
): void {
  const { paintCtx, defsParts, svgParts, captureViewport } = state;
  const {
    element, clone, fragsAxisIsBlock, hasBgImage, shadows, bgColor,
    sbt, sbr, sbb, sbl,
    bgImageLayers, bgSizeLayers, bgPosLayers, bgRepeatLayers, bgClipLayers,
    bgOriginLayers, bgBlendLayers,
    bgSelectedImageLayers, bgIntrinsicLayers, bgAttachmentLayers,
  } = ctx;

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
          const fid = paintCtx.nextClipId("sh");
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

    // DM-2365: clone positions each layer against the physical fragment and
    // therefore restarts its tile phase. Slice uses Blink's captured imaginary
    // unfragmented border box, then intersects the layer clip with this
    // physical fragment. Old captures have no stitched record and retain the
    // previous fail-closed behavior for slice images.
    const stitchedBorderBox = clone
      ? { x: f.x, y: f.y, width: f.width, height: f.height }
      : f.backgroundPositioningArea;
    if (hasBgImage && stitchedBorderBox != null) {
      const bwT = parseFloat(element.styles.borderTopWidth ?? "0") || 0;
      const bwR = parseFloat(element.styles.borderRightWidth ?? "0") || 0;
      const bwB = parseFloat(element.styles.borderBottomWidth ?? "0") || 0;
      const bwL = parseFloat(element.styles.borderLeftWidth ?? "0") || 0;
      const padT = parseFloat(element.styles.paddingTop ?? "0") || 0;
      const padR = parseFloat(element.styles.paddingRight ?? "0") || 0;
      const padB = parseFloat(element.styles.paddingBottom ?? "0") || 0;
      const padL = parseFloat(element.styles.paddingLeft ?? "0") || 0;
      const boxFor = (borderBox: { x: number; y: number; width: number; height: number }, key: string) => {
        const content = key === "content-box";
        const padding = content || key === "padding-box";
        const top = padding ? bwT + (content ? padT : 0) : 0;
        const right = padding ? bwR + (content ? padR : 0) : 0;
        const bottom = padding ? bwB + (content ? padB : 0) : 0;
        const left = padding ? bwL + (content ? padL : 0) : 0;
        return {
          x: borderBox.x + left,
          y: borderBox.y + top,
          width: Math.max(0, borderBox.width - left - right),
          height: Math.max(0, borderBox.height - top - bottom),
        };
      };
      const physicalFragment = { x: f.x, y: f.y, width: f.width, height: f.height };
      for (let li = bgImageLayers.length - 1; li >= 0; li--) {
        const layer = bgImageLayers[li].trim();
        const layerSize = cyclicBackgroundLayer(bgSizeLayers, li, "auto").trim();
        const layerPos = cyclicBackgroundLayer(bgPosLayers, li, "0% 0%").trim();
        const layerRepeat = cyclicBackgroundLayer(bgRepeatLayers, li, "repeat").trim();
        const layerClip = cyclicBackgroundLayer(bgClipLayers, li, "border-box").trim();
        const layerOrigin = cyclicBackgroundLayer(bgOriginLayers, li, "padding-box").trim();
        const layerBlend = cyclicBackgroundLayer(bgBlendLayers, li, "normal").trim();
        const selectedImage = bgSelectedImageLayers[li] ?? null;
        const layerIntrinsic = bgIntrinsicLayers[li] ?? null;
        const layerAttachment = cyclicBackgroundLayer(bgAttachmentLayers, li, "scroll").trim();
        if (layerClip === "text") continue;
        // A viewport-fixed layer ignores the imaginary decoration strip: Blink
        // positions it in the layout viewport and clips it to the current
        // physical fragment. A transformed/inert `fixed` layer resolves to
        // scroll and therefore continues through the stitched strip.
        const fixedToViewport = layerAttachment === "fixed"
          && element.styles.backgroundAttachmentGeometry?.source === "blink-box-background-paint-context-v1"
          && element.styles.backgroundAttachmentGeometry.fixedToViewport === true;
        const layerBorderBox = fixedToViewport ? physicalFragment : stitchedBorderBox;
        const originBox = boxFor(layerBorderBox, layerOrigin);
        const clipBox = boxFor(layerBorderBox, layerClip);
        const isUrlBacked = /^\s*(?:url\(|(?:-webkit-)?image-set\()/i.test(layer);
        const attachmentGeometry = isUrlBacked
          ? resolveBackgroundAttachment(
              layerAttachment,
              layerBorderBox,
              originBox,
              clipBox,
              element.styles.backgroundAttachmentGeometry,
              captureViewport,
            )
          : null;
        const positioningBox = attachmentGeometry?.positioningBox ?? originBox;
        const paintingBox = attachmentGeometry?.paintingBox ?? clipBox;
        const visiblePaintingBox = intersectBackgroundRects(physicalFragment, paintingBox);
        if (visiblePaintingBox.width <= 0 || visiblePaintingBox.height <= 0) continue;
        const defId = paintCtx.nextClipId("bgf");
        const out = buildBackgroundLayerDef(
          defId, layer,
          positioningBox.x, positioningBox.y, positioningBox.width, positioningBox.height,
          layerSize, layerPos, layerRepeat, layerIntrinsic,
          attachmentGeometry == null ? layerAttachment : "scroll",
          attachmentGeometry == null ? captureViewport : null,
          selectedImage,
          paintingBox,
        );
        if (out.def === "") continue;
        defsParts.push(out.def);
        const clipInsetTop = layerClip === "content-box" ? bwT + padT : layerClip === "padding-box" ? bwT : 0;
        const clipInsetRight = layerClip === "content-box" ? bwR + padR : layerClip === "padding-box" ? bwR : 0;
        const clipInsetBottom = layerClip === "content-box" ? bwB + padB : layerClip === "padding-box" ? bwB : 0;
        const clipInsetLeft = layerClip === "content-box" ? bwL + padL : layerClip === "padding-box" ? bwL : 0;
        const clipCorners = layerClip === "border-box"
          ? fragCorners
          : insetCornerRadii(fragCorners, clipInsetTop, clipInsetRight, clipInsetBottom, clipInsetLeft);
        const blendAttr = layerBlend !== "" && layerBlend !== "normal"
          ? ` style="mix-blend-mode:${layerBlend}"`
          : "";
        svgParts.push(
          `${indent}${roundedRectSvg(
            visiblePaintingBox.x,
            visiblePaintingBox.y,
            visiblePaintingBox.width,
            visiblePaintingBox.height,
            clipCorners,
            `fill="url(#${defId})"${blendAttr}`,
          )}`,
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

function renderInlineFragments(
  state: RenderState,
  el: CapturedElement,
  indent: string,
  bgColor: { r: number; g: number; b: number; a: number } | null,
  corners: CornerRadii,
): void {
  const { paintCtx, defsParts, svgParts, captureViewport } = state;
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
  const bgBlendLayers = splitTopLevelCommas(el.styles.backgroundBlendMode ?? "normal");
  const bgAttachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
  const bgSelectedImageLayers = el.styles.backgroundImages ?? [];
  const bgIntrinsicLayers = el.styles.backgroundIntrinsic ?? [];

  const fragmentCtx: InlineFragmentCtx = {
    element: el, clone, fragsAxisIsBlock, hasBgImage, shadows, bgColor,
    sbt, sbr, sbb, sbl,
    bgImageLayers, bgSizeLayers, bgPosLayers, bgRepeatLayers, bgClipLayers,
    bgOriginLayers, bgBlendLayers,
    bgSelectedImageLayers, bgIntrinsicLayers, bgAttachmentLayers,
  };
  for (let fi = 0; fi < frags.length; fi++) {
    const f = frags[fi];
    const isFirst = fi === 0;
    const isLast = fi === frags.length - 1;
    const fragCorners = deriveFragmentCorners(corners, isFirst, isLast, clone, fragsAxisIsBlock);
    paintInlineFragment(state, indent, f, fragCorners, isFirst, isLast, fragmentCtx);
  }
}

function resolveOverflowClipId(state: RenderState, el: CapturedElement, corners: CornerRadii): string | null {
  const { paintCtx, defsParts } = state;
  let clipPathUrlId: string | null = null;
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
      // DM-2419: Blink starts at its pixel-snapped contoured inner border,
      // applies the selected reference-box as PHYSICAL per-side outsets, then
      // applies the margin. Keep enough rectangular room in this renderer's
      // synthetic outer wrapper for that exact corrected inner contour. The
      // tight rounded shape is emitted by ensureChildOverflowClipId (or the
      // replaced-image paint path) below.
      const ocmGeometry = resolvedOverflowClipMarginGeometry(el, corners);
      const ocmExtension = ocmGeometry == null
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : overflowClipMarginOuterExtension(
            { x: el.x, y: el.y, width: el.width, height: el.height },
            ocmGeometry,
          );
      // DM-1264: a <fieldset>'s rendered <legend> is part of the block-start
      // BORDER, not the scrollport — per Blink `fieldset_layout_algorithm.cc`:
      // "the rendered legend shouldn't be part of the scrollport; the legend is
      // essentially a part of the block-start border ... scrollbars are handled by
      // the anonymous child box." So the fieldset's own `overflow` clip (which we
      // bind to its border box) must NOT cut the legend, which straddles the
      // border line and protrudes above the border-box top. Raise the clip's top
      // edge by the legend's protrusion so it clears the legend (the block-start
      // border strip holds nothing else). Without this, `fieldset { overflow:
      // auto }` (resize needs overflow != visible) clipped the top half of the
      // legend text.
      const legendInflateT = el.fieldsetLegendNotch != null
        ? Math.max(0, el.y - el.fieldsetLegendNotch.y)
        : 0;
      const inflateT = Math.max(outlineInflate, shadowInflateT, ocmExtension.top, legendInflateT);
      const inflateR = Math.max(outlineInflate, shadowInflateR, ocmExtension.right);
      const inflateB = Math.max(outlineInflate, shadowInflateB, ocmExtension.bottom);
      const inflateL = Math.max(outlineInflate, shadowInflateL, ocmExtension.left);
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
      clipPathUrlId = paintCtx.nextClipId("cp");
      defsParts.push(
        `<clipPath id="${clipPathUrlId}"><rect x="${r(cpX)}" y="${r(cpY)}" width="${r(cpW)}" height="${r(cpH)}"/></clipPath>`,
      );
    }
  return clipPathUrlId;
}


/**
 * True when an intra-frame animation targeting this element's `animId`
 * animates `opacity` (per the `annotateAnimatedProperties` tree-ops pass run
 * between capture and render). The animation then OWNS the opacity channel:
 * the captured opacity must not be baked onto the wrapper `<g>` (SVG group
 * opacity composes multiplicatively, so a baked 0.2 would cap an animated
 * 0.2→1 fade at 0.2 forever), and an `opacity: 0` element must still emit its
 * markup (a dropped element leaves nothing in the SVG to fade in). The
 * animation's keyframes carry the visible opacity instead — authors keep the
 * rest state faithful to the capture by setting `from` to the captured value.
 */
function animationOwnsOpacity(el: CapturedElement): boolean {
  return el.animId != null && el.animId !== ""
    && el.animatedProperties != null && el.animatedProperties.includes("opacity");
}

interface BoxReflectionSpec {
  direction: "above" | "below" | "left" | "right";
  offset: number;
  maskImage?: string;
}

/** Parse Chromium's computed `-webkit-box-reflect` serialization. */
export function parseBoxReflection(value: string | undefined, width: number, height: number): BoxReflectionSpec | null {
  if (value == null || value === "" || value === "none") return null;
  const head = /^\s*(above|below|left|right)\s+([^\s]+)(?:\s+([\s\S]+))?$/i.exec(value);
  if (head == null) return null;
  const direction = head[1].toLowerCase() as BoxReflectionSpec["direction"];
  const basis = direction === "above" || direction === "below" ? height : width;
  const rawOffset = head[2];
  const n = parseFloat(rawOffset);
  const offset = Number.isFinite(n) ? (/\%$/.test(rawOffset) ? n * basis / 100 : n) : 0;
  let maskImage: string | undefined;
  const tail = head[3]?.trim();
  if (tail != null && tail !== "" && tail !== "none") {
    const fn = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(|^url\(/i.exec(tail);
    if (fn != null) {
      let depth = 0;
      let quote = "";
      for (let i = fn[0].length - 1; i < tail.length; i++) {
        const ch = tail[i];
        if (quote !== "") { if (ch === quote && tail[i - 1] !== "\\") quote = ""; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) { maskImage = tail.slice(0, i + 1); break; }
      }
    }
  }
  return { direction, offset, maskImage };
}

function appendBoxReflection(state: RenderState, el: CapturedElement, fragmentStart: number, depth: number): void {
  const spec = parseBoxReflection(el.styles.webkitBoxReflect, el.width, el.height);
  if (spec == null || state.svgParts.length === fragmentStart) return;
  const source = state.svgParts.slice(fragmentStart).join("\n");
  const transform = boxReflectionTransform(spec, el.x, el.y, el.width, el.height);

  let reflected = source;
  if (spec.maskImage != null) {
    const maskId = state.paintCtx.nextClipId("reflect-mask");
    const fillId = state.paintCtx.nextClipId("reflect-fill");
    const built = buildBackgroundLayerDef(fillId, spec.maskImage, el.x, el.y, el.width, el.height, "100% 100%", "0% 0%", "no-repeat");
    if (built.def !== "") {
      state.defsParts.push(built.def);
      state.defsParts.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" style="mask-type:alpha"><rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" fill="url(#${fillId})"/></mask>`);
      reflected = `<g mask="url(#${maskId})">${source}</g>`;
    }
  }
  const indent = "  ".repeat(depth);
  const markup = `${indent}<g transform="${transform}" aria-hidden="true">${reflected}</g>`;
  // Blink's FEBoxReflect composites SourceGraphic over the reflected image.
  // Insert the copy first so negative offsets cannot make it cover the source.
  state.svgParts.splice(fragmentStart, 0, markup);
}

export function boxReflectionTransform(spec: BoxReflectionSpec, x: number, y: number, width: number, height: number): string {
  if (spec.direction === "below") return `matrix(1 0 0 -1 0 ${r(2 * (y + height) + spec.offset)})`;
  if (spec.direction === "above") return `matrix(1 0 0 -1 0 ${r(2 * y - spec.offset)})`;
  if (spec.direction === "right") return `matrix(-1 0 0 1 ${r(2 * (x + width) + spec.offset)} 0)`;
  return `matrix(-1 0 0 1 ${r(2 * x - spec.offset)} 0)`;
}


function computeGroupWrapperAttrs(
  el: CapturedElement,
  clipPathUrlId: string | null,
  maskUrlId: string | null,
  opacity: number,
  filterCss: string,
  blendCss: string,
): { needsGroup: boolean; groupAttrs: string[]; animClass: string; needsFilterOuter: boolean; localizeReferenceFilter: boolean; hasTransform: boolean } {
  const projective = el.projectiveTransform;
  const hasProjectiveTransform = projective != null;
  const transformAttr = hasProjectiveTransform
    ? `matrix(${projective[0]} ${projective[3]} ${projective[1]} ${projective[4]} ${projective[2]} ${projective[5]})`
    : svgTransformForElement(el);
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
  // since that's where `style="display:none"` / `class="cull-*"` lives.
  const needsCullWrapper = el.displayNone === true || (el.cullClass != null && el.cullClass !== "");
  // When an intra-frame animation owns the opacity channel (see
  // animationOwnsOpacity), the captured opacity is NOT baked onto the wrapper
  // — the animation's keyframes are the single opacity source, so a fade can
  // brighten past the captured value instead of multiplying against it.
  const bakeOpacity = opacity < 1 && !animationOwnsOpacity(el);
  const needsGroup = bakeOpacity || filterCss !== "" || blendCss !== "" || clipPathUrlId != null || maskUrlId != null || transformAttr !== "" || hasProjectiveTransform || needsIsolation || needsCullWrapper;
  const groupAttrs: string[] = [];
  if (transformAttr !== "") groupAttrs.push(`transform="${transformAttr}"`);
  if (bakeOpacity) groupAttrs.push(`opacity="${r(opacity)}"`);
  if (clipPathUrlId != null) groupAttrs.push(`clip-path="url(#${clipPathUrlId})"`);
  if (maskUrlId != null) groupAttrs.push(`mask="url(#${maskUrlId})"`);
  // animId (DM-209): elements tagged with `data-domotion-anim="<id>"` in the
  // source DOM get a `class="anim-<id>"` on an extra inner `<g>` wrapper so
  // the animator can target them via CSS keyframes for intra-frame motion.
  // The class lives on a SEPARATE wrapper from any merger-added visibility
  // class (which gets applied to the outer group) so the two `animation`
  // declarations don't clobber each other.
  const animClass = el.animId != null && el.animId !== "" ? `anim-${el.animId}` : "";
  // DM-603: viewBox-cull class (`cull-<start>-<end>`) goes on the OUTER group so it
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
  // Chromium builds CSS URL-reference filters on HTML elements against a
  // reference box whose origin is local to the filtered element. An SVG <g>,
  // however, exposes its root-space bbox to userSpaceOnUse primitives. That
  // difference is visible with coordinate-sensitive primitives such as
  // feTurbulence/feDisplacementMap. Put reference filters on a translated
  // outer wrapper and counter-translate their content so the filter sees the
  // same local coordinate space while the result stays at its page position.
  const localizeReferenceFilter = /\burl\(\s*(?:["']?)#/i.test(filterCss);
  const needsFilterOuter = filterCss !== "" && (localizeReferenceFilter || clipPathUrlId != null || maskUrlId != null);
  const styleParts: string[] = [];
  if (filterCss !== "" && !needsFilterOuter) styleParts.push(`filter:${filterCss}`);
  if (blendCss !== "") styleParts.push(`mix-blend-mode:${blendCss}`);
  if (needsIsolation) styleParts.push("isolation:isolate");
  if (el.displayNone === true) styleParts.push("display:none");
  // DM-486: HTML-escape the style attribute value. Chromium normalises
  // `filter: url(#id)` to `url("#id")` (with quotes) — emitting that raw
  // produced `style="filter:url("#id")"` and broke the SVG parser.
  if (styleParts.length > 0) groupAttrs.push(`style="${esc(styleParts.join(";"))}"`);
  return { needsGroup, groupAttrs, animClass, needsFilterOuter, localizeReferenceFilter, hasTransform: transformAttr !== "" || hasProjectiveTransform };
}

/**
 * Atomic Chromium surfaces return before the ordinary element wrapper path,
 * but they still belong to the generated element's cull and animation
 * wrappers. Keep those two timeline owners in the same outer→inner order as
 * vector content without reapplying static/filter state already baked into
 * the screenshot.
 */
function wrapAtomicRasterTimeline(el: CapturedElement, markup: string): string {
  let result = markup;
  if (el.animId != null && el.animId !== "") {
    result = `<g class="anim-${esc(el.animId)}">${result}</g>`;
  }
  const attrs: string[] = [];
  if (el.cullClass != null && el.cullClass !== "") attrs.push(`class="${esc(el.cullClass)}"`);
  if (el.displayNone === true) attrs.push('style="display:none"');
  return attrs.length === 0 ? result : `<g ${attrs.join(" ")}>${result}</g>`;
}


/**
 * Bucket `el`'s children by CSS 2.1 Appendix E paint step, resolved ONCE per
 * element and memoized: `gatherStackingContextChildren` records every
 * descendant it hoists in the shared `hoistedFromAncestor` set and skips
 * already-hoisted elements, so a second call for the same element would return
 * a shorter list. The two-phase walk visits each element twice, so the result
 * has to be cached rather than recomputed.
 */
function resolveChildPlan(
  state: RenderState,
  el: CapturedElement,
  parentDisplayForEl: string | undefined,
): ChildPaintPlan {
  const cached = state.childPlans.get(el);
  if (cached != null) return cached;
  const { hoistedFromAncestor, overflowClipForHoisted } = state;
  let childrenForSort: CapturedElement[];
  // DM-525: pass `el.styles.display` to flex/grid-aware checks so direct
  // children that are flex/grid items honor z-index ≠ auto as a stacking
  // context creator and z-sort accordingly.
  const childDisplay = el.styles.display;
  const hoistedAsInlineForEl = new Set<CapturedElement>();
  const hoistedAsZSortedForEl = new Set<CapturedElement>();
  if (establishesStackingContext(el, parentDisplayForEl)) {
    childrenForSort = gatherStackingContextChildren(el.children, hoistedFromAncestor, childDisplay, hoistedAsInlineForEl, overflowClipForHoisted, hoistedAsZSortedForEl);
  } else {
    childrenForSort = el.children.filter((c) => !hoistedFromAncestor.has(c));
  }
  // DM-1052: pass the SC root's actual direct children so a flex/grid
  // `order` / `*-reverse` reorder of a flattened paint list keeps each
  // hoisted descendant grouped with (and painting after) its direct-item
  // ancestor instead of being reversed ahead of it.
  const buckets = paintOrderBuckets(childrenForSort, childDisplay, el.styles.flexDirection, hoistedAsInlineForEl, hoistedAsZSortedForEl, new Set(el.children));
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
  //
  // The translateZ sort spans every paint-step bucket, so a 3D context can't
  // also run the block/inline phase split — it renders the flat list, each
  // child atomically, in Z order.
  let flat3d: CapturedElement[] | null = null;
  if (el.styles.transformStyle === "preserve-3d") {
    const zOf = (c: CapturedElement) => c.styles.translateZ ?? 0;
    flat3d = [...buckets.negative, ...buckets.base, ...buckets.floats, ...buckets.inlines, ...buckets.zeroOrAuto, ...buckets.positive]
      .map((c, idx) => ({ c, idx, z: zOf(c) }))
      .sort((a, b) => a.z - b.z || a.idx - b.idx)
      .map((x) => x.c);
  }
  const plan: ChildPaintPlan = { buckets, childDisplay, flat3d };
  state.childPlans.set(el, plan);
  return plan;
}

/**
 * Does this child paint as ONE atomic unit inside its parent's inline phase,
 * rather than being split across the parent's two phases?
 *
 * Inline-level boxes and flex/grid items qualify — CSS 2.1 Appendix E step 5
 * paints them "as if the element created a new stacking context", so their
 * background, border and content stay together. Block-level boxes are the ones
 * that split: background + border at step 3, content at step 5.
 *
 * Shares one predicate with the float hoist (`paintsAtomicallyAsInlineBox`), so
 * the box that keeps its floats is exactly the box that paints atomically.
 */
function paintsAtomicallyInInlinePhase(c: CapturedElement, parentDisplay: string | undefined): boolean {
  return paintsAtomicallyAsInlineBox(c, parentDisplay);
}

/**
 * Emit the box half of `el`'s children: negative-z stacking contexts (step 2),
 * every in-flow block-level child's box decorations (step 3, recursive), then
 * the context's non-positioned floats (step 4, each atomic).
 */
function renderChildBoxPhase(state: RenderState, plan: ChildPaintPlan, depth: number): void {
  const { buckets, childDisplay } = plan;
  for (const c of buckets.negative) {
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay);
  }
  for (const c of buckets.base) {
    if (paintsAtomicallyInInlinePhase(c, childDisplay)) continue;
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay, "box");
  }
  for (const c of buckets.floats) {
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay);
  }
}

/** Does the box phase of these children emit anything at all? */
function childBoxPhaseIsEmpty(plan: ChildPaintPlan): boolean {
  const { buckets } = plan;
  if (buckets.negative.length > 0 || buckets.floats.length > 0) return false;
  return !buckets.base.some((c) => !paintsAtomicallyInInlinePhase(c, plan.childDisplay));
}

/**
 * Emit the inline half of `el`'s children: every in-flow child's inline
 * content in document order (step 5 — block-level children recurse in the
 * inline phase, inline-level children paint atomically), then the flex/grid
 * items that paint as inline blocks (step 5), then the positioned and
 * stacking-context children (steps 6 and 7).
 */
function renderChildInlinePhase(state: RenderState, plan: ChildPaintPlan, depth: number): void {
  const { buckets, childDisplay } = plan;
  for (const c of buckets.base) {
    const phase: PaintPhase = paintsAtomicallyInInlinePhase(c, childDisplay) ? "all" : "inline";
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay, phase);
  }
  for (const c of buckets.inlines) {
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay);
  }
  for (const c of buckets.zeroOrAuto) {
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay);
  }
  for (const c of buckets.positive) {
    renderElementWithOverflowClip(state, c, depth + 1, childDisplay);
  }
}

/** Does the inline phase of these children emit anything at all? */
function childInlinePhaseIsEmpty(plan: ChildPaintPlan): boolean {
  const { buckets } = plan;
  return buckets.base.length === 0 && buckets.inlines.length === 0
    && buckets.zeroOrAuto.length === 0 && buckets.positive.length === 0;
}


/**
 * Resolve the element's effective clip-path id (extracted from `renderElement`,
 * DM-1458). Priority: a translated CSS `clip-path` shape → an inline `<clipPath>`
 * fragment ref (`clip-path: url(#id)`) → otherwise the overflow clip. Per CSS
 * Masking §5.1 a CSS clip-path replaces overflow clipping, so the overflow clip
 * is only consulted when no clip-path applies. Returns the id to reference (the
 * def is pushed into `<defs>` as a side effect) or null.
 *
 * CSS clip-path can't be passed through verbatim: it's authored in the element's
 * local coord space while our `<g>` paints in absolute viewport coords, so the
 * shape is translated + anchored at the element's (x, y). The optional
 * `<geometry-box>` keyword (DM-818) is handled inside `clipPathShapeForElement`.
 */
function resolveClipPath(state: RenderState, el: CapturedElement, corners: CornerRadii): string | null {
  const { paintCtx, defsParts } = state;
  const clipPathCss = el.styles.clipPath && el.styles.clipPath !== "none" ? el.styles.clipPath : "";
  let clipPathUrlId: string | null = null;
  if (clipPathCss !== "") {
    const shape = clipPathShapeForElement(el, clipPathCss);
    if (shape !== "") {
      clipPathUrlId = paintCtx.nextClipId("cp");
      defsParts.push(`<clipPath id="${clipPathUrlId}">${shape}</clipPath>`);
    } else {
      // DM-826: shape translator returned "" — try the inline-`<clipPath>`
      // fragment-ref path (`clip-path: url(#id)` against the captured
      // `clipPathDefs`). See docs/39.
      const fragId = resolveFragmentClipPathRef(state, clipPathCss, el.x, el.y);
      if (fragId != null) clipPathUrlId = fragId;
    }
  }
  // DM-587: overflow != visible clips painted descendants at the element's box;
  // clip-path takes priority when both are present (CSS Masking §5.1).
  if (clipPathUrlId == null) clipPathUrlId = resolveOverflowClipId(state, el, corners);
  return clipPathUrlId;
}

/**
 * `resolveClipPath` memoized per element — it mints a `<clipPath>` def and
 * consumes a positional id, so an element painted in both the box and the
 * inline phase must resolve it once and reference the same id twice.
 */
function resolveClipPathOnce(state: RenderState, el: CapturedElement, corners: CornerRadii): string | null {
  const cached = state.elementClipPathIds.get(el);
  if (cached !== undefined) return cached;
  const id = resolveClipPath(state, el, corners);
  state.elementClipPathIds.set(el, id);
  return id;
}

/**
 * Paint one explicit source-owned pseudo slot.  Background paint-server ids
 * remain allocated by the main renderer, but all geometry comes from the
 * retained pseudo fragment record rather than the host box/text segments.
 */
function paintCapturedPseudoFragments(
  state: RenderState,
  el: CapturedElement,
  indent: string,
  slot: PseudoFragmentPaintSlot,
): void {
  const { paintCtx, defsParts, svgParts, captureViewport } = state;
  svgParts.push(...renderPseudoFragmentSlot(el, slot, {
    indent,
    emittedCtm: paintCtx.emittedTextCtm.get(el),
    imageHref: (url, width, height) => embedResizedDataUri(url, width, height),
    emitBackgroundImage: ({ record, rect, borderRadius }) => {
      const layers = splitTopLevelCommas(record.paint.backgroundImage);
      const sizes = splitTopLevelCommas(record.paint.backgroundSize);
      const positions = splitTopLevelCommas(record.paint.backgroundPosition);
      const repeats = splitTopLevelCommas(record.paint.backgroundRepeat);
      const markup: string[] = [];
      for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex--) {
        const id = paintCtx.nextClipId("pfbg");
        const out = buildBackgroundLayerDef(
          id,
          layers[layerIndex].trim(),
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          cyclicBackgroundLayer(sizes, layerIndex, "auto").trim(),
          cyclicBackgroundLayer(positions, layerIndex, "0% 0%").trim(),
          cyclicBackgroundLayer(repeats, layerIndex, "repeat").trim(),
          null,
          "scroll",
          captureViewport,
        );
        if (out.def === "") continue;
        defsParts.push(out.def);
        const radius = borderRadius > 0 ? ` rx="${r(borderRadius)}" ry="${r(borderRadius)}"` : "";
        markup.push(`<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}"${radius} fill="url(#${id})"/>`);
      }
      return markup.join("");
    },
  }));
}

/** `renderMaskPhase` memoized per element — see `resolveClipPathOnce`. */
function renderMaskPhaseOnce(state: RenderState, el: CapturedElement): string | null {
  const cached = state.elementMaskIds.get(el);
  if (cached !== undefined) return cached;
  const id = renderMaskPhase(state, el);
  state.elementMaskIds.set(el, id);
  return id;
}

/**
 * Paint an element's box-only pseudo-elements (`::before` / `::after` with no
 * text content but borders / background / a CSS-triangle / a transform — DM-579).
 * Extracted from `renderElement` (DM-1458).
 *
 * `select` picks which of the three paint positions this call emits:
 *   - `"behind"` — a negative-z pseudo box. It is a negative stacking context
 *     of the host, so it paints in the box phase, before any descendant's
 *     background (CSS 2.1 Appendix E step 2).
 *   - `"inline"` — everything else, in inline paint position (step 5).
 * A fade-overlay `::after` (gradient bg, no own color/border, non-negative z)
 * belongs to neither: the caller defers it to after child recursion so it wins
 * z over child text (`paintDeferredFadeOverlays`).
 */
function paintPseudoBoxes(state: RenderState, el: CapturedElement, indent: string, select: "behind" | "inline" = "inline"): void {
  const { paintCtx, defsParts, svgParts, captureViewport } = state;
  if (el.pseudoBoxes != null) {
    for (const pb of el.pseudoBoxes) {
      // DM-1051: a NEGATIVE z-index pseudo box paints BEHIND the host's
      // content — Resend's `.rainbow-border::after` glow is `z-index: -10;
      // filter: blur(20px)`, a soft halo behind the dark pill. It is emitted
      // in the box phase so it lands under every descendant background, not
      // just under the host's own text.
      const paintsBehind = pb.zIndex != null && pb.zIndex < 0;
      if (paintsBehind !== (select === "behind")) continue;
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
      if (pb.pseudo === "::after" && select === "inline") {
        const hasBgImage = pb.backgroundImage != null && pb.backgroundImage !== "none" && pb.backgroundImage !== "";
        const hasBgColor = pb.backgroundColor != null && pb.backgroundColor !== "" && pb.backgroundColor !== "rgba(0, 0, 0, 0)";
        const hasBorder = (pb.borderTopWidth ?? 0) > 0
          || (pb.borderRightWidth ?? 0) > 0
          || (pb.borderBottomWidth ?? 0) > 0
          || (pb.borderLeftWidth ?? 0) > 0;
        // A negative-z gradient `::after` is NOT a fade overlay (it already
        // took the `"behind"` path above), so only the auto / non-negative
        // ones defer to the on-top pass.
        if (hasBgImage && !hasBgColor && !hasBorder) continue;
      }
      // Snapshot svgParts.length so the complete pseudo paint can be wrapped
      // in its Blink-owned filter / transform / opacity effect nodes.
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
          const defId = paintCtx.nextClipId("pbg");
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
      // Wrap whatever this iteration emitted (rect / lines / polygon /
      // per-side strokes) as one generated-content paint atom.
      function flushPbTransformWrap() {
        const hasFilter = pb.filter != null && pb.filter.trim() !== "" && pb.filter.trim() !== "none";
        const hasTransform = pb.transform != null && pb.transform.trim() !== "" && pb.transform.trim() !== "none";
        const hasOpacity = pb.opacity != null && pb.opacity < 1;
        if (!hasFilter && !hasTransform && !hasOpacity) return;
        const added = svgParts.splice(pbStart);
        if (added.length === 0) return;
        const inner = added.map((s) => s.startsWith(indent) ? s.slice(indent.length) : s).join("");
        svgParts.push(`${indent}${wrapPseudoPaintEffects(pb, inner)}`);
      }
      flushPbTransformWrap();
    }
  }
}

/**
 * Emit the DEFERRED fade-overlay `::after` pseudo-boxes (DM-1001) AFTER child
 * recursion, so a right-edge gradient mask wins z over the child text it fades.
 * Extracted from `renderElement` (DM-1458). Only `::after` boxes with a
 * background-image, no own color/border, and a non-negative z-index defer here;
 * everything else already painted inline via `paintPseudoBoxes`. Body unchanged.
 */
function paintDeferredFadeOverlays(state: RenderState, el: CapturedElement, indent: string): void {
  const { paintCtx, defsParts, svgParts, captureViewport } = state;
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
      const pbEffectStart = svgParts.length;
      const pbLayers = splitTopLevelCommas(pb.backgroundImage!);
      for (let li = pbLayers.length - 1; li >= 0; li--) {
        const layer = pbLayers[li].trim();
        const defId = paintCtx.nextClipId("pbg");
        const out = buildBackgroundLayerDef(
          defId, layer, pb.x, pb.y, pb.width, pb.height,
          pb.backgroundSize ?? "auto", pb.backgroundPosition ?? "0% 0%", "repeat", null, "scroll", captureViewport,
        );
        if (out.def === "") continue;
        defsParts.push(out.def);
        const rxAttr = pb.borderRadius && pb.borderRadius > 0 ? ` rx="${r(pb.borderRadius)}"` : "";
        svgParts.push(`${indent}<rect x="${r(pb.x)}" y="${r(pb.y)}" width="${r(pb.width)}" height="${r(pb.height)}"${rxAttr} fill="url(#${defId})" />`);
      }
      const added = svgParts.splice(pbEffectStart);
      if (added.length > 0) {
        const inner = added.map((s) => s.startsWith(indent) ? s.slice(indent.length) : s).join("");
        svgParts.push(`${indent}${wrapPseudoPaintEffects(pb, inner)}`);
      }
    }
  }
}

/**
 * Open the `<g clip-path>` that clips `el`'s children to its overflow region,
 * returning the clip-path id (caller closes the group) or null when the
 * element doesn't clip.
 *
 * Split out of `renderElement` for the block/inline phase split: a clipped
 * element emits its children in BOTH phases, so each pass opens its own group
 * around its own half of the child paint, referencing the one def that
 * `ensureChildOverflowClipId` minted.
 */
function openChildOverflowClip(
  state: RenderState,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
): string | null {
  const id = ensureChildOverflowClipId(state, el, corners);
  if (id != null) state.svgParts.push(`${indent}<g clip-path="url(#${id})">`);
  return id;
}

/**
 * Mint (once) the `<clipPath>` that clips `el`'s children to its overflow
 * region, and return its id — or null when the element doesn't clip.
 *
 * Registration is deliberately independent of whether any group is actually
 * opened around it: `overflowClipPathIds` is both this function's memo and the
 * lookup a HOISTED descendant uses to re-apply the clip it escaped (DM-673).
 * A scroller whose every child was hoisted away emits no group of its own, yet
 * those children still need its id.
 */
function ensureChildOverflowClipId(
  state: RenderState,
  el: CapturedElement,
  corners: ReturnType<typeof parseCornerRadii>,
): string | null {
  const { defsParts, paintCtx, overflowClipPathIds } = state;
  const memoized = overflowClipPathIds.get(el);
  if (memoized != null) return memoized;
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
    overflowClipId = paintCtx.nextClipId("ov");
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
    let overflowCorners = insetCornerRadii(corners, cbt, cbr, cbb, cbl);
    // Default clip = padding box (border-inset). DM-2419: for an active
    // overflow-clip-margin, Blink instead starts from a PIXEL-SNAPPED inner
    // border, applies the physical reference-box/margin outsets, and grows or
    // contracts every corner with FloatRoundedRect's coverage correction.
    // Reference-box-only zero values remain active; a negative CSS length is
    // invalid and never reaches this branch.
    let ocX = el.x + cbl;
    let ocY = el.y + cbt;
    let ocW = Math.max(0, el.width - cbl - cbr);
    let ocH = Math.max(0, el.height - cbt - cbb);
    const ocmGeometry = resolvedOverflowClipMarginGeometry(el, corners);
    if (ocmGeometry != null) {
      ocX = ocmGeometry.x;
      ocY = ocmGeometry.y;
      ocW = ocmGeometry.width;
      ocH = ocmGeometry.height;
      overflowCorners = ocmGeometry.corners;
    }
    // DM-1264: a <fieldset>'s rendered <legend> is part of the block-start BORDER,
    // not the scrollport — per Blink `fieldset_layout_algorithm.cc`: "the rendered
    // legend shouldn't be part of the scrollport; the legend is essentially a part
    // of the block-start border ... scrollbars are handled by the anonymous child
    // box." So a `fieldset { overflow: auto }` (resize needs overflow != visible)
    // must NOT clip the legend, which straddles the border line and protrudes above
    // the padding box. Raise the clip's top edge to clear the legend (the block-
    // start border strip holds nothing else that could leak out).
    if (el.fieldsetLegendNotch != null) {
      const protrude = ocY - el.fieldsetLegendNotch.y;
      if (protrude > 0) { ocY -= protrude; ocH += protrude; }
    }
    // DM-787: CSS Overflow 3 allows mixing `overflow-x: clip; overflow-y:
    // visible` (only `clip` permits this — `hidden + visible` coerces to
    // `auto + hidden`). Chrome clips only the clipped axis; content can
    // still escape on the visible axis. The SVG clipPath is a single rect,
    // so to NOT clip on an axis we extend that axis past any plausible
    // paint area with `±UNBOUNDED`. Such a one-axis combination is also an
    // explicit negative activation control for overflow-clip-margin.
    const UNBOUNDED = 100000;
    // Paint containment supplies its own both-axis overflow clip edge, so an
    // authored visible axis does not punch through that containment clip.
    const xVisible = !containClips && ox === "visible" && oy === "clip";
    const yVisible = !containClips && oy === "visible" && ox === "clip";
    if (xVisible) {
      ocX = el.x - UNBOUNDED;
      ocW = el.width + UNBOUNDED * 2;
    }
    if (yVisible) {
      ocY = el.y - UNBOUNDED;
      ocH = el.height + UNBOUNDED * 2;
    }
    defsParts.push(`<clipPath id="${overflowClipId}">${roundedRectSvg(ocX, ocY, ocW, ocH, overflowCorners, "")}</clipPath>`);
    // DM-673: stash the clip-path id so hoisted descendants of this
    // overflow scroller can re-wrap their emission in the same clip.
    overflowClipPathIds.set(el, overflowClipId);
  }
  return overflowClipId;
}

function renderElement(state: RenderState, el: CapturedElement, depth: number, parentDisplayForEl?: string, phase: PaintPhase = "all"): void {
  const {
    svgParts, defsParts, paintCtx, defCtx, captureViewport, width, height,
    overflowClipPathIds, offGridCollapsedCells,
  } = state;
  const reflectionFragmentStart = svgParts.length;
  // CSS 2.1 Appendix E splits an element's paint between two context-wide
  // passes: box decorations at step 3, inline content at step 5, with the
  // stacking context's floats (step 4) in between. See `PaintPhase`.
  let paintBoxPhase = phase !== "inline";
  const paintInlinePhase = phase !== "box";
  const indent = "  ".repeat(depth);
  const bgColor = parseColor(el.styles.backgroundColor);
  const textColor = parseColor(el.styles.color);
  const borderColor = parseColor(el.styles.borderColor);
  const borderWidth = parseFloat(el.styles.borderWidth) || 0;
  // Blink's table layout fragment is a wrapper around both captions and the
  // actual table grid. TablePainter passes the caption-excluding
  // TableGridRect to box-decoration painting, while layout/children/outline
  // continue to use the wrapper fragment. Keep those two ownership boxes
  // distinct instead of shrinking the captured element itself.
  const tableGridRect = el.styles.tableGridRect;
  const boxPaintEl: CapturedElement = tableGridRect == null ? el : {
    ...el,
    x: tableGridRect.x,
    y: tableGridRect.y,
    width: tableGridRect.width,
    height: tableGridRect.height,
  };
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
  const boxPaintCorners = tableGridRect == null
    ? corners
    : parseCornerRadii(el.styles, boxPaintEl.width, boxPaintEl.height);
  const _rawBorderRadius = parseFloat(el.styles.borderTopLeftRadius ?? el.styles.borderRadius ?? "0") || 0;
  const borderRadius = Math.min(_rawBorderRadius, el.width / 2, el.height / 2);
  const opacity = parseFloat(el.styles.opacity);

  // `opacity: 0` elements normally emit nothing (a real size win — an
  // invisible subtree is dead markup). EXCEPT when an intra-frame animation
  // owns the opacity channel: a fade-in needs the markup to exist, with the
  // animation's keyframes (holding `from`, typically the captured 0) keeping
  // it invisible at rest instead of a baked zero-opacity wrapper pinning it.
  if (opacity === 0 && !animationOwnsOpacity(el)) return;
  if (el.projectiveHidden === true) return;
  // DM-2415: feConvolveMatrix consumes Blink's raster SourceGraphic in layer
  // coordinates. The post-capture pass owns the complete filtered HTML
  // surface, including filter-region crop, edgeMode, divisor/bias, target,
  // preserveAlpha, clip/mask ordering, zoom, and the element's transform.
  // Emit it atomically and suppress the reconstructed subtree/filter wrapper.
  const urlFilterRaster = el.urlFilterRaster;
  if (urlFilterRaster?.empty === true) return;
  if (urlFilterRaster?.dataUri != null) {
    const image = `<image href="${urlFilterRaster.dataUri}" x="${r(urlFilterRaster.x)}" y="${r(urlFilterRaster.y)}" width="${r(urlFilterRaster.width)}" height="${r(urlFilterRaster.height)}" preserveAspectRatio="none"/>`;
    svgParts.push(`${indent}${wrapAtomicRasterTimeline(el, image)}`);
    appendBoxReflection(state, el, reflectionFragmentStart, depth);
    return;
  }
  // DM-2150: CSS preserve-3d/perspective is projective, while an SVG
  // `transform` attribute is strictly affine. The capture pipeline therefore
  // snapshots a complete 3D rendering context after Chromium composites it.
  // Emit that bitmap once at the context root and suppress the flattened box,
  // text, and descendants that would otherwise double-paint beneath it.
  const transformRaster = el.transformSubtreeRaster;
  // A promoted inline-SVG root can be an ordinary in-flow block, so Appendix E
  // visits it once for box decorations and again for inline/replaced content.
  // The Chromium surface is atomic and belongs at the clone's content paint
  // position; emitting it in the box pass too duplicates the same bitmap.
  if (transformRaster != null && phase === "box") return;
  if (transformRaster?.empty === true) return;
  if (transformRaster?.dataUri != null) {
    const image = `<image href="${transformRaster.dataUri}" x="${r(transformRaster.x)}" y="${r(transformRaster.y)}" width="${r(transformRaster.width)}" height="${r(transformRaster.height)}" preserveAspectRatio="none"/>`;
    svgParts.push(`${indent}${wrapAtomicRasterTimeline(el, image)}`);
    appendBoxReflection(state, el, reflectionFragmentStart, depth);
    return;
  }
  // DM-2149: native form chrome comes from Blink's per-platform LayoutTheme,
  // not from CSS boxes that can be reconstructed portably. Stamp Chromium's
  // host snapshot for native appearance; `appearance:none` controls never
  // receive this field and continue through the vector form-control renderer.
  const nativeControlRaster = el.nativeControlRaster;
  if (nativeControlRaster != null) {
    if (nativeControlRaster.dataUri != null) {
      const image = `<image href="${nativeControlRaster.dataUri}" x="${r(nativeControlRaster.x)}" y="${r(nativeControlRaster.y)}" width="${r(nativeControlRaster.width)}" height="${r(nativeControlRaster.height)}" preserveAspectRatio="none"/>`;
      svgParts.push(`${indent}${wrapAtomicRasterTimeline(el, image)}`);
      appendBoxReflection(state, el, reflectionFragmentStart, depth);
    }
    // Presence is the Chromium paint-ownership decision. A proven empty
    // isolation or a warned materialization failure both suppress the legacy
    // sampled form-controls.ts branch; silently substituting macOS-calibrated
    // chrome here would turn an observable capture failure into wrong pixels.
    return;
  }
  // DM-2171 / DM-2206: Blink evaluates backdrop-filter against a previously
  // painted backdrop surface. SVG has no way to address that prior surface,
  // so stamp Chromium's isolated box snapshot before its vector descendants.
  const backdropFilterRaster = el.backdropFilterRaster;
  if (backdropFilterRaster?.dataUri != null) {
    // rasterizeBackdropFilters hides this element's later-painted descendants
    // while taking the snapshot. The image therefore replaces only this box's
    // filtered backdrop surface; its text and children must still be emitted
    // as vectors above it. In split paint, the box phase owns the snapshot.
    if (paintBoxPhase) {
      svgParts.push(`${indent}<image href="${backdropFilterRaster.dataUri}" x="${r(backdropFilterRaster.x)}" y="${r(backdropFilterRaster.y)}" width="${r(backdropFilterRaster.width)}" height="${r(backdropFilterRaster.height)}" preserveAspectRatio="none"/>`);
    }
    paintBoxPhase = false;
  }
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
  const clipPathUrlId = resolveClipPathOnce(state, el, corners);
  const maskUrlId = renderMaskPhaseOnce(state, el);
  // CSS 2D transform (SK-1134): wrap the elements rendered group in
  // <g transform=...> composed around the resolved transform-origin in
  // viewport coords. transform-origin is reported by Chrome in pixels
  // relative to the elements border box (e.g. "0px 0px" for top-left,
  // "Npx Mpx" for the 50%-50% default). Add el.x/el.y to convert to the
  // viewport coordinate system the SVG draws in. Chrome resolves every
  // CSS transform function to a matrix in computed style, so we only
  // need to translate matrix() / matrix3d() into SVG syntax.
  const { needsGroup, groupAttrs, animClass, needsFilterOuter, localizeReferenceFilter, hasTransform } = computeGroupWrapperAttrs(el, clipPathUrlId, maskUrlId, opacity, filterCss, blendCss);
  const opened = needsGroup;
  const wrapperStart = svgParts.length;
  if (needsFilterOuter) {
    const localTransform = localizeReferenceFilter ? ` transform="translate(${r(el.x)} ${r(el.y)})"` : "";
    svgParts.push(`${indent}<g${localTransform} style="${esc(`filter:${filterCss}`)}">`);
    if (localizeReferenceFilter) svgParts.push(`${indent}<g transform="translate(${r(-el.x)} ${r(-el.y)})">`);
  }
  if (opened) svgParts.push(`${indent}<g ${groupAttrs.join(" ")}>`);
  // Everything painted until `closeWrappers()` (this element's own text AND its
  // whole subtree) is transformed content, where the baseline pixel-grid snap
  // must not apply — Skia rounds glyph y BEFORE the transform (in the local /
  // composited-layer space it rasterizes in), so snapping the post-transform
  // coordinate would land off Chrome's paint. Two signals cover the two ways
  // a transform reaches the renderer:
  //   - `hasTransform`: an explicit `<g transform>` wrapper is being emitted
  //     (animator/tree-ops-produced transforms) — the local coordinates we
  //     emit get transformed downstream.
  //   - `transformCreatesSc`: the capture script records `styles.transform =
  //     "none"` for every element and bakes the live post-transform rects
  //     into the coordinates, preserving the was-non-none bit here. Baked
  //     coordinates went through the element's transform (e.g. a
  //     perspective-projected `translateZ` scale), so the fractional
  //     baseline is Chrome's actual paint position, not an unsnapped one —
  //     measured on the preserve-3d feature fixture, where re-snapping it
  //     was a regression.
  //   - `transformStyle != flat`: children of a `preserve-3d` context are
  //     composited as 3D layers, and the 3D composite RESAMPLES each layer's
  //     raster at its (fractional) composited position — so the snap Skia
  //     applied inside the layer does not survive to the final pixels
  //     (measured: Chrome paints this fixture's untransformed children at
  //     baseline y = 109.5 / 169.5, not 110 / 170).
  const suppressBaselineSnap = hasTransform
    || el.styles.transformCreatesSc === true
    || (el.styles.transformStyle != null && el.styles.transformStyle !== "" && el.styles.transformStyle !== "flat");
  if (suppressBaselineSnap) pushBaselineSnapSuppression();
  // Inner anim-class wrapper sits INSIDE any visibility/transform group so
  // the merger's class (added on the outer group) and our anim class can
  // each carry their own `animation` shorthand without clobbering.
  if (animClass !== "") svgParts.push(`${indent}<g class="${animClass}">`);
  const wrapperContentStart = svgParts.length;

  // A negative positioned pseudo on a host that does not itself establish a
  // stacking context participates in the nearest ancestor context. It paints
  // below the host's own box (the common `position:relative; z-index:auto`
  // case), not in the host-local post-background step. A real host stacking
  // context retains the Appendix E order and paints its negative descendants
  // immediately after its own background/border below.
  const pseudoNegativePaintsAboveHostBox = establishesStackingContext(el, parentDisplayForEl);
  if (paintBoxPhase && !pseudoNegativePaintsAboveHostBox) {
    paintCapturedPseudoFragments(state, el, indent, "negative");
  }

  // Inline-fragment paint: when the element wraps across multiple line
  // boxes and the bbox-based paint would smear background + border across
  // the whole logical inline (typically the full container width), paint
  // each line fragment individually. The remaining bbox-based emissions
  // (outset shadow, bg color, bg image, inset shadow, border-image,
  // border) are gated below on `!useInlineFragments` so they don't double
  // up. Outline still paints around the bbox — it's outside the box and
  // CSS doesn't fragment it per inline line box.
  if (useInlineFragments && paintBoxPhase) {
    renderInlineFragments(state, el, indent, bgColor, corners);
  }

  // Outset box-shadow (SK-1101 + SK-1113): paints BENEATH the element box.
  // CSS spec says the first shadow in the list is closest to the element;
  // later shadows sit further behind. SVG paints later in document order,
  // so to get the same stacking we iterate the list in REVERSE (deepest
  // first). Blur > 0 routes through an SVG <filter feGaussianBlur> with
  // stdDeviation ≈ blur/2 (matches Chromes blur-to-stdDev mapping).
  if (!useInlineFragments && paintBoxPhase) {
    paintBoxShadow(paintCtx, boxPaintEl, boxPaintCorners, indent);
  }

  // Background rect(s). CSS lets backgrounds stack via background-image with
  // a comma-separated list of linear/radial gradients and url() images. The
  // first layer paints on top — we emit in reverse so the rect order matches
  // CSS layering. The background-color paints *under* all layers.
  const backgroundStackStart = svgParts.length;
  if (paintBoxPhase) {
    svgParts.push(...paintBackgroundColor(boxPaintEl, boxPaintCorners, indent, bgColor, useInlineFragments, suppressEmptyCell));
  }
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
  // Background-image layers + the background-clip:text fills consumed by
  // paintText. The layers belong to the box phase but the fills are consumed
  // in the inline phase, so they are stashed for the second pass to pick up.
  if (paintBoxPhase) {
    const backgroundImageStart = svgParts.length;
    state.bgClipTextFills.set(el, paintBackgroundImageLayers(paintCtx, boxPaintEl, indent, boxPaintCorners, useInlineFragments, captureViewport));
    const blendLayers = splitTopLevelCommas(el.styles.backgroundBlendMode ?? "normal");
    const hasNonNormalBlend = blendLayers.some((mode) => mode.trim() !== "" && mode.trim() !== "normal");
    // Blink's BoxPainterBase opens its separate buffer around PaintFillLayers,
    // whose bottom FillLayer paints both the background color and its image.
    // Keep the same boundary here: isolating only image rects leaves the
    // bottom blended layer with a transparent backdrop instead of the color.
    if (hasNonNormalBlend && svgParts.length > backgroundImageStart) {
      const stack = svgParts.slice(backgroundStackStart).join("\n");
      svgParts.length = backgroundStackStart;
      svgParts.push(`${indent}<g style="isolation:isolate">\n${stack}\n${indent}</g>`);
    }
  }
  const { fills: textBgClipFills, fragmentFills: textBgClipFragmentFills } = state.bgClipTextFills.get(el) ?? { fills: [], fragmentFills: [] };
  const nativeDecoration = el.nativeControlDecorationRaster;
  const isMenulistButtonDecoration = nativeDecoration?.kinds.includes("menulist-button-arrow") === true;
  if (paintBoxPhase && isMenulistButtonDecoration && nativeDecoration?.dataUri != null) {
    // Blink's BoxFragmentPainter emits kMenulistButton's ThemePainter
    // decoration after CSS background layers but before inset shadow and
    // border. Selected text is later child content. Keep this exact phase:
    // putting the transparent crop after the border/text changes overlap for
    // thick borders, inset shadows, and tight vertical controls.
    svgParts.push(`${indent}<image href="${nativeDecoration.dataUri}" x="${r(nativeDecoration.x)}" y="${r(nativeDecoration.y)}" width="${r(nativeDecoration.width)}" height="${r(nativeDecoration.height)}" preserveAspectRatio="none"/>`);
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
  if (!useInlineFragments && paintBoxPhase) {
    paintInsetBoxShadow(paintCtx, boxPaintEl, boxPaintCorners, indent);
  }

  if (paintBoxPhase) {
    paintBorder(paintCtx, boxPaintEl, indent, boxPaintCorners, width, height, borderWidth, borderColor, suppressEmptyCell, useInlineFragments, offGridCollapsedCells);
  }

  // Column rules belong to the multicol container's box-paint phase and sit
  // behind its contents. Capture supplies disjoint row segments so spanning
  // elements leave the same gap Blink paints instead of receiving a rule
  // through their middle.
  if (paintBoxPhase && el.columnRules != null) {
    for (const rule of el.columnRules) {
      const ruleColor = colorStr(parseColor(rule.color) ?? { r: 0, g: 0, b: 0, a: 1 });
      const dash = rule.style === "dashed"
        ? ` stroke-dasharray="${r(rule.width * 3)},${r(rule.width * 3)}"`
        : rule.style === "dotted"
          ? ` stroke-dasharray="0,${r(rule.width * 2)}" stroke-linecap="round"`
          : "";
      if (rule.style === "double" && rule.width >= 3) {
        const part = rule.width / 3;
        svgParts.push(`${indent}<line x1="${r(rule.x - part)}" y1="${r(rule.y1)}" x2="${r(rule.x - part)}" y2="${r(rule.y2)}" stroke="${ruleColor}" stroke-width="${r(part)}" />`);
        svgParts.push(`${indent}<line x1="${r(rule.x + part)}" y1="${r(rule.y1)}" x2="${r(rule.x + part)}" y2="${r(rule.y2)}" stroke="${ruleColor}" stroke-width="${r(part)}" />`);
      } else {
        svgParts.push(`${indent}<line x1="${r(rule.x)}" y1="${r(rule.y1)}" x2="${r(rule.x)}" y2="${r(rule.y2)}" stroke="${ruleColor}" stroke-width="${r(rule.width)}"${dash} />`);
      }
    }
  }

  // Outline (SK-1111): drawn outside the border-box and shifted further out
  // by outline-offset (which can be negative). Doesn't take layout space —
  // the captured rect is the border-box, so we inflate from that. Outline
  // styles (solid / dashed / dotted) reuse dashArrayForStyle.
  if (paintBoxPhase) {
    svgParts.push(...paintOutline(el, borderRadius, indent));
  }

  // The children's paint-step buckets, resolved once for both phases.
  const childPlan = resolveChildPlan(state, el, parentDisplayForEl);
  // Register the children's overflow clip even when neither phase ends up
  // opening a group around it — a descendant hoisted out of this scroller
  // looks the id up to re-apply the clip (see `ensureChildOverflowClipId`).
  if (el.svgContent == null) ensureChildOverflowClipId(state, el, corners);

  /**
   * Close whatever wrapper groups this call opened — or, when a split phase
   * turned out to paint nothing at all, drop them again rather than leave an
   * empty `<g>` behind. Only the phased calls roll back: an unsplit `"all"`
   * element keeps emitting exactly what it always did.
   */
  const closeWrappers = (): void => {
    if (suppressBaselineSnap) popBaselineSnapSuppression();
    if (phase !== "all" && svgParts.length === wrapperContentStart) {
      svgParts.length = wrapperStart;
      return;
    }
    if (animClass !== "") svgParts.push(`${indent}</g>`);
    if (opened) svgParts.push(`${indent}</g>`);
    if (localizeReferenceFilter) svgParts.push(`${indent}</g>`);
    if (needsFilterOuter) svgParts.push(`${indent}</g>`);
  };

  // ── Step 2: a host-local negative stacking context paints after this
  // element's own background and before any descendant. Non-SC hosts emitted
  // their ancestor-owned negative pseudo before the host box above.
  if (paintBoxPhase && pseudoNegativePaintsAboveHostBox) {
    paintCapturedPseudoFragments(state, el, indent, "negative");
  }
  if (paintBoxPhase) {
    paintPseudoBoxes(state, el, indent, "behind");
  }

  // ── Steps 2-4: negative-z stacking contexts, then every in-flow block
  // descendant's box, then the stacking context's floats. Emitted between this
  // element's own box and its own inline content, which is what makes a float
  // paint above the backgrounds and below the text of the WHOLE context.
  if (paintBoxPhase && !childBoxPhaseIsEmpty(childPlan) && el.svgContent == null && childPlan.flat3d == null) {
    const childClipId = openChildOverflowClip(state, el, indent, corners);
    renderChildBoxPhase(state, childPlan, depth);
    if (childClipId != null) svgParts.push(`${indent}</g>`);
  }
  if (!paintInlinePhase) {
    closeWrappers();
    appendBoxReflection(state, el, reflectionFragmentStart, depth);
    return;
  }

  // Inline SVG content (see paintInlineSvg). A replaced element's SVG content
  // is its entire paint, so when present we push the content, close the
  // wrapper groups opened above (animClass + opacity/transform/clip/mask
  // group, plus the DM-704 filter-outer wrapper) and return — otherwise an
  // inline-SVG element with e.g. `opacity < 1` would emit an unbalanced <g>
  // and break the document (observable on resend/stripe nav chevrons).
  {
    const _isvg = paintInlineSvg(el, indent, () => state.paintCtx.nextClipId("svgic"), state.paintCtx.idPrefix);
    if (_isvg.handled) {
      svgParts.push(..._isvg.svg);
      closeWrappers();
      appendBoxReflection(state, el, reflectionFragmentStart, depth);
      return;
    }
  }

  // Form control chrome (checkbox, radio, range, color, progress, meter,
  // select chevron, details disclosure). Paints on top of the element's
  // bg/border so the UA-default visuals are synthesized where the bare
  // capture missed them. Styled controls (author-set background/border)
  // still look like bare rects — the common case where authors match
  // Chromium defaults is handled here.
  const isFileSelectorDecoration = nativeDecoration?.kinds.includes("file-selector-button") === true;
  if (isFileSelectorDecoration) {
    // FileInputType's closed-shadow child paints its outset shadow, native
    // border-box surface, then its sibling status text. The crop deliberately
    // excludes shadow overflow and status, so keep all three source phases
    // separate and never place the raster after the filename.
    const shadow = renderFileSelectorOutsetShadow(el, indent, defCtx, true);
    if (shadow !== "") svgParts.push(shadow);
    if (nativeDecoration?.dataUri != null) {
      svgParts.push(`${indent}<image href="${nativeDecoration.dataUri}" x="${r(nativeDecoration.x)}" y="${r(nativeDecoration.y)}" width="${r(nativeDecoration.width)}" height="${r(nativeDecoration.height)}" preserveAspectRatio="none"/>`);
    }
  }
  const fc = renderFormControl(el, indent, defCtx);
  if (fc !== "") svgParts.push(fc);
  if (!isMenulistButtonDecoration && !isFileSelectorDecoration && nativeDecoration?.dataUri != null) {
    // This transparent image owns only the decoration pixels. It deliberately
    // stays inside the host's normal opacity/transform/clip/filter wrappers,
    // above the structural box and value text, unlike a complete native host
    // raster which terminates rendering near the top of this function.
    svgParts.push(`${indent}<image href="${nativeDecoration.dataUri}" x="${r(nativeDecoration.x)}" y="${r(nativeDecoration.y)}" width="${r(nativeDecoration.width)}" height="${r(nativeDecoration.height)}" preserveAspectRatio="none"/>`);
  }

  // DM-2464: the authoritative live record owns failed/loading/no-source
  // image paint. Its helper emits captured UA vectors + shaped text and only
  // the isolated Chromium icon pixels. Old serialized `imageBroken` records
  // deliberately fail closed instead of reviving the fixed mountain/raw-text
  // approximation removed here.
  const brokenFallback = renderBrokenImageFallback(el, {
    indent,
    idPrefix: paintCtx.idPrefix,
    nextId: (prefix) => paintCtx.nextClipId(prefix),
  });
  defsParts.push(...brokenFallback.defs);
  svgParts.push(...brokenFallback.svg);
  if (!brokenFallback.handled && el.imageBroken !== true
      && el.imageSrc != null
      && (el.tag === "img" || (el.tag === "input" && el.styles.inputType === "image"))) {
    paintImage(paintCtx, el, borderRadius, corners, indent);
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

  // Pseudo-element image content (::before / ::after with content: url(...)).
  // CSS atomic-inline-box paint order: the ::before's replaced-element box
  // paints BEFORE the parent's main-text inline content in the same line,
  // so subsequent text appears on top of any image overflow. Painting after
  // text put our SVG circles ON TOP of the paragraph in the 24-generated-content
  // fixture (DM-440 user feedback: 'z-index of svg is wrong'). Move the
  // emit ahead of the text block so text reliably wins z.
  paintCapturedPseudoFragments(state, el, indent, "before");
  if (el.pseudoImages != null) {
    for (const pi of el.pseudoImages) {
      const image = `<image href="${esc(embedResizedDataUri(pi.url, pi.width, pi.height))}" x="${r(pi.x)}" y="${r(pi.y)}" width="${r(pi.width)}" height="${r(pi.height)}" preserveAspectRatio="xMidYMid meet" />`;
      svgParts.push(`${indent}${wrapPseudoPaintEffects(pi, image)}`);
    }
  }
  // Box-only pseudo-elements (DM-579): empty-content `::before` / `::after`
  // with non-zero borders or background act as decorative separators /
  // overlays. Capture pass records their effective rect + per-side
  // borders; we emit one `<rect>` for the background fill (if any) plus
  // up to four `<line>`s for the visible border sides. Per-side colors /
  // widths can differ so we can't collapse them into a single
  // stroke="..." attribute the way the regular-element border path does.
  paintPseudoBoxes(state, el, indent);

  // Text rendering — delegated to text-renderer.ts based on configured mode
  {
    paintText(paintCtx, el, textColor, indent, textBgClipFills, captureViewport, textBgClipFragmentFills);
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
  svgParts.push(...paintTruncationMarker(el, textColor, indent));

  // ── Step 5 (continued) + steps 6-7: the children's inline content, then
  // the flex/grid items and the positioned / stacking-context children.
  //
  // DM-473: when `el` is a stacking-context root its paint list was flattened
  // (positioned descendants of non-SC children hoisted up to this level) when
  // `resolveChildPlan` bucketed it; when it is NOT an SC root, the plan holds
  // its direct children minus any already hoisted to an ancestor SC's list
  // (they render at the ancestor's depth, and re-rendering here would
  // double-emit).
  if (childPlan.flat3d != null) {
    // A 3D rendering context paints its children in translateZ order, each
    // atomically — the Z sort spans every paint-step bucket, so there is no
    // block/inline seam to split it on.
    const childClipId = openChildOverflowClip(state, el, indent, corners);
    for (const child of childPlan.flat3d) {
      renderElementWithOverflowClip(state, child, depth + 1, childPlan.childDisplay);
    }
    if (childClipId != null) svgParts.push(`${indent}</g>`);
  } else if (!childInlinePhaseIsEmpty(childPlan)) {
    const childClipId = openChildOverflowClip(state, el, indent, corners);
    renderChildInlinePhase(state, childPlan, depth);
    if (childClipId != null) svgParts.push(`${indent}</g>`);
  }

  // A non-positioned ::after is the host's final generated child. Positioned
  // auto/zero and positive stacking records follow the in-flow child paint;
  // their exact geometry remains source-owned in all three slots.
  paintCapturedPseudoFragments(state, el, indent, "after");
  paintCapturedPseudoFragments(state, el, indent, "positioned");

  // Blink's TablePainter paints the collapsed edge graph after cell/row/table
  // backgrounds. Emitting here gives the single table-owned layer the same
  // ownership and prevents descendant backgrounds from covering its edges.
  paintCollapsedBorderRects(paintCtx, el, indent);

  // DM-1001: emit deferred fade-overlay `::after` pseudoBoxes AFTER all
  // child recursion. The `::before` loop above skipped these so they paint
  // last and win z over child headline text — matches NYT's right-edge
  // mask-image-style fade pattern. Same filter as the skip condition above
  // so we don't double-emit decorative `::after` boxes (carets / dividers)
  // that the earlier loop already handled in CSS-correct inline position.
  paintDeferredFadeOverlays(state, el, indent);
  paintCapturedPseudoFragments(state, el, indent, "positive");

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
      { fontSize: radFontSize, fontFamily: el.styles.fontFamily, fontWeight: el.styles.fontWeight, fontStyle: el.styles.fontStyle, fontStretch: el.styles.fontStretch },
      strokeCol,
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

  // CustomScrollbarTheme paints the captured CSS boxes in source order:
  // horizontal, vertical, custom corner, then the separately owned resizer.
  // Geometry is already in capture-viewport coordinates and must not be
  // recomputed from scroll ranges or transformed a second time.
  svgParts.push(...paintCustomScrollbars({
    defsParts,
    nextId: (prefix) => paintCtx.nextClipId(prefix),
    paintVectorPart: (item, partIndent) => paintCustomScrollbarVectorPart(
      paintCtx, captureViewport, el, item, partIndent,
    ),
  }, captureViewport, el, indent));

  // PaintOverflowControls orders both axes and the corner before the resizer.
  // Native crops are already clipped source-frame pixels in capture-viewport
  // coordinates; this consumer never reconstructs or scales platform chrome.
  svgParts.push(...paintNativeScrollbarRasters(el, indent));

  svgParts.push(...paintResizeHandle(paintCtx, captureViewport, el, indent));

  closeWrappers();
  appendBoxReflection(state, el, reflectionFragmentStart, depth);
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
    /** DM-1488: accessible name → `role="img"` + `<title>` on the root `<svg>`
     *  (for inline-`<svg>` embedding). Omit to leave the output unchanged. */
    title?: string;
    /** DM-1488: accessible long description → `<desc>` on the root `<svg>`. */
    desc?: string;
  },
): string {
  const inner = elementTreeToSvgInner(
    elements, width, height,
    opts?.idPrefix ?? "",
    opts?.includeGlyphDefs ?? true,
    opts?.hiDPIFactor ?? 2,
    opts?.includeEmbeddedFontCss ?? (opts?.includeGlyphDefs ?? true),
  );
  return wrapSvg(inner, width, height, { tree: elements, title: opts?.title, desc: opts?.desc });
}


// Stacking-context analysis (establishesStackingContext / gatherStackingContextChildren / isOverflowOnlySC / isFlexOrGridContainerDisplay) moved to ./stacking.ts (DM-1305).

// isFixedContainingBlock / sortChildrenByPaintOrder moved to ./stacking.ts (DM-1742 — the cursor hit-test reuses them for true paint-order hit-testing).


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
  selectedImage: CapturedBackgroundImage | null = null,
  paintingArea: { x: number; y: number; width: number; height: number } | null = null,
): { def: string } {
  // Computed style deliberately serializes the complete image-set. The live
  // capture record—not this renderer—owns Blink's DPR/type candidate choice.
  const imageSet = /^(?:-webkit-)?image-set\((.+)\)$/i.exec(layer);
  if (imageSet != null) {
    if (selectedImage?.source !== "image-set" || selectedImage.selectedUrl == null
        || selectedImage.loadState !== "loaded") {
      console.warn("[domotion] image-set background omitted: authoritative selected candidate was unavailable");
      return { def: "" };
    }
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
  const legacyLinear = parseLegacyWebkitLinearGradient(layer);
  if (legacyLinear != null) {
    return { def: buildExactLinearGradientDef(legacyLinear, id, { x: gradX, y: gradY, w: gradW, h: gradH }) };
  }
  if (needsChromiumGradientRaster(layer)) {
    const tile = computeTileSize(sizeCss, gradW, gradH);
    const raster = advancedGradientTile(layer, tile.w, tile.h);
    if (raster != null) {
      return { def: buildImagePatternDef(id, raster, elX, elY, w, h, sizeCss, posCss, repeatCss, { w: tile.w, h: tile.h }, attachment, fixedViewport) };
    }
    console.warn(`[domotion] Chromium raster tile unavailable for advanced gradient; using best-effort SVG interpolation: ${layer}`);
  }
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
  // DM-550/DM-2327: Chromium capture (or the CPU fallback) populated `_conicTileCache`
  // with PNG bytes for `(layerText, "${tileW}x${tileH}")` tuples; we look up
  // and embed as <pattern><image>. Parse failure or cache miss returns an
  // empty def → caller skips this layer.
  if (/^(?:repeating-)?conic-gradient\(/i.test(layer)) {
    return { def: buildConicGradientDef(id, layer, elX, elY, w, h, sizeCss, posCss) };
  }
  if (selectedImage != null && selectedImage.loadState !== "loaded") {
    console.warn(`[domotion] URL background omitted: selected image ${selectedImage.loadState} at capture time`);
    return { def: "" };
  }
  const urlContent = selectedImage?.selectedUrl ?? parseCssUrl(layer);
  if (urlContent != null) {
    const def = buildImagePatternDef(
      id, urlContent, elX, elY, w, h, sizeCss, posCss, repeatCss,
      intrinsic, attachment, fixedViewport, selectedImage, paintingArea,
    );
    if (def === "") {
      console.warn("[domotion] URL background omitted: exact Blink tile geometry was unavailable");
    }
    return { def };
  }
  return { def: "" };
}

/**
 * DM-550: Emit a `<pattern><image href="data:image/png;base64,…"/></pattern>`
 * for a single conic-gradient background layer. Looks up the PNG bytes in
 * `_conicTileCache` (normally painted by the live Chromium page; CPU fallback
 * only when that page-backed pre-pass was unavailable).
 *
 * Tile size resolves from `sizeCss` against the element rect (mirrors the
 * tile-sizing logic in `conic-raster.ts computeTileSize` so cache lookups
 * line up). Background-position offset is applied to the pattern's x/y attrs.
 *
 * Returns empty string when the cache misses; the caller warns loudly and
 * skips emission.
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

// Mask + fragment-def builders (buildMaskDef, buildMaskBorder9Slice, rewriteFragmentMaskDef, positionFragment*Def) moved to ./mask.ts (DM-1305/DM-2379).

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
 * Blink `LayoutReplaced::ComputeObjectFitAndPositionRect`, expressed in CSS
 * pixels. Computed `object-position` serializes each axis as a percentage,
 * length, or `calc(<percentage> +/- <length>)`; the length is added after the
 * percentage has been resolved against the free space.
 */
export function computeObjectFitRect(
  x: number, y: number, width: number, height: number,
  intrinsicWidth: number, intrinsicHeight: number,
  fit: string | undefined, position: string | undefined,
): { x: number; y: number; width: number; height: number } {
  const mode = (fit ?? "fill").trim();
  let objectWidth = width;
  let objectHeight = height;
  if (mode !== "fill") {
    const containScale = Math.min(width / intrinsicWidth, height / intrinsicHeight);
    const scale = mode === "cover"
      ? Math.max(width / intrinsicWidth, height / intrinsicHeight)
      : mode === "none"
        ? 1
        : mode === "scale-down"
          ? Math.min(1, containScale)
          : containScale;
    objectWidth = intrinsicWidth * scale;
    objectHeight = intrinsicHeight * scale;
  }
  const [horizontal, vertical] = splitComputedObjectPosition(position ?? "50% 50%");
  return {
    x: x + resolveObjectPositionAxis(horizontal, width - objectWidth),
    y: y + resolveObjectPositionAxis(vertical, height - objectHeight),
    width: objectWidth,
    height: objectHeight,
  };
}

function splitComputedObjectPosition(position: string): [string, string] {
  const tokens = position.trim().match(/calc\([^)]*\)|\S+/g) ?? [];
  if (tokens.length === 0) return ["50%", "50%"];
  if (tokens.length === 1) {
    return tokens[0] === "top" || tokens[0] === "bottom"
      ? ["50%", tokens[0]]
      : [tokens[0], "50%"];
  }
  return [tokens[0]!, tokens[1]!];
}

function resolveObjectPositionAxis(token: string, freeSpace: number): number {
  const keywordPct = token === "left" || token === "top" ? 0
    : token === "right" || token === "bottom" ? 100
      : token === "center" ? 50 : null;
  if (keywordPct != null) return freeSpace * keywordPct / 100;
  const percentage = /(-?(?:\d+\.?\d*|\.\d+))%/.exec(token);
  const length = /([+-])\s*(-?(?:\d+\.?\d*|\.\d+))px/.exec(token);
  const plainPx = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(token);
  const pctOffset = percentage == null ? 0 : freeSpace * Number(percentage[1]) / 100;
  if (plainPx != null) return Number(plainPx[1]);
  if (length != null) return pctOffset + (length[1] === "-" ? -1 : 1) * Number(length[2]);
  return percentage == null ? freeSpace / 2 : pctOffset;
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
// default `. `; the CJK ideographic styles use the ideographic comma `、`.
// Return the complete suffix because Blink includes it in the marker inline
// size and aligns that full advance to the list-item edge.
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
      return ". ";
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

function quarterEllipseLength(rx: number, ry: number): number {
  if (rx <= 0 || ry <= 0) return Math.max(rx, ry);
  // Fixed Simpson integration is deterministic and sub-millipixel accurate for
  // the CSS corner aspect ratios used here; Blink asks Path::length() for this
  // same centerline before selecting a closed-path dash gap.
  const steps = 64;
  const h = (Math.PI / 2) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * h;
    const speed = Math.hypot(rx * Math.sin(t), ry * Math.cos(t));
    sum += speed * (i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4);
  }
  return sum * h / 3;
}

function roundedRectPerimeter(width: number, height: number, corners: CornerRadii): number {
  const horizontal = Math.max(0, width - corners.tl.h - corners.tr.h)
    + Math.max(0, width - corners.bl.h - corners.br.h);
  const vertical = Math.max(0, height - corners.tl.v - corners.bl.v)
    + Math.max(0, height - corners.tr.v - corners.br.v);
  return horizontal + vertical
    + quarterEllipseLength(corners.tl.h, corners.tl.v)
    + quarterEllipseLength(corners.tr.h, corners.tr.v)
    + quarterEllipseLength(corners.br.h, corners.br.v)
    + quarterEllipseLength(corners.bl.h, corners.bl.v);
}

function adjustedClosedDashArray(style: string, width: number, pathLength: number, thinDotted: boolean): string {
  if (pathLength <= 0 || width <= 0) return "";
  if (style === "dashed") {
    const dashLength = width * (width >= 3 ? 2 : 3);
    const targetGap = width * (width >= 3 ? 1 : 2);
    const gap = selectBestDashGap(pathLength, dashLength, targetGap, true);
    return gap > 0 ? `${r(dashLength)} ${r(gap)}` : "";
  }
  if (style === "dotted") {
    if (thinDotted) return `${r(Math.round(width))} ${r(Math.round(width))}`;
    const gap = selectBestDashGap(pathLength, width, width, true);
    return gap > 0 ? `0.01 ${r(gap + width - 0.01)}` : "";
  }
  return "";
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
    const gap = selectBestDashGap(sideLength, dashLen, gapTarget, false);
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
    const gap = selectBestDashGap(sideLength, width, width, false);
    if (gap <= 0) return { array: "", offset: 0 };
    const kEpsilon = 0.01;
    return { array: `0.01 ${r(gap + width - kEpsilon)}`, offset: 0 };
  }
  return { array: "", offset: 0 };
}
