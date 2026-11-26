/** Image-owned font evidence. Bytes never enter the embedding page's font set. */
import { createHash } from "node:crypto";
import postcss from "postcss";
import { imageStyleSheets, replaceImageStyleSheets, serializeImageStyleText } from "./svg-image-stylesheets.js";
import type { IsolatedFontFace } from "./font-resolution.js";
import { resolveSvgImageCssImports, xmlStyleText } from "./svg-image-css-import.js";
import { cssUnescape, parseImageElementTree } from "./svg-image-selector-engine.js";
import { referenceCssIdentifier } from "./svg-image-reference-syntax.js";

export interface ImageOwnFontContext {
  authority: "chromium-svg-image-fonts-v1";
  sourceSha256: string;
  /** Capture's CSSOM rejected non-default feature / variation settings on
   * active faces. Older contexts did not perform that check. */
  faceSettingsChecked?: true;
  faces: Array<{
    family: string;
    data: string;
    sha256: string;
    weight?: string;
    style?: string;
    stretch?: string;
    unicodeRange: Array<[number, number]>;
    /** Metric descriptors (fractions; absent = 100% / normal). Admitted only
     *  with a painted used-face witness (`image-svg-font-witness.ts`). */
    sizeAdjust?: number;
    ascentOverride?: number;
    descentOverride?: number;
    lineGapOverride?: number;
    /** Enclosing `@media` / `@supports` preludes, outermost first. Capture
     *  records only faces whose conditions held for `viewport`. */
    conditions?: ImageFontCondition[];
  }>;
  /** The image viewport (CSS px) the conditions were decided for; required
   *  when any face carries a media condition. */
  viewport?: { w: number; h: number };
}

/** One conditional group rule enclosing an image `@font-face`. */
export interface ImageFontCondition {
  type: "media" | "supports";
  prelude: string;
}

export const imageFontDigest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Decode XML before CSS parsing; preserve its exact text in the emitted sheet. */
export function imageOwnFontSheets(source: string): {
  source: string;
  faces: string[];
  conditions: ImageFontCondition[][];
  hasNonDefaultFaceSettings: boolean;
} | null {
  if (/<\?xml[^>]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(source)) return null;
  // These can change which stylesheet nodes are active. Do not authenticate
  // a regex-collected face as a member of a different document/style set.
  if (/<(?:foreignObject|template)\b|<[\w.-]+:style\b|<\?xml-stylesheet\b/i.test(source)) return null;
  if (/\bxmlns\s*=\s*(['"])(?!http:\/\/www\.w3\.org\/2000\/svg\1)/i.test(source)) return null;
  if (imageStyleSheets(source) == null) return null;
  const faces: string[] = [];
  const conditions: ImageFontCondition[][] = [];
  let invalid = false;
  let hasNonDefaultFaceSettings = false;
  const normalized = replaceImageStyleSheets(source, ({ open, css: raw, close }) => {
    const _all = open + raw + close;
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
        if (rule.name.toLowerCase() !== "font-face") {
          // PostCSS can split an escaped at-keyword into a name and prelude.
          // This scanner cannot authenticate the resulting face inventory.
          if (
            (rule.name + rule.params).includes("\\") &&
            referenceCssIdentifier(rule.toString(), 1)?.value.toLowerCase() === "font-face"
          )
            invalid = true;
          return;
        }
        rule.walkDecls((decl) => {
          const name = cssUnescape(decl.prop).toLowerCase();
          if (
            (name === "font-feature-settings" || name === "font-variation-settings") &&
            cssUnescape(decl.value.trim()).toLowerCase() !== "normal"
          )
            hasNonDefaultFaceSettings = true;
        });
        // `@media` / `@supports` groups are decided against the image's own
        // environment (`conditions`). Every other parent stays unresolved:
        // FontFaceList sorts layered faces by CascadeLayerMap rank
        // (css_segmented_font_face.cc:199-233) rather than source order, and
        // which faces `@container` / `@scope` contribute is not modeled.
        const chain: ImageFontCondition[] = [];
        for (let parent = rule.parent; parent != null && parent.type !== "root"; parent = parent.parent) {
          const name = parent.type === "atrule" ? (parent as postcss.AtRule).name.toLowerCase() : "";
          if (name !== "media" && name !== "supports") invalid = true;
          else chain.unshift({ type: name, prelude: (parent as postcss.AtRule).params });
        }
        faces.push(rule.toString());
        conditions.push(chain);
      });
    } catch {
      invalid = true;
    }
    return open + serializeImageStyleText(css, true) + close;
  });
  return invalid || faces.length > 64 ? null : { source: normalized, faces, conditions, hasNonDefaultFaceSettings };
}

