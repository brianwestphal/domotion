/**
 * Capture-time URL background selection and natural sizing.
 *
 * Chromium revision 7d859f271cbda744098ac69f44978d4edfa62be3:
 * - CSSImageSetValue::GetBestOption filters unsupported MIME descriptors,
 *   stable-sorts by computed resolution, removes later duplicate densities,
 *   and selects the first density >= Document::DevicePixelRatio.
 * - StyleImageSet delegates sizing/load state to that selected StyleImage.
 * - StyleFetchedImage::GetNaturalSizingInfo applies bitmap image-set density,
 *   image orientation, resource density correction, and effective CSS zoom.
 *
 * The synchronous capture walker cannot await image decoding. This module
 * primes every live element asynchronously, leaves a serializable record on
 * the element for the walker, and removes those temporary properties after
 * capture.
 */

import type { Frame, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CapturedBackgroundImage } from "./types.js";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/jpg",
  "image/webp",
  "image/png",
  "image/apng",
  "image/gif",
  "image/bmp",
  "image/vnd.microsoft.icon",
  "image/x-icon",
  "image/x-xbitmap",
  "image/x-png",
  // Chromium's desktop Playwright builds enable the AVIF decoder. JXL is
  // feature/build-flagged and disabled in the supported browser build.
  "image/avif",
]);

export interface ParsedImageSetCandidate {
  /** Null when Blink's selected `<image>` is not a URL-backed image. */
  url: string | null;
  resolution: number;
  type: string | null;
  index: number;
}

export interface SelectedBackgroundCandidate {
  source: "url" | "image-set";
  selectedUrl: string | null;
  selectedCandidateIndex: number | null;
  selectedResolution: number;
  selectedType: string | null;
  /** Exact byte-sniffed kind for a locally readable source. Page-side fetch
   * cannot read file:// resources, but capture Node can. */
  locallyObservedKind?: "bitmap" | "svg";
  /** Source bytes for a byte-sniffed local SVG. Kept only in the Node-to-page
   * sizing prepass so file: captures do not depend on page-side fetch(). */
  locallyObservedSvgText?: string;
  warning?: string;
}

interface CollectedBackgroundTarget {
  key: number;
  backgroundImage: string;
  dpr: number;
  effectiveZoom: number;
  imageOrientation: "from-image" | "none";
}

interface PreparedBackgroundTarget extends CollectedBackgroundTarget {
  selections: Array<SelectedBackgroundCandidate | null>;
}

/** Identify local bytes, never a filename suffix. This is the capture-side
 * analogue of Blink asking its decoded Image object whether it is bitmap/SVG. */
export function sniffLocalImageKind(bytes: Uint8Array): "bitmap" | "svg" | null {
  const ascii = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "bitmap";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "bitmap";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "bitmap";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "bitmap";
  if (bytes.length >= 2 && ascii(0, 2) === "BM") return "bitmap";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return "bitmap";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") return "bitmap";
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("utf8")
    .replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^>]*>\s*/i, "").replace(/^\s*<!--[^]*?-->\s*/i, "");
  return /^\s*<svg(?:\s|>)/i.test(text) ? "svg" : null;
}

async function locallyObservedImage(
  url: string | null,
): Promise<{ kind: "bitmap" | "svg"; svgText?: string } | null> {
  if (url == null || !url.startsWith("file:")) return null;
  try {
    const bytes = await readFile(fileURLToPath(url));
    const kind = sniffLocalImageKind(bytes);
    if (kind === "svg") return { kind, svgText: bytes.toString("utf8") };
    return kind === "bitmap" ? { kind } : null;
  } catch { return null; }
}

/**
 * tsx/esbuild's keep-names transform can leave `__name(...)` calls inside a
 * callback's serialized source. Playwright evaluates that source in the page,
 * where the module-scoped helper does not exist. Wrap the callback in a local
 * equivalent so CLI audits and built consumers execute the identical prepass
 * without leaving a helper on the inspected page's global object.
 */
function evaluateFrameFunction<Result>(
  frame: Frame,
  callback: () => Result | Promise<Result>,
): Promise<Result>;
function evaluateFrameFunction<Argument, Result>(
  frame: Frame,
  callback: (argument: Argument) => Result | Promise<Result>,
  argument: Argument,
): Promise<Result>;
function evaluateFrameFunction<Argument, Result>(
  frame: Frame,
  callback: ((argument: Argument) => Result | Promise<Result>) | (() => Result | Promise<Result>),
  argument?: Argument,
): Promise<Result> {
  const serializedArgument = arguments.length >= 3 ? JSON.stringify(argument) : "";
  const invocation = arguments.length >= 3 ? `(${serializedArgument})` : "()";
  const expression = `((__name) => (${callback.toString()})${invocation})(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; })`;
  return frame.evaluate(expression) as Promise<Result>;
}

