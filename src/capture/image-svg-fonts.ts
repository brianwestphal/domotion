import type { Page } from "@playwright/test";
import type { CapturedElement } from "./types.js";
import { resolveSvgSource } from "./embed.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { resolveSvgImageCssImports } from "../render/svg-image-css-import.js";
import {
  imageFontDigest,
  imageOwnFontSheets,
  rewriteImageFontFaces,
  type ImageOwnFontContext,
} from "../render/svg-image-own-fonts.js";
import { firstCssFunctionToken, parseCssUrl, splitTopLevelCommas } from "../render/css-tokens.js";
import { parseDataUri } from "../utils/data-uri.js";
import { parseUnicodeRangeDescriptor } from "./unicode-range.js";
import { normalizedFontData } from "./font-data.js";
import { parseCssFontFamilyName } from "../font-family-stack.js";
import { witnessImageFonts, type WitnessBox } from "./image-svg-font-witness.js";

/** One entry of a CSSOM-serialized `src` descriptor list. */
export type FontSourceEntry =
  { kind: "url"; url: string; text: string } | { kind: "local"; name: string; text: string };

/**
 * Split the `src` value Chromium's CSSOM serialized. The parser has already
 * dropped entries whose `format()` / `tech()` are unsupported
 * (`AtRuleDescriptorParser`; `CSSFontFaceSrcValue::IsSupportedFormat`,
 * `core/css/css_font_face_src_value.cc:85-99`, Chromium 7d859f27, only adds the
 * legacy `.eot` URL check for format-less non-data URLs). Null when any entry
 * is not a plain `url()` / `local()` with optional format/tech hints.
 */
export function fontSourceEntries(src: string): FontSourceEntry[] | null {
  if (src.trim() === "" || /\\/.test(src)) return null;
  const entries: FontSourceEntry[] = [];
  for (const raw of splitTopLevelCommas(src)) {
    const text = raw.trim();
    const token = firstCssFunctionToken(text);
    if (token == null) return null;
    const suffix = text.slice(token.length).trim();
    if (suffix !== "" && !/^(?:format|tech)\([^()]*\)(?:\s+(?:format|tech)\([^()]*\))*$/i.test(suffix)) return null;
    if (/^local\(/i.test(token)) {
      if (suffix !== "") return null;
      const name = /^local\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/i.exec(token)?.[1];
      if (name == null) return null;
      entries.push({ kind: "local", name, text });
      continue;
    }
    const url = parseCssUrl(token);
    if (url == null) return null;
    entries.push({ kind: "url", url, text });
  }
  return entries;
}

/** A metric descriptor as a fraction: absent / `normal` -> undefined. */
export function metricDescriptor(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "normal") return undefined;
  const percent = /^(\d+(?:\.\d+)?|\.\d+)%$/.exec(trimmed);
  return percent == null ? null : Number(percent[1]) / 100;
}

/** The concrete `<img>` box the image document was laid out in, in CSS px. */
function witnessBox(el: CapturedElement): WitnessBox {
  const n = (value: string | undefined): number => parseFloat(value ?? "0") || 0;
  const s = el.styles;
  const zoom =
    el.imageEffectiveZoom != null && Number.isFinite(el.imageEffectiveZoom) && el.imageEffectiveZoom > 0
      ? el.imageEffectiveZoom
      : 1;
  return {
    width:
      Math.max(0, el.width - n(s.borderLeftWidth) - n(s.borderRightWidth) - n(s.paddingLeft) - n(s.paddingRight)) /
      zoom,
    height:
      Math.max(0, el.height - n(s.borderTopWidth) - n(s.borderBottomWidth) - n(s.paddingTop) - n(s.paddingBottom)) /
      zoom,
    objectFit: s.objectFit,
    objectPosition: s.objectPosition,
  };
}

