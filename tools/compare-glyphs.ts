#!/usr/bin/env tsx
/**
 * DM-1686 — glyph font-identity comparator CLI.
 *
 * Given two PNG crops of the SAME character (expected vs actual), decide
 * whether they were rendered with the same font (family + size + weight +
 * style) — verdict CORRECT — or a different one — verdict INCORRECT.
 * Deterministic traditional CV (no ML); anti-aliasing and subpixel-position
 * noise are excluded by design. See docs/98-glyph-font-compare.md for the
 * methodology, calibration, and crop requirements (single glyph per crop,
 * solid background, same nominal scale, ink height ideally ≥ 32 px — capture
 * at 2×+ DPR).
 *
 * Usage:
 *   npx tsx tools/compare-glyphs.ts expected.png actual.png
 *   npx tsx tools/compare-glyphs.ts big-expected.png big-actual.png \
 *     --rect-a 120,80,48,56 --rect-b 118,80,48,56     # x,y,w,h crops
 *   npx tsx tools/compare-glyphs.ts a.png b.png --json  # full metrics JSON
 *
 * Exit codes: 0 = CORRECT (match), 1 = INCORRECT (mismatch), 2 = error
 * (unusable input: blank / too small / unreadable).
 */
import { compareGlyphPngs, type GlyphCompareResult } from "../src/review/glyph-compare.js";
import { flag, isMain, parseCommand, runMain } from "./lib/cli.js";

function parseRect(s: string): { x: number; y: number; w: number; h: number } {
  const parts = s.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`bad --rect value "${s}" — expected x,y,w,h`);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function usage(): never {
  throw new Error(
    "usage: compare-glyphs.ts <expected.png> <actual.png> [--rect-a x,y,w,h] [--rect-b x,y,w,h] [--json]",
  );
}

export async function compareGlyphs(argv: string[]): Promise<number> {
  const { values, positionals: files } = parseCommand(argv, {
    "rect-a": { type: "string" },
    "rect-b": { type: "string" },
    json: { type: "boolean" },
  });
  const rectAValue = flag(values, "rect-a");
  const rectBValue = flag(values, "rect-b");
  const rectA = typeof rectAValue === "string" ? parseRect(rectAValue) : undefined;
  const rectB = typeof rectBValue === "string" ? parseRect(rectBValue) : undefined;
  const json = flag(values, "json", false) === true;
  if (files.length !== 2) usage();

  let result: GlyphCompareResult;
  try {
    result = await compareGlyphPngs(files[0], files[1], { rectA, rectB });
  } catch (err) {
    throw new Error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (json) {
    console.log(JSON.stringify({ ...result, correct: result.verdict === "match" }, null, 2));
  } else {
    const m = result.metrics;
    console.log(`${result.verdict === "match" ? "CORRECT" : "INCORRECT"} (${result.confidence} confidence)`);
    for (const r of result.reasons) console.log(`  • ${r}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    console.log(
      `  ink ${m.inkWidthA}×${m.inkHeightA} vs ${m.inkWidthB}×${m.inkHeightB}` +
        ` · ncc ${m.ncc.toFixed(4)} · d95 ${m.d95.toFixed(2)}px` +
        ` · unexplained ${(Math.max(m.unexplainedA, m.unexplainedB) * 100).toFixed(2)}%` +
        ` · mass ×${Math.exp(Math.abs(m.inkLogRatio)).toFixed(3)}` +
        ` · hotspot ${m.hotspotMax.toFixed(2)}` +
        ` · stroke ${m.strokeWidthA.toFixed(2)}/${m.strokeWidthB.toFixed(2)}px` +
        ` · orient ${m.orientL1.toFixed(3)} · holes ${m.holesA}/${m.holesB}` +
        ` · zoning ${m.zoningL2.toFixed(4)}`,
    );
  }
  return result.verdict === "match" ? 0 : 1;
}

if (isMain(import.meta.url)) await runMain(() => compareGlyphs(process.argv.slice(2)));
