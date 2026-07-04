#!/usr/bin/env tsx
/**
 * DM-1686 — calibration + validation harness for the glyph font-identity
 * comparator (src/review/glyph-compare.ts).
 *
 * Renders a corpus of single-glyph crops with real system fonts via
 * Playwright Chromium at DPR 2 (the recommended production crop scale), then
 * scores every pair through the comparator and reports:
 *
 *   - per-metric distributions for SAME pairs (same font re-rendered at a
 *     different subpixel phase — the noise floor the thresholds must clear)
 *     vs DIFFERENT pairs (lookalike families, weight steps, size steps,
 *     italic vs upright),
 *   - the confusion matrix at the current DEFAULT_THRESHOLDS,
 *   - every misclassified pair, so threshold tuning is evidence-driven.
 *
 * Crops + a results JSON land in tests/output/glyph-compare-calibration/ so
 * thresholds can be re-derived (via the exported `decide()`) without
 * re-rendering. Run:
 *
 *   npx tsx tools/glyph-compare-calibrate.ts            # full corpus
 *   npx tsx tools/glyph-compare-calibrate.ts --quick    # 3 chars, fewer pairs
 *
 * Expectation semantics: the comparator answers "same rendered shape?", so
 * lookalike-family pairs are split into DISCRIMINATIVE chars (R a g e t G Q —
 * the letterforms font identification actually relies on; these SHOULD
 * mismatch) and WEAK chars (l o 8 — near-identical designs in e.g.
 * Helvetica vs Arial; a "match" there is correct behavior, reported
 * separately, not counted as a miss).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  compareGlyphPngs,
  DEFAULT_THRESHOLDS,
  type GlyphCompareResult,
} from "../src/review/glyph-compare.js";

const OUT_DIR = "tests/output/glyph-compare-calibration";
const QUICK = process.argv.includes("--quick");

const DISCRIMINATIVE = ["R", "a", "g", "e", "t", "G", "Q"];
const WEAK = ["l", "o", "8"];
const CHARS = QUICK ? ["R", "a", "g"] : [...DISCRIMINATIVE, ...WEAK];

interface Cell {
  family: string;
  weight: number;
  style: "normal" | "italic";
  size: number;
  /** Subpixel x offset applied to the span (phase noise for SAME pairs). */
  offset: number;
  char: string;
}

function cellId(c: Cell): string {
  const fam = c.family.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${fam}-w${c.weight}-${c.style}-s${c.size}-o${String(c.offset).replace(".", "_")}-u${c.char.codePointAt(0)!.toString(16)}`;
}

/** Render every char of a (family, weight, style, size, offset) config on
 *  one page and screenshot per-char crops. Returns id → png path. */
async function renderConfig(
  page: Page,
  cfg: Omit<Cell, "char">,
  chars: string[],
): Promise<Map<string, string>> {
  const spans = chars
    .map(
      (ch, i) =>
        `<span id="g${i}" style="position:absolute; left:${20 + i * 90 + cfg.offset}px; top:24px;">${ch}</span>`,
    )
    .join("");
  await page.setContent(
    `<!doctype html><html><body style="margin:0; background:#fff;
      font-family:${cfg.family}; font-weight:${cfg.weight}; font-style:${cfg.style};
      font-size:${cfg.size}px; color:#000; -webkit-font-smoothing:antialiased;">
      ${spans}</body></html>`,
  );
  await page.waitForLoadState("networkidle");
  const out = new Map<string, string>();
  for (let i = 0; i < chars.length; i++) {
    const box = await page.locator(`#g${i}`).boundingBox();
    if (box == null) continue;
    const M = 5;
    const clip = { x: box.x - M, y: box.y - M, width: box.width + 2 * M, height: box.height + 2 * M };
    const cell: Cell = { ...cfg, char: chars[i] };
    const file = join(OUT_DIR, `${cellId(cell)}.png`);
    await page.screenshot({ path: file, clip });
    out.set(cellId(cell), file);
  }
  return out;
}

interface PairSpec {
  kind: string;               // same | family | weight | size | style
  expect: "match" | "mismatch";
  /** Weak-char family pair — reported, not counted as a miss on match. */
  advisory: boolean;
  a: Cell;
  b: Cell;
  label: string;
}

function cell(family: string, char: string, over: Partial<Cell> = {}): Cell {
  return { family, weight: 400, style: "normal", size: 32, offset: 0, char, ...over };
}

