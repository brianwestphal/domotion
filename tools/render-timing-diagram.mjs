// DM-1029: render the per-step timing trace (written by the html-test-suite
// when DEMO_TIMING=1) into an annotated SVG that shows where time goes in a
// single demo-test run AND what the suite does in parallel vs serial.
//
// Usage:
//   DEMO_TIMING=1 HTML_TEST_DIR=<dir> HTML_TEST_OUTPUT_DIR=<out> \
//     npx tsx tests/html-test-suite.tsx           # writes <out>/timing.json
//   node tools/render-timing-diagram.mjs <out>/timing.json [diagram.svg]
//
// The instrumentation lives permanently in tests/html-test-suite.tsx so the
// numbers stay reproducible as we optimize the pipeline. Re-run both commands
// after a change to re-measure.

import { readFileSync, writeFileSync } from "node:fs";

const inPath = process.argv[2] ?? "tests/output/html-test-unicode/timing.json";
const outPath = process.argv[3] ?? inPath.replace(/timing\.json$/, "timing-diagram.svg").replace(/\.json$/, ".svg");
const data = JSON.parse(readFileSync(inPath, "utf-8"));

// ── aggregate per-step mean / min / max across all sampled fixtures ──
const STEP_ORDER = [
  "viewport", "cache-check", "goto-source", "settle-source", "read-bodyBg",
  "screenshot-expected", "discover-webfonts", "capture-tree", "cache-write",
  "embed-remote-images", "rasterize-conic", "render-svg", "goto-svg",
  "settle-svg", "screenshot-actual", "compare-pngs",
];
// Which pipeline phase each step belongs to (for color + grouping).
const PHASE = {
  "viewport": "setup", "cache-check": "setup",
  "goto-source": "source", "settle-source": "source", "read-bodyBg": "source",
  "screenshot-expected": "source", "discover-webfonts": "source",
  "capture-tree": "source", "cache-write": "source",
  "embed-remote-images": "render", "rasterize-conic": "render", "render-svg": "render",
  "goto-svg": "actual", "settle-svg": "actual", "screenshot-actual": "actual",
  "compare-pngs": "compare",
};
const PHASE_COLOR = {
  setup: "#9aa0a6", source: "#4285f4", render: "#ea4335", actual: "#fbbc04", compare: "#34a853",
};
const PHASE_LABEL = {
  setup: "setup", source: "capture source (cache-miss only)", render: "render SVG",
  actual: "rasterize actual", compare: "diff (serialized by lock)",
};

const agg = new Map();
for (const fx of data.fixtures) {
  for (const s of fx.steps) {
    if (!agg.has(s.step)) agg.set(s.step, []);
    agg.get(s.step).push(s.ms);
  }
}
const steps = STEP_ORDER.filter((s) => agg.has(s)).map((step) => {
  const v = agg.get(step);
  return {
    step,
    phase: PHASE[step] ?? "setup",
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    min: Math.min(...v),
    max: Math.max(...v),
    n: v.length,
  };
});
const meanTotal = steps.reduce((a, s) => a + s.mean, 0);

// ── DM-1029: render-svg sub-breakdown (helper subprocess / text in-process /
// box+markup), summed across all sampled fixtures ──
let rSvgTotal = 0, helperMs = 0, helperCalls = 0, textMs = 0;
for (const fx of data.fixtures) {
  rSvgTotal += (fx.steps.find((s) => s.step === "render-svg")?.ms) ?? 0;
  const rp = fx.renderProfile ?? {};
  helperMs += rp["helper-spawnSync"]?.ms ?? 0;
  helperCalls += rp["helper-spawnSync"]?.count ?? 0;
  textMs += rp["text-render"]?.ms ?? 0;
}
const rsplit = [
  { label: `CoreText helper — ${helperCalls} spawnSync calls`, ms: helperMs, color: "#d93025" },
  { label: "text shaping/markup (in-process)", ms: Math.max(0, textMs - helperMs), color: "#f29900" },
  { label: "box geometry + SVG markup", ms: Math.max(0, rSvgTotal - textMs), color: "#80868b" },
];

// ── reconstruct worker lanes from (startMs, totalMs) via greedy bin-packing ──
const W = data.workerCount;
const laneEnds = new Array(W).fill(0);
const placed = [];
for (const fx of [...data.fixtures].sort((a, b) => a.startMs - b.startMs)) {
  let lane = laneEnds.findIndex((end) => end <= fx.startMs + 1);
  if (lane === -1) lane = laneEnds.indexOf(Math.min(...laneEnds));
  laneEnds[lane] = fx.startMs + fx.totalMs;
  placed.push({ ...fx, lane });
}

