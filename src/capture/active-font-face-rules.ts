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
 * - Titled and alternate sheets: `CanBeActivated` also drops a sheet whose
 *   title is not the document's preferred stylesheet set name, and an
 *   alternate sheet with no title. That name is never exposed through CSSOM;
 *   Blink sets it ONCE, to the first of (`StyleEngine::
 *   SetPreferredStylesheetSetNameIfNotSet`, style_engine.cc:2649-2656): a
 *   titled `<style>` outside a shadow tree when its sheet is created
 *   (style_engine.cc:1208-1213); a titled, non-alternate `rel=stylesheet`
 *   `<link>` (html/link_style.cc:278-281, :393-398); a
 *   `<meta http-equiv="default-style">` with non-empty content
 *   (loader/http_equiv.cc:39-40, :103-106 → style_engine.cc:2658-2662). It is
 *   reconstructed here from those owner elements in tree order, which is the
 *   order the parser creates them. Not recoverable from the DOM, and so not
 *   mirrored: a name set by an element since removed or inserted out of tree
 *   order by script, a name surviving `document.open()` (Playwright's
 *   `setContent`) from the replaced document, and a `<link>` enabled via
 *   script (`IsEnabledViaScript`, which exempts it from the title check).
 *   `CSSStyleSheet::IsAlternate` (css_style_sheet.cc:676-682) is a substring
 *   test of the owner's `rel` attribute for "alternate".
 *
 * Media lists evaluate through the frame's `matchMedia` and supports
 * conditions through `CSS.supports`, the same evaluators Blink's CSSOM uses for
 * the document.
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
  // The document's preferred stylesheet set name (see the header); null when
  // no element set it. Only document sheets consult it.
  let preferredSetName: string | null = null;
  if (input == null) {
    for (const el of Array.from(document.querySelectorAll("style[title], link[title], meta[http-equiv]"))) {
      const tag = el.localName;
      if (tag === "style") {
        const title = el.getAttribute("title") ?? "";
        if (title !== "" && (el as HTMLStyleElement).sheet != null) preferredSetName = title;
      } else if (tag === "link") {
        const link = el as HTMLLinkElement;
        const title = link.getAttribute("title") ?? "";
        if (title !== "" && link.relList.contains("stylesheet") && !link.relList.contains("alternate")) {
          preferredSetName = title;
        }
      } else if (tag === "meta") {
        const equiv = (el.getAttribute("http-equiv") ?? "").toLowerCase();
        const content = el.getAttribute("content") ?? "";
        if (equiv === "default-style" && content !== "") preferredSetName = content;
      }
      if (preferredSetName != null) break;
    }
  }
  const canBeActivated = function (sheet: CSSStyleSheet): boolean {
    if (sheet.disabled) return false;
    const owner = sheet.ownerNode;
    if (owner == null || !(owner instanceof Element)) return true;
    const title = sheet.title ?? "";
    if (title !== "" && title !== preferredSetName) return false;
    if (title === "" && (owner.getAttribute("rel") ?? "").includes("alternate")) return false;
    return true;
  };
  const walkSheet = function (sheet: CSSStyleSheet): void {
    if (!canBeActivated(sheet)) return;
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
