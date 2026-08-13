/**
 * Demo: `<iframe>` recursion into native SVG (DM-1441 / DM-1442 / DM-1446 / DM-1448).
 *
 * Domotion no longer rasterizes an `<iframe>` to a flat `<image>`. When the
 * frame's document is accessible it walks the inner document with the same
 * capture logic and splices it in as native SVG — crisp `<path>`/`<text>`
 * glyphs, real gradients/clips, selectable text, sharp at any zoom.
 *
 * Produces two self-contained SVGs in examples/output/:
 *   - iframe-recursion-same-origin.svg  — a `srcdoc` card (Phase 1, no flags).
 *   - iframe-recursion-cross-origin.svg — a deterministic routed HTTPS origin
 *     embedded + recursed via the opt-in `--cross-origin-frames` path (Phase 2).
 *
 * NOT part of `npm run demos:examples` (kept as a focused iframe demo).
 * Run manually:  npx tsx examples/iframe-recursion.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  captureElementTree,
  captureElementTreeWithWarnings,
  crossOriginFramesLaunchArgs,
} from "../src/capture/index.js";
import { elementTreeToSvgInner, wrapSvg, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";
import type { CapturedElement } from "../src/capture/types.js";

const OUT_DIR = resolve("examples/output");

/** Render a captured tree to a self-contained static SVG (embedded fonts). */
function renderStatic(tree: CapturedElement[], w: number, h: number, idPrefix: string): string {
  clearEmbeddedFonts();
  const inner = elementTreeToSvgInner(tree, w, h, idPrefix, true, 2, false);
  const fontCss = getEmbeddedFontFaceCss();
  let svg = wrapSvg(inner, w, h, { tree });
  if (fontCss != null && fontCss.trim() !== "") {
    svg = svg.replace(/(<svg[^>]*>)/, `$1<defs><style>${fontCss}</style></defs>`);
  }
  return optimizeSvg(svg);
}

// ── Same-origin srcdoc card (Phase 1 — recurses by default, no flags) ────────
export const INNER_CARD = `<html><head><style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#e6edf3}
  .top{height:8px;background:linear-gradient(90deg,#22d3ee,#a855f7,#f97316)}
  .pad{padding:18px 20px}
  .row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .ava{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#22d3ee,#3b82f6);
       display:flex;align-items:center;justify-content:center;font-weight:700;color:#04121f;font-size:18px;clip-path:circle(50%)}
  .who{font-weight:600;font-size:15px} .when{color:#7d8aa3;font-size:12px}
  h2{margin:0 0 8px;font-size:19px} p{margin:0 0 14px;line-height:1.5;color:#c4cdde;font-size:14px}
  .badge{display:inline-block;background:#16351f;color:#4ade80;border:1px solid #225c33;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
  .cta{margin-top:6px;display:inline-block;background:#3b82f6;color:#fff;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600}
</style></head><body>
  <div class="top"></div>
  <div class="pad">
    <div class="row"><div class="ava">DM</div>
      <div><div class="who">Domotion</div><div class="when">just now · native SVG</div></div>
      <span class="badge" style="margin-left:auto">recursed ✓</span></div>
    <h2>This iframe is real, selectable SVG</h2>
    <p>Everything inside this frame — the avatar's clipped circle, the gradient bar,
       this paragraph's crisp glyph outlines — was walked out of the iframe's
       document and rendered as native SVG, not a flat screenshot. Zoom in: it stays sharp.</p>
    <span class="cta">Open ticket</span>
  </div>
</body></html>`;

