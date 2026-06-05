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

import { hasCssValue, sideWidths } from "../utils.js";

export const createPseudoContentHandler = ({ vp, normColor, measureFontMetrics, textNeedsRaster, resolveCounterValue, isCustomCounterStyle }) => {
  // DM-785: Chrome's HarfBuzz-shaped layout width differs from
  // `canvas.measureText` by ~1-3px on bold uppercase short strings (the
  // gradient-pill / MOST POPULAR / NEW badge pattern). Measuring via an
  // off-screen <span> with the pseudo's resolved font properties and reading
  // `getBoundingClientRect().width` matches the painted width exactly because
  // it goes through the same shaping pipeline Chrome uses for layout. Only
  // matters for `width: auto` absolute pseudos — the DM-507 numeric `pcs.width`
  // path is still authoritative when present.
  const probePseudoTextWidth = (text, pcs) => {
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-99999px;top:-99999px;white-space:pre;line-height:normal;margin:0;padding:0;border:0;text-indent:0';
    span.style.fontFamily = pcs.fontFamily || '';
    span.style.fontSize = pcs.fontSize || '';
    span.style.fontWeight = pcs.fontWeight || '';
    span.style.fontStyle = pcs.fontStyle || '';
    span.style.fontStretch = pcs.fontStretch || '';
    span.style.fontVariant = pcs.fontVariant || '';
    span.style.fontFeatureSettings = pcs.fontFeatureSettings || '';
    span.style.fontVariationSettings = pcs.fontVariationSettings || '';
    span.style.letterSpacing = pcs.letterSpacing || '';
    span.style.wordSpacing = pcs.wordSpacing || '';
    span.textContent = text;
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    return w;
  };

  // DM-768: when a static-flow pseudo declares `display: inline-block` (or
  // inline-flex / inline-grid / inline-table) the box participates in Chrome's
  // inline vertical-align math — `vertical-align: middle` aligns the pseudo's
  // mid-point with the parent's baseline + 0.5 × x-height, `baseline` aligns
  // the pseudo's bottom to the parent baseline, etc. The earlier formula
  // (`rect.top + hostBorT + hostPadT + pMarT`) ignores that and places the
  // pseudo at the host's content-area top — i.e. the line-box top — so an
  // inline-block down-caret with `border-top: 5px solid` paints 6-7 px too
  // high inside its parent button. Probe instead: insert a real sentinel
  // mirroring the pseudo's box (display / size / borders / padding / margin /
  // vertical-align) at the pseudo's logical position in the host and read its
  // `getBoundingClientRect()`. Chrome lays out the sentinel exactly where the
  // pseudo would have gone, so we get the correct x/y without re-deriving
  // font metrics + vertical-align semantics ourselves.
  const probePseudoStaticBoxRect = (el, pseudo, pcs) => {
    const probe = document.createElement('span');
    probe.style.cssText = 'pointer-events:none;visibility:hidden;box-sizing:content-box';
    probe.style.display = pcs.display;
    probe.style.width = pcs.width;
    probe.style.height = pcs.height;
    probe.style.paddingTop = pcs.paddingTop;
    probe.style.paddingRight = pcs.paddingRight;
    probe.style.paddingBottom = pcs.paddingBottom;
    probe.style.paddingLeft = pcs.paddingLeft;
    probe.style.borderTopWidth = pcs.borderTopWidth;
    probe.style.borderRightWidth = pcs.borderRightWidth;
    probe.style.borderBottomWidth = pcs.borderBottomWidth;
    probe.style.borderLeftWidth = pcs.borderLeftWidth;
    probe.style.borderStyle = 'solid';
    probe.style.borderColor = 'transparent';
    probe.style.marginTop = pcs.marginTop;
    probe.style.marginRight = pcs.marginRight;
    probe.style.marginBottom = pcs.marginBottom;
    probe.style.marginLeft = pcs.marginLeft;
    probe.style.verticalAlign = pcs.verticalAlign;
    probe.style.font = ''; // inherit so line-box metrics match the pseudo's parent
    if (pseudo === '::before') el.insertBefore(probe, el.firstChild);
    else el.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return r;
  };

  // For `position: absolute` / `position: fixed` pseudos, the containing block
  // is the nearest positioned ancestor of the host (NOT the host itself when
  // the host is `position: static`). NYT's mobile nav `.css-sdhjrl::after`
  // fade-out is `position: absolute; right: 0; top:0; width: 24px; height: 40px`
  // on a `position: static; display: flex; overflow: scroll` NAV — the pseudo's
  // computed `top` / `left` resolve against a far-up ancestor, so naïvely adding
  // them to the host's padding-box origin places the gradient ~3088px below the
  // NAV (where there's no NAV to fade over). Instead, inject a real absolutely-
  // positioned sentinel as a child of the host: it inherits the same containing
  // block the pseudo would have, and Chrome lays it out at the exact rect the
  // pseudo paints to. Read its `getBoundingClientRect` directly.
  const probePseudoAbsoluteBoxRect = (el, pseudo, pcs) => {
    const probe = document.createElement('div');
    probe.style.cssText = 'pointer-events:none;visibility:hidden;box-sizing:content-box;margin:0';
    probe.style.position = pcs.position;
    probe.style.top = pcs.top;
    probe.style.right = pcs.right;
    probe.style.bottom = pcs.bottom;
    probe.style.left = pcs.left;
    probe.style.width = pcs.width;
    probe.style.height = pcs.height;
    probe.style.paddingTop = pcs.paddingTop;
    probe.style.paddingRight = pcs.paddingRight;
    probe.style.paddingBottom = pcs.paddingBottom;
    probe.style.paddingLeft = pcs.paddingLeft;
    probe.style.borderTopWidth = pcs.borderTopWidth;
    probe.style.borderRightWidth = pcs.borderRightWidth;
    probe.style.borderBottomWidth = pcs.borderBottomWidth;
    probe.style.borderLeftWidth = pcs.borderLeftWidth;
    probe.style.borderStyle = 'solid';
    probe.style.borderColor = 'transparent';
    probe.style.marginTop = pcs.marginTop;
    probe.style.marginRight = pcs.marginRight;
    probe.style.marginBottom = pcs.marginBottom;
    probe.style.marginLeft = pcs.marginLeft;
    // DM-928: deliberately DO NOT apply the pseudo's `transform` to the
    // probe. CSS transforms only affect paint, not layout; the probe's
    // `getBoundingClientRect()` returns the AXIS-ALIGNED bounding box of
    // whatever box it currently paints. With a 45° rotation, that AABB is
    // ~√2 × larger than the actual border-box and its top-left sits
    // ~(diagonal-extra)/2 to the upper-left of the true border-box origin
    // — re-rotating that AABB later via the `<g transform>` wrapper
    // places the painted strokes at the wrong position (pricing-table
    // checkmarks drift ~4 px left / 1 px up). Strip the transform here
    // and let the unrotated probe report the actual border-box rect; the
    // transform is re-applied at render time inside `flushPbTransformWrap`.
    probe.style.transform = '';
    probe.style.transformOrigin = '';
    // Pseudo lives logically inside the host; an absolute child of the host
    // inherits the same containing-block lookup.
    if (pseudo === '::before') el.insertBefore(probe, el.firstChild);
    else el.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return r;
  };

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

  // Parse a pseudo-element's computed `content` string into the resolved text +
  // image-url it paints. Walks the token list: quoted strings, attr(name),
  // url(...), counter()/counters() (resolved against the captured counter
  // snapshot, with custom @counter-style formatting — DM-788), and the
  // open-quote / close-quote / no-*-quote keywords (DM-602). Closes over the
  // handler's pickQuoteChar / isCustomCounterStyle / resolveCounterValue.
  // Extracted from capturePseudoContent (DM-1088).
  const parsePseudoContent = (content, el, counterSnapshot) => {
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
        // DM-788: third arg of counters() / second arg of counter() is a
        // `<counter-style>` name. When that name matches a custom
        // `@counter-style` rule captured in the pre-walk, run each value
        // through the resolver so prefix / suffix / pad / negative / range
        // / fallback descriptors apply — e.g. `counter(step, prefixed)`
        // produces "Step 01:  " instead of plain decimal "1".
        const styleArg = isCounters ? args[2] : args[1];
        const useCustomStyle = styleArg != null && styleArg !== ''
          && isCustomCounterStyle != null && isCustomCounterStyle(styleArg);
        const format = (v) => {
          if (!useCustomStyle) return String(v);
          const out = resolveCounterValue(styleArg, v);
          return out != null ? out : String(v);
        };
        const snapshot = counterSnapshot.get(el) || [];
        const matches = snapshot.filter((s) => s.name === cname).map((s) => format(s.value));
        if (isCounters) {
          text += matches.length > 0 ? matches.join(sep) : format(0);
        } else {
          text += matches.length > 0 ? matches[matches.length - 1] : format(0);
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
    return { text, imageUrl };
  };

  // Capture an empty-content pseudo (no text, no image) that's being used as a
  // decorative box — a block-like `::before`/`::after` with a visible
  // background, background-image, or border (DM-579 hairlines, DM-767 accent
  // stripes, DM-594 speech-bubble tails). Returns the pseudoBox descriptor (rect
  // + per-side border + background + the pseudo's own transform), or null when
  // it paints nothing visible. Closes over the handler's probe helpers + vp +
  // normColor. Extracted from capturePseudoContent (DM-1088).
  const captureEmptyContentBox = (el, cs, pseudo, pcs, rect) => {
        const bgRaw = pcs.backgroundColor;
        const hasBg = bgRaw && bgRaw !== '' && bgRaw !== 'rgba(0, 0, 0, 0)' && bgRaw !== 'transparent';
        // DM-767: capture background-image (linear-gradient / radial-gradient /
        // url) on empty-content pseudos too. The `.corner::after` accent stripe
        // pattern in `24-deep-pseudo-shapes` is an absolutely-positioned 4 px
        // strip with a `linear-gradient` background and no color / border —
        // without this check the pseudoBox emit was skipped entirely.
        const bgImgRaw = pcs.backgroundImage;
        const hasBgImg = hasCssValue(bgImgRaw);
        const { top: bwT, right: bwR, bottom: bwB, left: bwL } = sideWidths(pcs, 'border', 'Width');
        const hasBorder = bwT > 0 || bwR > 0 || bwB > 0 || bwL > 0;
        const isBlockLike = pcs.display === 'block' || pcs.display === 'inline-block' || pcs.display === 'flex';
        // DM-1073: the `opacity: 0` skip that used to repeat here is dead — the
        // loop-top guard (above) already `continue`d on opacity 0 before any
        // box-rect work, so by here opacity is non-zero.
        if (isBlockLike && (hasBg || hasBgImg || hasBorder)) {
          const hostPadL = parseFloat(cs.paddingLeft) || 0;
          const hostPadT = parseFloat(cs.paddingTop) || 0;
          const hostBorL = parseFloat(cs.borderLeftWidth) || 0;
          const hostBorT = parseFloat(cs.borderTopWidth) || 0;
          const hostBorR = parseFloat(cs.borderRightWidth) || 0;
          const pMarL = parseFloat(pcs.marginLeft) || 0;
          const { left: pPadL, right: pPadR, top: pPadT, bottom: pPadB } = sideWidths(pcs, 'padding', '');
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
            // Use a real positioned sentinel to find the pseudo's true painted
            // rect. Chrome's containing-block lookup walks up from the host
            // looking for a positioned ancestor (or a transformed / filtered
            // / contained ancestor); the same lookup applies to a real child
            // of the host. Probing avoids re-implementing that walk + all the
            // containing-block-establishing properties. NYT mobile's nav fade-
            // out `.css-sdhjrl::after` (`position: absolute; right: 0`) on a
            // `position: static` NAV is the trigger case — the pseudo's
            // resolved `top` / `left` are relative to a far-up positioned
            // ancestor, not the NAV, so the prior additive math placed the
            // gradient thousands of pixels off the NAV.
            const pr = probePseudoAbsoluteBoxRect(el, pseudo, pcs);
            borderBoxX = pr.left - vp.x;
            borderBoxY = pr.top - vp.y;
          } else {
            const pMarT = parseFloat(pcs.marginTop) || 0;
            borderBoxX = rect.left - vp.x + hostBorL + hostPadL + pMarL;
            borderBoxY = rect.top - vp.y + hostBorT + hostPadT + pMarT;
            // DM-768: static `display: inline-block` (and inline-flex / inline-grid /
            // inline-table) pseudos participate in Chrome's inline vertical-align
            // math — the formula above ignores `vertical-align` and pins the box to
            // the host's content-area top, which is 6-7 px too high for a typical
            // `vertical-align: middle` down-caret. Probe with a real sentinel that
            // mirrors the pseudo's box properties.
            //
            // CSS render order on the line is: ::before → real children → ::after.
            // The sentinel is a real child:
            //   - For ::before, the sentinel renders AFTER the pseudo. The
            //     pseudo's own position is unchanged; the sentinel just shifts
            //     subsequent content. So the pseudo's border-box left =
            //     probe.left − pMarR − borderBoxW − pMarL (back out the sentinel
            //     gap), and the pseudo's top equals probe.top (both lay out
            //     on the same line with matching `vertical-align`).
            //   - For ::after, the sentinel renders BEFORE the pseudo. Without
            //     the sentinel, the pseudo would take the slot the sentinel
            //     now occupies, so the pseudo's border-box left = probe.left
            //     and top = probe.top.
            const dispIsInline = pcs.display === 'inline-block' || pcs.display === 'inline-flex' || pcs.display === 'inline-grid' || pcs.display === 'inline-table';
            if (dispIsInline) {
              const pr = probePseudoStaticBoxRect(el, pseudo, pcs);
              borderBoxY = pr.top - vp.y;
              if (pseudo === '::after') {
                borderBoxX = pr.left - vp.x;
              } else {
                const pMarR = parseFloat(pcs.marginRight) || 0;
                borderBoxX = pr.left - vp.x - pMarR - borderBoxW - pMarL;
              }
            }
          }
          // DM-710: if the host has a CSS transform whose 2D submatrix is
          // singular (zero determinant), the host's painted area collapses
          // to a point / line and the pseudo paints nothing visible —
          // Apple's `.globalnav-bag-badge` carries `transform: matrix(0, 0,
          // 0, 0, 0, 0)` as the "no items in cart" state, and the empty
          // ::before with `width: 13px; background: black; border-radius:
          // 13px` would otherwise emit as a visible dot. Skip the pseudoBox
          // in that case; the live-rect model already drops the host itself.
          let degenerateHostTransform = false;
          if (cs.transform && cs.transform !== 'none') {
            const m2 = /^matrix\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(cs.transform);
            if (m2) {
              const a = parseFloat(m2[1]);
              const b = parseFloat(m2[2]);
              const c = parseFloat(m2[3]);
              const d = parseFloat(m2[4]);
              if (Math.abs(a * d - b * c) < 1e-9) degenerateHostTransform = true;
            }
          }
          if (borderBoxW > 0 && borderBoxH > 0 && !degenerateHostTransform) {
            // DM-783: the pseudo's own `transform` (rotate/scale/translate/
            // matrix) wraps the pseudoBox at render time. getComputedStyle
            // returns the resolved matrix() form, and transformOrigin returns
            // resolved px values relative to the pseudo's box top-left — both
            // can be pasted directly into an SVG `<g>` wrapper. Captured only
            // when non-`none` to keep the captured tree compact.
            const pcsTransform = pcs.transform && pcs.transform !== 'none' ? pcs.transform : undefined;
            const pcsTransformOrigin = pcsTransform != null ? (pcs.transformOrigin || undefined) : undefined;
            // DM-1051: a negative z-index pseudo (Resend's `.rainbow-border::after`
            // glow, `z-index: -10`) paints BEHIND the host content, and its
            // `filter: blur(20px)` softens the gradient into a halo. Capture both
            // so the renderer can paint-behind + blur instead of overlaying a
            // sharp gradient rect on top of the dark pill interior.
            const pcsZ = parseInt(pcs.zIndex, 10);
            const pcsZIndex = Number.isFinite(pcsZ) ? pcsZ : undefined;
            const pcsFilter = pcs.filter && pcs.filter !== 'none' ? pcs.filter : undefined;
            return {
              // DM-1001: track which pseudo emitted this box so the renderer
              // can paint ::after pseudo-elements AFTER the host's text (the
              // CSS render order). The earlier "emit all pseudoBoxes ahead of
              // text" gate (line 2370) is right for ::before but wrong for
              // ::after — NYT's right-edge fade-out overlays the headline
              // text via `::after { background: linear-gradient(transparent,
              // white) }`, so painting it under the text leaves the headline
              // sharp instead of fading.
              pseudo: pseudo,
              x: borderBoxX,
              y: borderBoxY,
              width: borderBoxW,
              height: borderBoxH,
              backgroundColor: hasBg ? normColor(bgRaw) : undefined,
              backgroundImage: hasBgImg ? bgImgRaw : undefined,
              borderTopWidth: bwT, borderTopColor: bwT > 0 ? normColor(pcs.borderTopColor) : undefined, borderTopStyle: pcs.borderTopStyle,
              borderRightWidth: bwR, borderRightColor: bwR > 0 ? normColor(pcs.borderRightColor) : undefined, borderRightStyle: pcs.borderRightStyle,
              borderBottomWidth: bwB, borderBottomColor: bwB > 0 ? normColor(pcs.borderBottomColor) : undefined, borderBottomStyle: pcs.borderBottomStyle,
              borderLeftWidth: bwL, borderLeftColor: bwL > 0 ? normColor(pcs.borderLeftColor) : undefined, borderLeftStyle: pcs.borderLeftStyle,
              borderRadius: parseFloat(pcs.borderRadius) || 0,
              transform: pcsTransform,
              transformOrigin: pcsTransformOrigin,
              zIndex: pcsZIndex,
              filter: pcsFilter,
            };
          }
        }
    return null;
  };


  const capturePseudoContent = (el, cs, rect, counterSnapshot) => {
    const pseudoSegments = [];
    const pseudoBoxes = [];
    for (const pseudo of ['::before', '::after']) {
      const pcs = window.getComputedStyle(el, pseudo);
      const content = pcs.content;
      if (content == null || content === 'none' || content === 'normal' || content === '') continue;
      // DM-665 / DM-677: pseudos with computed `opacity: 0` paint nothing in
      // Chrome (Material-style ripple / hover overlays use this — Google's
      // `a.gb_C::before` is the empty-content variant we already skipped;
      // `a.gb_A::before` on the mobile "Sign in" pill is the same idea but
      // with `content: " "` (a single space, non-empty) so it slipped past
      // the previous gate). Skip ALL opacity-zero pseudos before doing any
      // measurement / box-rect work; capturing them anyway would paint an
      // opaque box over the host's actual content.
      const opacityNum = parseFloat(pcs.opacity);
      if (Number.isFinite(opacityNum) && opacityNum === 0) continue;

      const { text, imageUrl } = parsePseudoContent(content, el, counterSnapshot);
      if (text === '' && imageUrl === '') {
        const box = captureEmptyContentBox(el, cs, pseudo, pcs, rect);
        if (box != null) pseudoBoxes.push(box);
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

      // DM-785: probe-span measurement matches Chrome's HarfBuzz-shaped
      // layout width — canvas.measureText drifted ~1-3px on bold uppercase
      // short strings (visible on rotated gradient pills as the text
      // overflowing the badge). DM-507 numeric-pcs.width override still
      // wins when the pseudo's box has an authored fixed width.
      let pseudoWidth = probePseudoTextWidth(text, pcs);
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
        // per-pseudo color, font-size, font-weight, font-family, font-style
        // (CSS lets pseudos style independently of their parent — Slashdot's
        // "Most Discussed" carousel heading is a ::after that's italic+bordered
        // on a non-italic host div).
        color: pcs.color,
        fontSize: elFontSize,
        fontWeight: pcs.fontWeight,
        fontFamily: pcs.fontFamily,
        fontStyle: pcs.fontStyle,
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
      // Capture a uniform border when all four sides match (renders as
      // `<rect stroke=…>`). When a single side carries a border (e.g.
      // `border-bottom: 1px solid rgba(255,255,255,0.5)` on Slashdot's
      // `.carouselHeading::after`) we still capture per-side widths +
      // colors so the renderer can emit a `<line>` for the visible side.
      const bwTop = parseFloat(pcs.borderTopWidth) || 0;
      const bwRight = parseFloat(pcs.borderRightWidth) || 0;
      const bwBottom = parseFloat(pcs.borderBottomWidth) || 0;
      const bwLeft = parseFloat(pcs.borderLeftWidth) || 0;
      const bwUniform = bwTop > 0 && bwRight === bwTop && bwBottom === bwTop && bwLeft === bwTop;
      const pseudoBC = bwUniform ? normColor(pcs.borderTopColor) : '';
      const colorIsPaintable = (raw: string): boolean => raw !== '' && raw !== 'rgba(0, 0, 0, 0)' && raw !== 'transparent';
      const sideBorderTopColor = bwTop > 0 ? normColor(pcs.borderTopColor) : '';
      const sideBorderRightColor = bwRight > 0 ? normColor(pcs.borderRightColor) : '';
      const sideBorderBottomColor = bwBottom > 0 ? normColor(pcs.borderBottomColor) : '';
      const sideBorderLeftColor = bwLeft > 0 ? normColor(pcs.borderLeftColor) : '';
      const hasPerSideBorder = !bwUniform && (
        (bwTop > 0 && colorIsPaintable(sideBorderTopColor))
        || (bwRight > 0 && colorIsPaintable(sideBorderRightColor))
        || (bwBottom > 0 && colorIsPaintable(sideBorderBottomColor))
        || (bwLeft > 0 && colorIsPaintable(sideBorderLeftColor))
      );
      // DM-782: background-image (linear-gradient / radial-gradient / url())
      // on text-content pseudos. The empty-content path already plumbs this
      // (DM-767); the text-content path was dropping it, so "gradient badge"
      // patterns (`.tier.popular::before { content: "MOST POPULAR"; background:
      // linear-gradient(135deg, ...) }`) lost the pill bg behind the white
      // glyphs.
      const pseudoBgImgRaw = pcs.backgroundImage;
      const hasPseudoBgImg = hasCssValue(pseudoBgImgRaw);
      // DM-783: pseudo's own `transform` (rotate/scale/translate/matrix)
      // wraps both the paint box AND the glyph emit at render time.
      const pseudoTransform = pcs.transform && pcs.transform !== 'none' ? pcs.transform : undefined;
      const pseudoTransformOrigin = pseudoTransform != null ? (pcs.transformOrigin || undefined) : undefined;
      let pseudoBoxStyles = null;
      if (pseudoBgColor !== '' || hasPseudoBgImg || pseudoBR > 0 || (bwUniform && pseudoBC !== '' && pseudoBC !== 'rgba(0, 0, 0, 0)') || hasPerSideBorder || pseudoTransform != null) {
        pseudoBoxStyles = {
          padL: parseFloat(pcs.paddingLeft) || 0,
          padR: parseFloat(pcs.paddingRight) || 0,
          padT: parseFloat(pcs.paddingTop) || 0,
          padB: parseFloat(pcs.paddingBottom) || 0,
          borL: bwLeft,
          borR: bwRight,
          borT: bwTop,
          borB: bwBottom,
          // Inline-box bg paints at line-height, not at font-size — so
          // the box's vertical extent is lineH + padding + border (not
          // fontSize). Capture lineH alongside the metrics; the post-
          // injection block uses it to compute boxH and boxY (centered
          // on the line box).
          lineH,
          fontSize: elFontSize,
          backgroundColor: pseudoBgColor !== '' ? pseudoBgColor : undefined,
          backgroundImage: hasPseudoBgImg ? pseudoBgImgRaw : undefined,
          borderRadius: pseudoBR > 0 ? pseudoBR : undefined,
          borderWidth: bwUniform ? bwTop : undefined,
          borderColor: bwUniform && pseudoBC !== '' && pseudoBC !== 'rgba(0, 0, 0, 0)' ? pseudoBC : undefined,
          transform: pseudoTransform,
          transformOrigin: pseudoTransformOrigin,
          // Per-side colors. Renderer reads these when no uniform border
          // is set and emits a `<line>` for each side whose width > 0 and
          // color is paintable. Undefined when the side has no visible
          // border, keeping the captured tree compact in the common case.
          borderTopColor: hasPerSideBorder && bwTop > 0 && colorIsPaintable(sideBorderTopColor) ? sideBorderTopColor : undefined,
          borderRightColor: hasPerSideBorder && bwRight > 0 && colorIsPaintable(sideBorderRightColor) ? sideBorderRightColor : undefined,
          borderBottomColor: hasPerSideBorder && bwBottom > 0 && colorIsPaintable(sideBorderBottomColor) ? sideBorderBottomColor : undefined,
          borderLeftColor: hasPerSideBorder && bwLeft > 0 && colorIsPaintable(sideBorderLeftColor) ? sideBorderLeftColor : undefined,
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
