import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs, getEmbeddedFontFaceCss } from "../src/render/index.js";
import { generateAnimatedSvg, namespaceEmbeddedAnimatedSvg, composeCompressedRun } from "../src/animation/index.js";
import type { CapturedElement, TextSegment } from "../src/capture/types.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { comparePngs } from "../src/review/compare-pngs.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Frame-sequence compressor e2e (docs/100, Primitive 1) — the
// verify-the-rendered-SVG rule: capture a real editor-like page one keystroke
// per state (a mid-line insert that reflows the tail, then a
// colorize-on-completion state), compress the run, embed it as one outer
// animate frame (the embeddedAnimationPeriodMs path), RASTERIZE the actual
// composed SVG at every state (pause + seek), and assert against the
// uncompressed flipbook of the very same states — the ground truth:
//   1. pixel parity with the flipbook at every sampled state;
//   2. the tail genuinely shifted per typed state (ink positions);
//   3. the prefix pixels byte-stable across states;
//   4. the recolor lands as an in-place color change;
//   5. a real measured size reduction (< 60% of the flipbook payload).

const W = 760;
const H = 560;
const INS = " computed,";
const OUT_DIR = "tests/output/compressed-run-e2e";

// Editor page modeled on the kerf getting-started capture (the doc-100 probe
// page): Menlo 12.5px / 19px lines, 40px gutter, syntax-colored spans. NO
// page-side caret span — the compressor's auto-caret replaces that workaround.
const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
    font-family: system-ui, sans-serif; background: #e8eaee; position: relative; }
  .window { position: absolute; top: 18px; left: 18px; width: 724px; height: 524px;
    border-radius: 10px; overflow: hidden; background: #1e293b; display: flex; flex-direction: column;
    box-shadow: 0 12px 40px rgba(15,23,42,0.35); }
  .titlebar { height: 34px; flex: none; background: #0f172a; display:flex; align-items:center;
    padding: 0 12px; font-size: 12px; color: #94a3b8; }
  .codearea { flex: 1; padding: 10px 0; font-family: Menlo, ui-monospace, monospace;
    font-size: 12.5px; line-height: 19px; color: #e2e8f0; overflow: hidden; }
  .ln { display: flex; white-space: pre; height: 19px; }
  .ln .no { width: 40px; flex: none; text-align: right; padding-right: 14px; color: #475569; }
  .kw { color: #93c5fd; } .str { color: #86efac; } .num { color: #fbbf24; }
  .hole { color: #fbbf24; }
</style></head><body>
  <div class="window"><div class="titlebar">app.tsx — probe</div><div class="codearea" id="code"></div></div>
<script>
  const K = (s) => '<span class="kw">' + s + '</span>';
  const S_ = (s) => '<span class="str">' + s + '</span>';
  const N = (s) => '<span class="num">' + s + '</span>';
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const L3 = K('const') + ' count = signal(' + N('0') + ');';
  const L4 = K('const') + " root = document.getElementById(" + S_("'app'") + ")!;";
  const L6 = 'mount(root, () ' + K('=>') + ' (';
  const L12 = 'delegate(root, ' + S_("'click'") + ', ' + S_('\'[data-action="inc"]\'') + ', () ' + K('=>') + ' count.value++);';
  const INS = ' computed,';
  function render(rows) {
    document.getElementById('code').innerHTML = rows.map((html, i) =>
      '<div class="ln"><span class="no">' + (i + 1) + '</span><span>' + html + '</span></div>').join('');
  }
  window.ins = (k) => {
    const typed = esc(INS.slice(0, k));
    const row1 = K('import') + ' { signal,' + typed + ' mount, delegate } ' + K('from') + ' ' + S_("'kerfjs'") + ';';
    render([row1, '', L3, L4, '', L6, '', '', '', '', '', L12]);
  };
  window.colorized = () => {
    const row1 = K('import') + ' ' + '<span class="hole">{</span> signal, computed, mount, delegate <span class="hole">}</span> ' +
      K('from') + ' ' + S_("'kerfjs'") + ';';
    render([row1, '', L3, L4, '', L6, '', '', '', '', '', L12]);
  };
  window.ins(0);
</script></body></html>`;

/** Scan a screenshot region for pixels matching a predicate; absolute coords. */
async function scanRegion(
  page: Page,
  png: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  mode: "light" | "amber",
): Promise<{ minX: number; maxX: number; count: number }> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (args: { dataUri: string; rect: { x: number; y: number; w: number; h: number }; mode: string }) => {
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
    const { x, y, w, h } = args.rect;
    const d = ctx.getImageData(x, y, w, h).data;
    let minX = Infinity, maxX = -Infinity, count = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        // light: the editor's default #e2e8f0 body text on the dark window.
        // amber: the colorize state's #fbbf24 "hole" tokens.
        const hit = args.mode === "light"
          ? r > 170 && g > 170 && b > 170
          : r > 200 && g > 150 && g < 220 && b < 100;
        if (hit) {
          if (x + px < minX) minX = x + px;
          if (x + px > maxX) maxX = x + px;
          count++;
        }
      }
    }
    return { minX, maxX, count };
  }, { dataUri, rect, mode });
}

/** Raw RGBA bytes of a screenshot region (prefix byte-stability checks). */
async function regionPixels(page: Page, png: Buffer, rect: { x: number; y: number; w: number; h: number }): Promise<string> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (args: { dataUri: string; rect: { x: number; y: number; w: number; h: number } }) => {
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
    const { x, y, w, h } = args.rect;
    const d = ctx.getImageData(x, y, w, h).data;
    // FNV-1a over the raw bytes — a full-array compare in string form.
    let hash = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) {
      hash ^= d[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return `${w}x${h}:${(hash >>> 0).toString(16)}`;
  }, { dataUri, rect });
}

/** Find text segments in a captured tree matching a predicate. */
function findSegments(tree: CapturedElement[], pred: (seg: TextSegment, el: CapturedElement) => boolean): Array<{ seg: TextSegment; el: CapturedElement }> {
  const out: Array<{ seg: TextSegment; el: CapturedElement }> = [];
  const walk = (el: CapturedElement): void => {
    for (const seg of el.textSegments ?? []) {
      if (pred(seg, el)) out.push({ seg, el });
    }
    el.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
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

describeBrowser("frame-sequence compressor e2e (docs/100 Primitive 1)", () => {
  it("compressed run matches the uncompressed flipbook pixel-wise at every state, with real size reduction", async () => {
    const { browser } = env!;
    mkdirSync(OUT_DIR, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(PAGE, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);

      // ── Capture the per-keystroke states + the colorize state ────────────
      const trees: CapturedElement[][] = [];
      const capture = async (): Promise<void> => {
        trees.push(await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H }));
      };
      await capture(); // s0: before the insert
      for (let k = 1; k <= INS.length; k++) {
        await page.evaluate((kk: number) => (window as unknown as { ins: (k: number) => void }).ins(kk), k);
        await capture();
      }
      await page.evaluate(() => (window as unknown as { colorized: () => void }).colorized());
      await capture(); // colorize-on-completion
      const N = trees.length;
      expect(N).toBe(INS.length + 2);
      const HOLD = 170;
      const TAIL = 900;
      const holds = trees.map((_, i) => (i === N - 1 ? TAIL : HOLD));
      const boundaries = holds.map((_, i) => holds.slice(0, i).reduce((a, b) => a + b, 0));
      const rootBg = (trees[0][0]?.styles as { rootBgComputed?: string } | undefined)?.rootBgComputed;

      // ── Ground truth: the uncompressed continue+cut flipbook ─────────────
      clearEmbeddedFonts();
      clearGlyphDefs();
      const frames = trees.map((tree, i) => ({
        svgContent: elementTreeToSvgInner(structuredClone(tree), W, H, `f${i}-`, true, 2, false),
        duration: holds[i],
        transition: { type: "cut" as const, duration: 0 },
      }));
      const flipbookSvg = generateAnimatedSvg({
        width: W, height: H, frames,
        fontFaceCss: getEmbeddedFontFaceCss(),
        ...(rootBg != null ? { background: rootBg } : {}),
      });

      // ── The compressed run, embedded through the outer-frame path ────────
      const logs: string[] = [];
      const run = composeCompressedRun(
        trees.map((tree, i) => ({ tree, holdMs: holds[i] })),
        { width: W, height: H, idPrefix: "cr0", background: rootBg, log: (m) => logs.push(m) },
      );
      expect(run.durationMs).toBe(holds.reduce((a, b) => a + b, 0));
      const embedded = namespaceEmbeddedAnimatedSvg(run.svg, "cmp0");
      const outerSvg = generateAnimatedSvg({
        width: W, height: H,
        frames: [{
          svgContent: embedded,
          duration: run.durationMs,
          embeddedAnimationPeriodMs: run.durationMs,
          transition: { type: "cut", duration: 0 },
        }],
        fontFaceCss: "",
      });
      writeFileSync(join(OUT_DIR, "flipbook.svg"), flipbookSvg);
      writeFileSync(join(OUT_DIR, "compressed.svg"), outerSvg);

      // ── Pairing + size: the run must have really compressed ──────────────
      const stats = run.pairingStats;
      // eslint-disable-next-line no-console
      console.log(`[compressed-run e2e] ${logs[0] ?? ""} | groups=${stats.groupCount} chromeTracks=${stats.chromeTrackCount} recolored=${stats.recolored}`);
      expect(stats.pairedPct).toBeGreaterThan(0.85);
      expect(stats.compressedBytes).toBeLessThan(0.6 * stats.rawBytes);
      // The full documents (with the shared font block) shrink too.
      expect(outerSvg.length).toBeLessThan(flipbookSvg.length);

      // ── Rasterize BOTH SVGs at every state (pause + seek) ────────────────
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
      const flipShots: Buffer[] = [];
      const compShots: Buffer[] = [];
      for (let s = 0; s < N; s++) {
        const t = boundaries[s] + holds[s] / 2;
        flipShots.push(await shot(flipPage, t));
        compShots.push(await shot(compPage, t));
      }

      // ── (1) Pixel parity vs the ground-truth flipbook at every state ─────
      const comparePage = await ctx.newPage();
      for (let s = 0; s < N; s++) {
        const expPath = join(OUT_DIR, `state-${s}-flipbook.png`);
        const actPath = join(OUT_DIR, `state-${s}-compressed.png`);
        writeFileSync(expPath, flipShots[s]);
        writeFileSync(actPath, compShots[s]);
        const cmp = await comparePngs(comparePage, expPath, actPath, join(OUT_DIR, `state-${s}-diff.png`));
        expect(cmp.regionCount, `state ${s}: compressed render diverges from the uncompressed flipbook`).toBe(0);
      }

      // ── Geometry from the pairing itself ─────────────────────────────────
      // First edit: the first typed char of INS, mid-line. Its x locates the
      // insertion point; the import line's top locates the strip to scan.
      expect(run.edits.length).toBeGreaterThanOrEqual(INS.length);
      const firstEdit = run.edits[0];
      const lineStrip = { x: 58, y: Math.floor(firstEdit.lineTop) - 1, w: W - 60 - 18, h: 21 };
      const insertX = firstEdit.x - firstEdit.cellWidth;

      // ── (2) The tail genuinely shifted per typed state ───────────────────
      const rightEdge: number[] = [];
      for (let s = 0; s <= INS.length; s++) {
        const ink = await scanRegion(compPage, compShots[s], lineStrip, "light");
        expect(ink.count).toBeGreaterThan(50);
        rightEdge.push(ink.maxX);
      }
      for (let s = 1; s <= INS.length; s++) {
        const delta = rightEdge[s] - rightEdge[s - 1];
        expect(delta, `state ${s}: the tail should shift right by one Menlo advance`).toBeGreaterThanOrEqual(5);
        expect(delta, `state ${s}: the tail should shift by ONE advance, not more`).toBeLessThanOrEqual(11);
      }

      // ── (3) Prefix pixels byte-stable across every typed state ───────────
      const prefixRect = { x: lineStrip.x, y: lineStrip.y, w: Math.floor(insertX) - 2 - lineStrip.x, h: lineStrip.h };
      expect(prefixRect.w).toBeGreaterThan(60);
      const prefixHashes: string[] = [];
      for (let s = 0; s <= INS.length; s++) {
        prefixHashes.push(await regionPixels(compPage, compShots[s], prefixRect));
      }
      for (let s = 1; s <= INS.length; s++) {
        expect(prefixHashes[s], `state ${s}: prefix pixels must be byte-stable`).toBe(prefixHashes[0]);
      }

      // ── (4) The recolor lands as an in-place color change ────────────────
      // colorized() re-tokenizes the import line: '{' / '}' turn amber
      // (#fbbf24) at unchanged painted positions.
      const amberSegs = findSegments(trees[N - 1], (seg, el) => (seg.color ?? el.styles.color) === "rgb(251, 191, 36)" && Math.abs(seg.y - firstEdit.lineTop) < 2);
      expect(amberSegs.length).toBeGreaterThanOrEqual(2); // '{' and '}'
      const braceX = Math.min(...amberSegs.map((s) => s.seg.x));
      const beforeColorize = await scanRegion(compPage, compShots[N - 2], lineStrip, "amber");
      const afterColorize = await scanRegion(compPage, compShots[N - 1], lineStrip, "amber");
      expect(beforeColorize.count).toBe(0);
      expect(afterColorize.count).toBeGreaterThan(5);
      expect(Math.abs(afterColorize.minX - braceX)).toBeLessThanOrEqual(2);
      // ...and the glyphs did NOT move: the light ink's right edge is unchanged.
      const lightAfter = await scanRegion(compPage, compShots[N - 1], lineStrip, "light");
      expect(Math.abs(lightAfter.maxX - rightEdge[INS.length])).toBeLessThanOrEqual(1);

      // ── Auto-caret variant: opt-in emits the docs/101 track ──────────────
      const runWithCaret = composeCompressedRun(
        trees.map((tree, i) => ({ tree, holdMs: holds[i] })),
        { width: W, height: H, idPrefix: "cr1", background: rootBg, caret: true },
      );
      expect(runWithCaret.svg).toContain('class="text-track"');
      expect(run.svg).not.toContain('class="text-track"');
    } finally {
      await ctx.close();
    }
  }, 300_000);

  it("behind-glyph selection: the selection rect paints BEHIND the glyph ink (docs/101 true editor z-order)", async () => {
    // A minimal white-on-dark monospace line, selected over the middle chars
    // with an OPAQUE red selection. Behind-glyph z-order is decisive: the glyph
    // ink must still show through (white pixels survive inside the rect) AND the
    // red rect must be present in the gaps. If the rect painted ABOVE (the
    // standalone-overlay z-order), the opaque red would cover the glyphs and no
    // white pixel would survive.
    const { browser } = env!;
    const SW = 320, SH = 120;
    const SELPAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; width: ${SW}px; height: ${SH}px; background: #101820; }
      #line { position: absolute; left: 20px; top: 40px; color: #ffffff;
        font-family: Menlo, ui-monospace, monospace; font-size: 24px; white-space: pre; }
    </style></head><body><div id="line">ABCDEFGHIJ</div></body></html>`;
    const ctx = await browser.newContext({ viewport: { width: SW, height: SH }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(SELPAGE, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: SW, height: SH });

      // Select chars 3..6 ("DEF") with an opaque red, over a one-state run.
      const run = composeCompressedRun([{ tree, holdMs: 500 }], {
        width: SW, height: SH, idPrefix: "sel0", background: "rgb(16, 24, 32)",
        selection: { target: { match: (el) => el.text === "ABCDEFGHIJ" }, charStart: 3, charEnd: 6, color: "rgb(220, 0, 0)" },
      });
      expect(run.svg).toContain('class="tt-sel"');
      // Structural z-order: the rect precedes the glyph <text>.
      expect(run.svg.indexOf("tt-sel")).toBeLessThan(run.svg.indexOf("<text"));

      const embedded = namespaceEmbeddedAnimatedSvg(run.svg, "selcmp");
      const outerSvg = generateAnimatedSvg({
        width: SW, height: SH,
        frames: [{ svgContent: embedded, duration: run.durationMs, embeddedAnimationPeriodMs: run.durationMs, transition: { type: "cut", duration: 0 } }],
        fontFaceCss: "",
      });
      const view = await ctx.newPage();
      await view.setContent(`<!doctype html><html><body style="margin:0">${outerSvg}</body></html>`, { waitUntil: "domcontentloaded" });
      await view.evaluate(() => document.fonts.ready);
      await seekTo(view, 250);
      const png = await view.screenshot({ clip: { x: 0, y: 0, width: SW, height: SH } });

      // Scan the selection rect band (row ~40..75, x ~ the D..F cells) for
      // white glyph ink and opaque-red selection pixels.
      const dataUri = `data:image/png;base64,${png.toString("base64")}`;
      const counts = await view.evaluate(async (uri: string) => {
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("decode")); img.src = uri; });
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const cx = canvas.getContext("2d")!;
        cx.drawImage(img, 0, 0);
        // The 24px Menlo cell is ~14.4px wide; "DEF" starts ~char 3 → x ≈ 20 + 3·14.4.
        const d = cx.getImageData(60, 40, 50, 34).data;
        let white = 0, red = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 200 && g > 200 && b > 200) white++;
          else if (r > 150 && g < 90 && b < 90) red++;
        }
        return { white, red };
      }, dataUri);
      // Both present → the glyphs show through a rect painted behind them.
      expect(counts.red, "no selection-red pixels found in the rect band").toBeGreaterThan(20);
      expect(counts.white, "no glyph ink survived — the selection painted OVER the glyphs, not behind").toBeGreaterThan(20);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
