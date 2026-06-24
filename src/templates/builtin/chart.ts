/**
 * Built-in template: chart (DM-1279, doc 75; multi-series + axis scale DM-1301).
 *
 * A data/infographics generator — turn one or more series of numbers into an
 * animated column, bar, or line chart. The clearest "params → motion" fit for the
 * generator contract: the values are laid out at author time and the bars grow /
 * the line draws in via Domotion's intra-frame `animations` (a `scaleY`/`scaleX`
 * grow about the axis for bars, a `clipPath` left-to-right reveal for the line).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";

const CHART_TYPES = ["column", "bar", "line", "pie", "donut"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const DEFAULT_COLORS = ["#6366f1", "#22d3ee", "#ec4899", "#f59e0b", "#10b981", "#8b5cf6"];

/** One or more numeric series. Accepts a JSON `number[]` (one series), a JSON
 *  `number[][]` (multi-series), or a string: comma-separated values, with `;`
 *  separating series (so the CLI `--data "1,2,3;4,5,6"` works). Normalized to
 *  `number[][]`. */
const seriesSchema = z
  .union([
    z.string().transform((s) =>
      s.split(";").map((g) => g.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))),
    ),
    z.array(z.number()).transform((a) => [a]),
    z.array(z.array(z.number())),
  ])
  .pipe(z.array(z.array(z.number()).min(1)).min(1));

/** Strings as a JSON array OR a comma-separated string. */
const stringsSchema = z.union([
  z.string().transform((s) => s.split(",").map((x) => x.trim())),
  z.array(z.string()),
]);

export const chartParamsSchema = z.object({
  type: z.enum(CHART_TYPES).default("column").describe('"column" | "bar" | "line" | "pie" | "donut".'),
  data: seriesSchema.describe('Values: a JSON array, a 2D array for multi-series, or a string ("1,2,3" or "1,2;3,4").'),
  labels: stringsSchema.optional().describe("Category labels (comma-separated or array); cycled if shorter than the data."),
  seriesNames: stringsSchema.optional().describe("Legend names, one per series (multi-series only)."),
  layout: z.enum(["grouped", "stacked"]).default("grouped").describe("Multi-series bars: side-by-side (grouped) or stacked."),
  title: z.string().optional().describe("Chart title shown above the plot."),
  colors: stringsSchema.default(DEFAULT_COLORS).describe("Colors: per-series when multi-series, else per-bar (comma-separated or array)."),
  max: z.coerce.number().positive().optional().describe("Axis maximum (default: a nice round value above the largest datum)."),
  yTicks: z.coerce.number().int().nonnegative().default(4).describe("Value-axis gridline / tick divisions (0 disables the scale)."),
  showValues: z.coerce.boolean().default(true).describe("Print each value at the end of its bar / point (single series only)."),
  width: z.coerce.number().int().positive().default(1000).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(600).describe("Output height in px."),
  background: z.string().default("#0b1020").describe('Frame background (CSS color or "transparent").'),
  color: z.string().default("#e6edf3").describe("Text / axis color (CSS color)."),
  fontFamily: z.string().default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif").describe("CSS font-family."),
  growMs: z.coerce.number().int().positive().default(750).describe("Grow / draw duration per element in ms."),
  staggerMs: z.coerce.number().int().nonnegative().default(110).describe("Delay between categories in ms."),
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

/** A point on a circle, `deg` measured clockwise from 12 o'clock. */
function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: Math.round((cx + r * Math.sin(a)) * 100) / 100, y: Math.round((cy - r * Math.cos(a)) * 100) / 100 };
}

/** SVG path for a pie wedge (`ri = 0`) or a donut ring segment, clockwise. */
function arcPath(cx: number, cy: number, r: number, ri: number, start: number, end: number): string {
  const large = end - start > 180 ? 1 : 0;
  const o1 = polar(cx, cy, r, start), o2 = polar(cx, cy, r, end);
  if (ri <= 0) return `M ${cx} ${cy} L ${o1.x} ${o1.y} A ${r} ${r} 0 ${large} 1 ${o2.x} ${o2.y} Z`;
  const i2 = polar(cx, cy, ri, end), i1 = polar(cx, cy, ri, start);
  return `M ${o1.x} ${o1.y} A ${r} ${r} 0 ${large} 1 ${o2.x} ${o2.y} L ${i2.x} ${i2.y} A ${ri} ${ri} 0 ${large} 0 ${i1.x} ${i1.y} Z`;
}

