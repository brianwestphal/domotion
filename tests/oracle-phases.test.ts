import { describe, expect, it } from "vitest";
import { comparePaintOrderEvidence, formatPaintOrderReport } from "../tools/paint-order-oracle.js";
import { summarizeDecorationResults } from "../tools/decoration-oracle.js";
import { compareMixedBidiEvidence, buildMixedBidiReport } from "../tools/mixed-bidi-logical-oracle.js";
import { compareRouteEvidence, buildRouteReport } from "../tools/renderer-font-route-oracle.js";
import { compareShapingResults, buildShapingReport } from "../tools/shaping-conformance.js";

describe("oracle collection to comparison to report boundaries", () => {
  it("keeps paint-order failure order and mutation gating in the report", () => {
    const evidence = {
      rows: [
        { id: "first", expected: true, actual: true, pass: true, source: "test" },
        { id: "second", expected: true, actual: false, pass: false, source: "test" },
      ],
      mutationMoved: false,
    };
    expect(comparePaintOrderEvidence(evidence)).toMatchObject({ passed: 1, exitCode: 1 });
    expect(formatPaintOrderReport(evidence)).toEqual([
      "paint-order oracle: 1/2; mutation control DID NOT MOVE",
      "FAIL second: expected=true actual=false",
    ]);
    expect(comparePaintOrderEvidence({ rows: [], mutationMoved: true }).exitCode).toBe(0);
  });

  it("gates decoration legs independently and always gates transcription", () => {
    type Result = Parameters<typeof summarizeDecorationResults>[0][number];
    const result = (id: string, transcription: boolean, skipInk: boolean | null, svg: boolean): Result => ({
      id,
      transcription: { ok: transcription, detail: [] },
      svgGeometry: { ok: svg, detail: [] },
      skipInk: skipInk == null ? null : { ok: skipInk, detail: [] },
      notes: [],
      data: { predicted: [], chrome: [], svg: [] },
    });
    const rows = [result("a", true, false, false), result("b", false, null, true)];
    expect(summarizeDecorationResults(rows, false, false)).toMatchObject({ gateFailed: true });
    expect(summarizeDecorationResults([rows[0]], false, false)).toMatchObject({ gateFailed: false });
    expect(summarizeDecorationResults([rows[0]], true, false)).toMatchObject({ gateFailed: true });
    expect(summarizeDecorationResults([rows[0]], false, true)).toMatchObject({ gateFailed: true });
  });

  it("withholds mixed bidi verdict for incomplete records while retaining its schema", () => {
    const evidence = {
      records: [],
      wrongLevelDeltas: [],
      wrongClusterDeltas: [],
      wrongOriginDeltas: [],
      baselinesAgree: true,
    };
    expect(compareMixedBidiEvidence(evidence).complete).toBe(false);
    const report = buildMixedBidiReport(evidence);
    expect(report).toMatchObject({ schemaVersion: 1, verdict: "verdict-withheld", records: [] });
    expect(Object.keys(report.mutations)).toEqual(["wrongLevel", "wrongCluster", "wrongOrigin"]);
  });

  it("grades route faces only when graded and preserves the report envelope", () => {
    const good = { domotion: { runs: [{}], transitions: [] }, comparison: { graded: false, faceAgreement: [false] } };
    expect(compareRouteEvidence([good], { activation: true })).toBe(true);
    expect(
      compareRouteEvidence([{ ...good, comparison: { graded: true, faceAgreement: [false] } }], { activation: true }),
    ).toBe(false);
    expect(compareRouteEvidence([{ ...good, domotion: { runs: [], transitions: [] } }], { activation: true })).toBe(
      false,
    );
    const environment = { helper: { mode: "helper-present" } } as Parameters<typeof buildRouteReport>[1];
    expect(buildRouteReport([good], environment, ["fixture"], { activation: true }, true)).toMatchObject({
      schemaVersion: 3,
      verdict: "evidence-complete",
      mechanisms: ["fixture"],
      records: [good],
    });
  });

  it("summarizes shaping mismatches without changing report keys or route order", () => {
    const counts = {
      "agree-exact": 2,
      "agree-count": 0,
      "agree-count-clustered": 0,
      "mismatch-count": 1,
      "mismatch-unrendered": 2,
    };
    const routes = new Map([
      ["low", 1],
      ["high", 3],
    ]);
    expect(compareShapingResults(counts, routes)).toEqual({ mismatchTotal: 3, distinctRoutes: 2, complete: false });
    const report = buildShapingReport({
      platform: "test",
      runs: 5,
      corpus: { generatedAt: "now", sources: ["fixture"], runs: [] },
      chromium: "test-browser",
      tolerance: 0.2,
      wallMs: 10,
      counts,
      allowlisted: 0,
      routes,
      featureValueRecords: [{ logicalRecord: null }],
      defaultIgnorableRecords: [],
      rows: [],
    });
    expect(Object.keys(report)).toEqual([
      "meta",
      "summary",
      "featureValueRecords",
      "defaultIgnorableRecords",
      "topRoutes",
      "mismatches",
    ]);
    expect(report.summary.mismatchTotal).toBe(3);
    expect(report.topRoutes[0]).toEqual({ route: "high", count: 3 });
  });
});
