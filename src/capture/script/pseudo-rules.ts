// @ts-nocheck
//
// Blink-resolved WebKit form-control pseudo facts are collected by the
// Node-side CDP prepass (`pseudo-style-cdp.ts`). Most of these pseudos are
// closed-UA-shadow nodes, for which getComputedStyle(host, pseudo) returns the
// host's style. The old document.styleSheets walker reproduced only source
// order and could not model specificity, !important, origins, cascade layers,
// @scope, conditional rules, adopted sheets, or shadow tree scopes. This page
// helper now performs only a non-mutating host-id lookup.

const _emptyPseudo = {
  matched: false,
  width: '',
  height: '',
  backgroundColor: '',
  borderRadius: '',
  backgroundImage: '',
  border: '',
  padding: '',
  boxShadow: '',
};

export const createPseudoRules = (stylesByHost, propertyKey) => {

  // Resolve a single border-corner-radius value (e.g. "30px" or "50% 20%") to
  // a px-based axis-pair the renderer can use. Chrome's longhand corner values
  // come back already-resolved to px when the author used px, but a percent-
  // valued radius is preserved as e.g. "50%" so we have to evaluate it against
  // the box dimensions ourselves. Returns "h v" in px (two numbers separated
  // by a space) — h is the horizontal axis (resolved against rect width) and
  // v is the vertical axis (resolved against rect height). Per-corner radii
  // can be elliptical; returning the pair lets the renderer emit per-axis arc
  // commands without losing the elliptical shape (e.g. border-radius:50px/20px).
  // DM-909: `getComputedStyle().borderRadius` returns the AUTHORED CSS
  // length (e.g. "4px") regardless of `zoom`, but the element's rect is
  // SCALED by the effective zoom (4px on a zoom:2 box renders as 8px on
  // screen). Pass the effective zoom so px values track the painted size;
  // % values resolve against the (already-scaled) rect, so the `* zoom`
  // skip on that branch keeps them correct.
  const resolveCornerRadius = (v, w, h, zoom) => {
    if (v == null || v === '') return '0px 0px';
    const z = zoom == null || zoom <= 0 ? 1 : zoom;
    const parts = v.split(/\s+/);
    const a = parts[0] || '0';
    const b = parts[1] != null ? parts[1] : a;
    const aPx = a.endsWith('%') ? (parseFloat(a) || 0) * w / 100 : (parseFloat(a) || 0) * z;
    const bPx = b.endsWith('%') ? (parseFloat(b) || 0) * h / 100 : (parseFloat(b) || 0) * z;
    return aPx + 'px ' + bPx + 'px';
  };

  const resolvePseudo = (el, kind) => {
    if (propertyKey == null || propertyKey === '' || stylesByHost == null) return _emptyPseudo;
    const hostId = el[propertyKey];
    if (hostId == null) return _emptyPseudo;
    return stylesByHost[hostId] && stylesByHost[hostId][kind]
      ? stylesByHost[hostId][kind]
      : _emptyPseudo;
  };

  return { resolvePseudo, resolveCornerRadius };
};
