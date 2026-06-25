/**
 * Incremental (line-pool) terminal composer (DM-1225 follow-up).
 *
 * The full-frame composer (`castToTermFrames`) renders the ENTIRE screen per
 * settle-point and the animator replaces full frames, so a line on screen for N
 * frames is re-emitted N times (a 16-frame cast put "Cloning into" in the SVG 22
 * times). A terminal is really a POOL of lines that scroll: each logical line is
 * created once, may slide up/down as the buffer scrolls, and eventually leaves.
 *
 * So this composer tracks lines by identity. It diffs consecutive grids,
 * detecting the scroll shift between them, and threads each logical line through
 * frames as a single tracked entity with a list of (time, row) waypoints. Each
 * line is rendered ONCE (an absolutely-positioned element tagged
 * `data-domotion-anim` → `class="anim-<id>"`) and driven by ONE keyframe set
 * that animates `transform: translateY(...)` SMOOTHLY between waypoints (so a
 * scroll slides every line up together) and `opacity` with hard cuts for the
 * line's appear / leave. The result is one captured tree (not N frames), far
 * smaller, and a true line-level animation.
 *
 * Overwrite (a line's content changes in place — a spinner, a progress bar) ends
 * the old line and starts a new one at that position. A cleared / scrolled-off
 * line ends when it leaves the tracked set.
 */

import type { Browser } from "@playwright/test";
import { parseCast } from "./cast.js";
import { TerminalEmulator, type TermCell } from "./emulator.js";
import { buildFrames, rowInnerHtml, gridToHtml, TERM_TYPE_DEFAULTS, type TermFrame, type HtmlRenderOptions } from "./render.js";
import { resolveThemeSpec, type TerminalTheme } from "./theme.js";
import { captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs, getEmbeddedFontFaceCss } from "../render/index.js";
import type { TermToSvgOptions } from "./index.js";

/** Max rows to search when detecting an inter-frame scroll shift (scroll is normally small). */
const MAX_SCROLL_SEARCH_ROWS = 12;
/** Monospace cell advance as a fraction of font size, used only as a fallback when the measured width is unavailable. */
const MONO_ADVANCE_RATIO = 0.6;

/** A logical terminal line threaded through frames by identity. */
export interface TrackedLine {
  id: number;
  /** Coalesced `<span>` markup (from `rowInnerHtml`) — fixed for the line's life. */
  html: string;
  /** (time, row) at each point the line's row changed; first entry is its birth. */
  waypoints: { ms: number; row: number }[];
  /** When the line leaves the screen (scrolled off / cleared / overwritten), or totalMs. */
  endMs: number;
}

/**
 * How many rows the screen scrolled UP between `prev` and `cur` (0 = no scroll,
 * new content appended at the bottom). Scored by how many non-blank rows of
 * `cur[r]` equal `prev[r + S]`; ties prefer the smaller shift (no-scroll). Scroll
 * is normally small, so the search is capped.
 */
export function detectScroll(prev: string[], cur: string[], rows: number): number {
  let bestS = 0;
  let bestScore = 0;
  const maxS = Math.min(rows - 1, MAX_SCROLL_SEARCH_ROWS);
  for (let S = 0; S <= maxS; S++) {
    let score = 0;
    for (let r = 0; r + S < rows; r++) {
      if (cur[r] !== "" && cur[r] === prev[r + S]) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestS = S;
    }
  }
  return bestS;
}

