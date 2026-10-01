import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PINGFANG_DESCRIPTOR_ARMS,
  PINGFANG_DESCRIPTOR_CODEPOINTS,
  validatePingFangDescriptorArtifact,
} from "../tools/pingfang-live-descriptor-schema.mjs";
import {
  readPingFangDescriptorReport,
  writePingFangDescriptorReport,
} from "../tools/pingfang-live-descriptor-report.mjs";

const dir = mkdtempSync(join(tmpdir(), "pingfang-descriptor-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const processRecord = (iterations = 1) => ({
  samples: Array.from({ length: iterations }, (_, iteration) => ({
    iteration,
    queryCodepoint: PINGFANG_DESCRIPTOR_CODEPOINTS[0],
    arms: PINGFANG_DESCRIPTOR_ARMS.map((arm) => ({
      arm,
      descriptor: {},
      variationAxes: [],
      variation: {},
      unitsPerEm: 1000,
      matrix: [1, 0, 0, 1, 0, 0],
      glyphs: [],
    })),
  })),
});
const valid = () => ({
  schemaVersion: 1,
  environment: {
    os: "macOS",
    release: "25",
    arch: "arm64",
    swVers: "26",
    chromiumVersion: "147",
    sourceSha: "abc",
    fontInventoryDigest: "def",
  },
  codepoints: PINGFANG_DESCRIPTOR_CODEPOINTS,
  coldProcesses: [processRecord(), processRecord(), processRecord()],
  warmProcess: processRecord(3),
  browserRows: PINGFANG_DESCRIPTOR_CODEPOINTS.map((codepoint) => ({
    codepoint,
    hex: "U+",
    rangeWidth: 32,
    platformFonts: [],
  })),
});

describe("PingFang live descriptor artifact schema", () => {
  it("accepts the complete cold/warm/native/browser matrix", () =>
    expect(validatePingFangDescriptorArtifact(valid())).toBeTruthy());
  it("rejects a missing descriptor arm", () => {
    const artifact = valid();
    artifact.coldProcesses[0].samples[0].arms.pop();
    expect(() => validatePingFangDescriptorArtifact(artifact)).toThrow(/explicit-wght-400/);
  });
  it("rejects missing runner identity and browser evidence", () => {
    const artifact = valid();
    artifact.environment.fontInventoryDigest = "";
    artifact.browserRows = [];
    expect(() => validatePingFangDescriptorArtifact(artifact)).toThrow(/fontInventoryDigest[\s\S]*browser row count/);
  });

  it("writes a nested versioned report and reads its complete domain evidence", () => {
    const path = join(dir, "nested", "report.json");
    const envelope = writePingFangDescriptorReport(path, valid());
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.data.outcome).toBe("pass");
    expect(readPingFangDescriptorReport(path)).toEqual({ ...valid(), outcome: "pass" });
  });

  it("reads validated legacy evidence and rejects unknown versions", () => {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(valid()));
    expect(readPingFangDescriptorReport(path).outcome).toBe("pass");
    writeFileSync(path, JSON.stringify({ ...valid(), schemaVersion: 2 }));
    expect(() => readPingFangDescriptorReport(path)).toThrow("unsupported legacy");
    const envelope = writePingFangDescriptorReport(path, valid());
    writeFileSync(path, JSON.stringify({ ...envelope, schemaVersion: 2 }));
    expect(() => readPingFangDescriptorReport(path)).toThrow();
  });

  it("rejects a report whose retained domain evidence lost an arm", () => {
    const path = join(dir, "incomplete.json");
    const artifact = valid();
    artifact.coldProcesses[0].samples[0].arms.pop();
    expect(() => writePingFangDescriptorReport(path, artifact)).toThrow("explicit-wght-400");
  });
});
