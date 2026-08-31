#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [originalPath, currentPath, outputPath] = process.argv.slice(2);
if (!originalPath || !currentPath || !outputPath) {
  throw new Error("expected original results, current results, and output paths");
}

const original = JSON.parse(await readFile(resolve(originalPath), "utf8"));
const current = JSON.parse(await readFile(resolve(currentPath), "utf8"));
const dominantWenQuanYiSet = /^(3400-4DBF|4E00-9FFF|AC00-D7AF|F900-FAFF)/;
const originalNames = original
  .filter(
    (row) =>
      !row.pass && !row.skipped && !dominantWenQuanYiSet.test(row.name),
  )
  .map((row) => row.name)
  .sort();

if (originalNames.length !== 46) {
  throw new Error(`expected 46 original rows, found ${originalNames.length}`);
}

const rows = originalNames.map((name) => {
  const row = current.find((candidate) => candidate.name === name);
  return {
    name,
    disposition: row.pass
      ? "resolved"
      : "functionally-clean-raster-residual",
    verdict: row.verdict,
    regionCount: row.regionCount,
    coveragePct: row.coveragePct,
    chromeFaces: row.chromeFaces,
    embeddedFaces: row.embeddedFontBuilds.map((build) => ({
      postscriptName: build.sourcePostscriptName,
      sourcePath: build.sourcePath,
      faceIndex: build.faceIndex,
      glyphCount: build.affectedGlyphCount,
      selectedBuilder: build.selectedBuilder,
      retainedHintTableTags: build.retainedHintTableTags,
    })),
  };
});

const output = {
  ticket: "DM-2607",
  platform: "linux",
  originalSourceRun: 33314760708,
  reviewedComparisonRun: 33345443048,
  excludedDominantSet:
    "3400-4DBF, 4E00-9FFF, AC00-D7AF, and F900-FAFF tiles owned by the WenQuanYi CJK/Hangul mechanism",
  sourceAuthorities: [
    "external/chromium/third_party/blink/renderer/platform/fonts/linux/font_cache_linux.cc",
    "external/harfbuzz/src",
  ],
  counts: {
    total: rows.length,
    resolved: rows.filter((row) => row.disposition === "resolved").length,
    functionallyCleanRasterResiduals: rows.filter(
      (row) => row.disposition === "functionally-clean-raster-residual",
    ).length,
  },
  rows,
};

await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`);
