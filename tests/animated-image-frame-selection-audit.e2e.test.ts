import { describe, expect, it } from "vitest";
import { runAnimatedImageFrameSelectionAudit } from "../tools/animated-image-frame-selection-audit.js";

describe("animated-image decoder frame ownership", () => {
  it("selects complete GIF/APNG/WebP frames exactly in same-frame and reverse orders", async () => {
    const report = await runAnimatedImageFrameSelectionAudit();
    expect(report.browser.headless).toBe(true);
    expect(report.browser.secureContext).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.verdict).toBe("decoder-frame-exact");
    expect(report.formats.map((format) => format.format)).toEqual(["gif", "apng", "webp"]);
    for (const format of report.formats) {
      expect(format.typeSupported).toBe(true);
      expect(format.track.animated).toBe(true);
      expect(format.track.frameCount).toBeGreaterThanOrEqual(2);
      expect(format.arms.map((arm) => arm.role)).toEqual(["proposal", "validation"]);
      expect(new Set(format.arms.flatMap((arm) => arm.observations.map((row) => row.rgbaSha256))).size)
        .toBeGreaterThanOrEqual(2);
      expect(format.outOfRange.name).toBe("RangeError");
    }
  }, 120_000);
});
