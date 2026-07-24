import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { PARITY_LAUNCH_OPTS } from "./flipbook-parity.js";

// Declarative config surface for the frame-sequence compressor + the caret /
// selection track (docs/100 stage 4, docs/43 §11–12): drive a `states: [...]`
// frame and a `textTracks: [...]` frame end-to-end through the REAL
// `composeAnimateFrames` pipeline, then RASTERIZE the composed SVG (the
// verify-the-rendered-SVG rule) and assert the painted ink — the tail shift
// per typed state, the parked caret x, the selection sweep.

const W = 640;
const H = 240;

// A small editor-like page: one Menlo line whose `ins(k)` helper inserts a
// mid-line string one character at a time (reflowing the tail), plus a
// colorize() that re-tokenizes the line at unchanged glyph positions.
const EDITOR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#1e293b;overflow:hidden}
  #line{position:absolute;left:24px;top:40px;font:14px Menlo,monospace;color:#e2e8f0;white-space:pre}
  .kw{color:#93c5fd}.hole{color:#fbbf24}
</style></head><body>
  <div id="line"></div>
<script>
  const INS = " computed,";
  window.ins = (k) => {
    document.getElementById("line").innerHTML =
      '<span class="kw">import</span> { signal,' + INS.slice(0, k) + " mount } from 'kerfjs';";
  };
  window.colorize = () => {
    document.getElementById("line").innerHTML =
      '<span class="kw">import</span> <span class="hole">{</span> signal, computed, mount <span class="hole">}</span> from \\'kerfjs\\';';
  };
  window.ins(0);
</script></body></html>`;

// A plain text page for the textTracks e2e — NO data-domotion-anim attribute:
// the config's `selector` → capture-time stamping is exactly what's under test.
const TEXT_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#ffffff}
  #line{position:absolute;left:40px;top:60px;font:24px Helvetica,Arial,sans-serif;color:#111111}
</style></head><body>
  <div id="line">Hello world</div>
</body></html>`;

/** Bounding box + count of pixels matching a color family in a PNG buffer. */
async function scanInk(
  page: Page,
  png: Buffer,
  mode: "light" | "amber" | "red" | "selection",
  rect?: { x: number; y: number; w: number; h: number },
): Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number }> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (args: { dataUri: string; mode: string; rect?: { x: number; y: number; w: number; h: number } }) => {
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
    const r0 = args.rect ?? { x: 0, y: 0, w: img.width, h: img.height };
    const d = ctx.getImageData(r0.x, r0.y, r0.w, r0.h).data;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
    for (let y = 0; y < r0.h; y++) {
      for (let x = 0; x < r0.w; x++) {
        const i = (y * r0.w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let hit = false;
        if (args.mode === "light") hit = r > 170 && g > 170 && b > 170;
        else if (args.mode === "amber") hit = r > 200 && g > 150 && g < 220 && b < 100;
        else if (args.mode === "red") hit = r > 180 && g < 100 && b < 100;
        // #3b82f6 at ~2/3 alpha over white — strongly blue-dominant.
        else hit = b > 200 && b - r > 60 && b - g > 30;
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

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-states-e2e-"));
    writeFileSync(join(dir, "editor.html"), EDITOR_HTML);
    writeFileSync(join(dir, "page.html"), TEXT_HTML);
    return { browser: await launchChromium(PARITY_LAUNCH_OPTS), dir };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
  if (env != null) rmSync(env.dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("`states` compressed-run config (docs/100 stage 4)", () => {
  it("composes a states frame into a nested compressed run, logs the pairing ratio, and the rasterized tail shifts per state", async () => {
    const { browser, dir } = env!;
    const HOLDS = [220, 170, 170, 900];
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      frames: [{
        input: "./editor.html",
        duration: HOLDS.reduce((a, b) => a + b, 0),
        transition: { type: "cut", duration: 0 },
        caret: true,
        states: [
          { duration: HOLDS[0] },
          { actions: [{ type: "evaluate", script: "ins(1)" }], duration: HOLDS[1] },
          { actions: [{ type: "evaluate", script: "ins(2)" }], duration: HOLDS[2] },
          { actions: [{ type: "evaluate", script: "colorize()" }], duration: HOLDS[3] },
        ],
      }],
    });
    const logs: string[] = [];
    const config = await composeAnimateFrames(browser, cfg, { configDir: dir, log: (m) => logs.push(m) });

    // The frame's content is a nested animated SVG (the cast/typeResample
    // nesting), namespaced with the per-frame `cr0_` token, re-anchored via
    // embeddedAnimationPeriodMs = the run's total play time.
    expect(config.frames).toHaveLength(1);
    const frame = config.frames[0];
    expect(frame.svgContent).toMatch(/<svg[^>]*viewBox="0 0 640 240"/);
    expect(frame.svgContent).toContain("cr0_");
    expect(frame.embeddedAnimationPeriodMs).toBe(HOLDS.reduce((a, b) => a + b, 0));
    // The auto-caret rides the run (docs/101 markup inside the nested SVG;
    // the embed-namespace pass prefixes the class with the frame token).
    expect(frame.svgContent).toMatch(/class="cr0_text-track"/);
    // The compressor's pairing log line surfaced through the CLI logger.
    const pairingLine = logs.find((l) => /compress: run of 4 states, [\d.]+% glyphs paired/.test(l));
    expect(pairingLine, `pairing log missing; got:\n${logs.join("\n")}`).toBeTruthy();

    // Rasterize the ACTUAL composed SVG at state midpoints and assert the tail
    // genuinely shifts right by ~one Menlo advance per typed state, then the
    // colorize state recolors in place (amber ink appears, right edge stable).
    const svg = generateAnimatedSvg(config);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const viewer = await ctx.newPage();
      await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
      await viewer.evaluate(() => document.fonts.ready);
      const boundaries = HOLDS.map((_, i) => HOLDS.slice(0, i).reduce((a, b) => a + b, 0));
      const shot = async (tMs: number): Promise<Buffer> => {
        await seekTo(viewer, tMs);
        return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };
      const strip = { x: 20, y: 34, w: W - 24, h: 26 }; // the #line row
      const shots: Buffer[] = [];
      for (let s = 0; s < HOLDS.length; s++) shots.push(await shot(boundaries[s] + HOLDS[s] / 2));

      const edges: number[] = [];
      for (let s = 0; s < 3; s++) {
        const ink = await scanInk(viewer, shots[s], "light", strip);
        expect(ink.count, `state ${s}: no line ink`).toBeGreaterThan(50);
        edges.push(ink.maxX);
      }
      for (let s = 1; s < 3; s++) {
        const delta = edges[s] - edges[s - 1];
        expect(delta, `state ${s}: tail should shift right ~one Menlo advance`).toBeGreaterThanOrEqual(5);
        expect(delta, `state ${s}: tail should shift by ONE advance, not more`).toBeLessThanOrEqual(13);
      }
      // Colorize state: amber '{' / '}' appear; no amber before it.
      const amberBefore = await scanInk(viewer, shots[2], "amber", strip);
      const amberAfter = await scanInk(viewer, shots[3], "amber", strip);
      expect(amberBefore.count).toBe(0);
      expect(amberAfter.count).toBeGreaterThan(5);
    } finally {
      await ctx.close();
    }
  }, 240_000);
});

describeBrowser("`textTracks` caret/selection config (docs/101 config surface)", () => {
  it("stamps the selector at capture, parks the caret, and sweeps the selection in the rasterized SVG", async () => {
    const { browser, dir } = env!;
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      frames: [{
        input: "./page.html",
        duration: 4000,
        textTracks: [{
          selector: "#line",
          color: "#ff0000",
          events: [
            { type: "park", at: 200, charOffset: 0 },
            { type: "select", at: 1500, charStart: 0, charEnd: 5, sweepMs: 600 },
          ],
        }],
      }],
    });
    const config = await composeAnimateFrames(browser, cfg, { configDir: dir });
    expect(config.textTracks).toHaveLength(1);
    expect(config.textTracks![0].waypoints).toHaveLength(1);
    expect(config.textTracks![0].selections).toHaveLength(1);

    const svg = generateAnimatedSvg(config);
    expect(svg).toContain('class="text-track"');
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const viewer = await ctx.newPage();
      await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
      await viewer.evaluate(() => document.fonts.ready);
      const shot = async (tMs: number): Promise<Buffer> => {
        await seekTo(viewer, tMs);
        return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };

      // t=400 (blink-on): a thin red bar parked at char 0 — the text's left
      // edge (#line sits at left:40px), spanning the line's font box.
      const red = await scanInk(viewer, await shot(400), "red");
      expect(red.count).toBeGreaterThan(5);
      expect(Math.abs(red.minX - 40)).toBeLessThanOrEqual(3);
      expect(red.maxX - red.minX).toBeLessThanOrEqual(3);

      // t=1800 (mid-sweep, 300/600 ms): the selection is partially grown from
      // the text's left edge.
      const mid = await scanInk(viewer, await shot(1800), "selection");
      expect(mid.count).toBeGreaterThan(20);
      expect(Math.abs(mid.minX - 40)).toBeLessThanOrEqual(3);
      const midWidth = mid.maxX - mid.minX;

      // t=2500 (post-sweep): the full "Hello" span — wider than mid-sweep.
      const full = await scanInk(viewer, await shot(2500), "selection");
      expect(full.maxX - full.minX).toBeGreaterThan(midWidth);
    } finally {
      await ctx.close();
    }
  }, 240_000);

  // DM-1763: a frame's track ends at that frame's cut BY DEFAULT — the CLI
  // synthesizes a trailing hide (+ clearSelection) at the frame's duration, so a
  // caret parked in frame 0 does NOT haunt frame 1. `persist: true` opts out.
  it("auto-ends a parked caret at the frame's cut so it does not haunt the next frame (persist: true keeps it)", async () => {
    const { browser, dir } = env!;
    // Frame 0 parks a red caret at the line's left edge with NO explicit hide;
    // frame 1 is a plain continue frame. The caret bar lives near x≈40, y in
    // the #line font box (top:60px, 24px) — scan a tight rect around it.
    const caretRect = { x: 34, y: 52, w: 16, h: 40 };
    const makeCfg = (persist: boolean) =>
      validateAnimateConfig({
        width: W,
        height: H,
        frames: [
          {
            input: "./page.html",
            duration: 1000,
            transition: { type: "cut", duration: 0 },
            textTracks: [{
              selector: "#line",
              color: "#ff0000",
              ...(persist ? { persist: true } : {}),
              events: [{ type: "park", at: 100, charOffset: 0 }],
            }],
          },
          { continue: true, duration: 1000, transition: { type: "cut", duration: 0 } },
        ],
      });

    // t=1500 is inside frame 1 AND lands in the blink-ON half of the ~1.06 s
    // cycle (1500/1060 → phase 0.42 < 0.5), so a VISIBLE caret would paint here.
    const caretInkAt1500 = async (persist: boolean): Promise<number> => {
      const config = await composeAnimateFrames(browser, makeCfg(persist), { configDir: dir });
      const svg = generateAnimatedSvg(config);
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      try {
        const viewer = await ctx.newPage();
        await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
        await viewer.evaluate(() => document.fonts.ready);
        await seekTo(viewer, 1500);
        const png = await viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
        return (await scanInk(viewer, png, "red", caretRect)).count;
      } finally {
        await ctx.close();
      }
    };

    // Default: the synthesized hide at the frame-0 cut removes the caret — no
    // red ink over frame 1.
    expect(await caretInkAt1500(false)).toBe(0);
    // persist: true carries the parked caret over — red ink present in frame 1.
    expect(await caretInkAt1500(true)).toBeGreaterThan(5);
  }, 240_000);

  it("hard-errors at capture when a track selector matches nothing, naming frame + path", async () => {
    const { browser, dir } = env!;
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      frames: [{
        input: "./page.html",
        duration: 1000,
        textTracks: [{ selector: "#nope", events: [{ type: "park", at: 0, charOffset: 0 }] }],
      }],
    });
    await expect(composeAnimateFrames(browser, cfg, { configDir: dir })).rejects.toThrow(
      /frames\[0\]\.textTracks\[0\] selector "#nope" matched no element in frame 0/,
    );
  }, 120_000);
});
