/**
 * Example: a scrolling terminal session embedded in a window-chrome bezel.
 *
 * Authors a realistic, tall terminal session (git pull → pnpm install → test →
 * build → fly deploy) as HTML/CSS, captures it to a STATIC inner SVG, then
 * composes a viewport-clipped auto-scroll animation over it — the content is
 * taller than the window's screen, so it scrolls down to reveal the deploy, holds,
 * and scrolls back, looping. The scrolling SVG is wrapped in the shared `window`
 * device chrome (`wrapInDeviceChrome`, the single source of truth for the bezel),
 * so the terminal reads as a real macOS-style app window.
 *
 * Usage: npx tsx examples/terminal-window-scroll.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureElementTree,
  elementTreeToSvgInner,
} from "../src/render/element-tree-to-svg.js";
import {
  clearEmbeddedFonts,
  getEmbeddedFontFaceCss,
  wrapInDeviceChrome,
} from "../src/render/index.js";
import { optimizeSvg } from "./shared.js";

// Inner "screen" of the window (the chrome bar is added on top by the bezel).
const SCREEN_W = 860;
const SCREEN_H = 480;
const OUTPUT = resolve("examples/output/terminal-window-scroll.svg");

// A Tokyo-Night-adjacent palette that reads well on the bezel's dark screen.
const C = {
  bg: "#0d1117", // matches the dark window-chrome screen color so it's seamless
  dir: "#7aa2f7", // working-directory path
  branch: "#bb9af7", // git branch
  prompt: "#9ece6a", // the $ prompt glyph
  cmd: "#c0caf5", // the command the user typed
  text: "#a9b1d6", // ordinary output
  dim: "#565f89", // hashes, counts, meta
  ok: "#9ece6a", // success
  bad: "#f7768e", // deletions / errors
  num: "#e0af68", // sizes / numbers
  url: "#7dcfff", // links
} as const;

/** One styled span on a line. */
type Span = { t: string; c?: string; b?: boolean };
/** A line is a list of spans (empty list → a blank spacer line). */
type Line = Span[];

const sp = (t: string, c?: string, b?: boolean): Span => ({ t, c, b });
/** A `dir (branch)` prompt header line. ASCII-only so it's identical on every
 *  platform — powerline / Nerd-Font glyphs are private-use and render as tofu
 *  off-macOS, which the project's cross-platform rule forbids relying on. */
const promptHeader = (): Line => [
  sp("~/projects/aurora-api", C.dir, true),
  sp(" (", C.dim),
  sp("main", C.branch),
  sp(")", C.dim),
];
/** A `$ <command>` line. `$` is a universal, unambiguous prompt glyph. */
const command = (cmd: string): Line => [sp("$ ", C.prompt, true), sp(cmd, C.cmd)];
const out = (t: string, c: string = C.text): Line => [sp(t, c)];
const blank = (): Line => [];

