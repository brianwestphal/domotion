import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjudicateSfnsTerminalMasks } from "../tools/sfns-terminal-mask-adjudicator.js";
import type {
  SfnsPinnedObservation,
  SfnsPinnedSkiaProposalArtifact,
} from "../tools/sfns-pinned-skia-mask-schema.js";
import type {
  SfnsPinnedChromiumValidationArtifact,
} from "../tools/sfns-pinned-chromium-validation-schema.js";

const proposal = JSON.parse(readFileSync(
  ".pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json",
  "utf8",
)) as SfnsPinnedSkiaProposalArtifact;
const validation = JSON.parse(readFileSync(
  ".pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json",
  "utf8",
)) as SfnsPinnedChromiumValidationArtifact;

function mutatedProposal(
  mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => void,
): SfnsPinnedSkiaProposalArtifact {
  const copy = structuredClone(proposal);
  mutate(copy);
  return copy;
}

describe("exact SFNS terminal-mask adjudicator v2", () => {
  it("pairs the DM-2586 proposal exactly and keeps legacy validation-v1 gaps fail closed", () => {
    const report = adjudicateSfnsTerminalMasks(proposal, validation);
    const groups = new Set(report.mismatches.map((mismatch) => mismatch.group));
    const counts = Object.fromEntries([...groups].map((group) => [
      group,
      report.mismatches.filter((mismatch) => mismatch.group === group).length,
    ]));

    expect(report.schemaVersion).toBe(2);
    expect(report.inputIntegrityErrors).toEqual([]);
    expect(report.observationPairs).toHaveLength(26);
    expect(report.cancellationDecision).toEqual(expect.objectContaining({
      required: "13px-scaler-not-26px-later-resample",
      requiredScale: [13, 13],
      exact: true,
    }));
    expect(report.independence).toEqual(expect.objectContaining({
      distinctAuthorities: true,
      distinctBuildIdentities: true,
      distinctBinaryDigests: true,
      distinctObservationIds: true,
    }));
    expect(report.mismatches).toHaveLength(784);
    expect(counts).toMatchObject({
      gamma: 26,
      typeface: 21,
      "glyph-0-shapedAdvance": 26,
      "glyph-0-shapedOffset": 26,
      "glyph-1-shapedAdvance": 26,
      "glyph-1-shapedOffset": 26,
      "glyph-2-shapedAdvance": 26,
      "glyph-2-shapedOffset": 26,
      "glyph-3-shapedAdvance": 26,
      "glyph-3-shapedOffset": 26,
      "glyph-4-shapedAdvance": 26,
      "glyph-4-shapedOffset": 26,
      "glyph-5-shapedAdvance": 26,
      "glyph-5-shapedOffset": 26,
      "glyph-1-placement": 26,
      "glyph-2-placement": 26,
      "glyph-3-placement": 26,
      "glyph-4-placement": 26,
      "glyph-5-placement": 26,
    });
    for (const aligned of [
      "source", "paint", "surfaceProps", "scalerContextFlags", "matrices",
      "smoothBehavior", "fontMetrics", "glyph-count", "observation-identity",
      "glyph-0-identity", "glyph-1-identity", "glyph-2-identity", "glyph-3-identity",
      "glyph-4-identity", "glyph-5-identity", "glyph-0-strikeAdvance",
      "glyph-1-strikeAdvance", "glyph-2-strikeAdvance", "glyph-3-strikeAdvance",
      "glyph-4-strikeAdvance", "glyph-5-strikeAdvance", "glyph-0-placement",
      "glyph-0-phase", "glyph-0-metrics",
    ]) expect(groups).not.toContain(aligned);
    expect(report.ready).toBe(false);
    expect(report.reportDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    {
      name: "dropped observation",
      expected: "observation-count",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        (artifact.scenarios[0].observations as SfnsPinnedObservation[]).pop();
      },
    },
    {
      name: "unqualified duplicate observation id",
      expected: "arm-qualified-id",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[1].observationId = "zoom-2-cold-1";
      },
    },
    {
      name: "reordered lifecycle",
      expected: "lifecycle",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations.reverse();
      },
    },
    {
      name: "wrong source revision",
      expected: "source-revisions",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].source.skiaRevision = "wrong";
      },
    },
    {
      name: "wrong decoded typeface bytes",
      expected: "typeface-font-bytes",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].typeface.fontBytes.sha256 = "0".repeat(64);
      },
    },
    {
      name: "wrong axis",
      expected: "axis:wdth",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].typeface.axes[0].actual = 99;
      },
    },
    {
      name: "wrong packed phase",
      expected: "packed-phase",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].glyphs[0].phase.x ^= 1;
      },
    },
    {
      name: "wrong matrix",
      expected: "matrix-factorization",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].matrices.scale[0] = 25;
      },
    },
    {
      name: "wrong full gamma bytes",
      expected: "gamma-table:sha256",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const bytes = Buffer.from(observation.gamma.tableBytesBase64, "base64");
        bytes[0] ^= 1;
        observation.gamma.tableBytesBase64 = bytes.toString("base64");
      },
    },
    {
      name: "wrong post-conversion mask byte",
      expected: "mask:sha256",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        const mask = artifact.scenarios[0].observations[0].glyphs[0].mask;
        const bytes = Buffer.from(mask.bytes, "base64");
        bytes[0] ^= 1;
        mask.bytes = bytes.toString("base64");
      },
    },
  ])("fails closed for $name", ({ mutate, expected }) => {
    const report = adjudicateSfnsTerminalMasks(mutatedProposal(mutate), validation);
    expect(report.ready).toBe(false);
    expect(report.inputIntegrityErrors.some((error) => error.includes(expected))).toBe(true);
    expect(report.observationPairs).toEqual([]);
  });
});
