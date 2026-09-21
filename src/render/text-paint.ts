import type { CapturedElement, CapturedTextPaintAffine, TextSegment } from "../capture/types.js";
import { recordTextEmitterTransition } from "./text-run-provenance.js";
import { profAccum, profNow } from "./render-profile.js";
import { r } from "./format.js";
import { splitTopLevelCommas } from "./css-tokens.js";
import { parseColor, colorStr } from "./colors.js";
import { parseBoxShadow } from "./box-shadow.js";
import { renderSingleLineText, renderMultiSegmentText, renderMultiLineText, renderInputText } from "./text.js";
import { renderVerticalSegments, renderVerticalSystemFontText, hasVerticalSegments } from "./vertical-text.js";
import { getRenderTextMode } from "./font-resolution.js";
import { renderSourceOwnedTextBoundary } from "./text-to-path.js";
import { prepareAffineTextPaint, wrapAffineTextPaint } from "./text-affine.js";
import type { PaintCtx } from "./element-tree-to-svg.js";
import type { BackgroundLayerBuilder } from "./background-inline-paint.js";

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
export function emitVerticalRasterText(ctx: PaintCtx, el: CapturedElement, indent: string): void {
  const er = el.elementRaster!;
  const dataUri = er.dataUri!;
  recordTextEmitterTransition({ kind: "capture-raster", sourceText: el.text, reason: "element-raster" });
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
export function buildPseudoBoxBgLayers(
  ctx: PaintCtx,
  captureViewport: { w: number; h: number },
  pb: { x: number; y: number; width: number; height: number; backgroundImage: string; borderRadius?: number },
  buildBackgroundLayerDef: BackgroundLayerBuilder,
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
export function renderOneText(
  ctx: PaintCtx,
  opts: { el: CapturedElement; idPrefix: string; clipId: string; fillColor: string; overflowClip?: boolean; affineMatrix?: CapturedTextPaintAffine },
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
    if (hasVerticalSegments(opts.el)) {
      // DM-ZDDJAG: in system-font mode, emit ONE authored <text> with
      // writing-mode/text-orientation and let the browser lay out the column
      // (correct sideways rotation + a selectable run); the fidelity modes keep
      // the per-char rotated segments.
      if (getRenderTextMode() === "system-font") {
        return wrapAffineTextPaint(opts.affineMatrix, renderVerticalSystemFontText(opts.el, opts.fillColor));
      }
      return wrapAffineTextPaint(opts.affineMatrix, renderVerticalSegments(opts.el, opts.fillColor));
    }
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
export function resolveTextFill(
  ctx: PaintCtx,
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  textBgClipFills: string[],
  captureViewport: { w: number; h: number },
  buildBackgroundLayerDef: BackgroundLayerBuilder,
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
    // pre-fix behavior where each child re-runs the gradient over
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
export function paintText(
  ctx: PaintCtx,
  el: CapturedElement,
  textColor: ReturnType<typeof parseColor>,
  indent: string,
  textBgClipFills: string[],
  captureViewport: { w: number; h: number },
  textBgClipFragmentFills: (string[] | null)[] = [],
  textBgClipFragmentRects: NonNullable<CapturedElement["inlineFragments"]> | null = null,
  buildBackgroundLayerDef: BackgroundLayerBuilder,
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
    const { fillColor, textIsTransparent } = resolveTextFill(ctx, el, textColor, textBgClipFills, captureViewport, buildBackgroundLayerDef);
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
      buildPseudoBoxBgLayers(ctx, captureViewport, pb, buildBackgroundLayerDef);

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
        styles: {
          ...el.styles,
          webkitTextStrokeColor: shadowFillColor,
          textDecorationColor: shadowFillColor,
        },
        propagatedDecorations: el.propagatedDecorations?.map((decoration) => ({
          ...decoration,
          color: shadowFillColor,
        })),
        x: el.x + sh.x,
        y: el.y + sh.y,
        textLeft: el.textLeft != null ? el.textLeft + sh.x : undefined,
        textTop: el.textTop != null ? el.textTop + sh.y : undefined,
        textSegments: el.textSegments?.map((s) => ({
          ...s,
          color: shadowFillColor,
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
      // Patterned text decorations derive their local clip ids from `clipId`.
      // A shadow is a second rendering of the same run, so reusing the main
      // text id produces duplicate SVG ids; the first (shifted) shadow clip can
      // then clip the foreground decoration. The shadow does not use the
      // element overflow clip, so a unique token is sufficient here.
      const shadowClipId = ctx.nextClipId("tsd");
      let body = renderOneText(ctx, { el: shifted, idPrefix: ctx.idPrefix, clipId: shadowClipId, fillColor: shadowFillColor, affineMatrix }, emit);
      if (sh.blur > 0) {
        const stdDev = sh.blur / 2;
        const fid = ctx.nextClipId("tsh");
        ctx.defsParts.push(
          `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceAlpha" stdDeviation="${r(stdDev)}" result="blur"/><feFlood flood-color="${shadowFillColor}" result="color"/><feComposite in="color" in2="blur" operator="in"/></filter>`,
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
            color: segShadowFill,
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
          const shadowEl: CapturedElement = {
            ...el,
            styles: {
              ...el.styles,
              webkitTextStrokeColor: segShadowFill,
              textDecorationColor: segShadowFill,
            },
            propagatedDecorations: el.propagatedDecorations?.map((decoration) => ({
              ...decoration,
              color: segShadowFill,
            })),
          };
          const shadowClipId = ctx.nextClipId("tsd");
          let segBody = wrapAffineTextPaint(affineMatrix, renderMultiSegmentText({ el: shadowEl, idPrefix: ctx.idPrefix, clipId: shadowClipId, fillColor: segShadowFill, emitPseudoBoxBgLayers: emit }, [shiftedSeg]));
          if (sh.blur > 0) {
            const stdDev = sh.blur / 2;
            const fid = ctx.nextClipId("tssh");
            ctx.defsParts.push(
              `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceAlpha" stdDeviation="${r(stdDev)}" result="blur"/><feFlood flood-color="${segShadowFill}" result="color"/><feComposite in="color" in2="blur" operator="in"/></filter>`,
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
    if (hasTextBgClip) {
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
      // Blink's PaintPhase::kTextClip keeps TextStrokeWidth and replaces all
      // paint colors with an opaque color because the DstIn operation reads
      // ALPHA, not luminance. Preserve that geometry here—including author
      // stroke ink—and opt the SVG mask into alpha semantics. The old
      // luminance mask made a black stroke disappear and consequently dropped
      // the stroke from the mask, which diverged for transparent/semitransparent
      // foreground strokes.
      const maskFillEl: CapturedElement = { ...el, styles: { ...el.styles, color: "rgb(255,255,255)", webkitTextFillColor: "rgb(255,255,255)", webkitTextStrokeColor: "rgb(255,255,255)" } };
      const maskBody = renderOneText(ctx, { el: maskFillEl, idPrefix: ctx.idPrefix, clipId: cid, fillColor: "rgb(255,255,255)", overflowClip: textOverflowClip, affineMatrix }, emit);
      const mid = ctx.nextClipId("tbgm");
      ctx.defsParts.push(
        `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${r(sourceEl.x)}" y="${r(sourceEl.y)}" width="${r(sourceEl.width)}" height="${r(sourceEl.height)}" style="mask-type:alpha">${maskBody}</mask>`,
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
        if (fragFills != null && textBgClipFragmentRects != null) {
          for (let fi = 0; fi < textBgClipFragmentRects.length; fi++) {
            const fr = textBgClipFragmentRects[fi];
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
      // background-clip affects the element background, not its foreground.
      // With an opaque/semitransparent text fill Blink paints the normal text
      // after the masked background. Transparent fill keeps the dedicated
      // stroke-only pass above so no invisible duplicate is emitted.
      if (!textIsTransparent) {
        ctx.svgParts.push(`${indent}${renderOneText(ctx, renderOpts, emit)}`);
      }
    } else {
      ctx.svgParts.push(`${indent}${renderOneText(ctx, renderOpts, emit)}`);
    }
    }
  }
  return;
}

