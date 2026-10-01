import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { outcomeSchema, readReport, readReportData, reportEnvelopeSchema, writeReport } from "../tools/lib/report.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("accepts an explicitly validated legacy report but rejects unknown envelopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-report-"));
  dirs.push(dir);
  const path = join(dir, "report.json");
  const dataSchema = z.object({ outcome: outcomeSchema });
  const options = { tool: "fixture", schemaVersion: 1, legacySchema: dataSchema };
  writeFileSync(path, JSON.stringify({ outcome: "skip" }));
  expect(readReportData(path, dataSchema, options).outcome).toBe("skip");
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, outcome: "skip" }));
  expect(() => readReportData(path, dataSchema, options)).toThrow();
  writeFileSync(path, JSON.stringify({ outcome: "unavailable" }));
  expect(() => readReportData(path, dataSchema, options)).toThrow();
  const nestedDataSchema = z.object({ data: z.object({ outcome: outcomeSchema }) });
  writeFileSync(path, JSON.stringify({ data: { outcome: "pass" } }));
  expect(
    readReportData(path, nestedDataSchema, {
      tool: "fixture",
      schemaVersion: 1,
      legacySchema: nestedDataSchema,
    }).data.outcome,
  ).toBe("pass");
});

it("accepts a declared flat legacy version without confusing it for an envelope", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-report-"));
  dirs.push(dir);
  const path = join(dir, "report.json");
  const dataSchema = z.object({ schemaVersion: z.literal(3), outcome: outcomeSchema });
  const options = { tool: "fixture", schemaVersion: 1, legacySchema: dataSchema, legacySchemaVersion: 3 };
  writeFileSync(path, JSON.stringify({ schemaVersion: 3, outcome: "skip" }));
  expect(readReportData(path, dataSchema, options).outcome).toBe("skip");
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, outcome: "skip" }));
  expect(() => readReportData(path, dataSchema, options)).toThrow();
  writeFileSync(path, JSON.stringify({ schemaVersion: 3, data: { schemaVersion: 3, outcome: "skip" } }));
  expect(() => readReportData(path, dataSchema, options)).toThrow();
});

it("writes a versioned report into a missing directory and validates it on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-report-"));
  dirs.push(dir);
  const path = join(dir, "nested", "report.json");
  writeReport(path, "fixture", { outcome: "pass" }, { schemaVersion: 2, generatedAt: "2026-01-01T00:00:00Z" });
  const schema = reportEnvelopeSchema(z.object({ outcome: outcomeSchema }), { tool: "fixture", schemaVersion: 2 });
  expect(readReport(path, schema).data.outcome).toBe("pass");
  expect(() => readReport(path, reportEnvelopeSchema(z.unknown(), { tool: "fixture", schemaVersion: 3 }))).toThrow();
  expect(() => readReport(path, reportEnvelopeSchema(z.unknown(), { tool: "other", schemaVersion: 2 }))).toThrow();
  writeFileSync(path, JSON.stringify({ outcome: "pass" }));
  expect(() => readReport(path, schema)).toThrow();
  writeReport(path, "fixture", { outcome: "passed" }, { schemaVersion: 2 });
  expect(() => readReport(path, schema)).toThrow();
});
