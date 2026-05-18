/**
 * Example: animate the word "domotion" through a series of 90s-neon-retro
 * typographic variants. Each variant displays for ~400ms before cutting to
 * the next; the whole sequence loops.
 *
 * Usage: npx tsx examples/domotion-word-demo.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { optimizeSvg } from "./shared.js";

const WIDTH = 720;
const HEIGHT = 320;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "domotion-word-demo.svg");

interface Variant {
  /** Inner HTML inside the centered stage. */
  inner: string;
  /** Background CSS for the page. */
  background: string;
  /** Hold duration in ms. */
  duration: number;
}

const VARIANTS: Variant[] = [
  // 1) DOMotation — block + script, like a logo lockup
  {
    background: "#0a0014",
    duration: 420,
    inner: `
      <span style="
        font-family: Impact, 'Helvetica Neue', sans-serif;
        font-size: 120px;
        font-weight: 900;
        letter-spacing: -2px;
        color: #ff10f0;
        text-shadow: 3px 3px 0 #00ffff, 6px 6px 0 #b300ff;
        vertical-align: baseline;
      ">DOM</span><span style="
        font-family: 'Brush Script MT', 'Snell Roundhand', cursive;
        font-style: italic;
        font-size: 96px;
        color: #fff700;
        text-shadow: 0 0 12px #fff700, 0 0 24px #ff8c00;
        margin-left: 4px;
        vertical-align: baseline;
      ">otation</span>
    `,
  },

  // 2) doMotion — clean dual-color sans, big neon glow on "Motion"
  {
    background: "radial-gradient(ellipse at center, #1a0033 0%, #000010 80%)",
    duration: 380,
    inner: `
      <span style="
        font-family: 'Avenir Next', 'Futura', sans-serif;
        font-weight: 900;
        font-size: 110px;
        letter-spacing: -3px;
        color: #00ffff;
        text-shadow: 0 0 8px #00ffff, 0 0 16px #00ffff;
        vertical-align: baseline;
      ">do</span><span style="
        font-family: 'Avenir Next', 'Futura', sans-serif;
        font-weight: 900;
        font-size: 110px;
        letter-spacing: -3px;
        color: #ff00aa;
        text-shadow: 0 0 6px #ff00aa, 0 0 14px #ff10f0, 0 0 28px #ff00ff;
        vertical-align: baseline;
      ">Motion</span>
    `,
  },

  // 3) DoMotion — slanted, neon chalk
  {
    background: "#0a1a0a",
    duration: 400,
    inner: `
      <div style="
        transform: rotate(-4deg) skewX(-8deg);
        font-family: Chalkduster, 'Marker Felt', 'Comic Sans MS', cursive;
        font-size: 100px;
        font-weight: 700;
        color: #39ff14;
        text-shadow: 4px 4px 0 #ff00ff, 8px 8px 0 rgba(255, 0, 255, 0.35);
      ">DoMotion</div>
    `,
  },

  // 4) domotion — all lowercase, rainbow gradient fill
  {
    background: "#000000",
    duration: 420,
    inner: `
      <span style="
        font-family: 'Futura', 'Avenir Next', sans-serif;
        font-weight: 900;
        font-size: 116px;
        letter-spacing: 2px;
        background: linear-gradient(90deg, #ff10f0 0%, #ff8c00 25%, #fff700 50%, #39ff14 75%, #00ffff 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        color: transparent;
      ">domotion</span>
    `,
  },

  // 5) doMOTION — tiny "do" + huge "MOTION" with cyan offset
  {
    background: "#100020",
    duration: 460,
    inner: `
      <span style="
        font-family: 'Courier New', Courier, monospace;
        font-weight: 700;
        font-size: 32px;
        color: #ffffff;
        text-shadow: 0 0 6px #ffffff;
        vertical-align: baseline;
        margin-right: 6px;
      ">do</span><span style="
        font-family: Impact, 'Helvetica Neue', sans-serif;
        font-weight: 900;
        font-size: 130px;
        letter-spacing: -4px;
        color: #ff10f0;
        text-shadow: -5px 0 0 #00ffff, 5px 0 0 #fff700;
        vertical-align: baseline;
      ">MOTION</span>
    `,
  },
];

function buildPage(variant: Variant): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      background: ${variant.background};
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
    }
    .stage {
      display: inline-block;
      white-space: nowrap;
      line-height: 1;
      text-align: center;
    }
  </style></head><body><div class="stage">${variant.inner}</div></body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  const frames: AnimationFrame[] = [];

  for (let i = 0; i < VARIANTS.length; i++) {
    const variant = VARIANTS[i];
    const tmp = resolve(OUT_DIR, `domotion-word-tmp-${i}.html`);
    writeFileSync(tmp, buildPage(variant));
    await pg.goto(`file://${tmp}`);
    await pg.waitForTimeout(150);

    const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await embedRemoteImages(tree);

    frames.push({
      svgContent: elementTreeToSvg(tree, WIDTH, HEIGHT, `v${i}-`),
      duration: variant.duration,
      transition: { type: "cut", duration: 0 },
    });
  }

  await browser.close();

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();
