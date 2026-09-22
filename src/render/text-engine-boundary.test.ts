import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Domotion text-engine integration boundary", () => {
  it("bundles a private version-locked workspace and releases both manifests together", () => {
    const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
      bundledDependencies: string[];
    };
    const enginePackage = JSON.parse(
      readFileSync(new URL("../../packages/text-engine/package.json", import.meta.url), "utf8"),
    ) as { version: string; private: boolean };
    const release = readFileSync(new URL("../../scripts/release.sh", import.meta.url), "utf8");

    expect(enginePackage.private).toBe(true);
    expect(enginePackage.version).toBe(rootPackage.version);
    expect(rootPackage.dependencies["@domotion/text-engine"]).toBe(enginePackage.version);
    expect(rootPackage.bundledDependencies).toContain("@domotion/text-engine");
    expect(release).toContain("--workspaces --include-workspace-root");
    expect(release).toContain("packages/text-engine/package.json");
  });

  it("keeps document and baseline lifecycle calls behind the workspace facade", () => {
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

  it("consumes the internal workspace rather than its source tree", () => {
    const facade = readFileSync(new URL("./text-engine.ts", import.meta.url), "utf8");
    expect(facade).toContain('from "@domotion/text-engine/internal/render/text-engine"');
    expect(facade).not.toContain("packages/text-engine/src");
  });
});
