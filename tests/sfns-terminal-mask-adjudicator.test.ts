import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjudicateSfnsTerminalMasks } from "../tools/sfns-terminal-mask-adjudicator.js";
import type { SfnsPinnedObservation, SfnsPinnedSkiaProposalArtifact } from "../tools/sfns-pinned-skia-mask-schema.js";
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

const proposal = JSON.parse(
  readFileSync(".pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json", "utf8"),
) as SfnsPinnedSkiaProposalArtifact;
const validation = JSON.parse(
  readFileSync(".pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json", "utf8"),
) as SfnsPinnedChromiumValidationArtifact;

function mutatedProposal(mutate: (artifact: SfnsPinnedSkiaProposalArtifact) => void): SfnsPinnedSkiaProposalArtifact {
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
  const baseline = artifact.scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0];
  for (const control of artifact.controls) {
    control.observation.logicalDigest = sfnsValidationObservationDigest(control.observation);
    control.changedEvidenceGroups = sfnsValidationChangedEvidenceGroups(baseline, control.observation);
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

function selectedPayload<T>(observation: SfnsValidationObservation, sequence: number): T {
  return observation.events.find((event) => event.sequence === sequence)!.payload as T;
}

describe("exact SFNS terminal-mask adjudicator v3", () => {
  it("compares the independently collected proposal and validation-v2 evidence exactly", () => {
    const report = adjudicateSfnsTerminalMasks(proposal, validation);
    const groups = new Set(report.mismatches.map((mismatch) => mismatch.group));
    const count = (group: string): number => report.mismatches.filter((mismatch) => mismatch.group === group).length;

    expect(report.schemaVersion).toBe(3);
    expect(report.inputIntegrityErrors).toEqual([]);
    expect(report.observationPairs).toHaveLength(26);
    expect(report.cancellationDecision).toEqual(
      expect.objectContaining({
        required: "13px-scaler-not-26px-later-resample",
        requiredScale: [13, 13],
        exact: true,
      }),
    );
    expect(report.independence).toEqual(
      expect.objectContaining({
        distinctAuthorities: true,
        distinctBuildIdentities: true,
        distinctBinaryDigests: true,
        distinctObservationIds: true,
      }),
    );
    // DM-8JNC05: once the proposal shapes with Chromium's pinned HarfBuzz,
    // clones its typeface the way Blink does, and builds with Chromium's macOS
    // gamma defines, every one of the 26 pairs agrees byte for byte.
    expect(report.mismatches).toEqual([]);
    expect(groups.size).toBe(0);
    expect(count("glyph-0-shapedAdvance")).toBe(0);
    expect(report.observationPairs.every((pair) => pair.mismatchGroups.length === 0)).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.reportDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("DM-8JNC05: an unshaped proposal advance is a mismatch, not readiness", () => {
    // The pre-fix proposal used Skia's glyph width for `z`; Blink's HarfBuzz run
    // applies the `z`->`o` GPOS kern on top of it.
    const unshaped = mutatedProposal((artifact) => {
      const glyph = artifact.scenarios.find((entry) => entry.id === "zoom-2")!.observations[0].glyphs[0];
      glyph.shapedAdvance = glyph.strikeAdvance;
    });
    const report = adjudicateSfnsTerminalMasks(unshaped, validation);
    // The proposal schema re-derives each origin from the shaped advances, so the
    // swapped width is refused as inconsistent evidence before any comparison.
    expect(report.inputIntegrityErrors).toContain("proposal:proposal-zoom-2-cold-1:glyph:1:derived-run");
    expect(report.ready).toBe(false);
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
        const index = observation.events.findIndex((event) => event.sequence === observation.selection.shapeSequence);
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
        artifact.scenarios[0].observations[0].events[0].typeface.fontBytes.sha256 = "0".repeat(64);
      },
    },
    {
      name: "wrong axis",
      expected: "axis:wdth",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const event = observation.events.find((candidate) => candidate.sequence === observation.selection.runSequence)!;
        event.typeface.axes.find((axis) => axis.tag === "wdth")!.actual = 99;
      },
    },
    {
      name: "wrong glyph id",
      expected: "shaping-run-seam",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsShapePayload>(observation, observation.selection.shapeSequence).glyphs[0].gid += 1;
      },
    },
    {
      name: "wrong phase",
      expected: "packed-phase",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsRunPayload>(observation, observation.selection.runSequence).glyphs[0].phase.x ^= 1;
      },
    },
    {
      name: "wrong anti-aliasing result",
      expected: ":font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find((control) => control.id === "anti-aliasing")!.observation;
        selectedPayload<SfnsRawPayload>(observation, observation.selection.rawSequence).font.edging = "subpixel";
      },
    },
    {
      name: "wrong hinting result",
      expected: ":font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find((control) => control.id === "hinting")!.observation;
        selectedPayload<SfnsRawPayload>(observation, observation.selection.rawSequence).font.hinting = "normal";
      },
    },
    {
      name: "wrong device matrix",
      expected: "matrix-factorization",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        selectedPayload<SfnsRawPayload>(observation, observation.selection.rawSequence).deviceMatrix[2] += 0.25;
      },
    },
    {
      name: "wrong optical-size result",
      expected: "axis:opsz",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find((control) => control.id === "optical-size")!.observation;
        const event = observation.events.find((candidate) => candidate.sequence === observation.selection.runSequence)!;
        event.typeface.axes.find((axis) => axis.tag === "opsz")!.actual = 17;
      },
    },
    {
      name: "wrong surface result",
      expected: ":surface",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find((control) => control.id === "surface-mask-format")!.observation;
        selectedPayload<SfnsRawPayload>(observation, observation.selection.rawSequence).surfaceProps.pixelGeometry =
          "rgb-h";
      },
    },
    {
      name: "wrong gamma bytes",
      expected: "gamma-table:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const gamma = selectedPayload<SfnsGammaPayload>(observation, observation.selection.gammaSequence);
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
        const mask = selectedPayload<SfnsMaskPayload>(observation, observation.selection.maskSequences[0]).glyph.mask;
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
