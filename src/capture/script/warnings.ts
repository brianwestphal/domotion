//
// Capture-side warning collection. `warn(sel, feature, detail)` records a
// dedup'd entry for a feature domotion can't fully round-trip; the array is
// returned to the Node-side caller as part of the captureElementTree result.
// `shortSelector(el)` builds a developer-friendly path string for the entry.
// See SK-465 for the original spec.

import type { CaptureWarning } from "../types.js";

export const createWarnings = () => {
  const warnings: CaptureWarning[] = [];
  const seen = new Set<string>();

  // Build a short CSS-selectorish path for an element. Not guaranteed unique;
  // just enough context for a developer to find it.
  const shortSelector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur != null && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) {
        p += "#" + cur.id;
        parts.unshift(p);
        break;
      }
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join(".");
        if (cls !== "") p += "." + cls;
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };

  const warn = (sel: string, feature: string, detail: string): void => {
    const k = feature + "|" + sel;
    if (seen.has(k)) return;
    seen.add(k);
    warnings.push({ selector: sel, feature, detail });
  };

  return { warn, shortSelector, warnings };
};
