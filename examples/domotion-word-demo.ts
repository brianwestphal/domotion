/**
 * Example: animate the word "domotion" through a rapid-fire series of
 * 90s-neon-retro typographic variants. Each variant flashes for ~140ms before
 * cutting to the next; the whole 20-variant sequence loops (~2.8s).
 *
 * The capitalization is allowed to repeat across variants — what changes every
 * frame is the font, color treatment, glow / shadow, gradient, and transform.
 *
 * The output SVG is rendered on a TRANSPARENT background so it can sit on top
 * of a website's own (e.g. gradient) background — only the word paints.
 *
 * Usage: npx tsx examples/domotion-word-demo.ts
 */

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

export const WIDTH = 760;
export const HEIGHT = 320;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "domotion-word-demo.svg");

export interface Variant {
  /** Inner HTML inside the centered stage. */
  inner: string;
  /** Hold duration in ms. */
  duration: number;
}

// ── helpers ────────────────────────────────────────────────────────────────
const BASE = "vertical-align:baseline;display:inline-block;";

interface SpanOpts {
  font: string;
  size: number;
  weight?: number | string;
  color: string;
  glow?: string;       // text-shadow value
  ls?: number;         // letter-spacing px
  style?: string;      // font-style
  ml?: number; mr?: number;
  extra?: string;      // any extra CSS
}

/** A neon / shadowed word span. */
function word(text: string, o: SpanOpts): string {
  return `<span style="font-family:${o.font};font-size:${o.size}px;font-weight:${o.weight ?? 900};`
    + `${o.style ? `font-style:${o.style};` : ""}letter-spacing:${o.ls ?? 0}px;color:${o.color};`
    + `${o.glow ? `text-shadow:${o.glow};` : ""}${o.ml ? `margin-left:${o.ml}px;` : ""}`
    + `${o.mr ? `margin-right:${o.mr}px;` : ""}${o.extra ?? ""}${BASE}">${text}</span>`;
}

/** A gradient-filled word (background-clip: text). */
function grad(text: string, o: { font: string; size: number; weight?: number | string; gradient: string; ls?: number; style?: string; extra?: string }): string {
  return `<span style="font-family:${o.font};font-size:${o.size}px;font-weight:${o.weight ?? 900};`
    + `${o.style ? `font-style:${o.style};` : ""}letter-spacing:${o.ls ?? 0}px;background:${o.gradient};`
    + `-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;`
    + `${o.extra ?? ""}${BASE}">${text}</span>`;
}

// reusable glow presets
const CYAN = "0 0 8px #00ffff,0 0 18px #00ffff";
const PINK = "0 0 6px #ff00aa,0 0 14px #ff10f0,0 0 30px #ff00ff";
const GREEN = "0 0 8px #39ff14,0 0 20px #39ff14";
const YELLOW = "0 0 12px #fff700,0 0 26px #ff8c00";

const FAST = 140; // ~3x faster than the prior ~420ms holds

