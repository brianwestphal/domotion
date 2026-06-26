/**
 * Proof demo for DM-1414: a single looping SVG that CHAINS DIFFERENT transition
 * types — crossfade → push-left → scroll → crossfade(loop) — to show each
 * incoming frame now enters correctly (its entrance composed from the PREVIOUS
 * frame's transition, its exit from its own):
 *   - scene 2 (push) ENTERS by fading in from the crossfade, then EXITS sliding left;
 *   - scene 3 (scroll) ENTERS by sliding in from the right (the push hand-off),
 *     then EXITS sliding up — a cross-axis compose that used to be impossible;
 *   - scene 4 (crossfade) fades in as scene 3 scrolls up, then dissolves to the loop.
 * Before the fix, the slide frames after a non-matching transition simply cut in
 * (crossfade dipped to black; the scroll revealed empty canvas).
 *
 * Each scene is a distinct full-bleed color so the motion is unmistakable.
 * Run: npx tsx examples/transition-tour.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

const W = 600;
const H = 360;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "transition-tour.svg");

function scene(opts: { bg: string; accent: string; kicker: string; title: string; sub: string; via: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; background: #0a0f1e; color: #eef1fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
.page { width: ${W}px; height: ${H}px; padding: 38px 44px; position: relative; background: ${opts.bg}; display: flex; flex-direction: column; justify-content: center; }
.kicker { font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: ${opts.accent}; }
.title { font-size: 46px; font-weight: 800; letter-spacing: -0.02em; margin-top: 10px; }
.sub { font-size: 16px; color: #aeb6da; margin-top: 12px; max-width: 460px; line-height: 1.5; }
.via { position: absolute; bottom: 26px; left: 44px; font-size: 12px; color: #8b93b8; }
.via b { color: ${opts.accent}; }
</style></head><body><div class="page">
  <div class="kicker">${opts.kicker}</div>
  <div class="title">${opts.title}</div>
  <div class="sub">${opts.sub}</div>
  <div class="via">${opts.via}</div>
</div></body></html>`;
}

const S0 = scene({ bg: "radial-gradient(130% 130% at 0% 0%, #11315c 0%, #0a0f1e 62%)", accent: "#7c9cff", kicker: "Scene 1", title: "Chained transitions", sub: "One SVG, four scenes, four different transition types in a row.", via: "exits via <b>crossfade →</b>" });
const S1 = scene({ bg: "radial-gradient(130% 130% at 100% 0%, #0c3a2a 0%, #0a0f1e 62%)", accent: "#4ade80", kicker: "Scene 2", title: "It fades in", sub: "Entered from a crossfade, so it dissolves in — then it will push left.", via: "enters <b>fade</b> · exits <b>push-left →</b>" });
const S2 = scene({ bg: "radial-gradient(130% 130% at 100% 100%, #3a2c0c 0%, #0a0f1e 62%)", accent: "#fbbf24", kicker: "Scene 3", title: "It slides in", sub: "Entered from a push, it slides in from the right — then it will scroll up.", via: "enters <b>slide ←</b> · exits <b>scroll ↑</b>" });
const S3 = scene({ bg: "radial-gradient(130% 130% at 0% 100%, #2a1450 0%, #0a0f1e 62%)", accent: "#c4a3ff", kicker: "Scene 4", title: "Composed, not cut", sub: "Each entrance follows the previous transition; each exit is its own.", via: "enters as scene 3 scrolls up · exits <b>crossfade ↺</b>" });

async function cap(pg: Page, html: string, prefix: string): Promise<string> {
  const tmp = resolve(OUT_DIR, `tour-tmp-${prefix}.html`);
  writeFileSync(tmp, html);
  await pg.goto(`file://${tmp}`);
  await pg.waitForTimeout(180);
  const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: W, height: H });
  await embedRemoteImages(tree);
  return elementTreeToSvgInner(tree, W, H, prefix, true, 2, false);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  clearEmbeddedFonts();
  const browser = await chromium.launch();
  let frames: AnimationFrame[];
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const pg = await ctx.newPage();
    const c0 = await cap(pg, S0, "t0-");
    const c1 = await cap(pg, S1, "t1-");
    const c2 = await cap(pg, S2, "t2-");
    const c3 = await cap(pg, S3, "t3-");
    frames = [
      { svgContent: c0, duration: 1700, transition: { type: "crossfade", duration: 650 } }, // → crossfade
      { svgContent: c1, duration: 1700, transition: { type: "push-left", duration: 650 } },  // enters fade, exits push
      { svgContent: c2, duration: 1700, transition: { type: "scroll", duration: 700 } },     // enters slide (cross-axis), exits scroll
      { svgContent: c3, duration: 1900, transition: { type: "crossfade", duration: 650 } },  // exits crossfade → loop
    ];
  } finally {
    await browser.close();
  }
  let svg = generateAnimatedSvg({ width: W, height: H, frames, fontFaceCss: getEmbeddedFontFaceCss(), background: "#0a0f1e", loopFade: true });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();