/** Split a CSS comma-list without splitting nested image functions or strings. */
export function splitBackgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      layers.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

function cssUnescape(value: string): string {
  return value.replace(/\\([\s\S])/g, "$1");
}

function extractDirectUrl(value: string): string | null {
  const match = /^\s*url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)]+))\s*\)\s*$/i.exec(value);
  if (match != null) return cssUnescape(match[1] ?? match[2] ?? match[3] ?? "");
  const string = /^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*$/.exec(value);
  return string == null ? null : cssUnescape(string[1] ?? string[2] ?? "");
}

function topLevelTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let quote = "";
  let escaped = false;
  let current = "";
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== "") {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      current += char;
      quote = char;
      continue;
    }
    if (char === "(") {
      current += char;
      depth++;
      continue;
    }
    if (char === ")") {
      current += char;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (/\s/.test(char) && depth === 0) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function resolutionInDppx(token: string): number | null {
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))(x|dppx|dpi|dpcm)$/i.exec(token);
  if (match == null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "dpi") return value / 96;
  if (unit === "dpcm") return value * 2.54 / 96;
  return value;
}

export function parseImageSetCandidates(layer: string): ParsedImageSetCandidate[] | null {
  const match = /^\s*(?:-webkit-)?image-set\(([\s\S]*)\)\s*$/i.exec(layer);
  if (match == null) return null;
  return splitBackgroundLayers(match[1]).flatMap((option, index) => {
    const tokens = topLevelTokens(option);
    if (tokens.length === 0) return [];
    const extractedUrl = extractDirectUrl(tokens[0]);
    const url = extractedUrl === "" ? null : extractedUrl;
    let resolution = 1;
    let type: string | null = null;
    for (const token of tokens.slice(1)) {
      const parsedResolution = resolutionInDppx(token);
      if (parsedResolution != null) resolution = parsedResolution;
      const typeMatch = /^type\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\)$/i.exec(token);
      if (typeMatch != null) type = cssUnescape(typeMatch[1] ?? typeMatch[2] ?? "").toLowerCase();
    }
    return [{ url, resolution, type, index }];
  });
}

export function isBlinkSupportedImageMimeType(type: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(type.toLowerCase());
}

/** Mirror CSSImageSetValue::GetBestOption at the pinned Chromium revision. */
export function selectBackgroundCandidate(
  layer: string,
  deviceScaleFactor: number,
): SelectedBackgroundCandidate | null {
  const candidates = parseImageSetCandidates(layer);
  if (candidates == null) {
    const url = extractDirectUrl(layer);
    return url == null ? null : {
      source: "url",
      selectedUrl: url,
      selectedCandidateIndex: null,
      selectedResolution: 1,
      selectedType: null,
    };
  }

  const supported = candidates
    .filter((candidate) => candidate.resolution > 0
      && (candidate.type == null || isBlinkSupportedImageMimeType(candidate.type)))
    .sort((left, right) => left.resolution - right.resolution || left.index - right.index);
  const unique: ParsedImageSetCandidate[] = [];
  for (const candidate of supported) {
    if (unique.some((prior) => prior.resolution === candidate.resolution)) continue;
    unique.push(candidate);
  }
  const selected = unique.find((candidate) => candidate.resolution >= deviceScaleFactor)
    ?? unique.at(-1);
  if (selected == null) {
    return {
      source: "image-set",
      selectedUrl: null,
      selectedCandidateIndex: null,
      selectedResolution: 1,
      selectedType: null,
      warning: "image-set has no Blink-supported positive-resolution URL candidate",
    };
  }
  return {
    source: "image-set",
    selectedUrl: selected.url,
    selectedCandidateIndex: selected.index,
    selectedResolution: selected.resolution,
    selectedType: selected.type,
    ...(selected.url == null
      ? { warning: "Blink selected a non-URL image-set candidate; URL background sizing is unavailable" }
      : {}),
  };
}