export const VARIANTS: Variant[] = [
  // 1) DOMotation — block Impact + cursive script lockup
  {
    duration: FAST,
    inner: word("DOM", { font: "Impact, 'Helvetica Neue', sans-serif", size: 120, ls: -2, color: "#ff10f0", glow: "3px 3px 0 #00ffff,6px 6px 0 #b300ff" })
      + word("otation", { font: "'Brush Script MT','Snell Roundhand',cursive", size: 96, weight: 400, style: "italic", color: "#fff700", glow: YELLOW, ml: 4 }),
  },

  // 2) doMotion — clean dual-color sans, neon glow
  {
    duration: FAST,
    inner: word("do", { font: "'Avenir Next',Futura,sans-serif", size: 110, ls: -3, color: "#00ffff", glow: CYAN })
      + word("Motion", { font: "'Avenir Next',Futura,sans-serif", size: 110, ls: -3, color: "#ff00aa", glow: PINK }),
  },

  // 3) DoMotion — slanted neon chalk
  {
    duration: FAST,
    inner: `<div style="transform:rotate(-4deg) skewX(-8deg);">`
      + word("DoMotion", { font: "Chalkduster,'Marker Felt','Comic Sans MS',cursive", size: 100, weight: 700, color: "#39ff14", glow: "4px 4px 0 #ff00ff,8px 8px 0 rgba(255,0,255,0.35)" })
      + `</div>`,
  },

  // 4) domotion — lowercase rainbow gradient
  {
    duration: FAST,
    inner: grad("domotion", { font: "Futura,'Avenir Next',sans-serif", size: 116, ls: 2, gradient: "linear-gradient(90deg,#ff10f0 0%,#ff8c00 25%,#fff700 50%,#39ff14 75%,#00ffff 100%)" }),
  },

  // 5) doMOTION — tiny "do" + huge "MOTION", chromatic aberration
  {
    duration: FAST,
    inner: word("do", { font: "'Courier New',Courier,monospace", size: 32, weight: 700, color: "#fff", glow: "0 0 6px #fff", mr: 6 })
      + word("MOTION", { font: "Impact,'Helvetica Neue',sans-serif", size: 130, ls: -4, color: "#ff10f0", glow: "-5px 0 0 #00ffff,5px 0 0 #fff700" }),
  },

  // 6) DOMOTION — tight all-caps, vertical cyan→magenta gradient
  {
    duration: FAST,
    inner: grad("DOMOTION", { font: "'Arial Black',Arial,sans-serif", size: 92, ls: -2, gradient: "linear-gradient(180deg,#00ffff 0%,#ff00ff 100%)", extra: "text-shadow:0 0 18px rgba(255,0,255,0.5);" }),
  },

  // 7) domotion — monospace terminal green
  {
    duration: FAST,
    inner: word("domotion", { font: "Menlo,Monaco,'Courier New',monospace", size: 86, weight: 700, ls: 4, color: "#39ff14", glow: GREEN }),
  },

  // 8) Domotion — elegant thin Didot, soft pink glow
  {
    duration: FAST,
    inner: word("Domotion", { font: "Didot,'Bodoni 72','Times New Roman',serif", size: 104, weight: 400, ls: 1, color: "#fde7ff", glow: "0 0 10px #ff7bd5,0 0 22px #d000ff" }),
  },

  // 9) DOMOTION — gold letterpress Copperplate
  {
    duration: FAST,
    inner: grad("DOMOTION", { font: "Copperplate,'Copperplate Gothic Light',serif", size: 80, weight: 700, ls: 3, gradient: "linear-gradient(180deg,#fff1a8 0%,#ffcf40 45%,#ff8c00 100%)", extra: "text-shadow:2px 2px 0 #7a3b00,3px 3px 0 rgba(0,0,0,0.4);" }),
  },

  // 10) doMotion — italic serif, magenta→purple
  {
    duration: FAST,
    inner: grad("doMotion", { font: "Georgia,'Times New Roman',serif", size: 104, weight: 700, style: "italic", gradient: "linear-gradient(90deg,#ff2bd6 0%,#7b2ff7 100%)", extra: "text-shadow:0 0 16px rgba(180,0,255,0.6);" }),
  },

  // 11) domotion — electric-blue, wide tracking, layered glow
  {
    duration: FAST,
    inner: word("domotion", { font: "'Gill Sans','Helvetica Neue',sans-serif", size: 92, weight: 600, ls: 10, color: "#7df9ff", glow: "0 0 4px #fff,0 0 12px #00b3ff,0 0 28px #0066ff" }),
  },

  // 12) DOMotation — wild oversized script
  {
    duration: FAST,
    inner: word("DOMotation", { font: "'Brush Script MT','Snell Roundhand',cursive", size: 96, weight: 400, style: "italic", color: "#ff4fd8", glow: "0 0 10px #ff10f0,0 0 24px #ff00aa,0 0 44px #ff00ff" }),
  },

  // 13) dOmOtIoN — typewriter, alternating cyan/orange pairs with hard shadow
  {
    duration: FAST,
    inner: word("dO", { font: "'American Typewriter',Courier,monospace", size: 96, weight: 700, color: "#00ffd5", glow: "3px 3px 0 #003b33" })
      + word("mO", { font: "'American Typewriter',Courier,monospace", size: 96, weight: 700, color: "#ff8a00", glow: "3px 3px 0 #3b1d00" })
      + word("tI", { font: "'American Typewriter',Courier,monospace", size: 96, weight: 700, color: "#00ffd5", glow: "3px 3px 0 #003b33" })
      + word("oN", { font: "'American Typewriter',Courier,monospace", size: 96, weight: 700, color: "#ff8a00", glow: "3px 3px 0 #3b1d00" }),
  },

  // 14) doMOTION — sunset gradient on MOTION, small do
  {
    duration: FAST,
    inner: word("do", { font: "Futura,'Avenir Next',sans-serif", size: 40, color: "#ffd6f6", glow: "0 0 8px #ff7bd5", mr: 8 })
      + grad("MOTION", { font: "Futura,'Avenir Next',sans-serif", size: 118, ls: -3, gradient: "linear-gradient(180deg,#fff700 0%,#ff5e9c 50%,#7b2ff7 100%)" }),
  },

  // 15) domotion — ultralight, super-wide tracking, minimal synth
  {
    duration: FAST,
    inner: word("domotion", { font: "'Helvetica Neue',Arial,sans-serif", size: 80, weight: 200, ls: 18, color: "#aef6ff", glow: "0 0 6px #00ffff,0 0 16px #00cfff" }),
  },

  // 16) DoMotion — marker-felt sticker, stacked hard shadows
  {
    duration: FAST,
    inner: word("DoMotion", { font: "'Marker Felt','Comic Sans MS',cursive", size: 98, weight: 700, color: "#fff700", glow: "2px 2px 0 #ff10f0,4px 4px 0 #00ffff,6px 6px 0 rgba(0,0,0,0.4)" }),
  },

  // 17) DOMOTION — 3D extrude, magenta with cyan depth
  {
    duration: FAST,
    inner: word("DOMOTION", { font: "Impact,'Arial Black',sans-serif", size: 96, ls: -2, color: "#ff2bd6", glow: "2px 2px 0 #00d9ff,4px 4px 0 #00d9ff,6px 6px 0 #007a8c,8px 8px 0 #004a55" }),
  },

  // 18) domotion — serif teal→pink
  {
    duration: FAST,
    inner: grad("domotion", { font: "Palatino,'Palatino Linotype',serif", size: 100, weight: 700, style: "italic", gradient: "linear-gradient(90deg,#00ffc8 0%,#ff5ec7 100%)", extra: "text-shadow:0 0 14px rgba(0,255,200,0.4);" }),
  },

  // 19) doMotion — vaporwave split with offset twins
  {
    duration: FAST,
    inner: word("do", { font: "'Trebuchet MS',Verdana,sans-serif", size: 104, weight: 700, color: "#05d9e8", glow: "-3px 0 0 #ff2a6d", mr: 2 })
      + word("Motion", { font: "'Trebuchet MS',Verdana,sans-serif", size: 104, weight: 700, color: "#ff2a6d", glow: "-3px 0 0 #05d9e8" }),
  },

  // 20) DOMOTION — grand finale: huge rainbow + outer glow
  {
    duration: 180,
    inner: grad("DOMOTION", { font: "Impact,'Arial Black',sans-serif", size: 104, ls: -2, gradient: "linear-gradient(90deg,#ff10f0,#ff8c00,#fff700,#39ff14,#00ffff,#ff10f0)", extra: "text-shadow:0 0 22px rgba(255,255,255,0.55);" }),
  },
];

