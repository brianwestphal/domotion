/**
 * Terminal-session → animated SVG (DM-1225).
 *
 * Public entry: `castToAnimatedSvg(castText, browser, opts)`. Parses an
 * asciinema v2 cast, replays it through the headless VT emulator, selects
 * settle-point frames, renders each as terminal HTML, runs each HTML through
 * the normal capture→SVG pipeline, and stitches the frames into one animated
 * SVG with hard `cut` transitions (terminals don't crossfade).
 *
 * The whole backend is shared with a future live-PTY front-end (DM-1225): swap
 * the `parseCast` source for a `node-pty` byte stream and the rest is identical.
 */

import type { Browser } from "@playwright/test";
import { parseCast } from "./cast.js";
import { TerminalEmulator } from "./emulator.js";
import { buildFrames, gridToHtml, type FrameBuildOptions, type HtmlRenderOptions } from "./render.js";
import { THEMES, type TerminalTheme } from "./theme.js";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../render/element-tree-to-svg.js";
import { generateAnimatedSvg, type AnimationFrame } from "../animation/animator.js";

export interface TermToSvgOptions extends FrameBuildOptions {
  /** Theme name (`catppuccin` | `dark` | `github-light`) or a TerminalTheme. Default `catppuccin`. */
  theme?: string | TerminalTheme;
  /** Override the cast's recorded columns. */
  cols?: number;
  /** Override the cast's recorded rows. */
  rows?: number;
  /** Font size in px. Default 14. */
  fontSize?: number;
  /** Monospace font stack override. */
  fontFamily?: string;
  /** Padding around the grid in px. Default 16. */
  padding?: number;
  /** Optional progress log. */
  log?: (msg: string) => void;
}

export interface TermToSvgResult {
  svg: string;
  width: number;
  height: number;
  frameCount: number;
}

function resolveTheme(theme: string | TerminalTheme | undefined): TerminalTheme {
  if (theme == null) return THEMES.catppuccin;
  if (typeof theme !== "string") return theme;
  const t = THEMES[theme];
  if (t == null) throw new Error(`term: unknown theme "${theme}" (have: ${Object.keys(THEMES).join(", ")})`);
  return t;
}

export async function castToAnimatedSvg(
  castText: string,
  browser: Browser,
  opts: TermToSvgOptions = {},
): Promise<TermToSvgResult> {
  const log = opts.log ?? (() => {});
  const theme = resolveTheme(opts.theme);
  const cast = parseCast(castText);
  const cols = opts.cols ?? cast.header.width;
  const rows = opts.rows ?? cast.header.height;
  log(`term: ${cols}×${rows} cells, ${cast.events.length} output events, ${cast.duration.toFixed(1)}s recorded`);

  const emu = new TerminalEmulator(cols, rows, theme);
  let frames;
  try {
    frames = await buildFrames(emu, cast.events, opts);
  } finally {
    emu.dispose();
  }
  if (frames.length === 0) throw new Error("term: the cast produced no frames (no terminal output?)");
  log(`term: selected ${frames.length} settle-point frame(s)`);

  const htmlOpts: HtmlRenderOptions = {
    theme,
    fontSize: opts.fontSize,
    padding: opts.padding,
    fontFamily: opts.fontFamily,
  };

  // Measure the rendered terminal once (first frame) to size the SVG canvas.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let width = 0;
  let height = 0;
  const animFrames: AnimationFrame[] = [];
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    // A terminal is a fixed cols×rows monospace grid, so size the canvas from a
    // full-width/full-height reference block (every frame fits inside it) rather
    // than from one frame whose lines may be short.
    const refGrid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: "M", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false })),
    );
    const measureHtml = gridToHtml(refGrid, htmlOpts);
    await page.setContent(measureHtml, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    const box = await page.evaluate(() => {
      const el = document.querySelector(".term") as HTMLElement;
      const r = el.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    });
    width = box.w;
    height = box.h;
    log(`term: canvas ${width}×${height}px`);

    for (let i = 0; i < frames.length; i++) {
      const html = gridToHtml(frames[i].grid, htmlOpts);
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      await embedRemoteImages(tree);
      const svgContent = elementTreeToSvgInner(tree, width, height, `t${i}-`);
      animFrames.push({
        svgContent,
        duration: frames[i].durationMs,
        transition: { type: "cut", duration: 0 },
      });
      log(`term: frame ${i + 1}/${frames.length} rendered (${frames[i].durationMs}ms hold)`);
    }
  } finally {
    await ctx.close();
  }

  const svg = generateAnimatedSvg({ width, height, frames: animFrames });
  return { svg, width, height, frameCount: animFrames.length };
}
