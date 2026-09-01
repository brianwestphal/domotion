/** Final optimization and output ownership for `domotion animate`. */

import { compressEmbeddedFontsToWoff2, optimizeSvg } from "../post-processing/index.js";
import { isSvgzPath, resolveOutputPath, timed, writeOutput } from "./common.js";

export interface AnimateArtifactRequest {
  svg: string;
  outputArg: string | undefined;
  configPath: string;
  frameCount: number;
  optimizeRequested: boolean;
  optimizeConfigured: boolean;
  noOptimize: boolean;
  log: (message: string) => void;
}

/** Optimize, resolve the destination, and write one completed animation. */
export async function writeAnimateArtifact(request: AnimateArtifactRequest): Promise<void> {
  const svgz = isSvgzPath(request.outputArg);
  const optimize = request.optimizeRequested
    || (request.optimizeConfigured && !request.noOptimize)
    || (svgz && !request.noOptimize);
  let svg = request.svg;
  if (optimize) {
    svg = await timed(
      request.log,
      `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`,
      () => compressEmbeddedFontsToWoff2(optimizeSvg(svg)),
    );
  }
  const outPath = resolveOutputPath(request.outputArg, request.configPath, ".svg");
  writeOutput(svg, outPath, svgz, `, ${request.frameCount} frames`);
}