// ── SVG geometry ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n) => Math.round(n);
const PAD = 24;
const WIDTH = 1180;
const out = [];
const A_X = 230;          // left gutter for step labels (panel A)
const A_BARW = WIDTH - A_X - 360; // bar area width (room for ms + % + range)
const ROWH = 26;
const aTop = 116;
const panelAH = steps.length * ROWH + 24;
const rTop = aTop + panelAH + 26;     // render-svg breakdown panel
const rBarH = 30;
const bTop = rTop + rBarH + 130;
const B_X = 60;
const B_W = WIDTH - B_X - PAD;
const laneH = 30;
const panelBH = W * (laneH + 8) + 70;
const HEIGHT = bTop + panelBH + 40;

out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="-apple-system,Segoe UI,Roboto,sans-serif">`);
out.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`);
out.push(`<text x="${PAD}" y="34" font-size="20" font-weight="700" fill="#202124">Domotion demo-test pipeline — one fixture (serial) and a real run (parallel)</text>`);
out.push(`<text x="${PAD}" y="56" font-size="12.5" fill="#5f6368">Sample: ${data.fixtures.length} html-test-unicode fixtures, all cache-miss · ${data.workerCount} workers · ${(data.totalWallMs / 1000).toFixed(1)}s wall · source: tests/html-test-suite.tsx instrumentation (DEMO_TIMING=1)</text>`);

// Phase legend
let lx = PAD;
const ly = 74;
for (const ph of ["setup", "source", "render", "actual", "compare"]) {
  out.push(`<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${PHASE_COLOR[ph]}"/>`);
  out.push(`<text x="${lx + 16}" y="${ly}" font-size="11.5" fill="#3c4043">${esc(PHASE_LABEL[ph])}</text>`);
  lx += 36 + esc(PHASE_LABEL[ph]).length * 6.3;
}

// ── Panel A: per-step serial breakdown (bar width ∝ mean ms) ──
out.push(`<text x="${PAD}" y="${aTop - 10}" font-size="14" font-weight="700" fill="#202124">① One demo test, step by step (serial) — mean ms across ${data.fixtures.length} fixtures, total ${r1(meanTotal)} ms</text>`);
const aMax = Math.max(...steps.map((s) => s.mean));
const aScale = A_BARW / aMax;
steps.forEach((s, i) => {
  const y = aTop + i * ROWH;
  const bw = Math.max(1, s.mean * aScale);
  out.push(`<text x="${A_X - 8}" y="${y + ROWH / 2 + 4}" font-size="12" text-anchor="end" fill="#3c4043">${esc(s.step)}</text>`);
  out.push(`<rect x="${A_X}" y="${y + 4}" width="${r1(bw)}" height="${ROWH - 9}" rx="2.5" fill="${PHASE_COLOR[s.phase]}"/>`);
  const pct = (s.mean / meanTotal) * 100;
  out.push(`<text x="${A_X + bw + 8}" y="${y + ROWH / 2 + 4}" font-size="11.5" fill="#202124">${s.mean.toFixed(0)} ms <tspan fill="#80868b">(${pct.toFixed(0)}%, range ${s.min.toFixed(0)}–${s.max.toFixed(0)})</tspan></text>`);
});

// ── Panel ①b: render-svg sub-breakdown (exploded) ──
const helperPctOfRender = (helperMs / Math.max(1, rSvgTotal)) * 100;
const helperMsPerCall = helperMs / Math.max(1, helperCalls);
out.push(`<text x="${PAD}" y="${rTop - 8}" font-size="14" font-weight="700" fill="#202124">①b Inside render-svg = ${r1(rSvgTotal)} ms — CoreText helper ${helperPctOfRender.toFixed(0)}%, text ${((Math.max(0, textMs - helperMs)) / Math.max(1, rSvgTotal) * 100).toFixed(0)}%, box ${((Math.max(0, rSvgTotal - textMs)) / Math.max(1, rSvgTotal) * 100).toFixed(0)}%</text>`);
const rScale = (WIDTH - PAD - 40) / Math.max(1, rSvgTotal);
let rx = PAD;
for (const seg of rsplit) {
  const sw = Math.max(1, seg.ms * rScale);
  out.push(`<rect x="${rx}" y="${rTop + 4}" width="${r1(sw)}" height="${rBarH - 8}" fill="${seg.color}"/>`);
  const pct = (seg.ms / Math.max(1, rSvgTotal)) * 100;
  // label inside if wide enough, else below
  if (sw > 150) {
    out.push(`<text x="${rx + 6}" y="${rTop + rBarH / 2 + 3}" font-size="11" fill="#fff">${esc(seg.label)} — ${r1(seg.ms)} ms (${pct.toFixed(0)}%)</text>`);
  }
  rx += sw;
}
// callout legend row beneath
let rlx = PAD;
const rly = rTop + rBarH + 16;
for (const seg of rsplit) {
  const pct = (seg.ms / Math.max(1, rSvgTotal)) * 100;
  out.push(`<rect x="${rlx}" y="${rly - 9}" width="11" height="11" rx="2" fill="${seg.color}"/>`);
  const txt = `${seg.label} — ${r1(seg.ms)} ms (${pct.toFixed(0)}%)`;
  out.push(`<text x="${rlx + 16}" y="${rly}" font-size="11" fill="#3c4043">${esc(txt)}</text>`);
  rlx += 30 + txt.length * 6.0;
}
// The per-call cost reveals whether the helper is spawn-per-call (~16 ms) or
// the DM-1031 persistent `--serve` round-trip (sub-ms).
const helperNote = helperMsPerCall > 3
  ? `→ ${helperCalls} <tspan font-style="italic">spawnSync</tspan> spawns of the domotion-glyph-paths binary @ ~${helperMsPerCall.toFixed(1)} ms each (process spawn + CoreText init + font open). Optimization target: a persistent helper process (DM-1031).`
  : `→ ${helperCalls} persistent <tspan font-style="italic">--serve</tspan> round-trips @ ~${helperMsPerCall.toFixed(2)} ms each (DM-1031: the helper binary stays alive and reuses opened fonts — down from ~16 ms/spawn).`;