/** Thread the frame grids into tracked lines (the line pool). */
export function trackLines(frames: TermFrame[], rows: number, theme: TerminalTheme): { lines: TrackedLine[]; totalMs: number } {
  const starts: number[] = [];
  let acc = 0;
  for (const f of frames) {
    starts.push(acc);
    acc += f.durationMs;
  }
  const totalMs = acc;
  const lineRows = frames.map((f) => Array.from({ length: rows }, (_, r) => rowInnerHtml(f.grid[r] ?? [], theme)));

  const allLines: TrackedLine[] = [];
  let active = new Map<number, TrackedLine>(); // row → line currently there
  let nextId = 0;

  for (let i = 0; i < frames.length; i++) {
    const t = starts[i];
    const cur = lineRows[i];
    // DM-1249: a mid-session resize changes the grid height; the content
    // reflows, so there's no meaningful line continuity across it. Treat a
    // grid-height change as a HARD boundary — end every active line and start a
    // fresh pool. (No resize ⇒ all frames are the same height ⇒ never triggers,
    // so non-resizing recordings are unaffected.)
    const resized = i > 0 && frames[i].grid.length !== frames[i - 1].grid.length;
    if (resized) {
      for (const line of active.values()) line.endMs = t;
      active = new Map<number, TrackedLine>();
    }
    const shift = (i === 0 || resized) ? 0 : detectScroll(lineRows[i - 1], cur, rows);
    const newActive = new Map<number, TrackedLine>();
    const claimed = new Set<TrackedLine>();
    for (let r = 0; r < rows; r++) {
      const content = cur[r];
      if (content === "") continue;
      // The line now at row r sat at row r+shift before the scroll.
      const prev = i === 0 ? undefined : active.get(r + shift);
      if (prev != null && prev.html === content && !claimed.has(prev)) {
        const last = prev.waypoints[prev.waypoints.length - 1];
        if (last.row !== r) prev.waypoints.push({ ms: t, row: r }); // only record actual moves
        claimed.add(prev);
        newActive.set(r, prev);
      } else {
        const line: TrackedLine = { id: nextId++, html: content, waypoints: [{ ms: t, row: r }], endMs: totalMs };
        allLines.push(line);
        newActive.set(r, line);
      }
    }
    // Any previously-active line not carried over has left the screen.
    for (const line of active.values()) {
      if (!claimed.has(line)) line.endMs = t;
    }
    active = newActive;
  }
  return { lines: allLines, totalMs };
}

/** A scroll slide lasts at most this long (ms) — a quick glide at the scroll
 *  moment rather than a slow drift across the whole interval. */
const SLIDE_MS = 130;

/**
 * Per line, up to TWO animations on one element (a single timing-function can't
 * step opacity AND interpolate transform): an OPACITY track with `step-end`
 * timing (hard cut on at birth, off when the line leaves) and a TRANSFORM track
 * with `linear` timing that GLIDES `translateY` between waypoint rows over a
 * short window at each scroll (so lines slide up/down together). The element is
 * positioned in HTML at its birth row, so translateY is a delta (0 at birth); a
 * line that's visible the whole time AND never moves needs no rule.
 */
function lineKeyframes(lines: TrackedLine[], totalMs: number, yOf: (row: number) => number): string {
  const out: string[] = [];
  const durSec = (totalMs / 1000).toFixed(3);
  const pct = (ms: number): string => Math.max(0, Math.min(100, (ms / totalMs) * 100)).toFixed(4);
  for (const line of lines) {
    const wps = line.waypoints;
    const baseY = yOf(wps[0].row);
    const dy = (row: number): string => `translateY(${(yOf(row) - baseY).toFixed(2)}px)`;
    const moves = wps.length > 1;
    const visFromStart = wps[0].ms <= 0;
    const visToEnd = line.endMs >= totalMs;
    const animsFor: string[] = [];

    // Opacity track (step-end → hard cuts). Skipped when the line is visible the
    // whole time (opacity stays 1, positioned in HTML).
    if (!(visFromStart && visToEnd)) {
      const op: string[] = [`0%{opacity:${visFromStart ? 1 : 0}}`];
      if (!visFromStart) op.push(`${pct(wps[0].ms)}%{opacity:1}`);
      if (!visToEnd) op.push(`${pct(line.endMs)}%{opacity:0}`);
      op.push(`100%{opacity:${visToEnd ? 1 : 0}}`);
      out.push(`@keyframes ln${line.id}o{${op.join("")}}`);
      animsFor.push(`ln${line.id}o ${durSec}s step-end infinite`);
    }

    // Transform track (linear → smooth glide). Skipped when the line never moves.
    if (moves) {
      const tf: string[] = [`0%{transform:${dy(wps[0].row)}}`];
      for (let k = 1; k < wps.length; k++) {
        const slideStart = Math.max(wps[k - 1].ms, wps[k].ms - SLIDE_MS);
        tf.push(`${pct(slideStart)}%{transform:${dy(wps[k - 1].row)}}`); // hold prev row until the slide
        tf.push(`${pct(wps[k].ms)}%{transform:${dy(wps[k].row)}}`); // glide to the new row by the scroll time
      }
      tf.push(`100%{transform:${dy(wps[wps.length - 1].row)}}`);
      out.push(`@keyframes ln${line.id}t{${tf.join("")}}`);
      animsFor.push(`ln${line.id}t ${durSec}s linear infinite`);
    }

    if (animsFor.length > 0) out.push(`.anim-ln${line.id}{animation:${animsFor.join(",")}}`);
  }
  return out.join("\n");
}

