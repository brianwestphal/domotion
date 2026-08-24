import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sfnsValidationArtifactDigest,
  sfnsValidationChangedEvidenceGroups,
  sfnsValidationObservationDigest,
  validateSfnsPinnedChromiumValidation,
  type SfnsFilteredPayload,
  type SfnsGammaPayload,
  type SfnsHookEventName,
  type SfnsMaskPayload,
  type SfnsPinnedChromiumValidationArtifact,
  type SfnsRawPayload,
  type SfnsRunPayload,
  type SfnsShapePayload,
  type SfnsValidationObservation,
} from "../tools/sfns-pinned-chromium-validation-schema.js";

const retained = JSON.parse(readFileSync(new URL(
  "../.pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json",
  import.meta.url,
), "utf8")) as SfnsPinnedChromiumValidationArtifact;

function evidence(): SfnsPinnedChromiumValidationArtifact {
  return structuredClone(retained);
}

function resealObservation(observation: SfnsValidationObservation): void {
  observation.logicalDigest = sfnsValidationObservationDigest(observation);
}

function reseal(artifact: SfnsPinnedChromiumValidationArtifact): void {
  for (const scenario of artifact.scenarios) {
    for (const observation of scenario.observations) resealObservation(observation);
    scenario.observationLogicalDigest = sfnsValidationObservationDigest(scenario.observations[0]);
  }
  for (const control of artifact.controls) resealObservation(control.observation);
  const baseline = artifact.scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0];
  for (const control of artifact.controls) {
    control.changedEvidenceGroups = sfnsValidationChangedEvidenceGroups(
      baseline,
      control.observation,
    );
  }
  artifact.artifactDigest = sfnsValidationArtifactDigest(artifact);
}

function firstMask(observation: SfnsValidationObservation): SfnsMaskPayload {
  const sequence = observation.selection.maskSequences[0];
  return observation.events.find((event) => event.sequence === sequence)!.payload as SfnsMaskPayload;
}

function selectedEvent<T>(
  observation: SfnsValidationObservation,
  event: SfnsHookEventName,
): T {
  const sequence = event === "shape" ? observation.selection.shapeSequence
    : event === "raw" ? observation.selection.rawSequence
      : event === "filtered" ? observation.selection.filteredSequence
        : event === "gamma" ? observation.selection.gammaSequence
          : event === "run" ? observation.selection.runSequence
            : observation.selection.maskSequences[0];
  return observation.events.find((candidate) => candidate.sequence === sequence)!.payload as T;
}

