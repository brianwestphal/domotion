import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { flag, intFlag, isMain, parseCommand, parseFlags, requiredFlag, runMain, shardFlag } from "../tools/lib/cli.js";

const options = { output: { type: "string" }, strict: { type: "boolean" } } as const;

describe("tool CLI flags", () => {
  it("reads declared flags in both value forms", () => {
    const values = parseFlags(["--output=report.json", "--strict"], options);
    expect(requiredFlag(values, "--output")).toBe("report.json");
    expect(flag(values, "strict", false)).toBe(true);
    expect(flag(values, "missing", "fallback")).toBe("fallback");
  });

  it("rejects unknown flags, missing values, and positionals", () => {
    expect(() => parseFlags(["--unknown"], options)).toThrow();
    expect(() => parseFlags(["--output"], options)).toThrow();
    expect(() => parseFlags(["file.json"], options)).toThrow();
    expect(() => requiredFlag(parseFlags([], options), "--output")).toThrow();
  });

  it("accepts positional operands while still rejecting unknown or incomplete flags", () => {
    expect(parseCommand(["input.json", "--output=report.json"], options)).toEqual({
      values: { output: "report.json" },
      positionals: ["input.json"],
    });
    expect(() => parseCommand(["input.json", "--unknown"], options)).toThrow();
    expect(() => parseCommand(["input.json", "--output"], options)).toThrow();
  });

  it("validates integers and shard boundaries", () => {
    expect(intFlag({ workers: "4" }, "workers")).toBe(4);
    expect(() => intFlag({ workers: "4x" }, "workers")).toThrow();
    expect(shardFlag({ shard: "2/3" }, "shard")).toEqual({ index: 2, total: 3 });
    expect(() => shardFlag({ shard: "4/3" }, "shard")).toThrow();
  });

  it("recognizes a relative main script path", () => {
    expect(isMain(pathToFileURL(resolve("tools/example.ts")).href, ["node", "tools/example.ts"])).toBe(true);
    expect(isMain("file:///another/script.ts", ["node", "tools/example.ts"])).toBe(false);
  });

  it("preserves a gate's mismatch exit code when main returns void", async () => {
    const prior = process.exitCode;
    try {
      process.exitCode = 1;
      await runMain(async () => undefined);
      expect(process.exitCode).toBe(1);
      await runMain(async () => 0);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prior;
    }
  });

  it("stops a migrated visual script before work on an unknown option", () => {
    const result = spawnSync(process.execPath, ["scripts/write-baseline.mjs", "--typo"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown option '--typo'");
  });
});
