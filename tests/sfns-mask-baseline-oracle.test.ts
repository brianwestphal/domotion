import { describe, expect, it } from "vitest";
import {
  SFNS_BASE_AXES, SFNS_MUTATION_AXES, SFNS_REQUIRED_SCENARIOS,
  classifySfnsOracleRow, quantizeQuarter, validateSfnsOracleArtifact,
  type CoverageDiff, type SfnsAxes, type SfnsOracleArtifact, type SfnsOracleRow,
  type SfnsScenarioId,
} from "../tools/sfns-mask-baseline-schema.js";

const noDiff = (bestIntegerYOffset = 0): CoverageDiff => ({
  changedPixels: 0,
  meanAbsoluteCoverage: 0,
  maxAbsoluteCoverage: 0,
  inkPixelsA: 100,
  inkPixelsB: 100,
  centroidYA: 20,
  centroidYB: 20,
  fixedYOffset: 0,
  bestIntegerYOffset,
  bestMeanAbsoluteCoverage: 0,
});

function row(id: SfnsScenarioId, axes: SfnsAxes = { ...SFNS_BASE_AXES }): SfnsOracleRow {
  const mutation = id === "opsz-26-mutation";
  const digest = mutation ? "mutation" : id;
  return {
    id, mutation, requestedAxes: axes,
    chromiumAxes: { ...axes }, nativeAxes: { ...axes }, domotionAxes: { ...axes },
    nativeGlyphIds: [10, 11], nativeMappedGlyphIds: [10, 11], domotionGlyphIds: [10, 11],
    rawOrigins: [4.24, 8.26], quarterPixelOrigins: [4.25, 8.25],
    nativeOrigins: [4.25, 8.25], nativeBaselines: [30, 30], domotionOrigins: [4.25, 8.25],
    domotionEmittedOriginsRaw: [4.249, 8.251],
    sizes: { logical: 13, computed: 26, paint: 26 },
    sourceIdentity: {
      chromiumPostscriptName: ".SFNS-Regular", chromiumCustomFont: true,
      chromiumSourceSha256: "font", nativePostscriptName: ".SFNS-Regular",
      domotionPostscriptName: ".SFNS-Regular", domotionSourcePath: "/System/Library/Fonts/SFNS.ttf",
      domotionSourceSha256: "font",
    },
    pathCommandCounts: { native: [5, 6], domotion: [5, 6] },
    pathGeometry: {
      topologyMatches: true, maxDesignUnitDelta: 0, maxPaintPixelDelta: 0,
      meanPaintPixelDelta: 0, exactScale: 26 / 2048, domotionSerializedScale: 0.0127,
    },
    baseline: {
      rangeTop: 10, capturedTextTop: 10, capturedAscent: 20, capturedDescent: 5,
      capturedBaseline: 30, capturedBaselineQuarterPixel: 30, emittedBaseline: 30,
      browserCanvasAscent: 20, browserCanvasDescent: 5,
      nativeAscent: 19.5, nativeDescent: 5.1, nativeLeading: 0,
      nativeBoundingBox: { x: -1, y: -5, width: 28, height: 30 },
    },
    lifecycle: {
      chromiumColdSha256: ["chromium", "chromium"], chromiumWarmSha256: ["chromium", "chromium"],
      nativeColdMaskSha256: ["mask", "mask"], nativeColdPathSha256: ["path", "path"],
      nativeWarmMaskSha256: ["mask", "mask"], nativeWarmPathSha256: ["path", "path"],
      domotionColdSha256: ["domotion", "domotion"], domotionWarmSha256: ["domotion", "domotion"],
    },
    comparisons: {
      chromiumVsNativeMask: noDiff(), chromiumVsCoreTextPath: noDiff(), chromiumVsDomotionPath: noDiff(),
      nativeMaskVsCoreTextPath: noDiff(), coreTextPathVsDomotionPath: noDiff(),
    },
    stageDigests: { chromium: digest, nativeMask: digest, coreTextPath: digest, domotionPath: digest },
    artifactPaths: {
      chromiumPng: "chromium.png", nativeMaskPng: "mask.png", coreTextPathSvg: "ct.svg",
      coreTextPathPng: "ct.png", domotionPathSvg: "domotion.svg", domotionPathPng: "domotion.png",
    },
  };
}

