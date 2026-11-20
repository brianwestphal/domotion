import { openDashArray, isThinDotted } from "./stroke-style.js";
import { paintBlinkCurvedDashedDottedBorder, paintPerSideBorder } from "./border-paint.js";
import type { CapturedBackgroundImage, CapturedElement } from "../capture/types.js";
import { resolveBackgroundAttachment, intersectBackgroundRects } from "./background-attachment.js";
import {
  insetCornerRadii,
  roundedRectSvg,
  parseCornerRadii,
  parseSide,
  type CornerRadii,
  snappedInsetBox,
} from "./borders.js";
import { parseBoxShadow } from "./box-shadow.js";
import { paintBoxShadow, paintInsetBoxShadow, type ShadowBox, type ShadowFragment } from "./box-shadow-paint.js";
import { parseColor, colorStr, sameColor, INVISIBLE_ALPHA } from "./colors.js";
import { splitTopLevelCommas } from "./css-tokens.js";
import { r } from "./format.js";
import { cyclicBackgroundLayer } from "./image-pattern.js";
import { parsePaintClipLayers } from "./paint-clip-layers.js";
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
  /** The part of the painting area not covered by the box's own opaque
   * border, used only to decide whether a gradient needs tiling. */
  visiblePaintingArea?: { x: number; y: number; width: number; height: number } | null,
) => { def: string };

/** Width of one border side that paints fully opaque over the background
 * (solid style, opaque color), so the background beneath it never shows. */
