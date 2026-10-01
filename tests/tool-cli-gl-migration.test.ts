import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const cwd = resolve(import.meta.dirname, "..");
const run = (file: string, args: string[] = []) =>
  spawnSync(process.execPath, ["--import", "tsx", resolve(cwd, "tools", file), ...args], {
    cwd,
    encoding: "utf8",
  });

it("keeps the glyph tools inert when imported", () => {
  for (const file of ["glyph-compare-calibrate.ts", "glyph-sheet-audit.ts", "layout-stage-oracle.ts"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL(`../tools/${file}`, import.meta.url).href)})`,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(result.status, `${file}: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("");
  }
});

it("rejects unknown glyph flags before starting the browser", () => {
  for (const file of ["glyph-compare-calibrate.ts", "glyph-sheet-audit.ts"]) {
    const result = run(file, ["--bogus"]);
    expect(result.status, `${file}: ${result.stderr}`).toBe(2);
    expect(result.stderr).toContain("--bogus");
  }
});

it("prints the Linux Unicode fixture list without matrix inputs", () => {
  const result = run("linux-unicode-mutation-matrix.ts", ["--print-fixtures"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(",");
  expect(result.stderr).toBe("");
});

it("requires the declared Linux Unicode matrix inputs", () => {
  const result = run("linux-unicode-mutation-matrix.ts", ["--bogus"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--bogus");
});
