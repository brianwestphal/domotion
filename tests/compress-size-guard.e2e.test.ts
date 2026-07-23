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

// DM-1764 — the size-regression guard. Compressing a run is pixel-identical but
// NOT unconditionally smaller: a WHOLESALE-CHANGE run (a slideshow, where
// consecutive states share almost nothing) pairs badly, re-emits nearly
// everything as births/deaths, and pays the union + track overhead on top —
// measured at 2.36x the uncompressed payload. So after composing a run the
// automatic pass created, the guard compares it against the same states
// rendered uncompressed and keeps whichever is smaller. Two claims here: the
// output does NOT grow (the whole point — `autoCompress` can never make things
// worse), and the fallback is still pixel-identical to the flipbook.

const W = 480;
const H = 260;

// Every state replaces the entire painted content — the pathological shape.
const SLIDES_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#0f172a;overflow:hidden;
       font:16px Helvetica,Arial,sans-serif;color:#f8fafc}
  #slide{padding:24px}h1{font-size:22px;margin:0 0 12px}li{margin:5px 0}
</style></head><body>
  <div id="slide"></div>
<script>
  const SLIDES = [
    ["Capture the DOM", "Playwright drives Chromium", "The tree is serialized", "Computed styles ride along"],
    ["Resolve every font", "CoreText on macOS", "fontconfig on Linux", "DirectWrite on Windows"],
    ["Emit self-contained SVG", "No external assets", "Subset fonts embedded", "Scales crisply at any size"],
    ["Compose the animation", "Keyframes, not scripts", "One file to ship", "Loads lazily"],
    ["Review the diff", "Expected against actual", "Region-level scoring", "Pixel evidence first"],
  ];
  window.slide = (k) => {
    const s = SLIDES[k];
    document.getElementById("slide").innerHTML =
      "<h1>" + s[0] + "</h1><ul>" + s.slice(1).map((l) => "<li>" + l + "</li>").join("") + "</ul>";
  };
  window.slide(0);
</script></body></html>`;

const DURATIONS = [400, 400, 400, 400, 400];
const FRAMES = [
  { input: "./slides.html", duration: DURATIONS[0], transition: { type: "cut", duration: 0 } },
  ...[1, 2, 3, 4].map((k) => ({
    continue: true, duration: DURATIONS[k], transition: { type: "cut", duration: 0 },
    actions: [{ type: "evaluate", script: `slide(${k})` }],
  })),
];

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-compress-guard-e2e-"));
    writeFileSync(join(dir, "slides.html"), SLIDES_HTML);
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

describeBrowser("autoCompress size-regression guard (DM-1764)", () => {
  it("reverts a wholesale-change run to uncompressed states, without growing the output", async () => {
    const { browser, dir } = env!;

    const flipCfg = validateAnimateConfig({ width: W, height: H, frames: FRAMES });
    const compCfg = validateAnimateConfig({ width: W, height: H, autoCompress: true, frames: FRAMES });

    const compLogs: string[] = [];
    const flip = await composeAnimateFrames(browser, flipCfg, { configDir: dir });
    const comp = await composeAnimateFrames(browser, compCfg, { configDir: dir, log: (m) => compLogs.push(m) });

    // Structurally the collapse still happened (one nested frame) — the guard
    // swaps the run's CONTENT, not the frame shape, so the collapse pre-pass's
    // 1 config-frame to 1 animation-frame invariant is untouched.
    expect(flip.frames).toHaveLength(5);
    expect(comp.frames).toHaveLength(1);
    expect(comp.frames[0].embeddedAnimationPeriodMs).toBe(DURATIONS.reduce((a, b) => a + b, 0));

    // The guard tripped and said why.
    const revert = compLogs.find((l) => /auto-compress: reverting frame 0's run to uncompressed states/.test(l));
    expect(revert, `no revert log line; got:\n${compLogs.join("\n")}`).toBeDefined();
    expect(revert).toMatch(/grew the payload \d+%/);

    const flipSvg = generateAnimatedSvg(flip);
    const compSvg = generateAnimatedSvg(comp);

    // The load-bearing claim: turning `autoCompress` ON did not make the output
    // bigger. (Without the guard this run composes at ~2.4x its uncompressed
    // payload.) The small allowance is the nested wrapper: one <svg>, N <g>s,
    // and one display track each, measured at ~6% of the payload.
    expect(compSvg.length).toBeLessThan(flipSvg.length * 1.1);

    // …and it is still pixel-identical to the flipbook at every state.
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
        const fPath = join(dir, `flip-${s}.png`);
        const cPath = join(dir, `comp-${s}.png`);
        const dPath = join(dir, `diff-${s}.png`);
        writeFileSync(fPath, await render(flipPage, flipSvg, t));
        writeFileSync(cPath, await render(compPage, compSvg, t));
        const cmp = await comparePngs(diffPage, fPath, cPath, dPath);
        expectFlipbookParity(cmp, `state ${s} @ ${t}ms drifted from the flipbook`);
      }
    } finally {
      await ctx.close();
    }
  }, 240_000);

  it("leaves a well-pairing editing run compressed (the guard is not a blanket opt-out)", async () => {
    const { browser, dir } = env!;
    // The same page, but each state only appends one bullet — content pairs, so
    // the compressed form wins and the guard must NOT fire.
    writeFileSync(join(dir, "grow.html"), SLIDES_HTML.replace(
      "window.slide(0);",
      `window.slide = (k) => { document.getElementById("slide").innerHTML =
         "<h1>Capture the DOM</h1><ul>" + ["Playwright drives Chromium","The tree is serialized","Computed styles ride along","Nothing is guessed"]
           .slice(0, k + 1).map((l) => "<li>" + l + "</li>").join("") + "</ul>"; };
       window.slide(0);`,
    ));
    const frames = [
      { input: "./grow.html", duration: 300, transition: { type: "cut", duration: 0 } },
      ...[1, 2, 3].map((k) => ({
        continue: true, duration: 300, transition: { type: "cut", duration: 0 },
        actions: [{ type: "evaluate", script: `slide(${k})` }],
      })),
    ];
    const logs: string[] = [];
    const flip = await composeAnimateFrames(browser, validateAnimateConfig({ width: W, height: H, frames }), { configDir: dir });
    const comp = await composeAnimateFrames(browser, validateAnimateConfig({ width: W, height: H, autoCompress: true, frames }), { configDir: dir, log: (m) => logs.push(m) });
    expect(logs.some((l) => /reverting frame/.test(l))).toBe(false);
    // And it is a real win, not a wash.
    expect(generateAnimatedSvg(comp).length).toBeLessThan(generateAnimatedSvg(flip).length * 0.9);
  }, 240_000);
});
