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

  return { normColor };
};
