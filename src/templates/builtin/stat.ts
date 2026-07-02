/**
 * Built-in template: stat / KPI callout (creative pack, docs/86 §5, DM-1532).
 *
 * A large headline value + a label, with an optional delta/trend chip (e.g.
 * `▲ 8.1%`) that fades in AFTER the value settles. The value reuses the odometer
 * digit reels (`odometer.ts`); when `animateValue` is set it rolls up from 0,
 * otherwise it's shown static. Brand- and format-aware; reduced-motion pins to
 * the final value.
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Anims } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss, cardScaleFactor, fs, fsNum, fitOdometerCell, resolveCardTheme } from "./text-card-common.js";
import { planOdometer, buildOdometerMarkup } from "./odometer.js";
import type { SafeInset } from "../formats.js";

const THEMES = ["dark", "light"] as const;
const DELTA_DIRS = ["auto", "up", "down"] as const;
const PADDING = 96;

export const statParamsSchema = z.object({
  value: z.coerce.number().describe("The KPI value (required)."),
  label: z.string().optional().describe("Caption under the value."),
  delta: z.string().optional().describe("Trend chip text (e.g. \"8.1%\"). Shown with an arrow."),
  deltaDir: z.enum(DELTA_DIRS).default("auto").describe('Trend direction: "up" | "down" | "auto" (parse sign from delta).'),
  animateValue: z.coerce.boolean().default(true).describe("Roll the value up from 0 (else show it static)."),
  prefix: z.string().optional().describe("Text before the value (e.g. \"$\")."),
  suffix: z.string().optional().describe("Text after the value (e.g. \"%\" or \"K\")."),
  decimals: z.coerce.number().int().min(0).max(6).default(0).describe("Fixed decimal places."),
  grouping: z.coerce.boolean().default(true).describe("Insert a thousands separator."),
  durationMs: z.coerce.number().int().positive().default(1500).describe("Value roll duration in ms."),
  accent: z.string().default("#22c55e").describe("Accent for the up-trend chip (down uses a red)."),
  theme: z.enum(THEMES).default("dark").describe('Base theme: "dark" | "light".'),
  background: z.string().optional().describe("Background (CSS color/gradient). Defaults to the theme surface."),
  color: z.string().optional().describe("Value/text color. Defaults to the theme foreground."),
  fontSize: z.coerce.number().int().positive().default(200).describe("Value font size in px."),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(3400).describe("Total on-screen time in ms."),
});

export type StatParams = z.infer<typeof statParamsSchema>;

function blank(v: string | undefined): string | undefined {
  return v != null && v !== "" ? v : undefined;
}

/** Resolve the trend direction: explicit, else the sign of the delta text (a
 *  leading "-" or "▼" → down), defaulting to up. */
export function resolveDeltaDir(p: StatParams): "up" | "down" {
  if (p.deltaDir === "up" || p.deltaDir === "down") return p.deltaDir;
  const d = (p.delta ?? "").trim();
  return d.startsWith("-") || d.startsWith("▼") || d.startsWith("↓") ? "down" : "up";
}

