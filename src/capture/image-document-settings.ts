/**
 * The `prefersReducedMotion` / `inForcedColors` Settings an `<img>`'s SVG
 * image document sees (chromium 7d859f27).
 *
 * `SVGImage::DataChanged` builds each image's non-ordinary Page from the
 * renderer's first ordinary page's Settings (`core/svg/graphics/
 * svg_image.cc:901-904`), and `IsolatedSVGDocumentHost::CopySettingsFrom`
 * copies `prefersReducedMotion` and `inForcedColors` (`isolated_svg_document_
 * host.cc:192-199`). The image page has no DevTools media overrides, so
 * `MediaValues::CalculatePrefersReducedMotion` (`core/css/media_values.cc:
 * 441-459`) and the StyleEngine's forced colors (`core/css/style_engine.cc:
 * 4431, 4451-4455`) answer from those Settings. A Playwright `reducedMotion`
 * emulation is a media override and does not reach the image, while its
 * `forcedColors` emulation writes the page's Settings
 * (`InspectorEmulationAgent`, `core/inspector/inspector_emulation_agent.cc:
 * 418-430`) and does. Neither value is observable through the page's
 * `matchMedia`, so the probe asks an SVG image: it draws a `data:` SVG whose
 * rect is hidden under the query into a canvas and reads the pixel's alpha
 * (alpha, not color, so forced colors cannot repaint the answer). The canvas
 * image goes through the same `SVGImage` path as an `<img>`, in the same
 * renderer process, so it copies the same first ordinary page.
 */
import type { Page } from "@playwright/test";

import type { CapturedElement } from "./types.js";
import { walkCapturedElements } from "../tree-ops/walk-captured-elements.js";

export interface ImageDocumentSettings {
  prefersReducedMotion: boolean;
  forcedColors: boolean;
}

/** The queries probed, in result order. */
const PROBE_QUERIES = ["(prefers-reduced-motion: reduce)", "(forced-colors: active)"] as const;

/**
 * Ask the page's SVG image documents for their copied Settings. Null when a
 * probe image cannot load or be read back (e.g. a CSP that blocks `data:`
 * images), which leaves the two media features undecided.
 */
export async function probeImageDocumentSettings(page: Page): Promise<ImageDocumentSettings | null> {
  const answers = await page
    .evaluate(async (queries: readonly string[]) => {
      // No named inner functions: `tsx` (esbuild keepNames) would wrap them in
      // a `__name` helper that does not exist in the page.
      const out: Array<boolean | null> = [];
      for (const query of queries) {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">` +
          `<style>@media ${query} { rect { opacity: 0 } }</style>` +
          `<rect width="4" height="4" fill="#000"/></svg>`;
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        try {
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 4;
          canvas.height = 4;
          const context = canvas.getContext("2d");
          if (context == null) {
            out.push(null);
            continue;
          }
          context.drawImage(image, 0, 0);
          const alpha = context.getImageData(2, 2, 1, 1).data[3];
          out.push(alpha === 0 ? true : alpha === 255 ? false : null);
        } catch {
          out.push(null);
        }
      }
      return out;
    }, PROBE_QUERIES)
    .catch(() => null);
  if (answers == null) return null;
  const [prefersReducedMotion, forcedColors] = answers;
  if (prefersReducedMotion == null || forcedColors == null) return null;
  return { prefersReducedMotion, forcedColors };
}

/** True when the tree has an `<img>` whose image could be an SVG document. */
export function treeHasImgElement(tree: readonly CapturedElement[]): boolean {
  let found = false;
  walkCapturedElements(tree, (element) => {
    if (element.tag === "img") found = true;
  });
  return found;
}

/** Record the image document Settings on every captured `<img>`. */
export function stampImageDocumentSettings(tree: readonly CapturedElement[], settings: ImageDocumentSettings): void {
  walkCapturedElements(tree, (element) => {
    if (element.tag !== "img") return;
    element.imageDocumentPrefersReducedMotion = settings.prefersReducedMotion;
    element.imageDocumentForcedColors = settings.forcedColors;
  });
}

/** Probe and stamp in one step; a no-op for a tree without `<img>`. */
export async function captureImageDocumentSettings(page: Page, tree: readonly CapturedElement[]): Promise<void> {
  if (!treeHasImgElement(tree)) return;
  const settings = await probeImageDocumentSettings(page);
  if (settings != null) stampImageDocumentSettings(tree, settings);
}
