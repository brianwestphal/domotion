import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalTextEngine, resolvedTextEnginePackage } from "../scripts/local-text-engine.mjs";

// DM-YNZF20: a worktree whose node_modules linked into another checkout built
// and tested against that checkout's text-engine without any error.
describe("local text-engine guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-local-text-engine-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A checkout laid out as npm installs this workspace. */
  const checkout = (name: string, linkedModulesFrom?: string): string => {
    const root = join(dir, name);
    mkdirSync(join(root, "packages", "text-engine"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "packages", "text-engine", "package.json"), "{}");
    if (linkedModulesFrom != null) symlinkSync(join(linkedModulesFrom, "node_modules"), join(root, "node_modules"));
    else {
      mkdirSync(join(root, "node_modules", "@domotion"), { recursive: true });
      symlinkSync("../../packages/text-engine", join(root, "node_modules", "@domotion", "text-engine"));
    }
    return root;
  };

  it("accepts this repository and a checkout with its own install", () => {
    expect(() => assertLocalTextEngine(process.cwd())).not.toThrow();
    const own = checkout("own");
    expect(() => assertLocalTextEngine(own)).not.toThrow();
  });

  it("refuses a checkout whose node_modules links into another checkout", () => {
    const main = checkout("main");
    const worktree = checkout("worktree", main);
    expect(resolvedTextEnginePackage(worktree)).toContain(join("main", "packages", "text-engine"));
    expect(() => assertLocalTextEngine(worktree)).toThrow(/resolves to .*main.*not this checkout's .*worktree.*npm ci/s);
  });

  it("accepts a linked checkout whose packages resolve to the same source", () => {
    const main = checkout("source");
    const linked = join(dir, "linked");
    mkdirSync(linked);
    writeFileSync(join(linked, "package.json"), "{}");
    for (const entry of ["node_modules", "packages"]) symlinkSync(join(main, entry), join(linked, entry));
    expect(() => assertLocalTextEngine(linked)).not.toThrow();
  });

  it("names a missing install", () => {
    const bare = join(dir, "bare");
    mkdirSync(join(bare, "packages", "text-engine"), { recursive: true });
    writeFileSync(join(bare, "package.json"), "{}");
    // Lookup walks up to the filesystem root; the temp tree has no other install.
    if (resolvedTextEnginePackage(bare) == null)
      expect(() => assertLocalTextEngine(bare)).toThrow(/is not installed .*npm ci/);
    else expect(() => assertLocalTextEngine(bare)).toThrow(/resolves to/);
  });
});
