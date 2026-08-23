// @ts-nocheck
//
// DM-2051: detect a `kStandardFamily` element — one whose `font-family` is the
// UA-default initial value because NO author rule set it anywhere in the
// element's inherited cascade. Blink resolves such a description through
// `FamilyNameFromSettings` → `settings.Standard(script)`
// (`platform/fonts/font_selector.cc:71-75`, rev 7d859f27): the family is
// SCRIPT-KEYED, so a `lang=ja` element with no declared family paints the
// Japanese standard face (Hiragino…) for its WHOLE run, Latin included — even
// though `getComputedStyle().fontFamily` serializes to the concrete standard
// name ("Times" on mac). Capture cannot see the difference from the computed
// string alone: a declared `font-family: Times` serializes identically but
// paints Times for Latin and only FALLS BACK to Hiragino for the CJK.
//
// So we detect the UA-default case here and the caller rewrites the captured
// family to the `-webkit-standard` generic keyword, which the renderer's
// `matchFamilyNameToKey("-webkit-standard", true, lang)` routes to the same
// script-keyed standard entry Blink uses. That is the faithful representation:
// `-webkit-standard` IS what a kStandardFamily description maps to.
//
// The detection, validated against Chrome (CDP CSS.getPlatformFontsForNode) over
// a scenario matrix (tools/scratch/dm2051-standard-family-probe.mjs):
//
//   1. The computed first family must be a CONCRETE name, not a generic
//      keyword. A UA rule only ever sets a GENERIC family (`pre`/`code` →
//      `monospace`) which serializes as the keyword and is already routed
//      script-keyed by the declared-generic path; a concrete computed name with
//      no author declaration can only be the standard initial value.
//   2. NO author `font-family` declaration on self or any ancestor. Sources:
//      an inline `style` (its `.fontFamily` reflects both `font-family:` and the
//      `font` shorthand), a `<font face>` presentation attribute, or any
//      matching author RULE whose declaration sets font-family (again incl. the
//      `font` shorthand, since `rule.style.fontFamily` reflects it). font-family
//      inherits, so a declaration on ANY ancestor makes the element non-initial.

import { parseCssFontFamilyEntries } from "../../font-family-stack.js";

// CSS generic-family keywords (+ the -webkit- / ui- forms Blink recognizes).
// A computed first-family equal to one of these is a DECLARED or UA generic,
// never the concrete standard initial value — so it is not this case.
const GENERIC_FAMILY_KEYWORDS = {
  "serif": 1, "sans-serif": 1, "monospace": 1, "cursive": 1, "fantasy": 1,
  "system-ui": 1, "ui-serif": 1, "ui-sans-serif": 1, "ui-monospace": 1,
  "ui-rounded": 1, "emoji": 1, "math": 1, "fangsong": 1,
  "-webkit-body": 1, "-webkit-standard": 1, "-webkit-pictograph": 1,
};

