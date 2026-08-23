import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { LINUX_MATHML_GREEK_CELL, LINUX_MATHML_GREEK_SUBSETS, linuxMathmlGreekCellSha256 } from "../tools/linux-mathml-greek-raster-contract.js";
import {
  adjudicateLinuxMathmlGreekRows,
  linuxMathmlGreekFingerprintSha256,
  reauthenticateLinuxMathmlGreekRows,
  type LinuxMathmlGreekRasterRow,
} from "../tools/linux-mathml-greek-raster-gate.js";
import { measurePathsRasterResidual } from "../tools/paths-native-raster-metrics.js";
import { exactLinuxMathmlGreekPreterminal } from "./test-support/linux-mathml-greek-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function png(left: number): Promise<Buffer> {
  const width = 320, height = 160, channels = 4, data = Buffer.alloc(width * height * channels, 255);
  for (let y = 52; y < 78; y++) for (let x = left; x < left + 54; x++) {
    const offset = (y * width + x) * channels; data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0;
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function exactRow(runLabel: "proposal" | "validation", machine: string): Promise<{ root: string; row: LinuxMathmlGreekRasterRow }> {
  const root = mkdtempSync(join(tmpdir(), "dm2512-gate-")); roots.push(root);
  const [native, paths, hinting] = await Promise.all([png(48), png(49), png(50)]);
  writeFileSync(join(root, "native.png"), native); writeFileSync(join(root, "paths.png"), paths); writeFileSync(join(root, "hinting.png"), hinting);
  const preterminal = exactLinuxMathmlGreekPreterminal();
  const tokens = preterminal.tokens.map((token) => ({ id: token.id, glyph: token.glyph, baseline: token.geometry.baseline, matrix: token.geometry.matrix }));
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const residual = await measurePathsRasterResidual(native, paths), hintingOffResidual = await measurePathsRasterResidual(native, hinting);
  const fingerprint = {
    platform: "linux" as const, osImage: "ubuntu24", osImageVersion: "20260818.1", arch: "x64", osRelease: "6.11",
    chromium: "140.0", chromiumRevision: "r1", browserExecutableSha256: "c".repeat(64),
    fontconfigVersion: preterminal.inventory.fontconfigVersion, fontconfigConfigSha256: preterminal.inventory.configSha256,
    fontInventorySha256: preterminal.inventory.inventorySha256, rendererSourceSha256: "d".repeat(64), oracleSourceSha256: "e".repeat(64),
    consumerRasterizer: "playwright/chromium", playwrightVersion: "1.59.1", nodeVersion: "22.14.0", icuVersion: "78.2",
    sharpVersion: "0.34.3", libvipsVersion: "8.17.1", metricAlgorithm: LINUX_MATHML_GREEK_CELL.metricAlgorithm,
    launchFlags: ["headless", "isolated-fontconfig"], locale: "en-US",
  };
  return { root, row: {
    schemaVersion: 1, id: LINUX_MATHML_GREEK_CELL.id, runLabel,
    runProvenance: { githubRunId: "1", githubRunAttempt: "1", githubJob: runLabel, runnerName: runLabel, runnerBootIdSha256: machine.repeat(64), workflowRef: "owner/repo/.github/workflows/linux.yml@refs/heads/test" },
    cellSha256: linuxMathmlGreekCellSha256(), fingerprint, preterminal,
    pathsLogical: { sourceSha256: preterminal.sourceFont.sha256, faceIndex: 0, postscriptName: "FreeSans", subsetHintedSha256: LINUX_MATHML_GREEK_SUBSETS.hinted.sha256, subsetUnhintedSha256: LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256, tokens },
    hintingControl: { requestedFamily: "DMUnhinted", computedFamily: "DMUnhinted", fontFaceRuleFamily: "DMUnhinted", fontFaceRuleCount: 1, sourceSha256: LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256, sourceByteLength: LINUX_MATHML_GREEK_SUBSETS.unhinted.byteLength, isCustomFont: true, glyphCount: 4, tokens },
    nativeArtifact: { path: "native.png", sha256: sha(native), width: 320, height: 160 },
    pathsArtifact: { path: "paths.png", sha256: sha(paths), width: 320, height: 160 },
    hintingOffArtifact: { path: "hinting.png", sha256: sha(hinting), width: 320, height: 160 },
    residual, hintingOffResidual, warnings: [],
  } };
}

describe("DM-2512 Linux MathML Greek logical-first gate", () => {
  it("reauthenticates PNG bytes, dimensions, residuals, and the exact logical seam", async () => {
    const { root, row } = await exactRow("proposal", "a");
    await expect(reauthenticateLinuxMathmlGreekRows([row], root)).resolves.toHaveLength(1);
    const mutated: any = structuredClone(row); mutated.nativeArtifact.sha256 = "f".repeat(64);
    await expect(reauthenticateLinuxMathmlGreekRows([mutated], root)).rejects.toThrow(/SHA-256 is unauthenticated/);
  });

  it("rejects a self-consistent wrong logical witness before raster eligibility", async () => {
    const { row } = await exactRow("proposal", "a");
    const wrong: any = structuredClone(row);
    wrong.preterminal.tokens[0].glyph.gid++;
    wrong.pathsLogical.tokens[0].glyph.gid++;
    wrong.hintingControl.tokens[0].glyph.gid++;
    const report = adjudicateLinuxMathmlGreekRows([wrong], { schemaVersion: 1, entries: [] });
    expect(report.verdict).toBe("logical-mismatch");
    expect(report.eligibleForRatification).toBe(false);
  });

  it("requires independent machines and an active hinting-off control", async () => {
    const proposal = (await exactRow("proposal", "a")).row;
    const validation = (await exactRow("validation", "a")).row;
    expect(adjudicateLinuxMathmlGreekRows([proposal, validation], { schemaVersion: 1, entries: [] }).verdict).toBe("incomplete-independent-evidence");
    const inert: any = structuredClone(proposal); inert.hintingOffArtifact = inert.nativeArtifact; inert.hintingOffResidual.changedPixels = 0; inert.hintingOffResidual.totalChannelDelta = 0;
    expect(adjudicateLinuxMathmlGreekRows([inert], { schemaVersion: 1, entries: [] }).verdict).toBe("logical-mismatch");
  });

  it("emits an unratified candidate and accepts only the reviewed exact pair", async () => {
    const proposal = (await exactRow("proposal", "a")).row;
    const validation = (await exactRow("validation", "b")).row;
    const candidate = adjudicateLinuxMathmlGreekRows([proposal, validation], { schemaVersion: 1, entries: [] });
    expect(candidate.verdict).toBe("logical-exact-unratified");
    expect(candidate.eligibleForRatification).toBe(true);
    const entry = { ...candidate.candidateEnvelope!, reviewer: "independent-review", reviewedAt: "2026-08-23T00:00:00.000Z" };
    const ratified = adjudicateLinuxMathmlGreekRows([proposal, validation], { schemaVersion: 1, entries: [entry] });
    expect(ratified.verdict).toBe("ratified-rasterization-only");
    expect(ratified.pass).toBe(true);
    expect(entry.fingerprintSha256).toBe(linuxMathmlGreekFingerprintSha256(proposal.fingerprint));
  });
});