function buildPairs(): PairSpec[] {
  const pairs: PairSpec[] = [];
  const families = QUICK
    ? ["Helvetica", "Arial", "Georgia"]
    : ["Helvetica", "Arial", "'Helvetica Neue'", "system-ui", "Times", "'Times New Roman'", "Georgia", "Menlo", "Courier", "Verdana"];

  // SAME: subpixel-phase re-render of every family at 32px and 16px.
  for (const f of families) {
    for (const size of QUICK ? [32] : [32, 16]) {
      for (const ch of CHARS) {
        pairs.push({
          kind: "same", expect: "match", advisory: false,
          a: cell(f, ch, { size }),
          b: cell(f, ch, { size, offset: 0.37 }),
          label: `${f}@${size} '${ch}' phase 0 vs 0.37`,
        });
      }
    }
  }

  // DIFFERENT family (lookalikes) at 32px.
  const familyPairs: Array<[string, string]> = QUICK
    ? [["Helvetica", "Arial"]]
    : [
        ["Helvetica", "Arial"],
        ["Helvetica", "'Helvetica Neue'"],
        ["Arial", "'Helvetica Neue'"],
        ["system-ui", "Helvetica"],
        ["Times", "Georgia"],
        ["Times", "'Times New Roman'"],
        ["Georgia", "'Times New Roman'"],
        ["Menlo", "Courier"],
        ["Helvetica", "Verdana"],
      ];
  for (const [fa, fb] of familyPairs) {
    for (const ch of CHARS) {
      pairs.push({
        kind: "family", expect: "mismatch",
        advisory: WEAK.includes(ch),
        a: cell(fa, ch), b: cell(fb, ch),
        label: `${fa} vs ${fb} '${ch}'`,
      });
    }
  }

  // DIFFERENT weight.
  const weightFamilies = QUICK ? ["Helvetica"] : ["Helvetica", "system-ui", "Times", "Georgia"];
  for (const f of weightFamilies) {
    for (const ch of CHARS) {
      pairs.push({
        kind: "weight", expect: "mismatch", advisory: false,
        a: cell(f, ch), b: cell(f, ch, { weight: 700 }),
        label: `${f} 400 vs 700 '${ch}'`,
      });
    }
  }
  if (!QUICK) {
    for (const ch of CHARS) {
      pairs.push({
        kind: "weight", expect: "mismatch", advisory: true, // subtle real-medium step
        a: cell("system-ui", ch), b: cell("system-ui", ch, { weight: 500 }),
        label: `system-ui 400 vs 500 '${ch}'`,
      });
    }
  }

  // DIFFERENT size (same family). 32→34 (~6%) must be caught; 32→33 (~3%)
  // is advisory — a single-glyph 3% scale change sits at the detection floor
  // at this crop scale (see docs/98 § Limits).
  const sizeFamilies = QUICK ? ["Helvetica"] : ["Helvetica", "Times"];
  for (const f of sizeFamilies) {
    for (const ch of CHARS) {
      pairs.push({
        kind: "size", expect: "mismatch", advisory: false,
        a: cell(f, ch, { size: 32 }), b: cell(f, ch, { size: 34 }),
        label: `${f} 32 vs 34px '${ch}'`,
      });
      if (!QUICK) {
        pairs.push({
          kind: "size", expect: "mismatch", advisory: true,
          a: cell(f, ch, { size: 32 }), b: cell(f, ch, { size: 33 }),
          label: `${f} 32 vs 33px '${ch}'`,
        });
      }
    }
  }

  // DIFFERENT style (upright vs italic).
  const styleFamilies = QUICK ? ["Georgia"] : ["Helvetica", "Georgia", "system-ui"];
  for (const f of styleFamilies) {
    for (const ch of CHARS) {
      pairs.push({
        kind: "style", expect: "mismatch", advisory: false,
        a: cell(f, ch), b: cell(f, ch, { style: "italic" }),
        label: `${f} normal vs italic '${ch}'`,
      });
    }
  }
  return pairs;
}

