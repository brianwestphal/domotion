import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SFNS_DECODED_FONT_SHA256,
  SFNS_FONT_SHA256,
  sfnsObservationLogicalDigest,
  sfnsOtsMetadataDigest,
  sfnsPinnedArtifactDigest,
  validateSfnsPinnedSkiaProposal,
  type SfnsPinnedSkiaProposalArtifact,
} from "../tools/sfns-pinned-skia-mask-schema.js";
import {
  SFNS_TERMINAL_MASK_MANIFEST_ABI,
  sfnsTerminalMaskManifestDigest,
} from "../tools/sfns-terminal-mask-manifest.js";

const retained = JSON.parse(readFileSync(
  new URL("../.pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json", import.meta.url),
  "utf8",
)) as SfnsPinnedSkiaProposalArtifact;
const fileSha = (path: string): string => createHash("sha256")
  .update(readFileSync(path)).digest("hex");

function evidence(): SfnsPinnedSkiaProposalArtifact {
  return structuredClone(retained);
}

function seal(artifact: SfnsPinnedSkiaProposalArtifact): SfnsPinnedSkiaProposalArtifact {
  artifact.scenarios.forEach((scenario) => {
    scenario.observationLogicalDigest = sfnsObservationLogicalDigest(scenario.observations[0]);
  });
  artifact.artifactDigest = sfnsPinnedArtifactDigest(artifact);
  return artifact;
}

