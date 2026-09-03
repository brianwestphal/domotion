import { describe, expect, it } from "vitest";

import {
  buildFinalReport,
  decorationEvidenceErrors,
  parseElfIdentity,
  pinnedGlyphProtocolForRelease,
  REQUIRED_OUTCOMES,
  sourceFingerprintErrors,
  stableFingerprint,
} from "../tools/linux-arm64-release-evidence.js";

function elf(machine: number, elfClass = 2, endian = 1): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, endian]);
  if (endian === 2) bytes.writeUInt16BE(machine, 18);
  else bytes.writeUInt16LE(machine, 18);
  return bytes;
}

const requiredArtifacts = [
  "acquisition.json",
  "run-env.json",
  "logs/helper.log",
  "logs/icu.log",
  "font-selection/report.json",
  "shaping.json",
  "decoration.json",
  "paint-geometry.json",
  "paint-browser.json",
  "html/results.json",
  "unicode/results.json",
].map((path) => ({ path, size: 1, sha256: "a".repeat(64) }));

const successfulOutcomes = Object.fromEntries(REQUIRED_OUTCOMES.map((name) => [name, "success"]));
const exactAcquisition = {
  target: { platform: "linux", architecture: "arm64" },
  verdict: "acquisition-exact" as const,
  environmentFingerprint: "b".repeat(64),
  environment: {
    source: {
      checkoutSha: "1".repeat(40),
      chromiumRevision: "2".repeat(40),
      harfbuzzRevision: "3".repeat(40),
      skiaRevision: "4".repeat(40),
      icuSourceRevision: "5".repeat(40),
    },
  },
};

describe("DM-2353 Linux arm64 release evidence", () => {
  it("pins the helper protocol to the ratified release instead of the checkout", () => {
    expect(pinnedGlyphProtocolForRelease("0.24.0")).toBe("domotion-glyph-paths (linux/freetype) 0.3.0");
    expect(pinnedGlyphProtocolForRelease("0.26.3")).toBeNull();
  });

  it("accepts only the native little-endian ELF64 AArch64 identity", () => {
    expect(parseElfIdentity(elf(183))).toMatchObject({
      valid: true,
      class: "ELF64",
      endian: "little",
      machine: 183,
      architecture: "arm64",
    });
    expect(parseElfIdentity(elf(62)).architecture).toBe("x64");
    expect(parseElfIdentity(elf(183, 1)).class).toBe("ELF32");
    expect(parseElfIdentity(Buffer.from("not an elf"))).toMatchObject({ valid: false, architecture: "unknown" });
  });

  it("fingerprints semantic content independently of object insertion order", () => {
    const left = { platform: "linux", nested: { arch: "arm64", fonts: ["A", "B"] } };
    const same = { nested: { fonts: ["A", "B"], arch: "arm64" }, platform: "linux" };
    const moved = { nested: { fonts: ["A", "C"], arch: "arm64" }, platform: "linux" };
    expect(stableFingerprint(left)).toBe(stableFingerprint(same));
    expect(stableFingerprint(left)).not.toBe(stableFingerprint(moved));
  });

  it("fails closed when any governing source revision is absent or abbreviated", () => {
    expect(sourceFingerprintErrors(exactAcquisition.environment)).toEqual([]);
    expect(sourceFingerprintErrors({
      source: {
        ...exactAcquisition.environment.source,
        chromiumRevision: null,
        skiaRevision: "62efacd",
      },
    }).join("\n")).toMatch(/chromiumRevision[\s\S]*skiaRevision/);
  });

  it("requires the complete coherent-DPR decoration matrix without widening its envelope", () => {
    const exact = {
      platform: "linux",
      architecture: "arm64",
      coordinateOwnership: {
        source: "blink-physical-text-fragment-same-dpr-v1",
        chromePaintDeviceScaleFactor: 4,
        domotionCaptureDeviceScaleFactor: 4,
      },
      tolerances: { svgGeometry: 0.3 },
      gates: { transcription: true, skipInk: true, svgGeometry: true },
      results: Array.from({ length: 109 }, (_, index) => ({
        transcription: { ok: true },
        svgGeometry: { ok: true },
        skipInk: index < 30 ? { ok: true } : null,
      })),
    };
    expect(decorationEvidenceErrors(exact)).toEqual([]);
    expect(decorationEvidenceErrors({
      ...exact,
      coordinateOwnership: { ...exact.coordinateOwnership, domotionCaptureDeviceScaleFactor: 1 },
      tolerances: { svgGeometry: 1.3 },
    }).join("\n")).toMatch(/required DPR 4[\s\S]*0\.3 CSS px/);
  });

  it("emits an exact verdict only for the complete arm64 outcome and artifact set", () => {
    const report = buildFinalReport(exactAcquisition, successfulOutcomes, requiredArtifacts);
    expect(report.verdict).toBe("exact-arm64-release-parity");
    expect(report.errors).toEqual([]);
    expect(report.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on a wrong architecture, missing gate, or missing evidence", () => {
    const report = buildFinalReport(
      { ...exactAcquisition, target: { platform: "linux", architecture: "x64" } },
      { ...successfulOutcomes, shaping: "failure" },
      requiredArtifacts.filter((artifact) => artifact.path !== "unicode/results.json"),
    );
    expect(report.verdict).toBe("arm64-release-parity-drift");
    expect(report.errors.join("\n")).toMatch(/not linux\/arm64/);
    expect(report.errors.join("\n")).toMatch(/shaping outcome is failure/);
    expect(report.errors.join("\n")).toMatch(/unicode\/results\.json/);
  });

  it("does not accept an exact acquisition label with an incomplete source fingerprint", () => {
    const report = buildFinalReport(
      { ...exactAcquisition, environment: { source: { checkoutSha: "1".repeat(40) } } },
      successfulOutcomes,
      requiredArtifacts,
    );
    expect(report.verdict).toBe("arm64-release-parity-drift");
    expect(report.errors.join("\n")).toMatch(/chromiumRevision/);
    expect(report.errors.join("\n")).toMatch(/icuSourceRevision/);
  });
});
