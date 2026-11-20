/**
 * Painted used-face witness for an SVG image's own `@font-face` rules.
 *
 * Detached `FontFace` validation proves the bytes are valid, not that the image
 * painted them: `font-display` periods, source-list iteration and metric
 * descriptors are decided inside the image document. The witness asks Chromium
 * directly. It renders the image source and same-source references in `<img>`
 * elements on a scratch page of the capture browser context and compares the
 * element screenshots byte for byte; nothing is fitted to a width.
 *
 * - candidate: the source exactly as captured;
 * - loaded: every face reduced to the data source Domotion selected, with
 *   `font-display: block`, so the face is painted once it loads (the SVG image
 *   load event waits for the load-blocking font fetch, `SVGImage::CheckLoaded`);
 * - absent: every `@font-face` removed;
 * - per multi-source face, the candidate with the selected entry removed.
 *
 * The image painted Domotion's selection exactly when candidate == loaded,
 * loaded != absent (the reference discriminates at all), and removing a
 * selected entry moves the answer.
 */
import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";

/** The concrete `<img>` box the witness renders, in CSS px. */
export interface WitnessBox {
  width: number;
  height: number;
  objectFit?: string;
  objectPosition?: string;
}

export interface WitnessRequest {
  candidate: string;
  loaded: string;
  absent: string;
  /** Candidates with one selected source entry removed. */
  removed: string[];
  box: WitnessBox;
}

export type WitnessVerdict = "painted" | "fallback" | "other" | "indiscriminate" | "unavailable";

const MAX_BOX = 2048;
const MAX_IMAGES = 64;

/** Classify one image's digests (exported for unit tests). */
export function witnessVerdict(digests: {
  candidate: string;
  loaded: string;
  absent: string;
  removed: string[];
}): WitnessVerdict {
  if (digests.loaded === digests.absent) return "indiscriminate";
  if (digests.candidate === digests.absent) return "fallback";
  if (digests.candidate !== digests.loaded) return "other";
  // Removing the selected source must move the answer, or another source
  // paints identically and the selection is not proven.
  return digests.removed.every((digest) => digest !== digests.candidate) ? "painted" : "indiscriminate";
}

/** Run the witness for several images on one scratch page. */
export async function witnessImageFonts(page: Page, requests: WitnessRequest[]): Promise<WitnessVerdict[]> {
  const verdicts: WitnessVerdict[] = requests.map(() => "unavailable");
  const usable = requests
    .map((request, index) => ({ request, index }))
    .filter(
      ({ request }) =>
        request.box.width >= 1 &&
        request.box.height >= 1 &&
        request.box.width <= MAX_BOX &&
        request.box.height <= MAX_BOX,
    );
  if (usable.length === 0) return verdicts;
  let scratch: Page | null = null;
  let owned: BrowserContext | null = null;
  try {
    // A page in the capture context keeps its emulation (color scheme,
    // reduced motion, forced colors) for the image document to copy. An
    // implicit `browser.newPage()` context refuses more pages; fall back to a
    // fresh context in that case.
    try {
      scratch = await page.context().newPage();
    } catch {
      const browser = page.context().browser();
      if (browser == null) return verdicts;
      owned = await browser.newContext();
      scratch = await owned.newPage();
    }
    for (let start = 0; start < usable.length;) {
      // Each request renders 3 + removed.length images; batch by image count.
      const batch: typeof usable = [];
      let images = 0;
      while (start < usable.length) {
        const count = 3 + usable[start].request.removed.length;
        if (batch.length > 0 && images + count > MAX_IMAGES) break;
        batch.push(usable[start++]);
        images += count;
      }
      const items = batch.flatMap(({ request }, r) =>
        [request.candidate, request.loaded, request.absent, ...request.removed].map((source, k) => ({
          id: `w${r}_${k}`,
          source,
          box: request.box,
        })),
      );
      const width = Math.ceil(Math.max(...items.map((item) => item.box.width)));
      const height = Math.ceil(items.reduce((sum, item) => sum + item.box.height, 0));
      await scratch.setViewportSize({ width: Math.max(1, width), height: Math.max(1, Math.min(height, 16384)) });
      await scratch.setContent(
        `<!doctype html><body style="margin:0;background:#fff">${items
          .map(
            (item) =>
              `<div style="height:${item.box.height}px;width:${item.box.width}px;overflow:hidden"><img id="${item.id}" style="display:block;width:${item.box.width}px;height:${item.box.height}px;object-fit:${cssValue(item.box.objectFit, "fill")};object-position:${cssValue(item.box.objectPosition, "50% 50%")}" src="data:image/svg+xml,${encodeURIComponent(item.source).replaceAll('"', "%22")}"></div>`,
          )
          .join("")}</body>`,
      );
      const loaded = await scratch.evaluate(async () => {
        const images = [...document.images];
        await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return images.every((image) => image.complete && image.naturalWidth > 0);
      });
      if (!loaded) continue;
      const digests = new Map<string, string>();
      for (const item of items) {
        const shot = await scratch.locator(`#${item.id}`).screenshot({ animations: "disabled" });
        digests.set(item.id, createHash("sha256").update(shot).digest("hex"));
      }
      batch.forEach(({ request, index }, r) => {
        const at = (k: number): string => digests.get(`w${r}_${k}`) ?? "";
        verdicts[index] = witnessVerdict({
          candidate: at(0),
          loaded: at(1),
          absent: at(2),
          removed: request.removed.map((_, k) => at(3 + k)),
        });
      });
    }
  } catch {
    // An unavailable witness admits nothing that needs it.
  } finally {
    await scratch?.close().catch(() => undefined);
    await owned?.close().catch(() => undefined);
  }
  return verdicts;
}

/** A captured object-fit/position value, or the initial value if it could
 *  break out of the inline style. */
function cssValue(value: string | undefined, initial: string): string {
  return value != null && /^[\w\s.%+-]+$/.test(value) ? value : initial;
}
