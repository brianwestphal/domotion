// @ts-nocheck
//
// Pseudo-element injection. Consumes the `pseudoSegments` array produced
// by `walker/pseudo-content.ts` and:
//
//   - Re-anchors each pseudo's `seg.x` / `seg.y` against the captured
//     main `textSegments`. `walker/pseudo-content.ts` ran before text
//     shaping completed, so the pseudo positions it returned were
//     relative to the host's padding box; here we shift them to sit
//     flush against the real text boundaries.
//
//   - Splits pseudos by route:
//
//       1. **Image pseudos** (`content: url(...)`) → pushed onto
//          `pseudoImages`. The image paints at the inline-block's
//          content-box top-left; we compute that x from
//          `firstSeg.x - layoutWidth - padR - borR - marginR` for
//          `::before` and `lastSegEnd + marginL + borderL + paddingL`
//          for `::after`. The image itself paints at `renderWidth /
//          Height` and can overflow right/down.
//
//       2. **Positioned text pseudos** (DM-495, position: absolute /
//          fixed / relative offsets) → pushed onto `textSegments` at
//          their pre-computed anchor without flow alignment.
//
//       3. **In-flow text pseudos** → unshift (`::before`) or push
//          (`::after`) with `seg.x / seg.y / seg.height` re-anchored
//          against the adjacent main segment. When the pseudo carries
//          its own `boxStyles` (DM-497 badge / pill pattern) we subtract
//          its outer-box advance (margin + border + padding) so the
//          text content lands at the correct inset.
//
//   - When a pseudo is the only segment on the element (DM-495 trailing
//     icon, in-flow ::before-only chevron, …), propagate its bounds up
//     to the element's `textLeft / textTop / textWidth / textHeight /
//     fontAscent` so the renderer's single-segment path positions and
//     sizes the text from the pseudo (otherwise those locals stay 0 and
//     the text paints at the SVG origin).
//
//   - Re-anchors `seg.rasterRect` to the post-injection x/y so the
//     post-capture screenshot lands on the painted pixels, not the
//     pre-anchored position pseudo-content.ts originally computed.
//
//   - DM-497 `pseudoBox`: once `seg.x / y` is in its final viewport-
//     relative position, compute the pseudo's own paint box for
//     `::before` / `::after` with background-color / border-radius /
//     uniform border (badge / pill / chip patterns). Inline-box bg
//     paints at `lineH + padding` (not fontSize); we derive the
//     vertical anchor from `lineCenter - lineH/2 - padT - borT` so
//     the box centers on the line box.
//
//   - Concatenates pseudo text into the host element's captured `text`
//     — `::before` text prepends, `::after` appends. (Used for
//     accessibility / search-target output; the per-segment text in
//     `textSegments[]` is what the renderer reads for path emission.)
//
// Returns a state delta — the dispatcher reassigns `text` /
// `pseudoImages` / `textLeft / Top / Width / Height / fontAscent`
// from the result, and the in-place mutation of `textSegments` is
// visible to the caller through the shared array reference.

