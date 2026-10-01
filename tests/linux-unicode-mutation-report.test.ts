import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeReport } from "../tools/lib/report.js";
import { main } from "../tools/linux-unicode-mutation-matrix.js";
import {
  readLinuxUnicodeMutationMatrix,
  readLinuxUnicodeRasterCandidates,
} from "../tools/linux-unicode-mutation-report.js";
import {
  LINUX_UNICODE_RASTER_FLOOR_FIXTURES,
  hasLinuxUnicodeFaceMutationEvidence,
} from "../src/review/linux-unicode-evidence.js";

const dir = mkdtempSync(join(tmpdir(), "linux-unicode-mutation-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Linux Unicode mutation reports", () => {
  it("admits 14 active rows and retains ten unclassified sidecars through the real CLI", () => {
    const arms = ["baseline", "helper-off", "hint-off"].map((name) => join(dir, "validated", name));
    for (const arm of arms) mkdirSync(arm, { recursive: true });
    const rows = LINUX_UNICODE_RASTER_FLOOR_FIXTURES.map((fixture) => ({
      fixture,
      run: {
        fixture,
        row: 0,
        sourceSpan: [0, 1],
        sourceCodepointSpan: [0, 1],
        selected: { fontKey: "base", postscriptName: "Base", sourcePath: "/base.ttf", faceIndex: 0 },
        glyphs: [{ id: 1, cluster: 0, xAdvance: 1, yAdvance: 0, xOffset: 0, yOffset: 0 }],
      },
    }));
    for (const [armIndex, arm] of arms.entries()) {
      writeFileSync(
        join(arm, "results.json"),
        JSON.stringify(
          rows.map(({ fixture, run }) => ({
            name: fixture,
            actualSha256: armIndex === 2 ? "unhinted" : "hinted",
            textRunEvidence: {
              fixture,
              runs: [
                {
                  ...run,
                  selected:
                    armIndex === 1 && hasLinuxUnicodeFaceMutationEvidence(fixture)
                      ? { ...run.selected, fontKey: "fallback", postscriptName: "Fallback" }
                      : run.selected,
                },
              ],
            },
            embeddedFontBuilds: [
              {
                instanceKey: fixture,
                selectedBuilder: armIndex === 2 ? "svg2ttf" : "hb-subset",
                retainedHintTableTags: armIndex === 2 ? [] : ["prep"],
              },
            ],
          })),
        ),
      );
    }
    const out = join(dir, "validated", "reports");
    expect(main(["--baseline", arms[0], "--helper-off", arms[1], "--hint-off", arms[2], "--out", out])).toBe(0);
    const matrix = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    const candidates = readLinuxUnicodeRasterCandidates(join(out, "dm-2352-raster-floor-candidates.json"));
    expect(matrix).toMatchObject({
      outcome: "pass",
      summary: { rasterFloorCandidates: 14, mutationInert: 10 },
      errors: [],
    });
    expect(candidates.fixtures).toHaveLength(14);
    expect(matrix.fixtures).toHaveLength(24);
    expect(
      readFileSync(join(arms[0], `${LINUX_UNICODE_RASTER_FLOOR_FIXTURES[0]}-mutation-evidence.json`), "utf8"),
    ).toContain('"verdict": "mutation-inert"');

    const helperPath = join(arms[1], "results.json");
    const helperRows = JSON.parse(readFileSync(helperPath, "utf8")) as Array<{
      name: string;
      textRunEvidence: { runs: Array<{ selected: Record<string, unknown> }> };
    }>;
    helperRows.find((row) => row.name === "0180-024F-latin-extended-b")!.textRunEvidence.runs[0].selected = {
      fontKey: "base",
      postscriptName: "Base",
      sourcePath: "/base.ttf",
      faceIndex: 0,
    };
    helperRows.find((row) => row.name === "0080-00FF-latin-1-supplement")!.textRunEvidence.runs[0].selected = {
      fontKey: "fallback",
      postscriptName: "Fallback",
      sourcePath: "/base.ttf",
      faceIndex: 0,
    };
    writeFileSync(helperPath, JSON.stringify(helperRows));
    expect(main(["--baseline", arms[0], "--helper-off", arms[1], "--hint-off", arms[2], "--out", out])).toBe(1);
    const drift = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    expect(drift.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("0180-024F-latin-extended-b: expected fontconfig-helper-off mutation did not move"),
        expect.stringContaining(
          "0080-00FF-latin-1-supplement: newly moved selected-face row requires corpus re-ratification",
        ),
      ]),
    );
    expect(readLinuxUnicodeRasterCandidates(join(out, "dm-2352-raster-floor-candidates.json")).fixtures).not.toContain(
      "0080-00FF-latin-1-supplement",
    );
  });

  it("writes nested versioned reports through the real CLI when arms are incomplete", () => {
    const arms = ["baseline", "helper-off", "hint-off"].map((name) => join(dir, name));
    for (const arm of arms) {
      mkdirSync(arm, { recursive: true });
      writeFileSync(join(arm, "results.json"), "[]\n");
    }
    const out = join(dir, "nested", "reports");
    expect(main(["--baseline", arms[0], "--helper-off", arms[1], "--hint-off", arms[2], "--out", out])).toBe(1);
    const matrixPath = join(out, "linux-unicode-mutation-matrix.json");
    const candidatesPath = join(out, "dm-2352-raster-floor-candidates.json");
    const matrix = readLinuxUnicodeMutationMatrix(matrixPath);
    const candidates = readLinuxUnicodeRasterCandidates(candidatesPath);
    expect(matrix.outcome).toBe("fail");
    expect(matrix.summary.incomplete).toBe(24);
    expect(matrix.errors).toHaveLength(24);
    expect(candidates).toMatchObject({ outcome: "skip", fixtures: [] });
    expect(JSON.parse(readFileSync(matrixPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      tool: "linux-unicode-mutation-matrix",
      data: { outcome: "fail" },
    });
  });

  it("reads legacy matrix and candidate files and rejects unknown versions", () => {
    const matrixPath = join(dir, "legacy-matrix.json");
    const candidatesPath = join(dir, "legacy-candidates.json");
    const rawMatrix = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      corpus: "DM-2421-linux-unicode-non-vedic-24",
      sourceAuthority: null,
      fixtures: [],
      summary: { total: 0, rasterFloorCandidates: 0, logicalMismatches: 0, mutationInert: 0, incomplete: 0 },
      errors: [],
    };
    writeFileSync(matrixPath, JSON.stringify(rawMatrix));
    writeFileSync(
      candidatesPath,
      JSON.stringify({ schemaVersion: 1, source: "linux-unicode-mutation-matrix.json", fixtures: [] }),
    );
    expect(readLinuxUnicodeMutationMatrix(matrixPath).outcome).toBe("pass");
    expect(readLinuxUnicodeRasterCandidates(candidatesPath).outcome).toBe("skip");
    writeFileSync(matrixPath, JSON.stringify({ ...rawMatrix, schemaVersion: 2 }));
    expect(() => readLinuxUnicodeMutationMatrix(matrixPath)).toThrow("unsupported legacy");
    writeFileSync(candidatesPath, JSON.stringify({ schemaVersion: 2, source: "linux-unicode-mutation-matrix.json" }));
    expect(() => readLinuxUnicodeRasterCandidates(candidatesPath)).toThrow("unsupported legacy");
    writeReport(
      matrixPath,
      "linux-unicode-mutation-matrix",
      { ...rawMatrix, errors: ["drift"], outcome: "pass" },
      { schemaVersion: 1 },
    );
    expect(() => readLinuxUnicodeMutationMatrix(matrixPath)).toThrow("matrix outcome must agree");
    writeReport(
      candidatesPath,
      "linux-unicode-raster-candidates",
      { schemaVersion: 1, source: "linux-unicode-mutation-matrix.json", fixtures: [], outcome: "skip" },
      { schemaVersion: 2 },
    );
    expect(() => readLinuxUnicodeRasterCandidates(candidatesPath)).toThrow();
  });
});
