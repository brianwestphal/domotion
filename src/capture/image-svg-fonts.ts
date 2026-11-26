import type { Page } from "@playwright/test";
import type { CapturedElement } from "./types.js";
import { resolveSvgSource } from "./embed.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { resolveSvgImageCssImports } from "../render/svg-image-css-import.js";
import {
  imageFontDigest,
  imageOwnFontSheets,
  rewriteImageFontFaces,
  type ImageFontCondition,
  type ImageOwnFontContext,
} from "../render/svg-image-own-fonts.js";
import { evaluateMediaQueryList, type ImageMediaEnv } from "../render/svg-image-media.js";
import { decideImageSupports } from "../render/svg-image-supports.js";
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
  const pending: Array<{
    el: CapturedElement;
    source: string;
    expanded: string;
    faces: string[];
    conditions: ImageFontCondition[][];
  }> = [];
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
      pending.push({ el, source, expanded, faces: sheets.faces, conditions: sheets.conditions });
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
            // CSSFontFace::GetFontData merges these settings into the face's
            // description (both flags are stable at Chromium 7d859f27). The
            // isolated metrics resolver has no authenticated settings merge.
            for (const property of ["font-feature-settings", "font-variation-settings"])
              if (!["", "normal"].includes(style.getPropertyValue(property))) return null;
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
    // Measured only when a witness or a media condition needs the box.
    let measured: WitnessBox | undefined;
    const box = (): WitnessBox => (measured ??= witnessBox(item.el));
    const viewport = (): { w: number; h: number } => ({ w: box().width, h: box().height });
    const env: ImageMediaEnv = {
      preferredColorScheme: item.el.imageEmbeddingColorScheme ?? null,
      prefersReducedMotion: item.el.imageDocumentPrefersReducedMotion ?? null,
      forcedColors: item.el.imageDocumentForcedColors ?? null,
      supports: item.el.imageSvgSupports ?? null,
    };
    // `@media` sees the image document's viewport, the concrete object size
    // (`svg-image-media.ts`); the witness box is that size only for `fill`.
    const decide = (condition: ImageFontCondition): boolean | null =>
      condition.type === "supports"
        ? decideImageSupports(condition.prelude, env.supports)
        : (box().objectFit ?? "fill") === "fill"
          ? evaluateMediaQueryList(condition.prelude, viewport(), env)
          : null;
    // A chain holds when every group holds; one false group decides it.
    const active = item.conditions.map((chain) => {
      const answers = chain.map(decide);
      return answers.includes(false) ? false : answers.includes(null) ? null : true;
    });
    if (active.includes(null)) continue;
    const faces: ImageOwnFontContext["faces"] = [];
    // Per source face: null when its conditions do not hold, else the
    // selected entry and the full entry list.
    const selections: Array<{ entries: FontSourceEntry[]; selected: number } | null> = [];
    let needsWitness = item.conditions.some((chain) => chain.length > 0);
    let failed = false;
    let total = 0;
    const deadline = Date.now() + 3000;
    for (const [faceIndex, descriptor] of parsed.entries()) {
      // A face in a false group never becomes a FontFace in the image.
      if (active[faceIndex] === false) {
        selections.push(null);
        continue;
      }
      failed = true;
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
      // Non-data URLs are not modeled, so they never enter a FontFace.load
      // that could reach the network.
      if (entries == null || entries.length > 8 || entries.some((e) => e.kind === "url" && !/^data:/i.test(e.url)))
        break;
      // CSSFontFace::Load / GetFontData (css_font_face.cc:155-200, 247-271)
      // pop each source that fails to load and use the first that succeeds.
      // A local() source succeeds when FontCache's platform unique-name lookup
      // finds a host face (LocalFontFaceSource::IsLocalFontAvailable,
      // local_font_face_source.cc); the detached FontFace asks the same
      // process-wide FontCache the image document uses.
      let selected = -1;
      let bytes: Buffer | null = null;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const data = entry.kind === "url" && !entry.url.includes("#") ? parseDataUri(entry.url) : null;
        if (entry.kind === "url" && (data == null || (total += data.bytes.length) > 16 * 1024 * 1024)) break;
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) break;
        const loads = await page.evaluate(
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
                  new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), timeoutMs);
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
        // A timeout decides nothing. An available host-local face is painted
        // instead of any data bytes, which this path does not attribute.
        if (loads == null || (loads && data == null)) break;
        if (loads) {
          selected = index;
          bytes = data?.bytes ?? null;
          break;
        }
      }
      if (selected < 0 || bytes == null) break;
      const normalized = await normalizedFontData(bytes, 16 * 1024 * 1024);
      if (normalized == null || (total += normalized.length) > 16 * 1024 * 1024) break;
      if (descriptor.display === "fallback" || entries.length > 1 || metrics.some((metric) => metric !== undefined))
        needsWitness = true;
      selections.push({ entries, selected });
      const conditions = item.conditions[faceIndex];
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
        ...(conditions.length === 0 ? {} : { conditions }),
      });
      failed = false;
    }
    if (failed || selections.length !== item.faces.length || faces.length === 0) continue;
    const context: ImageOwnFontContext = {
      authority: "chromium-svg-image-fonts-v1",
      sourceSha256: imageFontDigest(item.source),
      faceSettingsChecked: true,
      faces,
      ...(item.conditions.some((chain) => chain.some((c) => c.type === "media")) ? { viewport: viewport() } : {}),
    };
    if (!needsWitness) {
      item.el.imageOwnFonts = context;
      continue;
    }
    const request = witnessRequest(item.source, item.expanded, selections, box());
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

/**
 * Same-source references for the painted used-face witness. The loaded
 * reference is Domotion's model, not the source's: faces whose conditions do
 * not hold are removed, and active faces move out of their `@media` /
 * `@supports` groups to the end of the last sheet in document order, so the
 * browser cannot repeat a wrong condition decision in the reference.
 */
export function witnessRequest(
  source: string,
  expanded: string,
  selections: ReadonlyArray<{ entries: FontSourceEntry[]; selected: number } | null>,
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
  const hoisted: string[] = [];
  const loaded = rewriteImageFontFaces(
    expanded,
    (index, rule) => {
      const selection = selections[index];
      if (selection != null) hoisted.push(withSrc(rule, selection.entries[selection.selected].text, true));
      return null;
    },
    () => hoisted.join(""),
  );
  const absent = rewriteImageFontFaces(expanded, () => null);
  if (loaded == null || absent == null) return null;
  const removed: string[] = [];
  for (let face = 0; face < selections.length; face++) {
    const selection = selections[face];
    if (selection == null || selection.entries.length < 2) continue;
    const variant = rewriteImageFontFaces(expanded, (index, rule) =>
      index !== face
        ? rule.toString()
        : withSrc(
            rule,
            selection.entries
              .filter((_, at) => at !== selection.selected)
              .map((entry) => entry.text)
              .join(", "),
            false,
          ),
    );
    if (variant == null) return null;
    removed.push(variant);
  }
  return { candidate: source, loaded, absent, removed, box };
}
