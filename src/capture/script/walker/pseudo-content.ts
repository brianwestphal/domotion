// @ts-nocheck
//
// `::before` / `::after` generated-content capture. Each matched pseudo's
// content string is parsed and turned into a TextSegment (or image-pseudo)
// positioned relative to the host element's content box. The capture
// produces an array of `pseudoSegments` that captureInner's downstream
// text-segments assembler converts into the final `pseudoImages` /
// in-flow textSegments emission.
//
// Content sources handled:
//
//   - String literals: `"text"` / `'text'`
//   - `attr(name)` lookups
//   - `url(...)` (rendered as `<image>` with intrinsic dims captured here)
//   - `counter(name)` / `counters(name, sep)` resolved against the
//     element's snapshot of active CSS counter scopes (built in the
//     pre-walk; passed in as `counterSnapshot`). counter-style argument
//     (third arg of counters, second of counter) is currently ignored —
//     decimal is the only output style. DM-357.
//   - `open-quote` / `close-quote` resolved against the element's
//     computed `quotes` property at the current q-element nesting depth.
//     Falls back to English curly defaults when `quotes` is missing /
//     auto / none. DM-367 / DM-376.
//   - `no-open-quote` / `no-close-quote`: consume nesting-depth state
//     without emitting glyphs.
//
// Positioning paths:
//
//   - **Positioned pseudo** (position: absolute / fixed): anchor on the
//     host's padding box using pcs.left/top (with right/bottom fallback
//     that subtracts the full box dims so `+= padL/T + borL/T` lands
//     on the text edge — DM-507). Vertical centering uses
//     `(lineH - fontSize) / 2`.
//
//   - **In-flow pseudo** (the common case): xPos at the host's content
//     left for `::before` or content-right − pseudoWidth − 2·padR for
//     `::after`; yPos centered on the host's line box.
//
// Output also carries:
//
//   - `pseudoSeg.rasterRect` when the pseudo contains a codepoint Chrome
//     paints via a color-bitmap font (emoji, U+2713, etc.) so the Node-
//     side raster pass can screenshot it.
//   - Per-pseudo background-color / border-radius / uniform border in
//     `boxStyles` (the downstream text-segments assembler will compute
//     the final pseudoBox rect once it re-anchors seg.x/y against the
//     host's real text boundaries — DM-497).
//
// What stays in captureInner: the post-loop reassembly that
// re-anchors pseudoSeg.x/y against the captured text positions, the
// pseudoImages array construction (consumes `imageUrl` from pseudoSegments
// entries), and everything that mixes pseudo positioning with the
// element's own textSegments. Those depend on text shaping state that
// hasn't been pulled out of captureInner yet — follow-up.

