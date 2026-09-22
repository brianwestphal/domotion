import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("text-engine package boundary", () => {
  it("does not depend on Domotion capture, animation, CLI, or Studio layers", () => {
    const source = readFileSync(new URL("./text-engine.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/(capture|animation|cli|scroll|studio|templates)\//);
  });

  it("does not recreate the accidental resolver barrel through text-to-path", () => {
    const source = readFileSync(new URL("./text-to-path.ts", import.meta.url), "utf8");
    expect(source).not.toContain('export * from "./font-resolution.js"');
  });

  it("keeps document and baseline lifecycle calls behind the facade", () => {
    const adapters = [
      "./element-tree-to-svg.ts",
      "../capture/index.ts",
      "../scroll/composer.ts",
      "../animation/svg-generator.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    for (const source of adapters) {
      expect(source).not.toMatch(/\b(begin|end)CharacterFallbackDocument\s*\(/);
      expect(source).not.toMatch(/\b(push|pop)BaselineSnapSuppression\s*\(/);
    }
  });
});
