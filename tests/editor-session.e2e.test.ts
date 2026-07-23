import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * Rasterized verification of the flagship `editor-session` example (docs/100
 * stage 5) — the kerf getting-started editor phases rebuilt on the new
 * primitives. Composes the COMMITTED example config through the real pipeline,
 * rasterizes the composed SVG at chosen times (the verify-the-rendered-SVG
 * rule), and asserts the painted ink:
 *
 *   - the typed-line handoff at a `holdToFrameEnd` cut is seamless (ink bbox
 *     continuity across the frame boundary);
 *   - trailing text genuinely shifts by one advance per keystroke inside the
 *     insert run, while the prefix pixels stay byte-stable across states;
 *   - the colorize / recolor states land IN PLACE (amber ink appears, glyph
 *     bbox unchanged);
 *   - the run's exit cut is seamless against the following frame's page text
 *     (byte-equal strips across both run exits);
 *   - the declarative selection sweeps over "btn" and clears at the cut;
 *   - the caret (track caret + the runs' auto-caret) rides the captured glyph
 *     edges.
 *
 * Frame timeline (from editor-session.json durations):
 *   F0 0–1600 (type L1)      F1 1600–2850    F2 2850–4000   F3 4000–5950
 *   F4 5950–6700             F5 6700–7500    F6 7500–9800 (insert run:
 *   s0 300ms, s1..s10 ×120ms from 7800, colorize 9000–9800)
 *   F7 9800–12050 (type cls) F8 12050–14450 (selection track)
 *   F9 14450–16040 (replace run: s0 140ms, s1..s5 ×130ms from 14590,
 *   recolor 15250–16040)     F10 16040–17240 (settle)
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EX_DIR = resolve(HERE, "../examples/animate/editor-session");
const W = 640;
const H = 360;

// Code rows paint at y = 80 + 19·(row−1) (window 16 + titlebar 28 + tabbar 26
// + codearea padding 10); text starts at x = 52 (36px number + 12px padding +
// 4px window inset... measured from the captured tree).
const rowStrip = (row: number, x = 40, w = 580) => ({ x, y: 80 + 19 * (row - 1), w, h: 19 });

async function setup() {
  try {
    const browser = await launchChromium();
    const cfg = validateAnimateConfig(JSON.parse(readFileSync(resolve(EX_DIR, "editor-session.json"), "utf8")));
    const config = await composeAnimateFrames(browser, cfg, { configDir: EX_DIR });
    const svg = generateAnimatedSvg(config);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const viewer = await ctx.newPage();
    await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
    await viewer.evaluate(() => document.fonts.ready);
    return { browser, viewer };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

async function shot(tMs: number): Promise<Buffer> {
  const { viewer } = env!;
  await seekTo(viewer, tMs);
  return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
}

/** Decode a full-viewport PNG and scan a rect for pixels in a color family. */
async function scan(
  png: Buffer,
  mode: "ink" | "light" | "amber" | "selection",
  rect: { x: number; y: number; w: number; h: number },
): Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number }> {
  const { viewer } = env!;
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return viewer.evaluate(async (args: { dataUri: string; mode: string; rect: { x: number; y: number; w: number; h: number } }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = args.dataUri;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const r0 = args.rect;
    const d = ctx.getImageData(r0.x, r0.y, r0.w, r0.h).data;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
    for (let y = 0; y < r0.h; y++) {
      for (let x = 0; x < r0.w; x++) {
        const i = (y * r0.w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let hit = false;
        // The editor background is #1e293b (30,41,59); any pixel meaningfully
        // brighter than it is glyph ink of SOME token color.
        if (args.mode === "ink") hit = r + g + b > 200;
        else if (args.mode === "light") hit = r > 170 && g > 170 && b > 170;
        // amber #fbbf24 — red+green high, blue low.
        else if (args.mode === "amber") hit = r > 200 && g > 150 && g < 220 && b < 100;
        // #3b82f6 at ~2/3 alpha over the dark editor — strongly blue-dominant,
        // and tighter than the page's cyan `.attr` (125,211,252) / blue `.kw`
        // (147,197,253) token colors, which must NOT count as selection.
        else hit = b > 150 && b - g > 70 && b - r > 100;
        if (hit) {
          const ax = r0.x + x, ay = r0.y + y;
          if (ax < minX) minX = ax;
          if (ax > maxX) maxX = ax;
          if (ay < minY) minY = ay;
          if (ay > maxY) maxY = ay;
          count++;
        }
      }
    }
    return { minX, maxX, minY, maxY, count };
  }, { dataUri, mode, rect });
}

/** Extract a rect's raw RGBA bytes (for byte-stability comparisons). */
async function rectBytes(png: Buffer, rect: { x: number; y: number; w: number; h: number }): Promise<string> {
  const { viewer } = env!;
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return viewer.evaluate(async (args: { dataUri: string; rect: { x: number; y: number; w: number; h: number } }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = args.dataUri;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(args.rect.x, args.rect.y, args.rect.w, args.rect.h).data;
    let out = "";
    for (let i = 0; i < d.length; i += 4) out += String.fromCharCode(d[i] >> 3, d[i + 1] >> 3, d[i + 2] >> 3);
    return out;
  }, { dataUri, rect });
}

/** Count pixels in a rect whose max channel delta between two shots exceeds `threshold`. */
async function diffCount(pngA: Buffer, pngB: Buffer, rect: { x: number; y: number; w: number; h: number }, threshold: number): Promise<number> {
  const { viewer } = env!;
  const uris = [pngA, pngB].map((p) => `data:image/png;base64,${p.toString("base64")}`);
  return viewer.evaluate(async (args: { uris: string[]; rect: { x: number; y: number; w: number; h: number }; threshold: number }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = src;
    });
    const [a, b] = await Promise.all(args.uris.map(load));
    const canvas = document.createElement("canvas");
    canvas.width = a.width;
    canvas.height = a.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(a, 0, 0);
    const da = ctx.getImageData(args.rect.x, args.rect.y, args.rect.w, args.rect.h).data;
    ctx.drawImage(b, 0, 0);
    const db = ctx.getImageData(args.rect.x, args.rect.y, args.rect.w, args.rect.h).data;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > args.threshold) n++;
    }
    return n;
  }, { uris, rect, threshold });
}

