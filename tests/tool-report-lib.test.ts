import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { readReport, writeReport } from "../tools/lib/report.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("writes a versioned report into a missing directory and validates it on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-report-"));
  dirs.push(dir);
  const path = join(dir, "nested", "report.json");
  writeReport(path, "fixture", { outcome: "pass" }, { schemaVersion: 2, generatedAt: "2026-01-01T00:00:00Z" });
  const schema = z.object({
    schemaVersion: z.literal(2),
    tool: z.literal("fixture"),
    generatedAt: z.string(),
    env: z.record(z.string(), z.unknown()),
    data: z.object({ outcome: z.literal("pass") }),
  });
  expect(readReport(path, schema).data.outcome).toBe("pass");
  expect(() => readReport(path, schema.extend({ schemaVersion: z.literal(3) }))).toThrow();
});
