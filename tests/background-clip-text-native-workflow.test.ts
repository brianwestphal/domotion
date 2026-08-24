import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2530 native background-clip:text workflow", () => {
  it("collects headless DPR1/2 evidence independently on Linux and Windows before aggregation", () => {
    const yaml = readFileSync(".github/workflows/background-clip-text-native-parity.yml", "utf8");
    expect(yaml).toContain("key: linux");
    expect(yaml).toContain("key: win32");
    expect(yaml).toContain("Run authenticated headless DPR1/2 oracle");
    expect(yaml).toContain("needs: collect");
    expect(yaml).toContain("background-clip-text-native-gate.ts");
    expect(yaml).not.toContain("headed: true");
    expect(yaml).not.toMatch(/tolerance|envelope/i);
  });
});
