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
import { expectFlipbookParity, PARITY_LAUNCH_OPTS } from "./flipbook-parity.js";

// DM-1761: the explicit per-frame `compress: true` marker — the surgical
// counterpart to the whole-config `autoCompress` flag. Two claims are load-
// bearing and both are proven here through the REAL pipeline:
//
//   1. FIDELITY — a marked run's composed output is PIXEL-IDENTICAL to the same
//      frames left uncompressed, at every state's hold (the same claim doc 100
//      makes for the compressor: the win is raw size + live-DOM weight, never
//      fidelity).
//   2. SELECTIVITY — only the marked run collapses. The identical config under
//      `autoCompress: true` collapses EVERYTHING, which is exactly the whole-
//      config-vs-per-run distinction the marker exists for.

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

// Five consecutive continue+cut frames, ALL of them eligible. The marker sits on
// frame 2, so the run [2,3,4] collapses and frames 0/1 stay sibling frames.
const DURATIONS = [300, 150, 150, 150, 300];
const MARKED_AT = 2;
const FRAMES = [
  { input: "./editor.html", duration: DURATIONS[0], transition: { type: "cut", duration: 0 } },
  { continue: true, duration: DURATIONS[1], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(3)" }] },
  { continue: true, duration: DURATIONS[2], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(6)" }], compress: true },
  { continue: true, duration: DURATIONS[3], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "ins(10)" }] },
  { continue: true, duration: DURATIONS[4], transition: { type: "cut", duration: 0 }, actions: [{ type: "evaluate", script: "colorize()" }] },
];
// The same frames with no marker at all — the uncompressed flipbook reference.
const PLAIN_FRAMES = FRAMES.map(({ compress: _drop, ...rest }) => rest);

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-compress-marker-e2e-"));
    writeFileSync(join(dir, "editor.html"), EDITOR_HTML);
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

describeBrowser("compress: true marker — pixel-identical, and only where marked (DM-1761)", () => {
  it("collapses just the marked run and rasterizes identically at every state", async () => {
    const { browser, dir } = env!;

    const flipCfg = validateAnimateConfig({ width: W, height: H, frames: PLAIN_FRAMES });
    const markCfg = validateAnimateConfig({ width: W, height: H, frames: FRAMES });
    const autoCfg = validateAnimateConfig({ width: W, height: H, autoCompress: true, frames: PLAIN_FRAMES });

    const markLogs: string[] = [];
    const flip = await composeAnimateFrames(browser, flipCfg, { configDir: dir });
    const mark = await composeAnimateFrames(browser, markCfg, { configDir: dir, log: (m) => markLogs.push(m) });
    const auto = await composeAnimateFrames(browser, autoCfg, { configDir: dir });

    // SELECTIVITY: 5 flipbook frames → 3 with the marker on frame 2 (frames 0
    // and 1 stay sibling frames even though they are just as eligible), vs 1
    // under the whole-config `autoCompress` flag on the identical frames.
    expect(flip.frames).toHaveLength(5);
    expect(mark.frames).toHaveLength(3);
    expect(auto.frames).toHaveLength(1);
    const runMs = DURATIONS.slice(MARKED_AT).reduce((a, b) => a + b, 0);
    expect(mark.frames[MARKED_AT].embeddedAnimationPeriodMs).toBe(runMs);
    expect(markLogs.some((l) => /^ {2}compress: collapsed frames 2–4 into a states run \(3 states, 600ms\)$/.test(l))).toBe(true);
    expect(markLogs.some((l) => /compress: run of 3 states/.test(l))).toBe(true);
    expect(markLogs.some((l) => /auto-compress:/.test(l))).toBe(false);

    const flipSvg = generateAnimatedSvg(flip);
    const markSvg = generateAnimatedSvg(mark);

    // FIDELITY: sample the MIDPOINT of each state's hold (away from the cuts).
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
      const markPage = await ctx.newPage();
      const diffPage = await ctx.newPage();

      for (let s = 0; s < sampleTimes.length; s++) {
        const t = sampleTimes[s];
        const flipPng = await render(flipPage, flipSvg, t);
        const markPng = await render(markPage, markSvg, t);
        const fPath = join(dir, `flip-${s}.png`);
        const mPath = join(dir, `mark-${s}.png`);
        const dPath = join(dir, `diff-${s}.png`);
        writeFileSync(fPath, flipPng);
        writeFileSync(mPath, markPng);
        const cmp = await comparePngs(diffPage, fPath, mPath, dPath);
        expectFlipbookParity(cmp, `state ${s} @ ${t}ms drifted from the flipbook`);
      }
    } finally {
      await ctx.close();
    }
  }, 240_000);

  it("hard-errors through the real compose path when a marked run cannot be collapsed", async () => {
    const { browser, dir } = env!;
    // Frame 2 is marked but frame 3 carries an intra-frame animation, so no
    // following frame can join the run. `autoCompress` would log and skip; the
    // marker fails loudly, naming the frame and the reason.
    const badFrames = PLAIN_FRAMES.map((f, i) => ({
      ...f,
      ...(i === MARKED_AT ? { compress: true } : {}),
      ...(i === MARKED_AT + 1 ? { animations: [{ selector: "#line", property: "opacity", from: "0", to: "1", duration: 100 }] } : {}),
    }));
    const cfg = validateAnimateConfig({ width: W, height: H, frames: badFrames });
    await expect(composeAnimateFrames(browser, cfg, { configDir: dir })).rejects.toThrow(
      /frames\[2\] sets `compress: true`.*no following frame can join it — frames\[3\] carries `animations`/s,
    );
  }, 60_000);
});
