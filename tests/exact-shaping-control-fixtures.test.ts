import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  runApplicableShapingControls,
  sfntTableTags,
  VARIABLE_FIXTURE_SHA256,
  TRACKING_FIXTURE_SHA256,
  type ExactControlGlyph,
} from "../tools/exact-shaping-control-fixtures.js";

function asciiGlyphs(ids: number[], advances: number[]): ExactControlGlyph[] {
  return ids.map((id, index) => ({
    id,
    cluster: index,
    sourceSpan: [index, index + 1],
    xAdvance: advances[index],
    yAdvance: 0,
    xOffset: 0,
    yOffset: 0,
    flags: 0,
    unsafeToBreak: false,
  }));
}

describe("DM-2500 portable exact-shaping controls", () => {
  it("proves both variable axes by destructively dropping non-default coordinates", () => {
    const report = runApplicableShapingControls();
    const rows = report.controlRows.filter((candidate) => candidate.control === "axes");
    expect(rows.map((row) => row.id)).toEqual([
      "open-sans-wght-800-to-default",
      "open-sans-wdth-75-to-default",
    ]);
    const ids = [43, 68, 80, 69, 88, 85, 74, 72, 73, 82, 81, 86, 87, 76, 89];
    const defaultGlyphs = asciiGlyphs(
      ids,
      [1510, 1138, 1896, 1253, 1256, 837, 1112, 1150, 689, 1232, 1256, 976, 730, 517, 1023],
    );
    const baselines = [
      asciiGlyphs(ids, [1569, 1276, 2048, 1317, 1372, 961, 1241, 1266, 846, 1305, 1372, 1059, 942, 666, 1251]),
      asciiGlyphs(ids, [1081, 841, 1380, 937, 923, 614, 790, 847, 509, 902, 923, 688, 519, 424, 741]),
    ];

    expect(rows.map((row) => row.baseline.axes)).toEqual([
      { wght: 800, wdth: 100 },
      { wght: 400, wdth: 75 },
    ]);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({
        required: true,
        fixture: {
          expectedSha256: VARIABLE_FIXTURE_SHA256,
          decodedSha256: VARIABLE_FIXTURE_SHA256,
          requiredTables: ["fvar", "gvar"],
        },
        baseline: { fontSizePx: 48 },
        destructiveMutation: { fontSizePx: 48, axes: null },
        expectedChangedFields: ["xAdvance"],
        changedFields: ["xAdvance"],
        applicability: { status: "applicable", reason: null },
        movement: { status: "moved-as-expected", reason: null },
        applicable: true,
        movementProven: true,
        rasterization: "out-of-scope",
      });
      expect(row.baseline.expected.glyphs).toEqual(baselines[index]);
      expect(row.baseline.actual?.glyphs).toEqual(baselines[index]);
      expect(row.destructiveMutation.expected.glyphs).toEqual(defaultGlyphs);
      expect(row.destructiveMutation.actual?.glyphs).toEqual(defaultGlyphs);
      expect(row.baseline.actual?.logicalSha256).toBe(row.baseline.expected.logicalSha256);
      expect(row.destructiveMutation.actual?.logicalSha256).toBe(row.destructiveMutation.expected.logicalSha256);
    }
  });

  it("proves ptem by destructively unsetting the upstream TRAK golden's size", () => {
    const report = runApplicableShapingControls();
    const row = report.controlRows.find((candidate) => candidate.control === "ptem");
    const baseline = asciiGlyphs([5, 3, 7], [1060, 1060, 1060]);
    const omitted = asciiGlyphs([5, 3, 7], [1000, 1000, 1000]);
    expect(row).toMatchObject({
      id: "harfbuzz-trak-ptem-9-to-unset",
      required: true,
      fixture: {
        expectedSha256: TRACKING_FIXTURE_SHA256,
        decodedSha256: TRACKING_FIXTURE_SHA256,
        upstreamRevision: "4de187dd0a915d13c976fa8bd474c084229f3aab",
        upstreamBlob: "3be9c0085421079272ddfbffc352862bbf0d0e9b",
        requiredTables: ["STAT", "trak"],
      },
      baseline: { fontSizePx: 9, axes: null },
      destructiveMutation: { fontSizePx: null, axes: null },
      expectedChangedFields: ["xAdvance"],
      changedFields: ["xAdvance"],
      applicability: { status: "applicable", reason: null },
      movement: { status: "moved-as-expected", reason: null },
      rasterization: "out-of-scope",
    });
    expect(row?.baseline.expected.glyphs).toEqual(baseline);
    expect(row?.baseline.actual?.glyphs).toEqual(baseline);
    expect(row?.destructiveMutation.expected.glyphs).toEqual(omitted);
    expect(row?.destructiveMutation.actual?.glyphs).toEqual(omitted);
    expect(report).toMatchObject({
      controlHits: { axes: 2, ptem: 1 },
      missedControls: [],
      inapplicableControls: [],
      nonMovingControls: [],
      unexpectedControls: [],
      failedControls: [],
    });
  });

  it("reports an invalid required fixture instead of aborting the evidence artifact", () => {
    const report = runApplicableShapingControls({
      trackingFixture: "tests/fixtures/exact-shaping/not-present.ttf.base64",
    });
    const row = report.controlRows.find((candidate) => candidate.control === "ptem");
    expect(row).toMatchObject({
      applicable: false,
      movementProven: false,
      applicability: { status: "inapplicable" },
      movement: { status: "not-run" },
      baseline: { actual: null },
      destructiveMutation: { actual: null },
    });
    expect(row?.applicability.reason).toMatch(/not-present/);
    expect(report.inapplicableControls).toEqual(["harfbuzz-trak-ptem-9-to-unset"]);
    expect(report.failedControls).toEqual(["harfbuzz-trak-ptem-9-to-unset"]);
    expect(report.controlHits).toEqual({ axes: 2, ptem: 0 });
  });

  it("writes schema-v3 evidence before failing an invalid CLI fixture", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "dm2500-shaping-"));
    const output = join(outputDir, "shaping.json");
    try {
      const run = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "tools/exact-shaping-oracle.ts",
        "--face",
        "__dm2500_no_host_face__",
        "--tracking-control-fixture",
        "tests/fixtures/exact-shaping/not-present.ttf.base64",
        "--json",
        output,
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("portable control failure: harfbuzz-trak-ptem-9-to-unset");
      const report = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({
        schemaVersion: 3,
        verdict: "verdict-withheld",
        movementProven: false,
        pairs: 0,
        inapplicableControls: ["harfbuzz-trak-ptem-9-to-unset"],
        failedControls: ["harfbuzz-trak-ptem-9-to-unset"],
        records: [],
      });
      expect((report.controlRows as unknown[]).length).toBe(3);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("matches the pinned Blink and HarfBuzz activation branches", () => {
    const blink = readFileSync("external/chromium/third_party/blink/renderer/platform/fonts/shaping/harfbuzz_face.cc", "utf8");
    const harfbuzz = readFileSync("external/harfbuzz/src/hb-ot-shape.cc", "utf8");
    expect(blink).toContain("hb_font_set_variations(");
    expect(blink).toContain("hb_font_set_ptem(unscaled_font");
    expect(harfbuzz).toMatch(/apply_trak\s*=\s*hb_aat_layout_has_tracking \(face\) && face->table\.STAT->has_data/);
  });

  it("keeps malformed sfnt parsing fail-closed for direct callers", () => {
    expect(() => sfntTableTags(Buffer.alloc(11))).toThrow(/not an sfnt/);
  });
});