/** SVGImage::CheckLoaded waits for Document::LoadEventFinished; font fetches
 * block that event (resource.cc:IsLoadEventBlockingResourceType). For auto,
 * block and swap, RemoteFontFaceSource::UpdatePeriod never latches failure.
 * Thus a completed image plus a valid data face proves availability.
 * Detached FontFace validation applies Chromium's OTS/format/tech parser but
 * never exposes an image family to document.fonts. Chromium7d859f27.
 *
 * Faces whose use is decided inside the image document — `font-display:
 * fallback`, several source entries, or metric descriptors — are admitted only
 * when the painted used-face witness (`image-svg-font-witness.ts`) shows the
 * image painted exactly Domotion's selection.
 *
 * `font-display: optional` stays raster. `RemoteFontFaceSource::ComputePeriod`
 * (`remote_font_face_source.cc:113-136`) enters the failure period once the
 * document's rendering has begun unless the font finished from the memory cache,
 * finished before rendering began, or no paint was requested while it was
 * pending. An SVG document begins rendering as soon as its document element is
 * inserted (`Document::ChildrenChanged`, `document.cc:1265-1274`; only HTML
 * documents have render-blocking resources, `document.cc:9034-9037`), before
 * any `<style>` child can start a font fetch, so the second condition never
 * holds. The other two depend on the process-wide memory cache and on paint
 * timing, which the source does not order.
 */
export async function captureImageSvgFonts(page: Page, tree: CapturedElement[]): Promise<void> {
  const pending: Array<{ el: CapturedElement; source: string; expanded: string; faces: string[] }> = [];
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
    if (expanded != null && sheets != null && sheets.faces.length > 0)
      pending.push({ el, source, expanded, faces: sheets.faces });
  });
  const witnessed: Array<{
    el: CapturedElement;
    context: ImageOwnFontContext;
    request: Parameters<typeof witnessImageFonts>[1][number];
  }> = [];
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
            // Descriptors this path does not model stay unresolved. Invalid
            // declarations have already been dropped by CSSOM.
            if (!["", "normal", "italic"].includes(style.getPropertyValue("font-style"))) return null;
            return {
              family: style.getPropertyValue("font-family"),
              src: style.getPropertyValue("src"),
              weight: style.getPropertyValue("font-weight"),
              style: style.getPropertyValue("font-style"),
              stretch: style.getPropertyValue("font-stretch"),
              unicodeRange: style.getPropertyValue("unicode-range") || "U+0-10FFFF",
              display: style.getPropertyValue("font-display") || "auto",
              sizeAdjust: style.getPropertyValue("size-adjust"),
              ascentOverride: style.getPropertyValue("ascent-override"),
              descentOverride: style.getPropertyValue("descent-override"),
              lineGapOverride: style.getPropertyValue("line-gap-override"),
            };
          } catch {
            return null;
          }
        }),
      item.faces,
    );
    const faces: ImageOwnFontContext["faces"] = [];
    // Per face: the selected entry's text and the full entry list.
    const selections: Array<{ entries: FontSourceEntry[]; selected: number }> = [];
    let needsWitness = false;
    let total = 0;
    const deadline = Date.now() + 3000;
    for (const descriptor of parsed) {
      if (descriptor == null || descriptor.family === "") break;
      const family = parseCssFontFamilyName(descriptor.family);
      if (family == null) break;
      if (descriptor.display === "optional" || !["auto", "block", "swap", "fallback"].includes(descriptor.display))
        break;
      const metrics = [
        descriptor.sizeAdjust,
        descriptor.ascentOverride,
        descriptor.descentOverride,
        descriptor.lineGapOverride,
      ].map(metricDescriptor);
      if (metrics.some((metric) => metric === null)) break;
      const [sizeAdjust, ascentOverride, descentOverride, lineGapOverride] = metrics as Array<number | undefined>;
      const entries = fontSourceEntries(descriptor.src);
      // local() and non-data URLs are not modeled here, so they never enter
      // a FontFace.load that could consult the embedding page or the network.
      if (entries == null || entries.length > 8 || entries.some((e) => e.kind !== "url" || !/^data:/i.test(e.url)))
        break;
      // CSSFontFace::Load / GetFontData (css_font_face.cc:155-200, 247-271)
      // pop each source that fails to load and use the first that succeeds.
      let selected = -1;
      let bytes: Buffer | null = null;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.kind !== "url" || entry.url.includes("#")) break;
        const data = parseDataUri(entry.url);
        if (data == null || (total += data.bytes.length) > 16 * 1024 * 1024) break;
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) break;
        const valid = await page.evaluate(
          async ({ descriptor, family, src, timeoutMs }) => {
            try {
              const font = new FontFace(family, src, {
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
          { descriptor, family, src: entry.text, timeoutMs },
        );
        if (valid) {
          selected = index;
          bytes = data.bytes;
          break;
        }
      }
      if (selected < 0 || bytes == null) break;
      const normalized = await normalizedFontData(bytes, 16 * 1024 * 1024);
      if (normalized == null || (total += normalized.length) > 16 * 1024 * 1024) break;
      if (descriptor.display === "fallback" || entries.length > 1 || metrics.some((metric) => metric !== undefined))
        needsWitness = true;
      selections.push({ entries, selected });
      faces.push({
        family,
        // Omitted descriptors are auto capabilities in FontFace::GetFontSelectionCapabilities;
        // explicit normal has equal selection ranges but DIFFERENT axis clamps.
        weight: descriptor.weight || undefined,
        style: descriptor.style || undefined,
        stretch: descriptor.stretch || undefined,
        unicodeRange: parseUnicodeRangeDescriptor(descriptor.unicodeRange) ?? [[0, 0x10ffff]],
        data: normalized.toString("base64"),
        sha256: imageFontDigest(normalized),
        ...(sizeAdjust == null ? {} : { sizeAdjust }),
        ...(ascentOverride == null ? {} : { ascentOverride }),
        ...(descentOverride == null ? {} : { descentOverride }),
        ...(lineGapOverride == null ? {} : { lineGapOverride }),
      });
    }
    if (faces.length !== item.faces.length) continue;
    const context: ImageOwnFontContext = {
      authority: "chromium-svg-image-fonts-v1",
      sourceSha256: imageFontDigest(item.source),
      faces,
    };
    if (!needsWitness) {
      item.el.imageOwnFonts = context;
      continue;
    }
    const request = witnessRequest(item.source, item.expanded, selections, witnessBox(item.el));
    if (request != null) witnessed.push({ el: item.el, context, request });
  }
  if (witnessed.length === 0) return;
  const verdicts = await witnessImageFonts(
    page,
    witnessed.map((entry) => entry.request),
  );
  witnessed.forEach((entry, index) => {
    if (verdicts[index] === "painted") entry.el.imageOwnFonts = entry.context;
  });
}

