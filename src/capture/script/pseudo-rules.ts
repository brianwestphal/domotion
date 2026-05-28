// @ts-nocheck
//
// WebKit form-control shadow-pseudo rule capture (`::-webkit-slider-thumb`,
// `::-webkit-slider-runnable-track`, `::-webkit-progress-bar`,
// `::-webkit-progress-value`, `::-webkit-meter-*`, `::-webkit-color-swatch`,
// `::-webkit-inner-spin-button`, `::-webkit-search-cancel-button`).
//
// Original problem: `getComputedStyle(el, '::-webkit-slider-thumb')` in
// Chromium returns the HOST element's computed style for these UA-internal
// pseudos rather than the pseudo's cascaded value — so `width: 22px` on the
// thumb rule came back as the host's `width: 100%` and the renderer drew a
// giant pill instead of a small thumb. SK-1193 / SK-1131 / SK-1138 / SK-1222
// confirmed the same quirk affects every WebKit-internal input, progress,
// and meter pseudo. Reading rules directly via `document.styleSheets` avoids
// the quirk uniformly.
//
// var() / calc() expressions are resolved at apply-time by probing the host
// element's inline style (SK-1191) — the host has the same custom properties
// in scope as the pseudo. State pseudos
// (:hover/:active/:focus/:focus-visible/:focus-within/:disabled) ARE
// supported (SK-1192) — rules with these in the host selector are collected
// like any other and `el.matches(hostSel)` decides at apply-time whether each
// rule applies given the element's current DOM state.
// Gradient backgrounds (linear + radial) round-trip via the renderer's
// gradient-def pipeline (SK-1224 / SK-1225 / SK-1226).

import { isUnsetCssValue, firstColorRe } from "./utils.js";

const _pseudoKindRe = /^(.*?)::?(-webkit-slider-runnable-track|-webkit-slider-thumb|-webkit-progress-bar|-webkit-progress-value|-webkit-meter-bar|-webkit-meter-optimum-value|-webkit-meter-suboptimum-value|-webkit-meter-even-less-good-value|-webkit-color-swatch|-webkit-color-swatch-wrapper|-webkit-inner-spin-button|-webkit-search-cancel-button)$/;

// Pseudo "kind" names are short stable identifiers used by the renderer
// to look up captured fields. The regex above maps each WebKit selector
// to its kind.
const _kindMap = {
  '-webkit-slider-runnable-track': 'track',
  '-webkit-slider-thumb': 'thumb',
  '-webkit-progress-bar': 'progress-bar',
  '-webkit-progress-value': 'progress-value',
  '-webkit-meter-bar': 'meter-bar',
  '-webkit-meter-optimum-value': 'meter-optimum',
  '-webkit-meter-suboptimum-value': 'meter-suboptimum',
  '-webkit-meter-even-less-good-value': 'meter-even-less-good',
  '-webkit-color-swatch': 'color-swatch',
  '-webkit-color-swatch-wrapper': 'color-swatch-wrapper',
  '-webkit-inner-spin-button': 'inner-spin-button',
  '-webkit-search-cancel-button': 'search-cancel-button',
};

// Detect whether a value is a CSS gradient function (linear/radial/conic
// and their repeating variants). Used to capture rangeTrackBgImage etc.
// SK-1224 ships linear-gradient first; SK-1225 adds radial.
const _gradientRe = /^\s*(repeating-)?(linear|radial|conic)-gradient\s*\(/i;

const _needsResolve = (v) => v != null && v !== '' && (v.indexOf('var(') >= 0 || v.indexOf('calc(') >= 0);

const _propMap = {
  backgroundColor: 'background-color',
  backgroundImage: 'background-image',
  borderRadius: 'border-radius',
  width: 'width',
  height: 'height',
};

// Extract gradient function calls from a CSS background-shorthand string,
// dropping any non-gradient layers (background-color, plain url(), etc.).
// Walks balanced parens to keep the gradient inner commas intact. Returns
// a comma-separated list of gradient calls suitable for assigning to
// background-image. DM-275.
const _extractGradients = (text) => {
  const re = /(repeating-)?(linear|radial|conic)-gradient\s*\(/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) != null) {
    const start = m.index;
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    out.push(text.slice(start, i));
    re.lastIndex = i;
  }
  return out.join(', ');
};

