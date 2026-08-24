import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjudicateSfnsTerminalMasks } from "../tools/sfns-terminal-mask-adjudicator.js";
import type {
  SfnsPinnedObservation,
  SfnsPinnedSkiaProposalArtifact,
} from "../tools/sfns-pinned-skia-mask-schema.js";
import type {
  SfnsPinnedChromiumValidationArtifact,
  SfnsGammaPayload,
  SfnsMaskPayload,
  SfnsRawPayload,
  SfnsRunPayload,
  SfnsShapePayload,
  SfnsValidationObservation,
} from "../tools/sfns-pinned-chromium-validation-schema.js";
import {
  sfnsValidationArtifactDigest,
  sfnsValidationChangedEvidenceGroups,
  sfnsValidationObservationDigest,
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

function resealValidation(artifact: SfnsPinnedChromiumValidationArtifact): void {
  for (const scenario of artifact.scenarios) {
    for (const observation of scenario.observations) {
      observation.logicalDigest = sfnsValidationObservationDigest(observation);
    }
    scenario.observationLogicalDigest = sfnsValidationObservationDigest(scenario.observations[0]);
  }
  const baseline = artifact.scenarios.find(
    (scenario) => scenario.id === "zoom-2",
  )!.observations[0];
  for (const control of artifact.controls) {
    control.observation.logicalDigest = sfnsValidationObservationDigest(control.observation);
    control.changedEvidenceGroups = sfnsValidationChangedEvidenceGroups(
      baseline,
      control.observation,
    );
  }
  artifact.artifactDigest = sfnsValidationArtifactDigest(artifact);
}

function mutatedValidation(
  mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => void,
): SfnsPinnedChromiumValidationArtifact {
  const copy = structuredClone(validation);
  mutate(copy);
  resealValidation(copy);
  return copy;
}

function selectedPayload<T>(
  observation: SfnsValidationObservation,
  sequence: number,
): T {
  return observation.events.find((event) => event.sequence === sequence)!.payload as T;
}

describe("exact SFNS terminal-mask adjudicator v3", () => {
  it("compares the independently collected proposal and validation-v2 evidence exactly", () => {
    const report = adjudicateSfnsTerminalMasks(proposal, validation);
    const groups = new Set(report.mismatches.map((mismatch) => mismatch.group));
    const count = (group: string): number => report.mismatches.filter(
      (mismatch) => mismatch.group === group,
    ).length;

    expect(report.schemaVersion).toBe(3);
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
    expect(report.mismatches).toHaveLength(498);
    expect(groups).toContain("glyph-0-shapedAdvance");
    expect(count("gamma")).toBe(1);
    expect(count("glyph-0-shapedAdvance")).toBe(26);
    expect(count("glyph-1-shapedAdvance")).toBe(5);
    expect(count("glyph-5-shapedAdvance")).toBe(5);
    for (const aligned of [
      "source", "paint", "surfaceProps", "scalerContextFlags", "matrices",
      "smoothBehavior", "fontMetrics", "glyph-count", "observation-identity",
      "glyph-0-identity", "glyph-1-identity", "glyph-2-identity", "glyph-3-identity",
      "glyph-4-identity", "glyph-5-identity", "glyph-0-strikeAdvance",
      "glyph-1-strikeAdvance", "glyph-2-strikeAdvance", "glyph-3-strikeAdvance",
      "glyph-4-strikeAdvance", "glyph-5-strikeAdvance", "glyph-0-placement",
      "glyph-0-phase", "glyph-0-metrics", "glyph-0-shapedOffset",
      "glyph-1-shapedOffset", "glyph-2-shapedOffset", "glyph-3-shapedOffset",
      "glyph-4-shapedOffset", "glyph-5-shapedOffset",
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

  it.each([
    {
      name: "dropped selected event",
      expected: "event-dropped",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const index = observation.events.findIndex(
          (event) => event.sequence === observation.selection.shapeSequence,
        );
        observation.events.splice(index, 1);
      },
    },
    {
      name: "wrong source revision",
      expected: "source-revision",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        artifact.scenarios[0].observations[0].events[0].source.skiaRevision = "wrong";
      },
    },
    {
      name: "wrong decoded font",
      expected: "font-identity",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        artifact.scenarios[0].observations[0].events[0]
          .typeface.fontBytes.sha256 = "0".repeat(64);
      },
    },
    {
      name: "wrong axis",
      expected: "axis:wdth",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const event = observation.events.find(
          (candidate) => candidate.sequence === observation.selection.runSequence,
        )!;
        event.typeface.axes.find((axis) => axis.tag === "wdth")!.actual = 99;
      },
    },
    {
      name: "wrong glyph id",
      expected: "shaping-run-seam",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsShapePayload>(
          observation, observation.selection.shapeSequence,
        ).glyphs[0].gid += 1;
      },
    },
    {
      name: "wrong phase",
      expected: "packed-phase",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsRunPayload>(
          observation, observation.selection.runSequence,
        ).glyphs[0].phase.x ^= 1;
      },
    },
    {
      name: "wrong anti-aliasing result",
      expected: ":font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "anti-aliasing",
        )!.observation;
        selectedPayload<SfnsRawPayload>(
          observation, observation.selection.rawSequence,
        ).font.edging = "subpixel";
      },
    },
    {
      name: "wrong hinting result",
      expected: ":font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "hinting",
        )!.observation;
        selectedPayload<SfnsRawPayload>(
          observation, observation.selection.rawSequence,
        ).font.hinting = "normal";
      },
    },
    {
      name: "wrong device matrix",
      expected: "matrix-factorization",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsRawPayload>(
          observation, observation.selection.rawSequence,
        ).deviceMatrix[2] += 0.25;
      },
    },
    {
      name: "wrong optical-size result",
      expected: "axis:opsz",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "optical-size",
        )!.observation;
        const event = observation.events.find(
          (candidate) => candidate.sequence === observation.selection.runSequence,
        )!;
        event.typeface.axes.find((axis) => axis.tag === "opsz")!.actual = 17;
      },
    },
    {
      name: "wrong surface result",
      expected: ":surface",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "surface-mask-format",
        )!.observation;
        selectedPayload<SfnsRawPayload>(
          observation, observation.selection.rawSequence,
        ).surfaceProps.pixelGeometry = "rgb-h";
      },
    },
    {
      name: "wrong gamma bytes",
      expected: "gamma-table:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const gamma = selectedPayload<SfnsGammaPayload>(
          observation, observation.selection.gammaSequence,
        );
        const bytes = Buffer.from(gamma.tableBytesBase64, "base64");
        bytes[0] ^= 1;
        gamma.tableBytesBase64 = bytes.toString("base64");
      },
    },
    {
      name: "wrong mask bytes",
      expected: "mask:0:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const mask = selectedPayload<SfnsMaskPayload>(
          observation, observation.selection.maskSequences[0],
        ).glyph.mask;
        const bytes = Buffer.from(mask.bytes, "base64");
        bytes[0] ^= 1;
        mask.bytes = bytes.toString("base64");
      },
    },
  ])("adjudicator rejects resealed validation-v2 $name", ({ mutate, expected }) => {
    const report = adjudicateSfnsTerminalMasks(proposal, mutatedValidation(mutate));
    expect(report.ready).toBe(false);
    expect(report.inputIntegrityErrors.some((error) => error.includes(expected))).toBe(true);
    expect(report.observationPairs).toEqual([]);
  });
});
