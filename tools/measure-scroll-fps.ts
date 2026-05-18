/**
 * Headless fps + frame-cost probe for scroll-composer SVGs.
 *
 * Loads each SVG in a Chromium page (wrapped in a minimal HTML host so the
 * @keyframes animation runs as it would in a normal browser tab), then
 * samples `requestAnimationFrame` timestamps for one or more full
 * animation cycles. Output:
 *   - mean fps + median / p95 / p99 frame-duration over the whole sample
 *   - per-segment fps + p95 frame-ms (the cycle is split into `--segments`
 *     equal-time buckets so you can see which part of the scroll is slow)
 *   - LongAnimationFrame (LoAF) summary — count, mean / p95 / longest
 *     duration. LoAF flags any frame whose work exceeded 50 ms and breaks
 *     it down into render / blocking / scripting cost. This is the
 *     cause-attribution signal the Performance panel exposes more
 *     visually.
 *
 * Usage:
 *   npx tsx tools/measure-scroll-fps.ts <file1.svg> [file2.svg ...] \
 *     [--cycle-ms 12000] [--segments 8] [--cycles 2] [--warmup-ms 1000]
 */

import { chromium, webkit, firefox, type BrowserType } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

type BrowserName = "chromium" | "webkit" | "firefox";

interface ProbeOptions {
  cycleMs: number;
  segments: number;
  cycles: number;
  warmupMs: number;
  headless: boolean;
  browser: BrowserName;
}

function browserType(name: BrowserName): BrowserType {
  switch (name) {
    case "chromium": return chromium;
    case "webkit":   return webkit;
    case "firefox":  return firefox;
  }
}

interface SegmentStat {
  idx: number;
  frames: number;
  meanFps: number;
  p95Ms: number;
}

interface Stats {
  file: string;
  totalFrames: number;
  windowMs: number;
  meanFps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  perSegment: SegmentStat[];
  loafCount: number;
  loafMeanMs: number;
  loafP95Ms: number;
  loafLongestMs: number;
  loafLongestPhase: string;
}

interface PerfBuffer {
  frames: number[];
  loaf: Array<{
    startTime: number;
    duration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    blockingDuration: number;
  }>;
  start: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

async function measure(svgPath: string, opts: ProbeOptions): Promise<Stats> {
  const svgText = readFileSync(svgPath, "utf-8").replace(/^<\?xml[^>]*\?>\s*/, "");

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>
</head><body>
${svgText}
<script>
  window.__perf = { frames: [], loaf: [], start: 0 };
  function onFrame(t) {
    window.__perf.frames.push(t);
    requestAnimationFrame(onFrame);
  }
  requestAnimationFrame(function(t) {
    window.__perf.start = t;
    onFrame(t);
  });
  try {
    var po = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        window.__perf.loaf.push({
          startTime: e.startTime,
          duration: e.duration,
          renderStart: e.renderStart,
          styleAndLayoutStart: e.styleAndLayoutStart,
          blockingDuration: e.blockingDuration,
        });
      }
    });
    po.observe({ type: "long-animation-frame", buffered: true });
  } catch (e) { /* LoAF unavailable */ }
