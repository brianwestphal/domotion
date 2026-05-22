// @ts-nocheck
//
// Color-string normalization. `normColor(c, elColor)` turns any CSS <color>
// (named, hex, hsl, hwb, lab/lch, oklab/oklch, color(), color-mix(), etc.)
// into an srgb form parseColor() (Node side) can consume.
//
// Mechanism: a hidden probe element with
// `color-mix(in srgb, <c> 100%, transparent 0%)` forces getComputedStyle()
// to resolve wide-gamut inputs into `color(srgb r g b / alpha)` or
// `rgb()/rgba()`. Canvas fillStyle works for srgb but silently rejects
// lab/lch/oklab/oklch/color(), so we avoid it.
//
// DM-519: `currentcolor` inside a color-mix expression resolves at
// used-value time against the element's own `color`. Our probe has its own
// (default black) `color`, so passing `currentcolor` would tint against
// black. When the caller passes the source element's `cs.color`, substitute
// currentcolor with that value before probing.

export const createColorNorm = () => {
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);

  const normColor = (c, elColor) => {
    if (c == null || c === '' || c === 'transparent' || c === 'currentcolor' || c === 'auto') return c;
    // Fast path: already in rgb/rgba/#hex form.
    if (/^(rgba?\(|#[0-9a-f]{3,8}$)/i.test(c)) return c;
    var probeIn = c;
    if (elColor != null && elColor !== '' && /\bcurrentcolor\b/i.test(c)) {
      probeIn = c.replace(/\bcurrentcolor\b/gi, elColor);
    }
    try {
      probe.style.color = '';
      probe.style.color = 'color-mix(in srgb, ' + probeIn + ' 100%, transparent 0%)';
      const v = getComputedStyle(probe).color;
      if (v != null && v !== '') return v;
    } catch (e) { /* fall through */ }
    return c;
  };

  // DM-800: Chromium retains wide-gamut color functions verbatim inside
  // computed gradient stops (e.g. `linear-gradient(90deg, oklch(0.89 0.04
  // 264), …)`). The render-side `parseColor` doesn't speak oklch/lab/lch/
  // oklab/hwb and falls back to black for any stop it can't decode,
  // collapsing the tinted-gradient strip to mostly-black bars. Walk the
  // gradient text and replace each wide-gamut color call with its
  // normColor-resolved form so the renderer only sees rgb()/color(srgb).
  // `color-mix(...)` doesn't appear here because Chromium pre-resolves it
  // inside gradients to its target color space (e.g. `color-mix(in oklch,
  // red, blue)` serializes as `oklch(...)`), but we match it defensively in
  // case future Chromium versions change that.
  const normGradientColors = (text, elColor) => {
    if (text == null || text === '' || text === 'none') return text;
    // Match a color-function identifier followed by a balanced (...) group.
    const fnRe = /\b(oklch|oklab|lab|lch|hwb|hsl|hsla|color|color-mix)\(/gi;
    var out = '';
    var i = 0;
    while (i < text.length) {
      fnRe.lastIndex = i;
      const m = fnRe.exec(text);
      if (m == null) { out += text.slice(i); break; }
      out += text.slice(i, m.index);
      // Walk forward consuming balanced parens.
      var depth = 1;
      var j = m.index + m[0].length;
      while (j < text.length && depth > 0) {
        const ch = text[j++];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      const call = text.slice(m.index, j);
      out += normColor(call, elColor);
      i = j;
    }
    return out;
  };

  return { normColor, normGradientColors };
};
