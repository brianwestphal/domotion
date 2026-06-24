/**
 * Built-in template: device-mockup (DM-1276, doc 70).
 *
 * The "migration proof" for the template contract: it re-expresses the shipped
 * `capture --chrome` flag (doc 65) as a template. Unlike lower-third (a
 * generator), this is a DECORATOR — it captures a user-supplied input (URL / HTML
 * file) through the existing pipeline, then wraps the rendered SVG in a device
 * bezel via the shared `wrapInDeviceChrome` (which stays the single source of
 * truth, so the flag and the template can't diverge). Proving the contract
 * handles both a generator and a decorator is the whole point of the spike.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DEVICE_CHROMES, CHROME_THEMES, wrapInDeviceChrome } from "../../render/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../../animation/embed-namespace.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

export const deviceMockupParamsSchema = z.object({
  input: z.string().optional().describe("URL or local HTML file to capture (the screen content). Omit when using screenSvg."),
  // DM-1323: an already-rendered (possibly ANIMATED) SVG to nest as the screen,
  // instead of capturing `input` to a static frame. The bezel nests it with its
  // animation intact (the screen's global names are namespaced first so they
  // can't collide). Takes precedence over `input`.
  screenSvg: z.string().optional().describe("Path to a pre-rendered SVG (e.g. a cast/scroll/animate output) to nest as the screen, animation preserved."),
  screenDurationMs: z.coerce.number().int().positive().optional().describe("Play length (ms) of the animated screenSvg, so a `template` frame can size it. Auto-detected from --scene-dur when omitted."),
  device: z.enum(DEVICE_CHROMES).default("browser").describe('Bezel: "phone" | "browser" | "window".'),
  width: z.coerce.number().int().positive().default(960).describe("Inner screen width in px (ignored when screenSvg sets its own size)."),
  height: z.coerce.number().int().positive().default(600).describe("Inner screen height in px (ignored when screenSvg sets its own size)."),
  label: z.string().optional().describe("Chrome-bar text (browser URL / window title; ignored by phone)."),
  theme: z.enum(CHROME_THEMES).default("dark").describe('Bezel theme for browser/window: "dark" | "light".'),
  mobile: z.coerce.boolean().default(false).describe("Emulate a mobile device for the capture (use with phone)."),
  colorScheme: z.enum(["light", "dark", "no-preference"]).optional().describe("prefers-color-scheme for the page."),
  selector: z.string().default("body").describe("Element selector to capture."),
});

export type DeviceMockupParams = z.infer<typeof deviceMockupParamsSchema>;

/** Resolve an input that's a URL (left as-is) or a local path (made absolute so
 *  it doesn't resolve against the template's temp workDir). */
function resolveInput(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  return resolve(input);
}

/** Best-effort intrinsic size of an SVG document (width/height attrs, else viewBox). */
function svgSize(svg: string): { w: number; h: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const w = /\bwidth="([\d.]+)(px)?"/i.exec(open);
  const h = /\bheight="([\d.]+)(px)?"/i.exec(open);
  if (w != null && h != null) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /\bviewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i.exec(open);
  if (vb != null) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return null;
}

/**
 * Read an animated SVG's own play length (ms) — from its `--scene-dur` custom
 * property when present (full-mode casts / animate output), else the longest
 * `animation:` shorthand duration (incremental-mode casts carry no `--scene-dur`
 * but every line/cursor track runs at the scene period). `undefined` if neither
 * is found (a static SVG).
 */
function sceneDurationMs(svg: string): number | undefined {
  const scene = /--scene-dur:\s*([\d.]+)s/i.exec(svg);
  if (scene != null) return Math.round(parseFloat(scene[1]) * 1000);
  let maxSec = 0;
  for (const m of svg.matchAll(/animation:\s*[^;}]*?\b([\d.]+)s\b/gi)) {
    const s = parseFloat(m[1]);
    if (s > maxSec) maxSec = s;
  }
  return maxSec > 0 ? Math.round(maxSec * 1000) : undefined;
}

export const deviceMockupTemplate: Template<DeviceMockupParams> = {
  name: "device-mockup",
  description: "Wrap a captured URL/page (or a pre-rendered animated SVG) in a device bezel (phone, browser window, or app window).",
  paramsSchema: deviceMockupParamsSchema,
  async render(params: DeviceMockupParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    // DM-1323: nest a pre-rendered, possibly ANIMATED screen instead of capturing
    // to static. `wrapInDeviceChrome` already nests the screen as a child <svg>
    // (it doesn't re-render), so the screen's animation survives — the only thing
    // needed is to namespace the screen's document-global names so they can't
    // collide once nested. Reports the screen's play length so a `template` frame
    // (doc 73) re-syncs it.
    if (params.screenSvg != null && params.screenSvg !== "") {
      const screen = readFileSync(resolve(params.screenSvg), "utf8");
      const size = svgSize(screen) ?? { w: params.width, h: params.height };
      const namespaced = namespaceEmbeddedAnimatedSvg(screen, "dms_");
      ctx.log(`template device-mockup: ${params.device} bezel around an animated ${size.w}×${size.h} screen (${params.screenSvg})`);
      const framed = wrapInDeviceChrome(namespaced, params.device, size.w, size.h, { label: params.label, theme: params.theme });
      const durationMs = params.screenDurationMs ?? sceneDurationMs(screen);
      return { svg: framed.svg, width: framed.width, height: framed.height, durationMs };
    }

    if (params.input == null || params.input === "") {
      throw new Error('device-mockup: provide either "input" (a page to capture) or "screenSvg" (a pre-rendered SVG to nest).');
    }
    ctx.log(`template device-mockup: ${params.device} bezel around ${params.width}×${params.height} capture`);
    // Capture the page to a STATIC SVG (not the animate pipeline) — a static SVG
    // nests cleanly inside the bezel. For an ANIMATED screen, use `screenSvg`.
    const capture = await ctx.captureToSvg({
      input: resolveInput(params.input),
      width: params.width,
      height: params.height,
      selector: params.selector,
      mobile: params.mobile,
      colorScheme: params.colorScheme,
    });

    const framed = wrapInDeviceChrome(capture.svg, params.device, params.width, params.height, {
      label: params.label,
      theme: params.theme,
    });
    return { svg: framed.svg, width: framed.width, height: framed.height };
  },
};