/** Plain text of a grid row with trailing default-blank cells trimmed. */
function rowPlain(cells: TermCell[]): string {
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1];
    if (c.char !== " " || c.fg != null || c.bg != null) break;
    end--;
  }
  return cells.slice(0, end).map((c) => c.char).join("");
}

/**
 * Which frames have the cursor on an INPUT line (a prompt the user types at),
 * so the caret is shown there and hidden on program output. The shell prompt is
 * inferred as the common prefix of every cursor-row line that gets typed onto
 * (extended at the next settle-point); a frame is then "input" when the cursor's
 * current line starts with that prompt, or is itself actively growing from the
 * prior frame (mid-type). With no detectable typing the prompt is empty and only
 * actively-growing frames count (a pure-output cast shows no caret).
 */
export function detectInputFrames(frames: TermFrame[]): boolean[] {
  const cursorRow = (i: number): string => rowPlain(frames[i].grid[frames[i].cursor.y] ?? []);
  const prompts: string[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const cur = cursorRow(i);
    const next = rowPlain(frames[i + 1].grid[frames[i].cursor.y] ?? []);
    if (cur !== "" && next.length > cur.length && next.startsWith(cur)) prompts.push(cur);
  }
  const promptSig = longestCommonPrefix(prompts);
  return frames.map((_, i) => {
    const cur = cursorRow(i);
    if (cur === "") return false;
    if (promptSig !== "" && cur.startsWith(promptSig)) return true;
    if (i > 0) {
      const prev = rowPlain(frames[i - 1].grid[frames[i].cursor.y] ?? []);
      if (prev !== "" && cur.length > prev.length && cur.startsWith(prev)) return true; // mid-type
    }
    return false;
  });
}

/** Longest common leading substring of the given strings ("" if none/empty). */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (let i = 1; i < strs.length && prefix !== ""; i++) {
    const s = strs[i];
    let k = 0;
    while (k < prefix.length && k < s.length && prefix[k] === s[k]) k++;
    prefix = prefix.slice(0, k);
  }
  return prefix;
}

/**
 * A blinking caret that follows the recorded cursor. Position GLIDES (linear)
 * between each frame's cursor cell — so as a typed line grows the caret slides
 * along it (reading as typed) — visibility steps with the program's DECTCEM
 * show/hide AND is gated to INPUT lines (a prompt the user types at; never
 * trailing output), and the caret blinks on a standard ~1.06 s cycle. Opacities
 * compose through nesting: vis (step) × blink (step) on a transform-positioned
 * group. Returns `null` when `shape === "none"`.
 */
