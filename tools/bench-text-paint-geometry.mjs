// Benchmark for the batched text-paint-geometry CDP probe.
//
// Validates the "batch text geometry probes" change: prepareTextPaintGeometry
// (src/capture/text-paint-geometry-cdp.ts, run from captureElementTree) measures
// every text row in three settled phases, issuing four awaited CDP commands per
// row. Before the change those chains ran strictly serially; the change runs at
// most BENCH_CONCURRENCY (16) independent row chains within each phase. This
// script captures a fixture with ~193 text rows repeatedly and reports the
// median wall time of captureElementTree(), whose probe phase is the code path
// under test.
//
// Faithful-benchmark rules (ticket acceptance):
//   - uninstrumented: do NOT set NODE_V8_COVERAGE or any profiler;
//   - browser tracing DISABLED: this script never enables Tracing/Profiler;
//   - native x64 ONLY: arm64 / qemu wall time is not accepted evidence, so the
//     workflow that drives this pins an x64 (ubuntu-latest) runner and this
//     script records process.arch for the record.
//
// Run: `node tools/bench-text-paint-geometry.mjs` after `npm run build`.
// Env overrides: BENCH_ROWS (193), BENCH_REPS (9), BENCH_WARMUP (2).
import { chromium } from "@playwright/test";
import { captureElementTree } from "../dist/capture/index.js";

const ROWS = Number(process.env.BENCH_ROWS ?? 193);
const REPS = Number(process.env.BENCH_REPS ?? 9);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
const WIDTH = 900;
const ROW_H = 23;
const HEIGHT = ROWS * ROW_H + 80;

// One distinct single-line text node per row → ROWS text-paint rows, mirroring
// the exact counter-template probe's many-independent-rows shape without pulling
// in the animator (so the same script builds and runs identically on the
// before/after refs, where only src/capture changed).
const lines = Array.from({ length: ROWS }, (_, i) =>
  `<div class="r">Row ${i} — the quick brown fox jumps over 0123456789</div>`,
).join("");
const html =
  `<!doctype html><meta charset="utf8"><style>` +
  `*{margin:0;padding:0;box-sizing:border-box}` +
  `body{font:16px/${ROW_H}px sans-serif;color:#111}` +
  `.r{white-space:nowrap;height:${ROW_H}px}` +
  `</style><body>${lines}</body>`;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });

  const clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const once = async () => {
    const t = performance.now();
    await captureElementTree(page, "body", clip);
    return performance.now() - t;
  };

  for (let i = 0; i < WARMUP; i++) await once();
  const times = [];
  for (let i = 0; i < REPS; i++) times.push(await once());
  times.sort((a, b) => a - b);

  const median = times[Math.floor(times.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const out = {
    arch: process.arch,
    platform: process.platform,
    node: process.version,
    rows: ROWS,
    reps: REPS,
    warmup: WARMUP,
    medianMs: +median.toFixed(1),
    minMs: +times[0].toFixed(1),
    maxMs: +times[times.length - 1].toFixed(1),
    meanMs: +mean.toFixed(1),
    timesMs: times.map((t) => +t.toFixed(1)),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
} finally {
  await browser.close();
}
