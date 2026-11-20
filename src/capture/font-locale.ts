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

/** Is this computed -webkit-locale the `auto` keyword (a null FontDescription
 * locale, so Blink uses `LayoutLocale::GetDefault()`)? */
export function isAutoFontLocale(fontLocale: string | undefined): boolean {
  return fontLocale != null && fontLocale.trim().toLowerCase() === "auto";
}

/** Font-selection language: an explicit computed CSS locale string; for
 * `auto`, Blink's default locale (the renderer's `--lang`) when the capture
 * authenticated it; otherwise DOM language, the compatibility route for old
 * captures and unavailable data. Empty explicit strings are data, not an
 * invitation to borrow a different DOM language. */
export function fontSelectionLanguage(value: {
  fontLocale?: string;
  defaultFontLocale?: string;
  lang?: string;
  language?: string;
}): string | undefined {
  const explicit = computedFontLocaleLanguage(value.fontLocale);
  if (explicit != null) return explicit;
  if (isAutoFontLocale(value.fontLocale) && value.defaultFontLocale != null) return value.defaultFontLocale;
  return value.lang ?? value.language;
}
