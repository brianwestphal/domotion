// @ts-nocheck
//
// `:placeholder-shown` background-color capture. The renderer applies the
// captured color conditionally on inputs whose value is empty + a
// placeholder attribute is set. See DM-283.
//
// Mechanism: walk all stylesheets for rules whose selectorText contains
// `:placeholder-shown`, strip the pseudo from the selector to get a host
// selector that `el.matches()` can test even when the element isn't
// currently in the matched state, and stash the rule's bg-color.

import { isUnsetCssValue, firstColorRe } from "./utils.js";

export const createPlaceholderShown = () => {
  const rules = [];
  const collect = (cssRules) => {
    if (cssRules == null) return;
    for (let i = 0; i < cssRules.length; i++) {
      const rule = cssRules[i];
      if (rule == null) continue;
      const sel = rule.selectorText;
      if (typeof sel === 'string' && sel.indexOf(':placeholder-shown') >= 0) {
        const hostSel = sel.replace(/:placeholder-shown/g, '').trim() || '*';
        const decl = rule.style;
        let bg = '';
        if (!isUnsetCssValue(decl.backgroundColor)) bg = decl.backgroundColor;
        else if (!isUnsetCssValue(decl.background)) {
          const cm = decl.background.match(firstColorRe);
          if (cm != null) bg = cm[1];
        }
        if (bg !== '') rules.push({ hostSel: hostSel, bg: bg });
      }
      if (rule.cssRules != null && rule.cssRules.length > 0) collect(rule.cssRules);
    }
  };
  for (let i = 0; i < document.styleSheets.length; i++) {
    try { collect(document.styleSheets[i].cssRules); } catch (e) { /* CORS — skip */ }
  }

  // Resolve `:placeholder-shown` bg color for an empty-with-placeholder input.
  // Returns the captured color or empty string. Later-source rules win.
  const resolvePlaceholderShownBg = (el) => {
    let bg = '';
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      let isMatch = false;
      try { isMatch = el.matches(r.hostSel); } catch (e) { /* invalid */ }
      if (isMatch) bg = r.bg;
    }
    return bg;
  };

  return { resolvePlaceholderShownBg };
};
