// @ts-nocheck
//
// Per-font baseline metric cache. fontkit's `font.ascent` (HHEA) does not
// match where Chrome paints the baseline on macOS for the legacy MS-shipped
// fonts (Helvetica, Arial, Times, Georgia, Menlo, Courier) — Chrome uses
// `OS/2.usWinAscent` there, not HHEA. Reading the answer from
// `canvas.measureText().fontBoundingBoxAscent` dodges the per-font metric-
// selection rules entirely (the browser already applied them). Cached by
// resolved font spec to avoid recreating canvases per element.
//
// DM-418 sub-pixel-ascent attempt (reverted): tried probing
// `canvas.fbAsc` at fontSize=1600 to extract an unrounded ratio, then
// applying `ratio * actualFontSize` for sub-pixel ascent. Theoretically
// closes the integer-rounding ±0.5 px swing, but in practice produces
// mixed results — about half of test fixtures regressed (text-right
// 1494 → 1636, text-mono 1204 → 1330, layout-flex-center 681 → 857)
// because SVG rasterization actually prefers integer baselines for
// crisp glyph hinting. Sub-pixel baselines blur some glyphs more
// than the integer-rounding drift hurts. Stuck with integer fbAsc.
//
// Map of @font-face family-name (lowercased) → the local() candidate
// Chrome ACTUALLY resolved the alias to. Canvas measureText does NOT honor
// @font-face local() src (it falls back to the generic family), so without
// substituting the resolved local() name into the font string, the metrics
// probe sees Courier (the monospace fallback) instead of the painted face
// and reports a different ascent — putting glyphs above/below where Chrome
// painted them and leaving halos in the diff. (DM-445.)
//
// Important: Chrome's local() resolution only matches a font's full name
// or PostScript name, NOT its CSS family name (CSS Fonts 4 §11.2). So
// local("Menlo") does NOT match Menlo (whose PostScript name is
// "Menlo-Regular") — Chrome falls through to the next local() candidate.
// We cannot predict which candidate Chrome picked from name alone, so we
// probe by rendering the alias face and comparing its width to each
// candidate referenced by direct family name (which does match installed
// system fonts). Whichever width matches is the one Chrome resolved.

export const createFontMetrics = () => {
  const metricsCache = new Map();
  const localFaceMap = new Map();

  const probeWidthCS = (familyExpr, weight, style) => {
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;font-size:16px;line-height:1;white-space:pre';
    span.style.fontFamily = familyExpr;
    span.style.fontWeight = weight;
    span.style.fontStyle = style;
    span.textContent = 'mIw0';
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    return w;
  };

  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules;
    try { cssRules = sheet.cssRules; } catch (e) { continue; }
    for (const rule of Array.from(cssRules)) {
      if (rule.constructor.name !== 'CSSFontFaceRule') continue;
      const r = rule;
      const family = r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase();
      const weight = r.style.getPropertyValue('font-weight') || '400';
      const styleDesc = r.style.getPropertyValue('font-style') || 'normal';
      const src = r.style.getPropertyValue('src');
      if (family === '' || /url\(/.test(src)) continue;
      const matches = src.match(/local\(\s*["']?[^"')]+?["']?\s*\)/g);
      if (matches == null) continue;
      const locals = [];
      for (const mm of matches) {
        const inner = /local\(\s*["']?([^"')]+?)["']?\s*\)/.exec(mm);
        if (inner != null) locals.push(inner[1].trim());
      }
      if (locals.length === 0) continue;
      // Probe-by-width to find the local() candidate Chrome actually
      // resolved this alias to. Cache only the first @font-face rule per
      // family (matching how src precedence works inside one rule); the
      // family-key collision case across multiple rules is handled by
      // the caller using getComputedStyle to pick the right rule's face.
      // Strip trailing variant suffix from a candidate name so the direct
      // family-name probe hits the installed family. The alias rule's
      // weight/style descriptors are applied separately, so the probe
      // reaches the same face Chrome's local() lookup did.
      const stripVariant = (n) => n.replace(/\s+(Bold Italic|Italic Bold|Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Black)$/i, '').trim();
      let resolved = null;
      const aliasW = probeWidthCS('"' + family + '"', weight, styleDesc);
      for (const cand of locals) {
        const candW = probeWidthCS('"' + stripVariant(cand) + '"', weight, styleDesc);
        if (Math.abs(candW - aliasW) < 0.05) { resolved = cand; break; }
      }
      // Fall back to the first local() candidate when probing didn't find a
      // match (keeps the previous behavior for cases the simple width
      // sample can't disambiguate).
      if (resolved == null) resolved = locals[0];
      if (!localFaceMap.has(family)) localFaceMap.set(family, resolved);
    }
  }

  const substituteAliasedFamilies = (ff) => {
    if (localFaceMap.size === 0) return ff;
    const parts = ff.split(',').map((s) => s.trim());
    let changed = false;
    const out = parts.map((p) => {
      const bare = p.replace(/^["']|["']$/g, '').toLowerCase();
      const local = localFaceMap.get(bare);
      if (local == null) return p;
      changed = true;
      return /\s/.test(local) ? '"' + local + '"' : local;
    });
    return changed ? out.join(', ') : ff;
  };

  const measureFontMetrics = (cs) => {
    const fs = cs.fontStyle || 'normal';
    const fw = cs.fontWeight || '400';
    const fz = cs.fontSize || '14px';
    const ff = substituteAliasedFamilies(cs.fontFamily || 'sans-serif');
    const key = fs + '|' + fw + '|' + fz + '|' + ff;
    let v = metricsCache.get(key);
    if (v != null) return v;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = fs + ' ' + fw + ' ' + fz + ' ' + ff;
    const m = ctx.measureText('Mxgp');
    v = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    metricsCache.set(key, v);
    return v;
  };

  return { measureFontMetrics, substituteAliasedFamilies };
};
