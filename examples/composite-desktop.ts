/**
 * Showcase: nested animated compositing with a real window resize (DM-1323).
 *
 * A macOS-like **desktop** (gradient wallpaper, menu bar, dock) with a **terminal
 * window** running a real build session. Half-way through, the mouse pointer drags
 * the window's right edge inward and the **window resizes** — which, like a real
 * terminal, changes the column count so the content **reflows** (a long path wraps
 * to two lines). The window's traffic-light **buttons keep their size** (windows
 * don't scale their chrome), and the terminal is NOT scaled — it genuinely
 * re-lays-out at the new width.
 *
 * This is the end-to-end proof of `composeAnimatedLayers`, and it is genuinely a
 * THREE-step composite, which is what makes the resize correct:
 *
 *   1. **Terminal layer (pre-composite).** A cast with a mid-session `resize`
 *      event (80 → 50 cols) renders to an animated terminal that reflows at the
 *      resize — `buildFrames` tells us the reflow's *rendered* time and the
 *      before/after column counts, so the chrome can match it.
 *   2. **Window layer.** The terminal is composited into window chrome (traffic
 *      lights + title bar, fixed) — `composeAnimatedLayers` step 2.
 *   3. **Desktop layer.** The window is placed on the desktop and given a
 *      `clipScaleX` resize animation (shrinks the window's box from the right,
 *      buttons untouched) matched to the terminal's reflow time, plus a cursor
 *      that drags the right edge in sync — `composeAnimatedLayers` step 3.
 *
 *   npx tsx examples/composite-desktop.ts   →  examples/output/composite-desktop.svg
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { parseCast } from "../src/terminal/cast.js";
import { TerminalEmulator } from "../src/terminal/emulator.js";
import { buildFrames } from "../src/terminal/render.js";
import { castToAnimatedSvg } from "../src/terminal/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../src/animation/composite.js";

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "composite-desktop.svg");
const PAD = 16; // terminal padding (TERM_TYPE_DEFAULTS.padding)
const ESC = String.fromCharCode(27); // ANSI escape (0x1b) for SGR color

/** A build session that resizes the terminal 80 → 50 cols mid-run (reflows a long path). */
function buildResizingCast(): string {
  const ev: [number, string, string][] = [
    [0.5, "o", `${ESC}[1;32m➜${ESC}[0m  ${ESC}[1;36m~/widget${ESC}[0m `],
    [1.3, "o", "npm run build"],
    [2.0, "o", "\r\n\r\n> widget@2.1.0 build\r\n> tsc && vite build\r\n\r\n"],
    [3.0, "o", `${ESC}[36mvite v5.0.0 building for production...${ESC}[0m\r\n`],
    [4.2, "o", "transforming: /Users/ada/projects/widget/src/components/Button.tsx\r\n"],
    [5.2, "o", `${ESC}[32m✓${ESC}[0m 142 modules transformed in 1.24s\r\n`],
    [6.0, "r", "50x18"], // ← the resize: terminal reflows to 50 cols
    [6.6, "o", `${ESC}[32m✓${ESC}[0m built dist/widget.js  ${ESC}[2m(48 kB)${ESC}[0m\r\n`],
    [7.6, "o", `${ESC}[1;32m➜${ESC}[0m  ${ESC}[1;36m~/widget${ESC}[0m ${ESC}[0m`],
  ];
  return JSON.stringify({ version: 2, width: 80, height: 18, title: "build" }) + "\n" +
    ev.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Static macOS-like desktop: gradient wallpaper, menu bar, dock with icons. */
function desktopSvg(W: number, H: number): string {
  const dock = ["#4f9dff", "#5be584", "#b07bff", "#ffb15b", "#ff7eb3", "#4be0d0"];
  const dockW = dock.length * 68 + 24;
  const dockX = (W - dockW) / 2;
  const icons = dock.map((c, i) => `<rect x="${dockX + 12 + i * 68}" y="${H - 80}" width="56" height="56" rx="14" fill="${c}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a1c71"/><stop offset="0.5" stop-color="#d76d77"/><stop offset="1" stop-color="#ffaf7b"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#wall)"/>` +
    `<rect width="${W}" height="26" fill="#00000055"/>` +
    `<text x="16" y="18" font-family="-apple-system,system-ui,sans-serif" font-size="13" font-weight="700" fill="#fff">Finder</text>` +
    `<text x="${W - 92}" y="18" font-family="-apple-system,system-ui,sans-serif" font-size="13" fill="#fff">Tue 9:41</text>` +
    `<rect x="${dockX}" y="${H - 92}" width="${dockW}" height="80" rx="22" fill="#ffffff22" stroke="#ffffff33"/>${icons}</svg>`
  );
}

/** macOS window chrome (fixed-size traffic lights + title bar) around a terminal box. */
function windowChrome(w: number, h: number, bar: number, rad: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + bar}" viewBox="0 0 ${w} ${h + bar}">` +
    `<rect width="${w}" height="${h + bar}" rx="${rad}" fill="#2b2b2e"/>` +
    `<rect x="0" y="${bar}" width="${w}" height="${h}" fill="#1e1e2e"/>` +
    `<circle cx="18" cy="18" r="6" fill="#ff5f56"/><circle cx="38" cy="18" r="6" fill="#ffbd2e"/><circle cx="58" cy="18" r="6" fill="#27c93f"/>` +
    `<text x="80" y="22" font-family="-apple-system,system-ui,sans-serif" font-size="12" fill="#8b949e">widget — build</text>` +
    `<line x1="0" y1="${bar}" x2="${w}" y2="${bar}" stroke="#000" stroke-width="1" opacity="0.4"/></svg>`
  );
}

