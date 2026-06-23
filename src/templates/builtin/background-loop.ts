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

const VARIANTS = ["aurora", "orbs", "stars", "gradient-pan", "grid"] as const;
export type BackgroundVariant = (typeof VARIANTS)[number];

/** Blob-laid-out variants (positioned soft circles). The non-blob variants
 *  (`gradient-pan`, `grid`) have their own layout + animation builders below. */
const BLOB_VARIANTS = new Set<BackgroundVariant>(["aurora", "orbs", "stars"]);

const DEFAULT_COLORS = ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"];

/**
 * DM-1285: accept `colors` as either a JSON array (`--params`) OR a
 * comma-separated string (the `--colors` convenience flag / a string in an
 * animate-config `params`). The union admits `string` in the projected JSON
 * Schema, so the template CLI surfaces `--colors` as a string flag (array params
 * are otherwise JSON-only); the string branch splits on commas.
 */
const colorsSchema = z
  .union([
    z.string().transform((s) => s.split(",").map((c) => c.trim()).filter((c) => c !== "")),
    z.array(z.string()),
  ])
  .pipe(z.array(z.string()).min(1))
  .default(DEFAULT_COLORS);

export const backgroundLoopParamsSchema = z.object({
  variant: z.enum(VARIANTS).default("aurora")
    .describe('"aurora" (soft mesh) | "orbs" (floating circles) | "stars" (twinkling particle field) | "gradient-pan" (sweeping color wash) | "grid" (drifting dot grid).'),
  colors: colorsSchema
    .describe("Colors, cycled across the elements (CSS colors; a JSON array, or a comma-separated string)."),
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

const VARIANT_STYLES: Record<"aurora" | "orbs" | "stars", VariantStyle> = {
  aurora: { sizeMin: 0.55, sizeMax: 0.95, falloff: 72, opacityLow: 0.35, opacityHigh: 0.7, drift: 0.18 },
  orbs:   { sizeMin: 0.18, sizeMax: 0.34, falloff: 55, opacityLow: 0.55, opacityHigh: 0.95, drift: 0.28 },
  // DM-1285 "particle / star field": many tiny, sharp-edged dots that twinkle
  // (wide opacity range) and drift only slightly — a starscape rather than a mesh.
  stars:  { sizeMin: 0.012, sizeMax: 0.03, falloff: 90, opacityLow: 0.15, opacityHigh: 1.0, drift: 0.05 },
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
  // Blob variants only (aurora / orbs / stars); the non-blob variants render via
  // their own builders. Fall back to `orbs` if called with an unexpected variant.
  const style = VARIANT_STYLES[(p.variant in VARIANT_STYLES ? p.variant : "orbs") as keyof typeof VARIANT_STYLES];
  const minDim = Math.min(p.width, p.height);
  // A star field reads as dense; treat `count` as a density level and multiply it
  // (so the default 5 → ~70 stars) while still honoring the user's knob.
  const n = p.variant === "stars" ? p.count * 14 : p.count;
  const blobs: Blob[] = [];
  for (let i = 0; i < n; i++) {
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

type Anims = NonNullable<AnimateConfig["frames"][number]["animations"]>;

/** Evenly-spaced gradient stops from the palette (a single color → a solid fill). */
function gradientStops(colors: string[]): string {
  if (colors.length === 1) return `${colors[0]} 0%, ${colors[0]} 100%`;
  return colors.map((c, i) => `${c} ${Math.round((i / (colors.length - 1)) * 100)}%`).join(", ");
}

/**
 * DM-1285 "panning linear-gradient": a single angled color band on a layer twice
 * the canvas width that slides horizontally so the visible window sweeps the
 * colors. Pure (unit-testable without a browser).
 */
export function buildGradientPanHtml(p: BackgroundLoopParams): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .gp { position: absolute; top: 0; left: 0; width: ${p.width * 2}px; height: ${p.height}px;
        background: linear-gradient(60deg, ${gradientStops(p.colors)}); opacity: 0.92; }
</style></head>
<body><div class="gp gp-layer"></div></body></html>`;
}

/** Slide the gradient layer by one canvas width (translateX, `alternate` ping-pong). */
export function buildGradientPanAnimations(p: BackgroundLoopParams): Anims {
  return [{
    selector: ".gp-layer",
    property: "transform",
    from: "translate(0px, 0px)",
    to: `translate(-${p.width}px, 0px)`,
    duration: p.durationMs,
    easing: "ease-in-out",
    repeat: "infinite",
    alternate: true,
  }];
}

interface GridDot { left: number; top: number; size: number; color: string; }

/** Lay out a dot grid one cell beyond every edge (so a one-cell drift never
 *  exposes a gap). Returns the dots + the cell size. Pure. */
export function planGridDots(p: BackgroundLoopParams): { dots: GridDot[]; cell: number } {
  const minDim = Math.min(p.width, p.height);
  const cell = Math.max(40, Math.round(minDim / 8));
  const dotSize = Math.max(4, Math.round(cell * 0.14));
  const dots: GridDot[] = [];
  let idx = 0;
  for (let y = -cell; y <= p.height + cell; y += cell) {
    for (let x = -cell; x <= p.width + cell; x += cell) {
      dots.push({ left: x, top: y, size: dotSize, color: p.colors[idx % p.colors.length] });
      idx++;
    }
  }
  return { dots, cell };
}

/** Standalone HTML for the dot grid. Pure. */
export function buildGridHtml(p: BackgroundLoopParams, dots: GridDot[]): string {
  const markup = dots
    .map((d) => `<div class="gd-dot" style="left:${d.left}px;top:${d.top}px;width:${d.size}px;height:${d.size}px;background:${d.color}"></div>`)
    .join("\n  ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .gd { position: absolute; top: 0; left: 0; width: ${p.width}px; height: ${p.height}px; }
  .gd-dot { position: absolute; border-radius: 50%; opacity: 0.5; }
</style></head>
<body><div class="gd gd-layer">
  ${markup}
</div></body></html>`;
}

/** Drift the whole grid by exactly one cell diagonally (`alternate` — the shifted
 *  grid looks identical to the rest, so even the endpoints read as seamless). */
export function buildGridAnimations(p: BackgroundLoopParams, cell: number): Anims {
  return [{
    selector: ".gd-layer",
    property: "transform",
    from: "translate(0px, 0px)",
    to: `translate(${cell}px, ${cell}px)`,
    duration: p.durationMs,
    easing: "ease-in-out",
    repeat: "infinite",
    alternate: true,
  }];
}

export const backgroundLoopTemplate: Template<BackgroundLoopParams> = {
  name: "background-loop",
  description: "Procedural seamlessly-looping animated background (drifting, breathing color blobs).",
  paramsSchema: backgroundLoopParamsSchema,
  async render(params: BackgroundLoopParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const htmlPath = join(ctx.workDir, "background-loop.html");
    // Each variant family has its own layout + animation builder; all share the
    // origin-safe translate + opacity, `alternate`-looped contract (doc 71).
    let animations: Anims;
    if (BLOB_VARIANTS.has(params.variant)) {
      const blobs = planBlobs(params);
      writeFileSync(htmlPath, buildBackgroundHtml(params, blobs));
      animations = buildBackgroundAnimations(blobs);
      ctx.log(`template background-loop: ${params.variant}, ${blobs.length} blobs, ${params.width}×${params.height}`);
    } else if (params.variant === "gradient-pan") {
      writeFileSync(htmlPath, buildGradientPanHtml(params));
      animations = buildGradientPanAnimations(params);
      ctx.log(`template background-loop: gradient-pan, ${params.colors.length} colors, ${params.width}×${params.height}`);
    } else {
      const { dots, cell } = planGridDots(params);
      writeFileSync(htmlPath, buildGridHtml(params, dots));
      animations = buildGridAnimations(params, cell);
      ctx.log(`template background-loop: grid, ${dots.length} dots, ${params.width}×${params.height}`);
    }

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "background-loop.html",
          // Hold for one full base period so the looping reads in the timeline.
          duration: params.durationMs,
          transition: { type: "cut", duration: 0 },
          animations,
        },
      ],
    });
    // One base loop period; the blobs loop infinitely, so this is the seamless-
    // cycle length to size a frame to.
    return { svg, width: params.width, height: params.height, durationMs: params.durationMs };
  },
};
