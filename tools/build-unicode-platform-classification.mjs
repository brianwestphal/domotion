#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [ticket, platform, resultPath, outputPath, expectedCountText] =
  process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (!ticket || !platform || !resultPath || !outputPath || !expectedCount) {
  throw new Error(
    "expected ticket, platform, results path, output path, and expected count",
  );
}

const results = JSON.parse(await readFile(resolve(resultPath), "utf8"));
const rows = results
  .filter((row) => !row.pass && !row.skipped)
  .map((row) => ({
    name: row.name,
    disposition: "functionally-clean-raster-residual",
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
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (rows.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} rows, found ${rows.length}`);
}

const output = {
  ticket,
  platform,
  originalSourceRun: 33314760708,
  reviewedComparisonRun: 33345443048,
  policy:
    "A row is functionally clean only when direct expected/actual review confirms the same glyph or tofu inventory, advances, cluster placement, and content; native-versus-embedded raster pixels remain recorded but are not a platform-functionality defect.",
  sourceAuthorities: [
    "external/chromium/third_party/blink/renderer/platform/fonts",
    "external/harfbuzz/src",
    "src/render/unicode-font-routing.win32.generated.ts",
    "tools/win32-glyph-extractor",
  ],
  counts: {
    total: rows.length,
    functionallyCleanRasterResiduals: rows.length,
  },
  rows,
};

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`);
