import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { comparePngs } from "../src/review/compare-pngs.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { expectFlipbookParity } from "./flipbook-parity.js";

// DM-1757: automatic compressed-run detection. `autoCompress: true` collapses a
// maximal run of consecutive continue+cut frames into ONE `states` compressed
// run. The load-bearing correctness claim (doc 100): the compressed output is
// PIXEL-IDENTICAL to the uncompressed flipbook at every time — the win is raw
// size + live-DOM weight, never fidelity. This drives the REAL pipeline both
// ways and rasterizes the two composed SVGs at matched wall-clock times, then
// asserts region-level pixel identity (the same diff the regression suites use).

const W = 480;
const H = 200;

// A mid-line editor: ins(k) inserts a string one char at a time (reflowing the
// tail), colorize() re-tokenizes at unchanged glyph positions — the classic
// continue+cut editing run.
const EDITOR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#1e293b;overflow:hidden}
  #line{position:absolute;left:20px;top:40px;font:14px Menlo,monospace;color:#e2e8f0;white-space:pre}
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

// Five consecutive continue+cut frames: the base state, three insert steps, and
// the colorize. `autoCompress` collapses all five into one states run.
const DURATIONS = [300, 150, 150, 150, 300];
const FRAMES = [
  { input: "./editor.html", duration: DURATIONS[0], transition: { type: "cut", duration: 0 } },
  { continue: true, duration: DURATIONS[1], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(3)" }] },
  { continue: true, duration: DURATIONS[2], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(6)" }] },
  { continue: true, duration: DURATIONS[3], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(10)" }] },
  { continue: true, duration: DURATIONS[4], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "colorize()" }] },
];

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-autocompress-e2e-"));
    writeFileSync(join(dir, "editor.html"), EDITOR_HTML);
    return { browser: await launchChromium(), dir };
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

describeBrowser("autoCompress: pixel-identical to the flipbook (DM-1757)", () => {
  it("collapses the continue+cut run and rasterizes identically at every state", async () => {
    const { browser, dir } = env!;

    const flipCfg = validateAnimateConfig({ width: W, height: H, frames: FRAMES });
    const compCfg = validateAnimateConfig({ width: W, height: H, autoCompress: true, frames: FRAMES });

    const flipLogs: string[] = [];
    const compLogs: string[] = [];
    const flip = await composeAnimateFrames(browser, flipCfg, { configDir: dir, log: (m) => flipLogs.push(m) });
    const comp = await composeAnimateFrames(browser, compCfg, { configDir: dir, log: (m) => compLogs.push(m) });

    // Structural: the flipbook keeps its 5 frames; autoCompress collapses to 1.
    expect(flip.frames).toHaveLength(5);
    expect(comp.frames).toHaveLength(1);
    expect(comp.frames[0].embeddedAnimationPeriodMs).toBe(DURATIONS.reduce((a, b) => a + b, 0));
    // The collapse + the compressor's pairing log both surfaced.
    expect(compLogs.some((l) => /auto-compress: collapsed frames 0–4/.test(l))).toBe(true);
    expect(compLogs.some((l) => /compress: run of 5 states/.test(l))).toBe(true);

    const flipSvg = generateAnimatedSvg(flip);
    const compSvg = generateAnimatedSvg(comp);

    // Sample the MIDPOINT of each state's hold (away from the cut boundaries).
    const starts = DURATIONS.map((_, i) => DURATIONS.slice(0, i).reduce((a, b) => a + b, 0));
    const sampleTimes = DURATIONS.map((d, i) => starts[i] + d / 2);

    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const render = async (page: Page, svg: string, tMs: number): Promise<Buffer> => {
        await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        await seekTo(page, tMs);
        return page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };
      const flipPage = await ctx.newPage();
      const compPage = await ctx.newPage();
      const diffPage = await ctx.newPage();

      for (let s = 0; s < sampleTimes.length; s++) {
        const t = sampleTimes[s];
        const flipPng = await render(flipPage, flipSvg, t);
        const compPng = await render(compPage, compSvg, t);
        const fPath = join(dir, `flip-${s}.png`);
        const cPath = join(dir, `comp-${s}.png`);
        const dPath = join(dir, `diff-${s}.png`);
        writeFileSync(fPath, flipPng);
        writeFileSync(cPath, compPng);
        const cmp = await comparePngs(diffPage, fPath, cPath, dPath);
        expectFlipbookParity(cmp, `state ${s} @ ${t}ms drifted from the flipbook`);
      }
    } finally {
      await ctx.close();
    }
  }, 240_000);

  // DM-1764: a single ineligible frame (here: the one an explicit cursor event
  // addresses) SPLITS the run instead of disqualifying it — the sub-runs on
  // either side still collapse, and that frame stays a plain sibling frame so
  // its pointer behaves exactly as it did uncompressed. Same load-bearing
  // claim as above: pixel-identical to the flipbook at every state.
  it("splits the run around a cursor-addressed frame and stays pixel-identical", async () => {
    const { browser, dir } = env!;

    const durations = [300, 150, 150, 200, 150, 150, 300];
    const scripts = ["ins(2)", "ins(4)", "ins(6)", "ins(7)", "ins(8)", "ins(10)"];
    const splitFrames = [
      { input: "./editor.html", duration: durations[0], transition: { type: "cut", duration: 0 } },
      ...scripts.map((script, k) => ({
        continue: true, duration: durations[k + 1], transition: { type: "cut", duration: 0 },
        actions: [{ type: "evaluate", script }],
      })),
    ];
    // The cursor event lands on frame 3 — the middle of the eligible window.
    const cursor = { events: [{ frame: 3, at: 0, type: "click", selector: "#line" }] };

    const flipCfg = validateAnimateConfig({ width: W, height: H, cursor, frames: splitFrames });
    const compCfg = validateAnimateConfig({ width: W, height: H, cursor, autoCompress: true, frames: splitFrames });

    const compLogs: string[] = [];
    const flip = await composeAnimateFrames(browser, flipCfg, { configDir: dir });
    const comp = await composeAnimateFrames(browser, compCfg, { configDir: dir, log: (m) => compLogs.push(m) });

    // [0,1,2] → one run · frame 3 plain · [4,5,6] → one run.
    expect(flip.frames).toHaveLength(7);
    expect(comp.frames).toHaveLength(3);
    expect(comp.frames[0].embeddedAnimationPeriodMs).toBe(durations[0] + durations[1] + durations[2]);
    expect(comp.frames[1].embeddedAnimationPeriodMs).toBeUndefined(); // plain captured frame
    expect(comp.frames[2].embeddedAnimationPeriodMs).toBe(durations[4] + durations[5] + durations[6]);
    expect(compLogs.some((l) => /auto-compress: leaving frame 3 uncompressed — an explicit cursor event addresses frame 3/.test(l))).toBe(true);
    expect(compLogs.some((l) => /auto-compress: collapsed frames 0–2 into a states run/.test(l))).toBe(true);
    expect(compLogs.some((l) => /auto-compress: collapsed frames 4–6 into a states run/.test(l))).toBe(true);

    const flipSvg = generateAnimatedSvg(flip);
    const compSvg = generateAnimatedSvg(comp);

    const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
    const sampleTimes = durations.map((d, i) => starts[i] + d / 2);

    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const render = async (page: Page, svg: string, tMs: number): Promise<Buffer> => {
        await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        await seekTo(page, tMs);
        return page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };
      const flipPage = await ctx.newPage();
      const compPage = await ctx.newPage();
      const diffPage = await ctx.newPage();

      for (let s = 0; s < sampleTimes.length; s++) {
        const t = sampleTimes[s];
        const fPath = join(dir, `split-flip-${s}.png`);
        const cPath = join(dir, `split-comp-${s}.png`);
        const dPath = join(dir, `split-diff-${s}.png`);
        writeFileSync(fPath, await render(flipPage, flipSvg, t));
        writeFileSync(cPath, await render(compPage, compSvg, t));
        const cmp = await comparePngs(diffPage, fPath, cPath, dPath);
        expectFlipbookParity(cmp, `state ${s} @ ${t}ms drifted from the flipbook`);
      }
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
