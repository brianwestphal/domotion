/**
 * Example: a `domotion` CLI session rendered as an animated terminal SVG.
 *
 * Renders terminal-style HTML pages and converts them to native SVG
 * (no PNGs, real text, native animations). For capturing a REAL recorded
 * session, see `domotion term --cast` (doc 67); this hand-authored demo just
 * showcases the renderer.
 *
 * Usage: npx tsx examples/terminal-demo.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { optimizeSvg } from "./shared.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";

const WIDTH = 720;
const HEIGHT = 420;
const OUTPUT = resolve("examples/output/terminal-demo.svg");

const TERMINAL_FRAMES = [
  {
    lines: [
      { text: "$ ", color: "#28c840", bold: true },
    ],
    duration: 1500,
    typing: { text: "domotion capture https://example.com -o hero.svg", x: 24, y: 32 },
  },
  {
    lines: [
      { text: "$ domotion capture https://example.com -o hero.svg", color: "#8b8fa3" },
      { text: "" },
      { text: "  ✓ Captured body → hero.svg", color: "#28c840", bold: true },
      { text: "    52 KB · self-contained · text as glyph paths", color: "#8b8fa3" },
      { text: "    scales crisply at any size", color: "#6e7681" },
      { text: "" },
      { text: "$ ", color: "#28c840", bold: true },
    ],
    duration: 2500,
    typing: { text: "domotion term --cast build.cast -o build.svg", x: 24, y: 172 },
  },
  {
    lines: [
      { text: "$ domotion term --cast build.cast -o build.svg", color: "#8b8fa3" },
      { text: "" },
      { text: "  ✓ 17 frames · 656×346px · 13.60s · 45.3 KB", color: "#28c840" },
      { text: "    → real text, native SVG animation", color: "#8b8fa3" },
    ],
    duration: 3000,
  },
  {
    lines: [
      { text: "  ── embed anywhere ───────────────────────────────", color: "#30363d" },
      { text: "" },
      { text: "  <img src=\"build.svg\" alt=\"terminal demo\">", color: "#e6edf3", bold: true },
      { text: "" },
      { text: "  • animations play inside <img>, lazy-loadable", color: "#e6edf3" },
      { text: "  • identical across browsers (glyph paths)", color: "#e6edf3" },
      { text: "  • no external fonts, images, or scripts", color: "#e6edf3" },
    ],
    duration: 4000,
  },
];

function buildTerminalHtml(lines: Array<{ text: string; color?: string; bold?: boolean }>): string {
  const lineHeight = 22;
  const padding = 16;
  const renderedLines = lines.map((line, i) => {
    const style = `color: ${line.color ?? "#e6edf3"}; ${line.bold === true ? "font-weight: 700;" : ""}`;
    const y = padding + i * lineHeight;
    return `<div style="position: absolute; left: ${padding}px; top: ${y}px; ${style} white-space: pre; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px;">${escapeHtml(line.text)}</div>`;
  }).join("\n");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body { margin: 0; background: #1e1e2e; overflow: hidden; }</style></head><body><div style="position: relative; width: ${WIDTH}px; height: ${HEIGHT}px;">${renderedLines}</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main(): Promise<void> {
  mkdirSync(resolve("examples/output"), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();

  const animFrames: AnimationFrame[] = [];
  const transTypes: Array<"push-left" | "crossfade"> = ["push-left", "push-left", "crossfade", "crossfade"];
  // Embedded-font mode accumulates one growing custom TTF across frames; render
  // each frame WITHOUT its own @font-face and emit the finished font once below,
  // or it gets re-embedded per frame (DM-1225 dedup).
  clearEmbeddedFonts();

  for (let i = 0; i < TERMINAL_FRAMES.length; i++) {
    const frame = TERMINAL_FRAMES[i];
    const html = buildTerminalHtml(frame.lines);

    // Write temp HTML and navigate
    const tmpPath = resolve("examples/output", `tmp-${i}.html`);
    writeFileSync(tmpPath, html);
    await page.goto(`file://${tmpPath}`);
    await page.waitForTimeout(100);

    // Capture DOM as SVG (text converted to path outlines). DM-512: demos
    // emit self-contained SVGs so they load in offline image viewers.
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await embedRemoteImages(tree);
    const svgContent = elementTreeToSvgInner(tree, WIDTH, HEIGHT, `f${i}-`, true, 2, false);

    const animFrame: AnimationFrame = {
      svgContent,
      duration: frame.duration,
      transition: { type: transTypes[i], duration: 400 },
    };

    // Add typing overlay if specified
    if (frame.typing != null) {
      animFrame.overlays = [{
        kind: "typing" as const,
        text: frame.typing.text,
        x: frame.typing.x,
        y: frame.typing.y,
        fontSize: 13,
        color: "#e6edf3",
        speed: 40,
      }];
    }

    animFrames.push(animFrame);
  }

  await browser.close();

  // Generate the animated SVG
  let svg = generateAnimatedSvg({
    width: WIDTH,
    height: HEIGHT,
    frames: animFrames,
    fontFaceCss: getEmbeddedFontFaceCss(),
  });

  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();
