import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SFNS_FONT_SHA256,
  SFNS_PINNED_CHROMIUM_REVISION,
  SFNS_PINNED_SKIA_REVISION,
  sfnsObservationLogicalDigest,
  sfnsPinnedArtifactDigest,
  validateSfnsPinnedSkiaProposal,
  type SfnsPinnedSkiaProposalArtifact,
} from "../tools/sfns-pinned-skia-mask-schema.js";

const retained = JSON.parse(readFileSync(new URL(
  "../.pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json",
  import.meta.url,
), "utf8")) as SfnsPinnedSkiaProposalArtifact;

function evidence(): SfnsPinnedSkiaProposalArtifact {
  return structuredClone(retained);
}

function seal(artifact: SfnsPinnedSkiaProposalArtifact): SfnsPinnedSkiaProposalArtifact {
  artifact.artifactDigest = sfnsPinnedArtifactDigest(artifact);
  return artifact;
}

describe("pinned-Skia SFNS post-conversion proposal evidence", () => {
  it("retains exact source, lifecycle, matrix, rec, gamma, and A8 mask bytes", () => {
    expect(validateSfnsPinnedSkiaProposal(retained)).toEqual([]);
    expect(retained.collectionContract).toEqual({
      browserLaunches: 0,
      processIsolation: "one-native-process-per-observation",
      equality: "exact-bytes-no-tolerance",
    });
    expect(retained.build).toMatchObject({
      chromiumRevision: SFNS_PINNED_CHROMIUM_REVISION,
      skiaRevision: SFNS_PINNED_SKIA_REVISION,
      platform: "darwin",
    });
    const observations = retained.scenarios.flatMap((scenario) => scenario.observations);
    expect(observations).toHaveLength(20);
    for (const observation of observations) {
      expect(observation.source.fontSha256).toBe(SFNS_FONT_SHA256);
      expect(observation.rawRec.maskFormat).toBe("LCD16");
      expect(observation.filteredRec.maskFormat).toBe("A8");
      expect(observation.gamma).toMatchObject({
        tableApplicable: true,
        tableByteLength: 2048,
        preblendApplicable: true,
      });
      expect(observation.glyphs).toHaveLength(6);
      expect(observation.glyphs.every((glyph) => glyph.metrics.maskFormat === "A8"
        && Buffer.from(glyph.mask.bytes, "base64").length === glyph.metrics.imageSize)).toBe(true);
    }
    expect(retained.scenarios.find((scenario) => scenario.id === "zoom-2-transform-half")!
      .observations[0].matrices.scale).toEqual([13, 13]);
    expect(retained.scenarios.find((scenario) => scenario.id === "zoom-2")!
      .observations[0].matrices.scale).toEqual([26, 26]);
  });

  it("requires four exact cold/warm observations for every scenario", () => {
    const artifact = evidence();
    artifact.scenarios[0].observations.pop();
    seal(artifact);
    expect(validateSfnsPinnedSkiaProposal(artifact)).toContain("zoom-2:observation-count");

    const unstable = evidence();
    unstable.scenarios[0].observations[3].glyphs[0].mask.sha256 = "0".repeat(64);
    unstable.scenarios[0].observations[3].glyphs[0].mask.bytes = "";
    seal(unstable);
    expect(validateSfnsPinnedSkiaProposal(unstable)).toEqual(expect.arrayContaining([
      "zoom-2:cold-warm-instability",
      "zoom-2-warm-2:glyph:0:image-size",
    ]));
  });

  it("rejects source drift and corrupt embedded bytes even when the envelope is resealed", () => {
    const sourceDrift = evidence();
    sourceDrift.scenarios[0].observations[0].source.skiaRevision = "0".repeat(40);
    sourceDrift.scenarios[0].observationLogicalDigest = sfnsObservationLogicalDigest(
      sourceDrift.scenarios[0].observations[0],
    );
    seal(sourceDrift);
    expect(validateSfnsPinnedSkiaProposal(sourceDrift)).toContain("zoom-2-cold-1:source-revision");

    const corrupt = evidence();
    corrupt.scenarios[1].observations[0].glyphs[0].mask.bytes = "AAAA";
    corrupt.scenarios[1].observationLogicalDigest = sfnsObservationLogicalDigest(
      corrupt.scenarios[1].observations[0],
    );
    seal(corrupt);
    expect(validateSfnsPinnedSkiaProposal(corrupt)).toEqual(expect.arrayContaining([
      "transform-scale-2-cold-1:glyph:0:image-size",
      "transform-scale-2-cold-1:glyph:0:sha256",
    ]));
  });

  it("requires all six positive controls to move their exact evidence groups", () => {
    const artifact = evidence();
    const baseline = artifact.scenarios.find((scenario) => scenario.id === "zoom-2")!
      .observations[0];
    const phase = artifact.controls.find((control) => control.id === "subpixel-phase")!;
    phase.observation = structuredClone(baseline);
    phase.observation.observationId = "control-subpixel-phase-cold-1";
    phase.changedEvidenceGroups = [];
    seal(artifact);
    expect(validateSfnsPinnedSkiaProposal(artifact)).toEqual(expect.arrayContaining([
      "subpixel-phase:request",
      "subpixel-phase:inactive:phase",
      "subpixel-phase:inactive:mask",
    ]));
  });

  it("rejects the wrong effective cancellation scale and envelope tampering", () => {
    const artifact = evidence();
    const cancellation = artifact.scenarios.find(
      (scenario) => scenario.id === "zoom-2-transform-half",
    )!;
    for (const observation of cancellation.observations) observation.matrices.scale = [26, 26];
    cancellation.observationLogicalDigest = sfnsObservationLogicalDigest(cancellation.observations[0]);
    seal(artifact);
    expect(validateSfnsPinnedSkiaProposal(artifact)).toContain(
      "zoom-2-transform-half:factored-scale",
    );

    const unsealed = evidence();
    unsealed.corpus.glyphIds[0]++;
    expect(validateSfnsPinnedSkiaProposal(unsealed)).toEqual(expect.arrayContaining([
      "corpus-glyphs", "artifact-digest",
    ]));
  });
});
