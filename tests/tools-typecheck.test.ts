import { existsSync, readFileSync } from "node:fs";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// DM-KCC90P: tools/ was outside every typecheck project, so a gate script
// shipped a bare `chromium.executablePath()` after its import was removed and
// every OS lane failed with a ReferenceError.
describe("DM-KCC90P: tools typecheck project", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const parsed = ts.parseConfigFileTextToJson("tsconfig.tools.json", readFileSync("tsconfig.tools.json", "utf8"));
  const config = parsed.config as { include: string[]; exclude: string[] };

  it("is part of npm run typecheck, which CI runs", () => {
    expect(parsed.error).toBeUndefined();
    expect(pkg.scripts.typecheck).toContain("-p tsconfig.tools.json");
  });

  it("covers every tool and excludes only paths that exist", () => {
    expect(config.include).toContain("tools/**/*.ts");
    for (const path of config.exclude.filter((entry) => !entry.includes("*") && entry.endsWith(".ts"))) {
      expect(existsSync(path), `${path} is excluded but no longer exists`).toBe(true);
    }
  });
});

// DM-ZKCPBZ: `tsconfig.tools.json` included only `.ts` / `.tsx`, and no ESLint config block matched `.mts`, so the
// TypeScript tool modules written as `.mts` were never typechecked or linted (one already carried a real type error).
describe("DM-ZKCPBZ: .mts tool modules are typechecked and linted", () => {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.tools.json", readFileSync("tsconfig.tools.json", "utf8"));
  const config = parsed.config as { include: string[] };

  it("includes tools/**/*.mts in the tools typecheck project", () => {
    expect(config.include).toContain("tools/**/*.mts");
  });

  it("lints a tools .mts module with the TypeScript parser and the no-any rule", async () => {
    const eslint = new ESLint();
    const file = "tools/cursor-catalog.mts";
    expect(existsSync(file)).toBe(true);
    expect(await eslint.isPathIgnored(file)).toBe(false);
    const resolved = (await eslint.calculateConfigForFile(file)) as
      { languageOptions?: { parser?: unknown }; rules?: Record<string, unknown> } | undefined;
    expect(resolved?.languageOptions?.parser).toBeDefined();
    expect(resolved?.rules?.["no-restricted-syntax"]).toBeDefined();
  });
});
