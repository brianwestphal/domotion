/**
 * The ONE page-side walker that decides which `@font-face` rules webfont
 * discovery sees — for the document's own sheets and for the text of a fetched
 * cross-origin sheet alike — following Blink's decision of which rules join
 * the document's font-face set (Chromium 7d859f27):
 *
 * - `RuleSet::AddChildRules` (core/css/rule_set.cc:973-1080) adds an
 *   `@font-face` at any depth (`AddFontFaceRule`, :1005-1006) reached through:
 *   `@media` only when its query matches (`MatchMediaForAddRules`, :999-1004 and
 *   :1282-1292); `@supports` only when `ConditionIsSupported()` (:1030-1035);
 *   `@container`, `@layer` blocks, `@scope` and `@starting-style`
 *   unconditionally (:1036-1070). Any other rule contributes nothing.
 * - `RuleSet::AddRulesFromSheet` (:1294-1330) follows an `@import` only when it
 *   `IsSupported()` (its `supports()` condition) and its media list matches.
 * - Whole sheets: `StyleEngine::RuleSetForSheet` (style_engine.cc:1016-1022)
 *   drops a sheet whose own media list does not match, and
 *   `CSSStyleSheet::CanBeActivated` (css_style_sheet.cc:686-711) drops a
 *   disabled one. Adopted sheets are active alongside the owner-node sheets
 *   (style_sheet_collection.cc:184-191). `ScopedStyleResolver::AddFontFaceRules`
 *   (resolver/scoped_style_resolver.cc:83-106) feeds the `FontFaceCache` from
 *   document-scope sheets only, so shadow-tree sheets are not walked.
 *
 * Media lists evaluate through the frame's `matchMedia` and supports
 * conditions through `CSS.supports`, the same evaluators Blink's CSSOM uses for
 * the document. Not mirrored: `CanBeActivated`'s preferred-stylesheet-set
 * check for titled / alternate sheets, which CSSOM does not expose.
 *
 * `scanActiveFontFaceRules` is serialized into the page by `evaluateInFrame`,
 * so it must stay self-contained: no imports, no module-scope references.
 */

/** The CSSOM serialization of one `@font-face` rule's descriptors ("" = absent or invalid). */
export interface FontFaceDescriptorText {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  unicodeRange: string;
  src: string;
}

/** One active `@font-face` rule plus the URL its relative `src` resolves against. */
export interface ActiveFontFaceRule extends FontFaceDescriptorText {
  baseUrl: string;
}

export interface ActiveFontFaceRuleScan {
  rules: ActiveFontFaceRule[];
  /** Active sheets whose `cssRules` threw (cross-origin): fetch and rescan their text. */
  crossOriginSheetUrls: string[];
}

/** `null` scans the document; otherwise the given CSS texts, each parsed by Chromium into a constructed sheet. */
export type ActiveFontFaceRuleScanInput = { cssTexts: Array<{ text: string; base: string }> } | null;

export function scanActiveFontFaceRules(input: ActiveFontFaceRuleScanInput): ActiveFontFaceRuleScan {
  const rules: ActiveFontFaceRule[] = [];
  const crossOriginSheetUrls: string[] = [];
  const mediaMatches = function (mediaText: string): boolean {
    return mediaText.trim() === "" || window.matchMedia(mediaText).matches;
  };
  const walkRules = function (list: CSSRuleList, base: string): void {
    for (const rule of Array.from(list)) {
      const kind = rule.constructor.name;
      if (kind === "CSSFontFaceRule") {
        const s = (rule as CSSFontFaceRule).style;
        rules.push({
          family: s.getPropertyValue("font-family"),
          weight: s.getPropertyValue("font-weight"),
          style: s.getPropertyValue("font-style"),
          // Chrome also serializes the descriptor under the spec's newer
          // `font-width` name.
          stretch: s.getPropertyValue("font-stretch") || s.getPropertyValue("font-width"),
          unicodeRange: s.getPropertyValue("unicode-range"),
          src: s.getPropertyValue("src"),
          baseUrl: base,
        });
      } else if (kind === "CSSImportRule") {
        const imp = rule as CSSImportRule & { supportsText?: string | null };
        if (imp.supportsText != null && !CSS.supports(imp.supportsText)) continue;
        if (!mediaMatches(imp.media.mediaText)) continue;
        if (imp.styleSheet != null) walkSheet(imp.styleSheet);
      } else if (kind === "CSSMediaRule") {
        const media = rule as CSSMediaRule;
        if (mediaMatches(media.media.mediaText)) walkRules(media.cssRules, base);
      } else if (kind === "CSSSupportsRule") {
        const supports = rule as CSSSupportsRule;
        if (CSS.supports(supports.conditionText)) walkRules(supports.cssRules, base);
      } else if (
        kind === "CSSContainerRule" ||
        kind === "CSSLayerBlockRule" ||
        kind === "CSSScopeRule" ||
        kind === "CSSStartingStyleRule"
      ) {
        walkRules((rule as CSSGroupingRule).cssRules, base);
      }
    }
  };
  const walkSheet = function (sheet: CSSStyleSheet): void {
    if (sheet.disabled) return;
    if (!mediaMatches(sheet.media.mediaText)) return;
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      if (sheet.href != null && sheet.href !== "") crossOriginSheetUrls.push(sheet.href);
      return;
    }
    walkRules(list, sheet.href ?? document.baseURI);
  };
  if (input == null) {
    for (const sheet of Array.from(document.styleSheets)) walkSheet(sheet);
    for (const sheet of document.adoptedStyleSheets) walkSheet(sheet);
  } else {
    for (const { text, base } of input.cssTexts) {
      let sheet: CSSStyleSheet;
      try {
        sheet = new CSSStyleSheet({ baseURL: base });
      } catch {
        sheet = new CSSStyleSheet();
      }
      try {
        // `replaceSync` drops `@import` rules (constructed sheets cannot import).
        sheet.replaceSync(text);
      } catch {
        continue;
      }
      walkRules(sheet.cssRules, base);
    }
  }
  return { rules, crossOriginSheetUrls };
}