describe("pinned-Chromium SFNS validation evidence", () => {
  it("retains 26 isolated explicitly-headless observations and authenticates scale cancellation", () => {
    expect(validateSfnsPinnedChromiumValidation(retained)).toEqual([]);
    expect(retained.collectionContract).toEqual({
      browserLaunches: 26,
      processIsolation: "one-explicitly-headless-browser-per-observation",
      inputDerivation: "source-owned-manifest-independent-arm-derivation",
      equality: "exact-bytes-no-tolerance",
      productionRenderingChanges: false,
    });
    const observations = [
      ...retained.scenarios.flatMap((scenario) => scenario.observations),
      ...retained.controls.map((control) => control.observation),
    ];
    expect(observations).toHaveLength(26);
    expect(observations.every((observation) => observation.browser.explicitlyHeadless
      && observation.browser.launchArgs.includes("--headless=new"))).toBe(true);
    const baseline = retained.scenarios.find(
      (scenario) => scenario.id === "zoom-2",
    )!.observations[0];
    const baselineRaw = baseline.events.find(
      (event) => event.sequence === baseline.selection.rawSequence,
    )!.payload as SfnsRawPayload;
    const baselineFiltered = baseline.events.find(
      (event) => event.sequence === baseline.selection.filteredSequence,
    )!.payload as SfnsFilteredPayload;
    expect([baselineRaw.rawRec.maskFormat, baselineFiltered.after.maskFormat]).toEqual([
      "LCD16", "A8",
    ]);
    const cancellation = retained.scenarios.find(
      (scenario) => scenario.id === "zoom-2-transform-half",
    )!.observations[0];
    const filtered = cancellation.events.find(
      (event) => event.sequence === cancellation.selection.filteredSequence,
    )!.payload as SfnsFilteredPayload;
    expect(filtered.matrices.scale).toEqual([13, 13]);
    expect(firstMask(cancellation).glyph.metrics.maskFormat).toBe("A8");
    const surface = retained.controls.find(
      (control) => control.id === "surface-mask-format",
    )!.observation;
    const surfaceRaw = surface.events.find(
      (event) => event.sequence === surface.selection.rawSequence,
    )!.payload as SfnsRawPayload;
    expect(surfaceRaw.surfaceProps.pixelGeometry).toBe("unknown");
    expect(surfaceRaw.rawRec.maskFormat).toBe("A8");
  });

  it("rejects missing observations and dropped, duplicate, reordered, or stale events", () => {
    const missing = evidence();
    missing.scenarios[0].observations.pop();
    reseal(missing);
    expect(validateSfnsPinnedChromiumValidation(missing)).toContain("zoom-2:observation-count");

    const duplicate = evidence();
    const duplicateObservation = duplicate.scenarios[0].observations[0];
    duplicateObservation.events[1].sequence = duplicateObservation.events[0].sequence;
    reseal(duplicate);
    expect(validateSfnsPinnedChromiumValidation(duplicate)).toContain(
      "validation-zoom-2-cold-1:duplicate-sequence",
    );

    const reordered = evidence();
    const reorderedObservation = reordered.scenarios[0].observations[0];
    [reorderedObservation.events[0], reorderedObservation.events[1]] =
      [reorderedObservation.events[1], reorderedObservation.events[0]];
    reseal(reordered);
    expect(validateSfnsPinnedChromiumValidation(reordered)).toContain(
      "validation-zoom-2-cold-1:event-reordered",
    );

    const dropped = evidence();
    dropped.scenarios[0].observations[0].events.shift();
    reseal(dropped);
    expect(validateSfnsPinnedChromiumValidation(dropped)).toContain(
      "validation-zoom-2-cold-1:event-dropped",
    );

    const stale = evidence();
    stale.scenarios[0].observations[0].events[0].observationId = "prior-process-evidence";
    reseal(stale);
    expect(validateSfnsPinnedChromiumValidation(stale)).toContain(
      "validation-zoom-2-cold-1:stale-envelope",
    );
  });

  it("rejects source drift, non-headless launches, and corrupt exact mask bytes", () => {
    const depotTools = evidence();
    depotTools.build.depotToolsRevision = "0".repeat(40);
    reseal(depotTools);
    expect(validateSfnsPinnedChromiumValidation(depotTools)).toContain("build-revisions");

    const source = evidence();
    source.scenarios[0].observations[0].events[0].source.skiaRevision = "0".repeat(40);
    reseal(source);
    expect(validateSfnsPinnedChromiumValidation(source)).toContain(
      "validation-zoom-2-cold-1:source-revision",
    );

    const visible = evidence();
    const visibleBrowser = visible.scenarios[0].observations[0].browser as {
      explicitlyHeadless: boolean;
      launchArgs: string[];
    };
    visibleBrowser.explicitlyHeadless = false;
    visibleBrowser.launchArgs = visibleBrowser.launchArgs.filter(
      (argument) => !argument.startsWith("--headless"),
    );
    reseal(visible);
    expect(validateSfnsPinnedChromiumValidation(visible)).toContain(
      "validation-zoom-2-cold-1:not-explicitly-headless",
    );

    const corrupt = evidence();
    firstMask(corrupt.scenarios[0].observations[0]).glyph.mask.bytes = "AAAA";
    reseal(corrupt);
    expect(validateSfnsPinnedChromiumValidation(corrupt)).toEqual(expect.arrayContaining([
      "validation-zoom-2-cold-1:mask:0:byte-length",
      "validation-zoom-2-cold-1:mask:0:sha256",
    ]));
  });

  it("retains exact rec bytes while rejecting a mismatched process-local typeface id", () => {
    const artifact = evidence();
    const observation = artifact.scenarios[0].observations[0];
    const raw = observation.events.find(
      (event) => event.sequence === observation.selection.rawSequence,
    )!.payload as SfnsRawPayload;
    const bytes = Buffer.from(raw.rawRec.bytesBase64, "base64");
    bytes.writeUInt32LE(bytes.readUInt32LE(0) + 1, 0);
    raw.rawRec.bytesBase64 = bytes.toString("base64");
    raw.rawRec.sha256 = createHash("sha256").update(bytes).digest("hex");
    reseal(artifact);
    expect(validateSfnsPinnedChromiumValidation(artifact)).toContain(
      "validation-zoom-2-cold-1:rec-typeface-identity",
    );
  });

  it.each([
    {
      name: "manifest identity",
      expected: "manifest-identity",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        artifact.manifest.digest = "0".repeat(64);
      },
    },
    {
      name: "arm-qualified observation id",
      expected: "proposal-zoom-2-cold-1:arm-qualified-id",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        artifact.scenarios[0].observations[0].observationId = "proposal-zoom-2-cold-1";
      },
    },
    {
      name: "decoded typeface bytes",
      expected: "validation-zoom-2-cold-1:font-identity",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        artifact.scenarios[0].observations[0].events[0]
          .typeface.fontBytes.sha256 = "0".repeat(64);
      },
    },
    {
      name: "typeface family",
      expected: "validation-zoom-2-cold-1:typeface-identity",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const sequence = observation.selection.runSequence;
        observation.events.find((event) => event.sequence === sequence)!.typeface.family = "SFNS";
      },
    },
    {
      name: "variation axis",
      expected: "validation-zoom-2-cold-1:axis:wdth",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.scenarios[0].observations[0];
        const sequence = observation.selection.runSequence;
        observation.events.find((event) => event.sequence === sequence)!
          .typeface.axes.find((axis) => axis.tag === "wdth")!.actual = 99;
      },
    },
    {
      name: "glyph id",
      expected: "validation-zoom-2-cold-1:glyph:0:shaping-run-seam",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const shape = selectedEvent<SfnsShapePayload>(
          artifact.scenarios[0].observations[0], "shape",
        );
        shape.glyphs[0].gid += 1;
      },
    },
    {
      name: "direct shaped offset",
      expected: "validation-zoom-2-cold-1:glyph:0:shaping-run-seam",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const shape = selectedEvent<SfnsShapePayload>(
          artifact.scenarios[0].observations[0], "shape",
        );
        shape.glyphs[0].shapedOffset[0] += 0.25;
      },
    },
    {
      name: "packed subpixel phase",
      expected: "validation-zoom-2-cold-1:glyph:0:packed-phase",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const run = selectedEvent<SfnsRunPayload>(
          artifact.scenarios[0].observations[0], "run",
        );
        run.glyphs[0].phase.x ^= 1;
      },
    },
    {
      name: "anti-aliasing request result",
      expected: "validation-control-anti-aliasing-1:font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "anti-aliasing",
        )!.observation;
        selectedEvent<SfnsRawPayload>(observation, "raw").font.edging = "subpixel";
      },
    },
    {
      name: "hinting request result",
      expected: "validation-control-hinting-1:font",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "hinting",
        )!.observation;
        selectedEvent<SfnsRawPayload>(observation, "raw").font.hinting = "normal";
      },
    },
    {
      name: "live device matrix",
      expected: "validation-zoom-2-cold-1:matrix-factorization",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        selectedEvent<SfnsRawPayload>(
          artifact.scenarios[0].observations[0], "raw",
        ).deviceMatrix[2] += 0.25;
      },
    },
    {
      name: "optical-size axis",
      expected: "validation-control-optical-size-1:axis:opsz",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "optical-size",
        )!.observation;
        const sequence = observation.selection.runSequence;
        observation.events.find((event) => event.sequence === sequence)!
          .typeface.axes.find((axis) => axis.tag === "opsz")!.actual = 17;
      },
    },
    {
      name: "surface mask format",
      expected: "validation-control-surface-mask-format-1:surface",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const observation = artifact.controls.find(
          (control) => control.id === "surface-mask-format",
        )!.observation;
        selectedEvent<SfnsRawPayload>(observation, "raw")
          .surfaceProps.pixelGeometry = "rgb-h";
      },
    },
    {
      name: "full gamma table bytes",
      expected: "validation-zoom-2-cold-1:gamma-table:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const gamma = selectedEvent<SfnsGammaPayload>(
          artifact.scenarios[0].observations[0], "gamma",
        );
        const bytes = Buffer.from(gamma.tableBytesBase64, "base64");
        bytes[0] ^= 1;
        gamma.tableBytesBase64 = bytes.toString("base64");
      },
    },
    {
      name: "full preblend bytes",
      expected: "validation-zoom-2-cold-1:preblend-r:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const gamma = selectedEvent<SfnsGammaPayload>(
          artifact.scenarios[0].observations[0], "gamma",
        );
        const bytes = Buffer.from(gamma.preblendR256Base64, "base64");
        bytes[0] ^= 1;
        gamma.preblendR256Base64 = bytes.toString("base64");
      },
    },
    {
      name: "post-conversion mask bytes",
      expected: "validation-zoom-2-cold-1:mask:0:sha256",
      mutate: (artifact: SfnsPinnedChromiumValidationArtifact) => {
        const mask = firstMask(artifact.scenarios[0].observations[0]).glyph.mask;
        const bytes = Buffer.from(mask.bytes, "base64");
        bytes[0] ^= 1;
        mask.bytes = bytes.toString("base64");
      },
    },
  ])("rejects a resealed hostile $name mutation", ({ mutate, expected }) => {
    const artifact = evidence();
    mutate(artifact);
    reseal(artifact);
    expect(validateSfnsPinnedChromiumValidation(artifact)).toContain(expected);
  });

  it("requires every control to move its owned exact evidence groups", () => {
    const artifact = evidence();
    const baseline = structuredClone(
      artifact.scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0],
    );
    const control = artifact.controls.find((candidate) => candidate.id === "subpixel-phase")!;
    baseline.observationId = "validation-control-subpixel-phase-1";
    baseline.caseId = "control-subpixel-phase";
    baseline.kind = "control";
    baseline.lifecycle = "control";
    baseline.controlId = "subpixel-phase";
    baseline.ordinal = 1;
    for (const event of baseline.events) {
      event.observationId = baseline.observationId;
      event.lifecycle = baseline.lifecycle;
      event.controlId = baseline.controlId;
      event.ordinal = baseline.ordinal;
    }
    control.observation = baseline;
    reseal(artifact);
    expect(validateSfnsPinnedChromiumValidation(artifact)).toEqual(expect.arrayContaining([
      "subpixel-phase:inactive:phase",
      "subpixel-phase:inactive:mask",
    ]));
  });

  it("rejects a 26px cancellation claim and an unsealed artifact mutation", () => {
    const artifact = evidence();
    const cancellation = artifact.scenarios.find(
      (scenario) => scenario.id === "zoom-2-transform-half",
    )!;
    for (const observation of cancellation.observations) {
      const filtered = observation.events.find(
        (event) => event.sequence === observation.selection.filteredSequence,
      )!.payload as SfnsFilteredPayload;
      filtered.matrices.scale = [26, 26];
    }
    reseal(artifact);
    expect(validateSfnsPinnedChromiumValidation(artifact)).toEqual(expect.arrayContaining([
      "validation-zoom-2-transform-half-cold-1:matrix-factorization",
      "validation-zoom-2-transform-half-cold-2:matrix-factorization",
      "validation-zoom-2-transform-half-warm-1:matrix-factorization",
      "validation-zoom-2-transform-half-warm-2:matrix-factorization",
    ]));

    const geometry = evidence();
    const baseline = geometry.scenarios.find(
      (scenario) => scenario.id === "zoom-2",
    )!.observations[0];
    const run = baseline.events.find(
      (event) => event.sequence === baseline.selection.runSequence,
    )!;
    (run.payload as { glyphs: Array<{ deviceOrigin: number[] }> })
      .glyphs[1].deviceOrigin[0] += 0.000_000_000_001;
    reseal(geometry);
    expect(validateSfnsPinnedChromiumValidation(geometry)).toContain(
      "validation-zoom-2-cold-1:glyph:1:shaping-run-seam",
    );

    const unsealed = evidence();
    unsealed.corpus.glyphIds[0]++;
    expect(validateSfnsPinnedChromiumValidation(unsealed)).toEqual(expect.arrayContaining([
      "corpus",
      "artifact-digest",
    ]));
  });
});