const SESSION: Line[] = [
  promptHeader(),
  command("git pull origin main"),
  out("remote: Enumerating objects: 47, done.", C.dim),
  out("remote: Counting objects: 100% (47/47), done.", C.dim),
  out("remote: Compressing objects: 100% (28/28), done.", C.dim),
  out("Unpacking objects: 100% (31/31), 6.21 KiB | 884.00 KiB/s, done.", C.dim),
  out("From github.com:acme/aurora-api"),
  [sp("   a1b2c3d..d4e5f6a  ", C.dim), sp("main", C.branch), sp(" -> origin/main", C.dim)],
  out("Updating a1b2c3d..d4e5f6a"),
  out("Fast-forward"),
  [sp(" src/routes/billing.ts                     | ", C.text), sp("184 ", C.num), sp("+++++++++++++", C.ok), sp("---", C.bad)],
  [sp(" src/db/migrations/0042_add_invoices.sql   | ", C.text), sp(" 26 ", C.num), sp("++++++++++", C.ok)],
  [sp(" 12 files changed, ", C.text), sp("348 insertions(+)", C.ok), sp(", ", C.text), sp("102 deletions(-)", C.bad)],
  blank(),
  promptHeader(),
  command("pnpm install"),
  out("Lockfile is up to date, resolution step is skipped", C.dim),
  out("Packages: +12 -3"),
  out("Progress: resolved 612, reused 598, downloaded 14, added 12, done", C.dim),
  [sp("Done in ", C.text), sp("3.2s", C.num)],
  blank(),
  promptHeader(),
  command("pnpm test"),
  [sp(" RUN ", C.text), sp(" v1.5.0 ", C.dim), sp(" /home/acme/aurora-api", C.dim)],
  [sp(" ✓ ", C.ok), sp("src/auth/token.test.ts ", C.text), sp("(14)", C.dim)],
  [sp(" ✓ ", C.ok), sp("src/db/pool.test.ts ", C.text), sp("(9)", C.dim)],
  [sp(" ✓ ", C.ok), sp("src/routes/billing.test.ts ", C.text), sp("(21)", C.dim)],
  [sp(" ✓ ", C.ok), sp("src/lib/money.test.ts ", C.text), sp("(33)", C.dim)],
  [sp(" Test Files  ", C.dim), sp("18 passed", C.ok), sp(" (18)", C.dim)],
  [sp("      Tests  ", C.dim), sp("142 passed", C.ok), sp(" (142)", C.dim)],
  [sp("   Duration  ", C.dim), sp("6.41s", C.num)],
  blank(),
  promptHeader(),
  command("pnpm build"),
  [sp("vite ", C.text), sp("v5.2.1 ", C.dim), sp("building for production...", C.text)],
  [sp("✓ ", C.ok), sp("612 modules transformed.", C.text)],
  [sp("dist/index.js              ", C.text), sp("142.8 kB", C.num), sp(" | gzip: ", C.dim), sp("48.2 kB", C.num)],
  [sp("dist/assets/app-9f2c.css     ", C.text), sp("18.4 kB", C.num), sp(" | gzip: ", C.dim), sp("4.1 kB", C.num)],
  [sp("✓ built in ", C.ok), sp("4.12s", C.num)],
  blank(),
  promptHeader(),
  command("fly deploy"),
  out("==> Building image with Depot", C.dim),
  out("--> build: exporting layers   done", C.dim),
  out("==> Pushing image to fly", C.dim),
  out("--> pushing manifest          done", C.dim),
  out("==> Deploying aurora-api app"),
  [sp(" ✓ ", C.ok), sp("Machine 148edf2a3 update finished", C.text)],
  [sp(" ✓ ", C.ok), sp("Machine 39281b7c1 update finished", C.text)],
  [sp("Visit your newly deployed app at ", C.text), sp("https://aurora-api.fly.dev/", C.url)],
  blank(),
  promptHeader(),
  command("█"),
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the standalone terminal HTML. Flowed lines (natural height) so the
 *  captured content can run taller than the window screen and scroll. */
function buildTerminalHtml(lines: Line[]): string {
  const rows = lines
    .map((spans) => {
      if (spans.length === 0) return `<div class="row">&nbsp;</div>`;
      const inner = spans
        .map((s) => {
          const style = `color:${s.c ?? C.text};${s.b === true ? "font-weight:700;" : ""}`;
          return `<span style="${style}">${escapeHtml(s.t)}</span>`;
        })
        .join("");
      return `<div class="row">${inner}</div>`;
    })
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${SCREEN_W}px; background: ${C.bg}; }
  #term {
    width: ${SCREEN_W}px;
    padding: 18px 20px 22px;
    font-family: 'SF Mono', 'JetBrains Mono', Menlo, Monaco, monospace;
    font-size: 13px;
    line-height: 20px;
  }
  .row { white-space: pre; }
</style></head><body><div id="term">${rows}</div></body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(resolve("examples/output"), { recursive: true });

  const browser = await chromium.launch();
  // Capture viewport: full screen width, generously tall so every line paints.
  const context = await browser.newContext({ viewport: { width: SCREEN_W, height: 1400 } });
  const page = await context.newPage();

  const tmpPath = resolve("examples/output", "tmp-terminal-window.html");
  writeFileSync(tmpPath, buildTerminalHtml(SESSION));
  await page.goto(`file://${tmpPath}`);
  await page.waitForTimeout(100);

  // Measure the true content height so the scroll distance is exact.
  const contentH = Math.ceil(
    await page.evaluate(() => document.getElementById("term")!.getBoundingClientRect().height),
  );

  // Single-frame standalone capture. includeGlyphDefs true (keep this capture's
  // defs), but emit the embedded-font @font-face once at the scroll-SVG level
  // below (not per-capture) to avoid duplicating the base64 font bytes.
  clearEmbeddedFonts();
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: SCREEN_W, height: contentH });
  const termInner = elementTreeToSvgInner(tree, SCREEN_W, contentH, "t-", true, 2, false);
  await browser.close();

  // The amount we can scroll before the last line reaches the bottom edge.
  const maxScroll = Math.max(0, contentH - SCREEN_H);

  // Viewport-sized scrolling SVG: a background rect + the tall terminal content
  // on a `.scroller` group that translates up and back on a loop. The outer
  // <svg>'s viewBox clips everything outside the visible screen.
  const DURATION_S = 13;
  const scrollSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN_W}" height="${SCREEN_H}" viewBox="0 0 ${SCREEN_W} ${SCREEN_H}">` +
    `<style>` +
    getEmbeddedFontFaceCss() +
    `@keyframes term-scroll{` +
    `0%,7%{transform:translateY(0)}` +
    `48%,55%{transform:translateY(-${maxScroll}px)}` +
    `96%,100%{transform:translateY(0)}` +
    `}` +
    `.scroller{animation:term-scroll ${DURATION_S}s ease-in-out infinite}` +
    `</style>` +
    `<rect width="${SCREEN_W}" height="${SCREEN_H}" fill="${C.bg}"/>` +
    `<g class="scroller">${termInner}</g>` +
    `</svg>`;

  // Wrap the scrolling screen in the shared macOS-style window bezel.
  const framed = wrapInDeviceChrome(scrollSvg, "window", SCREEN_W, SCREEN_H, {
    label: "aurora-api — zsh",
    theme: "dark",
  });

  const svg = optimizeSvg(framed.svg);
  writeFileSync(OUTPUT, svg);
  console.log(
    `Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB, ${framed.width}×${framed.height}, ` +
      `content ${contentH}px → scrolls ${maxScroll}px)`,
  );
}

void main();
