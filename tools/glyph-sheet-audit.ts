#!/usr/bin/env tsx
/**
 * Per-character font-fidelity audit for the Unicode per-block "grid" fixtures
 * (`<x><g>CHAR</g><n>U+XXXX</n></x>` cells — the `../html-test/unicode/*.html`
 * sheets). For each glyph cell it crops the SAME rect out of the expected
 * (Chromium) and actual (Domotion SVG raster) captures and runs the DM-1686
 * glyph font-identity comparator (`src/review/glyph-compare.ts`), which is
 * deterministic and excludes anti-aliasing / subpixel drift by design. The
 * output is a per-codepoint CORRECT/INCORRECT list plus a per-sheet summary —
 * i.e. exactly which characters render with the wrong font, separated from the
 * native-hinting AA drift that dominates the raw pixel diff.
 *
 * The tool does ALL the character-level work deterministically; no per-glyph AI
 * judgment is required. It is the batch companion to `tools/compare-glyphs.ts`
 * (single crop pair) — see docs/98-glyph-font-compare.md.
 *
 * Geometry is self-aligning: the Playwright render viewport is sized to the
 * STORED expected PNG, and each sheet's fresh screenshot is diffed against that
 * expected before trusting any verdict (a `layout-drift` flag fires if the two
 * disagree, e.g. a Chromium-version reflow — guarding against cropping the
 * wrong cell).
 *
 * Usage:
 *   npx tsx tools/glyph-sheet-audit.ts \
 *     --results-dir tests/output/review/ci-macos/html-test-unicode \
 *     --fixtures-dir ../html-test/unicode \
 *     [--only 1F100] [--out tools/scratch/sheet-audit.json] [--sheet <name>]
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import {
  extractCoverage,
  compareGlyphCoverage,
  type CoverageMap,
  type GlyphCompareResult,
} from "../src/review/glyph-compare.js";

interface Cell { cp: string; char: string; cls: string; x: number; y: number; w: number; h: number; }
interface RawImg { data: Buffer; width: number; height: number; channels: number; }
interface CellVerdict extends Cell { verdict: "match" | "mismatch" | "error"; hard: string[]; soft: string[]; ncc?: number; note?: string; }
interface SheetResult {
  sheet: string; cells: number; incorrect: number; errors: number;
  layoutDrift: boolean; alignCorr: number; alignDy: number; incorrectCps: string[]; verdicts: CellVerdict[];
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Slice an (x,y,w,h) sub-rect out of a decoded RGBA/RGB buffer. */
function cropRaw(img: RawImg, x: number, y: number, w: number, h: number): { buf: Buffer; w: number; h: number; ch: number } {
  const ch = img.channels;
  const cw = Math.min(w, img.width - x), chh = Math.min(h, img.height - y);
  const out = Buffer.alloc(cw * chh * ch);
  for (let row = 0; row < chh; row++) {
    const src = ((y + row) * img.width + x) * ch;
    img.data.copy(out, row * cw * ch, src, src + cw * ch);
  }
  return { buf: out, w: cw, h: chh, ch };
}

