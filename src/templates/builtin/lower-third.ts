/**
 * Built-in template: lower-third (DM-1276, doc 70).
 *
 * A broadcast-style lower-third banner — a title line, an optional subtitle, and
 * an accent bar — that slides + fades into the corner of the frame. The classic
 * "text & typography" template and the highest value-to-effort starter: it's
 * authored as plain HTML/CSS (so it reflows, re-themes, and uses real web fonts)
 * and animated with Domotion's intra-frame `animations` (opacity + translateY),
 * not baked keyframes.
 *
 * Transparent background by default so the SVG overlays whatever it's placed on.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

const POSITIONS = ["bottom-left", "bottom-center", "bottom-right", "top-left", "top-center", "top-right"] as const;
const THEMES = ["dark", "light"] as const;

export const lowerThirdParamsSchema = z.object({
  title: z.string().min(1).describe("Main title line (required)."),
  subtitle: z.string().optional().describe("Optional second line under the title."),
  accent: z.string().default("#3b82f6").describe("Accent color (CSS color) for the bar."),
  theme: z.enum(THEMES).default("dark").describe('Text/panel theme: "dark" | "light".'),
  position: z.enum(POSITIONS).default("bottom-left").describe("Corner/edge the banner anchors to."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(3000).describe("Total on-screen time in ms."),
  background: z.string().default("transparent").describe('Frame background (CSS color or "transparent").'),
  fontFamily: z
    .string()
    .default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif")
    .describe("CSS font-family stack for the banner text."),
});

export type LowerThirdParams = z.infer<typeof lowerThirdParamsSchema>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Flex alignment for the chosen corner. */
function alignmentFor(position: LowerThirdParams["position"]): { justify: string; align: string } {
  const [v, h] = position.split("-");
  const align = v === "top" ? "flex-start" : "flex-end";
  const justify = h === "center" ? "center" : h === "right" ? "flex-end" : "flex-start";
  return { justify, align };
}

/**
 * Build the standalone HTML for the banner. Pure function (no I/O) so it's unit-
 * testable without a browser. The `.lt` wrapper fades (opacity) and the inner
 * `.lt-panel` slides (translateY) — two distinct selectors so the intra-frame
 * animations target different elements and never collide on one animId.
 */
export function buildLowerThirdHtml(p: LowerThirdParams): string {
  const { justify, align } = alignmentFor(p.position);
  const isDark = p.theme === "dark";
  const panelBg = isDark ? "rgba(17,19,24,0.92)" : "rgba(255,255,255,0.94)";
  const titleColor = isDark ? "#f5f7fa" : "#0d1117";
  const subColor = isDark ? "#aeb6c2" : "#57606a";
  const shadow = isDark ? "0 6px 24px rgba(0,0,0,0.45)" : "0 6px 24px rgba(0,0,0,0.18)";
  const subtitle = p.subtitle != null && p.subtitle !== ""
    ? `<div class="lt-sub">${escapeHtml(p.subtitle)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body {
    background: ${p.background};
    font-family: ${p.fontFamily};
    display: flex;
    justify-content: ${justify};
    align-items: ${align};
    padding: 48px;
  }
  .lt { display: flex; }
  .lt-panel {
    display: flex; align-items: stretch;
    background: ${panelBg};
    border-radius: 10px;
    box-shadow: ${shadow};
    overflow: hidden;
    backdrop-filter: blur(2px);
  }
  .lt-accent { width: 6px; background: ${p.accent}; flex: none; }
  .lt-text { padding: 14px 22px 16px; }
  .lt-title {
    font-size: 30px; font-weight: 700; line-height: 1.15; color: ${titleColor};
    letter-spacing: -0.01em; white-space: nowrap;
  }
  .lt-sub { margin-top: 4px; font-size: 17px; font-weight: 500; color: ${subColor}; white-space: nowrap; }
</style></head>
<body>
  <div class="lt">
    <div class="lt-panel">
      <div class="lt-accent"></div>
      <div class="lt-text">
        <div class="lt-title">${escapeHtml(p.title)}</div>
        ${subtitle}
      </div>
    </div>
  </div>
</body></html>`;
}

export const lowerThirdTemplate: Template<LowerThirdParams> = {
  name: "lower-third",
  description: "Broadcast-style lower-third banner (title + subtitle + accent) that slides and fades in.",
  paramsSchema: lowerThirdParamsSchema,
  async render(params: LowerThirdParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const htmlPath = join(ctx.workDir, "lower-third.html");
    writeFileSync(htmlPath, buildLowerThirdHtml(params));
    ctx.log(`template lower-third: ${params.width}×${params.height}, "${params.title}"`);

    // A slide-down distance that reads as "rising into place" from below.
    const rise = params.position.startsWith("top") ? "-24px" : "24px";
    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "lower-third.html",
          duration: params.holdMs,
          transition: { type: "cut", duration: 0 },
          animations: [
            { selector: ".lt", property: "opacity", from: "0", to: "1", duration: 450, easing: "ease-out" },
            { selector: ".lt-panel", property: "translateY", from: rise, to: "0px", duration: 600, easing: "cubic-bezier(0.22,1,0.36,1)" },
          ],
        },
      ],
    });
    // The banner fades + slides in once and holds; `holdMs` is its play time.
    return { svg, width: params.width, height: params.height, durationMs: params.holdMs };
  },
};
