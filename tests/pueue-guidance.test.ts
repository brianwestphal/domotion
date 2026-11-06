import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// DM-57CM5X: `pueue add` joins its arguments with spaces and runs the result
// through its own `sh -c`, so `pueue add -- sh -c 'npx tsx script.ts'` runs
// `sh -c npx tsx script.ts`: `npx` (or `tsx`) starts with no arguments, opens an
// interactive shell or REPL, and waits forever on the task's stdin pipe.
describe("DM-57CM5X: pueue task commands are never wrapped in sh -c", () => {
  const WRAPPED = /pueue add\b[^\n`]*--\s+(?:ba|z)?sh\s+-c\b/;

  function textFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "scratch" ? [] : textFiles(path);
      return /\.(md|ts|tsx|mjs|sh|ya?ml)$/.test(entry.name) ? [path] : [];
    });
  }

  it("documents the rule in AGENTS.md Background Tasks", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("**Never wrap a task in `sh -c '…'`.**");
  });

  it("has no documented or scripted pueue command that wraps its task in sh -c", () => {
    const offenders = ["docs", "scripts", "tools", ".github"]
      .flatMap(textFiles)
      .filter((path) => WRAPPED.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    // The pattern does catch the hanging form.
    expect(WRAPPED.test("pueue add -l dm-x -- sh -c 'npx tsx tools/a.ts'")).toBe(true);
    expect(WRAPPED.test("pueue add -l dm-x -- 'npx tsx tools/a.ts | tail -1'")).toBe(false);
  });
});
