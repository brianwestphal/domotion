import { resolve } from "node:path";
import { expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

const cwd = resolve(import.meta.dirname, "..");
// `node --import tsx` starts of these tools (an import, or an argument
// rejection) used 0.12-0.89 s of CPU, idle and loaded
// (docs/tool-child-process-test-bounds.md).
const TOOL_BUDGET_MS = budgetForCpuWork(900);
const run = (file: string, args: string[] = []) =>
  runBoundedChild(process.execPath, ["--import", "tsx", resolve(cwd, "tools", file), ...args], {
    budgetMs: TOOL_BUDGET_MS,
    cwd,
  });

const IMPORTED_TOOLS = ["glyph-compare-calibrate.ts", "glyph-sheet-audit.ts", "layout-stage-oracle.ts"];
const FLAG_TOOLS = ["glyph-compare-calibrate.ts", "glyph-sheet-audit.ts"];

it(
  "keeps the glyph tools inert when imported",
  async () => {
    for (const file of IMPORTED_TOOLS) {
      const result = await runBoundedChild(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(new URL(`../tools/${file}`, import.meta.url).href)})`,
        ],
        { budgetMs: TOOL_BUDGET_MS, cwd },
      );
      expect(result.status, `${file}: ${describeChild(result)}`).toBe(0);
      expect(result.stdout).toBe("");
    }
  },
  testTimeoutFor(...IMPORTED_TOOLS.map(() => TOOL_BUDGET_MS)),
);

it(
  "rejects unknown glyph flags before starting the browser",
  async () => {
    for (const file of FLAG_TOOLS) {
      const result = await run(file, ["--bogus"]);
      expect(result.status, `${file}: ${describeChild(result)}`).toBe(2);
      expect(result.stderr).toContain("--bogus");
    }
  },
  testTimeoutFor(...FLAG_TOOLS.map(() => TOOL_BUDGET_MS)),
);

it(
  "prints the Linux Unicode fixture list without matrix inputs",
  async () => {
    const result = await run("linux-unicode-mutation-matrix.ts", ["--print-fixtures"]);
    expect(result.status, describeChild(result)).toBe(0);
    expect(result.stdout).toContain(",");
    expect(result.stderr).toBe("");
  },
  testTimeoutFor(TOOL_BUDGET_MS),
);

it(
  "requires the declared Linux Unicode matrix inputs",
  async () => {
    const result = await run("linux-unicode-mutation-matrix.ts", ["--bogus"]);
    expect(result.status, describeChild(result)).toBe(2);
    expect(result.stderr).toContain("--bogus");
  },
  testTimeoutFor(TOOL_BUDGET_MS),
);
