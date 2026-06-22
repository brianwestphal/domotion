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
import { resolveThemeSpec, type TerminalThemeSpec } from "./theme.js";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../render/element-tree-to-svg.js";
import { clearEmbeddedFonts, getEmbeddedFontFaceCss } from "../render/index.js";
import { generateAnimatedSvg, type AnimationFrame } from "../animation/animator.js";
import { composeIncrementalTermSvg } from "./incremental.js";

export interface TermToSvgOptions extends FrameBuildOptions {
  /** A built-in theme name (`catppuccin` | `dark` | `github-light`), or a custom
   *  theme spec overriding `bg` / `fg` / `ansi` on top of an `extends` base. */
  theme?: string | TerminalThemeSpec;
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
  /** Cursor caret shape, or `none` to omit it. Default `block` (incremental
   *  mode only). A blinking caret follows the recorded cursor — it slides along
   *  the input as the line grows, so typed commands read as typed. */
  cursor?: "block" | "bar" | "underline" | "none";
  /** Caret color. Default: the theme's foreground. */
  cursorColor?: string;
  /**
   * Composition mode (default `incremental`): `incremental` renders each
   * distinct LINE-STATE once and reveals it during its visible window (small,
   * true incremental animation — best for append/overwrite output like build &
   * test logs); `full` renders every settle-point as a complete screen frame
   * (handles full-screen scrolling, but re-emits unchanged lines per frame). See
   * doc 67.
   */
  mode?: "incremental" | "full";
  /**
   * Manage the embedded-font lifecycle for this call (default `true`): clear the
   * shared builder, render frames WITHOUT per-frame `@font-face` blocks, and
   * return the single deduped `fontFaceCss` so the font is embedded once instead
   * of re-emitted per frame. Set `false` when running inside a larger pipeline
   * (e.g. an `animate` config's `cast` frame) that owns the font lifecycle and
   * collects fonts itself — then this shares the builder and returns no
   * `fontFaceCss` (the frames defer to the caller's collection).
   */
  manageFonts?: boolean;
  /** Optional progress log. */
  log?: (msg: string) => void;
}

export interface TermToSvgResult {
  svg: string;
  width: number;
  height: number;
  frameCount: number;
  /** Sum of frame hold durations (ms) — the cast's effective play time. */
  totalDurationMs: number;
}

function resolveTheme(theme: string | TerminalThemeSpec | undefined): ReturnType<typeof resolveThemeSpec> {
  return resolveThemeSpec(theme ?? "catppuccin");
}

export interface TermFramesResult {
  /** One `AnimationFrame` per settle-point, with derived hold durations and
   *  `cut` transitions between them. Ready for `generateAnimatedSvg`, or for the
   *  caller to retime / wrap / re-transition before composing. */
  frames: AnimationFrame[];
  /** Canvas width/height in px (sized to the terminal grid). */
  width: number;
  height: number;
  /** Sum of the frame hold durations (ms) — the cast's effective play time. */
  totalDurationMs: number;
  /**
   * The deduped `@font-face` CSS for the embedded monospace font, collected once
   * (empty when `manageFonts: false` — the frames then defer to the caller's
   * font collection). Pass it as `generateAnimatedSvg({ …, fontFaceCss })` so
   * the base64 font appears once in the document rather than per frame.
   */
  fontFaceCss: string;
}

/**
 * The "frames-out" half of the pipeline (mirrors `composeAnimateFrames`): parse
 * → emulate → select settle-point frames → render each to an `AnimationFrame`,
 * WITHOUT the final `generateAnimatedSvg`. Reach for this when you want the
 * individual terminal frames to retime, wrap in window chrome, re-transition,
 * or interleave with other frames before composing.
 */