async function collectBackgroundTargets(frame: Frame): Promise<CollectedBackgroundTarget[]> {
  return evaluateFrameFunction(frame, () => {
    const host = globalThis as unknown as {
      __domotionBackgroundImageTargets?: Element[];
    };
    for (const prior of host.__domotionBackgroundImageTargets ?? []) {
      const tagged = prior as Element & {
        __domotionBackgroundImageKey?: unknown;
        __domotionBackgroundImages?: unknown;
      };
      try { delete tagged.__domotionBackgroundImageKey; } catch {}
      try { delete tagged.__domotionBackgroundImages; } catch {}
    }
    const elements = [document.documentElement, ...Array.from(document.getElementsByTagName("*"))];
    const targets: Element[] = [];
    host.__domotionBackgroundImageTargets = targets;
    const zoomMemo = new WeakMap<Element, number>();
    const effectiveZoom = (element: Element | null): number => {
      if (element == null) return 1;
      const cached = zoomMemo.get(element);
      if (cached != null) return cached;
      const parent = effectiveZoom(element.parentElement);
      const own = Number.parseFloat(getComputedStyle(element).zoom);
      const value = parent * (Number.isFinite(own) && own > 0 ? own : 1);
      zoomMemo.set(element, value);
      return value;
    };
    const out: CollectedBackgroundTarget[] = [];
    for (const element of elements) {
      const style = getComputedStyle(element);
      if (style.backgroundImage === "" || style.backgroundImage === "none") continue;
      const key = out.length;
      Object.defineProperty(element, "__domotionBackgroundImageKey", { configurable: true, value: key });
      targets.push(element);
      out.push({
        key,
        backgroundImage: style.backgroundImage,
        dpr: window.devicePixelRatio,
        effectiveZoom: effectiveZoom(element),
        imageOrientation: style.imageOrientation === "none" ? "none" : "from-image",
      });
    }
    return out;
  });
}

