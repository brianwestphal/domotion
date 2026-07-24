import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, BrowserContext } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import type { CapturedElement } from "../src/capture/types.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { comparePngs } from "../src/review/compare-pngs.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { expectFlipbookParity } from "./flipbook-parity.js";

/**
 * Independent per-region timing inside ONE compressed run (docs/100
 * "independent per-region timing", docs/43 §11.1).
 *
 * The scene holds two panes that change on DIFFERENT schedules: a code editor
 * typed into on the odd states, a preview scrolled on the even ones. Declaring
 * them as `regions` and tagging each state with the region it `advances` buys
 * two things, and this suite pins both:
 *
 *  1. **Capture count.** States advancing disjoint regions share one whole-page
 *     capture, so a 7-state run over 2 regions costs 4 whole-page captures
 *     instead of 7 — `1 + max(nᵢ)` rather than `1 + Σnᵢ`.
 *  2. **Correctness of the assembly.** Each state's tree is assembled from the
 *     round holding each region's own state — a page configuration the browser
 *     was never actually driven into. The bar is therefore the strongest one
 *     available: the composed run is rasterized against the UNCOMPRESSED
 *     FLIPBOOK OF SEQUENTIAL CAPTURES — the same seven states driven into the
 *     page one at a time and captured whole, which is exactly the ground truth
 *     the per-region schedule is allowed to shortcut. Identical pixels at every
 *     state means the splice reproduced the real page and the compression on
 *     top of it changed nothing.
 */

const W = 900;
const H = 420;
const OUT_DIR = "tests/output/region-timing-e2e";

/** Left = a code editor whose import line grows a character at a time;
 *  right = a preview scrolled by whole lines. The panes are fixed-width and
 *  clipped, so neither one's content can move anything outside itself. */
