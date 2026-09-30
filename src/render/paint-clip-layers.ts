import { splitTopLevelCommas } from "./css-tokens.js";
import { cyclicBackgroundLayer } from "./image-pattern.js";

/** Parse the per-layer background/mask paint clips without splitting functions. */
export function parsePaintClipLayers(css: string | undefined): string[] {
  return splitTopLevelCommas(css ?? "border-box");
}

/** CSS repeats a shorter paint-clip list to match its image layer list. */
export function paintClipForLayer(css: string | undefined, index: number): string {
  return cyclicBackgroundLayer(parsePaintClipLayers(css), index, "border-box").trim();
}
