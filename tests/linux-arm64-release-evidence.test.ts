import { describe, expect, it } from "vitest";

import {
  buildFinalReport,
  parseElfIdentity,
  REQUIRED_OUTCOMES,
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
};

describe("DM-2353 Linux arm64 release evidence", () => {
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
});
