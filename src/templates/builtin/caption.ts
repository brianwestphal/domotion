/**
 * Built-in template: caption / subtitle strip (creative pack, docs/86 §3, DM-1531).
 *
 * A single lightweight caption line for PAIRING OVER other content — transparent
 * background by default, anchored bottom- (or top-) center within the safe
 * margins, with an explicit in AND out (fade or slide). Distinct from
 * `lower-third` (a titled panel with an accent bar); `caption` is the subtitle
 * you composite over a captured demo/video.
 *
 * The in-hold-out lives on TWO nested wrappers so it works within a single frame:
 * `.cap-in` animates the entrance at the start; `.cap-out` animates the exit near
 * the end. Two elements each animating opacity independently compose to
 * in → hold → out without needing a three-stop keyframe (which the intra-frame
 * from→to schema can't express).
 */

import { z } from "zod";
import { runSingleFrameGenerator } from "../run-single-frame.js";
import type { Anims } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, type Brand } from "../brand.js";
import { escapeHtml } from "../../utils/escapeHtml.js";
import { CARD_FONT_STACK, cardHeadCss } from "./text-card-common.js";
import type { SafeInset } from "../formats.js";

const POSITIONS = ["bottom-center", "top-center", "center"] as const;
const MOTION = ["fade", "slide"] as const;
const PADDING = 64;

export const captionParamsSchema = z.object({
  text: z.string().min(1).describe("The caption line (required)."),
  position: z.enum(POSITIONS).default("bottom-center").describe("Where the caption sits within the safe area."),
  motion: z.enum(MOTION).default("fade").describe('Enter/exit motion: "fade" | "slide" (slide rises in / drops out).'),
  maxWidthPct: z.coerce.number().min(10).max(100).default(80).describe("Max caption width as a percent of the canvas."),
  bgOpacity: z.coerce.number().min(0).max(1).default(0).describe("Opacity of the scrim behind the text (0 = transparent)."),
  textColor: z.string().default("#ffffff").describe("Caption text color."),
  fontFamily: z.string().default(CARD_FONT_STACK).describe("CSS font-family stack."),
  inMs: z.coerce.number().int().positive().default(450).describe("Enter duration in ms."),
  outMs: z.coerce.number().int().positive().default(450).describe("Exit duration in ms."),
  holdMs: z.coerce.number().int().positive().default(2600).describe("Total on-screen time in ms (enter + hold + exit)."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
});

export type CaptionParams = z.infer<typeof captionParamsSchema>;

/** Flex anchor for the chosen position. */
function anchorFor(position: CaptionParams["position"]): string {
  if (position === "top-center") return "flex-start";
  if (position === "center") return "center";
  return "flex-end";
}

/** Build the standalone HTML. Pure — unit-testable without a browser. */
export function buildCaptionHtml(p: CaptionParams, safeInset?: SafeInset): string {
  const scrim = p.bgOpacity > 0
    ? `background: rgba(0,0,0,${p.bgOpacity}); padding: 14px 24px; border-radius: 12px;`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  ${cardHeadCss(p, PADDING, safeInset)}
  body { background: transparent; display: flex; justify-content: center; align-items: ${anchorFor(p.position)}; }
  .cap-out { max-width: ${p.maxWidthPct}%; }
  .cap-text {
    ${scrim}
    color: ${p.textColor};
    font-size: 40px; font-weight: 600; line-height: 1.3; text-align: center;
    text-shadow: ${p.bgOpacity > 0 ? "none" : "0 2px 8px rgba(0,0,0,0.55)"};
  }
</style></head>
<body>
  <div class="cap-out"><div class="cap-in"><div class="cap-text">${escapeHtml(p.text)}</div></div></div>
</body></html>`;
}

/** The two-wrapper in-hold-out animation (fade or slide). */
export function buildCaptionAnimations(p: CaptionParams): Anims {
  const outStart = Math.max(0, p.holdMs - p.outMs);
  const enterEasing = "cubic-bezier(0.22,1,0.36,1)";
  if (p.motion === "slide") {
    const rise = p.position === "top-center" ? "-24px" : "24px";
    return [
      { selector: ".cap-in", property: "translateY", from: rise, to: "0px", duration: p.inMs, easing: enterEasing, fuse: [{ property: "opacity", from: "0", to: "1" }] },
      { selector: ".cap-out", property: "translateY", from: "0px", to: rise, duration: p.outMs, delay: outStart, easing: "ease-in", fuse: [{ property: "opacity", from: "1", to: "0" }] },
    ];
  }
  return [
    { selector: ".cap-in", property: "opacity", from: "0", to: "1", duration: p.inMs, easing: "ease-out" },
    { selector: ".cap-out", property: "opacity", from: "1", to: "0", duration: p.outMs, delay: outStart, easing: "ease-in" },
  ];
}

export const captionTemplate: Template<CaptionParams> = {
  name: "caption",
  description: "Lightweight subtitle strip for compositing over other content — transparent, safe-margin anchored, explicit fade/slide in and out.",
  paramsSchema: captionParamsSchema,
  brandDefaults(brand: Brand): Partial<CaptionParams> {
    // Caption is content-agnostic overlay copy: only the font is a natural brand slot
    // (its color is tuned for legibility over arbitrary footage, so brand text color
    // is intentionally NOT mapped here).
    return brandParams<CaptionParams>({
      fontFamily: brand.font?.family,
    });
  },
  async render(params: CaptionParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    // The frame must outlast enter + a little hold + exit.
    const holdMs = Math.max(params.holdMs, params.inMs + params.outMs + 300);
    ctx.log(`template caption: ${params.width}×${params.height}, "${params.text.slice(0, 40)}…"`);
    return runSingleFrameGenerator(ctx, {
      name: "caption",
      html: buildCaptionHtml({ ...params, holdMs }, ctx.safeInset),
      width: params.width,
      height: params.height,
      durationMs: holdMs,
      animations: buildCaptionAnimations({ ...params, holdMs }),
    });
  },
};
