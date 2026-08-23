import { describe, expect, it } from "vitest";
import { runGenericProfileTargetOracle } from "../tools/generic-profile-target-oracle.js";

describe("authenticated Chrome profile and OOPIF generic authority", () => {
  it("proves all profile fields and both mutation orders without pixels", async () => {
    const report = await runGenericProfileTargetOracle();
    expect(report.errors).toEqual([]);
    expect(report.environment.browserBinary).toMatchObject({
      requestedChannel: "chrome",
      registryName: "chrome",
      registryBrowserName: "chromium",
    });
    expect(report.environment.browserBinary!.executablePath).toBeTruthy();
    expect(report.environment.browserBinary!.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.environment.launches).toHaveLength(8);
    expect(report.environment.launches.every((launch) => launch.pass)).toBe(true);
    expect(report.environment.sources.playwrightOverlaySha256).toMatch(/^[a-f0-9]{64}$/);

    expect(report.mutation).toMatchObject({ requiredFieldCount: 21, nonInertFieldCount: 21, pass: true });
    expect(Object.values(report.mutation.distinctRequestedFamiliesByScript).every((count) => count >= 2)).toBe(true);
    expect(report.playwrightOverlay.sourceFieldCount).toBe(report.playwrightOverlay.fields.length);
    expect(report.playwrightOverlay.fields.length).toBeGreaterThan(0);
    expect(report.profileOrders.map((order) => order.id)).toEqual(["headed-headless", "headless-headed"]);
    for (const order of report.profileOrders) {
      expect(order.persisted).toHaveLength(3);
      expect(order.persisted.every((checkpoint) => checkpoint.requiredFields === 21 && checkpoint.exactFields === 21 && checkpoint.pass)).toBe(true);
      expect(order.headed).toMatchObject({ expectedRows: 21, exactRows: 21, pass: true });
      expect(order.headless).toMatchObject({ expectedRows: 21, exactRows: 21, pass: true });
      expect(order.overlay).toMatchObject({ expectedRows: 21, exactRows: 21, mismatches: [], pass: true });
      expect(order.pass).toBe(true);
    }

    expect(report.target.orders.map((order) => order.id)).toEqual(["child-main", "main-child"]);
    for (const order of report.target.orders) {
      expect(order.targetIdentity.distinctOopifTargets).toBe(true);
      expect(order.baselineMainChildExactFields).toBe(21);
      expect(order.mutation).toMatchObject({ requiredFieldCount: 21, nonInertFieldCount: 21, pass: true });
      expect(order.steps).toHaveLength(2);
      expect(order.steps.every((step) => step.mutatedTargetExactFields === 21
        && step.otherTargetStableFields === 21
        && step.mainSystemUiStableRows === 3
        && step.childSystemUiStableRows === 3
        && step.pass)).toBe(true);
      expect(order.pass).toBe(true);
    }
    expect(report.target).toMatchObject({
      forwardReverseEquivalent: true,
      requiredGenericFieldsPerTarget: 21,
      requiredSystemUiRowsPerTarget: 3,
      supportedContract: "target-local-settings-authenticated-system-ui-separate",
      pass: true,
    });
    expect(JSON.stringify(report)).not.toMatch(/screenshot|pixelTolerance|tolerancePx/i);
    expect(report.verdict).toBe("source-exact");
  }, 120_000);
});