async function sameOrigin(): Promise<void> {
  const W = 760, H = 470;
  const browser = await chromium.launch();
  try {
    const pg = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
    await pg.setContent(`<body style="margin:0;background:#070a12;font-family:Arial,sans-serif">
      <div style="padding:26px">
        <div style="color:#8a97b0;font-size:13px;font-weight:600;letter-spacing:.04em;margin-bottom:14px">CAPTURED WITH DOMOTION — &lt;iframe&gt; → NATIVE SVG</div>
        <div style="width:460px;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55);border:1px solid #1d2740">
          <iframe srcdoc="${INNER_CARD.replace(/"/g, "&quot;")}" width="460" height="300" style="display:block;border:0"></iframe>
        </div>
      </div></body>`);
    await pg.waitForLoadState("networkidle");
    const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: W, height: H });
    const out = resolve(OUT_DIR, "iframe-recursion-same-origin.svg");
    const svg = renderStatic(tree, W, H, "so-");
    writeFileSync(out, svg);
    console.log(`Generated: ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

export const CROSS_ORIGIN_PAGE = `<!doctype html><html><head><style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#f5f7ff;color:#111827}
  .nav{height:62px;display:flex;align-items:center;padding:0 28px;background:#fff;border-bottom:1px solid #dfe3f0}
  .mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#22d3ee);margin-right:12px}
  .brand{font-size:17px;font-weight:700}.links{margin-left:auto;display:flex;gap:24px;color:#59627a;font-size:13px}
  .hero{height:538px;padding:58px 64px;position:relative;overflow:hidden;background:linear-gradient(135deg,#eef2ff 0%,#fdf2f8 52%,#ecfeff 100%)}
  .eyebrow{color:#7c3aed;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
  h1{font-size:54px;line-height:1.02;letter-spacing:-.04em;margin:14px 0 18px;max-width:540px}
  p{font-size:18px;line-height:1.55;color:#59627a;max-width:510px;margin:0 0 28px}
  .button{display:inline-block;background:#111827;color:#fff;border-radius:11px;padding:13px 20px;font-size:14px;font-weight:700}
  .panel{position:absolute;right:54px;top:92px;width:300px;height:330px;border-radius:24px;background:#111827;box-shadow:0 28px 65px rgba(76,29,149,.28);padding:24px;color:#fff}
  .panel-top{display:flex;gap:8px;margin-bottom:26px}.dot{width:8px;height:8px;border-radius:50%;background:#7c3aed}.dot:nth-child(2){background:#22d3ee}.dot:nth-child(3){background:#f472b6}
  .metric{font-size:12px;color:#9ca3af}.value{font-size:38px;font-weight:700;margin:7px 0 24px}
  .bars{height:150px;display:flex;align-items:flex-end;gap:10px}.bar{flex:1;border-radius:7px 7px 2px 2px;background:linear-gradient(#22d3ee,#7c3aed)}
</style></head><body>
  <div class="nav"><div class="mark"></div><div class="brand">Orbit Analytics</div><div class="links"><span>Product</span><span>Customers</span><span>Docs</span></div></div>
  <section class="hero"><div class="eyebrow">Cross-origin native SVG</div><h1>See momentum before it becomes obvious.</h1><p>A deterministic remote-origin fixture proves that Domotion walks the framed document into crisp vectors instead of flattening it into a screenshot.</p><span class="button">Explore dashboard</span>
    <div class="panel"><div class="panel-top"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div><div class="metric">Monthly recurring revenue</div><div class="value">$84,290</div><div class="bars"><i class="bar" style="height:42%"></i><i class="bar" style="height:65%"></i><i class="bar" style="height:54%"></i><i class="bar" style="height:83%"></i><i class="bar" style="height:100%"></i><i class="bar" style="height:88%"></i></div></div>
  </section>
</body></html>`;

// ── Deterministic cross-origin fixture (Phase 2) ────────────────────────────
async function crossOrigin(): Promise<void> {
  const W = 1000, H = 700;
  // The iframe stays genuinely cross-origin (`frame.example` vs about:blank),
  // but routing makes its bytes deterministic and offline-safe.
  const browser = await chromium.launch({ args: crossOriginFramesLaunchArgs("*") });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    await ctx.route("https://frame.example/demo", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: CROSS_ORIGIN_PAGE });
    });
    const pg = await ctx.newPage();
    await pg.setContent(`<body style="margin:0;background:#070a12;font-family:Arial,sans-serif">
      <div style="padding:20px">
        <div style="color:#8a97b0;font-size:13px;font-weight:600;letter-spacing:.04em;margin-bottom:12px">CROSS-ORIGIN — frame.example embedded &amp; recursed via --cross-origin-frames</div>
        <div style="width:960px;height:600px;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55);border:1px solid #1d2740">
          <iframe src="https://frame.example/demo" width="960" height="600" style="display:block;border:0"></iframe>
        </div>
      </div></body>`);
    await pg.waitForLoadState("networkidle").catch(() => {});
    const { tree } = await captureElementTreeWithWarnings(pg, "body", { x: 0, y: 0, width: W, height: H }, {
      crossOriginFrames: "frame.example",
    });
    await embedRemoteImages(tree);
    const out = resolve(OUT_DIR, "iframe-recursion-cross-origin.svg");
    const svg = renderStatic(tree, W, H, "co-");
    writeFileSync(out, svg);
    console.log(`Generated: ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await sameOrigin();
  await crossOrigin();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