export const createFontFamilyDefault = () => {
  // Cache author font selectors per Document. Iframe recursion walks elements
  // from several documents in one capture; consulting only the top document's
  // sheets makes an inherited iframe rule look like the UA default.
  const selectorsByDocument = new WeakMap();
  const splitSelectorList = (selectorText) => {
    const selectors = [];
    let token = '', quote = '', square = 0, round = 0;
    for (let index = 0; index < selectorText.length; index++) {
      const ch = selectorText[index];
      if (ch === '\\') {
        token += ch;
        if (index + 1 < selectorText.length) token += selectorText[++index];
        continue;
      }
      if (quote !== '') {
        token += ch;
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; token += ch; continue; }
      if (ch === '[') square++;
      else if (ch === ']') square = Math.max(0, square - 1);
      else if (ch === '(') round++;
      else if (ch === ')') round = Math.max(0, round - 1);
      if (ch === ',' && square === 0 && round === 0) {
        if (token.trim() !== '') selectors.push(token.trim());
        token = '';
      } else token += ch;
    }
    if (token.trim() !== '') selectors.push(token.trim());
    return selectors;
  };
  const pseudoNames = ['before', 'after', 'first-letter', 'first-line', 'placeholder', 'file-selector-button'];
  const pseudoHostSelector = (selector, pseudoName) => {
    const lower = selector.toLowerCase();
    let quote = '', square = 0, round = 0;
    for (let index = 0; index < selector.length; index++) {
      const ch = selector[index];
      if (ch === '\\') { index++; continue; }
      if (quote !== '') { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') { square++; continue; }
      if (ch === ']') { square = Math.max(0, square - 1); continue; }
      if (ch === '(') { round++; continue; }
      if (ch === ')') { round = Math.max(0, round - 1); continue; }
      if (square !== 0 || round !== 0 || ch !== ':') continue;
      const double = selector[index + 1] === ':';
      const start = index + (double ? 2 : 1);
      if (!lower.startsWith(pseudoName, start)) continue;
      const end = start + pseudoName.length;
      if (end < selector.length && /[-_a-z0-9]/i.test(selector[end])) continue;
      // Legacy single-colon spelling exists only for CSS2 pseudos.
      if (!double && !['before', 'after', 'first-letter', 'first-line'].includes(pseudoName)) continue;
      return `${selector.slice(0, index)}${selector.slice(end)}`.trim() || '*';
    }
    return null;
  };
  const collect = (cssRules, familySelectors, pseudoFamilyRules) => {
    if (cssRules == null) return;
    for (let i = 0; i < cssRules.length; i++) {
      const rule = cssRules[i];
      if (rule == null) continue;
      const sel = rule.selectorText;
      if (typeof sel === "string" && rule.style != null && rule.style.fontFamily !== "") {
        for (const selector of splitSelectorList(sel)) {
          const pseudo = pseudoNames.map((name) => ({ name, hostSelector: pseudoHostSelector(selector, name) }))
            .find((candidate) => candidate.hostSelector != null);
          if (pseudo != null) {
            pseudoFamilyRules.push({ pseudoName: pseudo.name, hostSelector: pseudo.hostSelector, value: rule.style.fontFamily });
          } else {
            familySelectors.push(selector);
          }
        }
      }
      // Recurse into @media / @supports / grouping rules.
      if (rule.cssRules != null && rule.cssRules.length > 0) collect(rule.cssRules, familySelectors, pseudoFamilyRules);
    }
  };
  const selectorsFor = (doc) => {
    const cached = selectorsByDocument.get(doc);
    if (cached != null) return cached;
    const familySelectors = [], pseudoFamilyRules = [];
    for (let i = 0; i < doc.styleSheets.length; i++) {
      try { collect(doc.styleSheets[i].cssRules, familySelectors, pseudoFamilyRules); } catch (e) { /* CORS — skip */ }
    }
    const result = { familySelectors, pseudoFamilyRules };
    selectorsByDocument.set(doc, result);
    return result;
  };

  // Form controls carry a UA `font: -webkit-small-control` (a CONCRETE family,
  // "Arial" on every platform — `core/html/resources/html.css:427`,
  // `input, textarea, select, button`), which is a SYSTEM font (kNoFamily), not
  // kStandardFamily — Chrome does NOT route it through settings.Standard. Their
  // descendants inherit that concrete family too. So a control anywhere on the
  // cascade means the element is not the standard initial value. (`textarea`
  // computes the `monospace` keyword — a later UA rule wins — and is excluded by
  // the generic-name test regardless, but is listed here for completeness.)
  const UA_CONCRETE_FAMILY_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, KEYGEN: 1 };

  const nodeSetsNonStandardFamily = (n, familySelectors) => {
    // A UA system-control font (concrete, not kStandardFamily).
    if (UA_CONCRETE_FAMILY_TAGS[n.tagName] === 1) return true;
    // Inline style (reflects `font-family:` AND the `font` shorthand).
    if (n.style != null && n.style.fontFamily !== "") return true;
    // `<font face>` presentation attribute (obsolete but present in fixtures).
    if (n.tagName === "FONT" && n.hasAttribute("face")) return true;
    // Any author rule that sets font-family and matches this node.
    for (let i = 0; i < familySelectors.length; i++) {
      let m = false;
      try { m = n.matches(familySelectors[i]); } catch (e) { /* invalid/complex selector */ }
      if (m) return true;
    }
    return false;
  };

  // Whether `el`'s computed `font-family` is the UA-default (kStandardFamily)
  // rather than an author-declared or UA-generic family.
  const familyIsUADefault = (el, computedFontFamily) => {
    if (typeof computedFontFamily !== "string" || computedFontFamily === "") return false;
    const { familySelectors } = selectorsFor(el.ownerDocument || document);
    // (1) concrete-name test on the first family.
    const first = parseCssFontFamilyEntries(computedFontFamily)[0]?.name ?? "";
    if (first === "" || GENERIC_FAMILY_KEYWORDS[first.toLowerCase()] === 1) return false;
    // (2) no author font-family on self or any ancestor (font-family inherits).
    let n = el;
    while (n != null && n.nodeType === 1) {
      if (nodeSetsNonStandardFamily(n, familySelectors)) return false;
      n = n.parentElement;
    }
    return true;
  };

  // `getComputedStyle(host, pseudo)` cannot distinguish inherited kStandard
  // from an authored declaration of the same concrete settings face. Join the
  // pseudo back to matching author rules before inheriting the host sentinel.
  const pseudoFamilyIsAuthored = (el, pseudo) => {
    const pseudoName = String(pseudo || '').replace(/^:+/, '').toLowerCase();
    if (pseudoName === '') return false;
    const { pseudoFamilyRules } = selectorsFor(el.ownerDocument || document);
    for (const rule of pseudoFamilyRules) {
      if (rule.pseudoName !== pseudoName) continue;
      let matches = false;
      try { matches = el.matches(rule.hostSelector); } catch (e) { /* unsupported selector */ }
      if (!matches) continue;
      const value = String(rule.value || '').trim().toLowerCase();
      if (value !== '' && value !== 'inherit' && value !== 'unset'
          && value !== 'initial' && value !== 'revert' && value !== 'revert-layer') return true;
    }
    return false;
  };

  return { familyIsUADefault, pseudoFamilyIsAuthored };
};
