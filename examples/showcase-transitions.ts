/**
 * Showcase: Transition Types — a labeled tour of every transition Domotion can
 * stitch between captured frames.
 *
 * Five scenes, each captioned with the transition it is about to perform, so the
 * output is self-documenting:
 *   1. crossfade  — scene 1 dissolves into scene 2 (opacity fades overlap)
 *   2. push-left  — scene 2 slides off left as scene 3 slides in from the right
 *   3. scroll     — scene 3 slides up and off as scene 4 rises from the bottom
 *   4. magic-move — shared `data-magic-key` cards glide to new positions (before
 *                   → after), then a final crossfade closes the loop.
 *
 * The magic-move bridge is built caller-side from the two frames' element trees
 * via `buildMagicMove`, exactly like the declarative `domotion animate` pipeline
 * (src/cli/animate.ts). It must run BEFORE `getEmbeddedFontFaceCss()` so the
 * bridge's re-rendered glyphs land in the embedded @font-face defs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { buildMagicMove } from "../src/animation/magic-move.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

const WIDTH = 800;
const HEIGHT = 500;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "showcase-transitions.svg");

/**
 * Shared chrome: a "step N / 4" badge, big title, subtitle. Each scene gets a
 * DISTINCT full-bleed gradient background (`bg`) so the transitions are actually
 * visible — a uniform background hides crossfade/slide/scroll motion entirely.
 */