async function hydrateBackgroundTargets(
  frame: Frame,
  targets: PreparedBackgroundTarget[],
  timeoutMs: number,
): Promise<void> {
  await evaluateFrameFunction(frame, async ({ prepared, timeout }) => {
    type RawSizing = {
      loadState: "loaded" | "loading" | "failed";
      naturalSizingState: "resolved" | "unavailable";
      kind: "bitmap" | "svg" | "unknown";
      width: number | null;
      height: number | null;
      hasWidth: boolean | null;
      hasHeight: boolean | null;
      ratio: { width: number; height: number } | null;
      warning?: string;
    };
    const host = globalThis as unknown as {
      __domotionBackgroundImageTargets?: Element[];
    };

    const absoluteSvgLength = (raw: string | null): number | null => {
      if (raw == null || raw.trim() === "" || raw.trim() === "auto" || raw.trim().endsWith("%")) return null;
      const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|in|cm|mm|q|pt|pc)?\s*$/.exec(raw);
      if (match == null) return null;
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value < 0) return null;
      const scales: Record<string, number> = {
        px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4,
        q: 96 / 101.6, pt: 96 / 72, pc: 16,
      };
      return value * (scales[(match[2] ?? "px").toLowerCase()] ?? 1);
    };
    const svgSizing = (text: string): Omit<RawSizing, "loadState"> | null => {
      const document = new DOMParser().parseFromString(text, "image/svg+xml");
      if (document.querySelector("parsererror") != null) return null;
      const root = document.documentElement;
      if (root.localName.toLowerCase() !== "svg") return null;
      const width = absoluteSvgLength(root.getAttribute("width"));
      const height = absoluteSvgLength(root.getAttribute("height"));
      let ratio: { width: number; height: number } | null = null;
      if (width != null && height != null && width > 0 && height > 0) {
        ratio = { width, height };
      } else {
        const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
        if (viewBox?.length === 4 && viewBox.every(Number.isFinite)
            && viewBox[2] > 0 && viewBox[3] > 0) {
          ratio = { width: viewBox[2], height: viewBox[3] };
        }
      }
      return {
        naturalSizingState: "resolved",
        kind: "svg",
        width,
        height,
        hasWidth: width != null,
        hasHeight: height != null,
        ratio,
      };
    };
    const dataSvgText = (url: string): string | null => {
      const match = /^data:image\/svg\+xml([^,]*),(.*)$/is.exec(url);
      if (match == null) return null;
      try {
        if (/;base64/i.test(match[1])) return atob(match[2]);
        return decodeURIComponent(match[2]);
      } catch {
        return null;
      }
    };
    const fetchSvg = async (url: string): Promise<{ kind: "bitmap" | "svg" | "unknown"; text: string | null }> => {
      const embedded = dataSvgText(url);
      if (embedded != null) return { kind: "svg", text: embedded };
      if (/^data:image\//i.test(url)) return { kind: "bitmap", text: null };
      try {
        const response = await fetch(url);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
        if (contentType === "image/svg+xml") {
          return { kind: "svg", text: await response.text() };
        }
        if (contentType.startsWith("image/")) return { kind: "bitmap", text: null };
      } catch {}
      // A URL suffix or image-set type() descriptor is only a hint. Blink asks
      // the decoded Image whether it is bitmap/SVG; when CORS hides the actual
      // response kind, guessing would apply density to SVG or invent fixed
      // bitmap dimensions. Preserve explicit unknown state instead.
      return { kind: "unknown", text: null };
    };
    const cache = new Map<string, Promise<RawSizing>>();
    const load = (
      url: string,
      orientation: "from-image" | "none",
      localKind?: "bitmap" | "svg",
      localSvgText?: string,
    ): Promise<RawSizing> => {
      const cacheKey = `${orientation}\n${localKind ?? ""}\n${url}`;
      const hit = cache.get(cacheKey);
      if (hit != null) return hit;
      const pending = (async (): Promise<RawSizing> => {
        const image = new Image();
        // Author `img` rules (including !important rules) must not turn this
        // sizing probe into page-style evidence. Inline important declarations
        // keep the replaced element at its own oriented intrinsic size.
        image.style.cssText = "all:initial!important;position:fixed!important;left:-100000px!important;top:0!important;display:block!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;visibility:hidden!important;pointer-events:none!important";
        image.style.setProperty("image-orientation", orientation, "important");
        let eventState: "load" | "error" | "timeout";
        const event = new Promise<"load" | "error">((resolve) => {
          image.addEventListener("load", () => resolve("load"), { once: true });
          image.addEventListener("error", () => resolve("error"), { once: true });
        });
        image.src = url;
        if (image.complete) eventState = image.naturalWidth > 0 && image.naturalHeight > 0 ? "load" : "error";
        else {
          eventState = await Promise.race([
            event,
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeout)),
          ]);
        }
        if (eventState === "timeout") {
          return {
            loadState: "loading", naturalSizingState: "unavailable", kind: "unknown",
            width: null, height: null, hasWidth: null, hasHeight: null, ratio: null,
            warning: `selected background image did not decode within ${timeout}ms`,
          };
        }
        if (eventState === "error" || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          return {
            loadState: "failed", naturalSizingState: "unavailable", kind: "unknown",
            width: null, height: null, hasWidth: null, hasHeight: null, ratio: null,
            warning: "selected background image failed to load or decode",
          };
        }

        const source = localKind == null
          ? await fetchSvg(url)
          : { kind: localKind, text: localSvgText ?? null };
        if (source.kind === "svg") {
          let svgText = source.text;
          if (svgText == null && url.startsWith("file:")) {
            try { svgText = await (await fetch(url)).text(); } catch {}
          }
          const sizing = svgText == null ? null : svgSizing(svgText);
          if (sizing == null) {
            return {
              loadState: "loaded", naturalSizingState: "unavailable", kind: "svg",
              width: null, height: null, hasWidth: null, hasHeight: null, ratio: null,
              warning: "loaded SVG background natural dimensions were not readable at capture time",
            };
          }
          return { loadState: "loaded", ...sizing };
        }
        if (source.kind === "unknown") {
          return {
            loadState: "loaded", naturalSizingState: "unavailable", kind: "unknown",
            width: null, height: null, hasWidth: null, hasHeight: null, ratio: null,
            warning: "loaded background image type was not observable; natural dimension presence is unknown",
          };
        }

        (document.body || document.documentElement).appendChild(image);
        // offsetWidth/offsetHeight retain image-orientation's used intrinsic
        // axes while excluding ancestor zoom/transforms. A client rect would
        // already contain the document's zoom and then be scaled a second time
        // by target.effectiveZoom below.
        const orientedWidth = image.offsetWidth;
        const orientedHeight = image.offsetHeight;
        image.remove();
        const width = orientedWidth > 0 && Number.isFinite(orientedWidth) ? orientedWidth : image.naturalWidth;
        const height = orientedHeight > 0 && Number.isFinite(orientedHeight) ? orientedHeight : image.naturalHeight;
        return {
          loadState: "loaded", naturalSizingState: "resolved", kind: "bitmap",
          width, height, hasWidth: true, hasHeight: true,
          ratio: width > 0 && height > 0 ? { width, height } : null,
        };
      })();
      cache.set(cacheKey, pending);
      return pending;
    };

    const elements = host.__domotionBackgroundImageTargets ?? [];
    await Promise.all(prepared.map(async (target) => {
      const element = elements.find((candidate) =>
        (candidate as Element & { __domotionBackgroundImageKey?: number }).__domotionBackgroundImageKey === target.key);
      if (element == null) return;
      // Start every unique resource together. A page with several stalled
      // layers pays one timeout window, not one timeout per layer/element.
      const records = await Promise.all(target.selections.map(async (
        selection,
        layerIndex,
      ): Promise<CapturedBackgroundImage | null> => {
        if (selection == null) return null;
        const {
          locallyObservedKind: _locallyObservedKind,
          locallyObservedSvgText: _locallyObservedSvgText,
          ...capturedSelection
        } = selection;
        if (selection.selectedUrl == null) {
          return {
            layerIndex,
            ...capturedSelection,
            decodedImageKind: "unknown",
            decodedNaturalWidth: null,
            decodedNaturalHeight: null,
            naturalWidth: null,
            naturalHeight: null,
            hasNaturalWidth: null,
            hasNaturalHeight: null,
            naturalAspectRatio: null,
            imageOrientation: target.imageOrientation,
            effectiveZoom: target.effectiveZoom,
            loadState: "unsupported",
            naturalSizingState: "unavailable",
          };
        }
        const raw = await load(
          selection.selectedUrl,
          target.imageOrientation,
          selection.locallyObservedKind,
          selection.locallyObservedSvgText,
        );
        // StyleFetchedImage applies image-set resolution only to bitmap
        // candidates. SVG candidate resolution affects selection, not its
        // NaturalSizingInfo multiplier.
        const density = raw.kind === "bitmap" ? selection.selectedResolution : 1;
        const scale = target.effectiveZoom / Math.max(Number.EPSILON, density);
        return {
          layerIndex,
          ...capturedSelection,
          decodedImageKind: raw.kind,
          decodedNaturalWidth: raw.hasWidth === true ? raw.width : null,
          decodedNaturalHeight: raw.hasHeight === true ? raw.height : null,
          naturalWidth: raw.hasWidth === true && raw.width != null ? raw.width * scale : null,
          naturalHeight: raw.hasHeight === true && raw.height != null ? raw.height * scale : null,
          hasNaturalWidth: raw.hasWidth,
          hasNaturalHeight: raw.hasHeight,
          naturalAspectRatio: raw.ratio,
          imageOrientation: target.imageOrientation,
          effectiveZoom: target.effectiveZoom,
          loadState: raw.loadState,
          naturalSizingState: raw.naturalSizingState,
          warning: selection.warning ?? raw.warning,
        };
      }));
      Object.defineProperty(element, "__domotionBackgroundImages", {
        configurable: true,
        value: records,
      });
    }));
  }, { prepared: targets, timeout: timeoutMs });
}