out.push(`<text x="${PAD}" y="${rly + 22}" font-size="11.5" fill="#5f6368">${helperNote}</text>`);

// ── Panel B: parallel swimlane of the real run ──
out.push(`<text x="${PAD}" y="${bTop - 26}" font-size="14" font-weight="700" fill="#202124">② The real run — ${data.fixtures.length} fixtures across ${W} workers (parallel). Browser launches once; each worker runs the serial pipeline above; the diff step is serialized by a shared lock.</text>`);
const tScale = B_W / data.totalWallMs;
// time axis
out.push(`<line x1="${B_X}" y1="${bTop - 6}" x2="${B_X + B_W}" y2="${bTop - 6}" stroke="#dadce0"/>`);
for (let t = 0; t <= data.totalWallMs; t += 5000) {
  const x = B_X + t * tScale;
  out.push(`<line x1="${x}" y1="${bTop - 9}" x2="${x}" y2="${bTop + W * (laneH + 8)}" stroke="#f1f3f4"/>`);
  out.push(`<text x="${x}" y="${bTop - 12}" font-size="10.5" text-anchor="middle" fill="#80868b">${(t / 1000).toFixed(0)}s</text>`);
}
for (let w = 0; w < W; w++) {
  const y = bTop + w * (laneH + 8);
  out.push(`<text x="${B_X - 8}" y="${y + laneH / 2 + 4}" font-size="11" text-anchor="end" fill="#5f6368">worker ${w + 1}</text>`);
  out.push(`<rect x="${B_X}" y="${y}" width="${B_W}" height="${laneH}" fill="#fafafa" stroke="#eee"/>`);
}
for (const fx of placed) {
  const y = bTop + fx.lane * (laneH + 8);
  const x = B_X + fx.startMs * tScale;
  const bw = Math.max(2, fx.totalMs * tScale);
  // stack the fixture's steps inside its block, colored by phase
  let sx = x;
  for (const st of fx.steps) {
    const sw = st.ms * tScale;
    out.push(`<rect x="${sx}" y="${y + 3}" width="${Math.max(0.5, sw)}" height="${laneH - 6}" fill="${PHASE_COLOR[PHASE[st.step] ?? "setup"]}" opacity="0.92"/>`);
    sx += sw;
  }
  out.push(`<rect x="${x}" y="${y + 3}" width="${r1(bw)}" height="${laneH - 6}" fill="none" stroke="#fff" stroke-width="0.5"/>`);
  const label = fx.name.length > 22 ? fx.name.slice(0, 21) + "…" : fx.name;
  if (bw > 50) out.push(`<text x="${x + 3}" y="${y + laneH / 2 + 3.5}" font-size="9.5" fill="#fff">${esc(label)} ${(fx.totalMs / 1000).toFixed(1)}s</text>`);
}
out.push(`<text x="${B_X}" y="${bTop + W * (laneH + 8) + 26}" font-size="11.5" fill="#5f6368">Total wall time ${(data.totalWallMs / 1000).toFixed(1)}s for ${data.fixtures.length} fixtures = ${(data.totalWallMs / data.fixtures.length / 1000).toFixed(2)}s/fixture amortized (vs ${(data.fixtures.reduce((a, f) => a + f.totalMs, 0) / data.fixtures.length / 1000).toFixed(2)}s/fixture of serial work — the gap is the ${W}× worker parallelism).</text>`);

out.push(`</svg>`);
writeFileSync(outPath, out.join("\n"));
console.log(`wrote ${outPath} (${steps.length} steps, ${data.fixtures.length} fixtures, ${W} workers)`);
