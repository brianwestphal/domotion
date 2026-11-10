/** Image-owned font evidence. Bytes never enter the embedding page's font set. */
import { createHash } from "node:crypto";
import postcss from "postcss";
import type { IsolatedFontFace } from "./font-resolution.js";
import { xmlStyleText } from "./svg-image-css-import.js";
import { parseImageElementTree } from "./svg-image-selector-engine.js";

export interface ImageOwnFontContext {
  authority: "chromium-svg-image-fonts-v1";
  sourceSha256: string;
  faces: Array<{
    family: string;
    data: string;
    sha256: string;
    weight?: string;
    style?: string;
    stretch?: string;
    unicodeRange: Array<[number, number]>;
  }>;
}

export const imageFontDigest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Decode XML before CSS parsing; preserve its exact text in the emitted sheet. */
export function imageOwnFontSheets(source: string): { source: string; faces: string[] } | null {
  if (/<\?xml[^>]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(source)) return null;
  // These can change which stylesheet nodes are active. Do not authenticate
  // a regex-collected face as a member of a different document/style set.
  if (/<(?:foreignObject|template)\b|<[\w.-]+:style\b|<\?xml-stylesheet\b/i.test(source)) return null;
  if (/\bxmlns\s*=\s*(['"])(?!http:\/\/www\.w3\.org\/2000\/svg\1)/i.test(source)) return null;
  const faces: string[] = [];
  let invalid = false;
  const normalized = source.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_all, open: string, raw: string, close: string) => {
      const css = xmlStyleText(raw);
      const style = parseImageElementTree(`<svg>${open}</style></svg>`)?.children[0];
      if (
        !/^<style\b/.test(open) ||
        style == null ||
        style.attributes.has("media") ||
        style.attributes.has("title") ||
        (style.attributes.has("type") && style.attributes.get("type")?.trim().toLowerCase() !== "text/css")
      )
        invalid = true;
      if (css == null) {
        invalid = true;
        return _all;
      }
      try {
        const sheet = postcss.parse(css);
        sheet.walkAtRules((rule) => {
          if (rule.name.toLowerCase() !== "font-face") return;
          // Conditional availability needs the image's exact environment;
          // FontFaceList also sorts layered faces by CascadeLayerMap rank
          // (css_segmented_font_face.cc:199-233), rather than source order.
          for (let parent = rule.parent; parent != null && parent.type !== "root"; parent = parent.parent) {
            invalid = true;
          }
          faces.push(rule.toString());
        });
      } catch {
        invalid = true;
      }
      return `${open}<![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]>${close}`;
    },
  );
  return invalid || faces.length > 64 ? null : { source: normalized, faces };
}

/** Missing, stale or malformed evidence cannot authorize isolated font metrics. */
export function authenticatedImageFonts(source: string, context?: ImageOwnFontContext): IsolatedFontFace[] | null {
  if (
    context?.authority !== "chromium-svg-image-fonts-v1" ||
    context.sourceSha256 !== imageFontDigest(source) ||
    context.faces.length === 0 ||
    context.faces.length > 64
  )
    return null;
  let bytes = 0;
  const out: IsolatedFontFace[] = [];
  for (const face of context.faces) {
    const data = Buffer.from(face.data, "base64");
    bytes += data.length;
    if (bytes > 16 * 1024 * 1024 || imageFontDigest(data) !== face.sha256) return null;
    out.push({ ...face, data });
  }
  return out;
}
