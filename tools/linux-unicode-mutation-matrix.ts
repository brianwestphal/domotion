import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain, parseFlags, requiredFlag, runMain } from "./lib/cli.js";
import type { EmbeddedFontBuildDiagnostic } from "../src/render/embedded-font-builder.js";
import type { FixtureTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  LINUX_UNICODE_RASTER_FLOOR_FIXTURES,
  compareLinuxUnicodeMutations,
  validateFixtureTextEvidence,
} from "../src/review/linux-unicode-evidence.js";

interface ResultRow {
  name: string;
  actualSha256?: string;
  textRunEvidence?: FixtureTextRunProvenance;
  embeddedFontBuilds?: EmbeddedFontBuildDiagnostic[];
  [key: string]: unknown;
}

function readRows(directory: string): Map<string, ResultRow> {
  const rows = JSON.parse(readFileSync(resolve(directory, "results.json"), "utf8")) as ResultRow[];
  return new Map(rows.map((row) => [row.name, row]));
}

function main(args: string[]): number {
  const flags = parseFlags(args, {
    "print-fixtures": { type: "boolean" },
    baseline: { type: "string" },
    "helper-off": { type: "string" },
    "hint-off": { type: "string" },
    out: { type: "string" },
  });
  if (flags["print-fixtures"] === true) {
    process.stdout.write(LINUX_UNICODE_RASTER_FLOOR_FIXTURES.join(","));
    return 0;
  } else {
    const baselineDir = resolve(requiredFlag(flags, "--baseline"));
    const helperOffDir = resolve(requiredFlag(flags, "--helper-off"));
    const hintOffDir = resolve(requiredFlag(flags, "--hint-off"));
    const outputDir = resolve(requiredFlag(flags, "--out"));
    const arms = {
      baseline: readRows(baselineDir),
      fontconfigHelperOff: readRows(helperOffDir),
      hintedSubsetOff: readRows(hintOffDir),
    };
    const errors: string[] = [];
    const fixtures = LINUX_UNICODE_RASTER_FLOOR_FIXTURES.map((fixture) => {
      const baseline = arms.baseline.get(fixture);
      const helperOff = arms.fontconfigHelperOff.get(fixture);
      const hintOff = arms.hintedSubsetOff.get(fixture);
      if (baseline == null || helperOff == null || hintOff == null) {
        errors.push(
          `${fixture}: missing arm(s): ${[
            baseline == null ? "baseline" : "",
            helperOff == null ? "fontconfig-helper-off" : "",
            hintOff == null ? "hinted-subset-off" : "",
          ]
            .filter(Boolean)
            .join(", ")}`,
        );
        return { fixture, verdict: "incomplete" as const };
      }
      for (const [arm, row] of [
        ["baseline", baseline],
        ["fontconfig-helper-off", helperOff],
        ["hinted-subset-off", hintOff],
      ] as const) {
        if (row.textRunEvidence == null) errors.push(`${fixture}/${arm}: missing textRunEvidence`);
        if (row.actualSha256 == null) errors.push(`${fixture}/${arm}: missing actualSha256`);
      }
      if (
        baseline.textRunEvidence == null ||
        helperOff.textRunEvidence == null ||
        hintOff.textRunEvidence == null ||
        baseline.actualSha256 == null ||
        hintOff.actualSha256 == null
      ) {
        return { fixture, verdict: "incomplete" as const };
      }
      errors.push(
        ...validateFixtureTextEvidence(fixture, baseline.textRunEvidence).map(
          (error) => `${fixture}/baseline: ${error}`,
        ),
      );
      const verdict = compareLinuxUnicodeMutations(
        baseline.textRunEvidence,
        helperOff.textRunEvidence,
        hintOff.textRunEvidence,
        baseline.embeddedFontBuilds ?? [],
        hintOff.embeddedFontBuilds ?? [],
        baseline.actualSha256,
        hintOff.actualSha256,
      );
      if (verdict.selectedFaceRowsMoved === 0)
        errors.push(`${fixture}: fontconfig-helper-off mutation did not move a selected-face row`);
      if (!verdict.hintedLogicalRowsExact)
        errors.push(`${fixture}: hinted-subset-off changed logical evidence (logical-mismatch)`);
      if (verdict.hintedBuilderRowsMoved === 0)
        errors.push(`${fixture}: hinted-subset-off did not move an embedded builder row`);
      if (!verdict.retainedHintTablesRemoved) errors.push(`${fixture}: hinted-subset-off retained hint tables`);
      if (!verdict.hintedRasterMoved) errors.push(`${fixture}: hinted-subset-off raster was byte-identical`);
      return {
        fixture,
        verdict: verdict.verdict,
        measurements: verdict,
        arms: {
          baseline: {
            actualSha256: baseline.actualSha256,
            textRunEvidence: baseline.textRunEvidence,
            embeddedFontBuilds: baseline.embeddedFontBuilds ?? [],
          },
          fontconfigHelperOff: {
            actualSha256: helperOff.actualSha256,
            textRunEvidence: helperOff.textRunEvidence,
            embeddedFontBuilds: helperOff.embeddedFontBuilds ?? [],
          },
          hintedSubsetOff: {
            actualSha256: hintOff.actualSha256,
            textRunEvidence: hintOff.textRunEvidence,
            embeddedFontBuilds: hintOff.embeddedFontBuilds ?? [],
          },
        },
      };
    });

    mkdirSync(outputDir, { recursive: true });
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      corpus: "DM-2421-linux-unicode-non-vedic-24",
      sourceAuthority: fixtures.find((row) => "arms" in row)?.arms?.baseline.textRunEvidence.sourceAuthority ?? null,
      fixtures,
      summary: {
        total: fixtures.length,
        rasterFloorCandidates: fixtures.filter((row) => row.verdict === "raster-floor-candidate").length,
        logicalMismatches: fixtures.filter((row) => row.verdict === "logical-mismatch").length,
        mutationInert: fixtures.filter((row) => row.verdict === "mutation-inert").length,
        incomplete: fixtures.filter((row) => row.verdict === "incomplete").length,
      },
      errors,
    };
    writeFileSync(resolve(outputDir, "linux-unicode-mutation-matrix.json"), JSON.stringify(report, null, 2));
    writeFileSync(
      resolve(outputDir, "dm-2352-raster-floor-candidates.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          source: "linux-unicode-mutation-matrix.json",
          fixtures: fixtures.filter((row) => row.verdict === "raster-floor-candidate").map((row) => row.fixture),
        },
        null,
        2,
      ),
    );
    for (const row of fixtures) {
      writeFileSync(resolve(baselineDir, `${row.fixture}-mutation-evidence.json`), JSON.stringify(row, null, 2));
    }
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      return 1;
    } else {
      console.log(
        `Validated ${fixtures.length} Linux Unicode rows; ${report.summary.rasterFloorCandidates} raster-floor candidates.`,
      );
    }
    return 0;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
