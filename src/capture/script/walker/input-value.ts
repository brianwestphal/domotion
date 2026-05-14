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

export const createInputValueHandler = ({ vp, measureFontMetrics }) => {
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
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    let textLeft = rect.left - vp.x + bl + pl;
    const textTop = rect.top - vp.y + bt + pt;
    const textHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const textWidth = rect.width - bl * 2 - pl * 2;
    const metrics = measureFontMetrics(cs);
    const fontAscent = metrics.ascent;
    const fontDescent = metrics.descent;

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
        const pr = parseFloat(cs.paddingRight) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
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
    };
  };

  return { captureInputValue };
};
