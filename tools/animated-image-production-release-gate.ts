#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AnimatedImageFrameSelectionReport } from "./animated-image-frame-selection-audit.js";

export interface AnimatedImageProductionReleaseReport {
  schemaVersion: 1;
  requiredPlatforms: ["macOS", "Linux", "Windows"];
  artifacts: Array<{ platform: "macOS" | "Linux" | "Windows"; decoderSha256: string; runEnvironmentSha256: string;
    productionTestsSha256: string; testsPassed: number }>;
  failures: string[];
  verdict: "macos-linux-windows-production-exact" | "blocked";
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const readJson = async <T>(path: string): Promise<{ value: T; bytes: Uint8Array }> => {
  const bytes = await readFile(path); return { value: JSON.parse(bytes.toString()) as T, bytes };
};

export async function adjudicateAnimatedImageProductionRelease(root: string): Promise<AnimatedImageProductionReleaseReport> {
  const failures: string[] = []; const artifacts: AnimatedImageProductionReleaseReport["artifacts"] = [];
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const platform of ["macOS", "Linux", "Windows"] as const) {
    const token = platform;
    const directory = directories.find((entry) => entry.isDirectory() && entry.name.includes(token))?.name;
    if (directory == null) { failures.push(`${platform}: native artifact missing`); continue; }
    try {
      const base = join(root, directory);
      const decoder = await readJson<AnimatedImageFrameSelectionReport>(join(base, "decoder.json"));
      const tests = await readJson<{ numPassedTests?: number; numFailedTests?: number; success?: boolean }>(join(base, "production-tests.json"));
      const environment = await readJson<Record<string, unknown>>(join(base, "run-env.json"));
      if (decoder.value.verdict !== "decoder-frame-exact" || decoder.value.errors.length !== 0 || !decoder.value.browser.headless) {
        failures.push(`${platform}: decoder evidence is not exact and explicitly headless`);
      }
      const reportedPlatform = decoder.value.browser.platform.toLowerCase();
      const expectedPlatform = platform === "macOS" ? "mac" : platform === "Windows" ? "win32" : "linux";
      if (!reportedPlatform.includes(expectedPlatform)) {
        failures.push(`${platform}: decoder platform identity drift`);
      }
      if (tests.value.success !== true || (tests.value.numFailedTests ?? 1) !== 0 || (tests.value.numPassedTests ?? 0) < 18) {
        failures.push(`${platform}: focused production matrix did not pass completely`);
      }
      if (Object.keys(environment.value).length === 0) failures.push(`${platform}: runner environment is empty`);
      artifacts.push({ platform, decoderSha256: sha256(decoder.bytes), runEnvironmentSha256: sha256(environment.bytes),
        productionTestsSha256: sha256(tests.bytes), testsPassed: tests.value.numPassedTests ?? 0 });
    } catch (error) { failures.push(`${platform}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { schemaVersion: 1, requiredPlatforms: ["macOS", "Linux", "Windows"], artifacts,
    failures, verdict: failures.length === 0 && artifacts.length === 3 ? "macos-linux-windows-production-exact" : "blocked" };
}

export async function mainAnimatedImageProductionReleaseGate(argv = process.argv): Promise<void> {
  const reportsIndex = argv.indexOf("--reports"); const jsonIndex = argv.indexOf("--json");
  const root = resolve(reportsIndex >= 0 && argv[reportsIndex + 1] != null ? argv[reportsIndex + 1] : "tests/output/animated-image-release");
  const report = await adjudicateAnimatedImageProductionRelease(root);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonIndex >= 0 && argv[jsonIndex + 1] != null) {
    const output = resolve(argv[jsonIndex + 1]); await mkdir(dirname(output), { recursive: true }); await writeFile(output, json);
  } else process.stdout.write(json);
  if (report.verdict !== "macos-linux-windows-production-exact") process.exitCode = 1;
}
