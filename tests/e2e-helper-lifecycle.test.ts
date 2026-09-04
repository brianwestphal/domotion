import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("E2E native-helper lifecycle (DM-2672)", () => {
  it("keeps the production persistent transport enabled and tears it down per test file", () => {
    const config = source("../vitest.e2e.config.ts");
    const setup = source("e2e-setup.ts");

    expect(config).not.toContain("DOMOTION_HELPER_NO_SERVE");
    expect(setup).toContain("afterAll(() => clearGlyphHelperCache())");
  });
});