function buildCursor(
  frames: TermFrame[],
  totalMs: number,
  charW: number,
  linePx: number,
  padding: number,
  shape: "block" | "bar" | "underline",
  color: string,
): { markup: string; css: string } | null {
  if (frames.length === 0) return null;
  const starts: number[] = [];
  let acc = 0;
  for (const f of frames) {
    starts.push(acc);
    acc += f.durationMs;
  }
  const pct = (ms: number): string => Math.max(0, Math.min(100, (ms / totalMs) * 100)).toFixed(4);
  const at = (c: TermFrame["cursor"]): string => `translate(${(padding + c.x * charW).toFixed(2)}px,${(padding + c.y * linePx).toFixed(2)}px)`;

  const pos: string[] = [`0%{transform:${at(frames[0].cursor)}}`];
  for (let i = 1; i < frames.length; i++) {
    const slideStart = Math.max(starts[i - 1], starts[i] - SLIDE_MS);
    pos.push(`${pct(slideStart)}%{transform:${at(frames[i - 1].cursor)}}`, `${pct(starts[i])}%{transform:${at(frames[i].cursor)}}`);
  }
  pos.push(`100%{transform:${at(frames[frames.length - 1].cursor)}}`);

  // The caret is only meaningful on INPUT lines (a prompt the user types at) —
  // trailing it through program output is noise. Gate visibility to input frames.
  const inputFrame = detectInputFrames(frames);
  const shown = (i: number): 0 | 1 => (frames[i].cursor.visible && inputFrame[i] ? 1 : 0);

  const vis: string[] = [`0%{opacity:${shown(0)}}`];
  for (let i = 1; i < frames.length; i++) vis.push(`${pct(starts[i])}%{opacity:${shown(i)}}`);
  vis.push(`100%{opacity:${shown(frames.length - 1)}}`);

  // Caret rect within the cell.
  let rx = 0;
  let ry = 0;
  let rw = charW;
  let rh = linePx;
  if (shape === "bar") rw = Math.max(1.5, charW * 0.16);
  else if (shape === "underline") {
    rh = Math.max(1.5, linePx * 0.12);
    ry = linePx - rh;
  }
  const durSec = (totalMs / 1000).toFixed(3);
  const css = [
    `@keyframes tcurp{${pos.join("")}}`,
    `@keyframes tcurv{${vis.join("")}}`,
    `@keyframes tcurb{0%{opacity:1}50%{opacity:0}100%{opacity:1}}`,
    `.tcur-v{animation:tcurv ${durSec}s step-end infinite}`,
    `.tcur-p{animation:tcurp ${durSec}s linear infinite}`,
    `.tcur-b{animation:tcurb 1.06s step-end infinite}`,
  ].join("\n");
  const markup = `<g class="tcur-v"><g class="tcur-p"><rect class="tcur-b" x="${rx.toFixed(2)}" y="${ry.toFixed(2)}" width="${rw.toFixed(2)}" height="${rh.toFixed(2)}" fill="${color}" fill-opacity="${shape === "block" ? 0.7 : 1}"/></g></g>`;
  return { markup, css };
}

export interface IncrementalResult {
  svg: string;
  width: number;
  height: number;
  fontFaceCss: string;
  totalDurationMs: number;
  /** Number of distinct tracked lines emitted (vs. rows × frames for full mode). */
  lineCount: number;
}

function resolveTheme(theme: TermToSvgOptions["theme"]): TerminalTheme {
  return resolveThemeSpec(theme ?? "catppuccin");
}

/**
 * Compose a cast into an animated SVG via the incremental line-pool model.
 * `manageFonts: false` defers the font to a host pipeline (an `animate` `cast`
 * frame), exactly like `castToTermFrames`.
 */
