/**
 * Built-in template: compare / before-after (creative pack, docs/86 §6, DM-1533).
 *
 * Two visuals stacked, with the "after" revealed over the "before" by a clip
 * wipe (optionally with a divider line, the "slider" look), plus optional
 * before/after labels. Each visual is resolved to a SELF-CONTAINED SVG (a page is
 * captured via `captureToSvg`; an image / existing SVG is wrapped in a full-bleed
 * page and captured, so its bytes embed) and then composited with
 * `composeAnimatedLayers` — whose `clipScale` animation is the same Firefox-safe
 * clip-path reveal used by the window-resize composite (DM-1529). So the wipe is
 * one implementation, shared with the transition family; nothing new here paints
 * a clip.
 */

import { writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { z } from "zod";
import { composeAnimatedLayers, type CompositeLayerAnimation } from "../../animation/index.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { escapeHtml } from "../../utils/escapeHtml.js";

const MODES = ["wipe", "slide"] as const;
const DIRECTIONS = ["right", "left", "down", "up"] as const;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp"]);

export const compareParamsSchema = z.object({
  before: z.string().min(1).describe("The 'before' visual: a page URL/HTML file, or an image/SVG file."),
  after: z.string().min(1).describe("The 'after' visual (revealed over the before). Same input kinds."),
  mode: z.enum(MODES).default("wipe").describe('"wipe" (clip reveal) | "slide" (reveal + a divider line at the edge).'),
  direction: z.enum(DIRECTIONS).default("right").describe("Direction the reveal travels: right | left | down | up."),
  beforeLabel: z.string().optional().describe("Caption badge for the before visual (bottom-left)."),
  afterLabel: z.string().optional().describe("Caption badge for the after visual (bottom-right)."),
  accent: z.string().default("#ffffff").describe("Divider line color (slide mode)."),
  fontFamily: z.string().default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif").describe("Label font."),
  durationMs: z.coerce.number().int().positive().default(1600).describe("Reveal duration in ms."),
  holdMs: z.coerce.number().int().positive().default(3200).describe("Total on-screen time in ms."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
});

export type CompareParams = z.infer<typeof compareParamsSchema>;

/** Is this input an image / SVG asset (vs a page to capture)? */
function isAsset(src: string): boolean {
  if (/^https?:\/\//i.test(src)) return false; // a URL is treated as a page
  return IMAGE_EXTS.has(extname(src).toLowerCase());
}

/** Resolve a local path to absolute (URLs pass through). */
function resolveSrc(src: string): string {
  return /^https?:\/\//i.test(src) ? src : resolve(src);
}

/**
 * Resolve one visual to a self-contained SVG at `w×h`. A page (URL/HTML) is
 * captured directly; an image/SVG asset is wrapped in a full-bleed page so its
 * bytes embed into the captured SVG. `slot` disambiguates the temp filename.
 */
async function visualToSvg(ctx: TemplateRenderContext, src: string, w: number, h: number, slot: string): Promise<string> {
  if (isAsset(src)) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{margin:0}html,body{width:${w}px;height:${h}px;overflow:hidden}
      img{width:100%;height:100%;object-fit:cover;display:block}
    </style></head><body><img src="file://${resolveSrc(src)}"></body></html>`;
    const path = join(ctx.workDir, `compare-${slot}.html`);
    writeFileSync(path, html);
    const out = await ctx.captureToSvg({ input: path, width: w, height: h });
    return out.svg;
  }
  const out = await ctx.captureToSvg({ input: resolveSrc(src), width: w, height: h });
  return out.svg;
}

/** Easing shared by the clip reveal AND the slide divider so their leading edges
 *  stay locked together (a mismatch desyncs the divider from the clip boundary). */
const REVEAL_EASING = "cubic-bezier(0.65,0,0.35,1)";

/** The clip-reveal animation for the "after" layer, per direction. `clipScaleX/Y`
 *  0→1 grows the after's clip from the anchored edge (Firefox-safe, DM-1529). */
export function revealAnimation(direction: CompareParams["direction"], durationMs: number): CompositeLayerAnimation {
  const horizontal = direction === "right" || direction === "left";
  const origin = direction === "right" ? "left" : direction === "left" ? "right" : direction === "down" ? "top" : "bottom";
  return {
    property: horizontal ? "clipScaleX" : "clipScaleY",
    from: 0, to: 1, start: 0, duration: durationMs, easing: REVEAL_EASING,
    transformOrigin: origin,
  };
}

/** Where a label pill sits: an edge along each axis. */
interface LabelPos { h: "left" | "right" | "center"; v: "top" | "bottom"; }

/**
 * SVG markup for the before/after label badges + (slide) the moving divider,
 * injected before the composite's closing `</svg>`. Each label is placed over the
 * region it describes: the reveal-origin side always shows the AFTER (it's
 * unveiled first and stays), the far side shows the BEFORE — so the "After" label
 * sits where the after appears, not on a fixed corner. Text is centered in the
 * pill. Exposed for testing.
 */
export function compareOverlayMarkup(p: CompareParams): string {
  const { width: W, height: H } = p;
  const pad = 28;
  const bh = 44;
  const fontSize = 22;
  const badge = (text: string, pos: LabelPos): string => {
    // Loose width estimate for a semibold system font; the text is CENTERED, so a
    // slightly-off estimate just changes the symmetric padding, never clips.
    const bw = Math.round(text.length * fontSize * 0.62 + 40);
    const bx = pos.h === "left" ? pad : pos.h === "right" ? W - pad - bw : (W - bw) / 2;
    const by = pos.v === "top" ? pad : H - pad - bh;
    const cx = bx + bw / 2;
    const baseline = by + bh / 2 + fontSize * 0.34; // vertical-center the cap height
    return `<g><rect x="${bx.toFixed(1)}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="rgba(0,0,0,0.62)"/>`
      + `<text x="${cx.toFixed(1)}" y="${baseline.toFixed(1)}" fill="#fff" font-family="${escapeHtml(p.fontFamily)}" font-size="${fontSize}" font-weight="600" text-anchor="middle">${escapeHtml(text)}</text></g>`;
  };
  // The reveal-origin side (where clipScale grows from) is the AFTER region.
  const horizontal = p.direction === "right" || p.direction === "left";
  const afterPos: LabelPos = horizontal
    ? { h: p.direction === "right" ? "left" : "right", v: "bottom" }
    : { h: "center", v: p.direction === "down" ? "top" : "bottom" };
  const beforePos: LabelPos = horizontal
    ? { h: afterPos.h === "left" ? "right" : "left", v: "bottom" }
    : { h: "center", v: afterPos.v === "top" ? "bottom" : "top" };
  let out = "";
  if (p.beforeLabel != null && p.beforeLabel !== "") out += badge(p.beforeLabel, beforePos);
  if (p.afterLabel != null && p.afterLabel !== "") out += badge(p.afterLabel, afterPos);
  if (p.mode === "slide") out += dividerMarkup(p);
  return out;
}

/** The moving divider line (slide mode) synced to the reveal window. */
function dividerMarkup(p: CompareParams): string {
  const { width: W, height: H, durationMs, holdMs } = p;
  const horizontal = p.direction === "right" || p.direction === "left";
  const endPct = Math.min(100, (durationMs / holdMs) * 100);
  // The divider tracks the reveal's leading edge across the reveal window, then
  // holds at the far edge. `right`: x 0→W; `left`: x W→0; `down`: y 0→H; `up`: y H→0.
  const name = "cmp-div";
  // The divider eases identically to the clip reveal (REVEAL_EASING) so its line
  // stays locked to the clip boundary; `animation-fill-mode: both` holds the end.
  const anim = `${name} ${(holdMs / 1000).toFixed(2)}s ${REVEAL_EASING} infinite`;
  if (horizontal) {
    const fromX = p.direction === "right" ? 0 : W;
    const toX = p.direction === "right" ? W : 0;
    return `<style>@keyframes ${name}{0%{transform:translateX(${fromX}px)}${endPct.toFixed(2)}%,100%{transform:translateX(${toX}px)}}`
      + `.${name}{animation:${anim}}</style>`
      + `<rect class="${name}" x="-3" y="0" width="6" height="${H}" fill="${p.accent}"/>`;
  }
  const fromY = p.direction === "down" ? 0 : H;
  const toY = p.direction === "down" ? H : 0;
  return `<style>@keyframes ${name}{0%{transform:translateY(${fromY}px)}${endPct.toFixed(2)}%,100%{transform:translateY(${toY}px)}}`
    + `.${name}{animation:${anim}}</style>`
    + `<rect class="${name}" x="0" y="-3" width="${W}" height="6" fill="${p.accent}"/>`;
}

export const compareTemplate: Template<CompareParams> = {
  name: "compare",
  description: "Before/after comparison: reveal the 'after' over the 'before' with a clip wipe (optional divider) + labels.",
  paramsSchema: compareParamsSchema,
  async render(params: CompareParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const { width, height } = params;
    const holdMs = Math.max(params.holdMs, params.durationMs + 600);
    ctx.log(`template compare: ${params.mode}/${params.direction}, ${width}×${height}`);
    const [beforeSvg, afterSvg] = await Promise.all([
      visualToSvg(ctx, params.before, width, height, "before"),
      visualToSvg(ctx, params.after, width, height, "after"),
    ]);
    const composed = composeAnimatedLayers(
      [
        { svg: beforeSvg, x: 0, y: 0, width, height },
        { svg: afterSvg, x: 0, y: 0, width, height, animations: [revealAnimation(params.direction, params.durationMs)] },
      ],
      { width, height, durationMs: holdMs },
    );
    // Inject the label badges + (slide) divider just before the closing tag.
    const overlay = compareOverlayMarkup({ ...params, holdMs });
    const svg = overlay === "" ? composed.svg : composed.svg.replace(/<\/svg>\s*$/, `${overlay}</svg>`);
    return { svg, width, height, durationMs: holdMs };
  },
};