describe("DM-2586 pinned-Skia proposal evidence v2", () => {
  it("authenticates the source manifest, independent OTS output, and 26 native observations", () => {
    expect(validateSfnsPinnedSkiaProposal(retained)).toEqual([]);
    expect(retained).toMatchObject({
      schemaVersion: 2,
      arm: "proposal",
      manifest: {
        abi: SFNS_TERMINAL_MASK_MANIFEST_ABI,
        digest: sfnsTerminalMaskManifestDigest(),
      },
      collectionContract: {
        browserLaunches: 0,
        processIsolation: "one-native-process-per-observation",
        inputDerivation: "source-owned-manifest-independent-arm-derivation",
        equality: "exact-bytes-no-tolerance",
      },
    });
    expect(retained.ots.metadata).toMatchObject({
      authority: "proposal-independent-pinned-chromium-ots",
      sourceFont: { sha256: SFNS_FONT_SHA256, byteLength: 7_909_644 },
      decodedFont: { sha256: SFNS_DECODED_FONT_SHA256, byteLength: 7_806_016 },
    });
    expect(retained.ots.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(retained.ots.metadataLogicalDigest).toBe(sfnsOtsMetadataDigest(retained.ots.metadata));
    expect(retained.build.source).toEqual({
      builderSha256: fileSha("tools/build-sfns-pinned-skia-collector.mjs"),
      cppSha256: fileSha(
        "tools/sfns-pinned-skia-collector/sfns_post_conversion_collector.cpp",
      ),
      buildGnSha256: fileSha("tools/sfns-pinned-skia-collector/BUILD.gn"),
      manifestSha256: fileSha("tools/sfns-terminal-mask-manifest.ts"),
      schemaSha256: fileSha("tools/sfns-pinned-skia-mask-schema.ts"),
      collectorSha256: fileSha("tools/sfns-pinned-skia-mask-collector.ts"),
    });
    expect(retained.ots.metadata.sources).toMatchObject({
      builderSha256: fileSha("tools/build-sfns-pinned-ots-sanitizer.mjs"),
      sanitizerCppSha256: fileSha(
        "tools/sfns-pinned-ots-sanitizer/sfns_pinned_ots_sanitizer.cc",
      ),
      sanitizerBuildGnSha256: fileSha("tools/sfns-pinned-ots-sanitizer/BUILD.gn"),
    });
    const observations = retained.scenarios.flatMap((scenario) => scenario.observations)
      .concat(retained.controls.map((control) => control.observation));
    expect(observations).toHaveLength(26);
    expect(observations.every((observation) => observation.observationId.startsWith("proposal-")))
      .toBe(true);
    expect(new Set(observations.map((observation) => observation.observationId)).size).toBe(26);
  });

  it("retains exact decoded typeface, white paint, translated matrices, CT metrics, and all bytes", () => {
    for (const observation of retained.scenarios.flatMap((entry) => entry.observations)) {
      expect(observation.source).toMatchObject({
        original: { sha256: SFNS_FONT_SHA256 },
        decoded: { sha256: SFNS_DECODED_FONT_SHA256, collectionIndex: 0 },
      });
      expect(observation.typeface.fontBytes).toEqual({
        authority: "ots-sanitized-sfnt",
        byteLength: 7_806_016,
        collectionIndex: 0,
        sha256: SFNS_DECODED_FONT_SHA256,
      });
      expect(observation.paint).toEqual({ color: 0xffff_ffff, style: 0 });
      expect(observation.surfaceProps).toMatchObject({
        flags: 0, textContrast: 0, textGamma: 0,
      });
      expect(observation.matrices.device).toEqual(observation.request.run.liveDeviceMatrix);
      expect(observation.coreTextMetrics.normalized).toMatchObject({
        coordinateSystem: "device-y-down",
        baseline: observation.request.run.deviceBaseline,
      });
      expect(Buffer.from(observation.rawRec.bytesBase64, "base64")).toHaveLength(56);
      expect(Buffer.from(observation.filteredRec.bytesBase64, "base64")).toHaveLength(56);
      expect(Buffer.from(observation.gamma.tableBytesBase64, "base64"))
        .toHaveLength(observation.gamma.tableByteLength);
      for (const channel of ["R", "G", "B"] as const) {
        expect(Buffer.from(observation.gamma[`preblend${channel}256Base64`], "base64"))
          .toHaveLength(observation.gamma.preblendByteLength);
      }
      expect(observation.glyphs).toHaveLength(6);
      for (const glyph of observation.glyphs) {
        expect(glyph).toEqual(expect.objectContaining({
          shapedOffset: [0, 0],
          deviceBaseline: observation.request.run.deviceBaseline,
          subpixelOffsetFixed: [glyph.phase.x << 14, glyph.phase.y << 14],
        }));
        expect(Buffer.from(glyph.mask.bytes, "base64")).toHaveLength(glyph.metrics.imageSize);
      }
    }
    expect(retained.scenarios.find((entry) => entry.id === "zoom-2-transform-half")!
      .observations[0].matrices.scale).toEqual([13, 13]);
    expect(retained.scenarios.find((entry) => entry.id === "zoom-2")!
      .observations.map((observation) => observation.typeface.postscriptName))
      .toEqual(Array(4).fill(".SFNS-Bold"));
    expect(retained.scenarios.find((entry) => entry.id === "opsz-26-mutation")!
      .observations.map((observation) => observation.typeface.postscriptName))
      .toEqual(Array(4).fill(".SFNS-Regular_wdth_opsz1A0000_GRAD_wght2BC0000"));
  });

  it("requires two cold and two warm exact observations per scenario", () => {
    const dropped = evidence();
    dropped.scenarios[0].observations.pop();
    seal(dropped);
    expect(validateSfnsPinnedSkiaProposal(dropped)).toContain("zoom-2:observation-count");

    const unstable = evidence();
    unstable.scenarios[0].observations[3].glyphs[0].strikeAdvance[0] += 1;
    seal(unstable);
    expect(validateSfnsPinnedSkiaProposal(unstable)).toContain("zoom-2:cold-warm-instability");
  });

  it.each([
    {
      name: "manifest identity",
      expected: "manifest-identity",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => { artifact.manifest.digest = "0".repeat(64); },
    },
    {
      name: "independent OTS identity",
      expected: "ots-authentication",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.ots.metadata.decodedFont.sha256 = "0".repeat(64);
      },
    },
    {
      name: "arm-qualified id",
      expected: "arm-qualified-id",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].observationId = "zoom-2-cold-1";
      },
    },
    {
      name: "white paint",
      expected: "paint-white",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].paint.color = 0xff00_0000;
      },
    },
    {
      name: "surface contrast",
      expected: "surface",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].surfaceProps.textContrast = 0.5;
      },
    },
    {
      name: "live matrix",
      expected: "matrix-factorization",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].matrices.device[2] += 0.25;
      },
    },
    {
      name: "derived shaped advance",
      expected: "derived-run",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].glyphs[0].shapedAdvance[0] += 0.25;
      },
    },
    {
      name: "packed phase",
      expected: "packed-phase",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].glyphs[0].subpixelOffsetFixed[0] ^= 16_384;
      },
    },
    {
      name: "self-consistent but position-wrong packed phase",
      expected: "packed-phase",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const glyph = artifact.scenarios[0].observations[0].glyphs[0];
        glyph.phase.x = (glyph.phase.x + 1) & 3;
        glyph.packedId = (glyph.packedId & ~3) | glyph.phase.x;
        glyph.subpixelOffsetFixed[0] = glyph.phase.x << 14;
      },
    },
    {
      name: "normalized CoreText baseline",
      expected: "coretext-normalization",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].coreTextMetrics.normalized.baseline += 1;
      },
    },
    {
      name: "raw rec bytes",
      expected: "raw-rec:sha256",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const rec = artifact.scenarios[0].observations[0].rawRec;
        const bytes = Buffer.from(rec.bytesBase64, "base64");
        bytes[8] ^= 1;
        rec.bytesBase64 = bytes.toString("base64");
      },
    },
    {
      name: "full preblend bytes",
      expected: "preblend-r:sha256",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const gamma = artifact.scenarios[0].observations[0].gamma;
        const bytes = Buffer.from(gamma.preblendR256Base64, "base64");
        bytes[0] ^= 1;
        gamma.preblendR256Base64 = bytes.toString("base64");
      },
    },
    {
      name: "mask bytes",
      expected: "mask:sha256",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const mask = artifact.scenarios[0].observations[0].glyphs[0].mask;
        const bytes = Buffer.from(mask.bytes, "base64");
        bytes[0] ^= 1;
        mask.bytes = bytes.toString("base64");
      },
    },
  ])("rejects $name drift even after resealing", ({ mutate, expected }) => {
    const artifact = evidence();
    mutate(artifact);
    seal(artifact);
    expect(validateSfnsPinnedSkiaProposal(artifact).some((error) => error.includes(expected)))
      .toBe(true);
  });

  it("returns a fail-closed error for a structurally malformed artifact", () => {
    const malformed = evidence() as unknown as Record<string, unknown>;
    delete malformed.build;
    expect(validateSfnsPinnedSkiaProposal(malformed as unknown as SfnsPinnedSkiaProposalArtifact))
      .toEqual([expect.stringContaining("malformed-artifact:")]);
  });
});
