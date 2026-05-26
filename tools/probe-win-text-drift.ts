// DM-884 diagnostic: locate the source of the Windows primary-font (Arial)
// text-positioning drift seen in the feature regression.
//
// Runs Domotion's real capture on the `text-center` fixture, then compares —
// per text segment — the CAPTURED per-char x offsets and baseline against the
// positions Chromium ACTUALLY painted (measured with a per-char Range). The
// delta pattern says which layer drifts:
//   - captured xOffsets absent           → renderer sums fontkit advances (drift)
//   - captured xOffsets != painted x      → capture is unfaithful
//   - captured xOffsets == painted x      → drift is render-side or vertical
//
// Run on the Windows runner via `npx tsx tools/probe-win-text-drift.ts`.

import { captureElementTree, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/index.js";

const WIDTH = 480;
const HEIGHT = 320;

// The exact text-center feature fixture body.
const BODY =
  `<div style="width: 400px; text-align: center; padding: 40px 20px; color: #e6edf3; font-family: -apple-system, sans-serif;">` +
  `<div id="title" style="font-size: 28px; font-weight: 800;">Centered Title</div>` +
  `<div id="subtitle" style="font-size: 14px; color: #8b949e; margin-top: 8px;">Centered subtitle text</div>` +
  `</div>`;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0d1117}</style></head><body>${BODY}</body></html>`;

function r(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function collectSegments(nodes: CapturedElement[], out: CapturedElement[]): void {
  for (const n of nodes) {
    if ((n as { textSegments?: unknown[] }).textSegments != null || (n as { text?: string }).text) out.push(n);
    const kids = (n as { children?: CapturedElement[] }).children;
    if (kids) collectSegments(kids, out);
  }
}

async function main(): Promise<void> {
  const browser = await launchChromium();
  const page = await browser.newPage();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.setContent(HTML, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  // Chromium's actual painted per-char left-x + baseline for #title / #subtitle.
  // Body passed as a string to dodge tsx/esbuild's `__name` helper injection.
  const painted = (await page.evaluate(`(() => {
    var out = {};
    var ids = ["title", "subtitle"];
    for (var k = 0; k < ids.length; k++) {
      var el = document.getElementById(ids[k]);
      if (!el || !el.firstChild) { out[ids[k]] = null; continue; }
      var node = el.firstChild;
      var text = node.textContent || "";
      var xs = [];
      for (var i = 0; i < text.length; i++) {
        var range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        xs.push(Math.round(range.getBoundingClientRect().left * 100) / 100);
      }
      var box = el.getBoundingClientRect();
      out[ids[k]] = { text: text, charLeftX: xs, top: Math.round(box.top * 100) / 100, bottom: Math.round(box.bottom * 100) / 100 };
    }
    return out;
  })()`)) as Record<string, { text: string; charLeftX: number[]; top: number; bottom: number } | null>;

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const segs: CapturedElement[] = [];
  collectSegments(tree, segs);

  console.log("=== captured text segments ===");
  for (const el of segs) {
    const tss = (el as { textSegments?: Array<{ text: string; x: number; y: number; width: number; xOffsets?: number[] }> }).textSegments;
    if (!tss) continue;
    for (const s of tss) {
      console.log(
        `seg "${s.text}"  x=${r(s.x)} y=${r(s.y)} w=${r(s.width)}  xOffsets=${s.xOffsets ? `[n=${s.xOffsets.length}] ${s.xOffsets.map(r).join(",")}` : "ABSENT"}`,
      );
    }
  }

  for (const which of ["title", "subtitle"] as const) {
    const p = painted[which];
    if (!p) continue;
    console.log(`\n=== ${which}: Chromium painted "${p.text}" ===`);
    console.log(`  painted top=${p.top} bottom=${p.bottom}`);
    console.log(`  painted per-char left-x: ${p.charLeftX.join(",")}`);
    // Find the matching captured segment and diff.
    let captured: { x: number; y: number; xOffsets?: number[] } | undefined;
    for (const el of segs) {
      const tss = (el as { textSegments?: Array<{ text: string; x: number; y: number; xOffsets?: number[] }> }).textSegments;
      const match = tss?.find((s) => s.text === p.text);
      if (match) { captured = match; break; }
    }
    if (!captured) { console.log("  (no matching captured segment)"); continue; }
    console.log(`  captured seg y=${r(captured.y)}  xOffsets ${captured.xOffsets ? "present" : "ABSENT"}`);
    if (captured.xOffsets) {
      const deltas = captured.xOffsets.map((xo, i) => Math.round((xo - p.charLeftX[i]) * 100) / 100);
      console.log(`  Δ(captured − painted) per char: ${deltas.join(",")}`);
      console.log(`  max |Δ| = ${Math.max(...deltas.map(Math.abs))}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
