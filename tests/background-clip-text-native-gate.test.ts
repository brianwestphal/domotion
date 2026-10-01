import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adjudicateBackgroundClipTextNativeReports,
  readBackgroundClipTextNativeReport,
} from "../tools/background-clip-text-native-gate.js";
import type { BackgroundClipTextOracleReport } from "../tools/background-clip-text-oracle.js";
import { writeReport } from "../tools/lib/report.js";

function report(platform: "linux" | "win32"): BackgroundClipTextOracleReport & { outcome: "pass" } {
  return {
    schemaVersion: 2,
    chromiumVersion: "147",
    chromiumExecutable: `/chromium/${platform}`,
    chromiumExecutableSha256: "a".repeat(64),
    platform,
    architecture: "x64",
    sourceRevisions: {
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skia: "62efacd37737505732dbe3d8daa62abd679626a1",
    },
    paintedFonts: Array.from({ length: 8 }, (_, index) => ({
      id: `${index}`,
      fonts: [{ familyName: "Arial", glyphCount: 1 }],
    })),
    logicalControls: {
      exactDprs: true,
      authenticatedBinary: true,
      authenticatedFonts: true,
      urlOwnership: true,
      alphaMaskOwnership: true,
      vectorPatternOwnership: true,
      zoomTransformClipOwnership: true,
      removeMaskMoves: true,
      removePatternMoves: true,
      removeTransformMoves: true,
    },
    toleranceDevicePixels: 4,
    requiredStates: [],
    rows: [1, 2].map((dpr) => ({
      dpr,
      capturedUrlLayers: 6,
      alphaMasks: 7,
      vectorPatterns: 6,
      sourceSignalPixels: 1,
      renderedSignalPixels: 1,
      sourceEdges: 1,
      renderedEdges: 1,
      maxEdgeDistanceDevicePixels: 0,
      unmatchedSourceEdges: 0,
      unmatchedRenderedEdges: 0,
      structuralErrors: [],
      pass: true,
    })),
    verdict: "source-exact",
    outcome: "pass",
  };
}

describe("DM-2530 native background-clip:text aggregator", () => {
  it("requires independent Linux and Windows DPR1/2 source-exact evidence", () => {
    expect(adjudicateBackgroundClipTextNativeReports([report("linux"), report("win32")])).toEqual([]);
    const forged = report("win32");
    forged.logicalControls.removeMaskMoves = false;
    expect(adjudicateBackgroundClipTextNativeReports([report("linux"), forged])).toContain(
      "win32: logical ownership/control failure",
    );
    expect(adjudicateBackgroundClipTextNativeReports([report("linux"), report("linux")])).toContain(
      "unexpected or duplicate platform linux",
    );
  });

  it("reads nested envelope and explicit legacy v2, rejecting an unknown version before adjudication", () => {
    const dir = mkdtempSync(join(tmpdir(), "background-clip-report-"));
    try {
      const currentPath = join(dir, "nested", "report.json");
      const legacyPath = join(dir, "legacy.json");
      writeReport(currentPath, "background-clip-text-oracle", report("linux"), { schemaVersion: 1 });
      expect(JSON.parse(readFileSync(currentPath, "utf8")).data.outcome).toBe("pass");
      writeFileSync(legacyPath, JSON.stringify({ ...report("win32"), outcome: undefined }));
      expect(
        adjudicateBackgroundClipTextNativeReports([
          readBackgroundClipTextNativeReport(currentPath),
          readBackgroundClipTextNativeReport(legacyPath),
        ]),
      ).toEqual([]);
      writeFileSync(legacyPath, JSON.stringify({ ...report("win32"), schemaVersion: 3 }));
      expect(() => readBackgroundClipTextNativeReport(legacyPath)).toThrow(/unsupported legacy/);
      writeReport(currentPath, "background-clip-text-oracle", report("linux"), { schemaVersion: 2 });
      expect(() => readBackgroundClipTextNativeReport(currentPath)).toThrow();
      writeReport(
        currentPath,
        "background-clip-text-oracle",
        { ...report("linux"), outcome: "fail" },
        { schemaVersion: 1 },
      );
      expect(() => readBackgroundClipTextNativeReport(currentPath)).toThrow(/outcome disagrees/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
