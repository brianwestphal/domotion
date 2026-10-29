import { existsSync, readFileSync } from "node:fs";
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