<\/script>
</body></html>`;

  const browser = await browserType(opts.browser).launch({ headless: opts.headless });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });

  const sampleMs = opts.warmupMs + opts.cycleMs * opts.cycles + 200;
  await page.waitForTimeout(sampleMs);

  const raw = (await page.evaluate(() => (window as unknown as { __perf: PerfBuffer }).__perf)) as PerfBuffer;
  await ctx.close();
  await browser.close();

  const cycleStart = raw.start + opts.warmupMs;
  const cycleEnd = cycleStart + opts.cycleMs * opts.cycles;
  const windowFrames = raw.frames.filter((t) => t >= cycleStart && t <= cycleEnd).sort((a, b) => a - b);

  const deltas: number[] = [];
  for (let i = 1; i < windowFrames.length; i++) deltas.push(windowFrames[i] - windowFrames[i - 1]);
  const sortedDeltas = [...deltas].sort((a, b) => a - b);

  const windowMs = cycleEnd - cycleStart;
  const meanFps = (windowFrames.length / windowMs) * 1000;

  const perSegment: SegmentStat[] = [];
  const segMs = opts.cycleMs / opts.segments;
  for (let s = 0; s < opts.segments; s++) {
    const segFrames = windowFrames.filter((t) => {
      const phase = (t - cycleStart) % opts.cycleMs;
      return Math.floor(phase / segMs) === s;
    });
    const segDeltas: number[] = [];
    for (let i = 1; i < segFrames.length; i++) segDeltas.push(segFrames[i] - segFrames[i - 1]);
    const segSorted = [...segDeltas].sort((a, b) => a - b);
    const segTotalMs = segMs * opts.cycles;
    perSegment.push({
      idx: s,
      frames: segFrames.length,
      meanFps: (segFrames.length / segTotalMs) * 1000,
      p95Ms: quantile(segSorted, 0.95),
    });
  }

  const loafDurations = raw.loaf.map((e) => e.duration).sort((a, b) => a - b);
  const loafLongest = raw.loaf.reduce<PerfBuffer["loaf"][number] | null>(
    (best, e) => (best === null || e.duration > best.duration ? e : best),
    null,
  );
  let loafLongestPhase = "n/a";
  if (loafLongest !== null) {
    const render = loafLongest.duration - (loafLongest.renderStart - loafLongest.startTime);
    const style = loafLongest.renderStart > 0 ? loafLongest.duration - (loafLongest.styleAndLayoutStart - loafLongest.startTime) : 0;
    const blocking = loafLongest.blockingDuration;
    loafLongestPhase = `render≈${render.toFixed(0)}ms style+layout≈${style.toFixed(0)}ms blocking=${blocking.toFixed(0)}ms`;
  }

  return {
    file: basename(svgPath),
    totalFrames: windowFrames.length,
    windowMs,
    meanFps,
    medianFrameMs: quantile(sortedDeltas, 0.5),
    p95FrameMs: quantile(sortedDeltas, 0.95),
    p99FrameMs: quantile(sortedDeltas, 0.99),
    perSegment,
    loafCount: raw.loaf.length,
    loafMeanMs: loafDurations.length ? loafDurations.reduce((a, b) => a + b, 0) / loafDurations.length : 0,
    loafP95Ms: quantile(loafDurations, 0.95),
    loafLongestMs: loafDurations.length ? loafDurations[loafDurations.length - 1] : 0,
    loafLongestPhase,
  };
}

function fmtFps(n: number): string { return `${n.toFixed(1).padStart(5)} fps`; }
function fmtMs(n: number): string { return `${n.toFixed(1).padStart(6)} ms`; }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const numArg = (flag: string, dflt: number): number => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number(args[i + 1]) : dflt;
  };
  const strArg = (flag: string, dflt: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const browserName = strArg("--browser", "chromium") as BrowserName;
  if (browserName !== "chromium" && browserName !== "webkit" && browserName !== "firefox") {
    console.error(`Invalid --browser '${browserName}'. Use chromium | webkit | firefox.`);
    process.exit(1);
  }
  const opts: ProbeOptions = {
    cycleMs: numArg("--cycle-ms", 12000),
    segments: numArg("--segments", 8),
    cycles: numArg("--cycles", 2),
    warmupMs: numArg("--warmup-ms", 1000),
    headless: args.includes("--headless"),
    browser: browserName,
  };

  const files = args.filter((a) => a.endsWith(".svg"));
  if (files.length === 0) {
    console.error("Usage: tools/measure-scroll-fps.ts <file1.svg> [file2.svg ...] [--browser chromium|webkit|firefox] [--cycle-ms N] [--segments N] [--cycles N] [--warmup-ms N]");
    process.exit(1);
  }
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`Not found: ${f}`);
      process.exit(1);
    }
  }
  console.error(`Settings: browser=${opts.browser}, cycle=${opts.cycleMs}ms, segments=${opts.segments}, cycles=${opts.cycles}, warmup=${opts.warmupMs}ms, headless=${opts.headless}`);
  if (opts.headless) {
    console.error("Note: headless rendering uses a software compositor that won't reflect real-browser GPU paint cost. Pass without --headless for representative numbers.");
  }
  if (opts.browser === "webkit") {
    console.error("Note: WebKit's PerformanceObserver does not support 'long-animation-frame' as of 2026-05; expect loafCount=0. Per-segment fps + frame-ms quantiles are still meaningful.");
  }

  const results: Stats[] = [];
  for (const f of files) {
    console.error(`Measuring ${basename(f)} (${(opts.warmupMs + opts.cycleMs * opts.cycles) / 1000}s sample) ...`);
    const s = await measure(resolve(f), opts);
    results.push(s);
  }

  for (const r of results) {
    console.log(`\n${"━".repeat(78)}`);
    console.log(`  ${r.file}`);
    console.log(`${"━".repeat(78)}`);
    console.log(`  window: ${(r.windowMs / 1000).toFixed(1)}s   frames: ${r.totalFrames}   mean: ${r.meanFps.toFixed(1)} fps`);
    console.log(`  frame-ms  median ${r.medianFrameMs.toFixed(2)}   p95 ${r.p95FrameMs.toFixed(2)}   p99 ${r.p99FrameMs.toFixed(2)}`);
    console.log(`  per-segment:`);
    for (const s of r.perSegment) {
      const bar = "█".repeat(Math.max(0, Math.round(s.meanFps / 4)));
      console.log(`    seg ${s.idx}  ${fmtFps(s.meanFps)}  p95 ${fmtMs(s.p95Ms)}  (${s.frames} frames)  ${bar}`);
    }
    console.log(`  long-animation-frames (>50ms): ${r.loafCount}`);
    if (r.loafCount > 0) {
      console.log(`    mean ${r.loafMeanMs.toFixed(1)}ms   p95 ${r.loafP95Ms.toFixed(1)}ms   longest ${r.loafLongestMs.toFixed(1)}ms`);
      console.log(`    longest frame attribution: ${r.loafLongestPhase}`);
    }
  }

  if (results.length >= 2) {
    console.log(`\n${"━".repeat(78)}`);
    console.log(`  Side-by-side per-segment fps`);
    console.log(`${"━".repeat(78)}`);
    const header = `  seg | ` + results.map((r) => r.file.replace(/^apple-desktop-scroll-/, "").replace(/\.svg$/, "").padStart(8)).join(" | ");
    console.log(header);
    for (let s = 0; s < results[0].perSegment.length; s++) {
      const cells = results.map((r) => r.perSegment[s].meanFps.toFixed(1).padStart(8));
      console.log(`  ${String(s).padStart(3)} | ${cells.join(" | ")}`);
    }
    const overall = results.map((r) => r.meanFps.toFixed(1).padStart(8));
    console.log(`  all | ${overall.join(" | ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
