/**
 * `domotion composite` (DM-1323) — declarative animated-SVG compositing.
 *
 * Stacks several layers — each a `cast`, a `template`, or a pre-rendered `svg`
 * (any of which may be *animated*) — into one self-contained animated SVG, each
 * placed and on its own timeline, with animation preserved. The declarative
 * front-end onto `composeAnimatedLayers` (the programmatic primitive): a layer's
 * source is rendered to an animated SVG (optionally wrapped in device chrome),
 * then composited.
 *
 * Config shape (validated by `compositeConfigSchema`):
 *   { width, height, output?, background?, duration?, layers: [ {
 *       <source>,                 // exactly one of: svg | cast | template
 *       chrome?: { device, label, theme },     // optional bezel around the source
 *       x?, y?, width?, height?, clip?, clipRadius?,
 *       start?, mode?, duration?, // the layer's own timeline (hold|stretch|loop)
 *       animations?: [ { property, from, to, start?, duration?, easing?, transformOrigin? } ]
 *     } ] }
 */

import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import type { Browser } from "@playwright/test";
import { z } from "zod";
import { requireField } from "./require-field.js";
import { loadTemplateRenderer } from "../templates/lazy-renderer.js";
import { launchChromium } from "../capture/index.js";
import { castToAnimatedSvg } from "../terminal/index.js";
import {
  DEVICE_CHROMES,
  CHROME_THEMES,
  wrapInDeviceChrome,
  clearEmbeddedFonts,
  clearGlyphDefs,
  getEmbeddedFontFaceCss,
} from "../render/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../animation/composite.js";
import { parseSvgIntrinsicSize, detectAnimationPeriodMs } from "../animation/svg-meta.js";
import { UsageError, errorMessage, formatConfigIssues, readInputFile, writeSvgOutput } from "./common.js";

export const compositeLayerAnimationSchema = z.object({
  property: z.enum(["scale", "translateX", "translateY", "opacity", "transform", "clipScaleX", "clipScaleY"]),
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]),
  start: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  easing: z.string().optional(),
  transformOrigin: z.string().optional(),
});

export const compositeLayerChromeSchema = z.object({
  device: z.enum(DEVICE_CHROMES).default("window"),
  label: z.string().optional(),
  theme: z.enum(CHROME_THEMES).default("dark"),
});

export const compositeLayerPlacementSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  clip: z.boolean().optional(),
  clipRadius: z.number().nonnegative().optional(),
  start: z.number().nonnegative().optional(),
  mode: z.enum(["hold", "stretch", "loop"]).optional(),
  duration: z.number().positive().optional(),
  animations: z.array(compositeLayerAnimationSchema).optional(),
});

export const compositeLayerSchema = z
  .object({
    // Exactly one source — enforced in the superRefine below.
    svg: z.string().optional().describe("Path to a pre-rendered SVG (static or animated)."),
    cast: z.string().optional().describe("Path to an asciinema v2 .cast (rendered as an animated terminal)."),
    template: z.string().optional().describe("A template name to render as the source."),
    params: z.record(z.string(), z.unknown()).optional().describe("Params for a `template` source."),
    term: z.record(z.string(), z.unknown()).optional().describe("Terminal options for a `cast` source."),
    // Period of an animated `svg` source (ms), when it can't be auto-detected.
    period: z.number().positive().optional(),
    chrome: compositeLayerChromeSchema.optional(),
    // Placement.
    ...compositeLayerPlacementSchema.shape,
  })
  .superRefine((l, ctx) => {
    const sources = [l.svg, l.cast, l.template].filter((s) => s != null);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "each layer must have exactly one source: `svg`, `cast`, or `template`",
      });
    }
  });

export const compositeConfigSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  output: z.string().optional(),
  background: z.string().optional(),
  duration: z.number().positive().optional(),
  layers: z.array(compositeLayerSchema).min(1),
});

export type CompositeConfig = z.infer<typeof compositeConfigSchema>;
export type CompositeLayerConfig = z.infer<typeof compositeLayerSchema>;
export type CompositeLayerPlacement = z.infer<typeof compositeLayerPlacementSchema>;

