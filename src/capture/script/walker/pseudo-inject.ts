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
        // Flush the ::before just left of the host's first OWN text segment.
        const flushX = firstSeg.x - p.seg.width - (bs.padR || 0) - (bs.borR || 0) - mRb;
        // DM-1105: `firstSeg` is the host's first OWN-text run, which is NOT the
        // leftmost content when the host's content begins with a CHILD element —
        // e.g. a syntax-highlight token span in a code diff:
        // `<span class="code"><span class="kw">import</span> { … }</span>` with a
        // `.code::before { content: "+" }` gutter marker. There `firstSeg` is the
        // ` { … }` text AFTER the token span, so the flush anchor lands the "+"
        // mid-line. Chrome paints a static ::before at the host's content-box
        // left and shifts ALL following content (child spans included) right past
        // it; pseudo-content.ts already put that content-box-left position in
        // `p.seg.x`. The flush anchor is only valid when it doesn't push the
        // marker RIGHT of that position, so clamp to it — the marker lands at the
        // line start instead of mid-line, and the normal own-text-first case is
        // unchanged (the two agree there).
        p.seg.x = Math.min(flushX, p.seg.x);
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
        // DM-926: when the host is a flex container with a non-default
        // `justify-content` (e.g. `summary { display: flex;
        // justify-content: space-between }` for a `<details>` accordion
        // marker), the ::after isn't laid out flush after the last
        // text segment — it's pushed to the right edge by the flex
        // distribution. The xPos pseudo-content.ts pre-computed
        // (`elLeft + rect.width - pseudoWidth - 2 × padR`) IS the
        // right-edge position; KEEP it instead of overwriting with the
        // adjacent-to-text anchor that's wrong here.
        const hcs = window.getComputedStyle(el);
        const hostIsFlex = hcs.display === 'flex' || hcs.display === 'inline-flex';
        const hostJc = hcs.justifyContent;
        const flexSpread = hostIsFlex && hostJc != null && hostJc !== ''
          && hostJc !== 'flex-start' && hostJc !== 'start' && hostJc !== 'normal';
        if (flexSpread) {
          // Keep p.seg.x as computed by pseudo-content.ts; only re-anchor y / height.
          p.seg.y = lastSeg.y;
          p.seg.height = lastSeg.height;
        } else {
        p.seg.x = lastSeg.x + lastSeg.width + mLa + (bs.borL || 0) + (bs.padL || 0);
        p.seg.y = lastSeg.y;
        p.seg.height = lastSeg.height;
        }
        // DM-944: when the host element's painted box extends BELOW the
        // last main-text line by more than one line-height, Chrome wrapped
        // the ::after content to a new line because it didn't fit on the
        // current line. Detect that gap by comparing the host's
        // `getBoundingClientRect().bottom` (which DOES include the
        // pseudo's painted area) to the last text segment's bottom
        // (which doesn't). If the gap is ≥ ~80% of one line-height, the
        // pseudo wrapped — bump `p.seg.y` down by the gap and reset its
        // x to the host's content-box left edge so the renderer paints
        // it on the new line at the host's left margin like Chrome did.
        const elRect = el.getBoundingClientRect();
        const ecs = window.getComputedStyle(el);
        const pdL = parseFloat(ecs.paddingLeft) || 0;
        const bdL = parseFloat(ecs.borderLeftWidth) || 0;
        const lastBottom = lastSeg.y + lastSeg.height;
        const elBottom = elRect.bottom - (parseFloat(ecs.paddingBottom) || 0) - (parseFloat(ecs.borderBottomWidth) || 0);
        const wrapThreshold = lastSeg.height * 0.8;
        if (elBottom - lastBottom >= wrapThreshold) {
          p.seg.x = elRect.x + bdL + pdL;
          p.seg.y = lastBottom; // start of the next line
        }
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
      // DM-626: when the rasterRect was sized to the host element's full
      // painted box (icon-font PUA case where the visible glyph paints
      // outside the canvas advance-width — `walker/pseudo-content.ts`
      // widens the rasterRect to the host rect for those), don't
      // re-anchor — the rasterRect already covers the right viewport
      // region and shifting it by margin-left+borderL+paddingL would
      // displace the screenshot off Chromium's painted output.
      if (p.seg.rasterRect != null) {
        const isHostSized = p.seg.rasterRect.width > p.seg.width + 1;
        if (!isHostSized) {
          p.seg.rasterRect.x = p.seg.x;
          p.seg.rasterRect.y = p.seg.y;
          p.seg.rasterRect.height = p.seg.height;
        }
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
            // DM-782: gradient/url() bg-image plumbing — renderer threads
            // each comma-separated layer through `buildBackgroundLayerDef`
            // and paints rect(s) behind the glyphs (mirrors the empty-
            // content pseudoBox path in `element-tree-to-svg.ts`).
            backgroundImage: bs.backgroundImage,
            borderRadius: bs.borderRadius,
            borderWidth: bs.borderWidth,
            borderColor: bs.borderColor,
            // Per-side widths + colors for non-uniform borders (e.g. a
            // bare `border-bottom` on a pseudo). Width fields are always
            // emitted so the renderer doesn't have to fall back to zero
            // when a `borderWidth` (uniform) shorthand is absent.
            borL: bs.borL, borR: bs.borR, borT: bs.borT, borB: bs.borB,
            borderTopColor: bs.borderTopColor,
            borderRightColor: bs.borderRightColor,
            borderBottomColor: bs.borderBottomColor,
            borderLeftColor: bs.borderLeftColor,
            // DM-783: pseudo's `transform` + `transformOrigin`. Renderer
            // wraps the box + glyphs in a pre-baked
            // translate-(transform)-translate matrix so the rotation/scale
            // pivots around the box-relative origin instead of (0,0).
            transform: bs.transform,
            transformOrigin: bs.transformOrigin,
          };
        }
      }
      // DM-1066: ::before content reads BEFORE the host text, ::after AFTER it.
      // (Previously both prepended, so an ::after landed before the host text in
      // the accessibility/search string.) `text` starts as the host text, so
      // prepend for before-pseudos and append for after-pseudos — yielding
      // `before + host + after` regardless of pseudo iteration order.
      text = p.isBefore ? p.seg.text + ' ' + text : text + ' ' + p.seg.text;
    }

    return { pseudoImages, text, textLeft, textTop, textWidth, textHeight, fontAscent };
  };

  return { injectPseudoSegments };
};