export const createPseudoContentHandler = ({ vp, normColor, measureFontMetrics, textNeedsRaster }) => {
  const pickQuoteChar = (forEl, isOpen) => {
    // Count q-element ancestors above this element (depth=0 = the first q
    // not inside another q). The pseudo lives ON forEl so when forEl IS a
    // q, its own depth = ancestorQ count. When forEl is some other element
    // with a manual `::before { content: open-quote }`, depth is ancestorQ
    // count too (manual content treated as outer-level text).
    let depth = 0;
    let p = forEl.parentElement;
    while (p != null) {
      if (p.tagName === 'Q') depth++;
      p = p.parentElement;
    }
    const cs = window.getComputedStyle(forEl).quotes;
    if (cs == null || cs === '' || cs === 'none' || cs === 'auto') {
      const pairs = [['“', '”'], ['‘', '’']];
      const pair = pairs[Math.min(depth, pairs.length - 1)];
      return isOpen ? pair[0] : pair[1];
    }
    // Parse the CSS quotes string: a sequence of double-quoted strings
    // (CSS escapes any quote char). Example: `"« " " »" "“ " " ”"`. Walk
    // and extract one string per token, alternating open/close.
    const tokens = [];
    let i = 0;
    while (i < cs.length) {
      if (cs[i] === '"') {
        let j = i + 1;
        let s = '';
        while (j < cs.length && cs[j] !== '"') {
          if (cs[j] === '\\') { s += cs[j + 1]; j += 2; } else { s += cs[j]; j++; }
        }
        tokens.push(s);
        i = j + 1;
      } else {
        i++;
      }
    }
    if (tokens.length < 2) {
      const pair = ['“', '”'];
      return isOpen ? pair[0] : pair[1];
    }
    const pairIdx = Math.min(depth, Math.floor((tokens.length - 1) / 2));
    return isOpen ? tokens[pairIdx * 2] : tokens[pairIdx * 2 + 1];
  };

  const capturePseudoContent = (el, cs, rect, counterSnapshot) => {
    const pseudoSegments = [];
    const pseudoBoxes = [];
    for (const pseudo of ['::before', '::after']) {
      const pcs = window.getComputedStyle(el, pseudo);
      const content = pcs.content;
      if (content == null || content === 'none' || content === 'normal' || content === '') continue;

      let text = '';
      let imageUrl = '';
      let i = 0;
      while (i < content.length) {
        const c = content[i];
        if (c === '"' || c === "'") {
          const end = content.indexOf(c, i + 1);
          if (end < 0) break;
          text += content.slice(i + 1, end);
          i = end + 1;
        } else if (content.startsWith('attr(', i)) {
          const end = content.indexOf(')', i);
          if (end < 0) break;
          const attrName = content.slice(i + 5, end).trim();
          text += el.getAttribute(attrName) || '';
          i = end + 1;
        } else if (content.startsWith('url(', i)) {
          const end = content.indexOf(')', i);
          if (end < 0) break;
          let url = content.slice(i + 4, end).trim();
          if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
            url = url.slice(1, -1);
          }
          imageUrl = url;
          i = end + 1;
        } else if (content.startsWith('counter(', i) || content.startsWith('counters(', i)) {
          const isCounters = content.startsWith('counters(', i);
          const openIdx = i + (isCounters ? 'counters('.length : 'counter('.length);
          const closeIdx = content.indexOf(')', openIdx);
          if (closeIdx < 0) { i++; continue; }
          const args = content.slice(openIdx, closeIdx).split(',').map((s) => {
            const t = s.trim();
            if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
              return t.slice(1, -1);
            }
            return t;
          });
          const cname = args[0];
          const sep = isCounters ? (args[1] ?? '') : '';
          // counter-style argument (third arg of counters, second of
          // counter) is currently ignored — decimal-only. Most fixtures
          // use the default style; non-decimal can be added later.
          const snapshot = counterSnapshot.get(el) || [];
          const matches = snapshot.filter((s) => s.name === cname).map((s) => String(s.value));
          if (isCounters) {
            text += matches.length > 0 ? matches.join(sep) : '0';
          } else {
            text += matches.length > 0 ? matches[matches.length - 1] : '0';
          }
          i = closeIdx + 1;
        } else if (content.startsWith('open-quote', i)) {
          text += pickQuoteChar(el, true);
          i += 'open-quote'.length;
        } else if (content.startsWith('close-quote', i)) {
          text += pickQuoteChar(el, false);
          i += 'close-quote'.length;
        } else if (content.startsWith('no-open-quote', i)) {
          i += 'no-open-quote'.length;
        } else if (content.startsWith('no-close-quote', i)) {
          i += 'no-close-quote'.length;
        } else {
          i++;
        }
      }
      if (text === '' && imageUrl === '') {
        // Empty-content pseudo. The author might be using the pseudo as a
        // decorative box — common pattern for inline separators (DM-579:
        // `.css-mx1q46::before { content: ""; height: 0; border-bottom: 2px
        // solid #121212 }` paints a hairline between sections). Capture
        // the box rect + per-side border / background only when the
        // pseudo is `display: block` and has at least one non-zero border
        // side or a visible background.
        const bgRaw = pcs.backgroundColor;
        const hasBg = bgRaw && bgRaw !== '' && bgRaw !== 'rgba(0, 0, 0, 0)' && bgRaw !== 'transparent';
        const bwT = parseFloat(pcs.borderTopWidth) || 0;
        const bwR = parseFloat(pcs.borderRightWidth) || 0;
        const bwB = parseFloat(pcs.borderBottomWidth) || 0;
        const bwL = parseFloat(pcs.borderLeftWidth) || 0;
        const hasBorder = bwT > 0 || bwR > 0 || bwB > 0 || bwL > 0;
        const isBlockLike = pcs.display === 'block' || pcs.display === 'inline-block' || pcs.display === 'flex';
        if (isBlockLike && (hasBg || hasBorder)) {
          const hostPadL = parseFloat(cs.paddingLeft) || 0;
          const hostPadT = parseFloat(cs.paddingTop) || 0;
          const hostBorL = parseFloat(cs.borderLeftWidth) || 0;
          const hostBorT = parseFloat(cs.borderTopWidth) || 0;
          const hostBorR = parseFloat(cs.borderRightWidth) || 0;
          const pMarL = parseFloat(pcs.marginLeft) || 0;
          const pPadL = parseFloat(pcs.paddingLeft) || 0;
          const pPadR = parseFloat(pcs.paddingRight) || 0;
          const pPadT = parseFloat(pcs.paddingTop) || 0;
          const pPadB = parseFloat(pcs.paddingBottom) || 0;
          // Pseudo width / height come from computed style. `width: 350px`
          // resolves directly; `auto` falls back to host content width
          // (minus host padding).
          const hostContentW = rect.width - hostBorL - hostBorR - hostPadL - (parseFloat(cs.paddingRight) || 0);
          const pcsW = parseFloat(pcs.width);
          const pcsH = parseFloat(pcs.height);
          const contentW = !isNaN(pcsW) ? pcsW : hostContentW - pMarL - (parseFloat(pcs.marginRight) || 0);
          const contentH = !isNaN(pcsH) ? pcsH : 0;
          const borderBoxW = contentW + pPadL + pPadR + bwL + bwR;
          const borderBoxH = contentH + pPadT + pPadB + bwT + bwB;

          // Position: absolute pseudos use pcs.left / pcs.top relative to
          // the host's padding box (DM-594: speech-bubble tails). Static
          // pseudos flow at the host's content-box top-left.
          let borderBoxX;
          let borderBoxY;
          if (pcs.position === 'absolute' || pcs.position === 'fixed') {
            const pcsLeft = parseFloat(pcs.left);
            const pcsTop = parseFloat(pcs.top);
            const pcsRight = parseFloat(pcs.right);
            const pcsBottom = parseFloat(pcs.bottom);
            const paddingBoxL = rect.left - vp.x + hostBorL;
            const paddingBoxT = rect.top - vp.y + hostBorT;
            const paddingBoxR = rect.right - vp.x - hostBorR;
            const paddingBoxB = rect.bottom - vp.y - (parseFloat(cs.borderBottomWidth) || 0);
            if (!isNaN(pcsLeft)) borderBoxX = paddingBoxL + pcsLeft;
            else if (!isNaN(pcsRight)) borderBoxX = paddingBoxR - pcsRight - borderBoxW;
            else borderBoxX = paddingBoxL;
            if (!isNaN(pcsTop)) borderBoxY = paddingBoxT + pcsTop;
            else if (!isNaN(pcsBottom)) borderBoxY = paddingBoxB - pcsBottom - borderBoxH;
            else borderBoxY = paddingBoxT;
          } else {
            const pMarT = parseFloat(pcs.marginTop) || 0;
            borderBoxX = rect.left - vp.x + hostBorL + hostPadL + pMarL;
            borderBoxY = rect.top - vp.y + hostBorT + hostPadT + pMarT;
          }
          if (borderBoxW > 0 && borderBoxH > 0) {
            pseudoBoxes.push({
              x: borderBoxX,
              y: borderBoxY,
              width: borderBoxW,
              height: borderBoxH,
              backgroundColor: hasBg ? normColor(bgRaw) : undefined,
              borderTopWidth: bwT, borderTopColor: bwT > 0 ? normColor(pcs.borderTopColor) : undefined, borderTopStyle: pcs.borderTopStyle,
              borderRightWidth: bwR, borderRightColor: bwR > 0 ? normColor(pcs.borderRightColor) : undefined, borderRightStyle: pcs.borderRightStyle,
              borderBottomWidth: bwB, borderBottomColor: bwB > 0 ? normColor(pcs.borderBottomColor) : undefined, borderBottomStyle: pcs.borderBottomStyle,
              borderLeftWidth: bwL, borderLeftColor: bwL > 0 ? normColor(pcs.borderLeftColor) : undefined, borderLeftStyle: pcs.borderLeftStyle,
              borderRadius: parseFloat(pcs.borderRadius) || 0,
            });
          }
        }
        continue;
      }

      // url() content -> emit as an image pseudo. Chrome decouples LAYOUT
      // from RENDER: the CSS box (pcs.width / pcs.height) drives how far
      // following inline text is shifted, but the image itself paints at
      // its INTRINSIC dimensions regardless of the CSS box — overflowing
      // down/right when the box is smaller than intrinsic. We track both:
      // seg.width/height carry the LAYOUT box; renderWidth/renderHeight
      // carry the paint size for the <image> element. SK-1057.
      if (imageUrl !== '' && text === '') {
        const probeImg = new Image();
        probeImg.src = imageUrl;
        // Playwright waits for load before capture, so naturalWidth /
        // Height resolve synchronously from cache.
        const intrinsicW = probeImg.naturalWidth || 0;
        const intrinsicH = probeImg.naturalHeight || 0;
        let layoutW = parseFloat(pcs.width) || 0;
        let layoutH = parseFloat(pcs.height) || 0;
        if (layoutW <= 0) layoutW = intrinsicW || 24;
        if (layoutH <= 0) layoutH = intrinsicH || 24;
        const renderW = intrinsicW > 0 ? intrinsicW : layoutW;
        const renderH = intrinsicH > 0 ? intrinsicH : layoutH;
        const elTop = rect.top - vp.y + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
        const elLeft = rect.left - vp.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
        const elFontSizeForImg = parseFloat(pcs.fontSize) || 14;
        const lineHImg = parseFloat(pcs.lineHeight) || elFontSizeForImg * 1.2;
        // Vertically center the LAYOUT box in the line; the image paints
        // from this anchor at render dims (may overflow downward).
        const yPosImg = elTop + (lineHImg - layoutH) / 2;
        // Capture the inline-block's outer-box horizontal contributions:
        // following text is shifted by (marginL + borderL + paddingL +
        // width + paddingR + borderR + marginR) but the IMAGE paints at
        // the content-box top-left = (outerLeft + marginL + borderL +
        // paddingL). Without these we lose marginR / paddingR / borderR
        // — DM-453 (.img-before with margin-right:6px rendered 6px right
        // of Chrome).
        pseudoSegments.push({
          isBefore: pseudo === '::before',
          imageUrl,
          seg: { text: '', x: elLeft, y: yPosImg, width: layoutW, height: layoutH },
          renderWidth: renderW,
          renderHeight: renderH,
          color: pcs.color,
          boxMarginLeft: parseFloat(pcs.marginLeft) || 0,
          boxMarginRight: parseFloat(pcs.marginRight) || 0,
          boxBorderLeft: parseFloat(pcs.borderLeftWidth) || 0,
          boxBorderRight: parseFloat(pcs.borderRightWidth) || 0,
          boxPaddingLeft: parseFloat(pcs.paddingLeft) || 0,
          boxPaddingRight: parseFloat(pcs.paddingRight) || 0,
        });
        continue;
      }
      if (text === '') continue;

      // Measure via canvas using the pseudo's computed font.
      const fontSpec = pcs.font || (pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily);
      const measureCanvas = document.createElement('canvas');
      const mctx = measureCanvas.getContext('2d');
      mctx.font = fontSpec;
      // DM-507: prefer Chrome's resolved layout width over
      // canvas.measureText when available. For position:absolute pseudos
      // with auto-width Chrome shrink-to-fits the box and
      // getComputedStyle returns the resolved content-box width.
      // canvas.measureText drifts ~1-2px from Chrome's actual layout in
      // common bold / symbol-mix fixtures because the canvas font-
      // shaping path differs slightly from Chrome's HarfBuzz paint
      // pipeline. Falling back to canvas measurement when pcs.width is
      // unavailable (typical for non-positioned inline pseudos) keeps
      // the existing path.
      let pseudoWidth = mctx.measureText(text).width;
      if (pcs.position === 'absolute' || pcs.position === 'fixed') {
        const pcsW = parseFloat(pcs.width);
        if (!isNaN(pcsW) && pcsW > 0) pseudoWidth = pcsW;
      }

      // Position: ::before sits at the START of the host's text/content.
      // ::after sits at the END. We fall back to (elLeft, elTop) here
      // because the host's textLeft/textWidth aren't yet known — the
      // captureInner text-segments assembler re-anchors seg.x/y after
      // capturing the host's real text positions.
      const elTop = rect.top - vp.y + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
      const elLeft = rect.left - vp.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
      const elFontSize = parseFloat(pcs.fontSize) || 14;
      const lineH = parseFloat(pcs.lineHeight) || elFontSize * 1.2;
      // CSS lets ::before / ::after override font-size independent of
      // the host, so the captured ascent must come from the pseudo's
      // computed font, not the element's. Renderer uses seg.fontAscent
      // when present and falls back to el.fontAscent otherwise.
      const pseudoMetrics = measureFontMetrics(pcs);

      let xPos;
      let yPos;
      let pseudoIsPositioned = false;
      if (pcs.position === 'absolute' || pcs.position === 'fixed') {
        // Containing block for absolute is the nearest positioned
        // ancestor's padding box; for the pseudo, that ancestor is el
        // when el is positioned, otherwise the chain Chromium resolved.
        // The simple case we handle: the pseudo left/top are resolved
        // against el's padding box (true when el is the offsetParent —
        // the common case since authors typically position the host to
        // anchor the pseudo).
        const pcsLeft = parseFloat(pcs.left);
        const pcsTop = parseFloat(pcs.top);
        const pcsRight = parseFloat(pcs.right);
        const pcsBottom = parseFloat(pcs.bottom);
        const paddingBoxLeft = rect.left - vp.x + (parseFloat(cs.borderLeftWidth) || 0);
        const paddingBoxTop = rect.top - vp.y + (parseFloat(cs.borderTopWidth) || 0);
        const paddingBoxRight = rect.right - vp.x - (parseFloat(cs.borderRightWidth) || 0);
        const paddingBoxBottom = rect.bottom - vp.y - (parseFloat(cs.borderBottomWidth) || 0);
        // DM-507: anchor xPos / yPos at the pseudo BOX edge, not the
        // text edge. Box width = textWidth + padL + padR + borL + borR;
        // box height = lineH + padT + padB + borT + borB. For
        // left/top-anchored, box-left/top = paddingBoxX + pcsLeft/Top —
        // the unconditional xPos += padL + borL below converts box-left
        // to text-left. For right/bottom-anchored, box-right/bottom =
        // paddingBoxOpposite - pcsRight/Bottom; subtract the FULL box
        // dimension here so the unconditional += padL/T + borL/T lands
        // xPos/yPos on the text edge.
        const pPadL = parseFloat(pcs.paddingLeft) || 0;
        const pPadR = parseFloat(pcs.paddingRight) || 0;
        const pPadT = parseFloat(pcs.paddingTop) || 0;
        const pPadB = parseFloat(pcs.paddingBottom) || 0;
        const pBorL = parseFloat(pcs.borderLeftWidth) || 0;
        const pBorR = parseFloat(pcs.borderRightWidth) || 0;
        const pBorT = parseFloat(pcs.borderTopWidth) || 0;
        const pBorB = parseFloat(pcs.borderBottomWidth) || 0;
        if (!isNaN(pcsLeft)) xPos = paddingBoxLeft + pcsLeft;
        else if (!isNaN(pcsRight)) xPos = paddingBoxRight - pcsRight - pseudoWidth - pPadL - pPadR - pBorL - pBorR;
        else xPos = paddingBoxLeft;
        if (!isNaN(pcsTop)) yPos = paddingBoxTop + pcsTop;
        else if (!isNaN(pcsBottom)) yPos = paddingBoxBottom - pcsBottom - lineH - pPadT - pPadB - pBorT - pBorB;
        else yPos = paddingBoxTop;
        // Pseudo's own padding shifts the content inside its box.
        xPos += pPadL + pBorL;
        yPos += pPadT + pBorT;
        // Center within the line box (vertical-align baseline approx).
        yPos += (lineH - elFontSize) / 2;
        pseudoIsPositioned = true;
      } else {
        yPos = elTop + (lineH - elFontSize) / 2;
        // In-flow pseudo: the painted text sits inside the pseudo's content
        // box. Shift from the host's left edge past the pseudo's own
        // margin-left + border-left + padding-left (DM-596: Slashdot's
        // .icon-angle-right ::before uses margin-left: 0.2em to space the
        // chevron away from the preceding text). For ::after the existing
        // rect-width-based anchor is the host's right edge minus the
        // pseudo's text width and twice the host's padding-right (legacy
        // behavior preserved — no fixture currently exposes a gap).
        const pcsMarginL = parseFloat(pcs.marginLeft) || 0;
        const pcsBorderL = parseFloat(pcs.borderLeftWidth) || 0;
        const pcsPaddingL = parseFloat(pcs.paddingLeft) || 0;
        if (pseudo === '::before') {
          xPos = elLeft + pcsMarginL + pcsBorderL + pcsPaddingL;
        } else {
          xPos = elLeft + rect.width - pseudoWidth - 2 * (parseFloat(cs.paddingRight) || 0);
        }
      }

      const pseudoSeg = {
        text,
        x: xPos,
        y: yPos,
        width: pseudoWidth,
        height: elFontSize,
        // Carry pseudo-specific typography so the renderer can respect
        // per-pseudo color, font-size, font-weight, font-family (CSS
        // lets pseudos style independently of their parent).
        color: pcs.color,
        fontSize: elFontSize,
        fontWeight: pcs.fontWeight,
        fontFamily: pcs.fontFamily,
        fontAscent: pseudoMetrics.ascent,
      };
      // DM-497: stash pseudo's own background / border-radius on the
      // wrapper (boxStyles below). The actual pseudoBox rect is computed
      // after the injection loop reassigns seg.x/seg.y to anchor against
      // the parent's real text boundaries — at capture-time xPos isn't
      // final.
      const pseudoBgRaw = pcs.backgroundColor;
      const pseudoBgColor = pseudoBgRaw && pseudoBgRaw !== '' && pseudoBgRaw !== 'rgba(0, 0, 0, 0)' && pseudoBgRaw !== 'transparent'
        ? normColor(pseudoBgRaw) : '';
      const pseudoBR = parseFloat(pcs.borderRadius) || 0;
      // Capture a uniform border when all four sides match. Mixed-side
      // styling is rare on pseudos in real-world fixtures and falls
      // through.
      const bw = parseFloat(pcs.borderTopWidth) || 0;
      const bwUniform = bw > 0
        && (parseFloat(pcs.borderRightWidth) || 0) === bw
        && (parseFloat(pcs.borderBottomWidth) || 0) === bw
        && (parseFloat(pcs.borderLeftWidth) || 0) === bw;
      const pseudoBC = bwUniform ? normColor(pcs.borderTopColor) : '';
      let pseudoBoxStyles = null;
      if (pseudoBgColor !== '' || pseudoBR > 0 || (bwUniform && pseudoBC !== '' && pseudoBC !== 'rgba(0, 0, 0, 0)')) {
        pseudoBoxStyles = {
          padL: parseFloat(pcs.paddingLeft) || 0,
          padR: parseFloat(pcs.paddingRight) || 0,
          padT: parseFloat(pcs.paddingTop) || 0,
          padB: parseFloat(pcs.paddingBottom) || 0,
          borL: parseFloat(pcs.borderLeftWidth) || 0,
          borR: parseFloat(pcs.borderRightWidth) || 0,
          borT: parseFloat(pcs.borderTopWidth) || 0,
          borB: parseFloat(pcs.borderBottomWidth) || 0,
          // Inline-box bg paints at line-height, not at font-size — so
          // the box's vertical extent is lineH + padding + border (not
          // fontSize). Capture lineH alongside the metrics; the post-
          // injection block uses it to compute boxH and boxY (centered
          // on the line box).
          lineH,
          fontSize: elFontSize,
          backgroundColor: pseudoBgColor !== '' ? pseudoBgColor : undefined,
          borderRadius: pseudoBR > 0 ? pseudoBR : undefined,
          borderWidth: bwUniform ? bw : undefined,
          borderColor: bwUniform && pseudoBC !== '' && pseudoBC !== 'rgba(0, 0, 0, 0)' ? pseudoBC : undefined,
        };
      }
      // If the pseudo contains any codepoint Chrome paints via a color-
      // bitmap font (emoji, U+2713, etc.), record a page-absolute rect
      // so the Node-side raster can screenshot the exact pixels Chrome
      // produced and swap in an <image> for the path-mode emission.
      // Expand the height to the full line box: emoji glyphs often
      // extend above/below font-size, and the surrounding transparent
      // pixels are harmless under the omitBackground:true screenshot.
      // Raster fallback (a) for codepoints Chrome paints via a color-
      // bitmap font (emoji, U+2713, etc.) and (b) for icon-font glyphs
      // whose CSS content is entirely in Unicode Private Use Area
      // (U+E000–F8FF / U+F0000–FFFFD / U+100000–10FFFD).
      // DM-583: apple.com's `<i class="icon-angle-right">::after { content:
      // "\f303"; font-family: "SF Pro Icons" }` chevron — the font isn't
      // available to fontkit, so path emission produces notdef which the
      // renderer suppresses (DM-490 / DM-500). Without a raster fallback
      // these icons disappear. Always rasterise PUA content so the post-
      // capture screenshot pass stamps the exact pixels Chromium paints.
      // (For fonts we DO have fontkit access to, like slashdot's sdicon,
      // raster output is also pixel-faithful — slight payload cost vs.
      // path emission, but a correct render trumps minor vector loss.)
      let allPua = text.length > 0;
      for (let _ci = 0; _ci < text.length;) {
        const cp = text.codePointAt(_ci);
        const inPua = (cp >= 0xE000 && cp <= 0xF8FF)
          || (cp >= 0xF0000 && cp <= 0xFFFFD)
          || (cp >= 0x100000 && cp <= 0x10FFFD);
        if (!inPua) { allPua = false; break; }
        _ci += cp > 0xFFFF ? 2 : 1;
      }
      if (textNeedsRaster(text) || allPua) {
        // Viewport-relative rect — matches the SVG coordinate system so
        // the renderer can emit <image x=…/> alongside other viewport-
        // local markup. Node-side raster adds vp.x/vp.y when calling
        // page.screenshot (which wants page-absolute pixels).
        //
        // DM-626: for all-PUA (icon-font) pseudos the visible glyph
        // often paints outside the canvas-measured advance-width box
        // because the font's glyph has a left-side bearing that
        // positions the visible ink past the cursor origin. A narrow
        // `pseudoWidth`-sized rect ends up capturing only the
        // advance-width slice, cutting off most of the glyph. Use the
        // host element's full painted rect for icon-font pseudos so
        // the screenshot covers wherever Chromium painted the glyph
        // (the empty area inside the host rect is harmless under
        // `omitBackground: true`). For emoji / U+2713 etc. the
        // textNeedsRaster path keeps its tighter rect since those
        // glyphs sit inside their advance box.
        if (allPua && !textNeedsRaster(text)) {
          pseudoSeg.rasterRect = {
            x: rect.left - vp.x,
            y: rect.top - vp.y,
            width: rect.width,
            height: rect.height,
          };
        } else {
          pseudoSeg.rasterRect = {
            x: pseudoSeg.x,
            y: elTop,
            width: pseudoWidth,
            height: lineH,
          };
        }
      }
      pseudoSegments.push({
        isBefore: pseudo === '::before',
        seg: pseudoSeg,
        color: pcs.color,
        isPositioned: pseudoIsPositioned,
        boxStyles: pseudoBoxStyles,
      });
    }
    return { pseudoSegments, pseudoBoxes };
  };

  return { capturePseudoContent };
};
