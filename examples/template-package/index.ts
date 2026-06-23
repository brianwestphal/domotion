/**
 * Worked example of a THIRD-PARTY Domotion template package.
 *
 * `domotion-template-quote-card` — a generator template that animates a pull
 * quote rising + fading into place on a colored card. Copy this directory as the
 * starting point for your own `domotion-template-<name>` package. See
 * `docs/74-template-authoring.md` for the full guide.
 *
 * The only Domotion dependency is the published `domotion-svg` package, and only
 * for TYPES (`Template`, `TemplateRenderContext`, `TemplateOutput`) — the render
 * context is supplied by the host at runtime. `zod` describes + validates params.
 */

import { z } from "zod";
import type { Template, TemplateRenderContext, TemplateOutput } from "domotion-svg";

// 1. Describe the params with a zod schema. Use `z.coerce.*` for non-string
//    scalars so the CLI's string flags (and JSON values) both parse, and give
//    every param a `.describe()` (shown by `domotion template <name> --help`).
export const quoteCardParamsSchema = z.object({
  quote: z.string().min(1).describe("The pull-quote text (required)."),
  author: z.string().optional().describe("Attribution line under the quote."),
  accent: z.string().default("#6366f1").describe("Accent / card color (CSS color)."),
  color: z.string().default("#f8fafc").describe("Text color (CSS color)."),
  width: z.coerce.number().int().positive().default(1080).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(620).describe("Output height in px."),
  holdMs: z.coerce.number().int().positive().default(2600).describe("Total on-screen time in ms."),
});

export type QuoteCardParams = z.infer<typeof quoteCardParamsSchema>;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pure HTML builder — no I/O, so it's unit-testable without a browser. */
export function buildQuoteCardHtml(p: QuoteCardParams): string {
  const author = p.author != null && p.author !== ""
    ? `<div class="qc-author">— ${escapeHtml(p.author)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body {
    background: ${p.accent};
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 9%;
  }
  /* Two selectors so the move (wrapper) and the fade (inner) are two separate
     intra-frame animations that don't clobber each other. */
  .qc { display: flex; }
  .qc-inner { color: ${p.color}; max-width: 100%; }
  .qc-quote { font-size: 46px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; }
  .qc-author { margin-top: 22px; font-size: 22px; font-weight: 500; opacity: 0.85; }
</style></head>
<body>
  <div class="qc">
    <div class="qc-inner">
      <div class="qc-quote">“${escapeHtml(p.quote)}”</div>
      ${author}
    </div>
  </div>
</body></html>`;
}

export const quoteCardTemplate: Template<QuoteCardParams> = {
  name: "quote-card",
  description: "Animated pull-quote card that rises and fades into place.",
  paramsSchema: quoteCardParamsSchema,
  async render(params: QuoteCardParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    // A generator writes its HTML into the scratch `workDir`, then drives the
    // existing animate pipeline via `runAnimateConfig` — no new rendering code.
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const htmlPath = join(ctx.workDir, "quote-card.html");
    writeFileSync(htmlPath, buildQuoteCardHtml(params));
    ctx.log(`quote-card: ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "quote-card.html", // relative → resolves against ctx.workDir
          duration: params.holdMs,
          transition: { type: "cut", duration: 0 },
          // The two animation constraints: ONE animation per element (so the
          // wrapper carries the move and the inner carries the fade), and
          // origin-safe transforms only (a `translateY`, never an origin-(0,0)
          // scale/rotate — see the guide).
          animations: [
            { selector: ".qc-inner", property: "opacity", from: "0", to: "1", duration: 500, easing: "ease-out" },
            { selector: ".qc", property: "translateY", from: "0.6em", to: "0em", duration: 650, easing: "cubic-bezier(0.22,1,0.36,1)" },
          ],
        },
      ],
    });

    // `durationMs` lets a `template` frame in an `animate` config inherit this
    // template's play time (doc 73). A static decorator would omit it.
    return { svg, width: params.width, height: params.height, durationMs: params.holdMs };
  },
};

// 2. Export the template as the default export (or a named `template` export) so
//    `loadTemplate("quote-card")` finds it after `npm i domotion-template-quote-card`.
export default quoteCardTemplate;