async function loadRaw(path: string): Promise<RawImg> {
  const { data, info } = await sharp(path).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// The unicode grid fixtures always lay out at 1024 CSS px wide (harness WIDTH).
const CSS_WIDTH = 1024;

async function auditSheet(browser: Browser, name: string, fixture: string, expPath: string, actPath: string): Promise<SheetResult | null> {
  const expMeta = await sharp(expPath).metadata();
  const W = expMeta.width ?? 1024, H = expMeta.height ?? 768;
  // The capture DPR is baked into the PNG width (1024×DPR). Render the layout at
  // CSS 1024 × DPR so the screenshot geometry matches the stored PNG and glyph
  // ink lands at the comparator's calibrated ≥32px scale on a 2× diagnostic run.
  const dpr = Math.max(1, Math.round(W / CSS_WIDTH));
  const cssW = Math.round(W / dpr), cssH = Math.round(H / dpr);

  // Cells + a fresh screenshot at the stored capture geometry.
  const ctx = await browser.newContext({ viewport: { width: cssW, height: cssH }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto(`file://${resolve(fixture)}`);
  await page.waitForLoadState("networkidle");
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: cssW, height: cssH } });
  const cells: Cell[] = await page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (const x of Array.from(document.querySelectorAll("x"))) {
      const g = x.querySelector("g"), n = x.querySelector("n");
      if (!g || !n) continue;
      const r = g.getBoundingClientRect();
      out.push({ cp: (n.textContent ?? "").trim(), char: g.textContent ?? "", cls: (x as HTMLElement).className || "",
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  }) as unknown as Cell[];
  await ctx.close();
  if (cells.length === 0) return null; // not a glyph-grid fixture

  // Alignment guard by GRID POSITION, not pixel identity. My local Chromium may
  // paint individual glyphs differently from the CI capture (that divergence is
  // the whole subject of this audit), so a full-image pixel diff would false-
  // alarm. Instead cross-correlate the horizontal row-ink PROJECTION of my
  // screenshot against the stored expected: the rows that carry glyph ink line
  // up regardless of which font drew them. The peak offset `dy` corrects any
  // vertical reflow (the preamble height shifts if system-ui metrics differ);
  // a weak peak correlation ⇒ genuine structural mismatch (`layout-drift`).
  const exp = await loadRaw(expPath);
  const shotRaw0 = await sharp(shot).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
  const shotRaw: RawImg = { data: shotRaw0.data, width: shotRaw0.info.width, height: shotRaw0.info.height, channels: shotRaw0.info.channels };
  const rowInk = (img: RawImg): Float64Array => {
    const p = new Float64Array(img.height);
    for (let yy = 0; yy < img.height; yy++) {
      let s = 0; const base = yy * img.width * img.channels;
      for (let xx = 0; xx < img.width; xx++) {
        const o = base + xx * img.channels;
        s += 255 - (img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114);
      }
      p[yy] = s;
    }
    return p;
  };
  const pe = rowInk(exp), ps = rowInk(shotRaw);
  const norm = (v: Float64Array): Float64Array => { let m = 0; for (const x of v) m += x; m /= v.length; const o = new Float64Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] - m; return o; };
  const ne = norm(pe), ns = norm(ps);
  let bestDy = 0, bestCorr = -Infinity;
  for (let dy = -12; dy <= 12; dy++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < ne.length; i++) {
      const j = i + dy; if (j < 0 || j >= ns.length) continue;
      num += ne[i] * ns[j]; da += ne[i] * ne[i]; db += ns[j] * ns[j];
    }
    const corr = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    if (corr > bestCorr) { bestCorr = corr; bestDy = dy; }
  }
  // dy>0 means the expected's rows sit LOWER than my render's ⇒ add dy to cell y.
  // Content differences (CI vs local glyph paint) legitimately drop the peak
  // correlation to ~0.8 even when the grid is perfectly aligned (clear peak at a
  // small dy), so the floor is loose; a genuine reflow shows up as a large dy
  // (viewport width is pinned to the expected PNG, so the only reflow axis is
  // vertical) or a washed-out peak (<0.55, no alignment possible).
  const layoutDrift = bestCorr < 0.55 || Math.abs(bestDy) > 8;
  const alignCorr = +bestCorr.toFixed(3);

  const act = await loadRaw(actPath);
  const verdicts: CellVerdict[] = [];
  for (const c of cells) {
    // Cell rects are CSS px; scale to PNG px (×dpr) and add the row-projection
    // vertical correction (already in PNG px).
    const x = Math.max(0, Math.round(c.x * dpr)), y = Math.max(0, Math.round(c.y * dpr) + bestDy);
    const cw = Math.round(c.w * dpr), chh = Math.round(c.h * dpr);
    const ca = cropRaw(exp, x, y, cw, chh);
    const cb = cropRaw(act, x, y, cw, chh);
    let va: CoverageMap, vb: CoverageMap;
    try { va = extractCoverage(ca.buf, ca.w, ca.h, ca.ch); vb = extractCoverage(cb.buf, cb.w, cb.h, cb.ch); }
    catch { verdicts.push({ ...c, verdict: "error", hard: [], soft: [], note: "decode" }); continue; }
    let res: GlyphCompareResult;
    try { res = compareGlyphCoverage(va, vb); }
    catch (e) { verdicts.push({ ...c, verdict: "error", hard: [], soft: [], note: (e as Error).message.slice(0, 40) }); continue; }
    verdicts.push({ ...c, verdict: res.verdict === "match" ? "match" : "mismatch",
      hard: res.hardSignals, soft: res.softSignals, ncc: +res.metrics.ncc.toFixed(3) });
  }
  const incorrect = verdicts.filter((v) => v.verdict === "mismatch");
  const errors = verdicts.filter((v) => v.verdict === "error");
  return { sheet: name, cells: cells.length, incorrect: incorrect.length, errors: errors.length,
    layoutDrift, alignCorr, alignDy: bestDy,
    incorrectCps: incorrect.map((v) => v.cp), verdicts };
}