export async function castToTermFrames(
  castText: string,
  browser: Browser,
  opts: TermToSvgOptions = {},
): Promise<TermFramesResult> {
  const log = opts.log ?? (() => {});
  const theme = resolveTheme(opts.theme);
  const cast = parseCast(castText);
  const cols = opts.cols ?? cast.header.width;
  const rows = opts.rows ?? cast.header.height;
  // DM-1246: honor mid-session resize events — unless the caller forced a fixed
  // grid via opts.cols/rows, in which case the recording is pinned to that size
  // and resizes are ignored. The canvas is sized to the LARGEST grid across the
  // initial size + every resize, so frames at any size fit (a smaller post-resize
  // grid renders top-left, the theme bg fills the rest, matching terminal anchoring).
  const honorResizes = opts.cols == null && opts.rows == null;
  const resizes = honorResizes ? cast.resizes : [];
  let maxCols = cols;
  let maxRows = rows;
  for (const rz of resizes) { if (rz.cols > maxCols) maxCols = rz.cols; if (rz.rows > maxRows) maxRows = rz.rows; }
  log(`term: ${cols}×${rows} cells${resizes.length > 0 ? ` (${resizes.length} resize(s) → max ${maxCols}×${maxRows})` : ""}, ${cast.events.length} output events, ${cast.duration.toFixed(1)}s recorded`);

  const manageFonts = opts.manageFonts !== false;
  // Embedded-font mode accumulates glyphs into one growing custom TTF across
  // frames; rendering each frame WITH its own `@font-face` would re-emit a
  // (different, partial) base64 copy per frame. Instead render every frame
  // WITHOUT the font CSS and collect the finished font ONCE at the end (the
  // same trick `composeAnimateFrames` uses). When we own the lifecycle, clear
  // the shared builder first so this cast's font is self-contained.
  if (manageFonts) clearEmbeddedFonts();

  const emu = new TerminalEmulator(cols, rows, theme);
  let frames;
  try {
    frames = await buildFrames(emu, cast.events, opts, resizes);
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

  // Measure the rendered terminal once to size the SVG canvas.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let width = 0;
  let height = 0;
  let totalDurationMs = 0;
  const animFrames: AnimationFrame[] = [];
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    // A terminal is a monospace grid, so size the canvas from a full-width/
    // full-height reference block (every frame fits inside it) rather than from
    // one frame whose lines may be short. Use the LARGEST grid across all resizes
    // (DM-1246) so post-resize frames (which may be bigger than the initial size)
    // still fit; smaller frames render top-left within it.
    const refGrid = Array.from({ length: maxRows }, () =>
      Array.from({ length: maxCols }, () => ({ char: "M", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false })),
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
      // includeGlyphDefs=true, includeEmbeddedFontCss=false (DM-1225): defer the
      // font to the single deduped block collected below, not per frame.
      const svgContent = elementTreeToSvgInner(tree, width, height, `t${i}-`, true, 2, false);
      animFrames.push({
        svgContent,
        duration: frames[i].durationMs,
        transition: { type: "cut", duration: 0 },
      });
      totalDurationMs += frames[i].durationMs;
      log(`term: frame ${i + 1}/${frames.length} rendered (${frames[i].durationMs}ms hold)`);
    }
  } finally {
    await ctx.close();
  }

  // Collect the finished font once. When `manageFonts` is false we're nested in
  // a pipeline that collects fonts itself, so leave the builder accumulated and
  // return no CSS (the frames defer to the caller's top-level collection).
  const fontFaceCss = manageFonts ? getEmbeddedFontFaceCss() : "";
  return { frames: animFrames, width, height, totalDurationMs, fontFaceCss };
}

export async function castToAnimatedSvg(
  castText: string,
  browser: Browser,
  opts: TermToSvgOptions = {},
): Promise<TermToSvgResult> {
  // Default to the incremental line-diff composer (small, true incremental
  // animation); `mode: "full"` keeps the per-settle-point full-frame path.
  if (opts.mode !== "full") {
    const r = await composeIncrementalTermSvg(castText, browser, opts);
    return { svg: r.svg, width: r.width, height: r.height, frameCount: r.lineCount, totalDurationMs: r.totalDurationMs };
  }
  const { frames, width, height, totalDurationMs, fontFaceCss } = await castToTermFrames(castText, browser, opts);
  const svg = generateAnimatedSvg({ width, height, frames, fontFaceCss });
  return { svg, width, height, frameCount: frames.length, totalDurationMs };
}
