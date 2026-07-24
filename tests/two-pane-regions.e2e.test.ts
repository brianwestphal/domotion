import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, BrowserContext } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { generateAnimatedSvg, namespaceEmbeddedAnimatedSvg } from "../src/animation/index.js";
import { composeCompressedRun, buildCompressedRunPlan } from "../src/animation/compressed-run.js";
import type { CapturedElement } from "../src/capture/types.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { comparePngs } from "../src/review/compare-pngs.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { expectFlipbookParity } from "./flipbook-parity.js";

/**
 * Two independently-updating regions in one compressed run (docs/100,
 * "Independent regions in one scene").
 *
 * A scene commonly holds several regions that update on their own schedule — an
 * editor pane and a rendered-preview pane side by side, both changing on
 * DIFFERENT timings. Their text lines sit at the SAME y values, and the
 * compressor's line buckets key on a segment's y — so without a region
 * discriminator the two panes merge into one logical line, and the pairing pass
 * sees a line whose content changes wholesale whenever EITHER pane changes.
 *
 * The hard case this fixture pins is the one a merged bucket cannot express:
 * the right pane scrolls by one line-height WHILE the left pane is edited, in
 * the same state. Measured on this exact fixture (6 states), with the panes
 * merged into one bucket vs. discriminated into two regions:
 *
 *   merged   59.7% of glyphs paired, 1191 births / 1179 deaths, 62.7 KB
 *   regions  96.5% of glyphs paired,  102 births /   90 deaths, 28.3 KB
 *
 * ...against an uncompressed flipbook payload of 92.3 KB. The merged bucket
 * costs 37 points of pairing and 2.2x the composed bytes.
 *
 * Both the clipping-pane case (the panes are scroll containers) and the
 * non-clipping case (a plain two-column layout) are covered, because the
 * discriminator resolves them by two different rules.
 *
 * Every assertion about size is secondary to the one about pixels: the run is
 * rasterized at every state and held to the uncompressed flipbook of the very
 * same state through the shift-inclusive parity helper.
 */

const W = 900;
const H = 420;
const OUT_DIR = "tests/output/two-pane-regions-e2e";

/** The two-pane scene: a code editor left, a rendered preview right, their
 *  text lines on the SAME 19px grid. `paneOverflow` picks which discriminator
 *  rule has to fire — `hidden` makes each pane a clipping ancestor, `visible`
 *  leaves only the side-by-side column geometry to go on. */
const pageHtml = (paneOverflow: "hidden" | "visible"): string => String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0f172a; }
  .split { display: flex; height: ${H}px; }
  .pane { width: 450px; height: ${H}px; overflow: ${paneOverflow}; padding: 12px 0; }
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

interface Measured {
  trees: CapturedElement[][];
  holds: number[];
  boundaries: number[];
  rootBg: string | undefined;
  run: ReturnType<typeof composeCompressedRun>;
  regions: number;
  buckets: number;
}

/** Drive the scene through `steps` = [leftTypedChars, rightScrollLines] per
 *  state, capture each, and compose the run. */
async function measure(
  ctx: BrowserContext,
  paneOverflow: "hidden" | "visible",
  steps: Array<[number, number]>,
  idPrefix: string,
): Promise<Measured> {
  const page = await ctx.newPage();
  await page.setContent(pageHtml(paneOverflow), { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  const trees: CapturedElement[][] = [];
  for (const [k, off] of steps) {
    await page.evaluate((a: [number, number]) => {
      (window as unknown as { setLeft: (n: number) => void }).setLeft(a[0]);
      (window as unknown as { setRight: (n: number) => void }).setRight(a[1]);
    }, [k, off] as [number, number]);
    trees.push(await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H }));
  }
  await page.close();

  const holds = trees.map((_, i) => (i === trees.length - 1 ? 700 : 220));
  const boundaries = holds.map((_, i) => holds.slice(0, i).reduce((a, b) => a + b, 0));
  const rootBg = (trees[0][0]?.styles as { rootBgComputed?: string } | undefined)?.rootBgComputed;

  const plan = buildCompressedRunPlan(trees.map((tree, i) => ({ tree: structuredClone(tree), holdMs: holds[i] })), idPrefix);
  const regions = new Set(plan.thread.all.map((t) => t.rec.region)).size;
  const buckets = new Set(plan.thread.all.map((t) => t.rec.lineKey)).size;

  const run = composeCompressedRun(
    trees.map((tree, i) => ({ tree, holdMs: holds[i] })),
    { width: W, height: H, idPrefix, ...(rootBg != null ? { background: rootBg } : {}) },
  );
  return { trees, holds, boundaries, rootBg, run, regions, buckets };
}

/** Rasterize the compressed run and the uncompressed flipbook of the same
 *  states, and hold every state to pixel parity. */
