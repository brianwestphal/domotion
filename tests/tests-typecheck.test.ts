import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

  function testSources(dir: string, root = dir): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return dir === root && (entry.name.startsWith("output") || entry.name === "cache")
          ? []
          : testSources(path, root);
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

  it("includes output-prefixed source files while excluding generated output directories", () => {
    const temporary = mkdtempSync(join(tmpdir(), "domotion-typecheck-glob-"));
    const included = [
      "tests/ordinary.test.ts",
      "tests/output-directory.test.ts",
      "tests/output-helper.tsx",
      "tests/source/output-model/nested.ts",
    ];
    const excluded = [
      "tests/output/generated.ts",
      "tests/output-linux/generated.tsx",
      "tests/output-windows/nested/generated.ts",
      "tests/cache/generated.ts",
    ];
    try {
      for (const file of [...included, ...excluded]) {
        const path = join(temporary, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "export {};\n");
      }
      const fixture = ts.parseJsonConfigFileContent(
        { include: ["tests/**/*.ts", "tests/**/*.tsx"], exclude: parsed.config.exclude },
        ts.sys,
        temporary,
      );
      expect(fixture.errors).toEqual([]);
      expect(
        testSources(join(temporary, "tests"))
          .map((path) => relative(temporary, path))
          .sort(),
      ).toEqual(included.map((path) => join(...path.split("/"))).sort());
      expect(fixture.fileNames.map((path) => relative(temporary, path)).sort()).toEqual(
        included.map((path) => join(...path.split("/"))).sort(),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("does not opt test files out of checking", () => {
    const optedOut = testSources("tests").filter((path) => /@ts-(nocheck|ignore)\b/.test(readFileSync(path, "utf8")));
    expect(optedOut).toEqual([]);
  });
});
