/**
 * Example: Terminal demo using the SVG demo generator.
 *
 * Renders terminal-style HTML pages and converts them to native SVG
 * (no PNGs, real text, native animations).
 *
 * Usage: npx tsx examples/terminal-demo.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { optimizeSvg } from "./shared.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animator.js";

const WIDTH = 720;
const HEIGHT = 420;
const OUTPUT = resolve("examples/output/terminal-demo.svg");

const TERMINAL_FRAMES = [
  {
    lines: [
      { text: "$ ", color: "#28c840", bold: true },
    ],
    duration: 1500,
    typing: { text: "sk search error-handling", x: 24, y: 32 },
  },
  {
    lines: [
      { text: "$ sk search error-handling", color: "#8b8fa3" },
      { text: "" },
      { text: "  @community/error-handling-patterns", color: "#58a6ff", bold: true },
      { text: "  Structured error handling with typed errors", color: "#8b8fa3" },
      { text: "  Score: 42/100  |  1,234 downloads  |  universal", color: "#6e7681" },
      { text: "" },
      { text: "$ ", color: "#28c840", bold: true },
    ],
    duration: 2500,
    typing: { text: "sk install @community/error-handling-patterns", x: 24, y: 172 },
  },
  {
    lines: [
      { text: "$ sk install @community/error-handling-patterns", color: "#8b8fa3" },
      { text: "" },
      { text: "  ✓ Installed @community/error-handling-patterns v1.0.0", color: "#28c840" },
      { text: "    → Written to CLAUDE.md", color: "#8b8fa3" },
    ],
    duration: 3000,
  },
  {
    lines: [
      { text: "  ── CLAUDE.md ─────────────────────────────────────", color: "#30363d" },
      { text: "" },
      { text: "  ## Error Handling", color: "#e6edf3", bold: true },
      { text: "" },
      { text: "  - Always use typed errors extending AppError", color: "#e6edf3" },
      { text: "  - Never catch and swallow errors silently", color: "#e6edf3" },
      { text: "  - Use Result<T, E> for expected failures", color: "#e6edf3" },
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
    const svgContent = elementTreeToSvg(tree, WIDTH, HEIGHT, `f${i}-`);

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
  });

  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();
