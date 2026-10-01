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

const dir = mkdtempSync(join(tmpdir(), "linux-unicode-mutation-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Linux Unicode mutation reports", () => {
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