/** Same-source references for the painted used-face witness. */
export function witnessRequest(
  source: string,
  expanded: string,
  selections: ReadonlyArray<{ entries: FontSourceEntry[]; selected: number }>,
  box: WitnessBox,
): Parameters<typeof witnessImageFonts>[1][number] | null {
  const withSrc = (rule: Parameters<Parameters<typeof rewriteImageFontFaces>[1]>[1], src: string, block: boolean) => {
    const clone = rule.clone();
    clone.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      if (prop === "src" || (block && prop === "font-display")) decl.remove();
    });
    clone.append({ prop: "src", value: src });
    if (block) clone.append({ prop: "font-display", value: "block" });
    return clone.toString();
  };
  const loaded = rewriteImageFontFaces(expanded, (index, rule) => {
    const selection = selections[index];
    return withSrc(rule, selection.entries[selection.selected].text, true);
  });
  const absent = rewriteImageFontFaces(expanded, () => null);
  if (loaded == null || absent == null) return null;
  const removed: string[] = [];
  for (let face = 0; face < selections.length; face++) {
    if (selections[face].entries.length < 2) continue;
    const variant = rewriteImageFontFaces(expanded, (index, rule) => {
      if (index !== face) return rule.toString();
      const { entries, selected } = selections[index];
      return withSrc(
        rule,
        entries
          .filter((_, at) => at !== selected)
          .map((entry) => entry.text)
          .join(", "),
        false,
      );
    });
    if (variant == null) return null;
    removed.push(variant);
  }
  return { candidate: source, loaded, absent, removed, box };
}
