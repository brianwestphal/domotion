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
 *   - iframe-recursion-cross-origin.svg — apple.com embedded + recursed via the
 *     opt-in `--cross-origin-frames` path (Phase 2). Needs network; skips
 *     gracefully offline.
 *
 * NOT part of `npm run demos:examples` (the cross-origin half needs network).
 * Run manually:  npx tsx examples/iframe-recursion.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
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
const INNER_CARD = `<html><head><style>
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e6edf3}
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
    await pg.setContent(`<body style="margin:0;background:#070a12;font-family:-apple-system,sans-serif">
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

// ── Cross-origin apple.com (Phase 2 — opt-in --cross-origin-frames) ──────────
async function crossOrigin(): Promise<void> {
  const W = 1000, H = 700;
  // Launch with web security disabled so the cross-origin contentDocument is
  // readable (the same args `--cross-origin-frames` passes; apple.com is trusted).
  const browser = await chromium.launch({ args: crossOriginFramesLaunchArgs("*") });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    // Strip framing-prevention headers so apple.com can be embedded at all
    // (X-Frame-Options / CSP frame-ancestors otherwise refuse the iframe).
    await ctx.route("**/*", async (route) => {
      try {
        const resp = await route.fetch();
        const headers = { ...resp.headers() };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        await route.fulfill({ response: resp, headers });
      } catch {
        await route.continue();
      }
    });
    const pg = await ctx.newPage();
    await pg.setContent(`<body style="margin:0;background:#070a12;font-family:-apple-system,sans-serif">
      <div style="padding:20px">
        <div style="color:#8a97b0;font-size:13px;font-weight:600;letter-spacing:.04em;margin-bottom:12px">CROSS-ORIGIN — apple.com embedded &amp; recursed via --cross-origin-frames</div>
        <div style="width:960px;height:600px;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55);border:1px solid #1d2740">
          <iframe src="https://www.apple.com/" width="960" height="600" style="display:block;border:0"></iframe>
        </div>
      </div></body>`);
    await pg.waitForLoadState("networkidle").catch(() => {});
    await pg.waitForTimeout(2500);
    const { tree } = await captureElementTreeWithWarnings(pg, "body", { x: 0, y: 0, width: W, height: H }, {
      crossOriginFrames: "apple.com,www.apple.com",
    });
    await embedRemoteImages(tree); // self-contained — apple's images inlined
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
  try {
    await crossOrigin();
  } catch (err) {
    console.warn(`Cross-origin (apple.com) demo skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void main();
