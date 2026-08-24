import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/helper-availability-contract.yml", "utf8");

describe("helper availability all-platform gate", () => {
  it("runs enabled and explicitly disabled logical arms on every supported OS", () => {
    expect(workflow).toContain("os: [macos-latest, ubuntu-latest, windows-latest]");
    expect(workflow).toContain("helper-present.json");
    expect(workflow).toContain("DOMOTION_DISABLE_HELPER: \"1\"");
    expect(workflow).toContain("helper-absent.json");
    expect(workflow).toContain("--compare helper-present.json,helper-absent.json");
  });

  it("builds the platform-native helper and makes no raster assertion", () => {
    expect(workflow).toContain("Build macOS helper");
    expect(workflow).toContain("Build Linux helper");
    expect(workflow).toContain("Build Windows helper");
    expect(workflow).not.toMatch(/screenshot|pixel|tolerance|playwright/i);
  });

  it("the oracle checks the production availability gate instead of trusting the environment label", () => {
    const oracle = readFileSync("tools/helper-availability-contract.ts", "utf8");
    expect(oracle).toContain("isGlyphHelperAvailable()");
    expect(oracle).toContain("activation was inert");
    const routeOracle = readFileSync("tools/renderer-font-route-oracle.ts", "utf8");
    expect(routeOracle).toContain("helperRouteLedgerEnvironment");
    expect(routeOracle).toContain('nativeFacts: helperEnvironment.helper.mode === "helper-present"');
    expect(routeOracle).toContain('"degraded-evidence-complete"');
  });
});
