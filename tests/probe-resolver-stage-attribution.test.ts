import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../tools/lib/report.js";
import { readAttributionReport } from "../tools/probe-resolver-stage-attribution.mjs";

const legacy = {
  meta: {
    platform: "darwin",
    arch: "arm64",
    chromium: "test",
    stackPrimaries: [{ fontFamily: "Times", fontSize: 16, fontWeight: 400, fontStyle: "normal" }],
  },
  summary: { mismatchTotal: 1, comparisons: 1 },
  mismatches: [{ cp: 65, ourKey: "times", stack: "Times" }],
};

describe("resolver stage attribution report reader", () => {
  it("accepts validated flat legacy and current font reports", () => {
    const path = join(mkdtempSync(join(tmpdir(), "domotion-stage-attribution-")), "report.json");
    writeFileSync(path, JSON.stringify(legacy));
    expect(readAttributionReport(path).mismatches).toEqual(legacy.mismatches);
    writeReport(path, "font-conformance", { ...legacy, outcome: "fail" }, { schemaVersion: 1 });
    expect(readAttributionReport(path).meta.stackPrimaries[0].fontFamily).toBe("Times");
  });

  it("rejects unknown versions and tools or malformed stage evidence", () => {
    const path = join(mkdtempSync(join(tmpdir(), "domotion-stage-attribution-")), "report.json");
    writeReport(path, "font-conformance", { ...legacy, outcome: "fail" }, { schemaVersion: 2 });
    expect(() => readAttributionReport(path)).toThrow();
    writeReport(path, "wrong-tool", { ...legacy, outcome: "fail" }, { schemaVersion: 1 });
    expect(() => readAttributionReport(path)).toThrow();
    writeFileSync(path, JSON.stringify({ ...legacy, mismatches: [{ cp: "bad", ourKey: "times", stack: "Times" }] }));
    expect(() => readAttributionReport(path)).toThrow();
    writeFileSync(path, JSON.stringify({ ...legacy, meta: { ...legacy.meta, stackPrimaries: [] } }));
    expect(() => readAttributionReport(path)).toThrow();
  });
});
