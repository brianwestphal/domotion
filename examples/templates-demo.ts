/**
 * Example: render one self-contained SVG per built-in template concept (DM-1276,
 * DM-1280, DM-1277). Covers every unique concept/variant of the four built-ins:
 *
 *   lower-third     → dark + light themes (different corners)
 *   device-mockup   → phone + browser + window bezels (each a distinct device)
 *   background-loop → aurora + orbs + stars + gradient-pan + grid + wave variants
 *   kinetic-text    → rise + slide(char) + fade + clip + pop variants
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
  lowerThirdTemplate,
  deviceMockupTemplate,
  backgroundLoopTemplate,
  kineticTextTemplate,
  type Template,
} from "../src/index.js";
import { optimizeSvg } from "./shared.js";

const OUT_DIR = resolve("examples/output/templates");
const SAMPLE_APP = resolve("examples/templates/sample-app.html");

// One entry per unique concept we want a committed example SVG for.
const EXAMPLES: Array<{ file: string; template: Template; params: Record<string, unknown> }> = [
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
    params: { variant: "stars", colors: ["#7aa2f7", "#bb9af7", "#7dcfff", "#9ece6a"], width: 1280, height: 720, seed: 5 },
  },
  {
    file: "background-loop-gradient-pan",
    template: backgroundLoopTemplate,
    params: { variant: "gradient-pan", colors: ["#6366f1", "#ec4899", "#22d3ee"], width: 1280, height: 720 },
  },
  {
    file: "background-loop-grid",
    template: backgroundLoopTemplate,
    params: { variant: "grid", colors: ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"], width: 1280, height: 720 },
  },
  {
    file: "background-loop-wave",
    template: backgroundLoopTemplate,
    params: { variant: "wave", colors: ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"], width: 1280, height: 720, seed: 3 },
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
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchChromium();
  try {
    for (const ex of EXAMPLES) {
      const { svg, width, height } = await renderTemplateToSvg(ex.template, ex.params, { browser });
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
