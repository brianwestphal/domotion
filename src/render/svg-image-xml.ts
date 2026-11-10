/** Lexical XML boundaries shared by SVG image trees and stylesheet consumers.
 * Unlike HTML raw-text parsing, CDATA owns literal end-tag spellings. Tokens
 * also work on child fragments; element-tree validation remains the caller's job. */
export interface ImageXmlToken {
  kind: "text" | "cdata" | "comment" | "instruction" | "declaration" | "open" | "close";
  start: number;
  end: number;
  name?: string;
  selfClosing?: boolean;
}
export function imageXmlTokens(xml: string): ImageXmlToken[] | null {
  const tokens: ImageXmlToken[] = [];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== "<") {
      const next = xml.indexOf("<", i);
      const end = next < 0 ? xml.length : next;
      tokens.push({ kind: "text", start: i, end });
      i = end;
      continue;
    }
    let kind: ImageXmlToken["kind"];
    let end: number;
    if (xml.startsWith("<!--", i) || xml.startsWith("<![CDATA[", i) || xml.startsWith("<?", i)) {
      kind = xml.startsWith("<!--", i) ? "comment" : xml.startsWith("<?", i) ? "instruction" : "cdata";
      const marker = kind === "comment" ? "-->" : kind === "instruction" ? "?>" : "]]>";
      const from = i + (kind === "comment" ? 4 : kind === "instruction" ? 2 : 9);
      const close = xml.indexOf(marker, from);
      if (close < 0) return null;
      end = close + marker.length;
    } else {
      kind = xml.startsWith("<!", i) ? "declaration" : xml.startsWith("</", i) ? "close" : "open";
      let depth = 0,
        quote = "",
        at = i + 1;
      for (; at < xml.length; at++) {
        const ch = xml[at];
        if (quote !== "") {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (kind === "declaration" && ch === "[") depth++;
        else if (kind === "declaration" && ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      if (at === xml.length) return null;
      end = at + 1;
    }
    if (kind === "open" || kind === "close") {
      const name = kind === "close" ? xml.slice(i + 2, end - 1).trim() : /^<([^\s/>]+)/.exec(xml.slice(i, end))?.[1];
      if (name == null || name === "") return null;
      tokens.push({ kind, start: i, end, name, selfClosing: kind === "open" && xml[end - 2] === "/" });
    } else tokens.push({ kind, start: i, end });
    i = end;
  }
  return tokens;
}
