/**
 * SVG Post-Processing Optimizer
 *
 * Uses SVGO to optimize path data and transforms without altering structure.
 * Particularly effective for path-mode text (shortens glyph coordinates, converts
 * to relative commands, reduces decimal precision).
 */

import { optimize, type PluginConfig } from "svgo";

/**
 * Optimize an SVG string. Safe for all rendering modes — only compresses
 * path data, transforms, and whitespace. Does not remove elements or IDs.
 */
export function optimizeSvg(svg: string): string {
  // svgo 4.x's PluginConfig discriminated union is too narrow for
  // `makeArcs: false` (the type expects a {threshold, tolerance} object even
  // though svgo accepts `false` at runtime to disable arc conversion).
  // Cast the convertPathData entry so the rest of the plugin list still
  // type-checks.
  const plugins: PluginConfig[] = [
    { name: "convertPathData", params: {
      floatPrecision: 1,
      transformPrecision: 3,
      makeArcs: false,
    } } as PluginConfig,
    "convertTransform",
    "minifyStyles",
    "removeComments",
    "removeEmptyAttrs",
  ];
  const result = optimize(svg, { multipass: true, plugins });
  return result.data;
}
