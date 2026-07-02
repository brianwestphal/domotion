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

import { runSingleFrameGenerator } from "../run-single-frame.js";
import { z } from "zod";
import type { AnimateConfig, Anims } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { brandParams, brandBackground, brandSeriesColors, type Brand } from "../brand.js";

const VARIANTS = ["aurora", "orbs", "stars", "gradient-pan", "grid", "wave"] as const;
export type BackgroundVariant = (typeof VARIANTS)[number];

/** Blob-laid-out variants (positioned soft circles). The non-blob variants
 *  (`stars`, `gradient-pan`, `grid`, `wave`) have their own layout + animation
 *  builders. */
const BLOB_VARIANTS = new Set<BackgroundVariant>(["aurora", "orbs"]);

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
    .describe('"aurora" (soft mesh) | "orbs" (floating circles) | "stars" (twinkling particle field) | "gradient-pan" (sweeping color wash) | "grid" (drifting dot grid) | "wave" (parallax ribbon bands).'),
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

const VARIANT_STYLES: Record<"aurora" | "orbs", VariantStyle> = {
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
  // Blob variants only (aurora / orbs); the others render via their own builders.
  // Fall back to `orbs` if called with an unexpected variant.
  const style = VARIANT_STYLES[(p.variant in VARIANT_STYLES ? p.variant : "orbs") as keyof typeof VARIANT_STYLES];
  const minDim = Math.min(p.width, p.height);
  const n = p.count;
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

const GRADIENT_PAN_ANGLE_DEG = 60;

/**
 * Shared geometry for the gradient-pan variant so the HTML (gradient period) and
 * the animation (horizontal shift) agree. The gradient is a `repeating-linear-
 * gradient` with period `period` px along its 60° line; advancing the element
 * horizontally by `shift = period / sin(60°)` moves the pattern by exactly one
 * period, so a CONTINUOUS (non-`alternate`) translate of `-shift` loops with no
 * seam — the colour scheme tiles into itself (DM-1298). The layer is widened by
 * `shift` so the canvas stays covered throughout.
 */
function gradientPanGeometry(p: BackgroundLoopParams): { period: number; shift: number; layerWidth: number } {
  const period = Math.round(Math.min(p.width, p.height) * 0.85);
  const shift = Math.round(period / Math.sin((GRADIENT_PAN_ANGLE_DEG * Math.PI) / 180));
  return { period, shift, layerWidth: p.width + shift + 4 };
}

/** Repeating-gradient stops over one `period`: the palette evenly spaced, wrapping
 *  the first colour back in at `period` so the tile joins itself seamlessly. */
function repeatingStops(colors: string[], period: number): string {
  const n = colors.length;
  const stops = colors.map((c, k) => `${c} ${Math.round((k * period) / n)}px`);
  stops.push(`${colors[0]} ${period}px`);
  return stops.join(", ");
}

/**
 * DM-1285/DM-1298 "panning linear-gradient": an angled, repeating colour band on a
 * layer wider than the canvas that pans CONTINUOUSLY in one direction. Pure.
 */
export function buildGradientPanHtml(p: BackgroundLoopParams): string {
  const { period, layerWidth } = gradientPanGeometry(p);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .gp { position: absolute; top: 0; left: 0; width: ${layerWidth}px; height: ${p.height}px;
        background: repeating-linear-gradient(${GRADIENT_PAN_ANGLE_DEG}deg, ${repeatingStops(p.colors, period)}); opacity: 0.92; }
</style></head>
<body><div class="gp gp-layer"></div></body></html>`;
}

/** Pan the gradient layer continuously by exactly one period (translateX, linear,
 *  NON-`alternate` — the repeating pattern wraps into itself, so it never backs out). */
export function buildGradientPanAnimations(p: BackgroundLoopParams): Anims {
  const { shift } = gradientPanGeometry(p);
  return [{
    selector: ".gp-layer",
    property: "transform",
    from: "translate(0px, 0px)",
    to: `translate(-${shift}px, 0px)`,
    duration: p.durationMs,
    easing: "linear",
    repeat: "infinite",
  }];
}

/** A grid dot in the layer's own (svg-local) coordinates. */
interface GridDot { cx: number; cy: number; r: number; color: string; }

/**
 * Lay out a dot grid covering one cell beyond every edge, in the grid LAYER's own
 * coordinate space (the layer is offset `-cell, -cell` so local `cell` sits at the
 * canvas origin). Returns the dots + the `cell` size + the layer dimensions. Pure.
 *
 * The layer is a single inline `<svg>` (DM-1299): each dot is a `<circle>` inside
 * it, so the margin dots survive capture. (Individual off-viewport `<div>` dots
 * were CULLED by the capture's outside-viewport pass, leaving nothing to slide in
 * from the top-left as the grid drifted down-right — a growing empty margin.)
 *
 * Colours run along the DIAGONAL `(col - row)`, invariant under the one-cell
 * down-right drift (`(col-1) - (row-1) === col - row`), so a dot sliding into a
 * position carries the same colour as the one it replaced (no seam flicker).
 */
export function planGridDots(p: BackgroundLoopParams): { dots: GridDot[]; cell: number; layerW: number; layerH: number } {
  const minDim = Math.min(p.width, p.height);
  const cell = Math.max(40, Math.round(minDim / 8));
  const r = Math.max(2, Math.round(cell * 0.07));
  const n = p.colors.length;
  // The layer extends one cell past each edge; in local coords that's [0, W+2cell].
  const layerW = p.width + cell * 2;
  const layerH = p.height + cell * 2;
  const cols = Math.round(layerW / cell);
  const rows = Math.round(layerH / cell);
  const dots: GridDot[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      dots.push({ cx: col * cell, cy: row * cell, r, color: p.colors[(((col - row) % n) + n) % n] });
    }
  }
  return { dots, cell, layerW, layerH };
}

/** Standalone HTML for the dot grid: a single inline `<svg>` of `<circle>`s,
 *  offset `-cell, -cell` so the extra margin row/column sits just off-canvas and
 *  slides in as the layer drifts. Pure. */
export function buildGridHtml(p: BackgroundLoopParams, grid: { dots: GridDot[]; cell: number; layerW: number; layerH: number }): string {
  const circles = grid.dots
    .map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="${d.color}"/>`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .gd-layer { position: absolute; left: -${grid.cell}px; top: -${grid.cell}px; width: ${grid.layerW}px; height: ${grid.layerH}px; opacity: 0.55; }
</style></head>
<body><div class="gd-layer">
  <svg width="${grid.layerW}" height="${grid.layerH}" viewBox="0 0 ${grid.layerW} ${grid.layerH}">${circles}</svg>
</div></body></html>`;
}

/** Drift the whole grid CONTINUOUSLY by exactly one cell diagonally (linear,
 *  NON-`alternate`, DM-1298). The grid is periodic with period `cell`, so after a
 *  one-cell shift every dot sits where its neighbour was — the loop is seamless and
 *  the motion never backs out, reading as an endless drift. */
export function buildGridAnimations(p: BackgroundLoopParams, cell: number): Anims {
  return [{
    selector: ".gd-layer",
    property: "transform",
    from: "translate(0px, 0px)",
    to: `translate(${cell}px, ${cell}px)`,
    duration: p.durationMs,
    easing: "linear",
    repeat: "infinite",
  }];
}

interface Star {
  idx: number;
  color: string;
  left: number; top: number; size: number;
  twMs: number; twDelay: number; opacityLow: number;   // opacity twinkle
  scMs: number; scDelay: number; scaleLow: number;      // scale sparkle
}

/**
 * DM-1298 "star field": many small SHARP points (a white-hot core fading to a
 * coloured glow), each twinkling fast on its own clock. `count` is a density level
 * (× ~16, so the default 5 → ~80 stars). Pure + deterministic from the seed.
 */
export function planStars(p: BackgroundLoopParams): Star[] {
  const rnd = mulberry32(p.seed);
  const minDim = Math.min(p.width, p.height);
  const n = p.count * 16;
  const stars: Star[] = [];
  for (let i = 0; i < n; i++) {
    // `r³` skews toward small dots with the occasional big bright star.
    const r = rnd();
    const size = Math.round((0.0035 + r * r * r * 0.024) * minDim) + 2;
    const twMs = 700 + Math.round(rnd() * 2200);
    const scMs = 900 + Math.round(rnd() * 2400);
    stars.push({
      idx: i,
      color: p.colors[i % p.colors.length],
      left: Math.round(rnd() * p.width),
      top: Math.round(rnd() * p.height),
      size,
      twMs,
      twDelay: -Math.round(rnd() * twMs), // negative phase → already mid-twinkle at t=0
      opacityLow: 0.06 + rnd() * 0.22,
      scMs,
      scDelay: -Math.round(rnd() * scMs),
      scaleLow: 0.5 + rnd() * 0.3,
    });
  }
  return stars;
}

/** Standalone HTML for the star field. Each star is a sharp radial-gradient point
 *  (white core → coloured glow → transparent) in a positioned wrapper. Pure. */
export function buildStarsHtml(p: BackgroundLoopParams, stars: Star[]): string {
  const markup = stars
    .map(
      (s) =>
        `<div class="st-pos st-pos-${s.idx}" style="left:${s.left}px;top:${s.top}px;width:${s.size}px;height:${s.size}px">`
        + `<div class="st-star st-star-${s.idx}" style="background:radial-gradient(circle, #ffffff 0%, ${s.color} 38%, transparent 72%)"></div>`
        + `</div>`,
    )
    .join("\n  ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .st-pos { position: absolute; }
  .st-star { width: 100%; height: 100%; border-radius: 50%; }
</style></head>
<body>
  ${markup}
</body></html>`;
}

/** Two looping animations per star: a center-origin scale sparkle on the wrapper
 *  (DM-1297) and a wide, fast opacity twinkle on the inner point — different fast
 *  periods + negative phase offsets so the field shimmers, never in lockstep. */
export function buildStarsAnimations(stars: Star[]): Anims {
  const anims: Anims = [];
  for (const s of stars) {
    anims.push({
      selector: `.st-pos-${s.idx}`,
      property: "scale",
      from: s.scaleLow.toFixed(3),
      to: "1.18",
      duration: s.scMs,
      delay: s.scDelay,
      easing: "ease-in-out",
      repeat: "infinite",
      alternate: true,
      transformOrigin: "center",
    });
    anims.push({
      selector: `.st-star-${s.idx}`,
      property: "opacity",
      from: s.opacityLow.toFixed(3),
      to: "1",
      duration: s.twMs,
      delay: s.twDelay,
      easing: "ease-in-out",
      repeat: "infinite",
      alternate: true,
    });
  }
  return anims;
}

interface WaveLayer {
  idx: number;
  color: string;
  /** SVG path of a filled sine wave, 2× canvas wide (periodic over the canvas). */
  path: string;
  opacity: number;
  /** Full canvas-width horizontal pan; the period divides the canvas so a one-
   *  canvas-width shift wraps seamlessly. Speed varies per layer → parallax. */
  driftMs: number;
}

/** Build a filled sine-wave `<path>` spanning `width` px at vertical `baseline`,
 *  amplitude `amp`, wavelength `period`, filled down to `floor`. */
function sineWavePath(width: number, floor: number, baseline: number, amp: number, period: number): string {
  const step = Math.max(6, Math.round(period / 24));
  const pts: string[] = [];
  for (let x = 0; x <= width; x += step) {
    const y = baseline - amp * Math.sin((2 * Math.PI * x) / period);
    pts.push(`${x} ${y.toFixed(1)}`);
  }
  // Pin the final sample exactly at `width` so the tile closes cleanly.
  const lastY = (baseline - amp * Math.sin((2 * Math.PI * width) / period)).toFixed(1);
  pts.push(`${width} ${lastY}`);
  return `M ${pts[0]} ` + pts.slice(1).map((pt) => `L ${pt}`).join(" ") + ` L ${width} ${floor} L 0 ${floor} Z`;
}

/**
 * DM-1295/DM-1298 "wave": `count` layered sine-wave fills (back → front) that each
 * pan horizontally at a DIFFERENT speed for clear parallax. Each wave is 2× the
 * canvas wide with an integer number of periods across the canvas, so a one-
 * canvas-width pan wraps seamlessly. Front layers are lower, taller-amplitude, and
 * more opaque; back layers are higher, gentler, fainter. Pure + deterministic.
 */
export function planWaves(p: BackgroundLoopParams): WaveLayer[] {
  const rnd = mulberry32(p.seed);
  const layers: WaveLayer[] = [];
  const n = p.count;
  const w2 = p.width * 2;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1); // 0 = back, 1 = front
    const humps = 2 + Math.round(rnd() * 2) + Math.floor(t * 2); // front waves are busier
    const period = Math.round(p.width / humps);
    const amp = Math.round((0.035 + t * 0.05 + rnd() * 0.02) * p.height);
    const baseline = Math.round((0.34 + t * 0.4) * p.height);
    layers.push({
      idx: i,
      color: p.colors[i % p.colors.length],
      path: sineWavePath(w2, p.height, baseline, amp, period),
      opacity: 0.4 + t * 0.45,
      // Front (fast) → back (slow): clearly different speeds = obvious parallax.
      driftMs: Math.round(p.durationMs * (2.2 - t * 1.3) * (0.9 + rnd() * 0.2)),
    });
  }
  return layers;
}

