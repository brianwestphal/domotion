/**
 * Built-in template: chart (DM-1279, doc 75).
 *
 * A data/infographics generator — turn a few numbers into an animated bar,
 * column, or line chart. The clearest "params → motion" fit for the generator
 * contract: the values are laid out at author time and the bars grow / the line
 * draws in via Domotion's intra-frame `animations` (the `height` / `width` grow
 * properties for bars, a `clipPath` left-to-right reveal for the line).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

const CHART_TYPES = ["column", "bar", "line"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const DEFAULT_COLORS = ["#6366f1", "#22d3ee", "#ec4899", "#f59e0b", "#10b981", "#8b5cf6"];

/** Numbers as a JSON array OR a comma-separated string (so the CLI `--data` flag
 *  works — array params are otherwise JSON-only). */
const dataSchema = z
  .union([
    z.string().transform((s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))),
    z.array(z.number()),
  ])
  .pipe(z.array(z.number()).min(1));

/** Strings as a JSON array OR a comma-separated string. */
const stringsSchema = z.union([
  z.string().transform((s) => s.split(",").map((x) => x.trim())),
  z.array(z.string()),
]);

export const chartParamsSchema = z.object({
  type: z.enum(CHART_TYPES).default("column").describe('"column" (vertical bars) | "bar" (horizontal bars) | "line".'),
  data: dataSchema.describe("Values: a JSON array or a comma-separated string (required)."),
  labels: stringsSchema.optional().describe("Category labels (comma-separated or array); cycled if shorter than data."),
  title: z.string().optional().describe("Chart title shown above the plot."),
  colors: stringsSchema.default(DEFAULT_COLORS).describe("Series colors, cycled across the data (comma-separated or array)."),
  max: z.coerce.number().positive().optional().describe("Axis maximum (default: a nice round value above the largest datum)."),
  showValues: z.coerce.boolean().default(true).describe("Print each value at the end of its bar / point."),
  width: z.coerce.number().int().positive().default(1000).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(600).describe("Output height in px."),
  background: z.string().default("#0b1020").describe('Frame background (CSS color or "transparent").'),
  color: z.string().default("#e6edf3").describe("Text / axis color (CSS color)."),
  fontFamily: z.string().default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif").describe("CSS font-family."),
  growMs: z.coerce.number().int().positive().default(750).describe("Grow / draw duration per element in ms."),
  staggerMs: z.coerce.number().int().nonnegative().default(110).describe("Delay between bars in ms."),
  holdMs: z.coerce.number().int().positive().default(1800).describe("Hold time after the chart finishes in ms."),
});

export type ChartParams = z.infer<typeof chartParamsSchema>;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Round `v` up to a "nice" axis maximum (1 / 2 / 2.5 / 5 × 10ⁿ). */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Trim a value to a short label (no trailing `.0`). */
function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

interface BarRect {
  idx: number; color: string; label: string; value: number;
  left: number; top: number; width: number; height: number;
  /** value-label box (slot-wide for columns, after-bar for bars). */
  vLeft: number; vTop: number; vWidth: number; vAlign: "center" | "left";
  /** category-label box. */
  cLeft: number; cTop: number; cWidth: number; cHeight: number; cAlign: "center" | "right";
}

interface LinePlan { points: string; areaPath: string; dots: { cx: number; cy: number; color: string }[]; values: { x: number; y: number; value: number }[]; }

export interface ChartPlan {
  type: ChartType;
  maxVal: number;
  plot: { x: number; y: number; w: number; h: number };
  bars: BarRect[];
  line: LinePlan | null;
}

