import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { helperAvailabilityContract } from "@domotion/text-engine/testing";
import { readHelperAvailabilityReport, runHelperAvailabilityContract } from "../tools/helper-availability-contract.js";

const tool = "helper-availability-contract";
const present = helperAvailabilityContract({
  platform: "darwin",
  helperObserved: true,
  explicitlyDisabled: false,
  implementationIdentity: "test-helper-v1",
});
const absent = helperAvailabilityContract({
  platform: "darwin",
  helperObserved: false,
  explicitlyDisabled: true,
  implementationIdentity: "test-helper-v1",
});
const wrap = (data: Record<string, unknown>) => ({
  schemaVersion: 1,
  tool,
  generatedAt: new Date().toISOString(),
  env: { platform: "darwin" },
  data: { ...data, outcome: "pass" },
});

describe("helper availability report migration", () => {
  it("reads flat v1 and versioned envelopes while rejecting malformed authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "helper-contract-unit-"));
    try {
      const path = join(directory, "report.json");
      writeFileSync(path, JSON.stringify(present));
      expect(readHelperAvailabilityReport(path)).toEqual(present);
      writeFileSync(path, JSON.stringify(wrap(present)));
      expect(readHelperAvailabilityReport(path)).toEqual(present);
      for (const malformed of [
        { ...present, version: "native-helper-availability-v2" },
        { ...wrap(present), schemaVersion: 2 },
        { ...wrap(present), tool: "other" },
        { ...wrap(present), data: { ...present, outcome: "fail" } },
        { ...wrap(present), data: { ...present, logicalFacts: { capturedWebfontBytes: "lost" }, outcome: "pass" } },
      ]) {
        writeFileSync(path, JSON.stringify(malformed));
        expect(() => readHelperAvailabilityReport(path)).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compares mixed legacy and current files with unchanged stdout shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "helper-contract-compare-"));
    try {
      const presentPath = join(directory, "present.json");
      const absentPath = join(directory, "absent.json");
      writeFileSync(presentPath, JSON.stringify(wrap(present)));
      writeFileSync(absentPath, JSON.stringify(absent));
      const originalWrite = process.stdout.write;
      const chunks: string[] = [];
      process.stdout.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stdout.write;
      try {
        expect(runHelperAvailabilityContract(["--compare", `${presentPath},${absentPath}`])).toBe(0);
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(JSON.parse(chunks.join(""))).toEqual({ pass: true, platform: "darwin", present, absent });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the real CLI producer and compare reader with stable exits", () => {
    const directory = mkdtempSync(join(tmpdir(), "helper-contract-cli-"));
    try {
      const presentPath = join(directory, "present.json");
      const absentPath = join(directory, "absent.json");
      writeFileSync(presentPath, JSON.stringify(present));
      const base = ["--import", "tsx", "tools/helper-availability-contract.ts"];
      const produced = spawnSync(process.execPath, [...base, "--out", absentPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DOMOTION_DISABLE_HELPER: "1", DOMOTION_HELPER_PATH: process.execPath },
      });
      expect(produced.status).toBe(0);
      const expectedAbsent = helperAvailabilityContract({
        platform: process.platform as "darwin" | "linux" | "win32",
        helperObserved: false,
        explicitlyDisabled: true,
        implementationIdentity: "ignored",
      });
      expect(JSON.parse(produced.stdout)).toEqual(expectedAbsent);
      const stored = JSON.parse(readFileSync(absentPath, "utf8"));
      expect(stored).toMatchObject({ schemaVersion: 1, tool, data: { outcome: "pass", mode: "helper-absent" } });
      const platformPresent = helperAvailabilityContract({
        platform: process.platform as "darwin" | "linux" | "win32",
        helperObserved: true,
        explicitlyDisabled: false,
        implementationIdentity: "test-helper-v1",
      });
      writeFileSync(presentPath, JSON.stringify(platformPresent));
      const compared = spawnSync(process.execPath, [...base, "--compare", `${presentPath},${absentPath}`], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(compared.status).toBe(0);
      expect(JSON.parse(compared.stdout)).toEqual({
        pass: true,
        platform: process.platform,
        present: platformPresent,
        absent: expectedAbsent,
      });
      writeFileSync(absentPath, JSON.stringify({ ...stored, schemaVersion: 2 }));
      const invalid = spawnSync(process.execPath, [...base, "--compare", `${presentPath},${absentPath}`], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(invalid.status).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
