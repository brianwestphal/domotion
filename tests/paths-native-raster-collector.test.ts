import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  assertCompletePathsRasterMatrix,
  PATHS_NATIVE_RASTER_FIXTURES,
  PATHS_NATIVE_RASTER_SOURCE,
  pathsNativeRasterMatrix,
  pathsRasterCellSha256,
} from "../tools/paths-native-raster-corpus.js";
import type { PathsRasterRow } from "../tools/paths-native-raster-gate.js";
import { measureDecodedPathsRasterResidual } from "../tools/paths-native-raster-metrics.js";
import { producePathsRasterRows } from "../tools/paths-native-raster-producer.js";
import { rendererPlacementFromMarkup } from "../tools/paths-native-raster-collector.js";
import { assessPathsNativeFaceIdentity } from "../tools/paths-native-face-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = (character: string): string => character.repeat(64);

function rawWithInk(x: number, y: number): Buffer {
  const data = Buffer.alloc(3 * 3 * 4, 255);
  const offset = (y * 3 + x) * 4;
  data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0;
  return data;
}

async function pngWithInk(x: number, y: number): Promise<Buffer> {
  return sharp(rawWithInk(x, y), { raw: { width: 3, height: 3, channels: 4 } }).png().toBuffer();
}

function partialRow(cell = pathsNativeRasterMatrix()[0]): PathsRasterRow {
  const sourceSha256 = cell.fixture.derivedSha256 ?? cell.fixture.upstreamSha256;
  const logical = {
    postscriptName: "Fixture-Regular", sourceSha256, faceIndex: 0, variationAxes: cell.variationAxes,
    glyphs: [{ gid: 1, cluster: 0, advanceX: 500, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: sha("e"), outlineCommandCount: 4 }],
    baseline: 92, matrix: cell.matrix, paintPlan: { syntheticBold: false, syntheticOblique: false },
  };
  return {
    id: cell.id, runLabel: "proposal", runProvenance: { githubRunId: "local", githubRunAttempt: "local", githubJob: "local", runnerName: "local-a", workflowRef: "local" }, cellSha256: pathsRasterCellSha256(cell),
    fingerprint: {
      platform: "linux", osImage: "ubuntu-24.04", osImageVersion: "20260817.1", arch: "x64", osRelease: "6.8",
      chromium: "147", chromiumRevision: "r147", browserExecutableSha256: sha("f"),
      skia: `browser-binary:${sha("f")}`, harfbuzz: `browser-binary:${sha("f")}`,
      oracleSkiaRevision: "62efacd3", oracleHarfbuzzRevision: PATHS_NATIVE_RASTER_SOURCE.revision,
      fontInventorySha256: sha("a"), rendererRevision: "deadbeef", consumerRasterizer: "chromium-svg-headless",
      playwrightVersion: "1.59.1", nodeVersion: "22.14.0", icuVersion: "77.1", sharpVersion: "0.34.5",
      libvipsVersion: "8.17.3", metricAlgorithm: "opaque-rgba-ink-edge-v2", launchFlags: ["headless"], locale: "en-US",
    },
    dimensions: cell.dimensions,
    expectedLogical: structuredClone(logical), actualLogical: structuredClone(logical),
    nativeFace: {
      requestedFamily: `DomotionPathsRaster_${cell.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
      computedFamily: `DomotionPathsRaster_${cell.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
      fontFaceRuleFamily: `DomotionPathsRaster_${cell.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
      fontFaceRuleCount: 1,
      sourceSha256,
      computedVariationAxes: cell.variationAxes,
      paintedFamilyDisplayName: "Fixture",
      postscriptDisplayName: "backend-display-name",
      isCustomFont: true,
      glyphCount: logical.glyphs.length,
    },
    residual: {
      changedPixels: 999, area: 999, width: 999, height: 999, maxEdgeDistance: 999, severity: 999,
      totalChannelDelta: 999, nativeInk: { area: 1, x: 1, y: 1, width: 1, height: 1 },
      pathsInk: { area: 1, x: 1, y: 1, width: 1, height: 1 },
    },
    nativeArtifact: { path: "native.png", sha256: sha("c"), width: 3, height: 3 },
    pathsArtifact: { path: "paths.png", sha256: sha("d"), width: 3, height: 3 }, warnings: [],
  };
}

describe("paths/native source-owned collection contract", () => {
  it("keeps the serialized browser callback free of nested helper functions", () => {
    const source = readFileSync("tools/paths-native-raster-collector.ts", "utf8");
    const start = source.indexOf('page.locator("#native").evaluate');
    const callback = source.slice(start, source.indexOf("const cdp =", start));
    expect(callback).not.toContain("const unquote =");
    expect(callback).not.toContain(".flatMap(");
    expect(callback).not.toContain(".filter(");
  });
  it("declares the deconfounded 348-cell technology/phase/transform/DPR union", () => {
    const matrix = pathsNativeRasterMatrix();
    expect(PATHS_NATIVE_RASTER_FIXTURES.map((fixture) => fixture.technology)).toEqual([
      "glyf-hinted", "glyf-unhinted", "cff", "cff2", "variable-glyf", "variable-cff2",
    ]);
    expect(matrix).toHaveLength(348);
    expect(new Set(matrix.map((cell) => cell.id)).size).toBe(348);
    for (const technology of PATHS_NATIVE_RASTER_FIXTURES.map((fixture) => fixture.technology)) {
      const rows = matrix.filter((cell) => cell.fixture.technology === technology);
      expect(new Set(rows.map((cell) => cell.dimensions.transform))).toEqual(new Set(["none", "translate", "scale", "rotate", "affine"]));
      expect(new Set(rows.map((cell) => cell.dimensions.deviceScaleFactor))).toEqual(new Set([1, 2]));
      expect(new Set(rows.filter((cell) => cell.dimensions.transform === "none" && cell.dimensions.fontSizePx === 20 && cell.dimensions.weight === 400)
        .map((cell) => `${cell.dimensions.phaseX},${cell.dimensions.phaseY}`)).size).toBe(16);
      expect(new Set(rows.map((cell) => cell.dimensions.weight))).toEqual(new Set([400, 600, 800]));
    }
    const declared = matrix.map((cell) => ({ id: cell.id, dimensions: cell.dimensions, cellSha256: pathsRasterCellSha256(cell) }));
    expect(() => assertCompletePathsRasterMatrix(declared)).not.toThrow();
    expect(() => assertCompletePathsRasterMatrix(declared.slice(1))).toThrow(/incomplete/);
    const tampered = structuredClone(declared); tampered[0].cellSha256 = sha("0");
    expect(() => assertCompletePathsRasterMatrix(tampered)).toThrow(/cellSha256/);
  });

  it("measures exact changed pixels but grades ink area, bounds, and edges independently", () => {
    const native = { data: rawWithInk(1, 1), width: 3, height: 3, channels: 4 };
    const paths = { data: rawWithInk(2, 1), width: 3, height: 3, channels: 4 };
    expect(measureDecodedPathsRasterResidual(native, paths)).toEqual({
      changedPixels: 2,
      area: 0,
      width: 0,
      height: 0,
      maxEdgeDistance: 1,
      severity: 1.5,
      totalChannelDelta: 1530,
      nativeInk: { area: 1, x: 1, y: 1, width: 1, height: 1 },
      pathsInk: { area: 1, x: 2, y: 1, width: 1, height: 1 },
    });
  });

  it("reads baseline, transform, and synthetic paint from emitted SVG rather than the matrix declaration", () => {
    expect(rendererPlacementFromMarkup(
      '<g transform="translate(48,91.5)" fill="#000"><g fill="#000" stroke="#000" stroke-width="31.25"></g></g>',
      '<svg><g transform="matrix(1.04 0.13 -0.09 0.96 2.75 -1.5)"></g></svg>',
    )).toEqual({
      baseline: 91.5,
      matrix: [1.04, 0.13, -0.09, 0.96, 2.75, -1.5],
      paintPlan: { syntheticBold: true, syntheticOblique: false },
    });
  });

  it("uses the unique custom CSS family and source facts, never a backend display alias", () => {
    const glyphs = [{
      gid: 1, cluster: 0, advanceX: 500, advanceY: 0, offsetX: 0, offsetY: 0,
      outlineSha256: sha("1"), outlineCommandCount: 8,
    }];
    const identity = {
      platform: "win32" as const,
      isVariable: true,
      expectedFamily: "DomotionPathsRaster_variable_glyf",
      fingerprintHelperSha256: sha("b"),
      expected: { sourceSha256: sha("a"), faceIndex: 0, variationAxes: { wdth: 90, wght: 600 }, glyphs },
      actual: { sourceSha256: sha("a"), faceIndex: 0, variationAxes: { wght: 600, wdth: 90 }, glyphs: structuredClone(glyphs) },
      native: {
        requestedFamily: "DomotionPathsRaster_variable_glyf",
        computedFamily: "DomotionPathsRaster_variable_glyf",
        fontFaceRuleFamily: "DomotionPathsRaster_variable_glyf",
        fontFaceRuleCount: 1,
        sourceSha256: sha("a"),
        computedVariationAxes: { wdth: 90, wght: 600 },
        paintedFamilyDisplayName: "Roboto",
        postscriptDisplayName: "Roboto-Medium",
        isCustomFont: true,
        glyphCount: 1,
        helper: {
          // DirectWrite's helper reports name ID 6 while CDP exposes a WSS
          // presentation alias; neither string participates in identity.
          postscriptDisplayName: "Roboto-Regular",
          resolvedAxes: { wdth: 90, wght: 600 },
          platformResolvedAxes: { wdth: 90, wght: 600, ital: 0, slnt: 0 },
          sourceSha256: sha("a"),
          faceIndex: 0,
          helperSha256: sha("b"),
        },
      },
    };
    expect(assessPathsNativeFaceIdentity(identity)).toEqual({ pass: true, blockers: [] });
    expect(assessPathsNativeFaceIdentity({
      ...identity,
      native: { ...identity.native, paintedFamilyDisplayName: "", postscriptDisplayName: "" },
    })).toEqual({ pass: true, blockers: [] });

    const mutations = [
      { expected: "requested-family", value: { ...identity, native: { ...identity.native, requestedFamily: "HostFallback", computedFamily: "HostFallback" } } },
      { expected: "native-source-bytes", value: { ...identity, native: { ...identity.native, sourceSha256: sha("c") } } },
      { expected: "native-variation-axes", value: { ...identity, native: { ...identity.native, computedVariationAxes: { wdth: 90, wght: 500 } } } },
      { expected: "non-custom-font", value: { ...identity, native: { ...identity.native, isCustomFont: false } } },
      { expected: "source-bytes", value: { ...identity, actual: { ...identity.actual, sourceSha256: sha("c") } } },
      { expected: "variation-axes", value: { ...identity, actual: { ...identity.actual, variationAxes: { wdth: 90, wght: 500 } } } },
      { expected: "helper-source-bytes", value: { ...identity, native: { ...identity.native, helper: { ...identity.native.helper!, sourceSha256: sha("c") } } } },
      { expected: "helper-variation-axes", value: { ...identity, native: { ...identity.native, helper: { ...identity.native.helper!, resolvedAxes: { wdth: 90, wght: 500 } } } } },
      { expected: "glyph-outline-stream", value: { ...identity, actual: { ...identity.actual, glyphs: [{ ...glyphs[0], outlineSha256: sha("c") }] } } },
    ];
    for (const mutation of mutations) {
      const result = assessPathsNativeFaceIdentity(mutation.value);
      expect(result.pass, mutation.expected).toBe(false);
      expect(result.blockers, mutation.expected).toContain(mutation.expected);
    }
  });

  it("rehashes bytes and recomputes residuals instead of trusting supplied observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "dm2499-producer-")); roots.push(root);
    const native = await pngWithInk(1, 1), paths = await pngWithInk(2, 1);
    writeFileSync(join(root, "native.png"), native); writeFileSync(join(root, "paths.png"), paths);
    const rows = await producePathsRasterRows([partialRow()], root, { requireComplete: false });
    expect(rows[0].nativeArtifact.sha256).toBe(createHash("sha256").update(native).digest("hex"));
    expect(rows[0].pathsArtifact.sha256).toBe(createHash("sha256").update(paths).digest("hex"));
    expect(rows[0].residual).toEqual(expect.objectContaining({ changedPixels: 2, area: 0, width: 0, height: 0, maxEdgeDistance: 1 }));
    expect(rows[0].residual.severity).toBeCloseTo(1.5, 12);
  });

  it.each(["source", "axes"] as const)("rejects a joint all-witness %s forgery against the declared cell", async (kind) => {
    const cell = pathsNativeRasterMatrix().find((candidate) => candidate.fixture.technology === "variable-glyf")!;
    const row = partialRow(cell);
    row.fingerprint.platform = "win32";
    row.fingerprint.nativeIdentityHelperSha256 = sha("7");
    row.nativeFace.helper = {
      postscriptDisplayName: "Roboto-Regular",
      sourceSha256: row.expectedLogical.sourceSha256,
      faceIndex: 0,
      resolvedAxes: structuredClone(row.expectedLogical.variationAxes),
      helperSha256: sha("7"),
    };
    if (kind === "source") {
      row.expectedLogical.sourceSha256 = sha("0");
      row.actualLogical.sourceSha256 = sha("0");
      row.nativeFace.sourceSha256 = sha("0");
      row.nativeFace.helper.sourceSha256 = sha("0");
    } else {
      const forged = { wdth: 100, wght: 500 };
      row.expectedLogical.variationAxes = structuredClone(forged);
      row.actualLogical.variationAxes = structuredClone(forged);
      row.nativeFace.computedVariationAxes = structuredClone(forged);
      row.nativeFace.helper.resolvedAxes = structuredClone(forged);
    }
    const root = mkdtempSync(join(tmpdir(), "dm2499-producer-")); roots.push(root);
    writeFileSync(join(root, "native.png"), await pngWithInk(1, 1));
    writeFileSync(join(root, "paths.png"), await pngWithInk(2, 1));
    await expect(producePathsRasterRows([row], root, { requireComplete: false }))
      .rejects.toThrow(kind === "source" ? /sourceSha256.*declared fixture/ : /variationAxes.*declared matrix/);
  });

  it("rejects artifact paths outside the authenticated observation root", async () => {
    const root = mkdtempSync(join(tmpdir(), "dm2499-producer-")); roots.push(root);
    const row = partialRow(); row.nativeArtifact.path = "../native.png";
    await expect(producePathsRasterRows([row], root, { requireComplete: false })).rejects.toThrow(/escapes/);
  });

  it("rejects role/path reuse before symmetric residuals can hide a swapped arm", async () => {
    const root = mkdtempSync(join(tmpdir(), "dm2499-producer-")); roots.push(root);
    writeFileSync(join(root, "native.png"), await pngWithInk(1, 1));
    const row = partialRow(); row.pathsArtifact.path = "native.png";
    await expect(producePathsRasterRows([row], root, { requireComplete: false })).rejects.toThrow(/reuses/);
  });
});
