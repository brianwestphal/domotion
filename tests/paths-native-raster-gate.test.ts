import { describe, expect, it } from "vitest";
import { adjudicatePathsRasterRows, dimensionsKey, fingerprintSha256, type PathsRasterRow } from "../tools/paths-native-raster-gate.js";

const sha = (c: string) => c.repeat(64);
function row(): PathsRasterRow { return {
  id: "glyf-16-400-quarter-scale-dpr2", fingerprint: { platform: "linux", osImage: "ubuntu-24.04", arch: "x64", chromium: "147", skia: "62efacd3", harfbuzz: "4de187d", fontInventorySha256: sha("a"), rendererRevision: "deadbeef", consumerRasterizer: "chromium-svg", launchFlags: [], locale: "en-US" },
  dimensions: { fontTechnology: "glyf-unhinted", fontSizePx: 16, weight: 400, phaseX: .25, phaseY: .5, transform: "scale", deviceScaleFactor: 2 },
  expectedLogical: { postscriptName: "FreeSans", sourceSha256: sha("b"), faceIndex: 0, variationAxes: {}, glyphs: [{ gid: 42, cluster: 0, advanceX: 512, advanceY: 0, offsetX: 0, offsetY: 0 }], baseline: 17.25, matrix: [1.25, 0, 0, 1.25, 10, 20] },
  actualLogical: { postscriptName: "FreeSans", sourceSha256: sha("b"), faceIndex: 0, variationAxes: {}, glyphs: [{ gid: 42, cluster: 0, advanceX: 512, advanceY: 0, offsetX: 0, offsetY: 0 }], baseline: 17.25, matrix: [1.25, 0, 0, 1.25, 10, 20] },
  residual: { changedPixels: 8, area: 6, width: 3, height: 4, maxEdgeDistance: 1, severity: 12 },
  nativeArtifact: { path: "native.png", sha256: sha("c"), width: 32, height: 32 }, pathsArtifact: { path: "paths.png", sha256: sha("d"), width: 32, height: 32 }, warnings: [],
}; }
const envelopes = (r: PathsRasterRow, ratified = true) => ({ schemaVersion: 1 as const, ratified, reviewer: ratified ? "reviewer" : undefined, reviewedAt: ratified ? "2026-08-23T00:00:00.000Z" : undefined, envelopes: [{ key: dimensionsKey(r.dimensions), fingerprintSha256: fingerprintSha256(r.fingerprint), dimensions: r.dimensions, max: { changedPixels: 8, area: 6, width: 3, height: 4, maxEdgeDistance: 1, severity: 12 }, reviewedArtifactSha256: [r.nativeArtifact.sha256, r.pathsArtifact.sha256] }] });

describe("paths-mode native-raster gate", () => {
  it("accepts only a ratified exact logical row inside its fingerprinted envelope", () => { const r = row(); expect(adjudicatePathsRasterRows([r], envelopes(r))).toEqual({ pass: true, rows: [{ id: r.id, verdict: "accepted-rasterization-only" }] }); });
  it.each(["face", "gid", "advance", "baseline", "matrix"])("fails %s before consulting raster bounds", (kind) => { const r = row(); if (kind === "face") r.actualLogical.postscriptName += "X"; if (kind === "gid") r.actualLogical.glyphs[0].gid++; if (kind === "advance") r.actualLogical.glyphs[0].advanceX++; if (kind === "baseline") r.actualLogical.baseline += .001; if (kind === "matrix") r.actualLogical.matrix[4] += .001; r.residual = { changedPixels: 0, area: 0, width: 0, height: 0, maxEdgeDistance: 0, severity: 0 }; expect(adjudicatePathsRasterRows([r], envelopes(row())).rows[0].verdict).toBe("logical-mismatch"); });
  it("withholds unratified, cross-fingerprint, warning, inert and outside-envelope evidence", () => { const r = row(); expect(adjudicatePathsRasterRows([r], envelopes(r, false)).rows[0].verdict).toBe("envelope-unratified"); const wrong = envelopes(r); wrong.envelopes[0].fingerprintSha256 = sha("e"); expect(adjudicatePathsRasterRows([r], wrong).rows[0].verdict).toBe("missing-envelope"); r.warnings.push("capture partial"); expect(adjudicatePathsRasterRows([r], envelopes(row())).rows[0].verdict).toBe("invalid-evidence"); r.warnings=[]; r.residual.changedPixels++; expect(adjudicatePathsRasterRows([r], envelopes(r)).rows[0].verdict).toBe("envelope-violation"); });
  it("rejects a nominal ratification without reviewer provenance", () => { const r = row(); const e = envelopes(r); delete e.reviewer; expect(() => adjudicatePathsRasterRows([r], e)).toThrow(/reviewer/); });
});
