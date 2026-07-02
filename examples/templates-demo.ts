/**
 * Example: render one self-contained SVG per built-in template concept (DM-1276,
 * DM-1280, DM-1277). Covers every unique concept/variant of the four built-ins:
 *
 *   lower-third     → dark + light themes (different corners)
 *   device-mockup   → phone + browser + window bezels (each a distinct device)
 *   background-loop → aurora + orbs + stars + gradient-pan + grid + wave variants
 *   kinetic-text    → rise + slide(char) + fade + clip + pop variants
 *   chart           → column + bar + line
 *   chat            → a message thread with staggered pop-in
 *   subscribe       → a follow/subscribe pop-up with a pulsing CTA
 *   title-card      → full-bleed intro card (creative pack)
 *   quote           → pull-quote / testimonial (creative pack)
 *   caption         → subtitle strip for compositing (creative pack)
 *   cta             → closing end-card with a pulsing button (creative pack)
 *   counter         → odometer number-ticker / countdown / timer (creative pack)
 *   stat            → KPI callout with a trend chip (creative pack)
 *   compare         → before/after clip-wipe with a divider + labels (creative pack)
 *
 * Outputs land in examples/output/templates/. Uses ONLY the public template API
 * (`renderTemplateToSvg` + `loadTemplate`) the way a consumer would.
 *
 * Usage: npx tsx examples/templates-demo.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  launchChromium,
  renderTemplateToSvg,
  resolveFormat,
  applyFormatSize,
  loadBrand,
  type Brand,
  lowerThirdTemplate,
  deviceMockupTemplate,
  backgroundLoopTemplate,
  kineticTextTemplate,
  chartTemplate,
  chatTemplate,
  subscribeTemplate,
  titleCardTemplate,
  quoteTemplate,
  captionTemplate,
  ctaTemplate,
  counterTemplate,
  statTemplate,
  compareTemplate,
  type Template,
} from "../src/index.js";
import { optimizeSvg } from "./shared.js";

const OUT_DIR = resolve("examples/output/templates");
const SAMPLE_APP = resolve("examples/templates/sample-app.html");
const ACME_BRAND: Brand = loadBrand(resolve("examples/templates/acme-brand.json"));

// One entry per unique concept we want a committed example SVG for. An optional
// `format` mirrors the CLI's `--format` (DM-1534): it sizes the canvas (unless
// params already pin width/height) and passes a safe-area inset to the render.
const EXAMPLES: Array<{ file: string; template: Template; params: Record<string, unknown>; format?: string; brand?: Brand }> = [
  // lower-third — the banner concept, shown in both themes / corners.
  {
    file: "lower-third-dark",
    template: lowerThirdTemplate,
    params: {
      title: "Ada Lovelace", subtitle: "First Programmer · 1843", accent: "#22d3ee",
      theme: "dark", position: "bottom-left",
      background: "linear-gradient(135deg, #1e293b, #0f172a)",
    },
  },
  {
    file: "lower-third-light",
    template: lowerThirdTemplate,
    params: {
      title: "Live from London", subtitle: "Acme News Network", accent: "#ef4444",
      theme: "light", position: "bottom-right",
      background: "linear-gradient(135deg, #e2e8f0, #cbd5e1)",
    },
  },

  // device-mockup — three distinct device bezels around the same sample app.
  {
    file: "device-mockup-phone",
    template: deviceMockupTemplate,
    params: { input: SAMPLE_APP, device: "phone", width: 390, height: 760, mobile: true },
  },
  {
    file: "device-mockup-browser",
    template: deviceMockupTemplate,
    params: { input: SAMPLE_APP, device: "browser", label: "acme.dev/dashboard", width: 1000, height: 600 },
  },
  {
    file: "device-mockup-window",
    template: deviceMockupTemplate,
    params: { input: SAMPLE_APP, device: "window", label: "Acme — Dashboard", width: 900, height: 560 },
  },

  // background-loop — the looping-background variants.
  {
    file: "background-loop-aurora",
    template: backgroundLoopTemplate,
    params: { variant: "aurora", width: 1280, height: 720, seed: 4 },
  },
  {
    file: "background-loop-orbs",
    template: backgroundLoopTemplate,
    params: { variant: "orbs", colors: ["#f43f5e", "#fb923c", "#facc15"], count: 7, width: 1280, height: 720, seed: 2 },
  },
  {
    file: "background-loop-stars",
    template: backgroundLoopTemplate,
    params: { variant: "stars", colors: ["#ffffff", "#bcd2ff", "#a5b4fc", "#fde68a"], background: "#05060f", width: 1280, height: 720, seed: 5 },
  },
  {
    file: "background-loop-gradient-pan",
    template: backgroundLoopTemplate,
    params: { variant: "gradient-pan", colors: ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"], width: 1280, height: 720 },
  },
  {
    file: "background-loop-grid",
    template: backgroundLoopTemplate,
    params: { variant: "grid", colors: ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"], width: 1280, height: 720 },
  },
  {
    file: "background-loop-wave",
    template: backgroundLoopTemplate,
    params: { variant: "wave", colors: ["#1e3a8a", "#0e7490", "#0891b2", "#22d3ee", "#67e8f9"], background: "#041020", width: 1280, height: 720, seed: 7 },
  },

  // kinetic-text — the three reveal styles (slide shown per-character).
  {
    file: "kinetic-text-rise",
    template: kineticTextTemplate,
    params: { text: "Ship faster with Domotion", variant: "rise", width: 1280, height: 720 },
  },
  {
    file: "kinetic-text-slide-char",
    template: kineticTextTemplate,
    params: { text: "MOTION", variant: "slide", by: "char", fontSize: 160, width: 1280, height: 720 },
  },
  {
    file: "kinetic-text-fade",
    template: kineticTextTemplate,
    params: { text: "Designed in the browser", variant: "fade", width: 1280, height: 720 },
  },
  {
    file: "kinetic-text-clip",
    template: kineticTextTemplate,
    params: { text: "Wipe to reveal", variant: "clip", width: 1280, height: 720 },
  },
  {
    // Multi-line (\n) + inline emphasis tags (<b>, <i>, <font color>).
    file: "kinetic-text-emphasis",
    template: kineticTextTemplate,
    params: {
      text: 'Build <font color="#22d3ee">motion</font>\\nright in the <i>browser</i>',
      variant: "rise", width: 1280, height: 720,
    },
  },
  {
    // pop — a per-character center-origin scale-up with overshoot (DM-1297).
    file: "kinetic-text-pop",
    template: kineticTextTemplate,
    params: { text: "POP!", variant: "pop", by: "char", fontSize: 200, width: 1280, height: 720 },
  },

  // chart — the three chart types (DM-1279), bars grow / line draws in.
  {
    file: "chart-column",
    template: chartTemplate,
    params: { type: "column", data: [42, 68, 55, 90, 34, 76], labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], title: "Monthly signups", width: 1100, height: 640 },
  },
  {
    file: "chart-bar",
    template: chartTemplate,
    params: { type: "bar", data: [120, 88, 64, 40], labels: ["Search", "Direct", "Social", "Email"], title: "Traffic by source", width: 1100, height: 560 },
  },
  {
    file: "chart-line",
    template: chartTemplate,
    params: { type: "line", data: [12, 18, 15, 28, 24, 38, 44], labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], title: "Daily active users", width: 1100, height: 600 },
  },
  {
    // grouped multi-series + legend + y-axis scale (DM-1301).
    file: "chart-grouped",
    template: chartTemplate,
    params: { type: "column", data: [[42, 68, 55], [30, 52, 71]], labels: ["Q1", "Q2", "Q3"], seriesNames: ["2024", "2025"], layout: "grouped", title: "Revenue by quarter", width: 1100, height: 620 },
  },
  {
    // stacked multi-series (DM-1301).
    file: "chart-stacked",
    template: chartTemplate,
    params: { type: "column", data: [[20, 35, 30, 28], [15, 25, 40, 22], [10, 15, 20, 30]], labels: ["Mon", "Tue", "Wed", "Thu"], seriesNames: ["Email", "Social", "Direct"], layout: "stacked", title: "Traffic by channel", width: 1100, height: 620 },
  },
  {
    // donut with a legend of label + percentage (DM-1300).
    file: "chart-donut",
    template: chartTemplate,
    params: { type: "donut", data: [42, 28, 18, 12], labels: ["Search", "Direct", "Social", "Email"], title: "Traffic sources", width: 1100, height: 620 },
  },

  // chat — a message thread whose bubbles pop in one at a time (DM-1278).
  {
    file: "chat-thread",
    template: chatTemplate,
    params: {
      title: "Sam",
      messages: [
        { from: "them", text: "Did the new build go out? 🚀" },
        { from: "me", text: "Yep — just shipped it" },
        { from: "them", text: "Nice. How's the SVG size?" },
        { from: "me", text: "Half what it was. Self-contained too" },
        { from: "them", text: "Amazing 🙌" },
      ],
      width: 560, height: 760,
    },
  },

  // subscribe — a follow/subscribe pop-up with a pulsing CTA (DM-1278).
  {
    file: "subscribe-youtube",
    template: subscribeTemplate,
    params: { name: "Domotion", subtitle: "1.2M subscribers", action: "Subscribe", accent: "#ff0000", width: 760, height: 360 },
  },
  {
    file: "subscribe-follow-dark",
    template: subscribeTemplate,
    params: { name: "Ada Lovelace", subtitle: "@ada · 89.4K followers", action: "Follow", accent: "#1d9bf0", theme: "dark", width: 760, height: 360 },
  },

  // creative pack — Batch A text cards (DM-1531).
  {
    file: "title-card",
    template: titleCardTemplate,
    params: { eyebrow: "Introducing", title: "Domotion", subtitle: "DOM → animated SVG, pixel-faithful to Chromium", accent: "#22d3ee", background: "linear-gradient(135deg,#0f172a,#1e293b)" },
  },
  {
    file: "quote",
    template: quoteTemplate,
    params: { quote: "It dropped our demo payload to a fraction and it looks identical across browsers.", author: "Ada Lovelace", role: "Staff Engineer", accent: "#8b5cf6" },
  },
  {
    file: "caption",
    template: captionTemplate,
    params: { text: "Captured, converted, and self-contained — no runtime.", motion: "slide", bgOpacity: 0.5 },
  },
  {
    file: "cta",
    template: ctaTemplate,
    params: { headline: "Ship your first demo today", cta: "Get started", handles: ["@domotion", "github.com/brianwestphal"], ctaColor: "#3b82f6", background: "linear-gradient(135deg,#111827,#0b1020)" },
  },

  // creative pack — Batch B number animation (DM-1532).
  {
    file: "counter",
    template: counterTemplate,
    params: { to: 128500, grouping: true, prefix: "$", suffix: "+", fontSize: 200 },
  },
  {
    file: "counter-timer",
    template: counterTemplate,
    params: { from: 90, to: 0, mode: "timer", fontSize: 220, color: "#22d3ee" },
  },
  {
    file: "stat",
    template: statTemplate,
    params: { value: 1240000, grouping: true, suffix: "", label: "Monthly active users", delta: "12.4%", deltaDir: "up" },
  },

  // creative pack — Batch C before/after compare (DM-1533).
  {
    file: "compare",
    template: compareTemplate,
    params: {
      before: resolve("examples/templates/compare-before.html"),
      after: resolve("examples/templates/compare-after.html"),
      mode: "slide", direction: "right", beforeLabel: "Before", afterLabel: "After",
    },
  },

  // format presets (DM-1534) — the same templates dropped onto platform canvases
  // via `--format`, which sets width/height + a safe-area inset. No explicit
  // width/height here, so the format supplies the canvas.
  {
    file: "format-reel-kinetic",
    template: kineticTextTemplate,
    params: { text: "Launch day", variant: "rise", fontSize: 120 },
    format: "reel", // 1080×1920 vertical (Reels/TikTok/Shorts)
  },
  {
    file: "format-square-chart",
    template: chartTemplate,
    params: { type: "column", data: [42, 68, 55, 90], labels: ["Q1", "Q2", "Q3", "Q4"], title: "Growth" },
    format: "square", // 1080×1080 feed square
  },

  // brand kit (DM-1530) — ONE brand file (acme-brand.json) drives the palette +
  // font across four different templates; none of these pass color/font flags.
  {
    file: "brand-acme-lower-third",
    template: lowerThirdTemplate,
    params: { title: "Acme Cloud", subtitle: "Now with brand kits" },
    brand: ACME_BRAND,
  },
  {
    file: "brand-acme-chart",
    template: chartTemplate,
    params: { type: "column", data: [42, 68, 55, 90, 34, 76], labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], title: "Signups" },
    brand: ACME_BRAND,
  },
  {
    file: "brand-acme-subscribe",
    template: subscribeTemplate,
    params: { name: "Acme", subtitle: "1.2M subscribers", action: "Subscribe" },
    brand: ACME_BRAND,
  },
  {
    file: "brand-acme-kinetic",
    template: kineticTextTemplate,
    params: { text: "On brand, at scale", variant: "rise" },
    brand: ACME_BRAND,
  },
  {
    // cta — the brand's `logo` token auto-fills the end-card's logo slot
    // (DM-1539); no `logo`/`ctaColor`/`fontFamily` flags passed. The first
    // built-in to consume `brand.logo`.
    file: "brand-acme-cta",
    template: ctaTemplate,
    params: { headline: "Ship on brand", cta: "Get started", handles: ["@acme", "acme.dev"] },
    brand: ACME_BRAND,
  },
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchChromium();
  try {
    for (const ex of EXAMPLES) {
      // Mirror the CLI's --format handling: size the canvas from the preset (if
      // params didn't pin width/height) and hand the render the safe-area inset.
      const params = { ...ex.params };
      const fmt = ex.format != null ? resolveFormat(ex.format) : undefined;
      if (fmt != null) applyFormatSize(params, fmt);
      const { svg, width, height } = await renderTemplateToSvg(ex.template, params, {
        browser,
        ...(fmt != null ? { safeInset: fmt.safeInset } : {}),
        ...(ex.brand != null ? { brand: ex.brand } : {}),
      });
      const optimized = optimizeSvg(svg);
      const out = resolve(OUT_DIR, `${ex.file}.svg`);
      writeFileSync(out, optimized);
      process.stdout.write(`Wrote ${out} (${(optimized.length / 1024).toFixed(1)} KB, ${width}×${height})\n`);
    }
  } finally {
    await browser.close();
  }
}

void main();