function fmtP(values: number[], p: number): string {
  if (values.length === 0) return "-";
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx].toFixed(3);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const pairs = buildPairs();

  // Collect the unique cells to render, grouped by config.
  const cells = new Map<string, Cell>();
  for (const p of pairs) {
    cells.set(cellId(p.a), p.a);
    cells.set(cellId(p.b), p.b);
  }
  const configs = new Map<string, { cfg: Omit<Cell, "char">; chars: Set<string> }>();
  for (const c of cells.values()) {
    const key = `${c.family}|${c.weight}|${c.style}|${c.size}|${c.offset}`;
    const entry = configs.get(key) ?? {
      cfg: { family: c.family, weight: c.weight, style: c.style, size: c.size, offset: c.offset },
      chars: new Set<string>(),
    };
    entry.chars.add(c.char);
    configs.set(key, entry);
  }

  console.log(`rendering ${cells.size} cells across ${configs.size} configs (DPR 2)…`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 140 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const files = new Map<string, string>();
  for (const { cfg, chars } of configs.values()) {
    const rendered = await renderConfig(page, cfg, [...chars]);
    for (const [id, f] of rendered) files.set(id, f);
  }
  await browser.close();

  console.log(`scoring ${pairs.length} pairs…`);
  interface Scored extends PairSpec { result: GlyphCompareResult }
  const scored: Scored[] = [];
  for (const p of pairs) {
    const fa = files.get(cellId(p.a));
    const fb = files.get(cellId(p.b));
    if (fa == null || fb == null) { console.warn(`  skip (render missing): ${p.label}`); continue; }
    try {
      scored.push({ ...p, result: await compareGlyphPngs(fa, fb) });
    } catch (err) {
      console.warn(`  error: ${p.label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Per-metric distributions, same vs different.
  const groups: Record<string, Scored[]> = {};
  for (const s of scored) (groups[s.kind] ??= []).push(s);
  const metricNames = [
    "sizeDiffPx", "inkLogRatio", "ncc", "unexplainedMax", "d95", "hotspotMax",
    "strokeLogRatio", "contrastLogRatio", "orientL1", "zoningL2",
  ] as const;
  const metricOf = (s: Scored, name: string): number => {
    const m = s.result.metrics;
    if (name === "unexplainedMax") return Math.max(m.unexplainedA, m.unexplainedB);
    if (name === "inkLogRatio" || name === "strokeLogRatio" || name === "contrastLogRatio") {
      return Math.abs(m[name]);
    }
    return (m as unknown as Record<string, number>)[name];
  };
  console.log("\n== metric distributions (p50 / p95 / max — for ncc: min / p05 / p50) ==");
  for (const [kind, list] of Object.entries(groups)) {
    console.log(`\n[${kind}] n=${list.length}`);
    for (const name of metricNames) {
      const vals = list.map((s) => metricOf(s, name));
      if (name === "ncc") {
        const s = [...vals].sort((a, b) => a - b);
        console.log(`  ${name.padEnd(16)} min ${s[0].toFixed(4)}  p05 ${fmtP(vals, 5)}  p50 ${fmtP(vals, 50)}`);
      } else {
        console.log(`  ${name.padEnd(16)} p50 ${fmtP(vals, 50)}  p95 ${fmtP(vals, 95)}  max ${fmtP(vals, 100)}`);
      }
    }
  }

  // Confusion at DEFAULT_THRESHOLDS.
  let tp = 0, tn = 0, fp = 0, fn = 0, advisoryMatched = 0, advisoryCaught = 0;
  const misses: string[] = [];
  for (const s of scored) {
    const got = s.result.verdict;
    if (s.advisory) {
      if (got === "mismatch") advisoryCaught++; else advisoryMatched++;
      continue;
    }
    if (s.expect === "match") {
      if (got === "match") tn++;
      else { fp++; misses.push(`FALSE-MISMATCH: ${s.label} — ${s.result.reasons.join(" | ")}`); }
    } else {
      if (got === "mismatch") tp++;
      else { fn++; misses.push(`MISSED-MISMATCH: ${s.label} — ncc ${s.result.metrics.ncc.toFixed(4)}`); }
    }
  }
  console.log("\n== confusion at DEFAULT_THRESHOLDS ==");
  console.log(`  same pairs correct (match):        ${tn}  false-mismatch: ${fp}`);
  console.log(`  diff pairs caught (mismatch):      ${tp}  missed: ${fn}`);
  console.log(`  advisory pairs (weak chars / ~3% size / w500): caught ${advisoryCaught}, matched ${advisoryMatched}`);
  if (misses.length > 0) {
    console.log("\n== misclassified ==");
    for (const m of misses) console.log(`  ${m}`);
  }

  // Dump everything for offline threshold re-derivation.
  const dump = scored.map((s) => ({
    kind: s.kind, expect: s.expect, advisory: s.advisory, label: s.label,
    verdict: s.result.verdict, confidence: s.result.confidence,
    hardSignals: s.result.hardSignals, softSignals: s.result.softSignals,
    metrics: s.result.metrics,
  }));
  const jsonPath = join(OUT_DIR, "results.json");
  writeFileSync(jsonPath, JSON.stringify({ thresholds: DEFAULT_THRESHOLDS, pairs: dump }, null, 1));
  console.log(`\nwrote ${jsonPath}`);
}

void main();
