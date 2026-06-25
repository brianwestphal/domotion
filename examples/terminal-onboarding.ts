/**
 * Example: a project-onboarding terminal session as a real `domotion term`
 * capture, composited into macOS window chrome.
 *
 * Drives the SAME pipeline as `domotion term --cast` (`castToAnimatedSvg`, doc
 * 67): one continuous asciinema v2 cast — clone → install → configure → run —
 * is replayed through the headless VT emulator and rendered to native SVG (real
 * text as glyph paths, real ANSI color, native incremental animation, no raster
 * frames). Because the terminal types its commands and reveals output natively,
 * there are no typing-overlay / clip-path timing hacks to drift out of sync.
 *
 * The terminal is then composited into a macOS window (traffic lights + title
 * bar) on a soft gradient backdrop via `composeAnimatedLayers`, exactly like
 * `terminal-demo.ts`.
 *
 * Usage: npx tsx examples/terminal-onboarding.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { castToAnimatedSvg } from "../src/terminal/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../src/animation/composite.js";

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "terminal-onboarding.svg");
const ESC = String.fromCharCode(27); // ANSI escape (0x1b) for SGR color
const MARGIN = 28; // breathing room around the window on the backdrop
const BAR = 36; // window title-bar height
const RAD = 11; // window corner radius

// SGR color helpers (Catppuccin palette via the default `term` theme).
const g = (s: string) => `${ESC}[32m${s}${ESC}[0m`; // green   #a6e3a1
const b = (s: string) => `${ESC}[34m${s}${ESC}[0m`; // blue    #89b4fa
const y = (s: string) => `${ESC}[33m${s}${ESC}[0m`; // yellow  #f9e2af
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`; // faint

/**
 * A continuous project-onboarding session, authored as an asciinema v2 cast so
 * it flows through the exact `domotion term --cast` path. Four commands run in
 * sequence; each command is typed, then its output streams in, then the next
 * prompt appears — the renderer paces it all natively.
 */
function buildOnboardingCast(): string {
  const home = `${g("➜")}  ${b("~")} `;
  const web = `${g("➜")}  ${b("web")} `;
  const ev: [number, string, string][] = [
    // 1 — clone
    [0.5, "o", home],
    [1.4, "o", "git clone https://github.com/acme/web.git\r\n"],
    [1.9, "o", `${dim("Cloning into 'web'…")}\r\n`],
    [2.4, "o", `${dim("remote: Enumerating objects: 1284, done.")}\r\n`],
    [2.9, "o", `${dim("Receiving objects: 100% (1284/1284), 4.2 MiB | 8.1 MiB/s")}\r\n`],
    [3.4, "o", `${g("✓")} Cloned in 2.1s\r\n`],
    [3.9, "o", `\r\n${home}`],
    // 2 — install
    [4.8, "o", "cd web && npm install\r\n"],
    [5.4, "o", `${dim("added 412 packages in 6s")}\r\n`],
    [5.9, "o", `${g("✓")} Dependencies installed\r\n`],
    [6.4, "o", `\r\n${web}`],
    // 3 — configure
    [7.3, "o", "npm run setup\r\n"],
    [7.9, "o", `${dim("Writing .env · seeding database…")}\r\n`],
    [8.4, "o", `${g("✓")} Project configured\r\n`],
    [8.9, "o", `\r\n${web}`],
    // 4 — run
    [9.8, "o", "npm run dev\r\n"],
    [10.4, "o", `\r\n  ${y("VITE")} ${dim("v5.2.0")}  ready in 312 ms\r\n\r\n`],
    [10.9, "o", `  ${g("➜")}  ${"Local"}:   ${b("http://localhost:5173/")}\r\n`],
    [11.4, "o", `  ${g("➜")}  ${"Network"}: ${dim("use --host to expose")}\r\n`],
    [11.9, "o", `\r\n${g("✓")} Dev server running — you're up and running 🎉\r\n`],
    [14.0, "o", ""],
  ];
  return JSON.stringify({ version: 2, width: 64, height: 16, title: "onboarding" }) + "\n" +
    ev.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** macOS window chrome (traffic lights + title bar) sized to the terminal box. */
function windowChrome(w: number, h: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + BAR}" viewBox="0 0 ${w} ${h + BAR}">` +
    `<rect width="${w}" height="${h + BAR}" rx="${RAD}" fill="#2b2b35"/>` +
    `<rect x="0" y="${BAR}" width="${w}" height="${h}" fill="#11111b"/>` +
    `<circle cx="20" cy="${BAR / 2}" r="6" fill="#ff5f56"/>` +
    `<circle cx="40" cy="${BAR / 2}" r="6" fill="#ffbd2e"/>` +
    `<circle cx="60" cy="${BAR / 2}" r="6" fill="#27c93f"/>` +
    `<text x="${w / 2}" y="${BAR / 2 + 4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="12" fill="#8b949e">web — onboarding</text>` +
    `<line x1="0" y1="${BAR}" x2="${w}" y2="${BAR}" stroke="#000" stroke-width="1" opacity="0.4"/></svg>`
  );
}

/** A gradient backdrop with a soft drop shadow behind the window's box. */
function backdrop(W: number, H: number, winX: number, winY: number, winW: number, winH: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2735"/><stop offset="1" stop-color="#2d1b3a"/></linearGradient>` +
    `<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/></filter>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RAD}" fill="#11111b" filter="url(#shadow)"/></svg>`
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    // The real terminal pipeline — identical to `domotion term --cast`.
    const term = await castToAnimatedSvg(buildOnboardingCast(), browser, {
      theme: "catppuccin",
      cursor: "block",
    });

    const winW = term.width;
    const winH = term.height + BAR;
    const W = winW + MARGIN * 2;
    const H = winH + MARGIN * 2;

    const layers: CompositeLayer[] = [
      { svg: backdrop(W, H, MARGIN, MARGIN, winW, winH), x: 0, y: 0, width: W, height: H },
      { svg: windowChrome(term.width, term.height), x: MARGIN, y: MARGIN, width: winW, height: winH },
      { svg: term.svg, periodMs: term.totalDurationMs, x: MARGIN, y: MARGIN + BAR, width: term.width, height: term.height },
    ];

    const result = composeAnimatedLayers(layers, { width: W, height: H, durationMs: term.totalDurationMs });
    writeFileSync(OUTPUT, result.svg);
    console.log(`Generated: ${OUTPUT} (${result.width}×${result.height}px, ${(result.svg.length / 1024).toFixed(1)} KB, ${term.frameCount} frames)`);
  } finally {
    await browser.close();
  }
}

void main();
