import { describe, expect, it } from "vitest";
import { runGenericProfileTargetOracle } from "../tools/generic-profile-target-oracle.js";

describe("Chrome profile and OOPIF generic authority", () => {
  it("matches exact source-owned face identity and rejects target divergence", async () => {
    const report = await runGenericProfileTargetOracle();
    expect(report.errors).toEqual([]);
    expect(report.headed.pass).toBe(true);
    expect(report.headless.pass).toBe(true);
    expect(report.overlay.pass).toBe(true);
    expect(report.target).toMatchObject({
      ordinaryMainFrameExact: true,
      ordinaryChildFrameExact: true,
      divergentMutationMovedChild: true,
      divergentMutationLeftMainStable: true,
      supportedContract: "non-divergent-target-settings-only",
      pass: true,
    });
    expect(report.verdict).toBe("source-exact");
  }, 120_000);
});