async function main(): Promise<void> {
  const resultsDir = arg("--results-dir");
  const fixturesDir = arg("--fixtures-dir");
  const only = arg("--only");
  const sheet = arg("--sheet");
  const outPath = arg("--out", "tools/scratch/sheet-audit.json");
  if (!resultsDir || !fixturesDir) {
    console.error("usage: glyph-sheet-audit.ts --results-dir <dir> --fixtures-dir <dir> [--only <substr>] [--sheet <name>] [--out <json>]");
    process.exit(2);
  }

  // Discover sheets: <name>-expected.png + <name>-actual.png + <name>.html.
  const names = new Set<string>();
  for (const f of readdirSync(resultsDir)) {
    const m = /^(.*)-expected\.png$/.exec(f);
    if (m) names.add(m[1]);
  }
  let sheets = [...names].sort();
  if (sheet) sheets = sheets.filter((s) => s === sheet);
  else if (only) sheets = sheets.filter((s) => s.includes(only));

  const browser = await chromium.launch();
  const results: SheetResult[] = [];
  let done = 0;
  for (const name of sheets) {
    const expPath = join(resultsDir, `${name}-expected.png`);
    const actPath = join(resultsDir, `${name}-actual.png`);
    const fixture = join(fixturesDir, `${name}.html`);
    if (!existsSync(actPath) || !existsSync(fixture)) continue;
    try {
      const r = await auditSheet(browser, name, fixture, expPath, actPath);
      if (r) {
        results.push(r);
        const flag = r.layoutDrift ? " ⚠LAYOUT-DRIFT" : "";
        process.stderr.write(`[${++done}/${sheets.length}] ${name}: ${r.incorrect}/${r.cells} incorrect${r.errors ? `, ${r.errors} err` : ""}${flag}\n`);
      }
    } catch (e) {
      process.stderr.write(`[skip] ${name}: ${(e as Error).message}\n`);
    }
  }
  await browser.close();

  writeFileSync(outPath, JSON.stringify(results, null, 1));

  // Summary table, sorted by incorrect-count desc then name.
  const withDefects = results.filter((r) => r.incorrect > 0).sort((a, b) => b.incorrect - a.incorrect || a.sheet.localeCompare(b.sheet));
  const clean = results.filter((r) => r.incorrect === 0);
  console.log(`\n=== ${results.length} grid sheets audited · ${withDefects.length} with real font defects · ${clean.length} clean (AA-only) ===\n`);
  console.log(`${"sheet".padEnd(52)} incorrect/cells  drift`);
  for (const r of withDefects) {
    console.log(`${r.sheet.padEnd(52)} ${String(r.incorrect).padStart(4)}/${String(r.cells).padEnd(4)}     ${r.layoutDrift ? "⚠" : ""}`);
  }
  const totalIncorrect = results.reduce((s, r) => s + r.incorrect, 0);
  console.log(`\ntotal incorrect glyphs: ${totalIncorrect}  ·  full per-codepoint JSON: ${outPath}`);
}

void main();
