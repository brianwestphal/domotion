/**
 * Proof demo for DM-1548: a single looping SVG that chains transition types
 * ACROSS effect families — crossfade → zoom-in → wipe → push-left → crossfade
 * (loop) — so every boundary composes an independent entrance (from the previous
 * transition) and exit (from its own):
 *   - scene 2 (zoom-in exit) FADES in from the crossfade;
 *   - scene 3 (wipe exit) DOLLIES in from the zoom-in, then HOLDS for its wipe —
 *     a dolly-entrance composed with a reveal-exit, which the single-branch
 *     dispatch used to drop (it cut the frame in, losing the scale);
 *   - scene 4 (push-left exit) REVEALS in via the wipe, then SLIDES out left — a
 *     reveal-entrance composed with a slide-exit, previously forced to hold-cut;
 *   - scene 5 (crossfade → loop) enters as scene 4 slides away, then dissolves.
 * Before DM-1548, the reveal / dolly cross-family boundaries were silently
 * dropped; the tour that mixes only the slide/fade families is `transition-tour`.
 *
 * Run: npx tsx examples/transition-mixed.ts
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
const OUTPUT = resolve(OUT_DIR, "transition-mixed.svg");

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

const S0 = scene({ bg: "radial-gradient(130% 130% at 0% 0%, #11315c 0%, #0a0f1e 62%)", accent: "#7c9cff", kicker: "Scene 1", title: "Mixed families", sub: "One SVG chaining reveal, dolly, and slide transitions back to back.", via: "exits via <b>crossfade →</b>" });
const S1 = scene({ bg: "radial-gradient(130% 130% at 100% 0%, #2a1450 0%, #0a0f1e 62%)", accent: "#c4a3ff", kicker: "Scene 2", title: "It fades in", sub: "Entered from a crossfade, so it dissolves in — then it dollies the next in.", via: "enters <b>fade</b> · exits <b>zoom-in →</b>" });
const S2 = scene({ bg: "radial-gradient(130% 130% at 100% 100%, #0c3a3a 0%, #0a0f1e 62%)", accent: "#5eead4", kicker: "Scene 3", title: "It dollies in", sub: "Entered from a zoom, it grows into place — then it holds for a wipe. A dolly-in composed with a wipe-out used to be impossible.", via: "enters <b>dolly</b> · exits <b>wipe →</b>" });
const S3 = scene({ bg: "radial-gradient(130% 130% at 0% 100%, #3a2c0c 0%, #0a0f1e 62%)", accent: "#fbbf24", kicker: "Scene 4", title: "It wipes in", sub: "Revealed on top by the wipe, then it slides off left — a reveal-in composed with a push-out.", via: "enters <b>reveal</b> · exits <b>push-left →</b>" });
const S4 = scene({ bg: "radial-gradient(130% 130% at 0% 0%, #0c3a2a 0%, #0a0f1e 62%)", accent: "#4ade80", kicker: "Scene 5", title: "Composed, not cut", sub: "Each entrance follows the previous transition; each exit is its own — across every family.", via: "enters as scene 4 slides away · exits <b>crossfade ↺</b>" });

async function cap(pg: Page, html: string, prefix: string): Promise<string> {
  const tmp = resolve(OUT_DIR, `mixed-tmp-${prefix}.html`);
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
    const c0 = await cap(pg, S0, "m0-");
    const c1 = await cap(pg, S1, "m1-");
    const c2 = await cap(pg, S2, "m2-");
    const c3 = await cap(pg, S3, "m3-");
    const c4 = await cap(pg, S4, "m4-");
    frames = [
      { svgContent: c0, duration: 1600, transition: { type: "crossfade", duration: 600 } }, // → crossfade
      { svgContent: c1, duration: 1600, transition: { type: "zoom-in", duration: 650 } },    // enters fade, exits zoom (dolly next)
      { svgContent: c2, duration: 1700, transition: { type: "wipe", duration: 650 } },        // enters dolly, exits wipe  [composed]
      { svgContent: c3, duration: 1700, transition: { type: "push-left", duration: 650 } },   // enters reveal, exits push  [composed]
      { svgContent: c4, duration: 1800, transition: { type: "crossfade", duration: 600 } },   // exits crossfade → loop
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
