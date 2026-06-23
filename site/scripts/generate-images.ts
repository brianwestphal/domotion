/**
 * Generate the SVG images embedded in the user manual, using Domotion itself.
 *
 * Each scene below is a small HTML snippet captured into a self-contained SVG,
 * written to `site/assets/img/`. This is the visible proof that Domotion
 * does what the manual says it does — every illustration in the manual was
 * produced by the same pipeline the manual is teaching.
 *
 * Run: `npx tsx site/scripts/generate-images.ts` (after `npx playwright install chromium`).
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page } from "@playwright/test";
import {
  captureElementTree, elementTreeToSvg, wrapSvg,
  generateAnimatedSvg, optimizeSvg, launchChromium,
  type AnimationFrame,
} from "../../src/index.js";

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(SITE_DIR, "..", "assets", "img");

interface Scene {
  name: string;
  width: number;
  height: number;
  html: string;
}

const SCENES: Scene[] = [
  // Hero "before / after" — a card that shows the live HTML alongside the
  // captured SVG would be ideal, but here we just produce the captured side.
  {
    name: "hero-card",
    width: 720, height: 280,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;">
      <div style="padding:40px;display:grid;gap:24px;grid-template-columns:auto 1fr;align-items:center;">
        <div style="
          width:80px;height:80px;border-radius:18px;
          background:linear-gradient(135deg,#79b8ff 0%,#d2a8ff 100%);
          display:flex;align-items:center;justify-content:center;
          color:#0d1117;font-size:34px;font-weight:700;
          box-shadow:0 8px 24px rgba(121,184,255,0.3);
        ">◐</div>
        <div>
          <div style="font-size:28px;font-weight:600;margin-bottom:6px;letter-spacing:-0.01em;">Pixel-faithful HTML, served as one SVG.</div>
          <div style="font-size:15px;color:#8b949e;line-height:1.55;">Author the demo as plain HTML. Domotion captures the rendered Chromium frame and emits a self-contained SVG with optional CSS animations.</div>
        </div>
      </div>
      <div style="margin:0 40px;padding:14px 18px;border:1px solid #30363d;border-radius:8px;background:#161b22;font-family:'SF Mono',monospace;font-size:13px;color:#79c0ff;">
        $ npm install domotion-svg
      </div>
    </body></html>`,
  },
  // Pipeline diagram — three boxes connected by arrows.
  {
    name: "pipeline",
    width: 800, height: 220,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;">
      <div style="padding:36px 24px;display:flex;align-items:center;justify-content:center;gap:0;">
        ${stage("HTML / CSS", "in your real app", "#79b8ff")}
        ${arrow("captureElementTree()")}
        ${stage("Element tree", "serialisable JSON", "#d2a8ff")}
        ${arrow("elementTreeToSvg()")}
        ${stage("SVG", "self-contained", "#56d364")}
      </div>
    </body></html>`,
  },
  // Gradient examples — three swatches.
  {
    name: "gradient-gallery",
    width: 720, height: 220,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;padding:30px;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">
        ${gradTile("Linear", "linear-gradient(135deg,#79b8ff 0%,#d2a8ff 100%)")}
        ${gradTile("Radial", "radial-gradient(circle at 30% 30%, #56d364 0%, #1a4a25 70%)")}
        ${gradTile("Repeating", "repeating-linear-gradient(45deg,#21262d 0 12px,#30363d 12px 24px)")}
      </div>
    </body></html>`,
  },
  // Form controls — checkbox / radio / range / progress / meter / color.
  {
    name: "form-controls",
    width: 720, height: 280,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;padding:30px;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
        ${formTile("checkbox", `<input type="checkbox" checked> &nbsp;<input type="checkbox">`)}
        ${formTile("radio",    `<input type="radio" name="r" checked> &nbsp;<input type="radio" name="r">`)}
        ${formTile("range",    `<input type="range" min="0" max="100" value="62" style="accent-color:#79b8ff;width:100%;">`)}
        ${formTile("progress", `<progress value="0.62" style="accent-color:#56d364;width:100%;">62%</progress>`)}
        ${formTile("meter",    `<meter value="0.74" min="0" max="1" style="width:100%;">74%</meter>`)}
        ${formTile("color",    `<input type="color" value="#79b8ff" style="width:48px;height:32px;border:none;background:transparent;">`)}
      </div>
    </body></html>`,
  },
  // Borders & radius — corner shapes and dash styles.
  {
    name: "borders-gallery",
    width: 720, height: 240,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;padding:30px;">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;">
        ${borderTile("solid",  "border:2px solid #79b8ff;border-radius:10px;")}
        ${borderTile("dashed", "border:2px dashed #d2a8ff;border-radius:10px;")}
        ${borderTile("dotted", "border:3px dotted #56d364;border-radius:10px;")}
        ${borderTile("groove", "border:6px groove #f0883e;border-radius:10px;")}
        ${borderTile("pill",   "border:2px solid #79b8ff;border-radius:9999px;")}
        ${borderTile("squircle","border:2px solid #d2a8ff;border-radius:36px;")}
        ${borderTile("uneven", "border:2px solid #56d364;border-radius:36px 8px 36px 8px;")}
        ${borderTile("inset",  "border:6px inset #f0883e;border-radius:10px;")}
      </div>
    </body></html>`,
  },
  // Multi-script text — Latin / Arabic / Devanagari / CJK / emoji on one line.
  {
    name: "scripts-line",
    width: 720, height: 200,
    html: `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;padding:30px;">
      <div style="font-size:24px;line-height:1.7;">
        <div>Hello — السلام عليكم — नमस्ते — 你好 — 🎨</div>
        <div style="font-size:14px;color:#8b949e;margin-top:12px;">Latin · Arabic · Devanagari · CJK · emoji — all path-mode shaping.</div>
      </div>
    </body></html>`,
  },
];

function stage(title: string, sub: string, color: string): string {
  return `<div style="
    width:170px;height:96px;border-radius:14px;background:#161b22;border:2px solid ${color};
    display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 8px;
  ">
    <div style="font-size:15px;font-weight:600;color:${color};">${title}</div>
    <div style="font-size:12px;color:#8b949e;margin-top:4px;">${sub}</div>
  </div>`;
}

function arrow(label: string): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;width:120px;color:#8b949e;font-family:'SF Mono',monospace;font-size:11px;">
    <div style="margin-bottom:4px;">${label}</div>
    <div style="height:2px;width:100%;background:#30363d;position:relative;">
      <div style="position:absolute;right:-6px;top:-4px;width:0;height:0;border-left:8px solid #30363d;border-top:5px solid transparent;border-bottom:5px solid transparent;"></div>
    </div>
  </div>`;
}

function gradTile(label: string, bg: string): string {
  return `<div style="border-radius:10px;overflow:hidden;border:1px solid #30363d;">
    <div style="height:120px;background:${bg};"></div>
    <div style="padding:10px 12px;font-size:13px;color:#e6edf3;background:#161b22;">${label}</div>
  </div>`;
}

function formTile(label: string, body: string): string {
  return `<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;">
    <div style="font-size:12px;color:#8b949e;letter-spacing:0.04em;text-transform:uppercase;">${label}</div>
    <div style="display:flex;align-items:center;gap:10px;min-height:32px;">${body}</div>
  </div>`;
}

function borderTile(label: string, style: string): string {
  return `<div style="background:#161b22;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;">
    <div style="height:64px;${style}"></div>
    <div style="font-size:12px;color:#8b949e;text-align:center;">${label}</div>
  </div>`;
}

async function captureScene(page: Page, scene: Scene): Promise<string> {
  await page.setViewportSize({ width: scene.width, height: scene.height });
  await page.setContent(scene.html);
  await page.evaluate(() => document.fonts.ready);
  const tree = await captureElementTree(page, "body", {
    x: 0, y: 0, width: scene.width, height: scene.height,
  });
  return optimizeSvg(wrapSvg(elementTreeToSvg(tree, scene.width, scene.height), scene.width, scene.height));
}

// A multi-stage terminal animation that doubles as a real install walkthrough.
// The previous 3-stage animation spent its first 1.2s on a near-empty terminal
// (just a "$" prompt) — visitors saw a static blank box. This version always
// shows meaningful, layered content: command typed, progress, then result.
async function captureAnimation(page: Page): Promise<string> {
  const W = 640, H = 240;

  function frame(opts: {
    cmd: string;          // shown after the prompt on the first line
    body: string;         // the body lines (plain HTML)
    cursor?: boolean;     // show a blinking cursor at end of cmd
  }): string {
    const cursor = opts.cursor === true
      ? `<span style="display:inline-block;width:8px;height:16px;background:#e6edf3;vertical-align:middle;margin-left:2px;"></span>`
      : "";
    return `<!doctype html><html><body style="margin:0;background:#1e1e2e;font-family:'SF Mono',Menlo,Monaco,monospace;color:#e6edf3;">
      <div style="padding:24px 28px;font-size:13px;line-height:1.7;">
        <div style="margin-bottom:6px;">
          <span style="color:#9d7cd8;font-weight:700;">~/my-app</span>
          <span style="color:#666;">&nbsp;on&nbsp;</span>
          <span style="color:#56d364;">main</span>
          <span style="color:#666;">&nbsp;via&nbsp;</span>
          <span style="color:#79c0ff;">⬢ v22.4.0</span>
        </div>
        <div><span style="color:#28c840;font-weight:700;">$</span>&nbsp;<span>${opts.cmd}</span>${cursor}</div>
        ${opts.body}
      </div>
    </body></html>`;
  }

  const stages = [
    {
      html: frame({
        cmd: "npm install domotion-svg",
        cursor: true,
        body: "",
      }),
    },
    {
      html: frame({
        cmd: "npm install domotion-svg",
        body: `
          <div style="color:#7dd3fc;margin-top:6px;">⠼ resolving dependencies…</div>
          <div style="margin-top:8px;height:6px;width:100%;border-radius:3px;background:#2a2a3a;overflow:hidden;">
            <div style="height:100%;width:62%;background:linear-gradient(90deg,#7dd3fc,#a78bfa);"></div>
          </div>`,
      }),
    },
    {
      html: frame({
        cmd: "npm install domotion-svg",
        body: `
          <div style="color:#56d364;margin-top:6px;font-weight:700;">✓ added 12 packages in 1.4s</div>
          <div style="color:#8b949e;margin-top:4px;">  <span style="color:#79c0ff;">domotion</span>@<span style="color:#d2a8ff;">0.1.0</span></div>
          <div style="color:#8b949e;">  └─ <span style="color:#79c0ff;">@playwright/test</span>@<span style="color:#d2a8ff;">1.59.1</span></div>
          <div style="color:#666;margin-top:8px;">$ <span style="color:#56d364;">●</span> ready to capture.</div>`,
      }),
    },
  ];

  await page.setViewportSize({ width: W, height: H });
  const frames: AnimationFrame[] = [];
  for (let i = 0; i < stages.length; i++) {
    await page.setContent(stages[i].html);
    await page.evaluate(() => document.fonts.ready);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    const svgContent = elementTreeToSvg(tree, W, H, `f${i}-`);

    // Debug: also write each frame as its own standalone SVG so it can be
    // inspected without the animation pipeline in the way.
    const standalone = optimizeSvg(wrapSvg(elementTreeToSvg(tree, W, H), W, H));
    writeFileSync(resolve(OUT_DIR, `install-demo-frame-${i + 1}.svg`), standalone);
    console.log(`  install-demo-frame-${i + 1}.svg (${(standalone.length / 1024).toFixed(1)} KB)`);

    frames.push({
      svgContent,
      duration: 3000,
      // Hard cut: instant frame switch with no fade or slide.
      transition: { type: "cut", duration: 0 },
    });
  }
  return optimizeSvg(generateAnimatedSvg({ width: W, height: H, frames }));
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();

  for (const scene of SCENES) {
    const svg = await captureScene(page, scene);
    const out = resolve(OUT_DIR, `${scene.name}.svg`);
    writeFileSync(out, svg);
    console.log(`  ${scene.name}.svg (${(svg.length / 1024).toFixed(1)} KB)`);
  }

  const animatedSvg = await captureAnimation(page);
  writeFileSync(resolve(OUT_DIR, "install-demo.svg"), animatedSvg);
  console.log(`  install-demo.svg (${(animatedSvg.length / 1024).toFixed(1)} KB, animated)`);

  // DM-1282: the Templates gallery page (site/pages/guides/templates.tsx) embeds
  // the committed built-in template example SVGs. Mirror them into the site
  // assets here (regenerate them first with `npm run demos:examples`) so the
  // gallery and the repo examples can never drift.
  const TEMPLATES_SRC = resolve(SITE_DIR, "..", "..", "examples", "output", "templates");
  const TEMPLATES_DST = resolve(OUT_DIR, "templates");
  cpSync(TEMPLATES_SRC, TEMPLATES_DST, { recursive: true });
  console.log(`  templates/ (mirrored from ${TEMPLATES_SRC})`);

  await browser.close();
  console.log(`\nWrote ${SCENES.length + 4} images to ${OUT_DIR}`);
}

void main();
