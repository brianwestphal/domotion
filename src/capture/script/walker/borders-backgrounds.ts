// @ts-nocheck
//
// Border + background + outline + box-shadow capture. The bulk of this is
// cs.X passthrough (the renderer does the real work — emitting SVG strokes
// for borders, gradient defs for background-image, etc.), with a handful of
// computed fields:
//
//   - **backgroundColor placeholder-shown fallback** (DM-283): when the
//     captured element is empty-with-placeholder, walk the captured
//     `:placeholder-shown` rules and prefer that color over Chrome's
//     resolved `rgba(0,0,0,0)` (which it returns when only the
//     `background` shorthand was set).
//
//   - **borderTop/Right/Bottom/LeftRadius**: resolve % corner-radii to px
//     against rect width/height. Chrome's computed longhand still
//     preserves %, so a `border-radius: 50%` would read as the literal
//     string "50%" and downstream parseFloat would mistake it for 50 px.
//     See SK-1093.
//
//   - **borderTop/Right/Bottom/LeftColor color-input tint workaround**
//     (DM-434): Chromium's appearance:auto `<input type=color>` paints
//     a 1px rgb(118,118,118) border, but getComputedStyle reports
//     rgb(0,0,0). Override at capture so the generic border-emit path
//     paints the same chrome Chromium paints. The workaround stays here
//     (rather than in form-controls) because it's a per-side border-color
//     override that intermixes with the normal `normColor(cs.borderXColor,
//     cs.color)` emission.
//
//   - **frostedBgFallback** (DM-476): when an element has a
//     backdrop-filter and an effectively-transparent background-color,
//     stash the document body's resolved bg color so the renderer can
//     paint it behind the would-have-been-frosted region. See
//     docs/19-frosted-backdrop-fallback.md.
//
//   - **backgroundIntrinsic** (DM-308): per-layer intrinsic dims of
//     background-image url() layers. Split background-image on top-level
//     commas (parens-aware) so each layer's url() can be probed for
//     naturalWidth/Height via a fresh Image().
//
//   - **borderImageIntrinsicWidth / Height**: same pattern for border-
//     image-source url().