/** Lay out the chart geometry from the params. Pure — no browser. */
export function planChart(p: ChartParams): ChartPlan {
  const n = p.data.length;
  const maxVal = p.max ?? niceMax(Math.max(...p.data, 0));
  const label = (i: number): string => (p.labels != null && p.labels.length > 0 ? p.labels[i % p.labels.length] : "");
  const color = (i: number): string => p.colors[i % p.colors.length];

  const mTop = p.title != null && p.title !== "" ? 78 : 36;
  const mBottom = 52;
  const mLeft = p.type === "bar" ? Math.round(p.width * 0.16) : 40;
  const mRight = p.type === "bar" ? 64 : 28;
  const plot = { x: mLeft, y: mTop, w: p.width - mLeft - mRight, h: p.height - mTop - mBottom };

  const bars: BarRect[] = [];
  let line: LinePlan | null = null;

  if (p.type === "column") {
    const slot = plot.w / n;
    const barW = Math.min(slot * 0.62, 130);
    for (let i = 0; i < n; i++) {
      const h = Math.round((p.data[i] / maxVal) * plot.h);
      const left = Math.round(plot.x + i * slot + (slot - barW) / 2);
      bars.push({
        idx: i, color: color(i), label: label(i), value: p.data[i],
        left, top: plot.y + plot.h - h, width: Math.round(barW), height: h,
        vLeft: Math.round(plot.x + i * slot), vTop: plot.y + plot.h - h - 30, vWidth: Math.round(slot), vAlign: "center",
        cLeft: Math.round(plot.x + i * slot), cTop: plot.y + plot.h + 10, cWidth: Math.round(slot), cHeight: 34, cAlign: "center",
      });
    }
  } else if (p.type === "bar") {
    const slot = plot.h / n;
    const barH = Math.min(slot * 0.62, 90);
    for (let i = 0; i < n; i++) {
      const w = Math.round((p.data[i] / maxVal) * plot.w);
      const top = Math.round(plot.y + i * slot + (slot - barH) / 2);
      bars.push({
        idx: i, color: color(i), label: label(i), value: p.data[i],
        left: plot.x, top, width: w, height: Math.round(barH),
        vLeft: plot.x + w + 10, vTop: top, vWidth: mRight - 4, vAlign: "left",
        cLeft: 0, cTop: top, cWidth: mLeft - 12, cHeight: Math.round(barH), cAlign: "right",
      });
    }
  } else {
    // line
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? plot.x + plot.w / 2 : Math.round(plot.x + (i / (n - 1)) * plot.w);
      const y = Math.round(plot.y + plot.h - (p.data[i] / maxVal) * plot.h);
      pts.push({ x, y });
    }
    const points = pts.map((q) => `${q.x},${q.y}`).join(" ");
    const baseY = plot.y + plot.h;
    const areaPath = `M ${pts[0].x} ${baseY} ` + pts.map((q) => `L ${q.x} ${q.y}`).join(" ") + ` L ${pts[pts.length - 1].x} ${baseY} Z`;
    line = {
      points, areaPath,
      dots: pts.map((q, i) => ({ cx: q.x, cy: q.y, color: color(i) })),
      values: pts.map((q, i) => ({ x: q.x, y: q.y, value: p.data[i] })),
    };
    // category labels reuse the bars list as label boxes only.
    for (let i = 0; i < n; i++) {
      bars.push({
        idx: i, color: color(i), label: label(i), value: p.data[i],
        left: 0, top: 0, width: 0, height: 0,
        vLeft: 0, vTop: 0, vWidth: 0, vAlign: "center",
        cLeft: Math.round(pts[i].x - 60), cTop: plot.y + plot.h + 10, cWidth: 120, cHeight: 34, cAlign: "center",
      });
    }
  }

  return { type: p.type, maxVal, plot, bars, line };
}

