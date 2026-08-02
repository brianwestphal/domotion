// Why does Chrome's `sans-serif` sometimes resolve to Arial and sometimes to
// Helvetica on a CI runner?
//
// Two conformance runs of one commit — same runner image, same font inventory,
// same Chromium build — disagreed wholesale on the `sans-serif` primary at
// 32px/700: 222,883 Helvetica-Bold answers became 108,576 Arial-BoldMT ones. It
// affects only the generic; every explicitly-named family in the corpus is
// stable. And it costs more than the oracle — the visual sweeps inherit it, and
// four unicode fixtures (2070-209F, 2C60-2C7F, 1CD0-1CFF, A8E0-A8FF) are
// bistable across runs because of it, which has already produced one wrong
// regression attribution.
//
// A developer Mac cannot answer this: 12 launches there gave Helvetica 12/12,
// and the host carries ~2,635 fonts against a runner's ~370. The choice is
// marginal where the inventory is thin. So this has to run on the runner, which
// is what the accompanying workflow is for.
//
// ## What it is designed to separate
//
// Reporting "it varies" would not narrow anything. Each launch therefore probes
// four things at once, so a single run distinguishes the candidate causes:
//
//   per-launch      the same query in N fresh browsers. Variation here means
//                   launch-time state, which is what the whole-stack flip
//                   implies. Stability here would refute the premise.
//   within-launch   the same query again, in a second page of the SAME browser,
//                   after a settle delay. Variation here would mean the answer
//                   depends on when you ask, not on the process — and the fix
//                   would be a wait rather than a warm-up.
//   cold-start      results are printed per launch, in order. A first launch
//                   that disagrees with launches 2..N is a cold-start effect and
//                   a warm-up page is the cheap mitigation.
//   generic-only    `serif` and `monospace` alongside `sans-serif`, and Arial
//                   and Helvetica named explicitly as controls. If the named
//                   controls ever move, this is font matching and not the
//                   default-font preference; if only the generics move, it is
//                   preference resolution. That distinction is the point.
//
// Diagnostic only: renders nothing, gates nothing, writes no baseline. Every
// line is prefixed `SANSFLIP` so it is greppable out of a job log.
import { chromium } from "@playwright/test";

const N = Number(process.env.LAUNCHES ?? process.argv[2] ?? 20);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 750);

/** The probes. `sans-serif` at 32px/700 is the exact case that flipped; the rest
 *  are there to say WHICH mechanism moved when it does. */
const PROBES = [
  { id: "sans-serif@700", css: "font-family:sans-serif;font-size:32px;font-weight:700" },
  { id: "sans-serif@400", css: "font-family:sans-serif;font-size:32px;font-weight:400" },
  { id: "serif@400", css: "font-family:serif;font-size:32px;font-weight:400" },
  { id: "monospace@400", css: "font-family:monospace;font-size:32px;font-weight:400" },
  { id: "Helvetica@700", css: 'font-family:Helvetica;font-size:32px;font-weight:700' },
  { id: "Arial@700", css: 'font-family:Arial;font-size:32px;font-weight:700' },
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0">${
  PROBES.map((p, i) => `<div class="p" data-i="${i}" style="${p.css}">Ag</div>`).join("")
}</body></html>`;

/** One page's answers: probe id → the face Chrome reports. */
async function facesFor(ctx) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await page.setContent(html);
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".p" });
  const out = {};
  for (let i = 0; i < PROBES.length; i++) {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[i] });
    out[PROBES[i].id] = fonts.map((f) => f.postScriptName || f.familyName).join(",") || "(none)";
  }
  await page.close();
  return out;
}

const rows = [];
for (let i = 0; i < N; i++) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 800, height: 200 } });
  // First ask: a fresh context, queried as soon as the content is set — the same
  // shape the oracle and the visual harness use.
  const first = await facesFor(ctx);
  // Second ask: same browser process, a new page, after a settle. Any difference
  // between these two columns is a timing effect rather than a process one.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const second = await facesFor(ctx);
  await browser.close();
  rows.push({ i, first, second });
  const flag = PROBES.some((p) => first[p.id] !== second[p.id]) ? "  <- first/second DIFFER" : "";
  console.log(`SANSFLIP launch ${String(i + 1).padStart(3)}  ${PROBES.map((p) => `${p.id}=${first[p.id]}`).join("  ")}${flag}`);
}

console.log("SANSFLIP");
console.log(`SANSFLIP === tally over ${N} launches (first ask) ===`);
let anyVaries = false;
for (const p of PROBES) {
  const tally = new Map();
  for (const r of rows) tally.set(r.first[p.id], (tally.get(r.first[p.id]) ?? 0) + 1);
  const varies = tally.size > 1;
  anyVaries ||= varies;
  const detail = [...tally].map(([k, v]) => `${v}x ${k}`).join("   |   ");
  console.log(`SANSFLIP ${varies ? "VARIES " : "stable "} ${p.id.padEnd(16)} ${detail}`);
}

// Cold start: does launch 1 disagree with the rest? Reported separately because
// it implies a different fix (warm up once) from a uniformly random flip.
const firstRow = rows[0], restRows = rows.slice(1);
const coldOnly = PROBES.filter((p) =>
  restRows.length > 0 && restRows.every((r) => r.first[p.id] === restRows[0].first[p.id])
    && firstRow.first[p.id] !== restRows[0].first[p.id]);
console.log("SANSFLIP");
console.log(coldOnly.length > 0
  ? `SANSFLIP COLD-START: launch 1 differs from a unanimous 2..${N} on: ${coldOnly.map((p) => p.id).join(", ")}`
  : "SANSFLIP no cold-start signature (launch 1 is not the odd one out)");

const timing = PROBES.filter((p) => rows.some((r) => r.first[p.id] !== r.second[p.id]));
console.log(timing.length > 0
  ? `SANSFLIP TIMING: first vs settled ask differ within a launch on: ${timing.map((p) => p.id).join(", ")}`
  : "SANSFLIP no within-launch timing effect (settled ask always agrees with the first)");

console.log("SANSFLIP");
console.log(anyVaries ? "SANSFLIP *** VARIES ACROSS LAUNCHES ***" : "SANSFLIP stable across launches");
