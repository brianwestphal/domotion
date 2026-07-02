/**
 * Built-in template: counter / countdown / number-ticker (creative pack,
 * docs/86 §4, DM-1532).
 *
 * Animate a number `from → to` (count-up, count-down, or a `timer` clock) as
 * rolling odometer digit reels — a pure `translateY` transform per digit column
 * (see `odometer.ts`), not per-frame text. Prefix/suffix, thousands grouping,
 * decimals, easing, and a per-digit stagger. Reduced-motion pins to the final
 * value (the reels rest at their end digit). Brand- and format-aware.
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss, resolveCardTheme } from "./text-card-common.js";
import { planOdometer, planTimer, buildOdometerMarkup, type OdometerPlan } from "./odometer.js";
import type { SafeInset } from "../formats.js";

const MODES = ["count", "timer"] as const;
const THEMES = ["dark", "light"] as const;
const PADDING = 96;

export const counterParamsSchema = z.object({
  to: z.coerce.number().describe("Target value (required). In `timer` mode this is seconds."),
  from: z.coerce.number().default(0).describe("Start value (seconds in `timer` mode). `to < from` counts down."),
  mode: z.enum(MODES).default("count").describe('"count" (a number) | "timer" (a M:SS / H:MM:SS clock).'),
  prefix: z.string().optional().describe("Text before the number (e.g. \"$\")."),
  suffix: z.string().optional().describe("Text after the number (e.g. \"+\" or \"%\")."),
  decimals: z.coerce.number().int().min(0).max(6).default(0).describe("Fixed decimal places (count mode)."),
  grouping: z.coerce.boolean().default(false).describe("Insert a thousands separator (count mode)."),
  durationMs: z.coerce.number().int().positive().default(1600).describe("Roll duration in ms."),
  staggerMs: z.coerce.number().int().min(0).default(60).describe("Per-digit stagger (ms), cascading left→right."),
  easing: z.string().default("cubic-bezier(0.22,1,0.36,1)").describe("CSS easing for the roll."),
  fontSize: z.coerce.number().int().positive().default(180).describe("Number font size in px."),
  theme: z.enum(THEMES).default("dark").describe('Base theme: "dark" | "light".'),
  background: z.string().optional().describe("Background (CSS color/gradient). Defaults to the theme surface."),
  color: z.string().optional().describe("Number color. Defaults to the theme foreground."),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(3200).describe("Total on-screen time in ms."),
});

export type CounterParams = z.infer<typeof counterParamsSchema>;

/** Plan the odometer for these params (count or timer). Exposed for tests. */
export function planCounter(p: CounterParams): OdometerPlan {
  return p.mode === "timer"
    ? planTimer(p.from, p.to)
    : planOdometer(p.from, p.to, { decimals: p.decimals, grouping: p.grouping });
}

/** Build the standalone HTML + animations. Pure — unit-testable without a browser. */
export function buildCounterHtml(p: CounterParams, safeInset?: SafeInset): { html: string; animations: ReturnType<typeof buildOdometerMarkup>["animations"] } {
  const t = resolveCardTheme(p.theme, { background: blank(p.background), text: p.color });
  const plan = planCounter(p);
  const od = buildOdometerMarkup(plan, { prefix: "od", cellPx: p.fontSize, durationMs: p.durationMs, easing: p.easing, staggerMs: p.staggerMs });
  const prefix = blank(p.prefix) != null ? `<span class="ct-affix">${escapeHtml(p.prefix!)}</span>` : "";
  const suffix = blank(p.suffix) != null ? `<span class="ct-affix">${escapeHtml(p.suffix!)}</span>` : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body { background: ${t.background}; color: ${t.text}; display: flex; align-items: center; justify-content: center; }
  .ct-num { display: inline-flex; align-items: baseline; font-size: ${p.fontSize}px; font-weight: 800; letter-spacing: -0.02em; }
  .ct-affix { font-weight: 700; }
  ${od.css}
</style></head>
<body>
  <div class="ct-num">${prefix}${od.html}${suffix}</div>
</body></html>`;
  return { html, animations: od.animations };
}

function blank(v: string | undefined): string | undefined {
  return v != null && v !== "" ? v : undefined;
}

export const counterTemplate: Template<CounterParams> = {
  name: "counter",
  description: "Odometer number-ticker: roll a value from→to (count up/down or a timer) with grouping, decimals, prefix/suffix.",
  paramsSchema: counterParamsSchema,
  brandDefaults(brand: Brand): Partial<CounterParams> {
    return brandParams<CounterParams>({
      color: brand.palette?.text,
      background: brandBackground(brand),
      fontFamily: brand.font?.family,
    });
  },
  async render(params: CounterParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const { html, animations } = buildCounterHtml(params, ctx.safeInset);
    const digitCols = animations.length;
    const rollEnd = params.durationMs + Math.max(0, digitCols - 1) * params.staggerMs;
    const holdMs = Math.max(params.holdMs, rollEnd + 500);
    ctx.log(`template counter: ${params.from}→${params.to} (${params.mode}), ${params.width}×${params.height}`);
    return runSingleFrameGenerator(ctx, {
      name: "counter",
      html,
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations,
    });
  },
};