export const createBordersBackgroundsHandler = ({ normColor, normGradientColors, resolvePlaceholderShownBg, resolveCornerRadius }) => {
  const isUaColorBorder = (tag, el, cs, side) =>
    tag === 'input' && el.type === 'color'
    && normColor(cs[side], cs.color).replace(/\s+/g, '') === 'rgb(0,0,0)';

  const tintedBorderColor = (tag, el, cs, side) =>
    isUaColorBorder(tag, el, cs, side) ? 'rgb(118,118,118)' : normColor(cs[side], cs.color);

  const computeFrostedBgFallback = (cs) => {
    const bdf = cs.backdropFilter || cs.webkitBackdropFilter || '';
    if (bdf === '' || bdf === 'none') return undefined;
    const bgCol = normColor(cs.backgroundColor, cs.color);
    // Parse alpha out of "rgba(r,g,b,a)" / "rgb(r,g,b)" / "rgb(r g b / a)".
    // normColor canonicalises to one of these forms.
    let a = 1;
    const m = /rgba?\(\s*[^,)\s]+[ ,]+[^,)\s]+[ ,]+[^,)\s]+(?:[ ,/]+([^)]+))?\)/.exec(bgCol);
    if (m != null && m[1] != null) {
      const av = parseFloat(m[1]);
      if (!isNaN(av)) a = av;
    }
    if (a > 0.1) return undefined;
    const bodyBg = normColor(window.getComputedStyle(document.body).backgroundColor);
    // If body itself is transparent (rare on real pages), default to white.
    let bodyA = 1;
    const bm = /rgba?\(\s*[^,)\s]+[ ,]+[^,)\s]+[ ,]+[^,)\s]+(?:[ ,/]+([^)]+))?\)/.exec(bodyBg);
    if (bm != null && bm[1] != null) {
      const bav = parseFloat(bm[1]);
      if (!isNaN(bav)) bodyA = bav;
    }
    return bodyA <= 0.1 ? 'rgb(255,255,255)' : bodyBg;
  };

  const computeBackgroundIntrinsic = (cs) => {
    const bgImage = cs.backgroundImage;
    if (bgImage == null || bgImage === 'none' || bgImage === '') return undefined;
    // Split on top-level commas respecting nested parens.
    const layers = [];
    let depth = 0, start = 0;
    for (let i = 0; i < bgImage.length; i++) {
      const c = bgImage[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { layers.push(bgImage.slice(start, i)); start = i + 1; }
    }
    layers.push(bgImage.slice(start));

    return layers.map((layer) => {
      // DM-759: `image-set(url(...) 1x, url(...) 2x, ...)` layers wrap their
      // url() candidates inside the function call; the top-level regex
      // below only matches a bare `url(...)` at layer start. Probe the
      // FIRST url() inside the image-set instead so the renderer's `cover`
      // / `contain` math has the right aspect ratio. Picking any candidate
      // works because Chrome's image-set candidates are conventionally the
      // SAME image at different resolutions / formats, so the intrinsic
      // aspect is consistent across them; the absolute scale may differ
      // by the 1x/2x factor but `cover` / `contain` are aspect-driven.
      let searchLayer = layer;
      const imgSet = /^\s*(?:-webkit-)?image-set\(\s*([\s\S]+)\s*\)\s*$/i.exec(layer);
      if (imgSet != null) searchLayer = imgSet[1];
      // Match all three url() forms: "...", '...', and bare. Data: URLs
      // with embedded HTML attribute quotes (escaped as \") were silently
      // truncated by a prior single-regex implementation. DM-308.
      // For image-set candidates the url() may appear anywhere in the
      // inner string, so anchor at the start of the SEARCH LAYER but
      // allow leading whitespace.
      const u = /\burl\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s]+))\s*\)/.exec(searchLayer);
      if (u == null) return null;
      const raw = u[1] || u[2] || u[3] || '';
      if (raw === '') return null;
      const url = raw.replace(/\\(.)/g, '$1');
      const img = new Image();
      img.src = url;
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      return w > 0 && h > 0 ? { w, h } : null;
    });
  };

  const computeBorderImageIntrinsic = (cs, dim) => {
    const m = /^url\((?:"|')?([^"')]+)/.exec(cs.borderImageSource || '');
    if (m == null) return undefined;
    const img = new Image();
    img.src = m[1];
    return img[dim] || undefined;
  };

  // DM-690: CSS 2.1 §17.6.2.1 — `border-style: hidden` has the highest
  // precedence in `border-collapse: collapse` mode and SUPPRESSES the
  // neighbor cell's matching border too. Walk the table grid neighbors and
  // return per-side flags so the caller can rewrite this cell's border-side
  // styles to `'hidden'` (which the renderer already skips). Scope: simple
  // tables (no rowspan / colspan); good enough for the bug-report fixture
  // `04-deep-border-conflict` and the common-case marketing tables.
  const cellHiddenNeighbors = (el, tag, cs) => {
    const out = { top: false, right: false, bottom: false, left: false };
    if ((tag !== 'td' && tag !== 'th') || cs.borderCollapse !== 'collapse') return out;
    const tr = el.parentElement;
    if (tr == null || tr.tagName !== 'TR') return out;
    const rowCells = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const colIdx = rowCells.indexOf(el);
    const hiddenSide = (cell, side) => {
      if (cell == null) return false;
      const cs2 = getComputedStyle(cell);
      return cs2['border' + side + 'Style'] === 'hidden';
    };
    if (hiddenSide(rowCells[colIdx - 1], 'Right')) out.left = true;
    if (hiddenSide(rowCells[colIdx + 1], 'Left')) out.right = true;
    // Resolve the surrounding table to walk row-neighbors across
    // thead/tbody/tfoot sections.
    let table = tr.parentElement;
    while (table != null && table.tagName !== 'TABLE') table = table.parentElement;
    if (table != null) {
      const allRows = Array.from(table.querySelectorAll('tr')).filter((t) => t.closest('table') === table);
      const rowIdx = allRows.indexOf(tr);
      const above = allRows[rowIdx - 1];
      const below = allRows[rowIdx + 1];
      if (above != null) {
        const aboveCells = Array.from(above.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        if (hiddenSide(aboveCells[colIdx], 'Bottom')) out.top = true;
      }
      if (below != null) {
        const belowCells = Array.from(below.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        if (hiddenSide(belowCells[colIdx], 'Top')) out.bottom = true;
      }
    }
    return out;
  };

  const captureBordersBackgrounds = (el, cs, tag, rect, isPlaceholderCapture) => ({
    backgroundColor: (function () {
      if (isPlaceholderCapture) {
        const psBg = resolvePlaceholderShownBg(el);
        if (psBg !== '') return normColor(psBg);
      }
      return normColor(cs.backgroundColor, cs.color);
    })(),
    borderColor: normColor(cs.borderColor, cs.color),
    borderWidth: cs.borderWidth,
    borderRadius: cs.borderRadius,
    borderTopLeftRadius: resolveCornerRadius(cs.borderTopLeftRadius, rect.width, rect.height),
    borderTopRightRadius: resolveCornerRadius(cs.borderTopRightRadius, rect.width, rect.height),
    borderBottomRightRadius: resolveCornerRadius(cs.borderBottomRightRadius, rect.width, rect.height),
    borderBottomLeftRadius: resolveCornerRadius(cs.borderBottomLeftRadius, rect.width, rect.height),
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    // DM-690: when an adjacent collapsed-table cell declares its matching
    // side as `border-style: hidden`, CSS 2.1 §17.6.2.1 says we MUST treat
    // our side as hidden too (precedence: `hidden > widest > ...`). Override
    // here at capture time so the renderer's existing `style === 'hidden'`
    // skip suppresses the paint on this side. (Cells whose OWN side is
    // already hidden are unaffected — they pass through.)
    ...(function () {
      const hn = cellHiddenNeighbors(el, tag, cs);
      return {
        borderTopStyle: hn.top ? 'hidden' : cs.borderTopStyle,
        borderRightStyle: hn.right ? 'hidden' : cs.borderRightStyle,
        borderBottomStyle: hn.bottom ? 'hidden' : cs.borderBottomStyle,
        borderLeftStyle: hn.left ? 'hidden' : cs.borderLeftStyle,
      };
    })(),
    borderTopColor: tintedBorderColor(tag, el, cs, 'borderTopColor'),
    borderRightColor: tintedBorderColor(tag, el, cs, 'borderRightColor'),
    borderBottomColor: tintedBorderColor(tag, el, cs, 'borderBottomColor'),
    borderLeftColor: tintedBorderColor(tag, el, cs, 'borderLeftColor'),
    borderCollapse: cs.borderCollapse,
    frostedBgFallback: computeFrostedBgFallback(cs),
    backgroundImage: normGradientColors(cs.backgroundImage, cs.color),
    backgroundSize: cs.backgroundSize,
    backgroundPosition: cs.backgroundPosition,
    backgroundRepeat: cs.backgroundRepeat,
    backgroundClip: cs.backgroundClip,
    // DM-462: -webkit-text-fill-color is the property that actually makes
    // the headline text transparent in the background-clip:text idiom
    // (cs.color may still report a normal value).
    webkitTextFillColor: cs.webkitTextFillColor || cs.WebkitTextFillColor || undefined,
    // DM-749: Stripe's keynote-speaker headline pattern — a span with
    // `background-image: <gradient>; background-clip: text; -webkit-text-
    // fill-color: transparent` wraps a child div that holds the actual
    // text. The gradient is on the parent but Chrome lets it paint through
    // the child's glyphs because background-clip: text masks the gradient
    // by the union of all descendant text shapes. When the element's own
    // bg-image is none AND its text-fill-color is transparent AND an
    // ancestor has background-clip: text with a gradient, capture that
    // ancestor's gradient so the renderer can use it as the glyph fill.
    inheritedTextFillGradient: (function () {
      const ownTfc = cs.webkitTextFillColor || cs.WebkitTextFillColor || '';
      // Only meaningful when our own text is transparent.
      if (!/^(rgba\(0[^)]*?,\s*0\)|transparent)$/i.test(ownTfc.trim())) return undefined;
      // Walk up at most 8 ancestors looking for `background-clip: text`
      // + a non-none `background-image`. 8 covers the Stripe hds-heading
      // depth-of-2 nesting comfortably without scanning the whole tree.
      let p = el.parentElement;
      let depth = 0;
      while (p != null && depth < 8) {
        const pcs = window.getComputedStyle(p);
        const bc = (pcs.backgroundClip || '') + ' ' + (pcs.webkitBackgroundClip || '');
        if (/\btext\b/i.test(bc) && pcs.backgroundImage && pcs.backgroundImage !== 'none' && pcs.backgroundImage !== '') {
          return pcs.backgroundImage;
        }
        p = p.parentElement;
        depth++;
      }
      return undefined;
    })(),
    // DM-719: `-webkit-text-stroke-width` / `-webkit-text-stroke-color` paint a
    // stroke around each glyph outline. Captured so the renderer can add a
    // `stroke` attribute to the text-path emission.
    webkitTextStrokeWidth: cs.webkitTextStrokeWidth || cs.WebkitTextStrokeWidth || undefined,
    webkitTextStrokeColor: cs.webkitTextStrokeColor || cs.WebkitTextStrokeColor || undefined,
    paintOrder: cs.paintOrder || undefined,
    backgroundOrigin: cs.backgroundOrigin,
    backgroundAttachment: cs.backgroundAttachment,
    backgroundIntrinsic: computeBackgroundIntrinsic(cs),
    borderImageSource: cs.borderImageSource,
    borderImageSlice: cs.borderImageSlice,
    borderImageWidth: cs.borderImageWidth,
    borderImageOutset: cs.borderImageOutset,
    borderImageRepeat: cs.borderImageRepeat,
    borderImageIntrinsicWidth: computeBorderImageIntrinsic(cs, 'naturalWidth'),
    borderImageIntrinsicHeight: computeBorderImageIntrinsic(cs, 'naturalHeight'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: normColor(cs.outlineColor),
    outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow,
    // box-decoration-break: 'slice' (default) vs 'clone'. Drives per-fragment
    // paint of wrapped inline elements; see CapturedElement.inlineFragments.
    boxDecorationBreak: cs.boxDecorationBreak || cs.webkitBoxDecorationBreak || 'slice',
  });

  return { captureBordersBackgrounds };
};
