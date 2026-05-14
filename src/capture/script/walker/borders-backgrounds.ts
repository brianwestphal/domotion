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

export const createBordersBackgroundsHandler = ({ normColor, resolvePlaceholderShownBg, resolveCornerRadius }) => {
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
      // Match all three url() forms: "...", '...', and bare. Data: URLs
      // with embedded HTML attribute quotes (escaped as \") were silently
      // truncated by a prior single-regex implementation. DM-308.
      const u = /^\s*url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s]+))\s*\)/.exec(layer);
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
    borderTopStyle: cs.borderTopStyle,
    borderRightStyle: cs.borderRightStyle,
    borderBottomStyle: cs.borderBottomStyle,
    borderLeftStyle: cs.borderLeftStyle,
    borderTopColor: tintedBorderColor(tag, el, cs, 'borderTopColor'),
    borderRightColor: tintedBorderColor(tag, el, cs, 'borderRightColor'),
    borderBottomColor: tintedBorderColor(tag, el, cs, 'borderBottomColor'),
    borderLeftColor: tintedBorderColor(tag, el, cs, 'borderLeftColor'),
    borderCollapse: cs.borderCollapse,
    frostedBgFallback: computeFrostedBgFallback(cs),
    backgroundImage: cs.backgroundImage,
    backgroundSize: cs.backgroundSize,
    backgroundPosition: cs.backgroundPosition,
    backgroundRepeat: cs.backgroundRepeat,
    backgroundClip: cs.backgroundClip,
    // DM-462: -webkit-text-fill-color is the property that actually makes
    // the headline text transparent in the background-clip:text idiom
    // (cs.color may still report a normal value).
    webkitTextFillColor: cs.webkitTextFillColor || cs.WebkitTextFillColor || undefined,
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
  });

  return { captureBordersBackgrounds };
};
