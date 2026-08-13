/**
 * Proof demo for DM-1548 and DM-2115: a single looping SVG that chains transition types
 * ACROSS effect families — crossfade → parameterized zoom → clock reveal → angled
 * push → custom recipe
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

const S0 = scene({ bg: "radial-gradient(130% 130% at 0% 0%, #11315c 0%, #0a0f1e 62%)", accent: "#7c9cff", kicker: "Scene 1", title: "Mixed families", sub: "One SVG chaining parameterized and custom transitions back to back.", via: "exits via <b>crossfade →</b>" });
const S1 = scene({ bg: "radial-gradient(130% 130% at 100% 0%, #2a1450 0%, #0a0f1e 62%)", accent: "#c4a3ff", kicker: "Scene 2", title: "Origin-aware zoom", sub: "It fades in, then brings the next scene forward from a deliberately off-center origin.", via: "enters <b>fade</b> · exits <b>zoom { origin } →</b>" });
const S2 = scene({ bg: "radial-gradient(130% 130% at 100% 100%, #0c3a3a 0%, #0a0f1e 62%)", accent: "#5eead4", kicker: "Scene 3", title: "Clock reveal", sub: "The zoom hands off to a counterclockwise reveal centered below and left of the canvas midpoint.", via: "enters <b>dolly</b> · exits <b>reveal { clock } →</b>" });
const S3 = scene({ bg: "radial-gradient(130% 130% at 0% 100%, #3a2c0c 0%, #0a0f1e 62%)", accent: "#fbbf24", kicker: "Scene 4", title: "Angled push", sub: "The clock opens onto this scene; an arbitrary-angle push then carries it into the final recipe.", via: "enters <b>clock reveal</b> · exits <b>push { angle } →</b>" });
const S4 = scene({ bg: "radial-gradient(130% 130% at 0% 0%, #0c3a2a 0%, #0a0f1e 62%)", accent: "#4ade80", kicker: "Scene 5", title: "Custom, safely", sub: "Opacity, translation, scale, and a shine band combine through bounded primitives — no raw CSS or script.", via: "enters via <b>custom recipe</b> · crossfades to loop ↺" });

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
      { svgContent: c1, duration: 1600, transition: { type: "zoom", duration: 650, zoom: { fromScale: 0.82, origin: { x: 0.68, y: 0.36 } } } },
      { svgContent: c2, duration: 1700, transition: { type: "reveal", duration: 650, reveal: { shape: "clock", origin: { x: 0.35, y: 0.62 }, startAngle: 35, direction: "counterclockwise" } } },
      { svgContent: c3, duration: 1700, transition: { type: "push", duration: 650, push: { angle: 205, distance: 0.85 } } },
      { svgContent: c4, duration: 1800, transition: { type: "custom", duration: 650, easing: "ease-out", custom: {
        incoming: { opacity: 0.1, translate: { x: 0.12, y: -0.08 }, scale: { from: 0.88, origin: { x: 0.5, y: 0.5 } } },
        outgoing: { opacity: 0, translate: { x: -0.08, y: 0.04 } },
        overlay: { angle: 25, bandWidth: 0.2, color: "#d1fae5", opacity: 0.42 },
        reducedMotion: "crossfade", loop: "crossfade-to-first", zOrder: "incoming-on-top",
      } } },
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
