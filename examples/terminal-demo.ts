/**
 * Example: a real `domotion term` capture, rendered as an animated terminal SVG.
 *
 * This drives the SAME terminal pipeline the `domotion term --cast` CLI uses
 * (`castToAnimatedSvg`, doc 67): an asciinema v2 cast is replayed through the
 * headless VT emulator and rendered to native SVG — real text as glyph paths,
 * real ANSI color, native CSS animation, no raster frames. The cast itself
 * showcases a `domotion` session (capturing a page, then converting a recorded
 * build log), so the demo is self-referential.
 *
 * The terminal is then composited into macOS-style window chrome (traffic
 * lights + title bar) via `composeAnimatedLayers` so it reads as a real window
 * rather than floating text on a slab.
 *
 * Usage: npx tsx examples/terminal-demo.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { castToAnimatedSvg } from "../src/terminal/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../src/animation/composite.js";

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "terminal-demo.svg");
const ESC = String.fromCharCode(27); // ANSI escape (0x1b) for SGR color
const MARGIN = 28; // breathing room around the window on the backdrop
const BAR = 36; // window title-bar height
const RAD = 11; // window corner radius

/**
 * A recorded `domotion` CLI session: capture a page to an SVG, then convert a
 * recorded terminal session to an animated SVG. Authored as an asciinema v2 cast
 * so it flows through the exact same `domotion term` path a real recording would.
 */
function buildDemoCast(): string {
  const prompt = `${ESC}[1;32m➜${ESC}[0m  ${ESC}[1;36m~/site${ESC}[0m `;
  const ev: [number, string, string][] = [
    [0.5, "o", prompt],
    [1.3, "o", "domotion capture https://example.com -o hero.svg"],
    [2.1, "o", "\r\n"],
    [2.5, "o", `${ESC}[32m  ✓${ESC}[0m Captured body ${ESC}[2m→${ESC}[0m hero.svg\r\n`],
    [2.9, "o", `${ESC}[2m    52 kB · self-contained · text as glyph paths${ESC}[0m\r\n`],
    [3.3, "o", `\r\n${prompt}`],
    [4.3, "o", "domotion term --cast build.cast -o build.svg"],
    [5.1, "o", "\r\n"],
    [5.5, "o", `${ESC}[32m  ✓${ESC}[0m 17 frames ${ESC}[2m·${ESC}[0m 656×346px ${ESC}[2m·${ESC}[0m 13.6s ${ESC}[2m·${ESC}[0m 45.3 kB\r\n`],
    [5.9, "o", `${ESC}[2m    → real text, native SVG animation${ESC}[0m\r\n`],
    [6.3, "o", `\r\n${prompt}`],
    [8.0, "o", ""],
  ];
  return JSON.stringify({ version: 2, width: 60, height: 14, title: "domotion" }) + "\n" +
    ev.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** macOS window chrome (traffic lights + title bar) sized to the terminal box. */
function windowChrome(w: number, h: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + BAR}" viewBox="0 0 ${w} ${h + BAR}">` +
    `<rect width="${w}" height="${h + BAR}" rx="${RAD}" fill="#2b2b35"/>` +
    `<rect x="0" y="${BAR}" width="${w}" height="${h}" fill="#1e1e2e"/>` +
    `<circle cx="20" cy="${BAR / 2}" r="6" fill="#ff5f56"/>` +
    `<circle cx="40" cy="${BAR / 2}" r="6" fill="#ffbd2e"/>` +
    `<circle cx="60" cy="${BAR / 2}" r="6" fill="#27c93f"/>` +
    `<text x="${w / 2}" y="${BAR / 2 + 4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="12" fill="#8b949e">~/site — domotion</text>` +
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
    `<rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RAD}" fill="#1e1e2e" filter="url(#shadow)"/></svg>`
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    // The real terminal pipeline — identical to `domotion term --cast`.
    const term = await castToAnimatedSvg(buildDemoCast(), browser, {
      theme: "dark",
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