function scene(opts: { step: string; accent: string; title: string; desc: string; body: string; bg: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0f1e; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
.page { padding: 40px 48px; width: ${WIDTH}px; height: ${HEIGHT}px; position: relative; background: ${opts.bg}; }
.badge { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #0d1117; background: ${opts.accent}; padding: 4px 12px; border-radius: 20px; }
.title { font-size: 44px; font-weight: 800; margin-top: 18px; letter-spacing: -0.02em; }
.desc { font-size: 16px; color: #8b949e; margin-top: 10px; max-width: 560px; line-height: 1.5; }
.body { margin-top: 30px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 18px; }
.card-title { font-weight: 600; color: ${opts.accent}; font-size: 15px; }
.card-desc { font-size: 13px; color: #8b949e; margin-top: 4px; }
.row { display: flex; gap: 16px; }
.row .card { flex: 1; }
.arrow { font-size: 64px; color: ${opts.accent}; line-height: 1; }
.panel { position: absolute; width: 280px; height: 150px; border-radius: 12px; border: 1px solid #30363d; }
.mm-stage { position: relative; height: 300px; }
.mm-card { position: absolute; width: 220px; height: 84px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; transition: none; }
.mm-card .k { font-weight: 700; font-size: 15px; }
.mm-card .v { font-size: 12px; color: #8b949e; margin-top: 6px; }
</style></head><body><div class="page">
  <span class="badge">${opts.step}</span>
  <div class="title">${opts.title}</div>
  <div class="desc">${opts.desc}</div>
  <div class="body">${opts.body}</div>
</div></body></html>`;
}

// 1 — Crossfade: two overlapping translucent panels suggest a dissolve.
const CROSSFADE = scene({
  step: "Transition 1 / 4",
  accent: "#58a6ff",
  bg: "radial-gradient(130% 130% at 0% 0%, #11315c 0%, #0a0f1e 62%)",
  title: "Crossfade",
  desc: "One scene dissolves into the next — the outgoing frame fades out while the incoming frame fades in, overlapping.",
  body: `<div style="position:relative;height:180px;margin-top:8px">
    <div class="panel" style="left:60px;top:10px;background:rgba(88,166,255,0.18)"></div>
    <div class="panel" style="left:180px;top:40px;background:rgba(188,140,255,0.18)"></div>
  </div>`,
});

// 2 — Push-left: a left arrow + a strip of frames.
const PUSHLEFT = scene({
  step: "Transition 2 / 4",
  accent: "#3fb950",
  bg: "radial-gradient(130% 130% at 100% 0%, #0c3a2a 0%, #0a0f1e 62%)",
  title: "Push left",
  desc: "Page-to-page navigation — the current scene slides off to the left as the next one slides in from the right.",
  body: `<div class="row" style="align-items:center">
    <div class="card"><div class="card-title">Search</div><div class="card-desc">results list</div></div>
    <div class="arrow">←</div>
    <div class="card"><div class="card-title">Detail</div><div class="card-desc">item page</div></div>
  </div>`,
});

// 3 — Scroll: a down arrow; the frames slide vertically.
const SCROLL = scene({
  step: "Transition 3 / 4",
  accent: "#d29922",
  bg: "radial-gradient(130% 130% at 0% 100%, #3a2c0c 0%, #0a0f1e 62%)",
  title: "Scroll",
  desc: "Same-page motion on the vertical axis — the outgoing frame slides up and off the top as the next rises from the bottom.",
  body: `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:4px">
    <div class="card" style="width:320px"><div class="card-title">Above the fold</div></div>
    <div class="arrow" style="font-size:48px">↓</div>
    <div class="card" style="width:320px"><div class="card-title">Further down</div></div>
  </div>`,
});

// 4 — Magic-move (before): three keyed cards in a row.
function mmCard(key: string, label: string, value: string, left: number, top: number, accent: string): string {
  return `<div class="mm-card" data-magic-key="${key}" style="left:${left}px;top:${top}px"><div class="k" style="color:${accent}">${label}</div><div class="v">${value}</div></div>`;
}
const MAGIC_BEFORE = scene({
  step: "Transition 4 / 4",
  accent: "#bc8cff",
  bg: "radial-gradient(130% 130% at 100% 100%, #2a1450 0%, #0a0f1e 62%)",
  title: "Magic move",
  desc: "Elements shared between two layouts (matched by key) glide to their new positions instead of cutting — like a reordering UI.",
  body: `<div class="mm-stage">
    ${mmCard("mm-capture", "capture", "URL → SVG", 0, 0, "#58a6ff")}
    ${mmCard("mm-animate", "animate", "frames → motion", 248, 0, "#3fb950")}
    ${mmCard("mm-composite", "composite", "layered SVGs", 496, 0, "#d29922")}
  </div>`,
});

// 5 — Magic-move (after): the same three keyed cards, rearranged → they slide.
const MAGIC_AFTER = scene({
  step: "Transition 4 / 4",
  accent: "#bc8cff",
  bg: "radial-gradient(130% 130% at 100% 100%, #2a1450 0%, #0a0f1e 62%)",
  title: "Magic move",
  desc: "Elements shared between two layouts (matched by key) glide to their new positions instead of cutting — like a reordering UI.",
  body: `<div class="mm-stage">
    ${mmCard("mm-composite", "composite", "layered SVGs", 0, 0, "#d29922")}
    ${mmCard("mm-capture", "capture", "URL → SVG", 290, 108, "#58a6ff")}
    ${mmCard("mm-animate", "animate", "frames → motion", 540, 216, "#3fb950")}
  </div>`,
});

async function captureScene(pg: Page, html: string, prefix: string): Promise<{ tree: Awaited<ReturnType<typeof captureElementTree>>; svg: string }> {
  const tmp = resolve(OUT_DIR, `trans-tmp-${prefix}.html`);
  writeFileSync(tmp, html);
  await pg.goto(`file://${tmp}`);
  await pg.waitForTimeout(200);
  const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await embedRemoteImages(tree);
  const svg = elementTreeToSvgInner(tree, WIDTH, HEIGHT, prefix, true, 2, false);
  return { tree, svg };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  clearEmbeddedFonts(); // DM-1225: emit the embedded font once, not per frame

  // Capture every scene up front; render svgContent for each (registers glyphs).
  const s0 = await captureScene(pg, CROSSFADE, "f0-");
  const s1 = await captureScene(pg, PUSHLEFT, "f1-");
  const s2 = await captureScene(pg, SCROLL, "f2-");
  const s3 = await captureScene(pg, MAGIC_BEFORE, "f3-");
  const s4 = await captureScene(pg, MAGIC_AFTER, "f4-");

  await browser.close();

  const frames: AnimationFrame[] = [
    { svgContent: s0.svg, duration: 2600, transition: { type: "crossfade", duration: 600 } },
    { svgContent: s1.svg, duration: 2400, transition: { type: "push-left", duration: 500 } },
    { svgContent: s2.svg, duration: 2400, transition: { type: "scroll", duration: 700 } },
    { svgContent: s3.svg, duration: 2200, transition: { type: "magic-move", duration: 800 } },
    { svgContent: s4.svg, duration: 2600, transition: { type: "crossfade", duration: 600 } },
  ];

  // The magic-move bridge for frame 3 → frame 4 (before → after). Built BEFORE
  // getEmbeddedFontFaceCss() so its re-rendered glyphs make it into the font defs.
  frames[3].magicMove = buildMagicMove(
    s3.tree,
    s4.tree,
    (roots, prefix) => elementTreeToSvgInner(roots, WIDTH, HEIGHT, prefix, true, 2, false),
    "mm3-",
  );

  // Opaque canvas background so the crossfades dissolve through the scene color
  // rather than flashing the host page background while both frames are partly
  // transparent (the scenes' own bg is #0d1117).
  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames, fontFaceCss: getEmbeddedFontFaceCss(), background: "#0a0f1e" });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  const mm = frames[3].magicMove != null ? "magic-move bridge built" : "magic-move fell back to crossfade";
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB, ${mm})`);
}

void main();