/**
 * Rewrite the `@font-face` rules of a source `imageOwnFontSheets` accepted, in
 * the same order as its `faces`. `edit` returns the replacement rule text, or
 * null to remove the rule. Used to build the same-source references the
 * painted used-face witness compares against.
 */
export function rewriteImageFontFaces(
  source: string,
  edit: (index: number, rule: postcss.AtRule) => string | null,
  /** Rules appended to the end of the last sheet (face order is document
   *  order); read after every edit has run. */
  append: () => string = () => "",
): string | null {
  const normalized = imageOwnFontSheets(source);
  if (normalized == null) return null;
  const sheets = imageStyleSheets(normalized.source)?.length ?? 0;
  let index = 0;
  let sheet = 0;
  let failed = false;
  const out = replaceImageStyleSheets(normalized.source, ({ open, css: raw, close }) => {
    const last = ++sheet === sheets;
    const css = xmlStyleText(raw);
    if (css == null) {
      failed = true;
      return open + raw + close;
    }
    try {
      const parsed = postcss.parse(css);
      parsed.walkAtRules((rule) => {
        if (rule.name.toLowerCase() !== "font-face") return;
        const replacement = edit(index++, rule);
        if (replacement == null) rule.remove();
        else rule.replaceWith(postcss.parse(replacement).nodes);
      });
      return open + serializeImageStyleText(parsed.toString() + (last ? append() : ""), true) + close;
    } catch {
      failed = true;
      return open + raw + close;
    }
  });
  return failed || index !== normalized.faces.length ? null : out;
}

/**
 * Missing, stale or malformed evidence cannot authorize isolated font metrics.
 * A face recorded under `@media` / `@supports` is re-decided with `decide`
 * (the renderer's image environment); capture recorded only faces whose
 * conditions held, so any other answer, or an undecided one, is refused.
 */
export function authenticatedImageFonts(
  source: string,
  context?: ImageOwnFontContext,
  decide?: (condition: ImageFontCondition, viewport: { w: number; h: number } | undefined) => boolean | null,
): IsolatedFontFace[] | null {
  if (
    context?.authority !== "chromium-svg-image-fonts-v1" ||
    context.sourceSha256 !== imageFontDigest(source) ||
    context.faces.length === 0 ||
    context.faces.length > 64
  )
    return null;
  // Legacy evidence predates the CSSOM check. Reuse it for ordinary sources;
  // only recapture can qualify sources with possible non-default settings.
  if (context.faceSettingsChecked !== true) {
    const expanded = resolveSvgImageCssImports(source, true);
    if (expanded == null || imageOwnFontSheets(expanded)?.hasNonDefaultFaceSettings !== false) return null;
  }
  let bytes = 0;
  const out: IsolatedFontFace[] = [];
  for (const face of context.faces) {
    const data = Buffer.from(face.data, "base64");
    bytes += data.length;
    if (bytes > 16 * 1024 * 1024 || imageFontDigest(data) !== face.sha256) return null;
    for (const metric of [face.sizeAdjust, face.ascentOverride, face.descentOverride, face.lineGapOverride])
      if (metric != null && !(Number.isFinite(metric) && metric >= 0)) return null;
    for (const condition of face.conditions ?? []) {
      if (condition.type === "media" && context.viewport == null) return null;
      if (decide?.(condition, context.viewport) !== true) return null;
    }
    const { conditions: _conditions, ...isolated } = face;
    out.push({ ...isolated, data });
  }
  return out;
}