/** A single bar / stack-segment, in px. `catIdx` drives the grow stagger. */
interface BarRect { catIdx: number; color: string; left: number; top: number; width: number; height: number; }
/** A stacked-category container that grows as one unit (so segments rise together). */
interface StackBox { catIdx: number; left: number; top: number; width: number; height: number; segments: { color: string; offset: number; size: number }[]; }
interface SeriesLine { seriesIdx: number; color: string; points: string; areaPath: string | null; dots: { cx: number; cy: number }[]; }
interface GridLine { x1: number; y1: number; x2: number; y2: number; label: string; lLeft: number; lTop: number; lWidth: number; lHeight: number; lAlign: "right" | "center"; }
interface Box { text: string; left: number; top: number; width: number; height: number; align: "center" | "right" | "left"; }
interface PieSlice { path: string; color: string; }

export interface ChartPlan {
  type: ChartType;
  stacked: boolean;
  maxVal: number;
  plot: { x: number; y: number; w: number; h: number };
  bars: BarRect[];          // grouped bars (and single-series)
  stacks: StackBox[];       // stacked categories
  lines: SeriesLine[];      // line series
  slices: PieSlice[];       // pie / donut slices
  pie: { cx: number; cy: number; r: number } | null;
  gridlines: GridLine[];
  catLabels: Box[];
  valueLabels: Box[];
  legend: { name: string; color: string }[];
}

