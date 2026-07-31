/**
 * Which dotted-circle oracle agrees with Chrome — measured on THIS host's fonts.
 *
 * DM-1851. The capture-time probe decides whether Chrome auto-inserts a U+25CC
 * DOTTED CIRCLE before an orphaned combining mark. Getting it wrong is visible:
 * a false positive paints a circle Chrome does not, a false negative drops one
 * Chrome does.
 *
 * ## Why this is a committed tool and not a scratch script
 *
 * The answer depends on the host's FONT INVENTORY, and that is exactly what
 * differs between a developer Mac and the CI runner. Two candidate oracles were
 * scored on a dev Mac and tied at 102/104; the one chosen on that basis then
 * regressed five Unicode blocks on CI, because the dev Mac only exercises one of
 * the two failure modes:
 *
 *     canvas  — false POSITIVE for a mark NOTHING covers (canvas draws ◌+tofu,
 *               DOM draws a bare tofu)
 *     dom     — false NEGATIVE for some marks the runner DOES cover
 *
 * So the comparison has to run where the fonts are. This script is meant to be
 * dispatched on a CI runner (`.github/workflows/dotted-circle-probe.yml`) and
 * read out of the job log.
 *
 * ## Ground truth
 *
 * CDP `CSS.getPlatformFontsForNode` on a real laid-out span: two glyphs from a
 * script font means Chrome inserted the circle, one `.notdef` means it did not.
 * That is Chrome reporting its own paint, not a heuristic about it.
 *
 * ## Usage
 *
 *     npx tsx tools/probe-dotted-circle-oracles.ts            # all blocks
 *     npx tsx tools/probe-dotted-circle-oracles.ts --stride 3 # denser sample
 *
 * Every candidate must be computable from page APIs alone, because the real
 * probe runs inside CAPTURE_SCRIPT with no CDP available.
 */
import { chromium } from "@playwright/test";

/** The blocks that regressed under the DOM oracle, plus the one that motivated
 *  the change and two controls that were already correct. */
const BLOCKS = [
  ["devanagari-extended", 0xa8e0, 0xa8ff], // the reproduction (canvas false-positives here)
  ["tulu-tigalari", 0x11380, 0x113ff],     // regressed under DOM
  ["dives-akuru", 0x11900, 0x1195f],       // regressed under DOM
  ["soyombo", 0x11a50, 0x11aaf],           // regressed under DOM (worst: 8x)
  ["kawi", 0x11f00, 0x11f5f],              // regressed under DOM
  ["kirat-rai", 0x16d40, 0x16d7f],         // regressed under DOM
  ["vedic-extensions", 0x1cd0, 0x1cff],    // control: canvas validated 43/43 here
  ["adlam", 0x1e900, 0x1e95f],             // control: covered, Chrome circles
];

const STACK = 'system-ui, -apple-system, sans-serif';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

const stride = Math.max(1, parseInt(arg("--stride", "2"), 10) || 2);