const CURSOR_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 28 28">` +
  `<path d="M5 3 L5 22 L10 17 L13 24 L16 23 L13 16 L20 16 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const cast = buildResizingCast();

    // STEP 1 — terminal layer. Learn the reflow's rendered time + before/after cols
    // from buildFrames (it carries each settle-point's grid + durationMs), then
    // render the animated terminal (full mode honors resizes robustly).
    const parsed = parseCast(cast);
    const emu = new TerminalEmulator(parsed.header.width, parsed.header.height);
    const frames = await buildFrames(emu, parsed.events, {}, parsed.resizes);
    const colsBefore = Math.max(...frames.map((f) => f.grid[0].length));
    const reflowIdx = frames.findIndex((f) => f.grid[0].length < colsBefore);
    const colsAfter = frames[reflowIdx].grid[0].length;
    const reflowMs = frames.slice(0, reflowIdx).reduce((s, f) => s + f.durationMs, 0);

    const term = await castToAnimatedSvg(cast, browser, { mode: "full", theme: "dark" });
    const charW = (term.width - 2 * PAD) / colsBefore;
    const shrinkPx = (colsBefore - colsAfter) * charW; // px the window loses on the right

    // STEP 2 — window layer: terminal composited into fixed-size chrome.
    const BAR = 36, RAD = 11;
    const Wwin = term.width, Hwin = term.height + BAR;
    const windowSvg = composeAnimatedLayers(
      [
        { svg: windowChrome(term.width, term.height, BAR, RAD), x: 0, y: 0, width: Wwin, height: Hwin },
        { svg: term.svg, periodMs: term.totalDurationMs, x: 0, y: BAR, width: term.width, height: term.height },
      ],
      { width: Wwin, height: Hwin, durationMs: term.totalDurationMs },
    );

    // STEP 3 — desktop layer: window (clipScaleX resize, matched to the reflow) +
    // cursor dragging the right edge in sync.
    const W = 1180, H = 760, winX = 180, winY = 110;
    const shrinkDur = 700;
    const edgeBefore = winX + Wwin, edgeAfter = edgeBefore - shrinkPx, edgeY = winY + Hwin / 2;
    const layers: CompositeLayer[] = [
      { svg: desktopSvg(W, H), x: 0, y: 0, width: W, height: H },
      {
        svg: windowSvg.svg, periodMs: windowSvg.durationMs, x: winX, y: winY, width: Wwin, height: Hwin, clipRadius: RAD,
        animations: [{ property: "clipScaleX", from: 1, to: (Wwin - shrinkPx) / Wwin, start: reflowMs, duration: shrinkDur, easing: "ease-in-out", transformOrigin: "left" }],
      },
      {
        svg: CURSOR_SVG, x: 0, y: 0, width: 26, height: 26,
        animations: [
          { property: "transform", from: `translate(${edgeBefore - 300}px,${edgeY - 160}px)`, to: `translate(${edgeBefore - 6}px,${edgeY}px)`, start: reflowMs - 1500, duration: 1500, easing: "ease-out" },
          { property: "transform", from: `translate(${edgeBefore - 6}px,${edgeY}px)`, to: `translate(${edgeAfter - 6}px,${edgeY}px)`, start: reflowMs, duration: shrinkDur, easing: "ease-in-out" },
        ],
      },
    ];
    const result = composeAnimatedLayers(layers, { width: W, height: H, background: "#000", durationMs: term.totalDurationMs });
    writeFileSync(OUTPUT, result.svg);
    console.log(`Wrote ${OUTPUT} — ${result.width}×${result.height}px, ${(result.durationMs / 1000).toFixed(1)}s loop, ${(result.svg.length / 1024).toFixed(1)} KB (terminal ${colsBefore}→${colsAfter} cols at ${(reflowMs / 1000).toFixed(1)}s)`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