const PAGE_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0f172a; }
  .split { display: flex; height: ${H}px; }
  .pane { width: 450px; height: ${H}px; overflow: hidden; padding: 12px 0; }
  .editor { background: #1e293b; color: #e2e8f0; font-family: Menlo, ui-monospace, monospace;
    font-size: 12.5px; line-height: 19px; }
  .preview { background: #f8fafc; color: #0f172a; font-family: Georgia, serif;
    font-size: 13px; line-height: 19px; }
  .ln { height: 19px; white-space: pre; padding: 0 14px; }
  .no { display: inline-block; width: 26px; text-align: right; margin-right: 12px; color: #475569; }
  .kw { color: #93c5fd; } .str { color: #86efac; } .num { color: #fbbf24; }
  .h { font-weight: 700; }
</style></head><body>
  <div class="split">
    <div class="pane editor" id="ed"></div>
    <div class="pane preview" id="pv"></div>
  </div>
<script>
  var K = function (s) { return '<span class="kw">' + s + '</span>'; };
  var S_ = function (s) { return '<span class="str">' + s + '</span>'; };
  var N_ = function (s) { return '<span class="num">' + s + '</span>'; };
  var CODE = [
    '',
    '',
    K('const') + ' count = signal(' + N_('0') + ');',
    K('const') + ' root = document.body;',
    '',
    'mount(root, () ' + K('=&gt;') + ' (',
    '  &lt;button onClick={inc}&gt;',
    '    {count.value}',
    '  &lt;/button&gt;',
    '));',
    '',
    'export ' + K('default') + ' root;'
  ];
  var PREVIEW = [
    '<span class="h">Getting started</span>',
    '',
    'Install the package and import the two',
    'primitives you need to render a view.',
    '',
    '<span class="h">Signals</span>',
    '',
    'A signal is a value plus a subscriber set.',
    'Reading one inside a render registers a',
    'dependency; writing one schedules a flush.',
    '',
    '<span class="h">Mounting</span>',
    '',
    'Mount attaches a view to a host element',
    'and keeps it in sync with your signals.',
    '',
    'Delegated events keep listener count flat',
    'no matter how many rows you render.',
    '',
    '<span class="h">Next steps</span>',
    '',
    'Read the recipes for forms and routing.'
  ];
  var INS = ' computed,';
  var ROWS = 20;
  function rows(host, htmls, numbered) {
    document.getElementById(host).innerHTML = htmls.map(function (h, i) {
      return '<div class="ln">' + (numbered ? '<span class="no">' + (i + 1) + '</span>' : '') + '<span>' + h + '</span></div>';
    }).join('');
  }
  window.setLeft = function (k) {
    var c = CODE.slice();
    c[0] = K('import') + ' { signal,' + INS.slice(0, k) + ' mount } ' + K('from') + ' ' + S_("'kerfjs'") + ';';
    rows('ed', c, true);
  };
  window.setRight = function (off) {
    var p = [];
    for (var i = 0; i < ROWS; i++) p.push(PREVIEW[(off + i) % PREVIEW.length]);
    rows('pv', p, false);
  };
  window.setLeft(0);
  window.setRight(0);
</script></body></html>`;

/** Seven states, alternating which pane advances: the editor on the odd
 *  states, the preview on the even ones. `[left chars, right scroll]` is the
 *  page configuration each state must depict. */
const HOLDS = [260, 180, 180, 180, 180, 180, 700];
const CONFIGURATIONS: Array<[number, number]> = [
  [0, 0], [2, 0], [2, 1], [4, 1], [4, 2], [6, 2], [6, 3],
];
const BOUNDARIES = HOLDS.map((_, i) => HOLDS.slice(0, i).reduce((a, b) => a + b, 0));
const TOTAL = HOLDS.reduce((a, b) => a + b, 0);

/** The same seven states as an `advances`-tagged `states:` block. */
const REGION_STATES = [
  { duration: HOLDS[0] },
  { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(2)" }], duration: HOLDS[1] },
  { advances: ["preview"], actions: [{ type: "evaluate", script: "setRight(1)" }], duration: HOLDS[2] },
  { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(4)" }], duration: HOLDS[3] },
  { advances: ["preview"], actions: [{ type: "evaluate", script: "setRight(2)" }], duration: HOLDS[4] },
  { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(6)" }], duration: HOLDS[5] },
  { advances: ["preview"], actions: [{ type: "evaluate", script: "setRight(3)" }], duration: HOLDS[6] },
];

/**
 * The GROUND TRUTH: drive the page into every one of the seven configurations
 * one at a time and capture it whole (the `Σnᵢ` schedule per-region timing
 * exists to avoid), then render them as a plain uncompressed flipbook.
 */
async function sequentialFlipbook(ctx: BrowserContext): Promise<string> {
  const page = await ctx.newPage();
  await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  const trees: CapturedElement[][] = [];
  for (const [k, off] of CONFIGURATIONS) {
    await page.evaluate((a: [number, number]) => {
      (window as unknown as { setLeft: (n: number) => void }).setLeft(a[0]);
      (window as unknown as { setRight: (n: number) => void }).setRight(a[1]);
    }, [k, off] as [number, number]);
    trees.push(await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H }));
  }
  await page.close();

  const rootBg = (trees[0][0]?.styles as { rootBgComputed?: string } | undefined)?.rootBgComputed;
  clearEmbeddedFonts();
  clearGlyphDefs();
  return generateAnimatedSvg({
    width: W, height: H,
    frames: trees.map((tree, i) => ({
      svgContent: elementTreeToSvgInner(structuredClone(tree), W, H, `f${i}-`, true, 2, false),
      duration: HOLDS[i],
      transition: { type: "cut" as const, duration: 0 },
    })),
    fontFaceCss: getEmbeddedFontFaceCss(),
    ...(rootBg != null ? { background: rootBg } : {}),
  });
}

/** Rasterize two SVGs at every state's midpoint and hold them to the
 *  shift-inclusive compressed-run parity bar. */
async function assertParityAtEveryState(
  ctx: BrowserContext,
  expectedSvg: string,
  actualSvg: string,
  label: string,
): Promise<void> {
  const dir = join(OUT_DIR, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "expected.svg"), expectedSvg);
  writeFileSync(join(dir, "actual.svg"), actualSvg);

  const open = async (svg: string): Promise<Page> => {
    const p = await ctx.newPage();
    await p.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
    await p.evaluate(() => document.fonts.ready);
    return p;
  };
  const expPage = await open(expectedSvg);
  const actPage = await open(actualSvg);
  const shot = async (p: Page, tMs: number): Promise<Buffer> => {
    await seekTo(p, tMs);
    return p.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  };
  const cmpPage = await ctx.newPage();
  for (let s = 0; s < HOLDS.length; s++) {
    const t = BOUNDARIES[s] + HOLDS[s] / 2;
    const expPath = join(dir, `state-${s}-expected.png`);
    const actPath = join(dir, `state-${s}-actual.png`);
    writeFileSync(expPath, await shot(expPage, t));
    writeFileSync(actPath, await shot(actPage, t));
    const cmp = await comparePngs(cmpPage, expPath, actPath, join(dir, `state-${s}-diff.png`));
    expectFlipbookParity(cmp, `${label} state ${s}`);
  }
  await expPage.close();
  await actPage.close();
  await cmpPage.close();
}

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-region-timing-"));
    writeFileSync(join(dir, "panes.html"), PAGE_HTML);
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

describeBrowser("independent per-region timing in one compressed run (docs/100, docs/43 §11.1)", () => {
  it("two regions on their own schedules compose correctly, at 4 whole-page captures instead of 7", async () => {
    const { browser, dir } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const cfg = validateAnimateConfig({
        width: W,
        height: H,
        frames: [{
          input: "./panes.html",
          duration: TOTAL,
          transition: { type: "cut", duration: 0 },
          regions: { editor: "#ed", preview: "#pv" },
          states: REGION_STATES,
        }],
      });
      const logs: string[] = [];
      const composed = await composeAnimateFrames(browser, cfg, { configDir: dir, log: (m) => logs.push(m) });

      // The capture-count win, straight off the log line the CLI prints.
      const scheduleLine = logs.find((l) => l.includes("whole-page capture"));
      expect(scheduleLine, `per-region schedule not logged; got:\n${logs.join("\n")}`).toBeTruthy();
      expect(scheduleLine).toContain("7 states over 2 regions");
      expect(scheduleLine).toContain("4 whole-page captures");
      expect(scheduleLine).toContain("7 without it");

      // It is still one config frame ↔ one animation frame, nesting a run.
      expect(composed.frames).toHaveLength(1);
      expect(composed.frames[0].embeddedAnimationPeriodMs).toBe(TOTAL);

      const st = logs.find((l) => /compress: run of 7 states, [\d.]+% glyphs paired/.test(l));
      expect(st, `pairing log missing; got:\n${logs.join("\n")}`).toBeTruthy();
      console.log(`[region-timing] ${scheduleLine!.trim()}\n[region-timing] ${st!.trim()}`);

      // ...and the point of the whole exercise: the assembled-from-4-captures
      // run paints exactly what seven honest sequential captures paint.
      const expected = await sequentialFlipbook(ctx);
      await assertParityAtEveryState(ctx, expected, generateAnimatedSvg(composed), "per-region-timing");
    } finally {
      await ctx.close();
    }
  }, 420_000);

  it("declaring `regions` without any `advances` is a discriminator override only — capture stays sequential", async () => {
    const { browser, dir } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const cfg = validateAnimateConfig({
        width: W,
        height: H,
        frames: [{
          input: "./panes.html",
          duration: TOTAL,
          transition: { type: "cut", duration: 0 },
          regions: { editor: "#ed", preview: "#pv" },
          // The same seven configurations, hand-interleaved the old way.
          states: REGION_STATES.map((s, i) => ({
            duration: s.duration,
            ...(i === 0 ? {} : {
              actions: [{
                type: "evaluate",
                script: `setLeft(${CONFIGURATIONS[i][0]}); setRight(${CONFIGURATIONS[i][1]})`,
              }],
            }),
          })),
        }],
      });
      const logs: string[] = [];
      const composed = await composeAnimateFrames(browser, cfg, { configDir: dir, log: (m) => logs.push(m) });

      // No per-region schedule: one capture per state, exactly as before.
      expect(logs.some((l) => l.includes("whole-page capture"))).toBe(false);
      expect(logs.some((l) => /states: capturing 7 editing states/.test(l))).toBe(true);

      const expected = await sequentialFlipbook(ctx);
      await assertParityAtEveryState(ctx, expected, generateAnimatedSvg(composed), "discriminator-override");
    } finally {
      await ctx.close();
    }
  }, 420_000);

  it("rejects per-region timing when the page changes outside every declared region", async () => {
    const { browser, dir } = env!;
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      frames: [{
        input: "./panes.html",
        duration: 600,
        transition: { type: "cut", duration: 0 },
        // Only the editor is declared, so the preview's scroll lands OUTSIDE
        // every region — precisely the assembly the splice cannot express.
        regions: { editor: "#ed" },
        states: [
          { duration: 200 },
          { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(2)" }], duration: 200 },
          { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(4); setRight(2)" }], duration: 200 },
        ],
      }],
    });
    await expect(composeAnimateFrames(browser, cfg, { configDir: dir, log: () => {} }))
      .rejects.toThrow(/changed OUTSIDE the declared regions/);
  }, 240_000);
});
