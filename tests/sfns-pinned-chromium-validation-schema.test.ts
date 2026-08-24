import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sfnsValidationArtifactDigest,
  sfnsValidationChangedEvidenceGroups,
  sfnsValidationObservationDigest,
  validateSfnsPinnedChromiumValidation,
  type SfnsFilteredPayload,
  type SfnsMaskPayload,
  type SfnsPinnedChromiumValidationArtifact,
  type SfnsRawPayload,
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

describe("pinned-Chromium SFNS validation evidence", () => {
  it("retains 26 isolated explicitly-headless observations and authenticates scale cancellation", () => {
    expect(validateSfnsPinnedChromiumValidation(retained)).toEqual([]);
    expect(retained.collectionContract).toEqual({
      browserLaunches: 26,
      processIsolation: "one-explicitly-headless-browser-per-observation",
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
      "zoom-2-cold-1:duplicate-sequence",
    );

    const reordered = evidence();
    const reorderedObservation = reordered.scenarios[0].observations[0];
    [reorderedObservation.events[0], reorderedObservation.events[1]] =
      [reorderedObservation.events[1], reorderedObservation.events[0]];
    reseal(reordered);
    expect(validateSfnsPinnedChromiumValidation(reordered)).toContain(
      "zoom-2-cold-1:event-reordered",
    );

    const dropped = evidence();
    dropped.scenarios[0].observations[0].events.shift();
    reseal(dropped);
    expect(validateSfnsPinnedChromiumValidation(dropped)).toContain(
      "zoom-2-cold-1:event-dropped",
    );

    const stale = evidence();
    stale.scenarios[0].observations[0].events[0].observationId = "prior-process-evidence";
    reseal(stale);
    expect(validateSfnsPinnedChromiumValidation(stale)).toContain(
      "zoom-2-cold-1:stale-envelope",
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
      "zoom-2-cold-1:source-revision",
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
      "zoom-2-cold-1:not-explicitly-headless",
    );

    const corrupt = evidence();
    firstMask(corrupt.scenarios[0].observations[0]).glyph.mask.bytes = "AAAA";
    reseal(corrupt);
    expect(validateSfnsPinnedChromiumValidation(corrupt)).toEqual(expect.arrayContaining([
      "zoom-2-cold-1:mask:0:size",
      "zoom-2-cold-1:mask:0:sha256",
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
      "zoom-2-cold-1:rec-typeface-identity",
    );
  });

  it("requires every control to move its owned exact evidence groups", () => {
    const artifact = evidence();
    const baseline = structuredClone(
      artifact.scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0],
    );
    const control = artifact.controls.find((candidate) => candidate.id === "subpixel-phase")!;
    baseline.observationId = "control-subpixel-phase-1";
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
      "zoom-2-transform-half-cold-1:factored-scale",
      "zoom-2-transform-half-cold-2:factored-scale",
      "zoom-2-transform-half-warm-1:factored-scale",
      "zoom-2-transform-half-warm-2:factored-scale",
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
      "zoom-2-cold-1:device-origins",
    );

    const unsealed = evidence();
    unsealed.corpus.glyphIds[0]++;
    expect(validateSfnsPinnedChromiumValidation(unsealed)).toEqual(expect.arrayContaining([
      "corpus",
      "artifact-digest",
    ]));
  });
});
