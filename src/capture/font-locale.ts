import { referenceCssString } from "../render/svg-image-reference-syntax.js";

/** Blink WebkitLocale computes explicit values as CSS strings and null as
 * `auto` (longhands_custom.cc, Chromium7d859f27). Decode only the explicit
 * token. Navigator/Intl locale does not identify RenderThread's default. */
export function computedFontLocaleLanguage(fontLocale: string | undefined): string | undefined {
  if (fontLocale == null || fontLocale.length > 4096) return;
  const value = fontLocale.trim();
  const token = referenceCssString(value, 0);
  return token != null && token.end === value.length ? token.value : undefined;
}

/** Preserve DOM language as metadata and as the compatibility route for old
 * captures, auto, and unavailable data. Empty explicit strings are data, not
 * an invitation to borrow a different DOM language. DM-3972FJ owns auto. */
export function fontSelectionLanguage(value: {
  fontLocale?: string;
  lang?: string;
  language?: string;
}): string | undefined {
  return computedFontLocaleLanguage(value.fontLocale) ?? value.lang ?? value.language;
}