/** Lay out the chart geometry from the params. Pure — no browser. */
export function planChart(p: ChartParams): ChartPlan {
  const series = p.data;
  const nSeries = series.length;
  const nCats = Math.max(...series.map((s) => s.length));
  const multi = nSeries > 1;
  const stacked = multi && p.layout === "stacked" && p.type !== "line";
  const val = (s: number, c: number): number => series[s][c] ?? 0;
  const colorOf = (s: number, c: number): string => p.colors[(multi ? s : c) % p.colors.length];
  const catLabel = (c: number): string => (p.labels != null && p.labels.length > 0 ? p.labels[c % p.labels.length] : "");

  // Pie / donut: one series of slices, each an arc path, with a legend of
  // label + percentage. No axes / gridlines.
  if (p.type === "pie" || p.type === "donut") {
    const vals = series[0].map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const hasLegend = vals.length > 0;
    const legendW = hasLegend ? Math.min(280, Math.round(p.width * 0.32)) : 0;
    const top = p.title != null && p.title !== "" ? 70 : 20;
    const areaW = p.width - legendW;
    const r = Math.round(Math.min(areaW, p.height - top - 24) / 2 - 8);
    const cx = Math.round(areaW / 2);
    const cy = Math.round(top + (p.height - top) / 2);
    const ri = p.type === "donut" ? Math.round(r * 0.58) : 0;
    const slices: PieSlice[] = [];
    const pieLegend: { name: string; color: string }[] = [];
    let acc = 0;
    vals.forEach((v, i) => {
      const start = (acc / total) * 360;
      acc += v;
      const end = (acc / total) * 360;
      slices.push({ path: arcPath(cx, cy, r, ri, start, Math.max(end, start + 0.0001)), color: p.colors[i % p.colors.length] });
      const pct = Math.round((v / total) * 1000) / 10;
      pieLegend.push({ name: `${catLabel(i) || `Slice ${i + 1}`} · ${pct}%`, color: p.colors[i % p.colors.length] });
    });
    return {
      type: p.type, stacked: false, maxVal: total,
      plot: { x: 0, y: top, w: areaW, h: p.height - top }, bars: [], stacks: [], lines: [],
      slices, pie: { cx, cy, r }, gridlines: [], catLabels: [], valueLabels: [], legend: pieLegend,
    };
  }

  // Axis maximum: stacked uses per-category totals; everything else the largest datum.
  const peak = stacked
    ? Math.max(...Array.from({ length: nCats }, (_, c) => series.reduce((sum, _s, s) => sum + val(s, c), 0)), 0)
    : Math.max(...series.flat(), 0);
  const maxVal = p.max ?? niceMax(peak);

  const legend = multi
    ? series.map((_s, s) => ({ name: p.seriesNames?.[s] ?? `Series ${s + 1}`, color: p.colors[s % p.colors.length] }))
    : [];

  const mTop = (p.title != null && p.title !== "" ? 64 : 24) + (legend.length > 0 ? 38 : 0);
  const valueAxisX = p.type === "bar"; // bar's value axis runs horizontally
  const mLeft = p.type === "bar" ? Math.round(p.width * 0.17) : p.yTicks > 0 ? 62 : 36;
  const mRight = p.type === "bar" ? (multi ? 28 : 58) : 28;
  const mBottom = 52;
  const plot = { x: mLeft, y: mTop, w: p.width - mLeft - mRight, h: p.height - mTop - mBottom };
  const showVals = p.showValues && !multi; // per-bar labels only read cleanly for one series

  const bars: BarRect[] = [];
  const stacks: StackBox[] = [];
  const lines: SeriesLine[] = [];
  const catLabels: Box[] = [];
  const valueLabels: Box[] = [];
  const gridlines: GridLine[] = [];

  // Value-axis gridlines + tick labels.
  for (let k = 0; p.yTicks > 0 && k <= p.yTicks; k++) {
    const frac = k / p.yTicks;
    const label = fmt(maxVal * frac);
    if (valueAxisX) {
      const x = Math.round(plot.x + frac * plot.w);
      gridlines.push({ x1: x, y1: plot.y, x2: x, y2: plot.y + plot.h, label, lLeft: x - 50, lTop: plot.y + plot.h + 8, lWidth: 100, lHeight: 24, lAlign: "center" });
    } else {
      const y = Math.round(plot.y + plot.h - frac * plot.h);
      gridlines.push({ x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, label, lLeft: 0, lTop: y - 12, lWidth: mLeft - 12, lHeight: 24, lAlign: "right" });
    }
  }

  if (p.type === "line") {
    for (let s = 0; s < nSeries; s++) {
      const pts: { x: number; y: number }[] = [];
      for (let c = 0; c < nCats; c++) {
        const x = nCats === 1 ? plot.x + plot.w / 2 : Math.round(plot.x + (c / (nCats - 1)) * plot.w);
        const y = Math.round(plot.y + plot.h - (val(s, c) / maxVal) * plot.h);
        pts.push({ x, y });
      }
      const baseY = plot.y + plot.h;
      lines.push({
        seriesIdx: s,
        color: p.colors[s % p.colors.length],
        points: pts.map((q) => `${q.x},${q.y}`).join(" "),
        areaPath: multi ? null : `M ${pts[0].x} ${baseY} ` + pts.map((q) => `L ${q.x} ${q.y}`).join(" ") + ` L ${pts[pts.length - 1].x} ${baseY} Z`,
        dots: pts.map((q) => ({ cx: q.x, cy: q.y })),
      });
      if (showVals) {
        pts.forEach((q, c) => valueLabels.push({ text: fmt(val(s, c)), left: q.x - 40, top: q.y - 34, width: 80, height: 22, align: "center" }));
      }
    }
    // Category labels under each point (x positions shared across series).
    for (let c = 0; c < nCats; c++) {
      const x = nCats === 1 ? plot.x + plot.w / 2 : Math.round(plot.x + (c / (nCats - 1)) * plot.w);
      catLabels.push({ text: catLabel(c), left: x - 60, top: plot.y + plot.h + 10, width: 120, height: 34, align: "center" });
    }
  } else if (p.type === "column") {
    const slot = plot.w / nCats;
    const groupW = Math.min(slot * 0.7, multi ? slot * 0.7 : 130);
    for (let c = 0; c < nCats; c++) {
      const gx = plot.x + c * slot + (slot - groupW) / 2;
      if (stacked) {
        let below = 0;
        const segs: { color: string; offset: number; size: number }[] = [];
        for (let s = 0; s < nSeries; s++) {
          const h = Math.round((val(s, c) / maxVal) * plot.h);
          segs.push({ color: colorOf(s, c), offset: below, size: h });
          below += h;
        }
        stacks.push({ catIdx: c, left: Math.round(gx), top: Math.round(plot.y + plot.h - below), width: Math.round(groupW), height: below, segments: segs });
      } else {
        const bw = groupW / nSeries;
        for (let s = 0; s < nSeries; s++) {
          const h = Math.round((val(s, c) / maxVal) * plot.h);
          bars.push({ catIdx: c, color: colorOf(s, c), left: Math.round(gx + s * bw), top: plot.y + plot.h - h, width: Math.round(bw), height: h });
          if (showVals) valueLabels.push({ text: fmt(val(s, c)), left: Math.round(gx + s * bw - 10), top: plot.y + plot.h - h - 30, width: Math.round(bw + 20), height: 24, align: "center" });
        }
      }
      catLabels.push({ text: catLabel(c), left: Math.round(plot.x + c * slot), top: plot.y + plot.h + 10, width: Math.round(slot), height: 34, align: "center" });
    }
  } else {
    // bar (horizontal)
    const slot = plot.h / nCats;
    const groupH = Math.min(slot * 0.7, multi ? slot * 0.7 : 90);
    for (let c = 0; c < nCats; c++) {
      const gy = plot.y + c * slot + (slot - groupH) / 2;
      if (stacked) {
        let left = 0;
        const segs: { color: string; offset: number; size: number }[] = [];
        for (let s = 0; s < nSeries; s++) {
          const w = Math.round((val(s, c) / maxVal) * plot.w);
          segs.push({ color: colorOf(s, c), offset: left, size: w });
          left += w;
        }
        stacks.push({ catIdx: c, left: plot.x, top: Math.round(gy), width: left, height: Math.round(groupH), segments: segs });
      } else {
        const bh = groupH / nSeries;
        for (let s = 0; s < nSeries; s++) {
          const w = Math.round((val(s, c) / maxVal) * plot.w);
          bars.push({ catIdx: c, color: colorOf(s, c), left: plot.x, top: Math.round(gy + s * bh), width: w, height: Math.round(bh) });
          if (showVals) valueLabels.push({ text: fmt(val(s, c)), left: plot.x + w + 10, top: Math.round(gy + s * bh), width: mRight - 4, height: Math.round(bh), align: "left" });
        }
      }
      catLabels.push({ text: catLabel(c), left: 0, top: Math.round(gy), width: mLeft - 12, height: Math.round(groupH), align: "right" });
    }
  }

  return { type: p.type, stacked, maxVal, plot, bars, stacks, lines, slices: [], pie: null, gridlines, catLabels, valueLabels, legend };
}