export function buildPage(variant: Variant): string {
  // Transparent page — no background fill of any kind — so the output SVG
  // composites over whatever the host website paints behind it. Only the
  // centered word (and its glows / shadows) renders.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: transparent; }
    body {
      width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      font-family: sans-serif;
    }
    .stage {
      display: inline-block; white-space: nowrap; line-height: 1; text-align: center;
    }
  </style></head><body><div class="stage">${variant.inner}</div></body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // The page's body background is transparent (buildPage), so the captured
  // tree carries no backdrop fill and the emitted SVG is transparent.
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  const frames: AnimationFrame[] = [];
  clearEmbeddedFonts(); // DM-1225: emit the embedded font once, not per frame

  for (let i = 0; i < VARIANTS.length; i++) {
    const variant = VARIANTS[i];
    const tmp = resolve(OUT_DIR, `domotion-word-tmp-${i}.html`);
    writeFileSync(tmp, buildPage(variant));
    await pg.goto(`file://${tmp}`);
    await pg.waitForTimeout(120);

    const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await embedRemoteImages(tree);

    frames.push({
      svgContent: elementTreeToSvgInner(tree, WIDTH, HEIGHT, `v${i}-`, true, 2, false),
      duration: variant.duration,
      transition: { type: "cut", duration: 0 },
    });
    rmSync(tmp, { force: true }); // don't leave per-variant scratch HTML behind
  }

  await browser.close();

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames, fontFaceCss: getEmbeddedFontFaceCss() });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB, ${VARIANTS.length} variants)`);
}

// Only run when invoked directly (so the verification harness can import the
// variants without kicking off a capture).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
