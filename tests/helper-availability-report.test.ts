import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { helperAvailabilityContract } from "@domotion/text-engine/testing";
import {
  helperPath,
  readHelperAvailabilityReport,
  runHelperAvailabilityContract,
} from "../tools/helper-availability-contract.js";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

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
/** A `node --import tsx` start of this CLI measured at most 0.49 s of CPU, idle or loaded. */
const CLI_BUDGET_MS = budgetForCpuWork(500);
const wrap = <T extends object>(data: T) => ({
  schemaVersion: 1,
  tool,
  generatedAt: new Date().toISOString(),
  env: { platform: "darwin" },
  data: { ...data, outcome: "pass" },
});

describe("helper availability report migration", () => {
  it("uses the text-engine native build path for every supported platform by default", () => {
    const override = process.env.DOMOTION_HELPER_PATH;
    try {
      delete process.env.DOMOTION_HELPER_PATH;
      for (const [platform, directory, binary] of [
        ["darwin", "macos-glyph-extractor", "domotion-glyph-paths"],
        ["linux", "linux-glyph-extractor", "domotion-glyph-paths"],
        ["win32", "win32-glyph-extractor", "domotion-glyph-paths.exe"],
      ] as const) {
        expect(helperPath(platform)).toBe(resolve("packages", "text-engine", "tools", directory, binary));
      }
      process.env.DOMOTION_HELPER_PATH = process.execPath;
      expect(helperPath("darwin")).toBe(resolve(process.execPath));
    } finally {
      if (override === undefined) delete process.env.DOMOTION_HELPER_PATH;
      else process.env.DOMOTION_HELPER_PATH = override;
    }
  });

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

  it(
    "runs the real CLI producer and compare reader with stable exits",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "helper-contract-cli-"));
      try {
        const presentPath = join(directory, "present.json");
        const absentPath = join(directory, "absent.json");
        writeFileSync(presentPath, JSON.stringify(present));
        const base = ["--import", "tsx", "tools/helper-availability-contract.ts"];
        const produced = await runBoundedChild(process.execPath, [...base, "--out", absentPath], {
          cwd: process.cwd(),
          env: { ...process.env, DOMOTION_DISABLE_HELPER: "1", DOMOTION_HELPER_PATH: process.execPath },
          budgetMs: CLI_BUDGET_MS,
        });
        expect(produced.error, describeChild(produced)).toBeNull();
        expect(produced.status, describeChild(produced)).toBe(0);
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
        const compared = await runBoundedChild(
          process.execPath,
          [...base, "--compare", `${presentPath},${absentPath}`],
          {
            cwd: process.cwd(),
            budgetMs: CLI_BUDGET_MS,
          },
        );
        expect(compared.error, describeChild(compared)).toBeNull();
        expect(compared.status, describeChild(compared)).toBe(0);
        expect(JSON.parse(compared.stdout)).toEqual({
          pass: true,
          platform: process.platform,
          present: platformPresent,
          absent: expectedAbsent,
        });
        writeFileSync(absentPath, JSON.stringify({ ...stored, schemaVersion: 2 }));
        const invalid = await runBoundedChild(
          process.execPath,
          [...base, "--compare", `${presentPath},${absentPath}`],
          {
            cwd: process.cwd(),
            budgetMs: CLI_BUDGET_MS,
          },
        );
        expect(invalid.error, describeChild(invalid)).toBeNull();
        expect(invalid.status, describeChild(invalid)).toBe(2);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    testTimeoutFor(CLI_BUDGET_MS, CLI_BUDGET_MS, CLI_BUDGET_MS),
  );
});
