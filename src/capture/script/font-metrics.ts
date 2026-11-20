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

import {
  captureFontFamilyStack,
  parseCssFontFamilyName,
  serializeCapturedFontFamilyStack,
} from "../../font-family-stack.js";

export const createFontMetrics = () => {
  const metricsCache = new Map<string, { ascent: number; descent: number }>();
  const localFaceMap = new Map<string, string>();

  const probeWidthCS = (familyExpr: string, weight: string, style: string): number => {
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;visibility:hidden;font-size:16px;line-height:1;white-space:pre";
    span.style.fontFamily = familyExpr;
    span.style.fontWeight = weight;
    span.style.fontStyle = style;
    span.textContent = "mIw0";
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    return w;
  };

  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules;
    try {
      cssRules = sheet.cssRules;
    } catch (e) {
      continue;
    }
    for (const rule of Array.from(cssRules)) {
      if (rule.constructor.name !== "CSSFontFaceRule") continue;
      const r = rule as CSSFontFaceRule;
      const family = parseCssFontFamilyName(r.style.getPropertyValue("font-family"))?.toLowerCase();
      const weight = r.style.getPropertyValue("font-weight") || "400";
      const styleDesc = r.style.getPropertyValue("font-style") || "normal";
      const src = r.style.getPropertyValue("src");
      if (family == null || /url\(/.test(src)) continue;
      const matches = src.match(/local\(\s*["']?[^"')]+?["']?\s*\)/g);
      if (matches == null) continue;
      const locals: string[] = [];
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
      const stripVariant = (n: string) =>
        n.replace(/\s+(Bold Italic|Italic Bold|Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Black)$/i, "").trim();
      let resolved: string | null = null;
      const aliasW = probeWidthCS(
        serializeCapturedFontFamilyStack({
          source: "blink-font-family-stack-v1",
          entries: [{ name: family, type: "family-name" }],
          genericFamily: "none",
        }),
        weight,
        styleDesc,
      );
      for (const cand of locals) {
        const candW = probeWidthCS('"' + stripVariant(cand) + '"', weight, styleDesc);
        if (Math.abs(candW - aliasW) < 0.05) {
          resolved = cand;
          break;
        }
      }
      // Fall back to the first local() candidate when probing didn't find a
      // match (keeps the previous behavior for cases the simple width
      // sample can't disambiguate).
      if (resolved == null) resolved = locals[0];
      if (!localFaceMap.has(family)) localFaceMap.set(family, resolved);
    }
  }

  const substituteAliasedFamilies = (ff: string): string => {
    if (localFaceMap.size === 0) return ff;
    const stack = captureFontFamilyStack(ff);
    let changed = false;
    const entries = stack.entries.map((entry) => {
      const local = localFaceMap.get(entry.name.toLowerCase());
      if (local == null) return entry;
      changed = true;
      return { name: local, type: "family-name" as const };
    });
    return changed ? serializeCapturedFontFamilyStack({ ...stack, entries }) : ff;
  };

  // A canvas probe cannot ask every question an element's own font
  // description asks. Blink resolves the primary font of a generic family
  // through `FamilyNameFromSettings` (`platform/fonts/font_selector.cc:20-80`,
  // Chromium 7d859f27): a kStandardFamily description reads
  // `settings.Standard(script)` and a generic keyword reads e.g.
  // `settings.Serif(script)`, with the script taken from the description's
  // locale. A detached canvas has no element locale, and the standard family
  // computes to a concrete settings name ("Times" on macOS) that the canvas
  // treats as a literal family. So `lang=ja` text with no declared family is
  // laid out with Hiragino Kaku Gothic ProN (ascent 28, descent 4 at 32px)
  // while the canvas measured Times (29 / 8, with Blink's macOS Times ascent
  // adjustment), which put the captured baseline one pixel low.
  //
  // For those descriptions the metrics are read from a hidden DOM probe that
  // carries the element's own family type and locale: `font-family: initial`
  // IS the kStandardFamily description, and `-webkit-locale` is copied from
  // the element's computed value (an explicit inline value overrides the
  // `lang` presentation attribute). The probe's inline box is the primary
  // font's ascent + descent; a zero-size inline-block sitting on the baseline
  // splits it.
  const standardFamilyStyles = new WeakSet<object>();
  const markStandardFamilyStyle = (cs: object): void => {
    standardFamilyStyles.add(cs);
  };
  const localeProbeFor = (cs: object, ff: string): { family: string; locale: string } | null => {
    const getter = (cs as { getPropertyValue?: (property: string) => string }).getPropertyValue;
    if (typeof getter !== "function") return null;
    const locale = String(getter.call(cs, "-webkit-locale") || "").trim();
    if (standardFamilyStyles.has(cs)) return { family: "initial", locale: locale || "auto" };
    // A generic keyword with the default (auto) locale is the same question
    // the canvas asks: both resolve against the default locale.
    if (locale === "" || locale.toLowerCase() === "auto") return null;
    return captureFontFamilyStack(ff).entries.some((entry) => entry.type === "generic-family")
      ? { family: ff, locale }
      : null;
  };
  const probeHost = (fs: string, fw: string, fz: string, probe: { family: string; locale: string }) => {
    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;visibility:hidden;margin:0;padding:0;border:0;white-space:pre;width:100px";
    // The shorthand resets stretch/variant/size-adjust the way a canvas
    // `font` string does; the family and locale are then the element's own.
    host.style.font = fs + " " + fw + " " + fz + " serif";
    host.style.fontFamily = probe.family;
    host.style.lineHeight = "normal";
    host.style.setProperty("-webkit-locale", probe.locale);
    return host;
  };
  const measureDomFontMetrics = (
    fs: string,
    fw: string,
    fz: string,
    probe: { family: string; locale: string },
  ): { ascent: number; descent: number } | null => {
    if (document.body == null) return null;
    const host = probeHost(fs, fw, fz, probe);
    const text = document.createElement("span");
    text.textContent = "Mxgp";
    const baseline = document.createElement("span");
    baseline.style.cssText =
      "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
    host.appendChild(text);
    host.appendChild(baseline);
    document.body.appendChild(host);
    const hostRect = host.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    const baselineRect = baseline.getBoundingClientRect();
    document.body.removeChild(host);
    // An inherited CSS zoom scales the probe; the canvas measures unzoomed
    // px, so keep the canvas answer rather than a scaled one.
    if (hostRect.width !== 100 || textRect.height <= 0) return null;
    return { ascent: baselineRect.top - textRect.top, descent: textRect.bottom - baselineRect.top };
  };

  const measureFontMetrics = (
    cs: Pick<CSSStyleDeclaration, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">,
    fontSizeOverride?: string,
  ): { ascent: number; descent: number } => {
    const fs = cs.fontStyle || "normal";
    const fw = cs.fontWeight || "400";
    const fz = fontSizeOverride || cs.fontSize || "14px";
    const ff = substituteAliasedFamilies(cs.fontFamily || "sans-serif");
    const probe = localeProbeFor(cs, ff);
    const key = fs + "|" + fw + "|" + fz + "|" + ff + (probe == null ? "" : "|" + probe.family + "|" + probe.locale);
    let v = metricsCache.get(key);
    if (v != null) return v;
    const domMetrics = probe == null ? null : measureDomFontMetrics(fs, fw, fz, probe);
    if (domMetrics != null) {
      metricsCache.set(key, domMetrics);
      return domMetrics;
    }
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    if (ctx == null) throw new Error("Canvas 2D context unavailable");
    ctx.font = fs + " " + fw + " " + fz + " " + ff;
    const m = ctx.measureText("Mxgp");
    v = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    metricsCache.set(key, v);
    return v;
  };

  // Blink's `line-height: normal` for a font: the primary face's FontMetrics::LineSpacing() =
  // lroundf(ascent) + lroundf(descent) + lroundf(line gap) (platform/fonts/simple_font_data.cc:176). The line
  // gap is the platform's own leading (CoreText, FreeType, DirectWrite) and fontkit's hhea value does not
  // reproduce it for the legacy Apple faces (Helvetica, Times, Courier read 0 there and 0.15 em in
  // Chromium), so ask the browser: a hidden line-height:normal block's used height IS that value. Cached by
  // font, like the ascent/descent above.
  const spacingCache = new Map<string, number>();
  const measureNormalLineSpacing = (
    cs: Pick<CSSStyleDeclaration, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">,
    fontSizeOverride?: string,
  ): number => {
    const fs = cs.fontStyle || "normal";
    const fw = cs.fontWeight || "400";
    const fz = fontSizeOverride || cs.fontSize || "14px";
    const ff = substituteAliasedFamilies(cs.fontFamily || "sans-serif");
    const localeProbe = localeProbeFor(cs, ff);
    const key =
      fs +
      "|" +
      fw +
      "|" +
      fz +
      "|" +
      ff +
      (localeProbe == null ? "" : "|" + localeProbe.family + "|" + localeProbe.locale);
    let v = spacingCache.get(key);
    if (v != null) return v;
    let probe: HTMLDivElement;
    if (localeProbe != null) {
      probe = probeHost(fs, fw, fz, localeProbe);
      probe.style.width = "";
    } else {
      probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;visibility:hidden;margin:0;padding:0;border:0;white-space:pre;line-height:normal";
      probe.style.font = fs + " " + fw + " " + fz + " " + ff;
      probe.style.lineHeight = "normal";
    }
    probe.textContent = "Mxgp";
    document.body.appendChild(probe);
    v = probe.getBoundingClientRect().height;
    document.body.removeChild(probe);
    spacingCache.set(key, v);
    return v;
  };

  return { measureFontMetrics, measureNormalLineSpacing, substituteAliasedFamilies, markStandardFamilyStyle };
};