/** Standalone HTML: each wave layer is a 2×-canvas-wide inline `<svg>` with the
 *  filled sine path, stacked back-to-front. Pure. */
export function buildWaveHtml(p: BackgroundLoopParams, layers: WaveLayer[]): string {
  const w2 = p.width * 2;
  const markup = layers
    .map(
      (l) =>
        `<div class="wv-layer wv-layer-${l.idx}" style="opacity:${l.opacity.toFixed(3)}">`
        + `<svg width="${w2}" height="${p.height}" viewBox="0 0 ${w2} ${p.height}" preserveAspectRatio="none">`
        + `<path d="${l.path}" fill="${l.color}"/></svg></div>`,
    )
    .join("\n  ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; }
  body { background: ${p.background}; position: relative; }
  .wv-layer { position: absolute; top: 0; left: 0; width: ${w2}px; height: ${p.height}px; }
</style></head>
<body>
  ${markup}
</body></html>`;
}

/** Pan each wave layer left by exactly one canvas width, continuously (linear,
 *  NON-`alternate`) — periodic, so it wraps seamlessly — at its own speed for
 *  parallax. */
export function buildWaveAnimations(p: BackgroundLoopParams, layers: WaveLayer[]): Anims {
  return layers.map((l) => ({
    selector: `.wv-layer-${l.idx}`,
    property: "transform",
    from: "translate(0px, 0px)",
    to: `translate(-${p.width}px, 0px)`,
    duration: l.driftMs,
    easing: "linear",
    repeat: "infinite",
  }));
}

/** A variant family's built HTML + intra-frame animations + log line. */
interface VariantBuild { html: string; animations: Anims; log: string }
type VariantFamily = "blob" | "stars" | "gradient-pan" | "wave" | "grid";

/** Map a variant name to its layout family. The blob layout backs several
 *  variant names (aurora / orbs); the others are 1:1. */
function variantFamily(v: BackgroundVariant): VariantFamily {
  if (BLOB_VARIANTS.has(v)) return "blob";
  if (v === "stars" || v === "gradient-pan" || v === "wave") return v;
  return "grid";
}

/** Dispatch table: each variant family lays out its own elements + animation
 *  builder. All share the origin-safe translate + opacity, `alternate`-looped
 *  contract (doc 71). Replaces the per-variant if/else chain (DM-1371). */
const VARIANT_BUILDERS: Record<VariantFamily, (p: BackgroundLoopParams) => VariantBuild> = {
  blob: (p) => {
    const blobs = planBlobs(p);
    return { html: buildBackgroundHtml(p, blobs), animations: buildBackgroundAnimations(blobs), log: `template background-loop: ${p.variant}, ${blobs.length} blobs, ${p.width}×${p.height}` };
  },
  stars: (p) => {
    const stars = planStars(p);
    return { html: buildStarsHtml(p, stars), animations: buildStarsAnimations(stars), log: `template background-loop: stars, ${stars.length} stars, ${p.width}×${p.height}` };
  },
  "gradient-pan": (p) => ({ html: buildGradientPanHtml(p), animations: buildGradientPanAnimations(p), log: `template background-loop: gradient-pan, ${p.colors.length} colors, ${p.width}×${p.height}` }),
  wave: (p) => {
    const layers = planWaves(p);
    return { html: buildWaveHtml(p, layers), animations: buildWaveAnimations(p, layers), log: `template background-loop: wave, ${layers.length} layers, ${p.width}×${p.height}` };
  },
  grid: (p) => {
    const grid = planGridDots(p);
    return { html: buildGridHtml(p, grid), animations: buildGridAnimations(p, grid.cell), log: `template background-loop: grid, ${grid.dots.length} dots, ${p.width}×${p.height}` };
  },
};

export const backgroundLoopTemplate: Template<BackgroundLoopParams> = {
  name: "background-loop",
  description: "Procedural seamlessly-looping animated background (drifting, breathing color blobs).",
  paramsSchema: backgroundLoopParamsSchema,
  brandDefaults(brand: Brand): Partial<BackgroundLoopParams> {
    return brandParams<BackgroundLoopParams>({
      background: brandBackground(brand),
      colors: brandSeriesColors(brand),
    });
  },
  async render(params: BackgroundLoopParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const built = VARIANT_BUILDERS[variantFamily(params.variant)](params);
    ctx.log(built.log);
    // Hold for one full base period (params.durationMs) so the looping reads in
    // the timeline; the variants loop infinitely.
    return runSingleFrameGenerator(ctx, {
      name: "background-loop",
      html: built.html,
      width: params.width,
      height: params.height,
      durationMs: params.durationMs,
      animations: built.animations,
    });
  },
};
