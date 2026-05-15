// @ts-nocheck
//
// Input / textarea value-as-text capture. When the host is a non-skipped
// input or textarea, this handler shapes `el.value` (or the `placeholder`
// attribute fallback) into the text-shaping locals — `text`, content-box
// `textLeft` / `textTop` / `textWidth` / `textHeight`, font metrics, and
// (for `<input>`) the sub-pixel per-character `inputXOffsets` array — and
// returns them in one object. The dispatcher copies the result into
// captureInner's text-shaping state and short-circuits the text-node
// walker for this element.
//
// Skipped input types — `range`, `color`, `checkbox`, `radio`, `file`,
// `image`, `hidden`, `date`, `time`, `datetime-local`, `month`, `week`
// — render their value via native chrome painted by `form-controls.ts`.
// Capturing the raw value here would stack text under the synthesized
// chrome with the wrong content (e.g. raw `2026-04-21` under a `MM/DD/
// YYYY` date picker).
//
// SK-1097 / SK-1100 — placeholder fallback. When an input/textarea has no
// user-typed value but carries a `placeholder` attribute, Chrome paints
// the attribute text in the computed `::placeholder` color (default muted
// gray). Capture it the same way so the renderer produces the same
// visible string just with the placeholder color. The dispatcher reads
// `isPlaceholderCapture` to emit the placeholder-color metadata and pass
// it to `borders-backgrounds.ts` for the placeholder-shown bg fallback.
//
// Password masking — replace the raw value with a same-length bullet
// string so the field reads like Chrome's masked view rather than leaking
// the plaintext. Placeholder text is rendered as-is even on password
// inputs (Chrome doesn't mask placeholders).
//
// SK-1234 — per-character `inputXOffsets` via a hidden probe span.
// Without these the renderer falls back to fontkit's native advances
// which drift ~0.5px/char vs Chromium's HarfBuzz shaping. The probe
// replicates the input's font properties (family / size / weight / style
// / letter-spacing / kerning / variations / features) so per-char Range
// rects produce the same shaping Chrome would paint.
//
// DM-353 — honor text-align inside an `<input>`. Chrome centers / right-
// aligns the value within the content box; the probe is an inline-level
// span so its xOffsets are flush-left and need post-shift. Without this
// `.spin input` with `text-align: center` left "3" against the left
// padding instead of centered between the +/- buttons.
//
// Only `<input>` runs the inputXOffsets probe — `<textarea>` text shaping
// goes through the elementRaster path on the captureInner side (see
// SK-1108 / DM-625 follow-ups).

const SKIP_VALUE_TYPES = new Set([
  'range', 'color', 'checkbox', 'radio',
  'file', 'image', 'hidden',
  'date', 'time', 'datetime-local', 'month', 'week',
]);

const NOT_APPLIED = { applied: false };