/** Build the standalone HTML + animations. Pure — unit-testable without a browser. */
export function buildStatHtml(p: StatParams, safeInset?: SafeInset): { html: string; animations: Anims } {
  const t = resolveCardTheme(p.theme, { background: blank(p.background), text: p.color });
  // DM-1541: scale the value cell + label/delta type by the adaptive per-ratio
  // factor, then cap the value cell so the fixed-width (unwrappable) number fits
  // the safe content width — a big number on a narrow reel would otherwise
  // overflow. sf === 1 + no clamp with no format → byte-identical default output.
  const sf = cardScaleFactor(p.width, p.height, safeInset);
  const start = p.animateValue ? 0 : p.value;
  const plan = planOdometer(start, p.value, { decimals: p.decimals, grouping: p.grouping });
  const cols = plan.columns.length + (blank(p.prefix)?.length ?? 0) + (blank(p.suffix)?.length ?? 0);
  const availableW = safeInset != null
    ? p.width - Math.max(PADDING, safeInset.left) - Math.max(PADDING, safeInset.right)
    : 0; // 0 disables the clamp (no format → byte-identical)
  const cellPx = fitOdometerCell(fsNum(p.fontSize, sf), cols, availableW);
  const od = buildOdometerMarkup(plan, { prefix: "od", cellPx, durationMs: p.durationMs, easing: "cubic-bezier(0.22,1,0.36,1)", staggerMs: 60 });
  const prefix = blank(p.prefix) != null ? `<span class="st-affix">${escapeHtml(p.prefix!)}</span>` : "";
  const suffix = blank(p.suffix) != null ? `<span class="st-affix">${escapeHtml(p.suffix!)}</span>` : "";
  const label = blank(p.label) != null ? `<div class="st-label">${escapeHtml(p.label!)}</div>` : "";

  const animations: Anims = [...od.animations];
  let deltaMarkup = "";
  if (blank(p.delta) != null) {
    const dir = resolveDeltaDir(p);
    const arrow = dir === "up" ? "▲" : "▼";
    const chipColor = dir === "up" ? p.accent : "#ef4444";
    // strip a leading sign/arrow the author may have included; we supply the arrow.
    const deltaText = p.delta!.replace(/^[-+▲▼↑↓]\s*/, "");
    deltaMarkup = `<div class="st-delta"><span class="st-arrow">${arrow}</span> ${escapeHtml(deltaText)}</div>`;
    // The chip fades in after the value has settled.
    const rollEnd = p.durationMs + Math.max(0, od.animations.length - 1) * 60;
    animations.push({ selector: ".st-delta", property: "opacity", from: "0", to: "1", duration: 400, delay: rollEnd + 150, easing: "ease-out",
      fuse: [{ property: "translateY", from: "8px", to: "0px" }] });
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body { background: ${t.background}; color: ${t.text}; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${fs(18, sf)}; text-align: center; }
  .st-value { display: inline-flex; align-items: baseline; font-size: ${cellPx}px; font-weight: 800; letter-spacing: -0.02em; }
  .st-affix { font-weight: 700; }
  .st-label { font-size: ${fs(34, sf)}; font-weight: 500; color: ${t.muted}; }
  .st-delta { display: inline-flex; align-items: center; gap: ${fs(8, sf)}; font-size: ${fs(30, sf)}; font-weight: 700; color: ${blank(p.delta) != null && resolveDeltaDir(p) === "up" ? p.accent : "#ef4444"}; }
  .st-arrow { font-size: ${fs(26, sf)}; }
  ${od.css}
</style></head>
<body>
  <div class="st-value">${prefix}${od.html}${suffix}</div>
  ${label}
  ${deltaMarkup}
</body></html>`;
  return { html, animations };
}

export const statTemplate: Template<StatParams> = {
  name: "stat",
  description: "Big KPI callout: an odometer value + label + optional trend chip (▲/▼) that fades in after the roll.",
  paramsSchema: statParamsSchema,
  brandDefaults(brand: Brand): Partial<StatParams> {
    return brandParams<StatParams>({
      accent: brand.palette?.primary,
      color: brand.palette?.text,
      background: brandBackground(brand),
      fontFamily: brand.font?.family,
    });
  },
  async render(params: StatParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const { html, animations } = buildStatHtml(params, ctx.safeInset);
    const rollEnd = params.durationMs + 8 * 60; // generous: roll + stagger + chip
    const holdMs = Math.max(params.holdMs, rollEnd + 900);
    ctx.log(`template stat: ${params.value}${params.delta != null ? ` (${params.delta})` : ""}, ${params.width}×${params.height}`);
    return runSingleFrameGenerator(ctx, {
      name: "stat",
      html,
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations,
    });
  },
};
