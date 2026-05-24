// Cross-platform painted-advance calibration probe.
//
// Domotion's font-fallback chain must match what Chromium PAINTS on the host
// platform, and the documented way to reverse-engineer that is: render a glyph
// in a probe div, read `Range.getBoundingClientRect().width` (the selection
// rectangle uses ADVANCE width, not ink), then match that advance against
// candidate system-font advance widths via fontkit's `glyphForCodePoint`.
//
// This script does the first half — it dumps Chromium's painted advances for a
// calibration set of (font-family x sample) pairs — and is deliberately
// PLATFORM-AGNOSTIC: the same code produces macOS (CoreText), Linux
// (fontconfig), or Windows (DirectWrite) numbers depending on where it runs,
// so the JSON outputs are directly diffable. CI runs it on `windows-latest` to
// capture the DirectWrite numbers we have no other faithful way to obtain
// (Wine's dwrite reimplementation does not match real Windows fallback).
//
// Usage:
//   node scripts/probe-platform-font-widths.mjs                 # prints JSON to stdout
//   node scripts/probe-platform-font-widths.mjs --out widths.json
//
// The downstream matching step (build the win32 chain from these advances)
// lives with the calibration work, not here.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const FONT_SIZE_PX = 64; // large for sub-pixel precision; advances scale linearly

// Families to probe. Generic keywords exercise each platform's UA default +
// fallback; the explicit families are the ones Chromium maps to platform faces
// we need to calibrate against (Segoe UI / Cambria Math / Consolas / Yu Gothic
// on Windows; Helvetica / Times / Menlo on macOS; Noto / DejaVu on Linux).
const FAMILIES = [
  "sans-serif",
  "serif",
  "monospace",
  "Arial",
  "Times New Roman",
  "Consolas",
  "Segoe UI",
  "Segoe UI Symbol",
  "Cambria Math",
  "Yu Gothic",
];

// Calibration samples. Each entry is one Range-measured cell. For "simple"
// codepoints the per-char advance directly fingerprints the fallback font; for
// shaped scripts (Arabic / Devanagari / Thai) we measure a short representative
// word's TOTAL advance, since per-char advance isn't meaningful there.
const cp = (...codes) => String.fromCodePoint(...codes);
const SAMPLES = [
  // Latin baseline — sanity check that the family resolved at all.
  { label: "latin-M", text: "M" },
  { label: "latin-mixed", text: "Mxgp" },
  // Geometric shapes / dingbats (U+25xx, U+26xx) — symbol fallback.
  { label: "black-square", text: cp(0x25a0) },
  { label: "black-circle", text: cp(0x25cf) },
  { label: "black-diamond", text: cp(0x25c6) },
  { label: "black-star", text: cp(0x2605) },
  { label: "spade", text: cp(0x2660) },
  { label: "ballot-x", text: cp(0x2612) },
  // Math operators (U+22xx) — math fallback (STIX / Cambria Math).
  { label: "summation", text: cp(0x2211) },
  { label: "product", text: cp(0x220f) },
  { label: "not-equal", text: cp(0x2260) },
  { label: "integral", text: cp(0x222b) },
  // Box drawing (U+25xx) — monospace cell alignment.
  { label: "box-horizontal", text: cp(0x2500) },
  { label: "box-cross", text: cp(0x253c) },
  { label: "box-top-tee", text: cp(0x252c) },
  // CJK ideographs + kana — CJK fallback (Yu Gothic / MS Gothic on Windows).
  { label: "han-yong", text: cp(0x6c38) }, // 永 — the classic metrics sample
  { label: "han-pair", text: cp(0x4e2d, 0x6587) }, // 中文
  { label: "hiragana", text: cp(0x3042) }, // あ
  { label: "katakana", text: cp(0x30a2) }, // ア
  { label: "hangul", text: cp(0xac00) }, // 가
  // Shaped scripts — total advance of a short word.
  { label: "arabic-word", text: cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627) }, // مرحبا
  { label: "hebrew-word", text: cp(0x05e9, 0x05dc, 0x05d5, 0x05dd) }, // שלום
  { label: "devanagari-word", text: cp(0x0928, 0x092e, 0x0938, 0x094d, 0x0924, 0x0947) }, // नमस्ते
  { label: "thai-word", text: cp(0x0e2a, 0x0e27, 0x0e31, 0x0e2a, 0x0e14, 0x0e35) }, // สวัสดี
];

function buildHtml() {
  const cells = [];
  for (let fi = 0; fi < FAMILIES.length; fi++) {
    for (let si = 0; si < SAMPLES.length; si++) {
      const id = `c_${fi}_${si}`;
      // `white-space: pre` so leading/trailing layout never collapses; the
      // span wraps exactly the sample text, which the Range then selects.
      cells.push(
        `<span id="${id}" style="font-family:${FAMILIES[fi].includes(" ") ? `'${FAMILIES[fi]}'` : FAMILIES[fi]};` +
          `font-size:${FONT_SIZE_PX}px;line-height:normal;white-space:pre;">${SAMPLES[si].text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</span>`,
      );
    }
  }
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `body{margin:0;padding:0;background:#fff;color:#000}` +
    `span{display:inline-block;margin:4px}` +
    `</style></head><body>${cells.join("")}</body></html>`
  );
}

async function main() {
  const outFlag = process.argv.indexOf("--out");
  const outPath = outFlag !== -1 ? process.argv[outFlag + 1] : null;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 4000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(buildHtml(), { waitUntil: "load" });

  const measured = await page.evaluate(
    ({ families, samples }) => {
      const out = [];
      for (let fi = 0; fi < families.length; fi++) {
        for (let si = 0; si < samples.length; si++) {
          const el = document.getElementById(`c_${fi}_${si}`);
          const range = document.createRange();
          range.selectNodeContents(el);
          const r = range.getBoundingClientRect();
          out.push({
            family: families[fi],
            label: samples[si].label,
            text: samples[si].text,
            // Round to 3dp — Chromium positions sub-pixel; more digits is noise.
            width: Math.round(r.width * 1000) / 1000,
            height: Math.round(r.height * 1000) / 1000,
          });
        }
      }
      return out;
    },
    { families: FAMILIES, samples: SAMPLES },
  );

  const result = {
    platform: process.platform, // "darwin" | "linux" | "win32"
    chromiumVersion: browser.version(),
    fontSizePx: FONT_SIZE_PX,
    capturedAt: new Date().toISOString(),
    widths: measured,
  };

  await browser.close();

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json);
    console.error(`[probe] wrote ${measured.length} measurements to ${outPath} (platform=${result.platform})`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
