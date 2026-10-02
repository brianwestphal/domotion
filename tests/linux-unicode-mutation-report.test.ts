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
  hasLinuxUnicodeHelperOffFaceMutationEvidence,
} from "../src/review/linux-unicode-evidence.js";

const dir = mkdtempSync(join(tmpdir(), "linux-unicode-mutation-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Linux Unicode mutation reports", () => {
  it("admits all 24 rows through their own face-selection control via the real CLI", () => {
    const arms = ["baseline", "helper-off", "hint-off", "selection-reject"].map((name) => join(dir, "validated", name));
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
                    (armIndex === 1 && hasLinuxUnicodeHelperOffFaceMutationEvidence(fixture)) || armIndex === 3
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
    const argv = [
      "--baseline",
      arms[0],
      "--helper-off",
      arms[1],
      "--hint-off",
      arms[2],
      "--selection-reject",
      arms[3],
      "--out",
      out,
    ];
    expect(main(argv)).toBe(0);
    const matrix = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    const candidates = readLinuxUnicodeRasterCandidates(join(out, "dm-2352-raster-floor-candidates.json"));
    expect(matrix).toMatchObject({
      outcome: "pass",
      summary: { rasterFloorCandidates: 24, mutationInert: 0 },
      errors: [],
    });
    expect(candidates.fixtures).toHaveLength(24);
    expect(matrix.fixtures).toHaveLength(24);
    expect(
      readFileSync(join(arms[0], `${LINUX_UNICODE_RASTER_FLOOR_FIXTURES[0]}-mutation-evidence.json`), "utf8"),
    ).toContain('"verdict": "raster-floor-candidate"');

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
    expect(main(argv)).toBe(1);
    const drift = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    expect(drift.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("0180-024F-latin-extended-b: expected fontconfig-helper-off mutation did not move"),
      ]),
    );
    // A selection-reject-ratified row moving under helper-off too is not drift.
    expect(drift.errors.some((error) => error.startsWith("0080-00FF-latin-1-supplement"))).toBe(false);
    expect(readLinuxUnicodeRasterCandidates(join(out, "dm-2352-raster-floor-candidates.json")).fixtures).not.toContain(
      "0180-024F-latin-extended-b",
    );
  });

  it("requires the fontconfig selection-reject arm to move every row without a helper-off control", () => {
    const names = ["baseline", "helper-off", "hint-off", "selection-reject"] as const;
    const arms = Object.fromEntries(names.map((name) => [name, join(dir, "reject", name)])) as Record<
      (typeof names)[number],
      string
    >;
    const writeArm = (name: (typeof names)[number], moved: (fixture: string) => boolean): void => {
      mkdirSync(arms[name], { recursive: true });
      writeFileSync(
        join(arms[name], "results.json"),
        JSON.stringify(
          LINUX_UNICODE_RASTER_FLOOR_FIXTURES.map((fixture) => ({
            name: fixture,
            actualSha256: name === "hint-off" ? "unhinted" : "hinted",
            textRunEvidence: {
              fixture,
              runs: [
                {
                  fixture,
                  row: 0,
                  sourceSpan: [0, 1],
                  sourceCodepointSpan: [0, 1],
                  selected: moved(fixture)
                    ? { fontKey: "rejected", postscriptName: "Rejected", sourcePath: "/other.ttf", faceIndex: 0 }
                    : { fontKey: "base", postscriptName: "Base", sourcePath: "/base.ttf", faceIndex: 0 },
                  glyphs: [{ id: 1, cluster: 0, xAdvance: 1, yAdvance: 0, xOffset: 0, yOffset: 0 }],
                },
              ],
            },
            embeddedFontBuilds: [
              {
                instanceKey: fixture,
                selectedBuilder: name === "hint-off" ? "svg2ttf" : "hb-subset",
                retainedHintTableTags: name === "hint-off" ? [] : ["prep"],
              },
            ],
          })),
        ),
      );
    };
    writeArm("baseline", () => false);
    writeArm("helper-off", (fixture) => hasLinuxUnicodeHelperOffFaceMutationEvidence(fixture));
    writeArm("hint-off", () => false);
    writeArm("selection-reject", () => true);
    const out = join(dir, "reject", "reports");
    const argv = [
      "--baseline",
      arms.baseline,
      "--helper-off",
      arms["helper-off"],
      "--hint-off",
      arms["hint-off"],
      "--selection-reject",
      arms["selection-reject"],
      "--out",
      out,
    ];
    expect(main(argv)).toBe(0);
    const matrix = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    expect(matrix.errors).toEqual([]);
    const unratified = LINUX_UNICODE_RASTER_FLOOR_FIXTURES.filter(
      (f) => !hasLinuxUnicodeHelperOffFaceMutationEvidence(f),
    );
    expect(unratified).toHaveLength(10);

    // An inert rejection arm for an unratified row is a missing control.
    writeArm("selection-reject", (fixture) => fixture !== unratified[0]);
    expect(main(argv)).toBe(1);
    const inert = readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json"));
    expect(inert.errors).toEqual([
      `${unratified[0]}: fontconfig selection-reject mutation did not move a selected-face row`,
    ]);
    // Its own control is inert, so it can no longer be a raster-floor candidate.
    expect(readLinuxUnicodeRasterCandidates(join(out, "dm-2352-raster-floor-candidates.json")).fixtures).not.toContain(
      unratified[0],
    );

    // Omitting the arm altogether is a missing control, not a pass.
    expect(
      main(
        argv.filter((_, i) => i !== argv.indexOf("--selection-reject") && i !== argv.indexOf("--selection-reject") + 1),
      ),
    ).toBe(1);
    expect(readLinuxUnicodeMutationMatrix(join(out, "linux-unicode-mutation-matrix.json")).errors).toContain(
      "missing selection-reject arm: ratified rows depend on it as their face-selection control",
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
    // 24 incomplete rows plus the missing selection-reject arm.
    expect(matrix.errors).toHaveLength(25);
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
