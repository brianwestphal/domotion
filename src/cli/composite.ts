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
import { readFileSync, writeFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import { z } from "zod";
import { launchChromium } from "../capture/index.js";
import { castToAnimatedSvg } from "../terminal/index.js";
import { DEVICE_CHROMES, CHROME_THEMES, wrapInDeviceChrome } from "../render/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../animation/composite.js";
import { cliFail } from "./common.js";

const layerAnimationSchema = z.object({
  property: z.enum(["scale", "translateX", "translateY", "opacity", "transform", "clipScaleX", "clipScaleY"]),
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]),
  start: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  easing: z.string().optional(),
  transformOrigin: z.string().optional(),
});

const chromeSchema = z.object({
  device: z.enum(DEVICE_CHROMES).default("window"),
  label: z.string().optional(),
  theme: z.enum(CHROME_THEMES).default("dark"),
});

const layerSchema = z.object({
  // Exactly one source — enforced in the superRefine below.
  svg: z.string().optional().describe("Path to a pre-rendered SVG (static or animated)."),
  cast: z.string().optional().describe("Path to an asciinema v2 .cast (rendered as an animated terminal)."),
  template: z.string().optional().describe("A template name to render as the source."),
  params: z.record(z.string(), z.unknown()).optional().describe("Params for a `template` source."),
  term: z.record(z.string(), z.unknown()).optional().describe("Terminal options for a `cast` source."),
  // Period of an animated `svg` source (ms), when it can't be auto-detected.
  period: z.number().positive().optional(),
  chrome: chromeSchema.optional(),
  // Placement.
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  clip: z.boolean().optional(),
  clipRadius: z.number().nonnegative().optional(),
  // Timeline of the layer's own animation.
  start: z.number().nonnegative().optional(),
  mode: z.enum(["hold", "stretch", "loop"]).optional(),
  duration: z.number().positive().optional(),
  animations: z.array(layerAnimationSchema).optional(),
}).superRefine((l, ctx) => {
  const sources = [l.svg, l.cast, l.template].filter((s) => s != null);
  if (sources.length !== 1) {
    ctx.addIssue({ code: "custom", message: "each layer must have exactly one source: `svg`, `cast`, or `template`" });
  }
});

export const compositeConfigSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  output: z.string().optional(),
  background: z.string().optional(),
  duration: z.number().positive().optional(),
  layers: z.array(layerSchema).min(1),
});

export type CompositeConfig = z.infer<typeof compositeConfigSchema>;

export function validateCompositeConfig(raw: unknown): CompositeConfig {
  const parsed = compositeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`composite: ${first.path.join(".")}: ${first.message}`);
  }
  return parsed.data;
}

/** Read an animated SVG's play length (ms): `--scene-dur`, else the longest `animation:` duration. */
function detectPeriodMs(svg: string): number | undefined {
  const scene = /--scene-dur:\s*([\d.]+)s/i.exec(svg);
  if (scene != null) return Math.round(parseFloat(scene[1]) * 1000);
  let maxSec = 0;
  for (const m of svg.matchAll(/animation:\s*[^;}]*?\b([\d.]+)s\b/gi)) {
    const s = parseFloat(m[1]);
    if (s > maxSec) maxSec = s;
  }
  return maxSec > 0 ? Math.round(maxSec * 1000) : undefined;
}

function svgSize(svg: string): { w: number; h: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const w = /\bwidth="([\d.]+)(px)?"/i.exec(open);
  const h = /\bheight="([\d.]+)(px)?"/i.exec(open);
  if (w != null && h != null) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i.exec(open);
  if (vb != null) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return null;
}

/** Render one layer's source to an animated SVG + intrinsic size + period. */
async function renderLayerSource(
  layer: z.infer<typeof layerSchema>,
  browser: Browser,
  configDir: string,
  log: (m: string) => void,
): Promise<{ svg: string; w: number; h: number; periodMs?: number }> {
  if (layer.cast != null) {
    const castText = readFileSync(resolve(configDir, layer.cast), "utf8");
    const { svg, width, height, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
      ...(layer.term ?? {}),
      log: (m) => log(`  ${m}`),
    });
    return { svg, w: width, h: height, periodMs: totalDurationMs };
  }
  if (layer.template != null) {
    const { loadTemplate } = await import("../templates/registry.js");
    const { renderTemplateToSvg } = await import("../templates/render.js");
    const template = await loadTemplate(layer.template);
    const out = await renderTemplateToSvg(template, layer.params ?? {}, { browser, log: (m) => log(`  ${m}`) });
    return { svg: out.svg, w: out.width, h: out.height, periodMs: out.durationMs ?? undefined };
  }
  // svg source: read a pre-rendered (static or animated) SVG.
  const svg = readFileSync(resolve(configDir, layer.svg!), "utf8");
  const size = svgSize(svg) ?? { w: layer.width ?? 0, h: layer.height ?? 0 };
  return { svg, w: size.w, h: size.h, periodMs: layer.period ?? detectPeriodMs(svg) };
}

/** Render + composite a validated config into one animated SVG. */
export async function composeCompositeConfig(
  browser: Browser,
  cfg: CompositeConfig,
  configDir: string,
  log: (m: string) => void = () => {},
): Promise<string> {
  const composeLayers: CompositeLayer[] = [];
  for (let i = 0; i < cfg.layers.length; i++) {
    const layer = cfg.layers[i];
    const kind = layer.cast != null ? "cast" : layer.template != null ? `template "${layer.template}"` : "svg";
    log(`Layer ${i + 1}/${cfg.layers.length}: ${kind}…`);
    let { svg, w, h, periodMs } = await renderLayerSource(layer, browser, configDir, log);
    if (layer.chrome != null) {
      const framed = wrapInDeviceChrome(svg, layer.chrome.device, w, h, { label: layer.chrome.label, theme: layer.chrome.theme });
      svg = framed.svg; w = framed.width; h = framed.height;
    }
    composeLayers.push({
      svg, periodMs, contentWidth: w, contentHeight: h,
      x: layer.x, y: layer.y,
      width: layer.width ?? w, height: layer.height ?? h,
      clip: layer.clip, clipRadius: layer.clipRadius,
      start: layer.start, mode: layer.mode, duration: layer.duration,
      animations: layer.animations,
    });
  }
  const result = composeAnimatedLayers(composeLayers, {
    width: cfg.width, height: cfg.height, background: cfg.background, durationMs: cfg.duration,
  });
  log(`Composited ${cfg.layers.length} layers — ${result.width}×${result.height}px, ${(result.durationMs / 1000).toFixed(1)}s loop`);
  return result.svg;
}

const HELP = `domotion composite — stack layers (cast / template / svg) into one animated SVG

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

export async function runComposite(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    (values.help ? process.stdout : process.stderr).write(HELP);
    if (!values.help) process.exit(2);
    return;
  }
  const configPath = resolve(positionals[0]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    cliFail("domotion composite", `could not read config ${configPath}: ${(e as Error).message}`, "usage");
    return;
  }
  const cfg = validateCompositeConfig(raw);
  const configDir = dirname(configPath);
  const browser = await launchChromium();
  try {
    const svg = await composeCompositeConfig(browser, cfg, configDir, (m) => process.stderr.write(m + "\n"));
    const outPath = values.output ?? cfg.output;
    if (outPath == null) {
      process.stdout.write(svg);
    } else {
      writeFileSync(resolve(outPath), svg);
      process.stderr.write(`Wrote ${resolve(outPath)} — ${(svg.length / 1024).toFixed(1)} KB\n`);
    }
  } finally {
    await browser.close();
  }
}
