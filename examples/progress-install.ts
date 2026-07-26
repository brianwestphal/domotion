/**
 * Example: a realistic `npm install domotion-svg` session, rendered as an
 * animated terminal SVG.
 *
 * This drives the SAME terminal pipeline the `domotion term --cast` CLI uses
 * (`castToAnimatedSvg`, doc 67) in its default `incremental` mode — the
 * terminal's compressed-run analog: each distinct LINE-STATE is rendered once
 * and revealed on its own timeline, so the window chrome and the settled lines
 * emit a single time and only the changing line animates. The cast is authored
 * as an asciinema v2 recording so it flows through the exact path a real
 * `asciinema rec` capture would: the command types in one key at a time, npm's
 * braille reify spinner cycles in place (carriage-return overwrites — the other
 * half of the incremental composer), then the completion summary lands and the
 * prompt returns with a blinking caret.
 *
 * The terminal is composited into macOS-style window chrome (traffic lights +
 * title bar, over a soft-shadowed backdrop) via `composeAnimatedLayers`, matching
 * `terminal-demo.ts`, so it reads as a real window rather than floating text.
 *
 * Usage: npx tsx examples/progress-install.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { castToAnimatedSvg } from "../src/terminal/index.js";
import { composeAnimatedLayers, type CompositeLayer } from "../src/animation/composite.js";

const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "progress-install.svg");
const ESC = String.fromCharCode(27); // ANSI escape (0x1b) for SGR color / erase
const MARGIN = 28; // breathing room around the window on the backdrop
const BAR = 36; // window title-bar height
const RAD = 11; // window corner radius
const BG = "#0d1117"; // terminal + window body (matches the chrome, seamless)
const FG = "#c9d1d9"; // default terminal foreground

/**
 * A recorded `npm install domotion-svg`, authored as an asciinema v2 cast so it
 * flows through the exact `domotion term` path a real recording would. The
 * command types a character at a time; npm's reify progress is a braille spinner
 * updated in place with `\r`; the summary clears the progress line and prints
 * the result.
 */
function buildInstallCast(): string {
  const prompt = `${ESC}[1;32m➜${ESC}[0m  ${ESC}[1;36m~/project${ESC}[0m `;
  const CMD = "npm install domotion-svg";
  const spin = "⠋⠙⠹⠸⠼⠴⠦⠧"; // npm's braille reify spinner
  const targets = [
    "resolving dependencies",
    "fetching domotion-svg",
    "fetching fontkit",
    "building fresh packages",
    "linking dependencies",
    "finalizing install",
  ];
  const ev: [number, string, string][] = [];
  ev.push([0.4, "o", prompt]);
  // Type the command one key at a time — each keystroke is its own line-state
  // the incremental composer reveals on its timeline (real typed-input feel).
  let t = 1.0;
  for (const ch of CMD) { ev.push([t, "o", ch]); t += 0.055; }
  ev.push([t + 0.2, "o", "\r\n"]);
  // The reify spinner: overwrite the same row via a carriage return each tick.
  // Trailing spaces pad the shrinking target text so no remnant is left behind.
  let st = t + 0.5;
  for (let i = 0; i < targets.length; i++) {
    const line = `${ESC}[36m${spin[i % spin.length]}${ESC}[0m reify:${ESC}[2m${targets[i]}${ESC}[0m`;
    ev.push([st, "o", (i === 0 ? "" : "\r") + line + " ".repeat(8)]);
    st += 0.32;
  }
  // Clear the progress line (\r + erase-to-end) and print the completion summary.
  ev.push([st + 0.1, "o", `\r${ESC}[K${ESC}[32madded 24 packages${ESC}[0m ${ESC}[2min 3s${ESC}[0m\r\n`]);
  ev.push([st + 0.5, "o", `${ESC}[32m✓${ESC}[0m domotion-svg ready to render\r\n`]);
  ev.push([st + 1.0, "o", `\r\n${prompt}`]);
  ev.push([st + 2.2, "o", ""]); // tail hold on the returned prompt
  return JSON.stringify({ version: 2, width: 58, height: 8, title: "npm" }) + "\n" +
    ev.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** macOS window chrome (traffic lights + title bar) sized to the terminal box. */
function windowChrome(w: number, h: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + BAR}" viewBox="0 0 ${w} ${h + BAR}">` +
    `<rect width="${w}" height="${h + BAR}" rx="${RAD}" fill="#161b22"/>` +
    `<rect x="0" y="${BAR}" width="${w}" height="${h}" fill="${BG}"/>` +
    `<circle cx="20" cy="${BAR / 2}" r="6" fill="#ff5f56"/>` +
    `<circle cx="40" cy="${BAR / 2}" r="6" fill="#ffbd2e"/>` +
    `<circle cx="60" cy="${BAR / 2}" r="6" fill="#27c93f"/>` +
    `<text x="${w / 2}" y="${BAR / 2 + 4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="12" fill="#6e7681">zsh — ~/project</text>` +
    `<line x1="0" y1="${BAR}" x2="${w}" y2="${BAR}" stroke="#000" stroke-width="1" opacity="0.4"/></svg>`
  );
}

/** A near-black backdrop with a soft drop shadow behind the window's box. */
function backdrop(W: number, H: number, winX: number, winY: number, winW: number, winH: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#000" flood-opacity="0.5"/></filter></defs>` +
    `<rect width="${W}" height="${H}" fill="#010409"/>` +
    `<rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RAD}" fill="${BG}" filter="url(#shadow)"/></svg>`
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    // The real terminal pipeline — identical to `domotion term --cast`.
    const term = await castToAnimatedSvg(buildInstallCast(), browser, {
      // GitHub-dark palette overriding the built-in `dark` base, so the terminal
      // body matches the window chrome seamlessly.
      theme: { extends: "dark", bg: BG, fg: FG },
      cursor: "bar",
      fontSize: 14,
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
