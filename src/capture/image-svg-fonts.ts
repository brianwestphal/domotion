import type { Page } from "@playwright/test";
import type { CapturedElement } from "./types.js";
import { resolveSvgSource } from "./embed.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { resolveSvgImageCssImports } from "../render/svg-image-css-import.js";
import { imageFontDigest, imageOwnFontSheets, type ImageOwnFontContext } from "../render/svg-image-own-fonts.js";
import { firstCssFunctionToken, parseCssUrl } from "../render/css-tokens.js";
import { parseDataUri } from "../utils/data-uri.js";
import { parseUnicodeRangeDescriptor } from "./unicode-range.js";
import { normalizedFontData } from "./font-data.js";
import { cssUnescape } from "../render/svg-image-selector-engine.js";

/** SVGImage::CheckLoaded waits for Document::LoadEventFinished; font fetches
 * block that event (resource.cc:IsLoadEventBlockingResourceType). For auto,
 * block and swap, RemoteFontFaceSource::UpdatePeriod never latches failure.
 * Thus a completed image plus a valid data face proves availability, unlike
 * optional/fallback, whose failure period can retain a fallback after loading.
 * Detached FontFace validation applies Chromium's OTS/format/tech parser but
 * never exposes an image family to document.fonts. Chromium7d859f27. */
export async function captureImageSvgFonts(page: Page, tree: CapturedElement[]): Promise<void> {
  const pending: Array<{ el: CapturedElement; source: string; faces: string[] }> = [];
  forEachElement(tree, (el) => {
    if (
      el.imageSrc == null ||
      el.imageOwnFonts != null ||
      el.brokenImageFallback?.source.complete !== true ||
      !(el.brokenImageFallback.source.naturalWidth > 0)
    )
      return;
    const source = resolveSvgSource(el.imageSrc);
    if (source == null) return;
    const expanded = resolveSvgImageCssImports(source, true);
    const sheets = expanded == null ? null : imageOwnFontSheets(expanded);
    if (sheets != null && sheets.faces.length > 0) pending.push({ el, source, faces: sheets.faces });
  });
  for (const item of pending) {
    const parsed = await page.evaluate(
      (rules: string[]) =>
        rules.map((rule) => {
          const sheet = new CSSStyleSheet();
          try {
            sheet.replaceSync(rule);
            const face = sheet.cssRules[0];
            if (!(face instanceof CSSFontFaceRule)) return null;
            const style = face.style;
            // Unsupported metric overrides and failure-period display modes stay
            // unresolved. Invalid declarations have already been dropped by CSSOM.
            if (!["auto", "block", "swap"].includes(style.getPropertyValue("font-display") || "auto")) return null;
            for (const name of ["size-adjust", "ascent-override", "descent-override", "line-gap-override"])
              if (style.getPropertyValue(name)) return null;
            if (!["", "normal", "italic"].includes(style.getPropertyValue("font-style"))) return null;
            return {
              family: style.getPropertyValue("font-family"),
              src: style.getPropertyValue("src"),
              weight: style.getPropertyValue("font-weight"),
              style: style.getPropertyValue("font-style"),
              stretch: style.getPropertyValue("font-stretch"),
              unicodeRange: style.getPropertyValue("unicode-range") || "U+0-10FFFF",
            };
          } catch {
            return null;
          }
        }),
      item.faces,
    );
    const faces: ImageOwnFontContext["faces"] = [];
    let total = 0;
    const deadline = Date.now() + 3000;
    for (const descriptor of parsed) {
      if (descriptor == null || descriptor.family === "" || /\\/.test(descriptor.src)) break;
      // Start with one unambiguous data source. local() and external resources
      // cannot be authenticated by an embedding-page FontFace request.
      const token = firstCssFunctionToken(descriptor.src);
      const url = token == null ? null : parseCssUrl(token);
      if (url == null || url.includes("#") || !/^data:/i.test(url)) break;
      // Reject other candidates BEFORE FontFace.load, so validation cannot
      // fetch a remote fallback or consult an embedding-page local source.
      const suffix = descriptor.src.slice(token!.length).trim();
      if (suffix !== "" && !/^(?:format|tech)\([^()]*\)(?:\s+(?:format|tech)\([^()]*\))*$/.test(suffix)) break;
      const data = parseDataUri(url);
      if (data == null || (total += data.bytes.length) > 16 * 1024 * 1024) break;
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) break;
      const valid = await page.evaluate(
        async ({ descriptor, timeoutMs }) => {
          try {
            const font = new FontFace(descriptor.family, descriptor.src, {
              weight: descriptor.weight || "normal",
              style: descriptor.style || "normal",
              stretch: descriptor.stretch || "normal",
              unicodeRange: descriptor.unicodeRange,
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                font.load().then(
                  () => true,
                  () => false,
                ),
                new Promise<false>((resolve) => {
                  timer = setTimeout(() => resolve(false), timeoutMs);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          } catch {
            return false;
          }
        },
        { descriptor, timeoutMs },
      );
      if (!valid) break;
      const bytes = await normalizedFontData(data.bytes, 16 * 1024 * 1024);
      if (bytes == null || (total += bytes.length - data.bytes.length) > 16 * 1024 * 1024) break;
      faces.push({
        family: cssUnescape(descriptor.family.replace(/^(["'])(.*)\1$/, "$2")),
        // Omitted descriptors are auto capabilities in FontFace::GetFontSelectionCapabilities;
        // explicit normal has equal selection ranges but DIFFERENT axis clamps.
        weight: descriptor.weight || undefined,
        style: descriptor.style || undefined,
        stretch: descriptor.stretch || undefined,
        unicodeRange: parseUnicodeRangeDescriptor(descriptor.unicodeRange) ?? [[0, 0x10ffff]],
        data: bytes.toString("base64"),
        sha256: imageFontDigest(bytes),
      });
    }
    if (faces.length === item.faces.length)
      item.el.imageOwnFonts = {
        authority: "chromium-svg-image-fonts-v1",
        sourceSha256: imageFontDigest(item.source),
        faces,
      };
  }
}