export const createInputValueHandler = ({ vp, normColor, measureFontMetrics }) => {
  const captureInputValue = (el, cs, tag, rect) => {
    if (tag !== 'input' && tag !== 'textarea') return NOT_APPLIED;
    const inputType = tag === 'input' ? (el.type || 'text') : '';
    if (SKIP_VALUE_TYPES.has(inputType)) return NOT_APPLIED;

    let isPlaceholderCapture = false;
    let text = '';
    if (!el.value) {
      const placeholder = el.getAttribute && el.getAttribute('placeholder');
      if (placeholder != null && placeholder !== '') {
        isPlaceholderCapture = true;
        text = placeholder;
      } else {
        return NOT_APPLIED;
      }
    } else {
      text = inputType === 'password' ? '•'.repeat(el.value.length) : el.value;
    }

    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    let textLeft = rect.left - vp.x + bl + pl;
    let textTop = rect.top - vp.y + bt + pt;
    const textHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const textWidth = rect.width - bl * 2 - pl * 2;
    // DM-581: when the input is laid out as a flex/grid container with
    // `align-items: center`, Chrome paints the value text vertically
    // centered within the content box rather than anchored at content-top.
    // The renderer treats `textTop` as the line-box top (baseline = textTop
    // + ascent), so without this adjustment the text shows up at the top
    // of the button instead of centered. Surfaced by framer-mobile-fold's
    // "Okay" button (display: flex; align-items: center; height: 45px).
    const display = cs.display;
    const isFlexLike = display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid';
    if (isFlexLike && cs.alignItems === 'center') {
      const contentH = rect.height - bt - bb - pt - pb;
      if (contentH > textHeight + 0.5) {
        textTop = (rect.top - vp.y + bt + pt) + (contentH - textHeight) / 2;
      }
    }
    const metrics = measureFontMetrics(cs);
    const fontAscent = metrics.ascent;
    const fontDescent = metrics.descent;
    // DM-581: when CSS `line-height` is shorter than the font's natural
    // ascent+descent (e.g. framer's `font-size:14;line-height:14` button
    // with Inter SemiBold whose natural fontHeight is 17), Chrome paints
    // the line box with negative half-leading on each side — so the line
    // box top sits ~(fontHeight - lineHeight)/2 above the content-box top.
    // The renderer treats `textTop` as the line-box top, so without this
    // adjustment the rendered baseline ends up ~(fontHeight - lineHeight)/2
    // below where Chrome paints it.
    const fontH = fontAscent + fontDescent;
    if (fontH > textHeight + 0.5) {
      textTop -= (fontH - textHeight) / 2;
    }

    let inputXOffsets;
    if (text.length > 0 && tag === 'input') {
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.left = '-9999px';
      probe.style.top = '-9999px';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.fontStyle = cs.fontStyle;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.style.fontKerning = cs.fontKerning;
      probe.style.fontVariationSettings = cs.fontVariationSettings;
      probe.style.fontFeatureSettings = cs.fontFeatureSettings;
      probe.textContent = text;
      document.body.appendChild(probe);
      const probeNode = probe.firstChild;
      if (probeNode != null) {
        const probeBox = probe.getBoundingClientRect();
        const probeOriginX = probeBox.left;
        const xs = [];
        let i = 0;
        while (i < text.length) {
          const code = text.charCodeAt(i);
          const isHigh = code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length;
          const step = isHigh ? 2 : 1;
          const rng = document.createRange();
          rng.setStart(probeNode, i);
          rng.setEnd(probeNode, i + step);
          const cr = rng.getBoundingClientRect();
          const left = cr.left - probeOriginX + textLeft;
          for (let k = 0; k < step; k++) xs.push(left);
          i += step;
        }
        const contentBoxW = rect.width - bl - br - pl - pr;
        const probeW = probeBox.width;
        const slack = contentBoxW - probeW;
        const align = cs.textAlign;
        const dir = cs.direction;
        let shift = 0;
        if (slack > 0) {
          if (align === 'center') shift = slack / 2;
          else if (align === 'right' || (align === 'end' && dir !== 'rtl') || (align === 'start' && dir === 'rtl')) shift = slack;
        }
        if (shift !== 0) {
          textLeft += shift;
          for (let k = 0; k < xs.length; k++) xs[k] += shift;
        }
        inputXOffsets = xs;
      }
      document.body.removeChild(probe);
    }

    // SK-1099 + SK-1097 / SK-1100: when the captured text came from a
    // placeholder attribute, the renderer paints it in `::placeholder`
    // color (default muted gray) with optionally-overridden font-style /
    // font-weight. Read the pseudo styles here so the dispatcher can stamp
    // them on the captured element alongside `isPlaceholderText: true`.
    let placeholderColor;
    let placeholderFontStyle;
    let placeholderFontWeight;
    if (isPlaceholderCapture) {
      const phCs = window.getComputedStyle(el, '::placeholder');
      placeholderColor = normColor(phCs.color || cs.color);
      placeholderFontStyle = phCs.fontStyle;
      placeholderFontWeight = phCs.fontWeight;
    }

    return {
      applied: true,
      text,
      textLeft,
      textTop,
      textHeight,
      textWidth,
      fontAscent,
      fontDescent,
      inputXOffsets,
      isPlaceholderCapture,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
    };
  };

  return { captureInputValue };
};