export const createPseudoRules = () => {
  const rules = [];

  const collect = (cssRules) => {
    if (cssRules == null) return;
    for (let i = 0; i < cssRules.length; i++) {
      const rule = cssRules[i];
      if (rule == null) continue;
      const selectorText = rule.selectorText;
      if (typeof selectorText === 'string') {
        const selectors = selectorText.split(',').map(function (s) { return s.trim(); });
        for (let j = 0; j < selectors.length; j++) {
          const sel = selectors[j];
          const m = sel.match(_pseudoKindRe);
          if (m == null) continue;
          const kind = _kindMap[m[2]];
          if (kind == null) continue;
          const hostSel = m[1].trim();
          rules.push({ kind: kind, hostSel: hostSel, decl: rule.style });
        }
      }
      if (rule.cssRules != null && rule.cssRules.length > 0) collect(rule.cssRules);
    }
  };
  for (let i = 0; i < document.styleSheets.length; i++) {
    try { collect(document.styleSheets[i].cssRules); } catch (e) { /* CORS — skip */ }
  }

  // Resolve var() and calc() in a declared rule value by temporarily applying
  // it to the host's inline style and reading the computed value back
  // (SK-1191). The host has the same CSS variables in scope as the pseudo
  // (custom props inherit through the shadow boundary), so values like
  // var(--thumb-size) or calc(var(--track-h) * 2) resolve correctly.
  // Limitations: percentage values resolve against the host's containing
  // block, not the pseudo's, and width/height: 100% on a thumb especially can
  // come out wrong — but the common authoring patterns (var-driven tokens,
  // calc with px units) round-trip faithfully.
  const _resolveOne = (host, propKey, value) => {
    if (!_needsResolve(value)) return value;
    const cssProp = _propMap[propKey] || propKey;
    const saved = host.style.getPropertyValue(cssProp);
    const savedPriority = host.style.getPropertyPriority(cssProp);
    host.style.setProperty(cssProp, value);
    const resolved = window.getComputedStyle(host).getPropertyValue(cssProp);
    if (saved === '') host.style.removeProperty(cssProp);
    else host.style.setProperty(cssProp, saved, savedPriority);
    return resolved !== '' ? resolved : value;
  };

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

  // Resolve a pseudo's cascaded declarations for an element by applying
  // matching rules in source order (later rules win per property). Specificity
  // is approximated as source order — adequate for a single author stylesheet.
  const resolvePseudo = (el, kind) => {
    let width = '', height = '', backgroundColor = '', borderRadius = '', backgroundImage = '';
    let border = '', padding = '', boxShadow = '';
    let matched = false;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.kind !== kind) continue;
      let isMatch = false;
      try { isMatch = el.matches(r.hostSel); } catch (e) { /* invalid selector */ }
      if (!isMatch) continue;
      matched = true;
      const d = r.decl;
      if (!isUnsetCssValue(d.width)) width = d.width;
      if (!isUnsetCssValue(d.height)) height = d.height;
      if (!isUnsetCssValue(d.borderRadius)) borderRadius = d.borderRadius;
      if (!isUnsetCssValue(d.border)) border = d.border;
      if (!isUnsetCssValue(d.padding)) padding = d.padding;
      if (!isUnsetCssValue(d.boxShadow)) boxShadow = d.boxShadow;
      // background-color longhand expands to 'initial' when the rule only
      // declared the 'background' shorthand with a non-color value (e.g. a
      // gradient). In that case fall through to extracting the first color
      // stop from the shorthand string.
      if (!isUnsetCssValue(d.backgroundColor)) {
        backgroundColor = d.backgroundColor;
      } else if (!isUnsetCssValue(d.background)) {
        const cm = d.background.match(firstColorRe);
        if (cm != null) backgroundColor = cm[1];
        // Shorthand of the form 'background: var(--accent)' that references a
        // solid color via a custom property: the regex won't match var(), but
        // probing the host's background-color longhand resolves it.
        else if (_needsResolve(d.background)) backgroundColor = d.background;
      }
      // Gradient capture (SK-1224). Two sources: the background-image
      // longhand, or a gradient function within the background shorthand.
      // The shorthand commonly carries gradients in author CSS
      // ('background: linear-gradient(...)'). Prefer longhand when set.
      // When falling back to the shorthand, isolate the gradient call(s):
      // a 'background:' value can carry a comma-separated layer list like
      // '<gradient>, #cbd5e1' where the trailing color is the bg-color, not
      // an additional image. Passing the whole shorthand to _resolveOne
      // for background-image would fail validation and silently fall back
      // to 'none'. DM-275.
      if (!isUnsetCssValue(d.backgroundImage) && _gradientRe.test(d.backgroundImage)) {
        backgroundImage = _extractGradients(d.backgroundImage);
      } else if (!isUnsetCssValue(d.background) && _gradientRe.test(d.background)) {
        backgroundImage = _extractGradients(d.background);
      }
    }
    return {
      matched: matched,
      width: _resolveOne(el, 'width', width),
      height: _resolveOne(el, 'height', height),
      backgroundColor: _resolveOne(el, 'backgroundColor', backgroundColor),
      borderRadius: _resolveOne(el, 'borderRadius', borderRadius),
      // Resolve var()/calc() inside gradient text via the same host-probe
      // (Chromium rewrites the gradient to fully-resolved rgb()/deg form).
      backgroundImage: _resolveOne(el, 'backgroundImage', backgroundImage),
      border: border,
      padding: padding,
      boxShadow: boxShadow,
    };
  };

  return { resolvePseudo, resolveCornerRadius };
};
