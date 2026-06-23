/**
 * Built-in template: kinetic-text (DM-1277, doc 72).
 *
 * Kinetic typography — a headline string is expanded at author time into per-word
 * (or per-character) units, each revealed with its own staggered one-shot
 * animation, then held assembled. This is the clearest showcase of the template
 * thesis from doc 70: the "split text → synthesize N staggered keyframes" work is
 * pure pre-processing that runs once; the emitted SVG just replays.
 *
 * Same two animation constraints as `background-loop` (doc 71): only one
 * intra-frame animation applies per captured element, and SVG transforms are
 * origin-(0,0). So each animated unit is a `.kt-w-N` transform-wrapper (rise /
 * slide via origin-safe translateX/translateY) around a `.kt-wi-N` opacity-inner
 * (fade). The reveal is one-shot (no repeat): units hold `from` until their
 * staggered turn, animate in, then hold `to` so the headline stays assembled.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

const VARIANTS = ["rise", "slide", "fade"] as const;
export type KineticVariant = (typeof VARIANTS)[number];

export const kineticTextParamsSchema = z.object({
  text: z.string().min(1).max(200).describe("The headline to animate (required)."),
  variant: z.enum(VARIANTS).default("rise").describe('Reveal style: "rise" | "slide" | "fade".'),
  by: z.enum(["word", "char"]).default("word").describe("Animate per word or per character."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  fontSize: z.coerce.number().int().positive().default(88).describe("Font size in px."),
  fontWeight: z.coerce.number().int().default(800).describe("Font weight."),
  color: z.string().default("#f5f7fa").describe("Text color (CSS color)."),
  background: z.string().default("#0b1020").describe('Frame background (CSS color or "transparent").'),
  align: z.enum(["center", "left"]).default("center").describe("Text alignment."),
  fontFamily: z
    .string()
    .default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif")
    .describe("CSS font-family stack."),
  staggerMs: z.coerce.number().int().positive().default(90).describe("Delay between units in ms."),
  revealMs: z.coerce.number().int().positive().default(600).describe("Per-unit reveal duration in ms."),
  holdMs: z.coerce.number().int().positive().default(1600).describe("Hold time after full reveal in ms."),
});

export type KineticTextParams = z.infer<typeof kineticTextParamsSchema>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One animated unit: a word, or a single character. `index` is its global
 *  stagger position; `word`/`char` tells the HTML how to group it. */
export interface KineticUnit {
  index: number;
  text: string;
}

/** Words, each carrying its animated units (one unit per word, or one per char).
 *  Pure — splits on whitespace, drops empty tokens, assigns global indices. */
export function planUnits(p: KineticTextParams): { words: KineticUnit[][]; count: number } {
  const words = p.text.trim().split(/\s+/).filter((w) => w.length > 0);
  const out: KineticUnit[][] = [];
  let index = 0;
  for (const word of words) {
    if (p.by === "char") {
      out.push([...word].map((ch) => ({ index: index++, text: ch })));
    } else {
      out.push([{ index: index++, text: word }]);
    }
  }
  return { words: out, count: index };
}

/** Standalone HTML for the headline (pure — unit-testable without a browser). */
export function buildKineticHtml(p: KineticTextParams, plan: { words: KineticUnit[][] }): string {
  const unitSpan = (u: KineticUnit): string =>
    `<span class="kt-w kt-w-${u.index}"><span class="kt-wi kt-wi-${u.index}">${escapeHtml(u.text)}</span></span>`;
  // Word mode: each word is one unit, separated by spaces. Char mode: wrap each
  // word's char-units in a nowrap group so words never break mid-word.
  const wordsMarkup = plan.words
    .map((units) =>
      p.by === "char"
        ? `<span class="kt-word">${units.map(unitSpan).join("")}</span>`
        : unitSpan(units[0]),
    )
    .join(" ");
  const justify = p.align === "center" ? "center" : "flex-start";
  const textAlign = p.align;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body {
    background: ${p.background};
    font-family: ${p.fontFamily};
    display: flex; align-items: center; justify-content: ${justify};
    padding: 8% 7%;
  }
  .kt-headline {
    font-size: ${p.fontSize}px; font-weight: ${p.fontWeight}; line-height: 1.1;
    color: ${p.color}; letter-spacing: -0.02em; text-align: ${textAlign};
    max-width: 100%;
  }
  /* inline-block so per-unit transforms apply; the wrapper carries the move, the
     inner carries the fade (two selectors → two non-colliding animations). */
  .kt-w, .kt-wi { display: inline-block; }
  .kt-word { display: inline-block; white-space: nowrap; }
</style></head>
<body>
  <h1 class="kt-headline">${wordsMarkup}</h1>
</body></html>`;
}

/** Per-unit staggered one-shot animations. `rise`/`slide` add a transform on the
 *  wrapper; every variant fades the inner. Pure. */
export function buildKineticAnimations(
  p: KineticTextParams,
  plan: { count: number; words: KineticUnit[][] },
): NonNullable<AnimateConfig["frames"][number]["animations"]> {
  const anims: NonNullable<AnimateConfig["frames"][number]["animations"]> = [];
  for (const units of plan.words) {
    for (const u of units) {
      const delay = u.index * p.staggerMs;
      // Fade in (all variants), on the inner span.
      anims.push({
        selector: `.kt-wi-${u.index}`,
        property: "opacity",
        from: "0",
        to: "1",
        duration: p.revealMs,
        delay,
        easing: "ease-out",
      });
      // Move in (rise / slide), on the wrapper. `fade` has no transform.
      if (p.variant === "rise") {
        anims.push({ selector: `.kt-w-${u.index}`, property: "translateY", from: "0.55em", to: "0em", duration: p.revealMs, delay, easing: "cubic-bezier(0.22,1,0.36,1)" });
      } else if (p.variant === "slide") {
        anims.push({ selector: `.kt-w-${u.index}`, property: "translateX", from: "-0.6em", to: "0em", duration: p.revealMs, delay, easing: "cubic-bezier(0.22,1,0.36,1)" });
      }
    }
  }
  return anims;
}

/** Total on-screen time: the last unit's reveal end + the hold. */
export function kineticDurationMs(p: KineticTextParams, count: number): number {
  const lastStart = Math.max(0, count - 1) * p.staggerMs;
  return lastStart + p.revealMs + p.holdMs;
}

export const kineticTextTemplate: Template<KineticTextParams> = {
  name: "kinetic-text",
  description: "Kinetic typography — reveal a headline word-by-word or char-by-char (rise / slide / fade).",
  paramsSchema: kineticTextParamsSchema,
  async render(params: KineticTextParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const plan = planUnits(params);
    const htmlPath = join(ctx.workDir, "kinetic-text.html");
    writeFileSync(htmlPath, buildKineticHtml(params, plan));
    ctx.log(`template kinetic-text: ${params.variant}/${params.by}, ${plan.count} units, "${params.text}"`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "kinetic-text.html",
          duration: kineticDurationMs(params, plan.count),
          transition: { type: "cut", duration: 0 },
          animations: buildKineticAnimations(params, plan),
        },
      ],
    });
    return { svg, width: params.width, height: params.height };
  },
};