async function assertFlipbookParity(ctx: BrowserContext, m: Measured, label: string): Promise<void> {
  const dir = join(OUT_DIR, label);
  mkdirSync(dir, { recursive: true });

  clearEmbeddedFonts();
  clearGlyphDefs();
  const flipbookSvg = generateAnimatedSvg({
    width: W, height: H,
    frames: m.trees.map((tree, i) => ({
      svgContent: elementTreeToSvgInner(structuredClone(tree), W, H, `f${i}-`, true, 2, false),
      duration: m.holds[i],
      transition: { type: "cut" as const, duration: 0 },
    })),
    fontFaceCss: getEmbeddedFontFaceCss(),
    ...(m.rootBg != null ? { background: m.rootBg } : {}),
  });
  const outerSvg = generateAnimatedSvg({
    width: W, height: H,
    frames: [{
      svgContent: namespaceEmbeddedAnimatedSvg(m.run.svg, `cmp_${label}`),
      duration: m.run.durationMs,
      embeddedAnimationPeriodMs: m.run.durationMs,
      transition: { type: "cut", duration: 0 },
    }],
    fontFaceCss: "",
  });
  writeFileSync(join(dir, "flipbook.svg"), flipbookSvg);
  writeFileSync(join(dir, "compressed.svg"), outerSvg);

  const flipPage = await ctx.newPage();
  await flipPage.setContent(`<!doctype html><html><body style="margin:0">${flipbookSvg}</body></html>`, { waitUntil: "domcontentloaded" });
  await flipPage.evaluate(() => document.fonts.ready);
  const compPage = await ctx.newPage();
  await compPage.setContent(`<!doctype html><html><body style="margin:0">${outerSvg}</body></html>`, { waitUntil: "domcontentloaded" });
  await compPage.evaluate(() => document.fonts.ready);
  const shot = async (p: Page, tMs: number): Promise<Buffer> => {
    await seekTo(p, tMs);
    return p.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  };
  const comparePage = await ctx.newPage();
  for (let s = 0; s < m.trees.length; s++) {
    const t = m.boundaries[s] + m.holds[s] / 2;
    const expPath = join(dir, `state-${s}-flipbook.png`);
    const actPath = join(dir, `state-${s}-compressed.png`);
    writeFileSync(expPath, await shot(flipPage, t));
    writeFileSync(actPath, await shot(compPage, t));
    const cmp = await comparePngs(comparePage, expPath, actPath, join(dir, `state-${s}-diff.png`));
    expectFlipbookParity(cmp, `${label} state ${s}: compressed render diverges from the uncompressed flipbook`);
  }
  await flipPage.close();
  await compPage.close();
  await comparePage.close();
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("two independently-updating regions in one compressed run (docs/100)", () => {
  it("clipping panes: the right pane scrolls while the left is edited, and each pane pairs on its own", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      // 6 states: two more characters typed into the editor's import line AND
      // the preview scrolled one more line, every state.
      const steps = Array.from({ length: 6 }, (_, s) => [s * 2, s] as [number, number]);
      const m = await measure(ctx, "hidden", steps, "tp0");
      const st = m.run.pairingStats;
      // eslint-disable-next-line no-console
      console.log(`[two-pane e2e clipping] regions=${m.regions} buckets=${m.buckets} paired=${(st.pairedPct * 100).toFixed(1)}% `
        + `births=${st.births} deaths=${st.deaths} groups=${st.groupCount} `
        + `raw=${(st.rawBytes / 1024).toFixed(1)}KB compressed=${(st.compressedBytes / 1024).toFixed(1)}KB (${(st.compressedBytes / st.rawBytes).toFixed(3)}x)`);

      // The two panes are two regions, and their lines never share a bucket:
      // 12 editor rows + 20 preview rows on the same 19px grid would collapse
      // to at most 20 buckets if the panes merged.
      expect(m.regions).toBe(2);
      expect(m.buckets).toBeGreaterThan(20);

      // Each pane pairs on its own timing. The preview's scroll is a pure
      // vertical move of already-painted lines (they ride a translateY), and
      // the editor's edit is a mid-line insert — so nearly everything pairs.
      // Merged into one bucket this measured 59.7%.
      expect(st.pairedPct).toBeGreaterThan(0.9);
      // Merged into one bucket this measured 1191 births / 1179 deaths: every
      // line of BOTH panes re-emitted, every state.
      expect(st.births).toBeLessThan(300);
      expect(st.deaths).toBeLessThan(300);
      // Real compression against the flipbook payload. Merged: 0.679x.
      expect(st.compressedBytes).toBeLessThan(0.4 * st.rawBytes);
      // The preview's scrolled lines rode a transform instead of dying.
      expect(m.run.svg).toMatch(/translate\([-\d.]+px,[-\d.]+px\)/);

      // ...and the whole point: identical pixels at every state.
      await assertFlipbookParity(ctx, m, "clipping");
    } finally {
      await ctx.close();
    }
  }, 300_000);

  it("non-clipping columns: side-by-side columns taller than one line box are regions too", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const steps = Array.from({ length: 6 }, (_, s) => [s * 2, s] as [number, number]);
      const m = await measure(ctx, "visible", steps, "tp1");
      const st = m.run.pairingStats;
      // eslint-disable-next-line no-console
      console.log(`[two-pane e2e non-clipping] regions=${m.regions} buckets=${m.buckets} paired=${(st.pairedPct * 100).toFixed(1)}% `
        + `births=${st.births} deaths=${st.deaths} groups=${st.groupCount} `
        + `raw=${(st.rawBytes / 1024).toFixed(1)}KB compressed=${(st.compressedBytes / 1024).toFixed(1)}KB (${(st.compressedBytes / st.rawBytes).toFixed(3)}x)`);

      // No clipping ancestor anywhere — the discriminator has only the
      // side-by-side column geometry to go on, and still separates the panes.
      // Merged into one bucket this same scene measured 59.7% paired and
      // 0.697x of the flipbook payload.
      expect(m.regions).toBe(2);
      expect(st.pairedPct).toBeGreaterThan(0.9);
      expect(st.compressedBytes).toBeLessThan(0.4 * st.rawBytes);

      await assertFlipbookParity(ctx, m, "non-clipping");
    } finally {
      await ctx.close();
    }
  }, 300_000);
});
