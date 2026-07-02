/**
 * Built-in template: cta / end-card (creative pack, docs/86 §7, DM-1531).
 *
 * A closing card: an optional logo, a headline, a call-to-action button (which
 * can pulse), and optional social handles / URL. Elements stagger in; the button
 * pulse rides a SEPARATE inner element (an infinite scale) from the button's
 * enter reveal, so the one-animation-per-property rule holds. Authored as
 * HTML/CSS + shared reveals; themes, honors safe margins, composes with the brand
 * kit. The brand kit's `logo` token maps to the `logo` param (DM-1539), so
 * `--brand acme.json` (with a `logo`) auto-fills the end-card's logo.
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Anims } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss, cardScaleFactor, fs, resolveCardTheme, staggeredReveal, revealEndMs } from "./text-card-common.js";
import type { SafeInset } from "../formats.js";

const THEMES = ["dark", "light"] as const;
const PADDING = 96;

/** A comma-separated string OR an array of handle strings. */
const handlesSchema = z.union([
  z.string().transform((s) => s.split(",").map((h) => h.trim()).filter((h) => h !== "")),
  z.array(z.string()),
]);

export const ctaParamsSchema = z.object({
  cta: z.string().min(1).describe("Call-to-action button label (required)."),
  headline: z.string().optional().describe("Headline above the button."),
  ctaColor: z.string().default("#3b82f6").describe("CTA button fill color."),
  logo: z.string().optional().describe("Optional logo image (URL or absolute path) shown above the headline."),
  handles: handlesSchema.optional().describe("Social handles / links (comma-separated or array), shown as a row."),
  url: z.string().optional().describe("A URL line under the handles."),
  pulse: z.coerce.boolean().default(true).describe("Whether the CTA button gently pulses."),
  theme: z.enum(THEMES).default("dark").describe('Base theme: "dark" | "light".'),
  background: z.string().optional().describe("Card background (CSS color or gradient). Defaults to the theme surface."),
  textColor: z.string().optional().describe("Headline/text color. Defaults to the theme foreground."),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(4000).describe("Total on-screen time in ms."),
});

export type CtaParams = z.infer<typeof ctaParamsSchema>;

function blank(v: string | undefined): string | undefined {
  return v != null && v !== "" ? v : undefined;
}

/** Build the standalone HTML. Pure — unit-testable without a browser. */
export function buildCtaHtml(p: CtaParams, safeInset?: SafeInset): string {
  const t = resolveCardTheme(p.theme, { background: blank(p.background), text: p.textColor });
  const handles = p.handles ?? [];
  const logoMarkup = blank(p.logo) != null ? `<img class="cta-logo" src="${escapeHtml(p.logo!)}" alt="">` : "";
  const headlineMarkup = blank(p.headline) != null ? `<div class="cta-headline">${escapeHtml(p.headline!)}</div>` : "";
  const handlesMarkup = handles.length > 0
    ? `<div class="cta-handles">${handles.map((h) => `<span>${escapeHtml(h)}</span>`).join('<span class="cta-dot">·</span>')}</div>`
    : "";
  const urlMarkup = blank(p.url) != null ? `<div class="cta-url">${escapeHtml(p.url!)}</div>` : "";
  // DM-1541: scale authored (landscape-tuned) type + spacing by the adaptive
  // per-ratio factor (sf === 1 with no format → byte-identical default output).
  const sf = cardScaleFactor(p.width, p.height, safeInset);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body {
    background: ${t.background};
    color: ${t.text};
    display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: ${fs(30, sf)};
  }
  .cta-logo { max-height: ${fs(96, sf)}; max-width: 60%; object-fit: contain; }
  .cta-headline { font-size: ${fs(64, sf)}; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; max-width: 90%; }
  .cta-btn-wrap { }
  .cta-btn {
    display: inline-block; background: ${p.ctaColor}; color: #fff;
    font-size: ${fs(34, sf)}; font-weight: 700; padding: ${fs(20, sf)} ${fs(44, sf)}; border-radius: 999px;
  }
  .cta-handles { display: flex; align-items: center; gap: ${fs(14, sf)}; font-size: ${fs(26, sf)}; font-weight: 500; color: ${t.muted}; }
  .cta-dot { opacity: 0.6; }
  .cta-url { font-size: ${fs(24, sf)}; font-weight: 500; color: ${t.muted}; }
</style></head>
<body>
  ${logoMarkup}
  ${headlineMarkup}
  <div class="cta-btn-wrap"><div class="cta-btn">${escapeHtml(p.cta)}</div></div>
  ${handlesMarkup}
  ${urlMarkup}
</body></html>`;
}

/** Reveal (staggered) + optional infinite button pulse on the inner `.cta-btn`. */
export function buildCtaAnimations(p: CtaParams, selectors: string[]): Anims {
  const anims = staggeredReveal(selectors);
  if (p.pulse) {
    // The pulse lives on the INNER `.cta-btn` (scale), separate from `.cta-btn-wrap`'s
    // enter reveal — one animation per property per element. It loops forever.
    anims.push({
      selector: ".cta-btn", property: "scale", from: "1", to: "1.06", duration: 900,
      easing: "ease-in-out", transformOrigin: "center", repeat: "infinite", alternate: true,
    });
  }
  return anims;
}

export const ctaTemplate: Template<CtaParams> = {
  name: "cta",
  description: "Closing end-card (optional logo + headline + call-to-action button [optional pulse] + handles/URL) with a staggered reveal.",
  paramsSchema: ctaParamsSchema,
  brandDefaults(brand: Brand): Partial<CtaParams> {
    return brandParams<CtaParams>({
      ctaColor: brand.palette?.primary,
      background: brandBackground(brand),
      textColor: brand.palette?.text,
      fontFamily: brand.font?.family,
      // DM-1539: the brand's logo asset fills the end-card's logo slot (resolved
      // to an absolute path / URL by `loadBrand`). The first built-in to consume
      // `brand.logo`.
      logo: brand.logo,
    });
  },
  async render(params: CtaParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const selectors: string[] = [];
    if (blank(params.logo) != null) selectors.push(".cta-logo");
    if (blank(params.headline) != null) selectors.push(".cta-headline");
    selectors.push(".cta-btn-wrap");
    if ((params.handles ?? []).length > 0) selectors.push(".cta-handles");
    if (blank(params.url) != null) selectors.push(".cta-url");
    const holdMs = Math.max(params.holdMs, revealEndMs(selectors.length) + 600);
    ctx.log(`template cta: ${params.width}×${params.height}, "${params.cta}"`);
    return runSingleFrameGenerator(ctx, {
      name: "cta",
      html: buildCtaHtml(params, ctx.safeInset),
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations: buildCtaAnimations(params, selectors),
    });
  },
};