function artifact(): SfnsOracleArtifact {
  const rows = SFNS_REQUIRED_SCENARIOS.map((id) => row(
    id, id === "opsz-26-mutation" ? { ...SFNS_MUTATION_AXES } : { ...SFNS_BASE_AXES },
  ));
  return {
    schemaVersion: 1,
    authority: "diagnostic-only",
    environment: {
      platform: "darwin",
      chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skiaRevision: "62efacd37737505732dbe3d8daa62abd679626a1",
      fontPath: "/System/Library/Fonts/SFNS.ttf",
      fontSha256: "font", deviceScaleFactor: 1,
      chromiumVersion: "Chromium", osVersion: "macOS", arch: "arm64",
    },
    rows,
    classifications: rows.map((candidate) => ({ id: candidate.id, ...classifySfnsOracleRow(candidate) })),
    mutationControlMoved: true,
  };
}

describe("SFNS mask/baseline oracle integrity", () => {
  it("derives Skia's two-bit position key at exact quarter pixels", () => {
    expect([4.12, 4.13, 4.37, 4.38].map(quantizeQuarter)).toEqual([4, 4.25, 4.25, 4.5]);
  });

  it("withholds before classification when axes, cmap gids, origins, or lifecycle move", () => {
    const evidence = row("zoom-2");
    evidence.chromiumAxes.opsz = 26;
    evidence.nativeAxes.opsz = 26;
    evidence.nativeMappedGlyphIds[1]++;
    evidence.domotionOrigins[0] = 4.5;
    evidence.lifecycle.domotionWarmSha256[1] = "different";
    expect(classifySfnsOracleRow(evidence)).toMatchObject({
      classification: "verdict-withheld",
      integrityErrors: expect.arrayContaining([
        "chromium-css-axis-state", "native-axis-state", "native-cmap-glyph-identity",
        "domotion-origin-routing", "cold-warm-instability",
      ]),
    });
  });

  it("names the first divergent representation before the native-mask boundary", () => {
    const path = row("zoom-2");
    path.comparisons.coreTextPathVsDomotionPath.changedPixels = 1;
    expect(classifySfnsOracleRow(path).classification).toBe("coretext-path-vs-domotion-path-divergence");

    const mask = row("zoom-2");
    mask.comparisons.nativeMaskVsCoreTextPath.changedPixels = 1;
    expect(classifySfnsOracleRow(mask).classification).toBe("native-mask-vs-coretext-path-rasterization");
  });

  it("reports the one-pixel baseline fit separately from fixed-position coverage", () => {
    const evidence = row("zoom-2");
    evidence.comparisons.chromiumVsNativeMask = noDiff(-1);
    evidence.comparisons.chromiumVsCoreTextPath = noDiff(1);
    const result = classifySfnsOracleRow(evidence);
    expect(result.classification).toBe("no-stage-divergence");
    expect(result.baselineResidual).toEqual({
      nativeMaskBestIntegerYOffset: -1,
      coreTextPathBestIntegerYOffset: 1,
      domotionPathBestIntegerYOffset: 0,
    });
  });

  it("requires every scenario and movement in every positive opsz mutation arm", () => {
    const valid = artifact();
    expect(validateSfnsOracleArtifact(valid)).toEqual([]);
    valid.rows.find((candidate) => candidate.id === "opsz-26-mutation")!.stageDigests.coreTextPath = "zoom-2";
    expect(validateSfnsOracleArtifact(valid)).toContain("opsz-mutation-did-not-move-all-stages");

    const wrongBytes = artifact();
    wrongBytes.rows[0].sourceIdentity.chromiumSourceSha256 = "different";
    expect(validateSfnsOracleArtifact(wrongBytes)).toContain("zoom-2:chromium-font-bytes");
  });
});
