import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// DM-WN6RXW: the project integrates under Hot Sheet's ci-staged strategy, so
// verified commits are pushed to the `integration` branch first and `main` is
// fast-forwarded only to a SHA whose CI run there was green. A push-triggered
// gate that listens to `main` alone would never test a staged batch, and the
// promotion would ship it unverified. Only the Pages deploy stays main-only.
const WORKFLOWS = ".github/workflows";
const MAIN_ONLY = new Set(["pages.yml"]);

const pushBranches = (source: string): string | undefined =>
  /\n {2}push:\s*\n(?: {4}[^\n]*\n)*? {4}branches: (\[[^\]]*\])/.exec(source)?.[1];

describe("ci-staged branch triggers (DM-WN6RXW)", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
  const branchFiltered = files
    .map((file) => ({ file, branches: pushBranches(readFileSync(join(WORKFLOWS, file), "utf8")) }))
    .filter((w): w is { file: string; branches: string } => w.branches != null);

  it("finds the branch-filtered push workflows, including ci.yml", () => {
    expect(branchFiltered.map((w) => w.file)).toContain("ci.yml");
  });

  it("runs every main-push gate on the integration staging branch too", () => {
    const missing = branchFiltered
      .filter((w) => !MAIN_ONLY.has(w.file))
      .filter((w) => !/\bmain\b/.test(w.branches) || !/\bintegration\b/.test(w.branches))
      .map((w) => `${w.file}: ${w.branches}`);
    expect(missing).toEqual([]);
  });

  it("keeps the Pages deploy on main only", () => {
    expect(branchFiltered.find((w) => w.file === "pages.yml")?.branches).toBe("[main]");
  });
});
