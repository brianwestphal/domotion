import { describe, expect, it } from "vitest";
import { PINGFANG_DESCRIPTOR_ARMS, PINGFANG_DESCRIPTOR_CODEPOINTS, validatePingFangDescriptorArtifact } from "../tools/pingfang-live-descriptor-schema.mjs";

const processRecord = (iterations = 1) => ({ samples: Array.from({ length: iterations }, (_, iteration) => ({
  iteration, queryCodepoint: PINGFANG_DESCRIPTOR_CODEPOINTS[0], arms: PINGFANG_DESCRIPTOR_ARMS.map((arm) => ({
    arm, descriptor: {}, variationAxes: [], variation: {}, unitsPerEm: 1000, matrix: [1, 0, 0, 1, 0, 0], glyphs: [],
  })),
})) });
const valid = () => ({ schemaVersion: 1, environment: { os: "macOS", release: "25", arch: "arm64", swVers: "26", chromiumVersion: "147", sourceSha: "abc", fontInventoryDigest: "def" },
  codepoints: PINGFANG_DESCRIPTOR_CODEPOINTS, coldProcesses: [processRecord(), processRecord(), processRecord()], warmProcess: processRecord(3),
  browserRows: PINGFANG_DESCRIPTOR_CODEPOINTS.map((codepoint) => ({ codepoint, hex: "U+", rangeWidth: 32, platformFonts: [] })) });

describe("PingFang live descriptor artifact schema", () => {
  it("accepts the complete cold/warm/native/browser matrix", () => expect(validatePingFangDescriptorArtifact(valid())).toBeTruthy());
  it("rejects a missing descriptor arm", () => {
    const artifact = valid(); artifact.coldProcesses[0].samples[0].arms.pop();
    expect(() => validatePingFangDescriptorArtifact(artifact)).toThrow(/explicit-wght-400/);
  });
  it("rejects missing runner identity and browser evidence", () => {
    const artifact = valid(); artifact.environment.fontInventoryDigest = ""; artifact.browserRows = [];
    expect(() => validatePingFangDescriptorArtifact(artifact)).toThrow(/fontInventoryDigest[\s\S]*browser row count/);
  });
});
