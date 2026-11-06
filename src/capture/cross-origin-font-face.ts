/**
 * `@font-face` discovery for cross-origin stylesheets.
 *
 * A cross-origin sheet throws on `cssRules` access from the page, so the Node
 * side fetches its text. The text is then parsed by Chromium itself, not by a
 * hand-written scanner: the page receives it in a constructed `CSSStyleSheet`
 * (`replaceSync`) and reads each `CSSFontFaceRule`'s descriptors from CSSOM,
 * exactly as the same-origin walker does.
 *
 * That is what makes the descriptor values Blink's (Chromium 7d859f27):
 *
 * - `CSSParserImpl::ConsumeFontFaceRule` (core/css/parser/css_parser_impl.cc
 *   :1519-1555) builds the rule's value set with `CreateCSSPropertyValueSet`,
 *   whose `FilterProperties` (:263-307) walks the declarations in reverse and
 *   keeps the first it sees per id: the LAST declaration wins.
 * - `AtRuleDescriptorParser::ParseFontFaceDescriptor`
 *   (at_rule_descriptor_parser.cc:346-430) returns nullptr for an invalid
 *   value, so an invalid later declaration never displaces a valid earlier one.
 * - `ConsumeFontFaceSrc` (:254-276) drops each invalid `src` component (an
 *   unsupported `format()`, a malformed `local()`) and keeps the rest.
 *
 * The previous scanner took the FIRST declaration of each descriptor with a
 * regex and split values at any `;` or `}`, including ones inside strings.
 */
import type { Page } from "@playwright/test";
import { parseUnicodeRangeDescriptor } from "./unicode-range.js";

/** One discovered `@font-face` rule with a fetchable `url()` source. */
export type FaceRule = {
  kind: "font-face";
  family: string;
  weight: string;
  style: string;
  styleDesc: string;
  url: string;
  urls?: string[];
  unicodeRange?: Array<[number, number]>;
  stretch?: string;
};

/** The CSSOM serialization of one `@font-face` rule's descriptors ("" = absent or invalid). */
export interface FontFaceDescriptorText {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  unicodeRange: string;
  src: string;
}

/**
 * Parse `cssText` with Chromium's CSS parser in `page` and return the
 * descriptors of every `@font-face` rule, including rules nested in grouping
 * rules (`@media`, `@supports`, `@layer`, …), in document order.
 *
 * Grouping-rule conditions are not evaluated, matching the scanner this
 * replaces. `@import` rules are ignored by `replaceSync`. Returns [] when the
 * page cannot construct the sheet.
 */
export async function readFontFaceDescriptorsFromCssText(
  page: Page,
  cssText: string,
  baseUrl: string,
): Promise<FontFaceDescriptorText[]> {
  try {
    return await page.evaluate(
      ({ text, base }) => {
        let sheet: CSSStyleSheet;
        try {
          sheet = new CSSStyleSheet({ baseURL: base });
        } catch {
          sheet = new CSSStyleSheet();
        }
        sheet.replaceSync(text);
        const found: Array<{
          family: string;
          weight: string;
          style: string;
          stretch: string;
          unicodeRange: string;
          src: string;
        }> = [];
        const walk = (rules: CSSRuleList): void => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSFontFaceRule) {
              const s = rule.style;
              found.push({
                family: s.getPropertyValue("font-family"),
                weight: s.getPropertyValue("font-weight"),
                style: s.getPropertyValue("font-style"),
                // Chrome also serializes the descriptor under the spec's newer
                // `font-width` name.
                stretch: s.getPropertyValue("font-stretch") || s.getPropertyValue("font-width"),
                unicodeRange: s.getPropertyValue("unicode-range"),
                src: s.getPropertyValue("src"),
              });
            } else if (rule instanceof CSSGroupingRule) {
              walk(rule.cssRules);
            }
          }
        };
        walk(sheet.cssRules);
        return found;
      },
      { text: cssText, base: baseUrl },
    );
  } catch {
    return [];
  }
}

/**
 * Same ranking as the page-side walker (woff2 > woff > ttf/otf, skip eot/svg),
 * so the Node-side iterator tries URLs in the same order whichever path found
 * the rule. Chromium's parser already drops unsupported `format()` components;
 * the URL-suffix checks still apply to entries with no `format()`.
 */
function formatRank(fmt: string, url: string): number {
  const lower = fmt.toLowerCase();
  if (/embedded-opentype|svg/.test(lower)) return -1;
  if (lower.includes("woff2") || /\.woff2(\?|$)/i.test(url)) return 4;
  if (lower === "woff" || /\.woff(\?|$)/i.test(url)) return 3;
  if (/truetype|opentype/.test(lower) || /\.(ttf|otf)(\?|$)/i.test(url)) return 2;
  if (/\.eot(\?|$)/i.test(url) || /\.svg(\?|$)/i.test(url)) return -1;
  return 1;
}

/**
 * Turn one rule's CSSOM descriptors into a `FaceRule`, or null when the rule
 * has no family or no fetchable `url()` source. Relative URLs resolve against
 * `baseUrl` (the stylesheet's URL).
 */
export function faceRuleFromFontFaceDescriptors(d: FontFaceDescriptorText, baseUrl: string): FaceRule | null {
  const family = d.family
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (family === "") return null;
  // The raw `font-weight` descriptor; "" = auto/absent (kept distinct from a
  // declared "400": only a declared value pins a variable face's wght axis).
  const weight = d.weight.trim();
  // The raw `font-style` descriptor stays separate from `style`'s "normal"
  // default, for the webfont synthetic-italic rule's slnt-axis exemption.
  const styleDesc = d.style.trim();
  const style = styleDesc || "normal";
  // Absent `font-stretch` = auto: the registry treats the face as normal width
  // and lets a variable face's own wdth range bound instancing.
  const stretch = d.stretch.trim() || undefined;
  const unicodeRange = parseUnicodeRangeDescriptor(d.unicodeRange);
  const srcEntries: { url: string; format: string }[] = [];
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g;
  for (const um of d.src.matchAll(urlRe)) {
    srcEntries.push({ url: um[1], format: (um[2] ?? "").toLowerCase() });
  }
  const absUrls: string[] = [];
  for (const { url } of srcEntries
    .map((e) => ({ url: e.url, rank: formatRank(e.format, e.url) }))
    .filter((e) => e.rank >= 0)
    .sort((a, b) => b.rank - a.rank)) {
    try {
      absUrls.push(new URL(url, baseUrl).href);
    } catch {
      /* skip an unresolvable URL */
    }
  }
  if (absUrls.length === 0) return null;
  return {
    kind: "font-face",
    family,
    weight,
    style,
    styleDesc,
    url: absUrls[0],
    urls: absUrls,
    unicodeRange,
    ...(stretch != null ? { stretch } : {}),
  };
}

/** Chromium-parsed `@font-face` rules of a fetched cross-origin stylesheet. */
export async function parseCrossOriginFontFaceRules(page: Page, cssText: string, baseUrl: string): Promise<FaceRule[]> {
  const out: FaceRule[] = [];
  for (const descriptors of await readFontFaceDescriptorsFromCssText(page, cssText, baseUrl)) {
    const rule = faceRuleFromFontFaceDescriptors(descriptors, baseUrl);
    if (rule != null) out.push(rule);
  }
  return out;
}
