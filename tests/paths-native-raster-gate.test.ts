import { describe, expect, it } from "vitest";
import { adjudicatePathsRasterRows, dimensionsKey, fingerprintSha256, type PathsRasterRow } from "../tools/paths-native-raster-gate.js";

const sha = (c: string) => c.repeat(64);
function row(): PathsRasterRow { return {
  id: "glyf-16-400-quarter-scale-dpr2", runLabel: "proposal", runProvenance: { githubRunId: "42", githubRunAttempt: "1", githubJob: "produce", runnerName: "runner-a", workflowRef: "owner/repo/workflow@sha" }, cellSha256: sha("9"),
  fingerprint: {
    platform: "linux", osImage: "ubuntu-24.04", osImageVersion: "20260817.1", arch: "x64", osRelease: "6.8", chromium: "147",
    chromiumRevision: "r147", browserExecutableSha256: sha("f"), skia: `browser-binary:${sha("f")}`,
    harfbuzz: `browser-binary:${sha("f")}`, oracleSkiaRevision: "62efacd3", oracleHarfbuzzRevision: "4de187d",
    fontInventorySha256: sha("a"), rendererRevision: "deadbeef", consumerRasterizer: "chromium-svg",
    playwrightVersion: "1.59.1", nodeVersion: "22.14.0", icuVersion: "77.1", sharpVersion: "0.34.5",
    libvipsVersion: "8.17.3", metricAlgorithm: "opaque-rgba-ink-edge-v2", launchFlags: [], locale: "en-US",
  },
  dimensions: { fontTechnology: "glyf-unhinted", fontSizePx: 16, weight: 400, phaseX: .25, phaseY: .5, transform: "scale", deviceScaleFactor: 2 },
  expectedLogical: { postscriptName: "FreeSans", sourceSha256: sha("b"), faceIndex: 0, variationAxes: {}, glyphs: [{ gid: 42, cluster: 0, advanceX: 512, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: sha("1"), outlineCommandCount: 8 }], baseline: 17.25, matrix: [1.25, 0, 0, 1.25, 10, 20], paintPlan: { syntheticBold: false, syntheticOblique: false } },
  actualLogical: { postscriptName: "FreeSans", sourceSha256: sha("b"), faceIndex: 0, variationAxes: {}, glyphs: [{ gid: 42, cluster: 0, advanceX: 512, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: sha("1"), outlineCommandCount: 8 }], baseline: 17.25, matrix: [1.25, 0, 0, 1.25, 10, 20], paintPlan: { syntheticBold: false, syntheticOblique: false } },
  nativeFace: { requestedFamily: "DomotionPathsRaster_glyf_16_400_quarter_scale_dpr2", computedFamily: "DomotionPathsRaster_glyf_16_400_quarter_scale_dpr2", fontFaceRuleFamily: "DomotionPathsRaster_glyf_16_400_quarter_scale_dpr2", fontFaceRuleCount: 1, sourceSha256: sha("b"), computedVariationAxes: {}, paintedFamilyDisplayName: "Fixture", postscriptDisplayName: "backend-display-name", isCustomFont: true, glyphCount: 1 },
  residual: { changedPixels: 8, area: 6, width: 3, height: 4, maxEdgeDistance: 1, severity: 12, totalChannelDelta: 12240, nativeInk: { area: 100, x: 10, y: 12, width: 20, height: 24 }, pathsInk: { area: 94, x: 10, y: 12, width: 17, height: 20 } },
  nativeArtifact: { path: "native.png", sha256: sha("c"), width: 32, height: 32 }, pathsArtifact: { path: "paths.png", sha256: sha("d"), width: 32, height: 32 }, warnings: [],
}; }
function pair(proposal = row()): PathsRasterRow[] {
  const validation = row();
  validation.runLabel = "validation";
  validation.runProvenance.runnerName = "runner-b";
  validation.nativeArtifact.sha256 = sha("e");
  validation.pathsArtifact.sha256 = sha("f");
  return [proposal, validation];
}
const envelopes = (r: PathsRasterRow, ratified = true) => ({ schemaVersion: 2 as const, ratified, reviewer: ratified ? "reviewer" : undefined, reviewedAt: ratified ? "2026-08-23T00:00:00.000Z" : undefined, envelopes: [{ key: dimensionsKey(r.dimensions), fingerprintSha256: fingerprintSha256(r.fingerprint), cellSha256: r.cellSha256, dimensions: r.dimensions, max: { changedPixels: 8, area: 6, width: 3, height: 4, maxEdgeDistance: 1, severity: 12, totalChannelDelta: 12240 }, reviewedArtifacts: { proposal: { native: r.nativeArtifact.sha256, paths: r.pathsArtifact.sha256 }, validation: { native: sha("e"), paths: sha("f") } } }] });

