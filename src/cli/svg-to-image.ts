#!/usr/bin/env node
/**
 * svg-to-image — convert a (still or animated) SVG to a single image file.
 *
 * A standalone CLI (its own `bin`, sibling to `domotion` / `svg-to-video` /
 * `svg-review` / `svg-scrubber`) that loads an SVG in Playwright
 * Chromium and writes one PNG, JPEG, or PDF. The headless, one-shot counterpart
 * to the scrubber's interactive "Export frame" — built for the agent review
 * loop ("render → look at the pixels → critique → iterate"), but works on any
 * SVG. Output format follows the `-o` extension (or `--format`).
 *
 * Run `svg-to-image --help` for options.
 */

import { parseArgs } from "node:util";
import { launchChromium } from "../index.js";
import { runBin, makeLogger, parseNonNegativeFloat, parsePositiveInt } from "./common.js";
import { resolveImageFormat, runSvgToImage, SUPPORTED_IMAGE_EXTS, type ImageFormat, type SvgToImageOptions } from "./svg-to-image-core.js";

// DM-1370: delegate the `--format` keyword parsing to `resolveImageFormat`'s
// override branch (the format-keyword list + aliases + error message live there)
// instead of duplicating it. With a non-empty override, the output path is
// ignored, so the placeholder is fine.
function parseFormat(value: string | undefined): ImageFormat | undefined {
  return value == null ? undefined : resolveImageFormat("", value);
}

function parseQuality(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`--quality expects an integer 1–100, got "${value}"`);
  return n;
}

const HELP = `svg-to-image — convert an SVG to an image (PNG / JPEG / PDF / WebP / AVIF / TIFF)

Usage:
  svg-to-image <input.svg> -o <output> [options]
  svg-to-image --help

Arguments:
  <input.svg>              SVG to rasterize (e.g. a domotion capture/animate output).

Options:
  -o, --output <path>      Output path (required). The extension picks the format:
                           ${SUPPORTED_IMAGE_EXTS}. Override with --format.
      --format <fmt>       Force the output format: png | jpeg | pdf | webp | avif | tiff.
      --at <ms>            For an animated SVG, the timeline position to sample
                           (default 0 = the first frame).
      --width <px>         Target width; contains within, preserving aspect ratio.
      --height <px>        Target height; contains within, preserving aspect ratio.
                           Give either or both; omitted → the SVG's intrinsic size.
      --scale <n>          Device-pixel-ratio / supersample factor for raster
                           output (default 1; output px = size × scale). Use 2 for
                           a crisp retina raster. Ignored for PDF (vector).
      --background <css>   Page background behind the SVG (default "transparent").
                           PNG/WebP/AVIF/TIFF keep the SVG's own alpha; JPEG/PDF
                           can't carry alpha and composite onto white.
      --quality <1-100>    Quality for JPEG / WebP / AVIF (default 92). Ignored for
                           png / pdf / tiff.
      --quiet              Suppress the progress line on stderr.
  -h, --help               Show this help.

Examples:
  # The agent review loop: capture to SVG, then look at the pixels.
  domotion capture page.html -o out.svg
  svg-to-image out.svg -o out.png

  # A retina (2×) PNG.
  svg-to-image card.svg -o card@2x.png --scale 2

  # Grab the payoff frame of an animation at 4s as a WebP.
  svg-to-image demo.svg -o frame.webp --at 4000 --quality 90

  # A vector PDF sized to the SVG.
  svg-to-image poster.svg -o poster.pdf

Needs Chromium (Playwright); auto-installed on first run. WebP/AVIF/TIFF are
transcoded with sharp (already a dependency), loaded only when requested.
`;

void runBin<SvgToImageOptions>({
  name: "svg-to-image",
  help: HELP,
  parse: (argv) => {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: "string", short: "o" },
        format: { type: "string" },
        at: { type: "string" },
        width: { type: "string" },
        height: { type: "string" },
        scale: { type: "string" },
        background: { type: "string" },
        quality: { type: "string" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });

    if (values.help) {
      process.stdout.write(HELP);
      process.exit(0);
    }

    const input = positionals[0];
    if (!input) throw new Error("missing <input.svg> argument");
    if (positionals.length > 1) throw new Error(`unexpected extra argument: ${positionals[1]}`);
    if (!values.output) throw new Error("missing required -o/--output");

    const quiet = values.quiet ?? false;
    return {
      input,
      output: values.output,
      format: parseFormat(values.format),
      atMs: parseNonNegativeFloat(values.at, "at"),
      width: parsePositiveInt(values.width, "width"),
      height: parsePositiveInt(values.height, "height"),
      scale: parsePositiveInt(values.scale, "scale") ?? 1,
      background: values.background,
      quality: parseQuality(values.quality),
      quiet,
      log: makeLogger(quiet),
      launchBrowser: () => launchChromium(),
    };
  },
  run: runSvgToImage,
});