/** Columns (absolute x) in a rect holding >= minRun light-caret pixels. */
async function caretColumns(png: Buffer, rect: { x: number; y: number; w: number; h: number }, minRun = 12): Promise<number[]> {
  const { viewer } = env!;
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return viewer.evaluate(async (args: { dataUri: string; rect: { x: number; y: number; w: number; h: number }; minRun: number }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = args.dataUri;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const r0 = args.rect;
    const d = ctx.getImageData(r0.x, r0.y, r0.w, r0.h).data;
    const cols: number[] = [];
    for (let x = 0; x < r0.w; x++) {
      let n = 0;
      for (let y = 0; y < r0.h; y++) {
        const i = (y * r0.w + x) * 4;
        if (d[i] > 170 && d[i + 1] > 170 && d[i + 2] > 170) n++;
      }
      if (n >= args.minRun) cols.push(r0.x + x);
    }
    return cols;
  }, { dataUri, rect, minRun });
}

describeBrowser("editor-session flagship rasterized verification (docs/100 stage 5)", () => {
  it("hands a holdToFrameEnd typed line off to real page text with ink-bbox continuity", async () => {
    // t=1595: F0's overlay fully typed and HELD (blink phase hides the caret,
    // so the strip is text-only). t=1650: F1's page text (the colored form).
    const held = await scan(await shot(1595), "ink", rowStrip(1));
    const page = await scan(await shot(1650), "ink", rowStrip(1));
    expect(held.count).toBeGreaterThan(200);
    expect(page.count).toBeGreaterThan(200);
    // Same glyph geometry across the cut: the ink bounding box is continuous.
    expect(Math.abs(page.minX - held.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(page.maxX - held.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(page.minY - held.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(page.maxY - held.maxY)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("shifts the trailing text right by ~one advance per keystroke inside the insert run", async () => {
    // Insert-run states: s0 holds 7500–7800, then one keystroke per 120 ms.
    const edges: number[] = [];
    for (const t of [7650, 7860, 7980, 8100]) {
      const ink = await scan(await shot(t), "ink", rowStrip(1));
      expect(ink.count, `t=${t}: no row-1 ink`).toBeGreaterThan(200);
      edges.push(ink.maxX);
    }
    for (let i = 1; i < edges.length; i++) {
      const delta = edges[i] - edges[i - 1];
      expect(delta, `keystroke ${i}: tail should shift right ~one Menlo advance`).toBeGreaterThanOrEqual(5);
      expect(delta, `keystroke ${i}: tail should shift by ONE advance, not more`).toBeLessThanOrEqual(11);
    }
  }, 120_000);

  it("keeps the prefix pixels byte-stable across the run's states", async () => {
    // `import { signal,` spans x≈52..172; the auto-caret and every typed glyph
    // land right of x=172, so this crop must not change by a single pixel
    // level across keystroke states (the compressor emits the prefix ONCE).
    const prefix = { x: 52, y: 80, w: 116, h: 19 };
    const s1 = await rectBytes(await shot(7860), prefix);
    for (const t of [7980, 8100, 8220, 8940]) {
      expect(await rectBytes(await shot(t), prefix), `t=${t}: prefix pixels drifted`).toBe(s1);
    }
  }, 120_000);

  it("lands the colorize recolor in place (amber appears, glyph bbox unchanged)", async () => {
    // s10 held at 8940 (all of ` computed,` typed, still plain); the colorize
    // state (9000–9800) recolors the braces amber at unchanged positions.
    const before = await shot(8940);
    const after = await shot(9400);
    const amberBefore = await scan(before, "amber", rowStrip(1));
    const amberAfter = await scan(after, "amber", rowStrip(1));
    expect(amberBefore.count).toBe(0);
    expect(amberAfter.count).toBeGreaterThan(5);
    const inkBefore = await scan(before, "ink", rowStrip(1));
    const inkAfter = await scan(after, "ink", rowStrip(1));
    expect(Math.abs(inkAfter.minX - inkBefore.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(inkAfter.maxX - inkBefore.maxX)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("exits the insert run seamlessly against the following frame's page text", async () => {
    // F6's colorize state at a blink-off moment (t=9500 hides the auto-caret)
    // vs F7's captured page before its overlay starts typing (t=9850) — the
    // same DOM through the same renderer. The tail glyphs ride the run's
    // composed translateX, so a handful of pixels carry subpixel-AA deltas vs
    // the direct paint; the strip must otherwise be pixel-identical (no
    // visible jump at the cut).
    const runSide = await shot(9500);
    const pageSide = await shot(9850);
    expect(await diffCount(runSide, pageSide, rowStrip(1), 32)).toBeLessThanOrEqual(60);
    // And the amber/green/blue token inks agree exactly in coverage.
    const a = await scan(runSide, "ink", rowStrip(1));
    const b = await scan(pageSide, "ink", rowStrip(1));
    expect(Math.abs(b.minX - a.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.maxX - a.maxX)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("sweeps the declarative selection over \"btn\" and clears it at the cut", async () => {
    // F8 12050: select at +950 sweeps 400 ms (13000–13400).
    const mid = await scan(await shot(13200), "selection", rowStrip(6));
    const full = await scan(await shot(13600), "selection", rowStrip(6));
    const afterCut = await scan(await shot(14500), "selection", rowStrip(6));
    expect(mid.count).toBeGreaterThan(20);
    expect(full.count).toBeGreaterThan(mid.count);
    // The full selection covers the five `"btn"` cells (~37.6 px).
    expect(full.maxX - full.minX).toBeGreaterThan(30);
    expect(afterCut.count).toBe(0);
  }, 60_000);

  it("parks the track caret on the captured glyph edge of the selection start", async () => {
    // After the move event the caret sits at charOffset 0 of the "btn" string
    // span — its captured left edge (x ≈ 172.4). t=12900 is inside the moved
    // window at a blink-on phase, before the sweep starts.
    const cols = await caretColumns(await shot(12900), rowStrip(6, 150, 200));
    expect(cols.length, "no caret bar found in row 6").toBeGreaterThan(0);
    for (const c of cols) {
      expect(c).toBeGreaterThanOrEqual(169);
      expect(c).toBeLessThanOrEqual(176);
    }
  }, 60_000);

  it("rides the insert run's auto-caret and HOLDS it through the recolor state", async () => {
    // s10 (all ten ` computed,` chars typed, 8880–9000): the derived edit
    // point sits after the tenth typed glyph, x ≈ 172.4 + 10·7.52 ≈ 247.7.
    const typing = await caretColumns(await shot(8940), rowStrip(1, 170, 120));
    expect(typing.length, "no auto-caret bar during s10").toBeGreaterThan(0);
    for (const c of typing) {
      expect(c).toBeGreaterThanOrEqual(243);
      expect(c).toBeLessThanOrEqual(252);
    }
    // The colorize state re-tokenizes the line (recolors + whitespace churn)
    // — a tokenizer catching up must NOT move the caret, so it holds at the
    // same edge (t=9700 is inside the colorize state at a blink-on phase).
    const colorize = await caretColumns(await shot(9700), rowStrip(1, 170, 120));
    expect(colorize.length, "auto-caret vanished during the colorize state").toBeGreaterThan(0);
    for (const c of colorize) {
      expect(c).toBeGreaterThanOrEqual(243);
      expect(c).toBeLessThanOrEqual(252);
    }
  }, 60_000);

  it("rides the replace run's auto-caret along the typed glyph edges", async () => {
    // Replace-run s3 (`{cl` typed, 14850–14980, blink-on window): the derived
    // edit point sits after the third typed glyph, x ≈ 172.4 + 3·7.52 ≈ 195.
    const cols = await caretColumns(await shot(14940), rowStrip(6, 150, 200));
    expect(cols.length, "no auto-caret bar found in row 6").toBeGreaterThan(0);
    for (const c of cols) {
      expect(c).toBeGreaterThanOrEqual(190);
      expect(c).toBeLessThanOrEqual(200);
    }
  }, 60_000);

  it("exits the replace run seamlessly against the settle frame's page text", async () => {
    // F9's recolor state at a blink-off moment (t=15400) vs F10's captured
    // page (t=16100). The "btn" → {cls} replacement nets a ZERO tail shift
    // (5 cells replace 5 cells), so this exit is pixel-identical — not merely
    // seamless-with-AA like the insert exit.
    expect(await diffCount(await shot(15400), await shot(16100), rowStrip(6), 8)).toBe(0);
  }, 60_000);

  it("recolors the landed {cls} hole in place inside the replace run", async () => {
    // s5 held (15150: `{cls}` fully typed, plain) → recolor state (15400):
    // amber appears in the class= area (x 165..215) at unchanged positions.
    const area = rowStrip(6, 165, 50);
    const before = await scan(await shot(15150), "amber", area);
    const after = await scan(await shot(15400), "amber", area);
    expect(before.count).toBe(0);
    expect(after.count).toBeGreaterThan(5);
    const inkBefore = await scan(await shot(15150), "ink", rowStrip(6));
    const inkAfter = await scan(await shot(15400), "ink", rowStrip(6));
    expect(Math.abs(inkAfter.minX - inkBefore.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(inkAfter.maxX - inkBefore.maxX)).toBeLessThanOrEqual(1);
  }, 60_000);
});
