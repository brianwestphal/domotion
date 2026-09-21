import type { CapturedBackgroundImage, CapturedElement } from "../capture/types.js";
import { resolveBackgroundAttachment, intersectBackgroundRects } from "./background-attachment.js";
import { outsetCornerRadiiForShadow, insetCornerRadii, roundedRectSvg, parseCornerRadii, parseSide, dashArrayForStyle, type CornerRadii } from "./borders.js";
import { parseBoxShadow } from "./box-shadow.js";
import { parseColor, colorStr, sameColor } from "./colors.js";
import { splitTopLevelCommas } from "./css-tokens.js";
import { r } from "./format.js";
import { cyclicBackgroundLayer } from "./image-pattern.js";
import type { PaintCtx, RenderState } from "./element-tree-to-svg.js";

export type BackgroundLayerBuilder = (
  id: string,
  layer: string,
  elX: number,
  elY: number,
  width: number,
  height: number,
  sizeCss?: string,
  positionCss?: string,
  repeatCss?: string,
  intrinsic?: { w: number; h: number } | null,
  attachment?: string,
  fixedViewport?: { w: number; h: number } | null,
  selectedImage?: CapturedBackgroundImage | null,
  paintingArea?: { x: number; y: number; width: number; height: number } | null,
) => { def: string };

export type BackgroundColorClipsToText = (element: CapturedElement) => boolean;

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
export function paintBackgroundImageLayers(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  useInlineFragments: boolean,
  captureViewport: { w: number; h: number },
  buildBackgroundLayerDef: BackgroundLayerBuilder,
  backgroundColorClipsToText: BackgroundColorClipsToText,
): {
  fills: string[];
  fragmentFills: (string[] | null)[];
  fragmentRects: NonNullable<CapturedElement["inlineFragments"]> | null;
} {
  const textBgClipFills: string[] = [];
  // DM-1420: per-line-fragment fills for a wrapped inline's bg-clip:text layers
  // (parallel to `textBgClipFills`; null for layers/elements painted single-box).
  const textBgClipFragmentFills: (string[] | null)[] = [];

  const bgImage = el.styles.backgroundImage;
  const imageLayers = bgImage != null && bgImage !== "none" && bgImage !== ""
    ? splitTopLevelCommas(bgImage)
    : [];
  if (!useInlineFragments && bgImage != null && bgImage !== "none" && bgImage !== "") {
    const layers = imageLayers;
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
    const layers = imageLayers;
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
        // DM-2365: use the live stitched imaginary border box captured for
        // slice fragments. The former sum(width)/shift-x construction only
        // matched horizontal LTR wrapping; it lost RTL, vertical writing,
        // nonuniform fragment offsets, background-origin and URL tile phase.
        // Clone continues to restart against each physical fragment.
        const clone = (el.styles.boxDecorationBreak ?? "slice") === "clone";
        const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
        const bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
        const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
        const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
        const padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
        const padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
        const padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
        const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
        const originLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
        const layerOrigin = cyclicBackgroundLayer(originLayers, li, "padding-box").trim();
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
        const perFrag: string[] = [];
        for (const fr of frags) {
          const physicalFragment = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
          const stitchedBorderBox = clone ? physicalFragment : fr.backgroundPositioningArea;
          if (stitchedBorderBox == null) {
            perFrag.push(textBgClipFills[li]!);
            continue;
          }
          const fixedToViewport = layerAttachment === "fixed"
            && el.styles.backgroundAttachmentGeometry?.source === "blink-box-background-paint-context-v1"
            && el.styles.backgroundAttachmentGeometry.fixedToViewport === true;
          const layerBorderBox = fixedToViewport ? physicalFragment : stitchedBorderBox;
          const originBox = boxFor(layerBorderBox, layerOrigin);
          const isUrlBacked = /^\s*(?:url\(|(?:-webkit-)?image-set\()/i.test(layer);
          const attachmentGeometry = isUrlBacked
            ? resolveBackgroundAttachment(
                layerAttachment,
                layerBorderBox,
                originBox,
                physicalFragment,
                el.styles.backgroundAttachmentGeometry,
                captureViewport,
              )
            : null;
          const positioningBox = attachmentGeometry?.positioningBox ?? originBox;
          const paintingBox = attachmentGeometry?.paintingBox ?? physicalFragment;
          const fid = ctx.nextClipId("bg");
          const fout = buildBackgroundLayerDef(
            fid, layer,
            positioningBox.x, positioningBox.y, positioningBox.width, positioningBox.height,
            layerSize, layerPos, layerRepeat, layerIntrinsic,
            attachmentGeometry == null ? layerAttachment : "scroll",
            attachmentGeometry == null ? captureViewport : null,
            selectedImage,
            paintingBox,
          );
          if (fout.def === "") { perFrag.push(textBgClipFills[li]!); continue; } // fall back to union fill
          ctx.defsParts.push(fout.def);
          perFrag.push(`url(#${fid})`);
        }
        textBgClipFragmentFills[li] = perFrag;
      }
    }
  }

  // Blink paints background-color as part of the bottom FillLayer, before its
  // image, and applies the same text clip to both. Store a synthetic final
  // entry so the mask emitter's bottom→top walk paints color first, then the
  // bottom image and every higher image. This also covers color-only
  // background-clip:text, where computed background-image is `none`.
  const bgColor = parseColor(el.styles.backgroundColor);
  if (bgColor != null && bgColor.a > 0.01 && backgroundColorClipsToText(el)) {
    const colorIndex = imageLayers.length;
    const colorFill = colorStr(bgColor);
    textBgClipFills[colorIndex] = colorFill;
    if (useInlineFragments && el.inlineFragments != null && el.inlineFragments.length > 0) {
      textBgClipFragmentFills[colorIndex] = el.inlineFragments.map(() => colorFill);
    }
  }
  return {
    fills: textBgClipFills,
    fragmentFills: textBgClipFragmentFills,
    fragmentRects: useInlineFragments ? (el.inlineFragments ?? null) : null,
  };
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
export function deriveFragmentCorners(
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
export function paintInlineFragment(
  state: RenderState,
  indent: string,
  f: NonNullable<CapturedElement["inlineFragments"]>[number],
  fragCorners: CornerRadii,
  isFirst: boolean,
  isLast: boolean,
  ctx: InlineFragmentCtx,
  buildBackgroundLayerDef: BackgroundLayerBuilder,
  backgroundColorClipsToText: BackgroundColorClipsToText,
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
    if (bgColor != null && bgColor.a > 0.01 && !backgroundColorClipsToText(element)) {
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

export function renderInlineFragments(
  state: RenderState,
  el: CapturedElement,
  indent: string,
  bgColor: { r: number; g: number; b: number; a: number } | null,
  corners: CornerRadii,
  buildBackgroundLayerDef: BackgroundLayerBuilder,
  backgroundColorClipsToText: BackgroundColorClipsToText,
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
    paintInlineFragment(state, indent, f, fragCorners, isFirst, isLast, fragmentCtx, buildBackgroundLayerDef, backgroundColorClipsToText);
  }
}
