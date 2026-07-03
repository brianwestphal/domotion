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
// DM-991: `<textarea>` text shaping now ALSO probes per-character Range
// rects, but on a hidden `<div>` mirror sized + styled like the textarea's
// content box (white-space: pre-wrap to honour author newlines and let
// the browser do its soft-wrap). The probe's wrap points and per-char x
// positions match Chrome's painted positions in the real textarea because
// both run the same inline-layout algorithm given the same constraints.
// Per-line textSegments[] are produced and returned alongside the single-
// line top-level locals; the dispatcher in captureInner spreads them.
//
// The textarea-specific probe path supersedes the earlier elementRaster
// fallback (which screenshotted the painted content box because
// reimplementing Chrome's word-wrap from scratch was deemed too brittle —
// turns out the browser's own layout, prompted via the probe div, is the
// correct source of truth for the wrap positions, same as for `<input>`).

import { sideWidths } from "../utils.js";

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
    const { left: bl, top: bt, right: br, bottom: bb } = sideWidths(cs, 'border', 'Width');
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
    //
    // DM-666: `<input type="submit" | "button" | "reset">` are button-type
    // inputs whose value text Chrome ALWAYS centers vertically inside the
    // content box — this is the UA-stylesheet `appearance: button`
    // behaviour, independent of `display` / `align-items`. Google's
    // homepage "Google Search" / "I'm Feeling Lucky" inputs are exactly
    // this case: `display: inline-block`, no flex, 36-px tall with 14-px
    // text — the value sits dead-centre in Chrome but anchored to
    // content-top in the captured tree pre-fix. Extending the centring to
    // these button types here keeps the renderer's textTop = line-box-top
    // contract intact.
    const display = cs.display;
    const isFlexLike = display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid';
    // DM-1587: Chrome vertically centers a single-line `<input>`'s value text within
    // its content box for EVERY input type (the text-field editing host centers its
    // single line), not just submit/button/reset (DM-666) or flex/align-center
    // containers (DM-581). Anchoring the captured value to content-top left tall
    // text/tel/email/etc. fields sitting high — e.g. the type-resample phone field
    // (height 42, font 16, no vertical padding → the value sat ~10px too high). A
    // `<textarea>` lays multiple lines from the top, so it stays top-anchored unless
    // it's an explicit flex/align-center container.
    const isSingleLineInput = tag === 'input';
    if (isSingleLineInput || (isFlexLike && cs.alignItems === 'center')) {
      const contentH = rect.height - bt - bb - pt - pb;
      if (contentH > textHeight + 0.5) {
        textTop = (rect.top - vp.y + bt + pt) + (contentH - textHeight) / 2;
      }
    }
    const metrics = measureFontMetrics(cs);
    const fontAscent = metrics.ascent;
    const fontDescent = metrics.descent;
    // Half-leading: a single line of height `textHeight` (the used line-height)
    // centers the font box (ascent + descent) within it by (textHeight - fontH)/2
    // on each side. The renderer treats `textTop` as the line-box top and draws
    // the baseline at textTop + ascent, so fold the half-leading into textTop.
    const fontH = fontAscent + fontDescent;
    if (cs.lineHeight !== 'normal' && textHeight > fontH + 0.5) {
      // DM-1259: an EXPLICIT line-height TALLER than the font → positive
      // half-leading; the single line's text is centered in the line box, LOWER
      // than the line-box top (`06-deep-input-baseline`'s `line-height:35.2` /
      // `font-size:16` email field rendered ~8px too high without this).
      // Gated to an explicit line-height: for `line-height: normal` we estimate
      // textHeight as 1.2×font-size, which OVER-counts the real normal line box
      // (≈ fontH) — applying the down-shift there mis-centered every
      // field-sizing input (DM-1259 regression).
      textTop += (textHeight - fontH) / 2;
    } else if (fontH > textHeight + 0.5) {
      // DM-581: line-height SHORTER than the font (framer's `font-size:14;
      // line-height:14` button, Inter natural height 17) → negative leading; the
      // glyphs sit ~(fontH - lineHeight)/2 ABOVE the content-box top.
      textTop -= (fontH - textHeight) / 2;
    }

    // DM-991: textareas produce per-line textSegments via a soft-wrap probe
    // (see end-of-function for the probe), so the single-line top-level
    // metrics (textLeft / textTop / textWidth / textHeight) only describe
    // the FIRST line. Other text-handling fields still mirror the input
    // path; inputXOffsets stays `undefined` for textareas (per-line
    // xOffsets live inside `textSegments`).
    let textSegments;
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

    // DM-991: textarea per-line probe. Mirror the textarea's content-box
    // width + font + wrap properties in a hidden `<div>`, set the same
    // text, then read per-character Range rects. The probe wraps at the
    // same chars Chrome wraps the real textarea at because both run the
    // same inline-layout algorithm under the same constraints.
    //
    // The probe is offscreen so it doesn't affect layout of the rest of
    // the page, but it must sit at a non-zero device coordinate (otherwise
    // some browsers short-circuit Range.getBoundingClientRect for
    // visually-clipped subtrees). `left: 0; top: -100000px` keeps the
    // probe at width-honouring layout while keeping it visually offscreen.
    if (text.length > 0 && tag === 'textarea') {
      const contentBoxW = rect.width - bl - br - pl - pr;
      const contentBoxH = rect.height - bt - bb - pt - pb;
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.left = '0';
      probe.style.top = '-100000px';
      probe.style.visibility = 'hidden';
      probe.style.boxSizing = 'content-box';
      probe.style.width = contentBoxW + 'px';
      // No height constraint — let the probe grow to fit; Chrome's textarea
      // scrolls if the content exceeds its height, but the painted positions
      // for the visible chars match what an unscrolled tall box would
      // produce (per-line positions are independent of scroll).
      probe.style.padding = '0';
      probe.style.margin = '0';
      probe.style.border = '0';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.fontStyle = cs.fontStyle;
      probe.style.fontVariationSettings = cs.fontVariationSettings;
      probe.style.fontFeatureSettings = cs.fontFeatureSettings;
      probe.style.fontKerning = cs.fontKerning;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.style.wordSpacing = cs.wordSpacing;
      probe.style.lineHeight = cs.lineHeight;
      probe.style.tabSize = cs.tabSize;
      probe.style.textAlign = cs.textAlign;
      probe.style.direction = cs.direction;
      // Textareas default to `white-space: pre-wrap` so newlines in `.value`
      // become line breaks AND long lines soft-wrap on word boundaries.
      // Use `white-space: pre-wrap` explicitly instead of inheriting the
      // textarea's computed value — the textarea's UA stylesheet pins this
      // and we want the probe to match regardless of any page-author
      // override that didn't actually apply.
      probe.style.whiteSpace = 'pre-wrap';
      probe.style.wordWrap = cs.wordWrap || 'normal';
      probe.style.overflowWrap = cs.overflowWrap || 'normal';
      probe.style.wordBreak = cs.wordBreak || 'normal';
      // hyphens — only matters when soft-hyphen / hyphens: auto are used;
      // mirror to match the real textarea's wrapping.
      probe.style.hyphens = cs.hyphens || 'manual';
      probe.textContent = text;
      document.body.appendChild(probe);
      const probeNode = probe.firstChild;
      if (probeNode != null) {
        const probeBox = probe.getBoundingClientRect();
        const probeOriginX = probeBox.left;
        const probeOriginY = probeBox.top;
        // Group per-character rects into visual lines by their Y top.
        // Each line becomes a textSegment with its own xOffsets[] for the
        // chars in that line. Newline chars (\n) produce zero-width rects
        // at the prior line's end; skip them (they're not painted).
        const lines = [];
        let cur = null;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          // Skip the newline itself — it's a hard break, not a painted
          // glyph. The next visible char starts a new line via cur === null.
          if (ch === '\n') {
            if (cur != null) { lines.push(cur); cur = null; }
            continue;
          }
          const code = text.charCodeAt(i);
          const isHigh = code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length;
          const step = isHigh ? 2 : 1;
          const rng = document.createRange();
          rng.setStart(probeNode, i);
          rng.setEnd(probeNode, i + step);
          const cr = rng.getBoundingClientRect();
          // Zero-width / zero-height rect → invisible (e.g. a trailing
          // space at a wrap point). Skip; the next visible char tells us
          // where the new line starts.
          if (cr.width === 0 && cr.height === 0) { i += step - 1; continue; }
          const charLeft = cr.left - probeOriginX;
          const charTop = cr.top - probeOriginY;
          const charRight = cr.right - probeOriginX;
          const charBottom = cr.bottom - probeOriginY;
          // New line if we haven't started one, or the Y jumped down.
          if (cur == null || charTop - cur.top > Math.max(1, (cur.bottom - cur.top) * 0.5)) {
            if (cur != null) lines.push(cur);
            cur = { text: '', xOffsets: [], top: charTop, bottom: charBottom, left: charLeft, right: charRight };
          }
          for (let k = 0; k < step; k++) {
            cur.text += text[i + k];
            cur.xOffsets.push(textLeft + charLeft);
          }
          if (charRight > cur.right) cur.right = charRight;
          if (charBottom > cur.bottom) cur.bottom = charBottom;
          i += step - 1;
        }
        if (cur != null) lines.push(cur);
        // Emit textSegments — one per visual line. y is viewport-relative
        // (textTop + offset within the probe).
        textSegments = lines.map(ln => ({
          text: ln.text,
          x: textLeft + ln.left,
          y: textTop + ln.top,
          width: ln.right - ln.left,
          height: ln.bottom - ln.top,
          xOffsets: ln.xOffsets,
        }));
      }
      document.body.removeChild(probe);
      // Suppress the unused single-char-mode contentBoxH warning.
      void contentBoxH;
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
      textSegments,
      isPlaceholderCapture,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
    };
  };

  return { captureInputValue };
};
