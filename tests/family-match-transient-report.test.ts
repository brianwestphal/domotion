import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readFamilyMatchTransientReport,
  writeFamilyMatchTransientReport,
} from "../tools/family-match-transient-report.js";

const macReport = { scored: 2, agree: 1, skipped: 0, misses: [{ family: "A", css: 700, chrome: "A", ours: "B" }] };
const linuxReport = {
  meta: {
    suite: "family-match" as const,
    os: "linux" as const,
    capturedAt: "2026-10-01T00:00:00.000Z",
    env: { platform: "linux", arch: "x64" },
    weights: [400, 700],
  },
  summary: { families: 1, cases: 2, scored: 2, agree: 1, rejectAgree: 0, skipped: 0, misses: 1 },
  misses: macReport.misses,
};

function tempFile(createParent = false): string {
  const dir = join(mkdtempSync(join(tmpdir(), "family-match-report-")), "nested");
  if (createParent) mkdirSync(dir);
  return join(dir, "report.json");
}

describe("family-match transient report", () => {
  it("writes nested envelopes and reads only the selected tool and platform", () => {
    const path = tempFile();
    writeFamilyMatchTransientReport(path, "family-match-conformance-linux", linuxReport, "fail", linuxReport.meta.env);
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      tool: "family-match-conformance-linux",
      env: linuxReport.meta.env,
      data: { ...linuxReport, outcome: "fail" },
    });
    expect(readFamilyMatchTransientReport(path, "family-match-conformance-linux")).toEqual(artifact.data);
    expect(() => readFamilyMatchTransientReport(path, "family-match-conformance-win32")).toThrow();
    artifact.schemaVersion = 2;
    writeFileSync(path, JSON.stringify(artifact));
    expect(() => readFamilyMatchTransientReport(path, "family-match-conformance-linux")).toThrow();
  });

  it("accepts only explicit flat legacy shapes and marks their verdict unknown", () => {
    const path = tempFile(true);
    writeFileSync(path, JSON.stringify(macReport));
    expect(readFamilyMatchTransientReport(path, "family-match-conformance")).toEqual({ ...macReport, outcome: "skip" });
    writeFileSync(path, JSON.stringify(linuxReport));
    expect(readFamilyMatchTransientReport(path, "family-match-conformance-linux")).toEqual({
      ...linuxReport,
      outcome: "skip",
    });
    writeFileSync(path, JSON.stringify({ ...linuxReport, schemaVersion: 99 }));
    expect(() => readFamilyMatchTransientReport(path, "family-match-conformance-linux")).toThrow();
    writeFileSync(path, JSON.stringify({ ...linuxReport, summary: {} }));
    expect(() => readFamilyMatchTransientReport(path, "family-match-conformance-linux")).toThrow();
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves the macOS CLI stdout and writes a nested report",
    () => {
      const path = tempFile();
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "tools/family-match-conformance.ts", "--json", "--json-path", path, "--allow", "100000"],
        { cwd: process.cwd(), encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      );
      expect(result.status, result.stderr.slice(-2_000)).toBe(0);
      const stdout = JSON.parse(result.stdout);
      const artifact = JSON.parse(readFileSync(path, "utf8"));
      expect(stdout).toMatchObject({
        scored: expect.any(Number),
        agree: expect.any(Number),
        misses: expect.any(Array),
      });
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        tool: "family-match-conformance",
        data: {
          scored: stdout.scored,
          agree: stdout.agree,
          skipped: stdout.skipped,
          misses: stdout.misses,
          outcome: "pass",
        },
      });
    },
    150_000,
  );
});
