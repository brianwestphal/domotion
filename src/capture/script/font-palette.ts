// @ts-nocheck

/**
 * Capture Blink's author-facing palette ownership record. Computed style keeps
 * only the requested token, so named palettes must be joined back to the
 * matching CSSFontPaletteValuesRule and requested family (Chromium
 * css_font_selector.cc:50-74,166-190; style_rule_font_palette_values.cc:43-140).
 */
export const createFontPaletteResolver = () => {
  const cache = new WeakMap();
  const rulesFor = (doc) => {
    const hit = cache.get(doc);
    if (hit != null) return hit;
    const rows = [];
    for (const sheet of Array.from(doc.styleSheets ?? [])) {
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
  const families = (value) => value.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "").toLowerCase());
  const resolveFontPalette = (el, cs) => {
    const token = cs.fontPalette || "normal";
    const record = { token, ruleFamily: null, basePalette: token, overrides: [] };
    if (!token.startsWith("--")) return record;
    const requested = families(cs.fontFamily || "");
    const rule = rulesFor(el.ownerDocument).find((row) => row.name === token
      && families(row.fontFamily || "").some((family) => requested.includes(family)));
    if (rule == null) return { ...record, basePalette: "normal" };
    const overrides = [];
    const re = /(\d+)\s+([^,]+)(?:,|$)/g;
    let match;
    while ((match = re.exec(rule.overrideColors || "")) != null) overrides.push({ index: Number(match[1]), color: match[2].trim() });
    return { token, ruleFamily: rule.fontFamily, basePalette: rule.basePalette || "normal", overrides };
  };
  return { resolveFontPalette };
};
