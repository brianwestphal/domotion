/**
 * Hero demo for the site landing: a polished analytics dashboard that ASSEMBLES
 * ITSELF and comes alive, composited into a browser window on a gradient
 * backdrop. It showcases, in one self-contained SVG:
 *   - faithful capture of a dense, realistic product UI (real text as glyph paths)
 *   - rich staggered entrance animation (top bar + sidebar + KPI cards rise/fade,
 *     chart bars grow up from the baseline)
 *   - simulated interaction that loops (a search query types itself; a click
 *     ripples on a nav item)
 *   - scene composition (browser chrome + soft-shadowed window on a gradient)
 *
 * Built on the same primitives the CLI uses: capture → `generateAnimatedSvg`
 * (intra-frame `animations` + `overlays`) → `composeAnimatedLayers` for the
 * window chrome. Run: npx tsx examples/hero-product-demo.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../src/animation/animator.js";
import type { IntraFrameAnimation } from "../src/animation/overlay-schema.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../src/animation/composite.js";
import { optimizeSvg } from "./shared.js";

const APP_W = 960;
const APP_H = 600;
const MARGIN = 34; // backdrop breathing room around the window
const BAR = 40; // browser title-bar height
const RAD = 12; // window corner radius
const LOOP = 6400; // master loop length (ms)

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "hero-product-demo.svg");

/** The dashboard. `data-domotion-anim` ids tag the elements the entrance animates. */
export function dashboardHtml(): string {
  const nav = [
    ["Overview", true],
    ["Analytics", false],
    ["Customers", false],
    ["Revenue", false],
    ["Settings", false],
  ] as const;
  const navItems = nav
    .map(
      ([label, active], i) =>
        `<div class="nav ${active ? "active" : ""}" data-domotion-anim="nav${i}">
           <span class="nav-dot"></span>${label}
         </div>`,
    )
    .join("");

  // KPI cards — fade on the outer, rise on the inner (one animation per element).
  const kpis = [
    ["Revenue", "$48.2k", "+12.4%", "up"],
    ["Active users", "8,914", "+3.1%", "up"],
    ["Conversion", "3.8%", "−0.4%", "down"],
  ];
  const kpiCards = kpis
    .map(
      ([label, value, delta, dir], i) =>
        `<div class="kpi" data-domotion-anim="kpiFade${i}">
           <div class="kpi-inner" data-domotion-anim="kpiRise${i}">
             <div class="kpi-label">${label}</div>
             <div class="kpi-value">${value}</div>
             <div class="trend ${dir}">${dir === "up" ? "▲" : "▼"} ${delta}</div>
           </div>
         </div>`,
    )
    .join("");

  // Chart — 7 bars; the peak is highlighted. Each grows up via clip-path.
  const heights = [44, 62, 38, 78, 96, 70, 58];
  const peak = 4;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const bars = heights
    .map(
      (h, i) =>
        `<div class="bar-col">
           <div class="bar ${i === peak ? "peak" : ""}" data-domotion-anim="bar${i}" style="height:${h}%"></div>
           <div class="bar-x">${days[i]}</div>
         </div>`,
    )
    .join("");

  // Activity rows — staggered fade-in.
  const activity = [
    ["#8b5cf6", "Ava Chen", "upgraded to Pro", "2m"],
    ["#34d399", "New signup", "from /pricing", "9m"],
    ["#f59e0b", "Invoice #1042", "paid · $290", "23m"],
    ["#ec4899", "Liam Park", "left a review", "1h"],
  ];
  const rows = activity
    .map(
      ([dot, who, what, when], i) =>
        `<div class="act" data-domotion-anim="act${i}">
           <span class="act-dot" style="background:${dot}"></span>
           <span class="act-who">${who}</span>
           <span class="act-what">${what}</span>
           <span class="act-when">${when}</span>
         </div>`,
    )
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${APP_W}px;height:${APP_H}px;background:radial-gradient(120% 120% at 0% 0%, #141a32 0%, #0b1020 60%);
  color:#eef1fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;overflow:hidden;display:flex}
.side{width:212px;flex:none;height:100%;padding:22px 16px;border-right:1px solid #222a47;display:flex;flex-direction:column;gap:6px;background:#0e1326}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-0.02em;margin-bottom:14px}
.brand .logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#8b5cf6,#ec4899);box-shadow:0 4px 14px rgba(139,92,246,0.5)}
.nav{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;color:#9aa3c7;font-size:14px;font-weight:500}
.nav-dot{width:7px;height:7px;border-radius:50%;background:#39426b}
.nav.active{background:linear-gradient(90deg,rgba(139,92,246,0.22),rgba(236,72,153,0.10));color:#fff;font-weight:600}
.nav.active .nav-dot{background:linear-gradient(135deg,#8b5cf6,#ec4899)}
.upsell{margin-top:auto;background:linear-gradient(135deg,rgba(139,92,246,0.18),rgba(236,72,153,0.12));border:1px solid #2c2150;border-radius:12px;padding:14px}
.upsell b{font-size:13px}.upsell p{font-size:12px;color:#9aa3c7;margin:4px 0 10px}
.upsell .btn{display:block;text-align:center;font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#8b5cf6,#ec4899);border-radius:8px;padding:7px}
.main{flex:1;height:100%;padding:22px 24px;display:flex;flex-direction:column;gap:18px;overflow:hidden}
.top{display:flex;align-items:center;justify-content:space-between}
.top h1{font-size:22px;font-weight:800;letter-spacing:-0.02em}
.top .right{display:flex;align-items:center;gap:12px}
.search{display:flex;align-items:center;gap:8px;width:220px;background:#141a30;border:1px solid #28304f;border-radius:10px;padding:8px 12px;color:#7d86ad;font-size:13px}
.search .mag{width:13px;height:13px;border:2px solid #6b74a0;border-radius:50%;position:relative}
.search .mag::after{content:'';position:absolute;width:6px;height:2px;background:#6b74a0;transform:rotate(45deg);right:-5px;bottom:-1px}
.bell{width:34px;height:34px;border-radius:9px;background:#141a30;border:1px solid #28304f}
.avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#34d399,#22d3ee)}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.kpi{background:#141a30;border:1px solid #232b4a;border-radius:14px;padding:16px 18px}
.kpi-label{font-size:12px;color:#8b93b8;font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
.kpi-value{font-size:30px;font-weight:800;letter-spacing:-0.02em;margin:8px 0 8px}
.trend{display:inline-block;font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px}
.trend.up{color:#34d399;background:rgba(52,211,153,0.12)}
.trend.down{color:#fb7185;background:rgba(251,113,133,0.12)}
.lower{display:grid;grid-template-columns:1.55fr 1fr;gap:16px;flex:1;min-height:0}
.card{background:#141a30;border:1px solid #232b4a;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column}
.card-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}
.card-head .t{font-size:15px;font-weight:700}
.card-head .s{font-size:12px;color:#8b93b8}
.chart{flex:1;display:flex;align-items:flex-end;gap:14px;padding-top:6px}
.bar-col{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px}
.bar{width:100%;max-width:34px;border-radius:7px 7px 3px 3px;background:linear-gradient(180deg,#7c84ff,#6366f1);min-height:6px}
.bar.peak{background:linear-gradient(180deg,#a78bfa,#ec4899);box-shadow:0 6px 18px rgba(236,72,153,0.45)}
.bar-x{font-size:11px;color:#7d86ad;font-weight:500}
.act{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #1f2742;font-size:13px}
.act:last-child{border-bottom:none}
.act-dot{width:9px;height:9px;border-radius:50%;flex:none}
.act-who{font-weight:700}
.act-what{color:#8b93b8;flex:1}
.act-when{color:#6b74a0;font-size:12px}
</style></head><body>
  <div class="side">
    <div class="brand" data-domotion-anim="brand"><span class="logo"></span>Pulse</div>
    ${navItems}
    <div class="upsell" data-domotion-anim="upsell"><b>Go Pro</b><p>Unlimited dashboards & exports.</p><span class="btn">Upgrade</span></div>
  </div>
  <div class="main">
    <div class="top" data-domotion-anim="top">
      <h1>Overview</h1>
      <div class="right">
        <div class="search"><span class="mag"></span><span class="ph">Search…</span></div>
        <div class="bell"></div><div class="avatar"></div>
      </div>
    </div>
    <div class="kpis">${kpiCards}</div>
    <div class="lower">
      <div class="card" data-domotion-anim="chartCard">
        <div class="card-head"><span class="t">Revenue</span><span class="s">Last 7 days</span></div>
        <div class="chart">${bars}</div>
      </div>
      <div class="card" data-domotion-anim="actCard">
        <div class="card-head"><span class="t">Recent activity</span></div>
        ${rows}
      </div>
    </div>
  </div>
</body></html>`;
}

/** Browser window chrome (traffic lights + a URL pill) sized to the app. */
function windowChrome(w: number, h: number): string {
  const url = "app.pulse.dev/overview";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + BAR}" viewBox="0 0 ${w} ${h + BAR}">` +
    `<rect width="${w}" height="${h + BAR}" rx="${RAD}" fill="#0e1326"/>` +
    `<rect x="0" y="${BAR}" width="${w}" height="${h}" fill="#0b1020"/>` +
    `<circle cx="22" cy="${BAR / 2}" r="6" fill="#ff5f56"/>` +
    `<circle cx="42" cy="${BAR / 2}" r="6" fill="#ffbd2e"/>` +
    `<circle cx="62" cy="${BAR / 2}" r="6" fill="#27c93f"/>` +
    `<rect x="${w / 2 - 130}" y="${BAR / 2 - 11}" width="260" height="22" rx="11" fill="#161c34"/>` +
    `<text x="${w / 2}" y="${BAR / 2 + 4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="12" fill="#8b93b8">${url}</text>` +
    `<line x1="0" y1="${BAR}" x2="${w}" y2="${BAR}" stroke="#000" stroke-width="1" opacity="0.35"/></svg>`
  );
}

/** Gradient backdrop with a soft drop shadow behind the window box. */
function backdrop(W: number, H: number, winX: number, winY: number, winW: number, winH: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#231a52"/><stop offset="0.5" stop-color="#1a1140"/><stop offset="1" stop-color="#3a1538"/></linearGradient>` +
    `<radialGradient id="glow" cx="18%" cy="12%" r="70%"><stop offset="0" stop-color="#8b5cf6" stop-opacity="0.45"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient>` +
    `<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="20" stdDeviation="34" flood-color="#000" flood-opacity="0.5"/></filter>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#glow)"/>` +
    `<rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RAD}" fill="#0b1020" filter="url(#shadow)"/></svg>`
  );
}

/** Helpers to keep the animation list readable. */
const fade = (id: string, delay: number, dur = 520): IntraFrameAnimation => ({ animId: id, property: "opacity", from: "0", to: "1", duration: dur, delay, easing: "ease-out" });
const rise = (id: string, delay: number, px = 22, dur = 560): IntraFrameAnimation => ({ animId: id, property: "translateY", from: `${px}px`, to: "0px", duration: dur, delay, easing: "cubic-bezier(0.22,0.61,0.36,1)" });
const growUp = (id: string, delay: number, dur = 560): IntraFrameAnimation => ({ animId: id, property: "clipPath", from: "inset(100% 0 0 0)", to: "inset(0 0 0 0)", duration: dur, delay, easing: "cubic-bezier(0.22,0.61,0.36,1)" });

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  clearEmbeddedFonts();

  const browser = await chromium.launch();
  let appSvg = "";
  try {
    const ctx = await browser.newContext({ viewport: { width: APP_W, height: APP_H } });
    const pg = await ctx.newPage();
    await pg.setContent(dashboardHtml(), { waitUntil: "load" });
    await pg.waitForTimeout(200);
    const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: APP_W, height: APP_H });
    await embedRemoteImages(tree);
    const content = elementTreeToSvgInner(tree, APP_W, APP_H, "h-", true, 2, false);

    // Staggered entrance.
    const animations: IntraFrameAnimation[] = [
      fade("top", 0),
      fade("brand", 80),
      ...[0, 1, 2, 3, 4].map((i) => fade(`nav${i}`, 140 + i * 70)),
      fade("upsell", 520),
      // KPI cards: fade (outer) + rise (inner).
      ...[0, 1, 2].flatMap((i) => [fade(`kpiFade${i}`, 540 + i * 130), rise(`kpiRise${i}`, 540 + i * 130)]),
      fade("chartCard", 940),
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => growUp(`bar${i}`, 1120 + i * 80)),
      fade("actCard", 1000),
      ...[0, 1, 2, 3].map((i) => fade(`act${i}`, 1300 + i * 130)),
    ];

    const frames: AnimationFrame[] = [
      {
        svgContent: content,
        duration: LOOP,
        overlays: [
          {
            // The search box types a query each loop. The "Search…" placeholder
            // sits at x≈658, baseline≈44 (probed); mask it with the field bg.
            kind: "typing",
            text: "revenue",
            x: 658,
            y: 44,
            fontSize: 13,
            color: "#eef1fb",
            delay: 2100,
            speed: 80,
            mask: { color: "#141a30", width: 96, height: 18 },
          },
          // A click ripples on the "Revenue" nav item (center ≈ 105, 208).
          { kind: "tap", x: 105, y: 208, delay: 3000 },
        ],
        animations,
      },
    ];

    appSvg = generateAnimatedSvg({ width: APP_W, height: APP_H, frames, fontFaceCss: getEmbeddedFontFaceCss(), background: "#0b1020" });
  } finally {
    await browser.close();
  }

  // Compose: backdrop + window chrome + the animated app on its own timeline.
  const winW = APP_W;
  const winH = APP_H + BAR;
  const W = winW + MARGIN * 2;
  const H = winH + MARGIN * 2;
  const layers: CompositeLayer[] = [
    { svg: backdrop(W, H, MARGIN, MARGIN, winW, winH), x: 0, y: 0, width: W, height: H },
    { svg: windowChrome(APP_W, APP_H), x: MARGIN, y: MARGIN, width: winW, height: winH },
    { svg: appSvg, periodMs: LOOP, x: MARGIN, y: MARGIN + BAR, width: APP_W, height: APP_H, clipRadius: 0 },
  ];

  const result = composeAnimatedLayers(layers, { width: W, height: H, durationMs: LOOP });
  let svg = result.svg;
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${result.width}×${result.height}px, ${(svg.length / 1024).toFixed(1)} KB)`);
}

void main();
