import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adjudicateSfnsTerminalMasks,
} from "../tools/sfns-terminal-mask-adjudicator.js";
import type {
  SfnsPinnedObservation,
  SfnsPinnedSkiaProposalArtifact,
} from "../tools/sfns-pinned-skia-mask-schema.js";
import type {
  SfnsPinnedChromiumValidationArtifact,
} from "../tools/sfns-pinned-chromium-validation-schema.js";

const proposalPath = ".pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json";
const validationPath = ".pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json";
const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as SfnsPinnedSkiaProposalArtifact;
const validation = JSON.parse(
  readFileSync(validationPath, "utf8"),
) as SfnsPinnedChromiumValidationArtifact;

function mutatedProposal(
  mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => void,
): SfnsPinnedSkiaProposalArtifact {
  const copy = structuredClone(proposal);
  mutate(copy);
  return copy;
}

describe("exact SFNS terminal-mask adjudicator", () => {
  it("authenticates both arms and reports the retained cross-arm mismatch exactly", () => {
    const report = adjudicateSfnsTerminalMasks(proposal, validation);
    const groups = new Set(report.mismatches.map((mismatch) => mismatch.group));

    expect(report.inputIntegrityErrors).toEqual([
      "independence:observation-id-overlap",
    ]);
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
      distinctObservationIds: false,
    }));
    expect(groups).toEqual(expect.objectContaining(new Set([
      "observation-identity",
      "typeface",
      "paint",
      "surfaceProps",
      "rawRec",
      "filteredRec",
      "gamma",
      "fontMetrics",
      "glyph-0-offset",
      "glyph-0-placement",
      "glyph-0-phase",
      "glyph-0-mask",
    ])));
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
      name: "duplicated observation",
      expected: "observation-identity",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[1].observationId =
          artifact.scenarios[0].observations[0].observationId;
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
      name: "stale scenario envelope",
      expected: "scenario-id",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].scenarioId = "stale-scenario";
      },
    },
    {
      name: "wrong source revision",
      expected: "source-revision",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].source.skiaRevision = "wrong";
      },
    },
    {
      name: "wrong font identity",
      expected: "font-bytes",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].source.fontSha256 = "0".repeat(64);
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
      name: "wrong gid",
      expected: "glyph:0:identity",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].glyphs[0].gid += 1;
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
      name: "wrong antialiasing and hinting",
      expected: "font-request",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].font.edging = "alias";
        artifact.scenarios[0].observations[0].font.hinting = "none";
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
      name: "wrong optical size",
      expected: "request:0",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].request.opsz = 26;
      },
    },
    {
      name: "wrong surface geometry and mask format",
      expected: "rec-mask-format-route",
      mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => {
        artifact.scenarios[0].observations[0].request.pixelGeometry = "unknown";
      },
    },
    {
      name: "wrong post-conversion mask byte",
      expected: "glyph:0:sha256",
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

  it("detects an exact 13px-versus-26px cancellation mutation", () => {
    const changed = mutatedProposal((artifact) => {
      artifact.scenarios.find((scenario) => scenario.id === "zoom-2-transform-half")!
        .observations[0].matrices.scale = [26, 26];
    });
    const report = adjudicateSfnsTerminalMasks(changed, validation);
    expect(report.cancellationDecision.exact).toBe(false);
    expect(report.inputIntegrityErrors).toContain("cancellation:not-exact-13px-scaler");
    expect(report.ready).toBe(false);
  });
});
