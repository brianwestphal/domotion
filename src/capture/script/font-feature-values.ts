// @ts-nocheck

/** Collect Blink's CSSOM view of author @font-feature-values rules. */
export function collectFontFeatureValues(doc) {
  const families = {};
  const categories = ["annotation", "ornaments", "stylistic", "swash", "characterVariant", "styleset"];
  function familyNames(css) {
    const out = [];
    let token = "", quote = "";
    for (const ch of css) {
      if (quote) { if (ch === quote) quote = ""; else token += ch; continue; }
      if (ch === "\"" || ch === "'") { quote = ch; continue; }
      if (ch === ",") { if (token.trim()) out.push(token.trim().toLowerCase()); token = ""; }
      else token += ch;
    }
    if (token.trim()) out.push(token.trim().toLowerCase());
    return out;
  }
  function visit(rules) {
    if (!rules) return;
    for (const rule of rules) {
      if (typeof rule.fontFamily === "string" && rule.stylistic != null) {
        for (const family of familyNames(rule.fontFamily)) {
          const table = families[family] || (families[family] = {});
          for (const category of categories) {
            const entries = Array.from(rule[category].entries());
            if (!entries.length) continue;
            const aliases = table[category] || (table[category] = {});
            for (const [name, values] of entries) aliases[name] = Array.from(values);
          }
        }
      } else if (rule.cssRules) {
        visit(rule.cssRules);
      }
    }
  }
  for (const sheet of doc.styleSheets) {
    try { visit(sheet.cssRules); } catch { /* cross-origin sheet */ }
  }
  return families;
}
