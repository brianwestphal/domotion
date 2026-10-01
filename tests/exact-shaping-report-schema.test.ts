import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExactShapingReport } from "../tools/exact-shaping-report-schema.js";
import { writeReport } from "../tools/lib/report.js";

const legacy = {
  schemaVersion: 3,
  stage: "shaping",
  verdict: "exact-logical-agreement",
  completeEnvironment: true,
  movementProven: true,
  pairs: 0,
  controlHits: { face: 1 },
  records: [],
};

describe("exact shaping report reader", () => {
  it("accepts flat v3 reports and versioned envelopes", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-exact-report-"));
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(legacy));
    expect(readExactShapingReport(path)).toMatchObject({ outcome: "pass", pairs: 0 });

    const { schemaVersion: _version, ...data } = legacy;
    writeReport(path, "exact-shaping-oracle", { ...data, outcome: "pass" }, { schemaVersion: 1 });
    expect(readExactShapingReport(path)).toMatchObject({ outcome: "pass", pairs: 0 });
  });

  it("rejects future legacy or envelope versions, wrong tools, and malformed records", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-exact-report-"));
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify({ ...legacy, schemaVersion: 4 }));
    expect(() => readExactShapingReport(path)).toThrow();

    const { schemaVersion: _version, ...data } = legacy;
    writeReport(path, "exact-shaping-oracle", { ...data, outcome: "pass" }, { schemaVersion: 2 });
    expect(() => readExactShapingReport(path)).toThrow();
    writeReport(path, "other-oracle", { ...data, outcome: "pass" }, { schemaVersion: 1 });
    expect(() => readExactShapingReport(path)).toThrow();
    writeReport(path, "exact-shaping-oracle", { ...data, records: [{}], outcome: "pass" }, { schemaVersion: 1 });
    expect(() => readExactShapingReport(path)).toThrow();
  });
});
