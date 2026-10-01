import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { main as paintGeometryMain } from "../tools/paint-geometry-oracle.js";
import { outcomeSchema, readReport, reportEnvelopeSchema } from "../tools/lib/report.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("writes a versioned paint geometry report into a nested --json destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-oracle-report-"));
  dirs.push(dir);
  const path = join(dir, "new", "subdir", "report.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const exitCode = paintGeometryMain(["--json", path]);
  const schema = reportEnvelopeSchema(
    z.object({ outcome: outcomeSchema, rows: z.array(z.object({ pass: z.boolean() })), movementProven: z.boolean() }),
    { tool: "paint-geometry-oracle", schemaVersion: 1 },
  );
  const report = readReport(path, schema);
  expect(report.data.outcome).toBe(exitCode === 0 ? "pass" : "fail");
  expect(report.data.rows.length).toBeGreaterThan(0);
});
