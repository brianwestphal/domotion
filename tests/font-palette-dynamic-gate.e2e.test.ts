import { describe, expect, it } from "vitest";

import { runFontPaletteDynamicGate } from "../tools/font-palette-dynamic-gate.js";
import {
  COLRV1_FIXTURE,
  readColrv1SourceFacts,
} from "../tools/font-palette-paint-gate.js";

describe("dynamic font-palette production ownership", () => {
  it("preserves mix, animation time, and document/shadow scope in both cache orders", async () => {
    const report = await runFontPaletteDynamicGate({
      colrv1Source: readColrv1SourceFacts(),
      colrv1Fixture: COLRV1_FIXTURE,
      dprs: [1],
    });
    expect(report.verdict).toBe("source-exact");
    expect(report.colrv0Rows).toHaveLength(6);
    expect(report.colrv1Rows).toHaveLength(3);
    expect(report.colrv0Rows.every((row) => row.pass)).toBe(true);
    expect(report.colrv1Rows.every((row) => row.pass)).toBe(true);
    expect(report.productionOrders).toHaveLength(2);
    for (const order of report.productionOrders) {
      expect(order.pass).toBe(true);
      expect(order.capturedPngSha256).toEqual(order.sourcePngSha256);
      expect(order.capturedPaletteRecords).toHaveLength(6);
      expect(Object.values(order.identityChecks).every(Boolean)).toBe(true);
      expect(order.warnings).toEqual([]);
    }
    const [forward, reverse] = report.productionOrders;
    const forwardById = new Map(forward.order.map((id, index) => [id, forward.sourcePngSha256[index]]));
    const reverseById = new Map(reverse.order.map((id, index) => [id, reverse.sourcePngSha256[index]]));
    expect(reverseById).toEqual(forwardById);
    expect(forwardById.get("mix-srgb-30")).not.toBe(forwardById.get("animation-oklab-30"));
    expect(forwardById.get("animation-oklab-30")).not.toBe(forwardById.get("animation-oklab-50"));
    expect(forwardById.get("shadow-document-rule")).not.toBe(forwardById.get("shadow-local-rule-ignored"));
  }, 30_000);
});