export function validateCompositeConfig(raw: unknown): CompositeConfig {
  const parsed = compositeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`composite: ${formatConfigIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Render one layer's source to an animated SVG + intrinsic size + period. */
async function renderLayerSource(
  layer: CompositeLayerConfig,
  browser: Browser,
  configDir: string,
  log: (m: string) => void,
): Promise<{ svg: string; w: number; h: number; periodMs?: number }> {
  if (layer.cast != null) {
    const castText = readInputFile(resolve(configDir, layer.cast), "composite layer cast");
    const { svg, width, height, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
      ...(layer.term ?? {}),
      log: (m) => log(`  ${m}`),
    });
    return { svg, w: width, h: height, periodMs: totalDurationMs };
  }
  if (layer.template != null) {
    const { loadTemplate, renderTemplateToSvg } = await loadTemplateRenderer();
    const template = await loadTemplate(layer.template);
    const out = await renderTemplateToSvg(template, layer.params ?? {}, { browser, log: (m) => log(`  ${m}`) });
    return { svg: out.svg, w: out.width, h: out.height, periodMs: out.durationMs ?? undefined };
  }
  // svg source: read a pre-rendered (static or animated) SVG.
  const svg = readInputFile(resolve(configDir, requireField(layer.svg, "composite layer.svg")), "composite layer svg");
  const size = parseSvgIntrinsicSize(svg) ?? { w: layer.width ?? 0, h: layer.height ?? 0 };
  return { svg, w: size.w, h: size.h, periodMs: layer.period ?? detectAnimationPeriodMs(svg) };
}

/** A rendered layer source (before chrome wrap / placement). */
interface RenderedSource {
  svg: string;
  w: number;
  h: number;
  periodMs?: number;
  deferFonts?: boolean;
}

/** Render + composite a validated config into one animated SVG. */
export async function composeCompositeConfig(
  browser: Browser,
  cfg: CompositeConfig,
  configDir: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const n = cfg.layers.length;
  const rendered: (RenderedSource | undefined)[] = new Array(n);

  // DM-1331: render all `cast` layers through ONE shared embedded-font builder so
  // several terminals that use the same monospace embed its (union) glyph subset
  // ONCE, not one subset per terminal. `clearEmbeddedFonts()` resets the builder,
  // each cast renders with `manageFonts:false` (deferring its @font-face), and the
  // single finished block is collected with `getEmbeddedFontFaceCss()` and emitted
  // once by composeAnimatedLayers. Must happen BEFORE template layers render —
  // a generator template runs a nested pipeline that clears the same builder.
  const castIdxs = cfg.layers.flatMap((l, i) => (l.cast != null ? [i] : []));
  let sharedFontCss = "";
  if (castIdxs.length > 0) {
    clearEmbeddedFonts();
    clearGlyphDefs(); // DM-1338: glyph registry shares the shared-builder lifecycle
    for (const i of castIdxs) {
      const layer = cfg.layers[i];
      log(`Layer ${i + 1}/${n}: cast (shared font)…`);
      const castText = readInputFile(
        resolve(configDir, requireField(layer.cast, "composite layer.cast")),
        "composite layer cast",
      );
      const { svg, width, height, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
        ...(layer.term ?? {}),
        manageFonts: false,
        log: (m) => log(`  ${m}`),
      });
      rendered[i] = { svg, w: width, h: height, periodMs: totalDurationMs, deferFonts: true };
    }
    sharedFontCss = getEmbeddedFontFaceCss();
  }

  // Remaining (svg / template) layers are self-contained — render after the shared
  // cast font is collected (a template clears the builder).
  for (let i = 0; i < n; i++) {
    if (rendered[i] != null) continue;
    const layer = cfg.layers[i];
    log(`Layer ${i + 1}/${n}: ${layer.template != null ? `template "${layer.template}"` : "svg"}…`);
    rendered[i] = await renderLayerSource(layer, browser, configDir, log);
  }

  // Assemble in z-order: apply optional device chrome, then place.
  const composeLayers: CompositeLayer[] = cfg.layers.map((layer, i) => {
    let { svg, w, h, periodMs, deferFonts } = requireField(rendered[i], `composite layer ${i} render`);
    if (layer.chrome != null) {
      const framed = wrapInDeviceChrome(svg, layer.chrome.device, w, h, {
        label: layer.chrome.label,
        theme: layer.chrome.theme,
      });
      svg = framed.svg;
      w = framed.width;
      h = framed.height;
    }
    return {
      svg,
      periodMs,
      contentWidth: w,
      contentHeight: h,
      deferFonts,
      x: layer.x,
      y: layer.y,
      width: layer.width ?? w,
      height: layer.height ?? h,
      clip: layer.clip,
      clipRadius: layer.clipRadius,
      start: layer.start,
      mode: layer.mode,
      duration: layer.duration,
      animations: layer.animations,
    };
  });

  const result = composeAnimatedLayers(composeLayers, {
    width: cfg.width,
    height: cfg.height,
    background: cfg.background,
    durationMs: cfg.duration,
    fontFaceCss: sharedFontCss,
  });
  log(`Composited ${n} layers — ${result.width}×${result.height}px, ${(result.durationMs / 1000).toFixed(1)}s loop`);
  return result.svg;
}

export const COMPOSITE_HELP = `domotion composite — stack layers (cast / template / svg) into one animated SVG

Usage:
  domotion composite <config.json> [-o out.svg]

Each layer is a cast, a template, or a pre-rendered SVG (any may be animated),
placed at x/y with an independent timeline (start / mode hold|stretch|loop) and
optional layer animations (move / scale / fade) and device chrome. See
docs/77-nested-animated-compositing.md.

Options:
  -o, --output <path>  Output SVG path (default: the config's "output", else stdout).
  -h, --help           Show this help.
`;

export function parseCompositeArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return { help: true as const };
  if (positionals.length === 0) throw new UsageError("composite: missing <config.json>");
  if (positionals.length > 1) throw new UsageError(`unexpected extra argument: ${positionals[1]}`);
  const configPath = resolve(positionals[0]);
  let raw: unknown;
  try {
    raw = JSON.parse(readInputFile(configPath, "config"));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`config ${configPath} is not valid JSON: ${errorMessage(e)}`);
  }
  const cfg = validateCompositeConfig(raw);
  const configDir = dirname(configPath);
  return { help: false as const, values, cfg, configDir };
}

export async function runComposite(argv: string[]): Promise<void> {
  const parsed = parseCompositeArgs(argv);
  if (parsed.help) {
    process.stdout.write(COMPOSITE_HELP);
    return;
  }
  await executeComposite(parsed);
}

export async function executeComposite(
  parsed: Exclude<ReturnType<typeof parseCompositeArgs>, { help: true }>,
): Promise<void> {
  const { values, cfg, configDir } = parsed;
  const browser = await launchChromium();
  try {
    const svg = await composeCompositeConfig(browser, cfg, configDir, (m) => process.stderr.write(m + "\n"));
    const written = writeSvgOutput(svg, values.output ?? cfg.output);
    if (written != null) process.stderr.write(`Wrote ${written} — ${(svg.length / 1024).toFixed(1)} KB\n`);
  } finally {
    await browser.close();
  }
}
