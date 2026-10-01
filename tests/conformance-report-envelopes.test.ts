import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../tools/lib/report.js";
import {
  readClusterConformanceReport,
  readDecorationReport,
  readFontConformanceReport,
  readShapingConformanceReport,
} from "../tools/conformance-report-schemas.js";

const legacyReports = {
  font: {
    meta: { platform: "darwin", arch: "arm64", chromium: "test" },
    summary: { mismatchTotal: 0, comparisons: 1 },
  },
  shaping: { meta: { platform: "darwin", chromium: "test" }, summary: { mismatchTotal: 1 }, mismatches: [{}] },
  cluster: { meta: { agreed: 0, mismatched: 0, skipped: 1 }, results: [{ verdict: "skip" }] },
  decoration: {
    platform: "linux",
    architecture: "arm64",
    coordinateOwnership: { source: "test" },
    gates: { transcription: true, skipInk: true, svgGeometry: true },
    results: [{ transcription: { ok: true }, svgGeometry: { ok: true }, skipInk: null }],
  },
};

describe("conformance report envelopes", () => {
  it.each([
    ["font-conformance", legacyReports.font, readFontConformanceReport, "pass"],
    ["shaping-conformance", legacyReports.shaping, readShapingConformanceReport, "fail"],
    ["cluster-conformance", legacyReports.cluster, readClusterConformanceReport, "skip"],
    ["decoration-oracle", legacyReports.decoration, readDecorationReport, "pass"],
  ] as const)("accepts legacy and current %s, rejects future versions", (tool, legacy, read, outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-conformance-report-"));
    const path = join(dir, "nested", "report.json");
    writeFileSync(join(dir, "legacy.json"), JSON.stringify(legacy));
    expect(read(join(dir, "legacy.json")).outcome).toBe(outcome);

    writeReport(path, tool, { ...legacy, outcome }, { schemaVersion: 1, env: { platform: "test" } });
    expect(JSON.parse(readFileSync(path, "utf8")).tool).toBe(tool);
    expect(read(path).outcome).toBe(outcome);

    const future = JSON.parse(readFileSync(path, "utf8"));
    future.schemaVersion = 2;
    writeFileSync(path, JSON.stringify(future));
    expect(() => read(path)).toThrow();
    future.schemaVersion = 1;
    future.tool = "other-tool";
    writeFileSync(path, JSON.stringify(future));
    expect(() => read(path)).toThrow();
  });
});
