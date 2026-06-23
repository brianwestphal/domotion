/**
 * Built-in template: background-loop (DM-1280, doc 71).
 *
 * A procedurally-generated, seamlessly-looping animated background — drifting,
 * breathing color blobs over a base fill. The classic "overlays & graphic
 * assets → backgrounds & loops" template, and a good showcase of author-time
 * pre-processing: a seed + a few knobs expand into N positioned blobs each with
 * its own staggered drift + breathe loop, baked once into a self-contained
 * animated SVG that replays forever.
 *
 * Two reliability rules drive the design (both learned from the DM-1276 spike):
 *  1. Only ONE intra-frame animation applies per captured element (a second
 *     animation on the same selector overrides the first), so each blob is a
 *     `.bg-pos-N` wrapper (drift) around a `.bg-blob-N` inner (breathe) — two
 *     distinct selectors, two animations.
 *  2. SVG transforms are origin-(0,0), so rotate/scale would orbit/shift. We use
 *     only origin-safe `translate` (drift) + `opacity` (breathe), looped with
 *     `alternate` so each cycle ping-pongs seamlessly (no snap-back).
 *  Soft edges come from `radial-gradient` falloff (natively supported, doc 07),
 *  not `filter: blur()`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

const VARIANTS = ["aurora", "orbs"] as const;
export type BackgroundVariant = (typeof VARIANTS)[number];

const DEFAULT_COLORS = ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"];

export const backgroundLoopParamsSchema = z.object({
  variant: z.enum(VARIANTS).default("aurora")
    .describe('"aurora" (large soft mesh) | "orbs" (smaller floating circles).'),
  colors: z.array(z.string()).min(1).default(DEFAULT_COLORS)
    .describe("Blob colors, cycled across the blobs (CSS colors)."),
  background: z.string().default("#0b1020").describe("Base fill behind the blobs (CSS color)."),
  count: z.coerce.number().int().min(1).max(24).default(5).describe("Number of blobs."),
  width: z.coerce.number().int().positive().default(1280).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(720).describe("Output height in px."),
  durationMs: z.coerce.number().int().positive().default(9000)
    .describe("Base loop period in ms (each blob varies around it)."),
  seed: z.coerce.number().int().default(1).describe("PRNG seed — same seed ⇒ identical layout."),
});

export type BackgroundLoopParams = z.infer<typeof backgroundLoopParamsSchema>;

/** Deterministic PRNG (mulberry32) so a seed reproduces the exact layout — keeps
 *  output stable for tests / re-renders (Math.random would not). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface VariantStyle {
  /** Blob radius as a fraction of the smaller canvas dimension. */
  sizeMin: number; sizeMax: number;
  /** radial-gradient transparent-falloff stop (%). */
  falloff: number;
  /** Breathe opacity range. */
  opacityLow: number; opacityHigh: number;
  /** Drift distance as a fraction of the canvas. */
  drift: number;
}

const VARIANT_STYLES: Record<BackgroundVariant, VariantStyle> = {
  aurora: { sizeMin: 0.55, sizeMax: 0.95, falloff: 72, opacityLow: 0.35, opacityHigh: 0.7, drift: 0.18 },
  orbs:   { sizeMin: 0.18, sizeMax: 0.34, falloff: 55, opacityLow: 0.55, opacityHigh: 0.95, drift: 0.28 },
};

interface Blob {
  idx: number;
  color: string;
  /** size, left/top, drift dx/dy (px); breathe + drift loop durations (ms); phases (ms). */
  size: number; left: number; top: number;
  dx: number; dy: number;
  driftMs: number; breatheMs: number; driftDelay: number; breatheDelay: number;
  opacityLow: number; opacityHigh: number;
  falloff: number;
}

