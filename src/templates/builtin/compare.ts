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
import { formatScaleFactor, type SafeInset } from "../formats.js";

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

/**
 * SVG markup for the single before/after label badge + (slide) the moving
 * divider, injected before the composite's closing `</svg>`. There is ONE label
 * pill (bottom-left) whose text tracks the reveal: it reads `beforeLabel` while
 * the before is shown and crossfades to `afterLabel` as the after is unveiled —
 * "Before" then "After" — rather than two fixed corner labels that never change.
 * With only one of the two labels set, that label is shown statically. Text is
 * centered in the pill. Exposed for testing.
 */
export function compareOverlayMarkup(p: CompareParams, safeInset?: SafeInset): string {
  const { height: H } = p;
  // DM-1541: scale the label pill by the adaptive per-ratio factor, and — since a
  // compare has no reflowable layout — honor a format's safe-area inset by nudging
  // the bottom-left badge inside it (DM-1537 skipped compare; this closes it). Both
  // no-op with no format (sf === 1, insets 0) → byte-identical default output.
  const sf = formatScaleFactor(p.width, p.height, safeInset);
  const pad = Math.round(28 * sf);
  const bh = Math.round(44 * sf);
  const fontSize = Math.round(22 * sf);
  const before = p.beforeLabel != null && p.beforeLabel !== "" ? p.beforeLabel : null;
  const after = p.afterLabel != null && p.afterLabel !== "" ? p.afterLabel : null;

  let out = "";
  if (before != null || after != null) {
    // One pill, sized to the wider label so the crossfade doesn't reflow it.
    const widest = Math.max((before ?? "").length, (after ?? "").length);
    const bw = Math.round(widest * fontSize * 0.62 + 40);
    const bx = Math.max(pad, safeInset?.left ?? 0);
    const by = H - Math.max(pad, safeInset?.bottom ?? 0) - bh;
    const cx = bx + bw / 2;
    const baseline = by + bh / 2 + fontSize * 0.34; // vertical-center the cap height
    const txt = (t: string, cls: string): string =>
      `<text class="${cls}" x="${cx.toFixed(1)}" y="${baseline.toFixed(1)}" fill="#fff" font-family="${escapeHtml(p.fontFamily)}" font-size="${fontSize}" font-weight="600" text-anchor="middle">${escapeHtml(t)}</text>`;

    if (before != null && after != null) {
      // Swap the text with a SHORT crossfade centered on the reveal's midpoint, so
      // "Before" reads solid until the wipe is ~half done and "After" solid after —
      // with only a brief overlap, not a long double-exposure. Percentages are of
      // the whole loop; the reveal spans [0, endPct].
      const endPct = Math.min(100, (p.durationMs / p.holdMs) * 100);
      const s0 = (endPct * 0.42).toFixed(2); // before starts fading
      const s1 = (endPct * 0.58).toFixed(2); // after fully in
      const dur = (p.holdMs / 1000).toFixed(2);
      // A vertical flip: "Before" slides up + out while "After" rises up + in, so
      // at the crossover they sit at different heights instead of ghosting over
      // each other. (translateY is a pure shift — no transform-box/origin needed.)
      out += `<style>`
        + `@keyframes cmp-lbl-b{0%,${s0}%{opacity:1;transform:translateY(0)}${s1}%,100%{opacity:0;transform:translateY(-9px)}}`
        + `@keyframes cmp-lbl-a{0%,${s0}%{opacity:0;transform:translateY(9px)}${s1}%,100%{opacity:1;transform:translateY(0)}}`
        + `.cmp-lbl-b{animation:cmp-lbl-b ${dur}s ease infinite}`
        + `.cmp-lbl-a{animation:cmp-lbl-a ${dur}s ease infinite}</style>`;
      out += `<g><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="rgba(0,0,0,0.62)"/>`
        + txt(before, "cmp-lbl-b") + txt(after, "cmp-lbl-a") + `</g>`;
    } else {
      out += `<g><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="rgba(0,0,0,0.62)"/>`
        + txt((before ?? after)!, "cmp-lbl-s") + `</g>`;
    }
  }
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
    const overlay = compareOverlayMarkup({ ...params, holdMs }, ctx.safeInset);
    const svg = overlay === "" ? composed.svg : composed.svg.replace(/<\/svg>\s*$/, `${overlay}</svg>`);
    return { svg, width, height, durationMs: holdMs };
  },
};