/**
 * Await the selected resource for each URL background and leave its sizing
 * record on the live DOM for the synchronous capture walker.
 */
export async function primeBackgroundImageSizing(
  page: Page,
  options: { timeoutMs?: number } = {},
): Promise<{ dispose(): Promise<void> }> {
  const frames = page.frames();
  const timeoutMs = options.timeoutMs ?? 3_000;
  await Promise.all(frames.map(async (frame) => {
    try {
      const collected = await collectBackgroundTargets(frame);
      const prepared: PreparedBackgroundTarget[] = await Promise.all(collected.map(async (target) => ({
        ...target,
        selections: await Promise.all(splitBackgroundLayers(target.backgroundImage)
          .map(async (layer) => {
            const selected = selectBackgroundCandidate(layer, target.dpr);
            if (selected?.selectedUrl == null) return selected;
            const local = await locallyObservedImage(selected.selectedUrl);
            return local == null ? selected : {
              ...selected,
              locallyObservedKind: local.kind,
              ...(local.svgText == null ? {} : { locallyObservedSvgText: local.svgText }),
            };
          })),
      })));
      await hydrateBackgroundTargets(frame, prepared, timeoutMs);
    } catch {
      // Detached and cross-origin frames remain owned by their existing raster
      // boundary. The top document and same-origin recursive frames continue.
    }
  }));

  return {
    async dispose(): Promise<void> {
      await Promise.all(frames.map(async (frame) => {
        try {
          await evaluateFrameFunction(frame, () => {
            const host = globalThis as unknown as {
              __domotionBackgroundImageTargets?: Element[];
            };
            for (const target of host.__domotionBackgroundImageTargets ?? []) {
              const tagged = target as Element & {
                __domotionBackgroundImageKey?: unknown;
                __domotionBackgroundImages?: unknown;
              };
              try { delete tagged.__domotionBackgroundImageKey; } catch {}
              try { delete tagged.__domotionBackgroundImages; } catch {}
            }
            delete host.__domotionBackgroundImageTargets;
          });
        } catch {}
      }));
    },
  };
}
