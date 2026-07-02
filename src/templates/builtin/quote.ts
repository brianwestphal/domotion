/**
 * Built-in template: quote / testimonial (creative pack, docs/86 §2, DM-1531).
 *
 * A pull-quote block with a large decorative quotation mark, an accent rule, and
 * an attribution row (optional avatar initial + name + role/handle). The mark,
 * quote, rule, and attribution stagger in (fade-up). Authored as HTML/CSS +
 * shared intra-frame reveals; themes, honors safe margins, and composes with the
 * brand kit.
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss, resolveCardTheme, staggeredReveal, revealEndMs } from "./text-card-common.js";
import type { SafeInset } from "../formats.js";

const THEMES = ["dark", "light"] as const;
const PADDING = 96;

export const quoteParamsSchema = z.object({
  quote: z.string().min(1).describe("The pull-quote text (required)."),
  author: z.string().optional().describe("Attribution name."),
  role: z.string().optional().describe("Author's role / handle (second attribution line)."),
  avatarInitial: z.string().optional().describe("A single initial shown in the avatar circle (defaults to the author's first letter)."),
  avatarColor: z.string().optional().describe("Avatar circle fill (defaults to the accent)."),
  accent: z.string().default("#3b82f6").describe("Accent color for the quote mark + rule + avatar."),
  theme: z.enum(THEMES).default("dark").describe('Base theme: "dark" | "light".'),
  background: z.string().optional().describe("Card background (CSS color or gradient). Defaults to the theme surface."),
  textColor: z.string().optional().describe("Quote text color. Defaults to the theme foreground."),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(3800).describe("Total on-screen time in ms."),
});

export type QuoteParams = z.infer<typeof quoteParamsSchema>;

function blank(v: string | undefined): string | undefined {
  return v != null && v !== "" ? v : undefined;
}

/** Build the standalone HTML. Pure — unit-testable without a browser. */
export function buildQuoteHtml(p: QuoteParams, safeInset?: SafeInset): string {
  const t = resolveCardTheme(p.theme, { background: blank(p.background), text: p.textColor });
  const avatarColor = p.avatarColor ?? p.accent;
  const initial = (blank(p.avatarInitial) ?? blank(p.author)?.[0] ?? "").toUpperCase();
  const hasAttribution = blank(p.author) != null || blank(p.role) != null;
  const attribution = hasAttribution
    ? `<div class="q-attr">
        ${initial !== "" ? `<div class="q-avatar">${escapeHtml(initial)}</div>` : ""}
        <div class="q-who">
          ${blank(p.author) != null ? `<div class="q-name">${escapeHtml(p.author!)}</div>` : ""}
          ${blank(p.role) != null ? `<div class="q-role">${escapeHtml(p.role!)}</div>` : ""}
        </div>
      </div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body {
    background: ${t.background};
    color: ${t.text};
    display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 28px;
  }
  .q-mark { font-size: 140px; line-height: 0.7; font-weight: 800; color: ${p.accent}; font-family: Georgia, 'Times New Roman', serif; height: 84px; }
  .q-text { font-size: 52px; font-weight: 600; line-height: 1.28; letter-spacing: -0.01em; max-width: 94%; }
  .q-rule { width: 96px; height: 5px; border-radius: 3px; background: ${p.accent}; }
  .q-attr { display: flex; align-items: center; gap: 18px; }
  .q-avatar { width: 64px; height: 64px; border-radius: 50%; background: ${avatarColor}; color: #fff; font-size: 28px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .q-name { font-size: 28px; font-weight: 700; }
  .q-role { font-size: 22px; font-weight: 500; color: ${t.muted}; margin-top: 2px; }
</style></head>
<body>
  <div class="q-mark">&ldquo;</div>
  <div class="q-text">${escapeHtml(p.quote)}</div>
  <div class="q-rule"></div>
  ${attribution}
</body></html>`;
}

export const quoteTemplate: Template<QuoteParams> = {
  name: "quote",
  description: "Pull-quote / testimonial card (decorative mark + accent rule + attribution) with a staggered reveal.",
  paramsSchema: quoteParamsSchema,
  brandDefaults(brand: Brand): Partial<QuoteParams> {
    return brandParams<QuoteParams>({
      accent: brand.palette?.primary,
      background: brandBackground(brand),
      textColor: brand.palette?.text,
      fontFamily: brand.font?.family,
    });
  },
  async render(params: QuoteParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const selectors = [".q-mark", ".q-text", ".q-rule"];
    if (blank(params.author) != null || blank(params.role) != null) selectors.push(".q-attr");
    const holdMs = Math.max(params.holdMs, revealEndMs(selectors.length) + 400);
    ctx.log(`template quote: ${params.width}×${params.height}, "${params.quote.slice(0, 40)}…"`);
    return runSingleFrameGenerator(ctx, {
      name: "quote",
      html: buildQuoteHtml(params, ctx.safeInset),
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations: staggeredReveal(selectors),
    });
  },
};
