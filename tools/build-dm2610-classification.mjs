#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [oldRoot, reviewRoot, outputPath] = process.argv.slice(2);
if (!oldRoot || !reviewRoot || !outputPath) {
  throw new Error("expected old-results root, review root, and output path");
}

const platforms = ["macos", "linux", "windows"];
const wideImageFixtures = new Set([
  "07-deep-image-rendering",
  "17-bg-color-image",
  "17-deep-bg-attachment-fixed",
  "17-deep-bg-clip-text",
  "17-deep-image-set",
  "17-gradient-linear",
  "19-color-opacity",
  "22-backdrop-filter",
  "22-blend-modes",
  "22-deep-blend-groups",
  "22-deep-filter-stacking",
  "23-clip-path",
  "23-mask",
]);

const old = Object.fromEntries(
  await Promise.all(
    platforms.map(async (platform) => [
      platform,
      JSON.parse(
        await readFile(resolve(oldRoot, `results-${platform}.json`), "utf8"),
      ),
    ]),
  ),
);
const current = Object.fromEntries(
  await Promise.all(
    platforms.map(async (platform) => [
      platform,
      JSON.parse(
        await readFile(
          resolve(reviewRoot, `ci-${platform}/html-test/results.json`),
          "utf8",
        ),
      ),
    ]),
  ),
);

const failedSets = platforms.map(
  (platform) =>
    new Set(
      old[platform]
        .filter((row) => !row.pass && !row.skipped)
        .map((row) => row.name),
    ),
);
const names = [...failedSets[0]]
  .filter(
    (name) =>
      failedSets.slice(1).every((set) => set.has(name)) &&
      !wideImageFixtures.has(name),
  )
  .sort();

const implementationTickets = {
  "24-generated-content": "DM-2616",
  "niche-select-customizable": "DM-2615",
};
const rows = names.map((name) => {
  const platformEvidence = platforms.map((platform) => {
    const row = current[platform].find((candidate) => candidate.name === name);
    return {
      platform,
      verdict: row.verdict,
      regionCount: row.regionCount,
      coveragePct: row.coveragePct,
      chromeFaces: row.chromeFaces,
      embeddedFaces: row.embeddedFontBuilds.map(
        (build) => build.sourcePostscriptName,
      ),
    };
  });
  return {
    name,
    disposition: implementationTickets[name]
      ? "functional-defect"
      : "functionally-clean-raster-residual",
    implementationTicket: implementationTickets[name] ?? null,
    platformEvidence,
  };
});

if (rows.length !== 43) {
  throw new Error(`expected 43 rows, found ${rows.length}`);
}

const output = {
  ticket: "DM-2610",
  sourceRun: 33314760277,
  comparisonRun: 33345443071,
  excludedWideImageTicket: "DM-2605",
  sourceAuthorities: [
    "external/chromium/third_party/blink/renderer/core/layout",
    "external/chromium/third_party/blink/renderer/core/paint",
    "external/chromium/third_party/blink/renderer/platform/fonts",
  ],
  policy:
    "Functional correctness is required on all three platforms; coincident geometry/content with native raster differences is not an implementation defect.",
  counts: {
    total: rows.length,
    functionalDefects: rows.filter(
      (row) => row.disposition === "functional-defect",
    ).length,
    functionallyCleanRasterResiduals: rows.filter(
      (row) => row.disposition === "functionally-clean-raster-residual",
    ).length,
  },
  rows,
};

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`);