function opaqueBorderWidth(el: CapturedElement, side: "Top" | "Right" | "Bottom" | "Left"): number {
  const s = el.styles;
  const [style, color, width] =
    side === "Top"
      ? [s.borderTopStyle, s.borderTopColor, s.borderTopWidth]
      : side === "Right"
        ? [s.borderRightStyle, s.borderRightColor, s.borderRightWidth]
        : side === "Bottom"
          ? [s.borderBottomStyle, s.borderBottomColor, s.borderBottomWidth]
          : [s.borderLeftStyle, s.borderLeftColor, s.borderLeftWidth];
  if (style !== "solid") return 0;
  if (s.borderImageSource != null && s.borderImageSource !== "" && s.borderImageSource !== "none") return 0;
  const parsed = parseColor(color ?? "");
  if (parsed == null || parsed.a < 1) return 0;
  return Math.max(0, parseFloat(width ?? "0") || 0);
}

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
  /** The document canvas paints its propagated layers over the whole canvas
   * while positioning them against the root box (`el`). */
  paintingAreaOverride?: { x: number; y: number; width: number; height: number },
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
  const imageLayers = bgImage != null && bgImage !== "none" && bgImage !== "" ? splitTopLevelCommas(bgImage) : [];
  if (!useInlineFragments && bgImage != null && bgImage !== "none" && bgImage !== "") {
    const layers = imageLayers;
    const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
    const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
    const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
    const clipLayers = parsePaintClipLayers(el.styles.backgroundClip);
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
    // BackgroundImageGeometry pixel-snaps both the destination (painting) area
    // and the positioning area after contracting them to the clip/origin box
    // (`ToPixelSnappedRect`, core/paint/background_image_geometry.cc:391-401,
    // Chromium 7d859f27). With an authenticated border paint snap that rounding
    // happens in the box's local paint space; otherwise the captured geometry
    // is kept.
    const boxFor = (key: string): { x: number; y: number; w: number; h: number } => {
      const insets =
        key === "content-box"
          ? { top: bwT + padT, right: bwR + padR, bottom: bwB + padB, left: bwL + padL }
          : key === "padding-box"
            ? { top: bwT, right: bwR, bottom: bwB, left: bwL }
            : { top: 0, right: 0, bottom: 0, left: 0 };
      const box = snappedInsetBox(el, insets);
      return { x: box.x, y: box.y, w: box.width, h: box.height };
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
      const positioningBox = attachmentGeometry?.positioningBox ?? {
        x: originBox.x,
        y: originBox.y,
        width: originBox.w,
        height: originBox.h,
      };
      const paintingBox = paintingAreaOverride ??
        attachmentGeometry?.paintingBox ?? {
          x: clipBox.x,
          y: clipBox.y,
          width: clipBox.w,
          height: clipBox.h,
        };
      const defId = ctx.nextClipId("bg");
      // A border-box painting area under an opaque solid border shows the
      // background only inside the border; a gradient repeat confined to the
      // covered band is invisible, so it must not force the tiled path.
      const visiblePaintingArea =
        paintingAreaOverride == null && attachmentGeometry == null && layerClip === "border-box"
          ? (() => {
              const top = opaqueBorderWidth(el, "Top");
              const right = opaqueBorderWidth(el, "Right");
              const bottom = opaqueBorderWidth(el, "Bottom");
              const left = opaqueBorderWidth(el, "Left");
              return {
                x: paintingBox.x + left,
                y: paintingBox.y + top,
                width: Math.max(0, paintingBox.width - left - right),
                height: Math.max(0, paintingBox.height - top - bottom),
              };
            })()
          : null;
      // Pattern is positioned + sized relative to the origin box (where the image starts)
      // then painted into a rect clipped to the clip box. For fixed attachment
      // the origin is the viewport instead.
      const out = buildBackgroundLayerDef(
        defId,
        layer,
        positioningBox.x,
        positioningBox.y,
        positioningBox.width,
        positioningBox.height,
        layerSize,
        layerPos,
        layerRepeat,
        layerIntrinsic,
        attachmentGeometry == null ? layerAttachment : "scroll",
        attachmentGeometry == null ? captureViewport : null,
        selectedImage,
        paintingBox,
        visiblePaintingArea,
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
      const innerCorners = layerClip === "border-box" ? corners : insetCornerRadii(corners, bwT, bwR, bwB, bwL);
      // CSS Compositing §6.1: every image layer uses its corresponding
      // background-blend-mode, including the bottom image layer as it blends
      // with the background color painted beneath it.
      const layerBlend = cyclicBackgroundLayer(blendLayers, li, "normal");
      const blendAttr = layerBlend !== "normal" && layerBlend !== "" ? ` style="mix-blend-mode:${layerBlend}"` : "";
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
    const clipLayers = parsePaintClipLayers(el.styles.backgroundClip);
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
      const out = buildBackgroundLayerDef(
        defId,
        layer,
        el.x,
        el.y,
        el.width,
        el.height,
        layerSize,
        layerPos,
        layerRepeat,
        layerIntrinsic,
        layerAttachment,
        captureViewport,
        selectedImage,
      );
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
          const fixedToViewport =
            layerAttachment === "fixed" &&
            el.styles.backgroundAttachmentGeometry?.source === "blink-box-background-paint-context-v1" &&
            el.styles.backgroundAttachmentGeometry.fixedToViewport === true;
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
            fid,
            layer,
            positioningBox.x,
            positioningBox.y,
            positioningBox.width,
            positioningBox.height,
            layerSize,
            layerPos,
            layerRepeat,
            layerIntrinsic,
            attachmentGeometry == null ? layerAttachment : "scroll",
            attachmentGeometry == null ? captureViewport : null,
            selectedImage,
            paintingBox,
          );
          if (fout.def === "") {
            perFrag.push(textBgClipFills[li]!);
            continue;
          } // fall back to union fill
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
  if (bgColor != null && bgColor.a > INVISIBLE_ALPHA && backgroundColorClipsToText(el)) {
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
  return fragsAxisIsBlock
    ? {
        tl: isFirst ? corners.tl : { h: 0, v: 0 },
        tr: isFirst ? corners.tr : { h: 0, v: 0 },
        bl: isLast ? corners.bl : { h: 0, v: 0 },
        br: isLast ? corners.br : { h: 0, v: 0 },
        uniform: corners.uniform && isFirst && isLast,
      }
    : {
        tl: isFirst ? corners.tl : { h: 0, v: 0 },
        bl: isFirst ? corners.bl : { h: 0, v: 0 },
        tr: isLast ? corners.tr : { h: 0, v: 0 },
        br: isLast ? corners.br : { h: 0, v: 0 },
        uniform: corners.uniform && isFirst && isLast,
      };
}

/**
 * The box one fragment's shadows are painted from: the fragment rect with the
 * element's shadow, border widths and background, and the sides Blink's
 * `SidesToInclude()` keeps — every side for `clone`, and for `slice` only the
 * box's starting side on its first fragment and its ending side on its last
 * (the same sides the fragment's borders paint). The fragment carries the
 * element's user→device translation: it is painted in the same space.
 */
export function fragmentShadowBox(
  element: CapturedElement,
  f: { x: number; y: number; width: number; height: number },
  clone: boolean,
  isFirst: boolean,
  isLast: boolean,
  fragsAxisIsBlock: boolean,
): { box: ShadowBox; fragment: ShadowFragment } {
  const s = element.styles;
  // Blink snaps each fragment's paint rect (`PixelSnappedContouredBorder` of
  // the fragment's own rect, inline_box_fragment_painter.cc:189-213) in the
  // element's local paint space. The element's record holds `round(L) - L`
  // per edge; a fragment edge at viewport offset `d` from the element's edge
  // sits at `L + d` locally, so its delta is `round(d - δ) - (d - δ)` with
  // δ the element's delta (round(L) is a whole pixel).
  const snap = element.borderPaintSnap;
  const authentic = snap != null && snap.width === element.width && snap.height === element.height;
  const edgeDelta = (offset: number, delta: number) => {
    const local = Math.round((offset - delta) * 64) / 64;
    return Math.round(local) - local;
  };
  const fragmentSnap = authentic
    ? {
        source: snap.source,
        left: edgeDelta(f.x - element.x, snap.left),
        top: edgeDelta(f.y - element.y, snap.top),
        right: edgeDelta(f.x + f.width - element.x, snap.left),
        bottom: edgeDelta(f.y + f.height - element.y, snap.top),
        width: f.width,
        height: f.height,
      }
    : undefined;
  return {
    box: {
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      ...(fragmentSnap == null ? {} : { borderPaintSnap: fragmentSnap }),
      styles: {
        boxShadow: s.boxShadow,
        backgroundColor: s.backgroundColor,
        borderTopWidth: s.borderTopWidth,
        borderRightWidth: s.borderRightWidth,
        borderBottomWidth: s.borderBottomWidth,
        borderLeftWidth: s.borderLeftWidth,
      },
    },
    fragment: {
      // An inline's fragments run in line order; its starting side is the
      // right one in a right-to-left inline (horizontal writing modes).
      sides: {
        top: clone || (fragsAxisIsBlock ? isFirst : true),
        bottom: clone || (fragsAxisIsBlock ? isLast : true),
        left: clone || (fragsAxisIsBlock ? true : s.direction === "rtl" ? isLast : isFirst),
        right: clone || (fragsAxisIsBlock ? true : s.direction === "rtl" ? isFirst : isLast),
      },
      ...(element.borderPaintSnap?.device == null ? {} : { device: element.borderPaintSnap.device }),
    },
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
    element,
    clone,
    fragsAxisIsBlock,
    hasBgImage,
    shadows,
    bgColor,
    sbt,
    sbr,
    sbb,
    sbl,
    bgImageLayers,
    bgSizeLayers,
    bgPosLayers,
    bgRepeatLayers,
    bgClipLayers,
    bgOriginLayers,
    bgBlendLayers,
    bgSelectedImageLayers,
    bgIntrinsicLayers,
    bgAttachmentLayers,
  } = ctx;

  // Box shadows. Blink paints every inline box fragment's decorations from
  // that fragment's own rect (InlineBoxFragmentPainterBase::
  // PaintBoxDecorationBackground, inline_box_fragment_painter.cc:427-444,
  // Chromium 7d859f27): the normal shadow first, then the background, then
  // the inset shadow, each through the shared BoxPainterBase producer with
  // the fragment's SidesToInclude(). Clone includes every side; slice drops
  // the sides where the box continues, which ClipToSides and
  // AdjustRectForSideClipping turn into an open shadow edge
  // (box_painter_base.cc:200-250).
  const shadowFragment =
    shadows.length > 0 ? fragmentShadowBox(element, f, clone, isFirst, isLast, fragsAxisIsBlock) : null;
  if (shadowFragment != null) {
    paintBoxShadow(paintCtx, shadowFragment.box, fragCorners, indent, shadowFragment.fragment);
  }

  // Background color.
  if (bgColor != null && bgColor.a > INVISIBLE_ALPHA && !backgroundColorClipsToText(element)) {
    svgParts.push(
      `${indent}${roundedRectSvg(f.x, f.y, f.width, f.height, fragCorners, `fill="${colorStr(bgColor)}"`)}`,
    );
  }

  // DM-2365: clone positions each layer against the physical fragment and
  // therefore restarts its tile phase. Slice uses Blink's captured imaginary
  // unfragmented border box, then intersects the layer clip with this
  // physical fragment. Old captures have no stitched record and retain the
  // previous fail-closed behavior for slice images.
  const stitchedBorderBox = clone ? { x: f.x, y: f.y, width: f.width, height: f.height } : f.backgroundPositioningArea;
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
      const fixedToViewport =
        layerAttachment === "fixed" &&
        element.styles.backgroundAttachmentGeometry?.source === "blink-box-background-paint-context-v1" &&
        element.styles.backgroundAttachmentGeometry.fixedToViewport === true;
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
        defId,
        layer,
        positioningBox.x,
        positioningBox.y,
        positioningBox.width,
        positioningBox.height,
        layerSize,
        layerPos,
        layerRepeat,
        layerIntrinsic,
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
      const clipCorners =
        layerClip === "border-box"
          ? fragCorners
          : insetCornerRadii(fragCorners, clipInsetTop, clipInsetRight, clipInsetBottom, clipInsetLeft);
      const blendAttr = layerBlend !== "" && layerBlend !== "normal" ? ` style="mix-blend-mode:${layerBlend}"` : "";
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

  // The inset shadow paints above the background and below the border.
  if (shadowFragment != null) {
    paintInsetBoxShadow(paintCtx, shadowFragment.box, fragCorners, indent, shadowFragment.fragment);
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

  const drawSide = (side: typeof sbt, x1: number, y1: number, x2: number, y2: number) => {
    if (side == null || side.w <= 0 || side.color.a < INVISIBLE_ALPHA) return;
    if (side.style === "none" || side.style === "hidden") return;
    const dash = openDashArray(side.style, side.w, Math.hypot(x2 - x1, y2 - y1));
    const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
    const linecap = side.style === "dotted" && !isThinDotted(side.w) ? ` stroke-linecap="round"` : "";
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
  const sidesUniformColor =
    sbt != null &&
    sbr != null &&
    sbb != null &&
    sbl != null &&
    sbt.w === sbr.w &&
    sbr.w === sbb.w &&
    sbb.w === sbl.w &&
    sbt.style === sbr.style &&
    sbr.style === sbb.style &&
    sbb.style === sbl.style &&
    sameColor(sbt.color, sbr.color) &&
    sameColor(sbr.color, sbb.color) &&
    sameColor(sbb.color, sbl.color);
  const anyCorner = fragCorners.tl.h > 0 || fragCorners.tr.h > 0 || fragCorners.br.h > 0 || fragCorners.bl.h > 0;
  // Rounded dashed/dotted fragments go through Blink's
  // DrawCurvedDashedDottedBoxSide exactly as block borders do. The inline
  // painter hands BoxBorderPainter the fragment rect with SidesToInclude()
  // (inline_box_fragment_painter.cc:459-461, chromium 7d859f27), and
  // PixelSnappedContouredBorderWithOutsets zeroes the excluded sides' outsets
  // (contoured_border_geometry.cc:219-250): the centerline stays one CLOSED
  // contour that runs along the fragment edge on an excluded side, its dash
  // gap is fitted to that whole contour's truncated Skia length, and the
  // excluded side, having no width, paints nothing.
  const fragmentSides = [wantTop ? sbt : null, wantRight ? sbr : null, wantBottom ? sbb : null, wantLeft ? sbl : null];
  const paintedSides = fragmentSides.filter(
    (side) => side != null && side.w > 0 && side.style !== "none" && side.style !== "hidden",
  );
  const roundContour =
    fragCorners.curvature == null || Object.values(fragCorners.curvature).every((value) => value === 2);
  if (
    anyCorner &&
    paintedSides.length > 0 &&
    paintedSides.every((side) => side?.style === "dashed" || side?.style === "dotted")
  ) {
    if (sbt != null && sidesUniformColor && allFourWanted && roundContour) {
      paintBlinkCurvedDashedDottedBorder(
        paintCtx,
        indent,
        fragCorners,
        sbt,
        Math.round(f.x),
        Math.round(f.y),
        Math.round(f.x + f.width),
        Math.round(f.y + f.height),
      );
    } else {
      const fragmentElement: CapturedElement = {
        ...element,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        styles: { ...element.styles, collapsedBorderSegments: undefined },
      };
      const [top, right, bottom, left] = fragmentSides;
      paintPerSideBorder(paintCtx, fragmentElement, indent, fragCorners, top, right, bottom, left, false);
    }
  } else if (
    sbt != null &&
    sidesUniformColor &&
    allFourWanted &&
    anyCorner &&
    sbt.w > 0 &&
    sbt.style !== "none" &&
    sbt.style !== "hidden"
  ) {
    const half = sbt.w / 2;
    const strokeCorners = insetCornerRadii(fragCorners, half, half, half, half);
    svgParts.push(
      `${indent}${roundedRectSvg(f.x + half, f.y + half, Math.max(0, f.width - sbt.w), Math.max(0, f.height - sbt.w), strokeCorners, `fill="none" stroke="${colorStr(sbt.color)}" stroke-width="${r(sbt.w)}"`)}`,
    );
  } else if (
    sbt != null &&
    sidesUniformColor &&
    anyCorner &&
    sbt.w > 0 &&
    sbt.style !== "none" &&
    sbt.style !== "hidden" &&
    ((wantTop && wantBottom && wantLeft && !wantRight) || (wantTop && wantBottom && !wantLeft && wantRight))
  ) {
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
    const fxL = f.x + half,
      fxR = f.x + f.width - half;
    const fyT = f.y + half,
      fyB = f.y + f.height - half;
    const tl = strokeCorners.tl,
      tr = strokeCorners.tr,
      br = strokeCorners.br,
      bl = strokeCorners.bl;
    let d: string;
    if (wantLeft && !wantRight) {
      // First frag: start at top-right (sharp), trace top → TL arc →
      // left → BL arc → bottom → end at bottom-right (sharp).
      d =
        `M${r(fxR)},${r(fyT)} L${r(fxL + tl.h)},${r(fyT)}` +
        (tl.h > 0 || tl.v > 0 ? ` A${r(tl.h)},${r(tl.v)} 0 0 0 ${r(fxL)},${r(fyT + tl.v)}` : "") +
        ` L${r(fxL)},${r(fyB - bl.v)}` +
        (bl.h > 0 || bl.v > 0 ? ` A${r(bl.h)},${r(bl.v)} 0 0 0 ${r(fxL + bl.h)},${r(fyB)}` : "") +
        ` L${r(fxR)},${r(fyB)}`;
    } else {
      // Last frag: start at top-left (sharp), trace top → TR arc →
      // right → BR arc → bottom → end at bottom-left (sharp).
      d =
        `M${r(fxL)},${r(fyT)} L${r(fxR - tr.h)},${r(fyT)}` +
        (tr.h > 0 || tr.v > 0 ? ` A${r(tr.h)},${r(tr.v)} 0 0 1 ${r(fxR)},${r(fyT + tr.v)}` : "") +
        ` L${r(fxR)},${r(fyB - br.v)}` +
        (br.h > 0 || br.v > 0 ? ` A${r(br.h)},${r(br.v)} 0 0 1 ${r(fxR - br.h)},${r(fyB)}` : "") +
        ` L${r(fxL)},${r(fyB)}`;
    }
    svgParts.push(`${indent}<path d="${d}" fill="none" stroke="${colorStr(sbt.color)}" stroke-width="${r(sbt.w)}" />`);
  } else {
    // Per-side strokes anchored at the inner half-width inset so they
    // sit inside the border-box (matching Chrome). For slice-mode
    // middle fragments there are no corners so straight lines suffice.
    const tw = sbt?.w ?? 0;
    const rw = sbr?.w ?? 0;
    const bw = sbb?.w ?? 0;
    const lw = sbl?.w ?? 0;
    const xL = f.x,
      xR = f.x + f.width,
      yT = f.y,
      yB = f.y + f.height;
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
  const bgClipLayers = parsePaintClipLayers(el.styles.backgroundClip);
  const bgOriginLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
  const bgBlendLayers = splitTopLevelCommas(el.styles.backgroundBlendMode ?? "normal");
  const bgAttachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
  const bgSelectedImageLayers = el.styles.backgroundImages ?? [];
  const bgIntrinsicLayers = el.styles.backgroundIntrinsic ?? [];

  const fragmentCtx: InlineFragmentCtx = {
    element: el,
    clone,
    fragsAxisIsBlock,
    hasBgImage,
    shadows,
    bgColor,
    sbt,
    sbr,
    sbb,
    sbl,
    bgImageLayers,
    bgSizeLayers,
    bgPosLayers,
    bgRepeatLayers,
    bgClipLayers,
    bgOriginLayers,
    bgBlendLayers,
    bgSelectedImageLayers,
    bgIntrinsicLayers,
    bgAttachmentLayers,
  };
  for (let fi = 0; fi < frags.length; fi++) {
    const f = frags[fi];
    const isFirst = fi === 0;
    const isLast = fi === frags.length - 1;
    const fragCorners = deriveFragmentCorners(corners, isFirst, isLast, clone, fragsAxisIsBlock);
    paintInlineFragment(
      state,
      indent,
      f,
      fragCorners,
      isFirst,
      isLast,
      fragmentCtx,
      buildBackgroundLayerDef,
      backgroundColorClipsToText,
    );
  }
}
