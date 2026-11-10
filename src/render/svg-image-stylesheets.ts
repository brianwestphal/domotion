/** XML-aware stylesheet spans; never search CSS data for an XML closing tag. */
import { expandXmlReferences } from "./svg-image-selector-engine.js";
import { imageXmlTokens } from "./svg-image-xml.js";

export interface ImageStyleSheet {
  start: number;
  end: number;
  open: string;
  css: string;
  close: string;
  name: string;
}
export function imageStyleSheets(markup: string, qualified = false): ImageStyleSheet[] | null {
  const tokens = imageXmlTokens(markup);
  if (tokens == null) return null;
  const sheets: ImageStyleSheet[] = [];
  let opening: (typeof tokens)[number] | undefined;
  for (const token of tokens) {
    if (token.kind !== "open" && token.kind !== "close") continue;
    const style = qualified ? /(?:^|:)style$/i.test(token.name ?? "") : /^style$/i.test(token.name ?? "");
    if (token.kind === "open" && style && !token.selfClosing) {
      if (opening != null) return null;
      opening = token;
    } else if (token.kind === "close" && opening != null && token.name === opening.name) {
      sheets.push({
        start: opening.start,
        end: token.end,
        open: markup.slice(opening.start, opening.end),
        css: markup.slice(opening.end, token.start),
        close: markup.slice(token.start, token.end),
        name: opening.name!,
      });
      opening = undefined;
    }
  }
  return opening == null ? sheets : null;
}
export function replaceImageStyleSheets(markup: string, rewrite: (sheet: ImageStyleSheet) => string): string {
  const sheets = imageStyleSheets(markup);
  if (sheets == null) return markup;
  let result = "",
    at = 0;
  for (const sheet of sheets) {
    result += markup.slice(at, sheet.start) + rewrite(sheet);
    at = sheet.end;
  }
  return result + markup.slice(at);
}
/** Decode DOM text, omitting XML comments and joining CDATA at their real boundaries. */
export function xmlStyleText(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const tokens = imageXmlTokens(text);
  if (tokens == null) return null;
  let result = "";
  for (const token of tokens) {
    if (token.kind === "cdata") result += text.slice(token.start + 9, token.end - 3);
    else if (token.kind === "text") {
      const value = text.slice(token.start, token.end);
      if (/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(value)) return null;
      const decoded = expandXmlReferences(value);
      if (decoded == null) return null;
      result += decoded;
    } else if (token.kind !== "comment") return null;
  }
  return result;
}
/** CDATA is legal in XML and HTML's SVG foreign content; never change CSS values. */
export function serializeImageStyleText(css: string, forceCdata = false): string {
  return forceCdata || /[<&]|\]\]>/.test(css) ? `<![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]>` : css;
}