describe("paths-mode native-raster gate", () => {
  it("accepts only a ratified exact proposal/validation pair inside its fingerprinted envelope", () => { const r = row(); expect(adjudicatePathsRasterRows(pair(r), envelopes(r))).toEqual({ pass: true, rows: [{ id: r.id, verdict: "accepted-rasterization-only" }, { id: r.id, verdict: "accepted-rasterization-only" }] }); });
  it.each(["face", "source", "axes", "gid", "outline", "advance", "baseline", "matrix", "paint"])("fails %s before consulting raster bounds", (kind) => { const r = row(); if (kind === "face") r.actualLogical.postscriptName += "X"; if (kind === "source") r.actualLogical.sourceSha256 = sha("0"); if (kind === "axes") r.actualLogical.variationAxes.wght = 700; if (kind === "gid") r.actualLogical.glyphs[0].gid++; if (kind === "outline") r.actualLogical.glyphs[0].outlineSha256 = sha("0"); if (kind === "advance") r.actualLogical.glyphs[0].advanceX++; if (kind === "baseline") r.actualLogical.baseline += .001; if (kind === "matrix") r.actualLogical.matrix[4] += .001; if (kind === "paint") r.actualLogical.paintPlan.syntheticBold = true; expect(adjudicatePathsRasterRows(pair(r), envelopes(row())).rows[0].verdict).toBe("logical-mismatch"); });
  it("withholds unratified, cross-fingerprint, warning, inert and outside-envelope evidence", () => { const r = row(); expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0].verdict).toBe("envelope-unratified"); const wrong = envelopes(r); wrong.envelopes[0].fingerprintSha256 = sha("e"); expect(adjudicatePathsRasterRows(pair(r), wrong).rows[0].verdict).toBe("missing-envelope"); r.warnings.push("capture partial"); expect(adjudicatePathsRasterRows(pair(r), envelopes(row())).rows[0].verdict).toBe("invalid-evidence"); const outsidePair = pair(row()); outsidePair[1].residual.changedPixels++; expect(adjudicatePathsRasterRows(outsidePair, envelopes(row())).rows[1].verdict).toBe("envelope-violation"); });
  it("rejects a nominal ratification without reviewer provenance", () => { const r = row(); const e = envelopes(r); delete e.reviewer; expect(() => adjudicatePathsRasterRows([r], e)).toThrow(/reviewer/); });
  it("rejects ambiguous duplicate envelopes instead of accepting last-write-wins", () => { const r = row(); const e = envelopes(r); e.envelopes.push(structuredClone(e.envelopes[0])); expect(() => adjudicatePathsRasterRows([r], e)).toThrow(/duplicate/); });
  it("requires a fingerprinted native identity helper for Windows observations", () => {
    const r = row(); r.fingerprint.platform = "win32";
    expect(() => adjudicatePathsRasterRows([r], envelopes(r, false))).toThrow(/identity-helper fingerprint/);
    r.fingerprint.nativeIdentityHelperSha256 = sha("7");
    expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0].verdict).toBe("envelope-unratified");
  });
  it.each([
    ["wrong requested family", (r: PathsRasterRow) => { r.nativeFace.requestedFamily = "HostFallback"; r.nativeFace.computedFamily = "HostFallback"; }, "requested-family,computed-family"],
    ["non-custom fallback", (r: PathsRasterRow) => { r.nativeFace.isCustomFont = false; }, "non-custom-font"],
    ["wrong native glyph count", (r: PathsRasterRow) => { r.nativeFace.glyphCount = 2; }, "glyph-count"],
    ["wrong native source", (r: PathsRasterRow) => { r.nativeFace.sourceSha256 = sha("0"); }, "native-source-bytes"],
    ["wrong native axes", (r: PathsRasterRow) => { r.nativeFace.computedVariationAxes = { wght: 700 }; }, "native-variation-axes"],
  ])("rejects hostile %s evidence before envelopes", (_label, mutate, reason) => {
    const r = row(); mutate(r);
    expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0]).toEqual({
      id: r.id, verdict: "invalid-evidence", reason: `native-face-identity:${reason}`,
    });
  });
  it("requires exact helper source/face/axes for a Windows variable face", () => {
    const r = row();
    r.fingerprint.platform = "win32";
    r.fingerprint.nativeIdentityHelperSha256 = sha("7");
    r.dimensions.fontTechnology = "variable-glyf";
    r.expectedLogical.variationAxes = { wdth: 90, wght: 600 };
    r.actualLogical.variationAxes = { wght: 600, wdth: 90 };
    r.nativeFace.computedVariationAxes = { wdth: 90, wght: 600 };
    r.nativeFace.helper = { postscriptDisplayName: "Roboto-Regular", sourceSha256: sha("b"), faceIndex: 0, resolvedAxes: { wdth: 90, wght: 600 }, helperSha256: sha("7") };
    expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0].verdict).toBe("envelope-unratified");
    r.nativeFace.helper.resolvedAxes.wght = 500;
    expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0]).toEqual({
      id: r.id, verdict: "invalid-evidence", reason: "native-face-identity:helper-variation-axes",
    });
  });
  it("retains run/role identity so swapping symmetric raster arms cannot pass", () => { const r = row(); [r.nativeArtifact, r.pathsArtifact] = [r.pathsArtifact, r.nativeArtifact]; expect(adjudicatePathsRasterRows(pair(r), envelopes(row())).rows[0]).toEqual({ id: r.id, verdict: "missing-envelope", reason: "unreviewed-artifact-role" }); });
  it("accepts byte-identical same-role reruns but rejects an inert arm within either run", () => {
    const r = row();
    const repeated = pair(r);
    repeated[1].nativeArtifact.sha256 = r.nativeArtifact.sha256;
    repeated[1].pathsArtifact.sha256 = r.pathsArtifact.sha256;
    const reviewed = envelopes(r);
    reviewed.envelopes[0].reviewedArtifacts.validation = structuredClone(reviewed.envelopes[0].reviewedArtifacts.proposal);
    expect(adjudicatePathsRasterRows(repeated, reviewed).pass).toBe(true);
    reviewed.envelopes[0].reviewedArtifacts.validation.paths = reviewed.envelopes[0].reviewedArtifacts.validation.native;
    expect(() => adjudicatePathsRasterRows(repeated, reviewed)).toThrow(/validation native and paths artifact hashes must differ/);
  });
  it("rejects widened proposal maxima and same-runner validation", () => { const r = row(); const widened = envelopes(r); widened.envelopes[0].max.changedPixels++; expect(() => adjudicatePathsRasterRows(pair(r), widened)).toThrow(/must equal.*proposal/); const sameRunner = pair(r); sameRunner[1].runProvenance.runnerName = sameRunner[0].runProvenance.runnerName; expect(() => adjudicatePathsRasterRows(sameRunner, envelopes(r))).toThrow(/independent validation/); });
});
