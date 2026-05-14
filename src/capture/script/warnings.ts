// @ts-nocheck
//
// Capture-side warning collection. `warn(sel, feature, detail)` records a
// dedup'd entry for a feature domotion can't fully round-trip; the array is
// returned to the Node-side caller as part of the captureElementTree result.
// `shortSelector(el)` builds a developer-friendly path string for the entry.
// See SK-465 for the original spec.

export const createWarnings = () => {
  const warnings = [];
  const seen = new Set();

  // Build a short CSS-selectorish path for an element. Not guaranteed unique;
  // just enough context for a developer to find it.
  const shortSelector = (el) => {
    const parts = [];
    let cur = el;
    while (cur != null && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += '#' + cur.id; parts.unshift(p); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls !== '') p += '.' + cls;
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const warn = (sel, feature, detail) => {
    const k = feature + '|' + sel;
    if (seen.has(k)) return;
    seen.add(k);
    warnings.push({ selector: sel, feature, detail });
  };

  return { warn, shortSelector, warnings };
};
