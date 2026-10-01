import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runFeatureTests } from "./runner.js";

const stixPath = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf";

describe.skipIf(!existsSync(stixPath))("STIX Two Math radical glyph raster", () => {
  it("matches Chromium across the display-size sweep, including the 60px hook", async () => {
    const html = `<div style="padding:20px;background:#fff;color:#111">${[12, 16, 22, 30, 40, 50, 60]
      .map(
        (size) =>
          `<math display="block" style="font-family:'STIX Two Math';font-size:${size}px;margin:8px"><msqrt><mi>x</mi></msqrt></math>`,
      )
      .join("")}</div>`;
    const { results, failed } = await runFeatureTests(
      [{ name: "mathml-radical-stix-display-raster", html, width: 360, height: 1000 }],
      "mathml-radical-raster",
    );
    expect(failed).toBe(0);
    expect(results[0].regionCount).toBe(0);
  }, 120_000);
});