const codepoints = [];
for (const [, lo, hi] of BLOCKS) {
  for (let cp = lo; cp <= hi; cp += stride) {
    if (/\p{M}|\p{Lo}|\p{Lm}/u.test(String.fromCodePoint(cp))) codepoints.push(cp);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

await page.setContent(`<!doctype html><html lang="en"><body style="margin:0;font:16px ${STACK}">
  <div id="cells"></div><div id="probe" style="position:absolute;left:-99999px;visibility:hidden;white-space:pre"></div>
</body></html>`);

await page.evaluate(({ cps, stack }) => {
  const host = document.getElementById("cells");
  for (const cp of cps) {
    const s = document.createElement("span");
    s.id = "c" + cp.toString(16);
    s.style.font = `32px ${stack}`;
    s.textContent = String.fromCodePoint(cp);
    host.appendChild(s);
    host.appendChild(document.createElement("br"));
  }
}, { cps: codepoints, stack: STACK });

// All candidates, evaluated with page APIs only — the constraint the real probe
// lives under.
const verdicts = await page.evaluate(({ cps, stack }) => {
  const cv = document.createElement("canvas");
  cv.width = 96; cv.height = 64;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const ink = (s) => {
    ctx.clearRect(0, 0, 96, 64);
    ctx.fillStyle = "#000"; ctx.textBaseline = "middle"; ctx.font = "32px " + stack;
    ctx.fillText(s, 40, 32);
    const d = ctx.getImageData(0, 0, 96, 64).data;
    let cnt = 0, minx = 1e9, maxx = -1;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      if (d[(y * 96 + x) * 4 + 3] > 20) { cnt++; if (x < minx) minx = x; if (x > maxx) maxx = x; }
    }
    return { cnt, w: cnt > 0 ? maxx - minx + 1 : 0 };
  };
  const el = document.getElementById("probe");
  const domW = (s) => { el.style.font = `32px ${stack}`; el.textContent = s; return el.getBoundingClientRect().width; };

  const circleW = domW("◌");
  const out = {};
  for (const cp of cps) {
    const ch = String.fromCodePoint(cp);
    const bi = ink(ch), ci = ink("◌" + ch);
    const ratio = ci.cnt > 0 ? bi.cnt / ci.cnt : 0;
    const bw = domW(ch), cw = domW("◌" + ch);
    out[cp] = {
      // A: today's canvas ink comparison.
      canvas: bi.cnt > 20 && ratio > 0.9 && ci.w <= bi.w * 1.25,
      // C: the same bare-vs-combined question asked of DOM layout.
      dom: bw > 0 && cw > 0 && Math.abs(cw - bw) / cw < 0.05,
      // D: does the bare mark's ADVANCE match U+25CC's own? If Chrome inserted
      // the circle, the cluster is ◌+mark and the mark contributes no advance,
      // so the bare width tracks the circle's. A lone tofu's advance does not.
      // A different signal from C, so it should not share C's blind spot.
      circleAdv: circleW > 0 && bw > 0 && Math.abs(bw - circleW) / circleW < 0.05,
      raw: { bareInk: bi.cnt, combInk: ci.cnt, bareW: bw, combW: cw, circleW },
    };
  }
  return out;
}, { cps: codepoints, stack: STACK });

const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
const rows = [];
for (const cp of codepoints) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#c" + cp.toString(16) });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const used = (fonts ?? []).filter((f) => f.glyphCount > 0);
  const glyphs = used.reduce((n, f) => n + f.glyphCount, 0);
  rows.push({
    cp, glyphs,
    families: used.map((f) => `${f.familyName}x${f.glyphCount}`).join("+"),
    truth: glyphs >= 2,
    ...verdicts[cp],
  });
}
await browser.close();

const block = (cp) => BLOCKS.find(([, lo, hi]) => cp >= lo && cp <= hi)?.[0] ?? "?";
const ORACLES = ["canvas", "dom", "circleAdv"];

console.log(`DOTCIRCLE host=${process.platform} codepoints=${rows.length} stride=${stride}\n`);
console.log("DOTCIRCLE cp        block                 truth  glyphs family                       canvas dom circleAdv");
for (const r of rows) {
  const mark = (k) => (r[k] === r.truth ? "ok " : "XX ");
  console.log(
    `DOTCIRCLE U+${r.cp.toString(16).toUpperCase().padStart(5, "0")}  ${block(r.cp).padEnd(20)} `
    + `${(r.truth ? "CIRCLE" : "bare  ")} ${String(r.glyphs).padStart(2)}    ${String(r.families).slice(0, 28).padEnd(28)} `
    + ORACLES.map((k) => `${String(r[k])[0]}${mark(k)}`).join(" "),
  );
}

console.log(`\nDOTCIRCLE ===== AGREEMENT WITH CHROME'S PAINT (${rows.length} codepoints) =====`);
for (const k of ORACLES) {
  const ok = rows.filter((r) => r[k] === r.truth).length;
  const fp = rows.filter((r) => r[k] && !r.truth).length;
  const fn = rows.filter((r) => !r[k] && r.truth).length;
  console.log(`DOTCIRCLE   ${k.padEnd(10)} ${String(ok).padStart(4)}/${rows.length}   false-positive ${fp}   false-negative ${fn}`);
}
// Per-block, because a whole-corpus score can hide a block that flips entirely —
// which is exactly how the DOM oracle's five regressions were invisible in the
// aggregate.
console.log(`\nDOTCIRCLE ===== PER BLOCK =====`);
for (const [name] of BLOCKS) {
  const sub = rows.filter((r) => block(r.cp) === name);
  if (sub.length === 0) continue;
  const s = ORACLES.map((k) => `${k} ${sub.filter((r) => r[k] === r.truth).length}/${sub.length}`).join("   ");
  console.log(`DOTCIRCLE   ${name.padEnd(22)} ${s}`);
}