/** Standalone HTML for the chart. Pure — unit-testable without a browser. */
export function buildChartHtml(p: ChartParams, plan: ChartPlan): string {
  const titleMarkup = p.title != null && p.title !== "" ? `<div class="ch-title">${escapeHtml(p.title)}</div>` : "";
  const subColor = "rgba(255,255,255,0.6)";
  const gridColor = "rgba(255,255,255,0.10)";

  const isPie = plan.type === "pie" || plan.type === "donut";
  const legend = plan.legend.length === 0
    ? ""
    : isPie
      // Vertical legend down the right side (label + percentage).
      ? `<div class="ch-legend-v">${plan.legend
          .map((l) => `<span class="ch-leg"><span class="ch-swatch" style="background:${l.color}"></span>${escapeHtml(l.name)}</span>`)
          .join("")}</div>`
      : `<div class="ch-legend" style="top:${p.title != null && p.title !== "" ? 56 : 16}px">${plan.legend
          .map((l) => `<span class="ch-leg"><span class="ch-swatch" style="background:${l.color}"></span>${escapeHtml(l.name)}</span>`)
          .join("")}</div>`;

  const grid = plan.gridlines
    .map((g) => {
      const lineW = Math.max(1, g.x2 - g.x1) || 1;
      const lineH = Math.max(1, g.y2 - g.y1) || 1;
      const line = `<div class="ch-grid" style="left:${g.x1}px;top:${g.y1}px;width:${g.x2 === g.x1 ? 1 : lineW}px;height:${g.y2 === g.y1 ? 1 : lineH}px"></div>`;
      const lab = `<div class="ch-tick" style="left:${g.lLeft}px;top:${g.lTop}px;width:${g.lWidth}px;height:${g.lHeight}px;text-align:${g.lAlign};${g.lAlign === "right" ? "display:flex;align-items:center;justify-content:flex-end" : ""}">${escapeHtml(g.label)}</div>`;
      return line + lab;
    })
    .join("");

  let body = "";
  if (isPie) {
    const paths = plan.slices
      .map((s, i) => `<path class="ch-pie-slice ch-pie-slice-${i}" d="${s.path}" fill="${s.color}" stroke="${p.background}" stroke-width="2"/>`)
      .join("");
    body += `<div class="ch-pie-wrap"><svg width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}"><g class="ch-pie-group">${paths}</g></svg></div>`;
  } else if (plan.type === "line") {
    const svgInner = plan.lines
      .map((l) => {
        const area = l.areaPath != null ? `<path d="${l.areaPath}" fill="${l.color}" opacity="0.14"/>` : "";
        const dots = l.dots.map((d, i) => `<circle class="ch-dot ch-dot-${l.seriesIdx}-${i}" cx="${d.cx}" cy="${d.cy}" r="6" fill="${l.color}" stroke="${p.background}" stroke-width="3"/>`).join("");
        return `<g class="ch-reveal ch-reveal-${l.seriesIdx}">${area}<polyline points="${l.points}" fill="none" stroke="${l.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>${dots}</g>`;
      })
      .join("");
    body += `<div class="ch-line-wrap"><svg width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">${svgInner}</svg></div>`;
  } else if (plan.stacked) {
    body += plan.stacks
      .map((st) => {
        const segs = st.segments
          .map((sg) => plan.type === "column"
            ? `<div class="ch-seg" style="left:0;bottom:${sg.offset}px;width:100%;height:${sg.size}px;background:${sg.color}"></div>`
            : `<div class="ch-seg" style="top:0;left:${sg.offset}px;height:100%;width:${sg.size}px;background:${sg.color}"></div>`)
          .join("");
        return `<div class="ch-stack ch-stack-${st.catIdx}" style="left:${st.left}px;top:${st.top}px;width:${st.width}px;height:${st.height}px">${segs}</div>`;
      })
      .join("\n  ");
  } else {
    body += plan.bars
      .map((b, i) => {
        const anchor = plan.type === "column"
          ? `left:${b.left}px;bottom:${p.height - (plan.plot.y + plan.plot.h)}px;width:${b.width}px;height:${b.height}px`
          : `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px`;
        return `<div class="ch-bar ch-bar-${i}" style="${anchor};background:${b.color}"></div>`;
      })
      .join("\n  ");
  }

  const valueMarkup = plan.valueLabels
    .map((v, i) => `<div class="ch-val ch-val-${i}" style="left:${v.left}px;top:${v.top}px;width:${v.width}px;text-align:${v.align};${v.align === "left" ? `height:${v.height}px;display:flex;align-items:center` : ""}">${escapeHtml(v.text)}</div>`)
    .join("\n  ");
  const catMarkup = plan.catLabels
    .filter((b) => b.text !== "")
    .map((b) => `<div class="ch-cat" style="left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;text-align:${b.align};${b.align === "right" ? "display:flex;align-items:center;justify-content:flex-end" : ""}">${escapeHtml(b.text)}</div>`)
    .join("\n  ");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body { background: ${p.background}; font-family: ${p.fontFamily}; color: ${p.color}; position: relative; }
  .ch-title { position: absolute; left: 40px; top: 22px; font-size: 30px; font-weight: 700; letter-spacing: -0.01em; }
  .ch-legend { position: absolute; right: 40px; display: flex; gap: 20px; font-size: 17px; color: ${subColor}; }
  .ch-leg { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .ch-swatch { width: 15px; height: 15px; border-radius: 4px; display: inline-block; }
  .ch-grid { position: absolute; background: ${gridColor}; }
  .ch-tick { position: absolute; font-size: 15px; color: ${subColor}; }
  .ch-bar { position: absolute; border-radius: ${plan.type === "bar" ? "0 5px 5px 0" : "5px 5px 0 0"}; }
  .ch-stack { position: absolute; overflow: hidden; border-radius: ${plan.type === "bar" ? "0 5px 5px 0" : "5px 5px 0 0"}; }
  .ch-seg { position: absolute; }
  .ch-val { position: absolute; font-size: 19px; font-weight: 600; }
  .ch-cat { position: absolute; font-size: 17px; font-weight: 500; color: ${subColor}; white-space: nowrap; overflow: hidden; }
  .ch-line-wrap, .ch-pie-wrap { position: absolute; left: 0; top: 0; width: ${p.width}px; height: ${p.height}px; }
  .ch-legend-v { position: absolute; right: 44px; top: 0; height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 16px; font-size: 19px; color: ${p.color}; }
  .ch-pie-group { transform-box: fill-box; transform-origin: center; }
</style></head>
<body>
  ${titleMarkup}
  ${legend}
  ${grid}
  ${body}
  ${valueMarkup}
  ${catMarkup}
</body></html>`;
}

type Anims = NonNullable<AnimateConfig["frames"][number]["animations"]>;

/** Per-slice fade delay for the pie/donut sweep. */
const PIE_SLICE_STAGGER = 90;

/** Grow each bar / stack from the axis (scaleY for columns, scaleX for bars) or
 *  reveal each line, plus fade the value labels / pop the dots — staggered by
 *  category. Pure. */
export function buildChartAnimations(p: ChartParams, plan: ChartPlan): Anims {
  const anims: Anims = [];
  const ease = "cubic-bezier(0.22,1,0.36,1)";
  const grow = (sel: string, catIdx: number): void => {
    anims.push({
      selector: sel, property: "transform",
      from: plan.type === "bar" ? "scaleX(0)" : "scaleY(0)",
      to: plan.type === "bar" ? "scaleX(1)" : "scaleY(1)",
      duration: p.growMs, delay: catIdx * p.staggerMs, easing: ease,
      transformOrigin: plan.type === "bar" ? "left" : "bottom",
    });
  };

  if (plan.type === "pie" || plan.type === "donut") {
    // The pie spins + scales into place as one group, while the slices fade in
    // staggered clockwise — a sweep.
    anims.push({ selector: ".ch-pie-group", property: "transform", from: "scale(0.3) rotate(-22deg)", to: "scale(1) rotate(0deg)", duration: 640, easing: "cubic-bezier(0.34,1.56,0.64,1)", transformOrigin: "center" });
    plan.slices.forEach((_s, i) => {
      anims.push({ selector: `.ch-pie-slice-${i}`, property: "opacity", from: "0", to: "1", duration: 260, delay: i * PIE_SLICE_STAGGER, easing: "ease-out" });
    });
    return anims;
  }

  if (plan.type === "line") {
    for (const l of plan.lines) {
      const n = l.dots.length;
      const revealMs = p.growMs + Math.max(0, n - 1) * p.staggerMs;
      anims.push({ selector: `.ch-reveal-${l.seriesIdx}`, property: "clipPath", from: "inset(0 100% 0 0)", to: "inset(0 0% 0 0)", duration: revealMs, easing: "linear" });
      for (let i = 0; i < n; i++) {
        const delay = n === 1 ? 0 : Math.round((i / (n - 1)) * revealMs);
        anims.push({ selector: `.ch-dot-${l.seriesIdx}-${i}`, property: "scale", from: "0", to: "1", duration: 320, delay, easing: ease, transformOrigin: "center" });
      }
    }
  } else if (plan.stacked) {
    for (const st of plan.stacks) grow(`.ch-stack-${st.catIdx}`, st.catIdx);
  } else {
    plan.bars.forEach((b, i) => grow(`.ch-bar-${i}`, b.catIdx));
  }

  if (!plan.stacked) {
    plan.valueLabels.forEach((_v, i) => {
      // value labels track their bar's category; approximate via even spread.
      const delay = Math.round((i / Math.max(1, plan.valueLabels.length)) * (plan.catLabels.length * p.staggerMs)) + p.growMs - 150;
      anims.push({ selector: `.ch-val-${i}`, property: "opacity", from: "0", to: "1", duration: 280, delay: Math.max(0, delay), easing: "ease-out" });
    });
  }
  return anims;
}

/** Total play time: the last category finishes, then hold. */
export function chartDurationMs(p: ChartParams, plan: ChartPlan): number {
  if (plan.type === "pie" || plan.type === "donut") {
    const sweep = Math.max(640, Math.max(0, plan.slices.length - 1) * PIE_SLICE_STAGGER + 260);
    return sweep + p.holdMs;
  }
  const cats = plan.type === "line" ? Math.max(...plan.lines.map((l) => l.dots.length), 1) : plan.catLabels.length;
  const lastStart = Math.max(0, cats - 1) * p.staggerMs;
  return lastStart + p.growMs + p.holdMs;
}

export const chartTemplate: Template<ChartParams> = {
  name: "chart",
  description: "Animated column / bar / line chart from one or more series (bars grow, lines draw in).",
  paramsSchema: chartParamsSchema,
  async render(params: ChartParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const plan = planChart(params);
    const htmlPath = join(ctx.workDir, "chart.html");
    writeFileSync(htmlPath, buildChartHtml(params, plan));
    ctx.log(`template chart: ${params.type}, ${params.data.length} series × ${params.data[0].length}, ${params.width}×${params.height}`);

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
