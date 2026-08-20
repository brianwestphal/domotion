/**
 * Chromium-backed raster boundary for CSS gradient interpolation that SVG 1.1
 * cannot represent faithfully (DM-2308).
 *
 * SVG exposes only sRGB/linearRGB interpolation and interpolates unpremultiplied
 * stop colors. CSS gradients support Lab-family and polar hue spaces and Blink
 * always requests premultiplied-alpha interpolation. Rather than curve-fit
 * extra SVG stops, capture those tiles directly from the already-running
 * Chromium page and embed the exact result.
 */

import type { Page } from "@playwright/test";
import type { CapturedElement } from "../capture/types.js";
import { splitTopLevelCommas } from "./css-tokens.js";
import { computeTileSize } from "./conic-raster.js";
import { _conicTileCache } from "./element-tree-to-svg.js";
import { collectFormControlConicTiles } from "./form-controls.js";

export const _advancedGradientTileCache = new Map<string, Map<string, string>>();

export function needsChromiumGradientRaster(layer: string): boolean {
  if (/^(?:repeating-)?conic-gradient\(/i.test(layer.trim())) return true;
  if (!/^(?:repeating-)?(?:linear|radial)-gradient\(/i.test(layer.trim())) return false;
  // SVG has no Lab/OKLab/LCH/OKLCH/HSL/HWB interpolation or hue-route knob.
  if (/\bin\s+(?:lab|oklab|lch|oklch|hsl|hwb)\b/i.test(layer)) return true;
  // Blink constructs CSS gradients with kPremultiplied. SVG gradients use
  // unpremultiplied color interpolation, which diverges whenever alpha varies.
  const alphas = [
    ...[...layer.matchAll(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/gi)].map((m) => Number(m[1])),
    ...[...layer.matchAll(/rgb\([^)]*\/\s*([\d.]+)\s*\)/gi)].map((m) => Number(m[1])),
    ...[...layer.matchAll(/color\([^)]*\/\s*([\d.]+)\s*\)/gi)].map((m) => Number(m[1])),
  ];
  return alphas.some((alpha) => Number.isFinite(alpha) && alpha < 1);
}

export function advancedGradientTile(layer: string, width: number, height: number): string | null {
  const sizeKey = `${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`;
  const cache = /^(?:repeating-)?conic-gradient\(/i.test(layer.trim())
    ? _conicTileCache
    : _advancedGradientTileCache;
  return cache.get(layer)?.get(sizeKey) ?? null;
}

export async function rasterizeAdvancedGradients(tree: CapturedElement[], page: Page): Promise<void> {
  const tuples = new Map<string, { layer: string; width: number; height: number }>();
  const consider = (layer: string, width: number, height: number): void => {
    if (!needsChromiumGradientRaster(layer)) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${layer}\n${w}x${h}`;
    // The live page is authoritative for this capture. Do not reuse a module-
    // global entry that may have come from a prior browser/context or from the
    // helper-absent CPU conic fallback; overwrite it below with current pixels.
    tuples.set(key, { layer, width: w, height: h });
  };
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      for (const [imageCss, sizeCss] of [
        [el.styles.backgroundImage, el.styles.backgroundSize],
        [el.styles.maskImage, el.styles.maskSize],
      ] as const) {
        if (imageCss == null || imageCss === "" || imageCss === "none") continue;
        const layers = splitTopLevelCommas(imageCss);
        const sizes = splitTopLevelCommas(sizeCss ?? "auto");
        for (let index = 0; index < layers.length; index++) {
          const layer = layers[index].trim();
          const tile = computeTileSize((sizes[index % Math.max(1, sizes.length)] ?? "auto").trim(), el.width, el.height);
          consider(layer, tile.w, tile.h);
        }
      }
      for (const tile of collectFormControlConicTiles(el)) consider(tile.layer, tile.w, tile.h);
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (tuples.size === 0) return;

  const scratch = await page.context().newPage();
  try {
    await scratch.setContent('<style>html,body{margin:0;background:transparent}</style><div id="tile"></div>');
    for (const { layer, width, height } of tuples.values()) {
      await scratch.locator("#tile").evaluate((node, { layer, width, height }) => {
        (node as HTMLElement).style.cssText = `width:${width}px;height:${height}px;background-color:transparent;background-repeat:no-repeat;background-size:100% 100%`;
        (node as HTMLElement).style.backgroundImage = layer;
      }, { layer, width, height });
      const png = await scratch.locator("#tile").screenshot({ omitBackground: true });
      const cache = /^(?:repeating-)?conic-gradient\(/i.test(layer)
        ? _conicTileCache
        : _advancedGradientTileCache;
      let bySize = cache.get(layer);
      if (bySize == null) {
        bySize = new Map();
        cache.set(layer, bySize);
      }
      bySize.set(`${width}x${height}`, `data:image/png;base64,${png.toString("base64")}`);
    }
  } finally {
    await scratch.close();
  }
}
