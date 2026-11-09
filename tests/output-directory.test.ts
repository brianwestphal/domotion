import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveVisualOutputRoot, resolveReviewOutputRoot } from "./output-directory.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(testsDir, "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const temporary = mkdtempSync(join(tmpdir(), "domotion-output-root-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe("visual output root", () => {
  it("keeps the script-anchored default for absent and empty overrides", () => {
    expect(resolveVisualOutputRoot({})).toBe(join(testsDir, "output"));
    expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: "" })).toBe(join(testsDir, "output"));
  });

  it.each(["tests/output-linux", "tests/output-windows", "relative root with spaces"])(
    "resolves relative override %s against the invocation cwd",
    (override) => expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: override })).toBe(resolve(override)),
  );

  it("retains an absolute alternate root", () => {
    expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: temporary })).toBe(temporary);
  });

  it("lets the explicit review root win and otherwise follows the suite root", () => {
    const suite = join(temporary, "suite");
    const review = join(temporary, "review");
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite, REVIEW_OUTPUT_DIR: review })).toBe(review);
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite, REVIEW_OUTPUT_DIR: "" })).toBe(suite);
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite })).toBe(suite);
    expect(resolveReviewOutputRoot({})).toBe(join(testsDir, "output"));
  });

  it("the real-world CLI creates the selected suite directory from another cwd", () => {
    const output = join(temporary, "alternate");
    const canonicalManifest = join(testsDir, "output/real-world/results.json");
    const before = existsSync(canonicalManifest) ? readFileSync(canonicalManifest) : undefined;
    const stdout = execFileSync(
      process.execPath,
      ["--import", tsxLoader, join(testsDir, "real-world.tsx"), "--only", "__no_matching_fixture__"],
      {
        cwd: temporary,
        env: { ...process.env, DOMOTION_OUTPUT_DIR: output },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(stdout).toContain("No jobs matched");
    expect(existsSync(join(output, "real-world"))).toBe(true);
    expect(existsSync(join(output, "results.json"))).toBe(false);
    expect(existsSync(canonicalManifest) ? readFileSync(canonicalManifest) : undefined).toEqual(before);
  }, 25000);

  it("the comparison CLI reads the suite override while explicit paths retain precedence", () => {
    const output = join(temporary, "compare");
    mkdirSync(join(output, "real-world"), { recursive: true });
    const baseline = join(temporary, "baseline.json");
    const explicit = join(temporary, "explicit.json");
    const manifest = (name: string) =>
      JSON.stringify({ results: [{ name, coveragePct: 0, regionCount: 0, verdict: "clean" }] });
    writeFileSync(baseline, JSON.stringify({ results: [] }));
    writeFileSync(join(output, "real-world/results.json"), manifest("suite-root-result"));
    writeFileSync(explicit, manifest("explicit-path-result"));
    const run = (paths: string[]) =>
      execFileSync(process.execPath, [join(repo, "tools/compare-real-world-results.mjs"), ...paths], {
        cwd: temporary,
        env: { ...process.env, DOMOTION_OUTPUT_DIR: output },
        encoding: "utf8",
        timeout: 10000,
      });
    expect(run([baseline])).toContain("suite-root-result");
    const stdout = run([baseline, explicit]);
    expect(stdout).toContain("explicit-path-result");
    expect(stdout).not.toContain("suite-root-result");
  });
});
