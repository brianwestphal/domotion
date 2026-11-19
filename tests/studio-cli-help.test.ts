import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budgetForCpuWork,
  describeChild,
  runBoundedChild,
  testTimeoutFor,
  type BoundedChildResult,
} from "./bounded-child.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A `node --import tsx` start of the CLI that prints help used 0.80-1.17 s of
// CPU, idle and loaded (docs/tool-child-process-test-bounds.md).
const HELP_BUDGET_MS = budgetForCpuWork(1_200);

function run(entry: string, args: string[]): Promise<BoundedChildResult> {
  return runBoundedChild(process.execPath, ["--import", "tsx", resolve(ROOT, entry), ...args], {
    budgetMs: HELP_BUDGET_MS,
    cwd: ROOT,
    env: { ...process.env, DOMOTION_NO_OPEN: "1" },
  });
}

function expectStudioHelp(result: BoundedChildResult): void {
  expect(result.status, describeChild(result)).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("domotion-studio — local visual workspace");
  expect(result.stdout).toContain("domotion studio [project.json] [options]");
  expect(result.stdout).toContain("--workspace <dir>");
  expect(result.stdout).toContain("--port <n>");
  expect(result.stdout).toContain("--no-open");
  expect(result.stdout).not.toContain("capture options:");
}

describe("Studio CLI help routing", () => {
  it(
    "lists all Studio launch options in the umbrella help",
    async () => {
      const result = await run("src/cli/index.ts", ["--help"]);
      expect(result.status, describeChild(result)).toBe(0);
      expect(result.stdout).toContain("domotion studio [project.json] [--workspace <dir>] [--port <n>] [--no-open]");
    },
    testTimeoutFor(HELP_BUDGET_MS),
  );

  it(
    "routes umbrella-command help to the Studio command",
    async () => {
      expectStudioHelp(await run("src/cli/index.ts", ["studio", "--help"]));
    },
    testTimeoutFor(HELP_BUDGET_MS),
  );

  it(
    "prints the same command help from the standalone entrypoint",
    async () => {
      const umbrella = await run("src/cli/index.ts", ["studio", "--help"]);
      const standalone = await run("src/cli/studio.ts", ["--help"]);
      expectStudioHelp(standalone);
      expect(standalone.stdout).toBe(umbrella.stdout);
    },
    testTimeoutFor(HELP_BUDGET_MS, HELP_BUDGET_MS),
  );
});