export const createPseudoInjectHandler = () => {
  const injectPseudoSegments = (el, pseudoSegments, textSegments, state) => {
    const pseudoImages = [];
    let { text, textLeft, textTop, textWidth, textHeight, fontAscent } = state;

    for (const p of pseudoSegments) {
      if (p.imageUrl) {
        const mL = p.boxMarginLeft || 0;
        const mR = p.boxMarginRight || 0;
        const bL = p.boxBorderLeft || 0;
        const bR = p.boxBorderRight || 0;
        const pL = p.boxPaddingLeft || 0;
        const pR = p.boxPaddingRight || 0;
        if (p.isBefore && textSegments.length > 0) {
          const firstSeg = textSegments[0];
          p.seg.x = firstSeg.x - p.seg.width - pR - bR - mR;
          p.seg.y = firstSeg.y + (firstSeg.height - p.seg.height) / 2;
        } else if (!p.isBefore && textSegments.length > 0) {
          const lastSeg = textSegments[textSegments.length - 1];
          p.seg.x = lastSeg.x + lastSeg.width + mL + bL + pL;
          p.seg.y = lastSeg.y + (lastSeg.height - p.seg.height) / 2;
        }
        pseudoImages.push({
          url: p.imageUrl,
          x: p.seg.x, y: p.seg.y,
          width: p.renderWidth, height: p.renderHeight,
        });
        continue;
      }

      if (p.isPositioned) {
        // Positioned pseudo paints at its own anchor — do NOT realign
        // to the parent's text flow (DM-495).
        if (p.isBefore) textSegments.unshift(p.seg);
        else textSegments.push(p.seg);
      } else if (p.isBefore && textSegments.length > 0) {
        // Offset by measured width before the first real segment's x.
        // When the pseudo carries its own margin / border / padding
        // (DM-497 badge pattern), the text content is inset further
        // so subtract the right-side outer-box advance from the anchor.
        const firstSeg = textSegments[0];
        const bs = p.boxStyles || {};
        const mRb = parseFloat(window.getComputedStyle(el, '::before').marginRight) || 0;
        p.seg.x = firstSeg.x - p.seg.width - (bs.padR || 0) - (bs.borR || 0) - mRb;
        p.seg.y = firstSeg.y;
        p.seg.height = firstSeg.height;
        textSegments.unshift(p.seg);
      } else if (!p.isBefore && textSegments.length > 0) {
        // ::after sits to the right of the parent's trailing text.
        // When the pseudo has its own margin / padding / border
        // (DM-497), the text content is offset by margin-left +
        // border-left + padding-left from the parent's text right edge.
        const lastSeg = textSegments[textSegments.length - 1];
        const bs = p.boxStyles || {};
        const mLa = parseFloat(window.getComputedStyle(el, '::after').marginLeft) || 0;
        p.seg.x = lastSeg.x + lastSeg.width + mLa + (bs.borL || 0) + (bs.padL || 0);
        p.seg.y = lastSeg.y;
        p.seg.height = lastSeg.height;
        textSegments.push(p.seg);
      } else {
        // No main text — just place at element origin (already set by
        // pseudo-content.ts using elLeft/elTop).
        textSegments.push(p.seg);
      }

      // DM-495: pseudo-only segments propagate their bounds up.
      if (textSegments.length === 1 && textSegments[0] === p.seg) {
        textLeft = p.seg.x;
        textTop = p.seg.y;
        textWidth = p.seg.width;
        textHeight = p.seg.height;
        if (p.seg.fontAscent != null) fontAscent = p.seg.fontAscent;
      }

      // Re-anchor rasterRect to the final (post-injection) seg.x/y.
      if (p.seg.rasterRect != null) {
        p.seg.rasterRect.x = p.seg.x;
        p.seg.rasterRect.y = p.seg.y;
        p.seg.rasterRect.height = p.seg.height;
      }

      // DM-497: compute the pseudo's own paint box for ::before /
      // ::after with background-color / border-radius / uniform border.
      // Inline-box bg paints at lineH + padding (not fontSize); the
      // box top sits at lineCenter - lineH/2 - padT - borT where
      // lineCenter is derived from p.seg.y (text-top) and the pseudo
      // fontSize.
      if (p.boxStyles != null) {
        const bs = p.boxStyles;
        const lineCenter = p.seg.y + bs.fontSize / 2;
        const boxTop = lineCenter - bs.lineH / 2 - bs.padT - bs.borT;
        const bx = p.seg.x - bs.padL - bs.borL;
        const bw = p.seg.width + bs.padL + bs.padR + bs.borL + bs.borR;
        const bh = bs.lineH + bs.padT + bs.padB + bs.borT + bs.borB;
        if (bw > 0 && bh > 0) {
          p.seg.pseudoBox = {
            x: bx, y: boxTop, width: bw, height: bh,
            backgroundColor: bs.backgroundColor,
            borderRadius: bs.borderRadius,
            borderWidth: bs.borderWidth,
            borderColor: bs.borderColor,
          };
        }
      }
      text = (p.isBefore ? p.seg.text + ' ' : ' ' + p.seg.text) + text;
    }

    return { pseudoImages, text, textLeft, textTop, textWidth, textHeight, fontAscent };
  };

  return { injectPseudoSegments };
};
