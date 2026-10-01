import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeReport } from "../tools/lib/report.js";
import { readPseudoFragmentRenderReport } from "../tools/pseudo-fragment-render-report.js";

const dir = mkdtempSync(join(tmpdir(), "pseudo-fragment-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const report = {
  schemaVersion: 1 as const,
  chromiumVersion: "147.0.0.0",
  platform: "darwin",
  architecture: "arm64",
  toleranceDevicePixels: 4 as const,
  requiredStates: ["before", "after"],
  rows: [
    {
      dpr: 1,
      exactRecords: 2,
      terminalRecords: 0,
      terminalReasons: [],
      renderedRecords: 2,
      sourceEdges: 12,
      renderedEdges: 12,
      maxEdgeDistanceDevicePixels: 0,
      unmatchedSourceEdges: 0,
      unmatchedRenderedEdges: 0,
      structuralErrors: [],
      pass: true,
    },
  ],
  verdict: "source-exact" as const,
};

describe("pseudo-fragment render report", () => {
  it("reads a nested versioned report with its normalized outcome", () => {
    const path = join(dir, "nested", "report.json");
    writeReport(path, "pseudo-fragment-render-oracle", { ...report, outcome: "pass" }, { schemaVersion: 1 });
    expect(readPseudoFragmentRenderReport(path)).toMatchObject({ verdict: "source-exact", outcome: "pass" });
  });

  it("reads the legacy report and derives its outcome", () => {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(report));
    expect(readPseudoFragmentRenderReport(path)).toMatchObject({ verdict: "source-exact", outcome: "pass" });
  });

  it("rejects unknown outer and legacy versions and an inconsistent outcome", () => {
    const path = join(dir, "invalid.json");
    writeReport(path, "pseudo-fragment-render-oracle", { ...report, outcome: "pass" }, { schemaVersion: 2 });
    expect(() => readPseudoFragmentRenderReport(path)).toThrow();
    writeFileSync(path, JSON.stringify({ ...report, schemaVersion: 2 }));
    expect(() => readPseudoFragmentRenderReport(path)).toThrow("unsupported legacy");
    writeReport(path, "pseudo-fragment-render-oracle", { ...report, outcome: "fail" }, { schemaVersion: 1 });
    expect(() => readPseudoFragmentRenderReport(path)).toThrow("outcome must agree");
  });
});