/** Lay out the blobs deterministically from the params (pure — no I/O). */
export function planBlobs(p: BackgroundLoopParams): Blob[] {
  const rnd = mulberry32(p.seed);
  const style = VARIANT_STYLES[p.variant];
  const minDim = Math.min(p.width, p.height);
  const blobs: Blob[] = [];
  for (let i = 0; i < p.count; i++) {
    const size = Math.round((style.sizeMin + rnd() * (style.sizeMax - style.sizeMin)) * minDim);
    // Place the blob's CENTER anywhere in the canvas (allow it to bleed off-edge).
    const cx = rnd() * p.width;
    const cy = rnd() * p.height;
    const angle = rnd() * Math.PI * 2;
    const dist = (0.5 + rnd() * 0.5) * style.drift * minDim;
    const driftMs = Math.round(p.durationMs * (0.8 + rnd() * 0.8));
    const breatheMs = Math.round(p.durationMs * (0.6 + rnd() * 0.7));
    blobs.push({
      idx: i,
      color: p.colors[i % p.colors.length],
      size,
      left: Math.round(cx - size / 2),
      top: Math.round(cy - size / 2),
      dx: Math.round(Math.cos(angle) * dist),
      dy: Math.round(Math.sin(angle) * dist),
      driftMs,
      breatheMs,
      // NEGATIVE phase offset (a fraction of the loop's own period), NOT a wait.
      // A positive animation-delay would FREEZE the blob at its `from` state for
      // the delay then snap into motion — visibly "appearing"/"disappearing"
      // rather than fading. A negative delay starts the infinite-`alternate` loop
      // already mid-cycle, so every blob is drifting/breathing from t=0: the
      // seamless, always-smooth ambient loop the template is meant to produce.
      driftDelay: -Math.round(rnd() * driftMs),
      breatheDelay: -Math.round(rnd() * breatheMs),
      opacityLow: style.opacityLow,
      opacityHigh: style.opacityHigh,
      falloff: style.falloff,
    });
  }
  return blobs;
}

/** The standalone HTML for the background (pure — unit-testable without a browser). */
export function buildBackgroundHtml(p: BackgroundLoopParams, blobs: Blob[]): string {
  const blobMarkup = blobs
    .map(
      (b) =>
        `<div class="bg-pos bg-pos-${b.idx}" style="left:${b.left}px;top:${b.top}px;width:${b.size}px;height:${b.size}px">`
        + `<div class="bg-blob bg-blob-${b.idx}" style="background:radial-gradient(circle at center, ${b.color} 0%, transparent ${b.falloff}%)"></div>`
        + `</div>`,
    )
    .join("\n  ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .bg-pos { position: absolute; }
  .bg-blob { width: 100%; height: 100%; border-radius: 50%; }
</style></head>
<body>
  ${blobMarkup}
</body></html>`;
}

/** Build the intra-frame animations (one drift on the wrapper, one breathe on the
 *  inner) for every blob. Pure so the loop wiring is unit-testable. */
export function buildBackgroundAnimations(blobs: Blob[]): NonNullable<AnimateConfig["frames"][number]["animations"]> {
  const anims: NonNullable<AnimateConfig["frames"][number]["animations"]> = [];
  for (const b of blobs) {
    anims.push({
      selector: `.bg-pos-${b.idx}`,
      property: "transform",
      from: "translate(0px, 0px)",
      to: `translate(${b.dx}px, ${b.dy}px)`,
      duration: b.driftMs,
      delay: b.driftDelay,
      easing: "ease-in-out",
      repeat: "infinite",
      alternate: true,
    });
    anims.push({
      selector: `.bg-blob-${b.idx}`,
      property: "opacity",
      from: String(b.opacityLow),
      to: String(b.opacityHigh),
      duration: b.breatheMs,
      delay: b.breatheDelay,
      easing: "ease-in-out",
      repeat: "infinite",
      alternate: true,
    });
  }
  return anims;
}

export const backgroundLoopTemplate: Template<BackgroundLoopParams> = {
  name: "background-loop",
  description: "Procedural seamlessly-looping animated background (drifting, breathing color blobs).",
  paramsSchema: backgroundLoopParamsSchema,
  async render(params: BackgroundLoopParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const blobs = planBlobs(params);
    const htmlPath = join(ctx.workDir, "background-loop.html");
    writeFileSync(htmlPath, buildBackgroundHtml(params, blobs));
    ctx.log(`template background-loop: ${params.variant}, ${blobs.length} blobs, ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "background-loop.html",
          // Hold for one full base period so the looping reads in the timeline.
          duration: params.durationMs,
          transition: { type: "cut", duration: 0 },
          animations: buildBackgroundAnimations(blobs),
        },
      ],
    });
    return { svg, width: params.width, height: params.height };
  },
};
