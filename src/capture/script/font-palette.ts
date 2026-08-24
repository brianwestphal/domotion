// @ts-nocheck

import { parseCssFontFamilyEntries } from "../../font-family-stack.js";

/**
 * Capture Blink's author-facing palette ownership record. Computed style keeps
 * the serialized requested/interpolated value, so named palettes must be
 * joined back to the matching document-scoped CSSFontPaletteValuesRule and
 * requested family. Palette mixes are recursive paint identities: Blink keeps
 * both endpoints, the non-normalized weights, normalized progress, alpha
 * multiplier, interpolation space, and hue method in FontPalette equality and
 * hashing (Chromium 7d859f27 font_palette.cc:14-43,90-107).
 *
 * Blink deliberately does not register @font-palette-values from shadow
 * trees yet (style_engine.cc:3159-3167). Accordingly this resolver reads the
 * document sheets (including document.adoptedStyleSheets), never a shadow
 * root's sheets. The selected document rule is the last matching rule, exactly
 * like StyleEngine's map Set() in style_engine.cc:3577-3586.
 */
export const createFontPaletteResolver = () => {
  const cache = new WeakMap();
  const rulesFor = (doc) => {
    const hit = cache.get(doc);
    if (hit != null) return hit;
    const rows = [];
    const sheets = [...Array.from(doc.styleSheets ?? [])];
    for (const sheet of Array.from(doc.adoptedStyleSheets ?? [])) {
      if (!sheets.includes(sheet)) sheets.push(sheet);
    }
    for (const sheet of sheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules ?? [])) {
        if (rule.constructor?.name !== "CSSFontPaletteValuesRule") continue;
        rows.push({
          name: rule.name,
          fontFamily: rule.fontFamily,
          basePalette: rule.basePalette,
          overrideColors: rule.overrideColors,
        });
      }
    }
    cache.set(doc, rows);
    return rows;
  };
  const families = (value) => parseCssFontFamilyEntries(value)
    .map((entry) => entry.name.toLowerCase());

  const resolveLeaf = (doc, requestedFamilies, token) => {
    const kind = token === "normal" || token === "light" || token === "dark"
      ? token
      : token.startsWith("--") ? "custom" : "unresolved";
    const record = {
      token,
      kind,
      ruleScope: null,
      ruleFamily: null,
      basePalette: kind === "unresolved" ? "normal" : token,
      overrides: [],
    };
    if (kind !== "custom") return record;
    const rows = rulesFor(doc);
    let rule = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.name === token
        && families(row.fontFamily || "").some((family) => requestedFamilies.includes(family))) {
        rule = row;
        break;
      }
    }
    if (rule == null) return { ...record, basePalette: "normal" };
    const overrides = [];
    const re = /(\d+)\s+([^,]+)(?:,|$)/g;
    let match;
    while ((match = re.exec(rule.overrideColors || "")) != null) overrides.push({ index: Number(match[1]), color: match[2].trim() });
    return { ...record, ruleScope: "document", ruleFamily: rule.fontFamily, basePalette: rule.basePalette || "normal", overrides };
  };

  const splitTopLevel = (value) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (char === "," && depth === 0) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts;
  };

  const endpoint = (value) => {
    const match = /^(.*\S)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/.exec(value.trim());
    return match == null
      ? { token: value.trim(), percentage: null }
      : { token: match[1].trim(), percentage: Number(match[2]) };
  };

  const animatedPaletteMix = (el, token) => {
    if (!token.startsWith("palette-mix(")) return false;
    try {
      const animations = Array.from(el.getAnimations?.() ?? []);
      for (let index = animations.length - 1; index >= 0; index -= 1) {
        const effect = animations[index].effect;
        if (effect?.target != null && effect.target !== el) continue;
        if (effect?.getComputedTiming?.().progress == null) continue;
        if (Array.from(effect.getKeyframes?.() ?? []).some((frame) => Object.prototype.hasOwnProperty.call(frame, "fontPalette"))) {
          return true;
        }
      }
    } catch {}
    return false;
  };

  const resolveToken = (doc, requestedFamilies, token, animationRoot = false) => {
    const text = (token || "normal").trim();
    if (!text.startsWith("palette-mix(") || !text.endsWith(")")) {
      return resolveLeaf(doc, requestedFamilies, text);
    }
    const parts = splitTopLevel(text.slice("palette-mix(".length, -1));
    if (parts.length !== 3 || !parts[0].startsWith("in ")) {
      return resolveLeaf(doc, requestedFamilies, text);
    }
    const interpolation = parts[0].slice(3).trim().split(/\s+/);
    const colorSpace = interpolation[0] || "oklab";
    const hueInterpolationMethod = animationRoot ? null : interpolation.length >= 3 && interpolation.at(-1) === "hue"
      ? interpolation.at(-2)
      : "shorter";
    const start = endpoint(parts[1]);
    const end = endpoint(parts[2]);
    // FontPalette stores the raw (possibly calc-produced out-of-range)
    // endpoint percentages for equality/hash, while NormalizePercentages uses
    // separately clamped values for paint progress and alpha.
    let startPercentage = start.percentage == null ? 50 : start.percentage;
    let endPercentage = end.percentage == null ? 50 : end.percentage;
    if (start.percentage != null && end.percentage == null) endPercentage = 100 - startPercentage;
    else if (end.percentage != null && start.percentage == null) startPercentage = 100 - endPercentage;
    let normalizedStart = start.percentage == null ? 50 : Math.min(100, Math.max(0, start.percentage));
    let normalizedEnd = end.percentage == null ? 50 : Math.min(100, Math.max(0, end.percentage));
    if (start.percentage != null && end.percentage == null) normalizedEnd = 100 - normalizedStart;
    else if (end.percentage != null && start.percentage == null) normalizedStart = 100 - normalizedEnd;
    const normalizedScale = normalizedStart + normalizedEnd;
    const normalizedPercentage = normalizedStart === 0 ? 1 : normalizedScale === 0 ? 0 : normalizedEnd / normalizedScale;
    const alphaMultiplier = normalizedScale <= 100 ? normalizedScale / 100 : 1;
    return {
      token: text,
      kind: "mix",
      ruleScope: null,
      ruleFamily: null,
      basePalette: "normal",
      overrides: [],
      mix: {
        colorSpace,
        hueInterpolationMethod,
        startPercentage,
        endPercentage,
        normalizedPercentage,
        alphaMultiplier,
        start: resolveToken(doc, requestedFamilies, start.token),
        end: resolveToken(doc, requestedFamilies, end.token),
      },
    };
  };

  const resolveFontPalette = (el, cs) => {
    const token = cs.fontPalette || "normal";
    const requested = families(cs.fontFamily || "");
    return resolveToken(el.ownerDocument, requested, token, animatedPaletteMix(el, token));
  };

  const resolveShadowFontPalettes = (host) => {
    if (host.shadowRoot == null) return undefined;
    const rows = [];
    const visit = (container, prefix) => {
      const children = Array.from(container.children ?? []);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const path = prefix === "" ? String(index) : `${prefix}.${index}`;
        const view = child.ownerDocument?.defaultView ?? window;
        const cs = view.getComputedStyle(child);
        const token = cs.fontPalette || "normal";
        if (token !== "normal") {
          rows.push({
            path,
            text: child.textContent || "",
            fontFamily: cs.fontFamily || "",
            palette: resolveToken(child.ownerDocument, families(cs.fontFamily || ""), token, animatedPaletteMix(child, token)),
          });
        }
        if (child.shadowRoot != null) visit(child.shadowRoot, `${path}.s`);
        visit(child, path);
      }
    };
    visit(host.shadowRoot, "s");
    return rows.length === 0 ? undefined : rows;
  };
  return { resolveFontPalette, resolveShadowFontPalettes };
};