/** Standalone HTML for the chart. Pure — unit-testable without a browser. */
export function buildChartHtml(p: ChartParams, plan: ChartPlan): string {
  const titleMarkup = p.title != null && p.title !== ""
    ? `<div class="ch-title">${escapeHtml(p.title)}</div>`
    : "";
  const axisColor = "rgba(255,255,255,0.16)";
  const subColor = "rgba(255,255,255,0.6)";

  // The baseline (column/line) or left axis (bar).
  const baseY = plan.plot.y + plan.plot.h;
  const axis = plan.type === "bar"
    ? `<div class="ch-axis" style="left:${plan.plot.x}px;top:${plan.plot.y}px;width:1px;height:${plan.plot.h}px"></div>`
    : `<div class="ch-axis" style="left:${plan.plot.x}px;top:${baseY}px;width:${plan.plot.w}px;height:1px"></div>`;

  let body = "";
  if (plan.type === "line" && plan.line != null) {
    const l = plan.line;
    const dots = l.dots.map((d, i) => `<circle class="ch-dot ch-dot-${i}" cx="${d.cx}" cy="${d.cy}" r="6" fill="${d.color}" stroke="${p.background}" stroke-width="3"/>`).join("");
    body += `<div class="ch-line-wrap ch-reveal">
      <svg width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">
        <path d="${l.areaPath}" fill="${p.colors[0]}" opacity="0.14"/>
        <polyline points="${l.points}" fill="none" stroke="${p.colors[0]}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
      </svg>
    </div>`;
    if (p.showValues) {
      body += l.values.map((v, i) => `<div class="ch-val ch-val-${i}" style="left:${v.x - 40}px;top:${v.y - 34}px;width:80px;text-align:center">${escapeHtml(fmt(v.value))}</div>`).join("");
    }
  } else {
    // Columns are anchored at the baseline (`bottom`) so the height grow rises
    // upward; horizontal bars are anchored at the left axis (`left`) so the width
    // grow extends rightward.
    const baselineBottom = p.height - baseY;
    body += plan.bars.map((b) => {
      const barStyle = plan.type === "column"
        ? `left:${b.left}px;bottom:${baselineBottom}px;width:${b.width}px;height:${b.height}px;background:${b.color}`
        : `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;background:${b.color}`;
      const val = p.showValues
        ? `<div class="ch-val ch-val-${b.idx}" style="left:${b.vLeft}px;top:${b.vTop}px;width:${b.vWidth}px;text-align:${b.vAlign};${b.vAlign === "left" ? `height:${b.height}px;display:flex;align-items:center` : ""}">${escapeHtml(fmt(b.value))}</div>`
        : "";
      return `<div class="ch-bar ch-bar-${b.idx}" style="${barStyle}"></div>${val}`;
    }).join("\n  ");
  }

  // Category labels (all types).
  const labels = plan.bars
    .filter((b) => b.label !== "")
    .map((b) => `<div class="ch-cat" style="left:${b.cLeft}px;top:${b.cTop}px;width:${b.cWidth}px;height:${b.cHeight}px;text-align:${b.cAlign};${b.cAlign === "right" ? "display:flex;align-items:center;justify-content:flex-end" : ""}">${escapeHtml(b.label)}</div>`)
    .join("\n  ");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body { background: ${p.background}; font-family: ${p.fontFamily}; color: ${p.color}; position: relative; }
  .ch-title { position: absolute; left: 40px; top: 26px; font-size: 30px; font-weight: 700; letter-spacing: -0.01em; }
  .ch-axis { position: absolute; background: ${axisColor}; }
  .ch-bar { position: absolute; border-radius: ${plan.type === "bar" ? "0 6px 6px 0" : "6px 6px 0 0"}; }
  .ch-val { position: absolute; font-size: 19px; font-weight: 600; }
  .ch-cat { position: absolute; font-size: 17px; font-weight: 500; color: ${subColor}; white-space: nowrap; overflow: hidden; }
  .ch-line-wrap { position: absolute; left: 0; top: 0; width: ${p.width}px; height: ${p.height}px; }
</style></head>
<body>
  ${titleMarkup}
  ${axis}
  ${body}
  ${labels}
</body></html>`;
}

type Anims = NonNullable<AnimateConfig["frames"][number]["animations"]>;

/** Grow each bar (height for columns, width for bars) or reveal the line, plus
 *  fade in the value labels / dots — all staggered. Pure. */
export function buildChartAnimations(p: ChartParams, plan: ChartPlan): Anims {
  const anims: Anims = [];
  const ease = "cubic-bezier(0.22,1,0.36,1)";

  if (plan.type === "line" && plan.line != null) {
    const n = plan.line.dots.length;
    const revealMs = p.growMs + (n - 1) * p.staggerMs;
    // Draw the line in left-to-right via a clipPath wipe.
    anims.push({
      selector: ".ch-reveal", property: "clipPath",
      from: "inset(0 100% 0 0)", to: "inset(0 0% 0 0)",
      duration: revealMs, easing: "linear",
    });
    // Dots + values pop as the wipe passes each point.
    for (let i = 0; i < n; i++) {
      const delay = n === 1 ? 0 : Math.round((i / (n - 1)) * revealMs);
      anims.push({ selector: `.ch-dot-${i}`, property: "scale", from: "0", to: "1", duration: 320, delay, easing: ease, transformOrigin: "center" });
      if (p.showValues) anims.push({ selector: `.ch-val-${i}`, property: "opacity", from: "0", to: "1", duration: 280, delay: delay + 120, easing: "ease-out" });
    }
    return anims;
  }

  for (const b of plan.bars) {
    const delay = b.idx * p.staggerMs;
    // Grow each bar from the axis: a column scales up from its bottom edge, a
    // horizontal bar scales out from its left edge. We use `scaleY` / `scaleX`
    // with `transformOrigin` (DM-1297) rather than animating `width`/`height` —
    // the intra-frame animation lands on a `<g>` wrapper, where CSS width/height
    // don't apply, but a transform does (and the origin pins it to the axis).
    anims.push({
      selector: `.ch-bar-${b.idx}`,
      property: "transform",
      from: plan.type === "bar" ? "scaleX(0)" : "scaleY(0)",
      to: plan.type === "bar" ? "scaleX(1)" : "scaleY(1)",
      duration: p.growMs,
      delay,
      easing: ease,
      transformOrigin: plan.type === "bar" ? "left" : "bottom",
    });
    if (p.showValues) {
      anims.push({ selector: `.ch-val-${b.idx}`, property: "opacity", from: "0", to: "1", duration: 280, delay: delay + p.growMs - 150, easing: "ease-out" });
    }
  }
  return anims;
}

/** Total play time: the last element finishes, then hold. */
export function chartDurationMs(p: ChartParams, plan: ChartPlan): number {
  const n = plan.type === "line" && plan.line != null ? plan.line.dots.length : plan.bars.length;
  const lastStart = Math.max(0, n - 1) * p.staggerMs;
  return lastStart + p.growMs + p.holdMs;
}

export const chartTemplate: Template<ChartParams> = {
  name: "chart",
  description: "Animated bar / column / line chart from a list of values (bars grow, lines draw in).",
  paramsSchema: chartParamsSchema,
  async render(params: ChartParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const plan = planChart(params);
    const htmlPath = join(ctx.workDir, "chart.html");
    writeFileSync(htmlPath, buildChartHtml(params, plan));
    ctx.log(`template chart: ${params.type}, ${params.data.length} points, ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "chart.html",
          duration: chartDurationMs(params, plan),
          transition: { type: "cut", duration: 0 },
          animations: buildChartAnimations(params, plan),
        },
      ],
    });
    return { svg, width: params.width, height: params.height, durationMs: chartDurationMs(params, plan) };
  },
};