export async function composeIncrementalTermSvg(
  castText: string,
  browser: Browser,
  opts: TermToSvgOptions = {},
): Promise<IncrementalResult> {
  const log = opts.log ?? (() => {});
  const theme = resolveTheme(opts.theme);
  const manageFonts = opts.manageFonts !== false;
  const cast = parseCast(castText);
  const cols = opts.cols ?? cast.header.width;
  const rows = opts.rows ?? cast.header.height;
  // DM-1249: honor mid-session resize (like the full-frame path) unless the
  // caller pinned the grid via opts.cols/rows. The canvas is sized to the
  // largest grid across the initial size + all resizes; `trackLines` resets the
  // line pool at each resize boundary.
  const honorResizes = opts.cols == null && opts.rows == null;
  const resizes = honorResizes ? cast.resizes : [];
  let maxCols = cols;
  let maxRows = rows;
  for (const rz of resizes) { if (rz.cols > maxCols) maxCols = rz.cols; if (rz.rows > maxRows) maxRows = rz.rows; }
  const fontSize = opts.fontSize ?? TERM_TYPE_DEFAULTS.fontSize;
  const padding = opts.padding ?? TERM_TYPE_DEFAULTS.padding;
  const lineHeight = TERM_TYPE_DEFAULTS.lineHeight;
  const fontFamily = opts.fontFamily ?? TERM_TYPE_DEFAULTS.fontFamily;
  log(`term: ${cols}×${rows} cells${resizes.length > 0 ? ` (${resizes.length} resize(s) → max ${maxCols}×${maxRows})` : ""}, ${cast.events.length} output events, ${cast.duration.toFixed(1)}s recorded`);

  const emu = new TerminalEmulator(cols, rows, theme);
  let frames;
  try {
    frames = await buildFrames(emu, cast.events, opts, resizes);
  } finally {
    emu.dispose();
  }
  if (frames.length === 0) throw new Error("term: the cast produced no frames (no terminal output?)");

  const { lines, totalMs } = trackLines(frames, maxRows, theme);
  log(`term: ${lines.length} tracked lines across ${frames.length} settle point(s) (incremental)`);

  if (manageFonts) { clearEmbeddedFonts(); clearGlyphDefs(); } // DM-1338: glyph registry shares the lifecycle

  const htmlOpts: HtmlRenderOptions = { theme, fontSize, padding, fontFamily, lineHeight };
  const linePx = fontSize * lineHeight;
  const yOf = (row: number): number => padding + row * linePx;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let width = 0;
  let height = 0;
  let inner = "";
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    // Measure the canvas from a full max-cols×max-rows reference block (same as
    // the full-frame path) so the two modes lay out identically and a post-resize
    // grid still fits (DM-1249).
    const refGrid = Array.from({ length: maxRows }, () =>
      Array.from({ length: maxCols }, () => ({ char: "M", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false })),
    );
    await page.setContent(gridToHtml(refGrid, htmlOpts), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    const box = await page.evaluate(() => {
      const el = document.querySelector(".term") as HTMLElement;
      const r = el.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    });
    width = box.w;
    height = box.h;
    log(`term: canvas ${width}×${height}px`);

    // Each line is positioned at its BIRTH row; translateY animates the delta.
    const divs = lines
      .map((line) =>
        `<div class="r" data-domotion-anim="ln${line.id}" style="top:${yOf(line.waypoints[0].row).toFixed(3)}px">${line.html === "" ? "&nbsp;" : line.html}</div>`,
      )
      .join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:${theme.bg}}
  .term{position:relative;overflow:hidden;width:${width}px;height:${height}px;background:${theme.bg};color:${theme.fg};
    font-family:${fontFamily};font-size:${fontSize}px;line-height:${lineHeight};
    font-variant-ligatures:none;-webkit-font-smoothing:antialiased}
  .r{position:absolute;left:${padding}px;white-space:pre}
</style></head><body><div class="term">${divs}</div></body></html>`;
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
    await embedRemoteImages(tree);
    inner = elementTreeToSvgInner(tree, width, height, "ti-", true, 2, false);
  } finally {
    await ctx.close();
  }

  // Blinking caret that follows the recorded cursor (incremental mode). charW is
  // the monospace cell advance, recovered from the measured content width.
  const shape = opts.cursor ?? "block";
  const charW = cols > 0 ? (width - 2 * padding) / cols : fontSize * MONO_ADVANCE_RATIO;
  const cursor = shape === "none" ? null : buildCursor(frames, totalMs, charW, linePx, padding, shape, opts.cursorColor ?? theme.fg);

  const fontFaceCss = manageFonts ? getEmbeddedFontFaceCss() : "";
  const styleCss = `${fontFaceCss !== "" ? fontFaceCss + "\n" : ""}${lineKeyframes(lines, totalMs, yOf)}${cursor != null ? "\n" + cursor.css : ""}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<style>${styleCss}</style>${inner}${cursor != null ? cursor.markup : ""}</svg>`;
  return { svg, width, height, fontFaceCss, totalDurationMs: totalMs, lineCount: lines.length };
}
