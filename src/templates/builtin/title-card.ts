/**
 * Built-in template: title-card (creative pack, docs/86 §1, DM-1531).
 *
 * A full-bleed opening card — an optional eyebrow/kicker, a large headline, and
 * an optional subtitle on a brand background — with a staggered fade-up (or pop)
 * reveal, then hold. The narrative "intro" building block. Authored as plain
 * HTML/CSS and animated with Domotion's intra-frame reveals (shared with the
 * other text cards), so it reflows, re-themes, honors format safe margins, and
 * composes with the brand kit.
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss, resolveCardTheme, staggeredReveal, revealEndMs } from "./text-card-common.js";
import type { SafeInset } from "../formats.js";

const ALIGN = ["center", "left"] as const;
const REVEAL = ["fade-up", "pop"] as const;
const THEMES = ["dark", "light"] as const;
const PADDING = 96; // generous default margin for a full-bleed card

export const titleCardParamsSchema = z.object({
  title: z.string().min(1).describe("The headline (required)."),
  subtitle: z.string().optional().describe("Optional line under the headline."),
  eyebrow: z.string().optional().describe("Optional small kicker/label above the headline."),
  align: z.enum(ALIGN).default("center").describe('Text alignment: "center" | "left".'),
  theme: z.enum(THEMES).default("dark").describe('Base theme when no explicit colors: "dark" | "light".'),
  background: z.string().optional().describe("Card background (CSS color or gradient). Defaults to the theme surface."),
  textColor: z.string().optional().describe("Headline/text color. Defaults to the theme foreground."),
  accent: z.string().default("#3b82f6").describe("Accent color for the eyebrow."),
  reveal: z.enum(REVEAL).default("fade-up").describe('Reveal motion: "fade-up" | "pop".'),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(3500).describe("Total on-screen time in ms."),
});

export type TitleCardParams = z.infer<typeof titleCardParamsSchema>;

/** Build the standalone HTML. Pure (no I/O) so it's unit-testable without a browser. */
export function buildTitleCardHtml(p: TitleCardParams, safeInset?: SafeInset): string {
  const t = resolveCardTheme(p.theme, { background: brandOrUndef(p.background), text: p.textColor });
  const items: string[] = [];
  if (p.eyebrow != null && p.eyebrow !== "") items.push(`<div class="tc-eyebrow">${escapeHtml(p.eyebrow)}</div>`);
  items.push(`<div class="tc-title">${escapeHtml(p.title)}</div>`);
  if (p.subtitle != null && p.subtitle !== "") items.push(`<div class="tc-sub">${escapeHtml(p.subtitle)}</div>`);
  const alignItems = p.align === "center" ? "center" : "flex-start";
  const textAlign = p.align;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body {
    background: ${t.background};
    color: ${t.text};
    display: flex; flex-direction: column; justify-content: center; align-items: ${alignItems};
    text-align: ${textAlign}; gap: 20px;
  }
  .tc-eyebrow { font-size: 26px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${p.accent}; }
  .tc-title { font-size: 84px; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em; max-width: 90%; }
  .tc-sub { font-size: 34px; font-weight: 500; line-height: 1.3; color: ${t.muted}; max-width: 80%; }
</style></head>
<body>
  ${items.join("\n  ")}
</body></html>`;
}

/** `undefined` for an empty/absent string, so a blank flag doesn't override the theme. */
function brandOrUndef(v: string | undefined): string | undefined {
  return v != null && v !== "" ? v : undefined;
}

export const titleCardTemplate: Template<TitleCardParams> = {
  name: "title-card",
  description: "Full-bleed intro card (eyebrow + headline + subtitle) with a staggered fade-up/pop reveal.",
  paramsSchema: titleCardParamsSchema,
  brandDefaults(brand: Brand): Partial<TitleCardParams> {
    return brandParams<TitleCardParams>({
      background: brandBackground(brand),
      textColor: brand.palette?.text,
      accent: brand.palette?.accent,
      fontFamily: brand.font?.family,
    });
  },
  async render(params: TitleCardParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const selectors: string[] = [];
    if (params.eyebrow != null && params.eyebrow !== "") selectors.push(".tc-eyebrow");
    selectors.push(".tc-title");
    if (params.subtitle != null && params.subtitle !== "") selectors.push(".tc-sub");
    const opts = { style: params.reveal } as const;
    // Ensure the hold outlasts the reveal so the card settles before it ends/loops.
    const holdMs = Math.max(params.holdMs, revealEndMs(selectors.length, opts) + 400);
    ctx.log(`template title-card: ${params.width}×${params.height}, "${params.title}"`);
    return runSingleFrameGenerator(ctx, {
      name: "title-card",
      html: buildTitleCardHtml(params, ctx.safeInset),
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations: staggeredReveal(selectors, opts),
    });
  },
};
