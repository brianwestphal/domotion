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
import { expectFlipbookParity, PARITY_LAUNCH_OPTS, loadSeekableSvg } from "./flipbook-parity.js";

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

describeBrowser("autoCompress size-regression guard (DM-1764)", () => {
  it("reverts a wholesale-change run to uncompressed states, without growing the output", async () => {
    const { browser, dir } = env!;

    // `autoCompress: false` — the uncompressed baseline (auto-collapse is the
    // default since DM-1768, so the flipbook reference must opt out explicitly).
    const flipCfg = validateAnimateConfig({ width: W, height: H, autoCompress: false, frames: FRAMES });
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
        await loadSeekableSvg(page, svg);
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
    const flip = await composeAnimateFrames(browser, validateAnimateConfig({ width: W, height: H, autoCompress: false, frames }), { configDir: dir });
    const comp = await composeAnimateFrames(browser, validateAnimateConfig({ width: W, height: H, autoCompress: true, frames }), { configDir: dir, log: (m) => logs.push(m) });
    expect(logs.some((l) => /reverting frame/.test(l))).toBe(false);
    // And it is a real win, not a wash.
    expect(generateAnimatedSvg(comp).length).toBeLessThan(generateAnimatedSvg(flip).length * 0.9);
  }, 240_000);

  // DM-1772: the guard is PER REGION. A scene with a well-pairing pane beside a
  // wholesale-change pane must demote only what's worth demoting — and the
  // demoted output must beat BOTH the uncompressed flipbook and keep-all, which
  // is only possible if it demoted the RIGHT region: demoting the wrong subset
  // (the well-pairing pane) would exceed the flipbook and the guard would pick
  // the flipbook instead. Chrome demotion beats the flipbook here because the
  // large shared left column dedupes in the union while the flipbook re-emits it
  // whole every state.
  const MW = 640, MH = 300;
  const MIXED_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;width:${MW}px;height:${MH}px;overflow:hidden;background:#0f172a;font:13px Helvetica,Arial,sans-serif}
    .split{display:flex;height:${MH}px}
    .col{width:${MW / 2}px;height:${MH}px;padding:12px 0;overflow:hidden}
    .left{background:#1e293b;color:#e2e8f0;font-family:Menlo,monospace;font-size:12.5px;line-height:19px}
    .right{background:#f8fafc;color:#0f172a;font-size:13px;line-height:19px}
    .ln{height:19px;white-space:pre;padding:0 14px}
    h1{font-size:16px;margin:0 0 8px;padding:0 14px}
  </style></head><body>
    <div class="split"><div class="col left" id="left"></div><div class="col right" id="right"></div></div>
  <script>
    var BASE=['// module.ts','','const label = "";','const a = 1;','const b = 2;','const c = 3;','','function run() {','  return a + b + c;','}','','export { run };'];
    window.setLeft=function(k){
      var rows=BASE.slice(); rows[2]='const label = "'+'lorem-ipsum'.slice(0,k)+'";';
      document.getElementById('left').innerHTML=rows.map(function(h){return '<div class="ln">'+h+'</div>';}).join('');
    };
    // DM-1978: six lines per slide, not three, and no line shared between
    // slides. The wholesale pane has to OUTWEIGH the well-pairing code pane for
    // the run to be a genuine size regression — with three short lines it did
    // not, and the whole decision hung on ~1% of payload. macOS measured
    // 26.3 KB -> 26.5 KB (a regression, guard trips) while Linux measured
    // 26.0 KB -> 25.5 KB (no regression, guard correctly stays out), off the
    // same 62.7% pairing. The glyph payload legitimately differs by platform —
    // different faces, different subset sizes — so a fixture balanced on the
    // sign of a 1% difference tests the platform, not the compressor. At this
    // size both measure ~+30%.
    var SLIDES=[
      ['Overview','Domotion turns DOM into SVG','Pixel-faithful to Chromium','Embeds with no external assets','Marketing demos load lazily','One file, no runtime scripts','Scales crisply at any size'],
      ['Rendering','Blink decides which typeface','HarfBuzz shapes every cluster','Skia rasterizes the outlines','Bidi mirrors paired brackets','Gradients become native defs','Shadow pseudos are honored'],
      ['Platforms','CoreText answers on Apple','Fontconfig resolves on Ubuntu','DirectWrite maps on Windows','Each chain is calibrated','Hinting floors are documented','Oracles gate the agreement'],
      ['Motion','Keyframes replace scripting','Magic-move pairs subtrees','Scroll patterns drive cameras','Typing overlays anchor baselines','Carets ride measured advances','Transitions compose cleanly'],
      ['Verification','Expected against actual','Region-level scoring beats eyeballs','Conformance sweeps every codepoint','Baselines refuse mismatched envs','Cassettes replay host answers','Evidence precedes conclusions']
    ];
    window.setRight=function(k){
      var s=SLIDES[k];
      document.getElementById('right').innerHTML='<h1>'+s[0]+'</h1>'+s.slice(1).map(function(l){return '<div class="ln">'+l+'</div>';}).join('');
    };
    window.setLeft(0); window.setRight(0);
  </script></body></html>`;

  const MIXED_DUR = [360, 360, 360, 360, 360];
  const MIXED_FRAMES = [
    { input: "./mixed.html", duration: MIXED_DUR[0], transition: { type: "cut" as const, duration: 0 } },
    ...[1, 2, 3, 4].map((k) => ({
      continue: true as const, duration: MIXED_DUR[k], transition: { type: "cut" as const, duration: 0 },
      actions: [{ type: "evaluate" as const, script: `setLeft(${k * 2}); setRight(${k})` }],
    })),
  ];

  it("per-region: demotes the wholesale pane, keeps the shared pane deduped, and beats the flipbook (DM-1772)", async () => {
    const { browser, dir } = env!;
    writeFileSync(join(dir, "mixed.html"), MIXED_HTML);
    const cfg = { width: MW, height: MH, frames: MIXED_FRAMES };

    const flip = await composeAnimateFrames(browser, validateAnimateConfig({ ...cfg, autoCompress: false }), { configDir: dir });
    const logs: string[] = [];
    const comp = await composeAnimateFrames(browser, validateAnimateConfig({ ...cfg, autoCompress: true }), { configDir: dir, log: (m) => logs.push(m) });

    // The guard tripped and chose chrome demotion (not the flipbook revert).
    const demoteLog = logs.find((l) => /demoting .* into the chrome union/.test(l));
    expect(demoteLog, `no demotion log; got:\n${logs.join("\n")}`).toBeDefined();

    // DM-1978: and it tripped by a MARGIN, not by a hair. The demotion branch is
    // only reached when compressing grew the run, so a fixture that grows it by
    // ~1% passes on whichever platform rounds the right way and fails on the
    // other — which is precisely what happened here, off identical pairing.
    // Pinning the margin means a future fixture edit that quietly walks it back
    // to the boundary fails HERE, naming the cause, instead of surfacing later
    // as a platform-specific flake.
    const grewBy = /kept them (\d+)% larger/.exec(demoteLog!);
    expect(grewBy, `demotion log did not report a growth %: ${demoteLog}`).not.toBeNull();
    expect(Number(grewBy![1])).toBeGreaterThanOrEqual(10);

    const flipSvg = generateAnimatedSvg(flip);
    const compSvg = generateAnimatedSvg(comp);
    // Beats BOTH keep-all (implicitly — the guard only demotes when smaller) and
    // the uncompressed flipbook. A win over the flipbook is only reachable by
    // demoting the RIGHT region(s); the wrong subset would exceed it.
    expect(compSvg.length).toBeLessThan(flipSvg.length);

    // Byte-identity of the speculative trials: composing the same config again
    // (which re-runs every per-region trial) must be byte-for-byte identical —
    // proof the snapshot/restore leaves no PUA / dmfN trace (DM-1771 contract).
    const comp2 = await composeAnimateFrames(browser, validateAnimateConfig({ ...cfg, autoCompress: true }), { configDir: dir });
    expect(generateAnimatedSvg(comp2)).toBe(compSvg);

    // Pixel-identical to the flipbook at every state.
    const starts = MIXED_DUR.map((_, i) => MIXED_DUR.slice(0, i).reduce((a, b) => a + b, 0));
    const sampleTimes = MIXED_DUR.map((d, i) => starts[i] + d / 2);
    const ctx = await browser.newContext({ viewport: { width: MW, height: MH }, deviceScaleFactor: 1 });
    try {
      const render = async (page: Page, svg: string, tMs: number): Promise<Buffer> => {
        await loadSeekableSvg(page, svg);
        await seekTo(page, tMs);
        return page.screenshot({ clip: { x: 0, y: 0, width: MW, height: MH } });
      };
      const flipPage = await ctx.newPage();
      const compPage = await ctx.newPage();
      const diffPage = await ctx.newPage();
      for (let s = 0; s < sampleTimes.length; s++) {
        const t = sampleTimes[s];
        const fPath = join(dir, `mixed-flip-${s}.png`);
        const cPath = join(dir, `mixed-comp-${s}.png`);
        writeFileSync(fPath, await render(flipPage, flipSvg, t));
        writeFileSync(cPath, await render(compPage, compSvg, t));
        const cmp = await comparePngs(diffPage, fPath, cPath, join(dir, `mixed-diff-${s}.png`));
        expectFlipbookParity(cmp, `mixed state ${s} @ ${t}ms drifted from the flipbook`);
      }
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
