import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// DM-GTSWNF: tests/ was outside every typecheck project. Vitest and tsx strip
// types without checking them, so 167 errors had accumulated: fixtures that
// drifted from the capture schema, a sharp option that does not exist (the
// "16-bit" PNG was 8-bit), and a uniqueness assertion over a field that the
// captured tree has never had.
describe("DM-GTSWNF: tests typecheck project", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const parsed = ts.readConfigFile("tsconfig.tests.json", ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, resolve("."));

  function testSources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "output" || entry.name === "cache" ? [] : testSources(path);
      return /\.tsx?$/.test(entry.name) ? [resolve(path)] : [];
    });
  }

  it("is part of npm run typecheck, which CI runs", () => {
    expect(parsed.error).toBeUndefined();
    expect(pkg.scripts.typecheck).toContain("-p tsconfig.tests.json");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain("run: npm run typecheck");
  });

  it("checks every TypeScript file under tests/ with the strict root options", () => {
    expect(config.errors).toEqual([]);
    expect(config.options.strict).toBe(true);
    expect(config.options.noUnusedLocals).toBe(true);
    // Plain-JS helpers are typed from their source and JSDoc rather than
    // imported as an implicit `any`; they are not themselves checked.
    expect(config.options.allowJs).toBe(true);
    expect(config.options.checkJs).toBe(false);
    const checked = new Set(config.fileNames.map((path) => resolve(path)));
    const missing = testSources("tests").filter((path) => !checked.has(path));
    expect(missing).toEqual([]);
  });

  it("does not opt test files out of checking", () => {
    const optedOut = testSources("tests").filter((path) => /@ts-(nocheck|ignore)\b/.test(readFileSync(path, "utf8")));
    expect(optedOut).toEqual([]);
  });
});
