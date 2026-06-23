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

import { resolve } from "node:path";
import { z } from "zod";
import { DEVICE_CHROMES, CHROME_THEMES, wrapInDeviceChrome } from "../../render/index.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

export const deviceMockupParamsSchema = z.object({
  input: z.string().min(1).describe("URL or local HTML file to capture (the screen content)."),
  device: z.enum(DEVICE_CHROMES).default("browser").describe('Bezel: "phone" | "browser" | "window".'),
  width: z.coerce.number().int().positive().default(960).describe("Inner screen width in px."),
  height: z.coerce.number().int().positive().default(600).describe("Inner screen height in px."),
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

export const deviceMockupTemplate: Template<DeviceMockupParams> = {
  name: "device-mockup",
  description: "Wrap a captured URL/page in a device bezel (phone, browser window, or app window).",
  paramsSchema: deviceMockupParamsSchema,
  async render(params: DeviceMockupParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    ctx.log(`template device-mockup: ${params.device} bezel around ${params.width}×${params.height} capture`);
    // Capture the page to a STATIC SVG (not the animate pipeline) — a static SVG
    // nests cleanly inside the bezel, whereas an animated SVG's keyframe `<style>`
    // + frame-group wrappers don't survive `wrapInDeviceChrome`'s re-nesting.
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
