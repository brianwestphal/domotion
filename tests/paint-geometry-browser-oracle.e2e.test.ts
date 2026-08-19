import { describe, expect, it } from "vitest";
import { runBrowserPaintOracle } from "../tools/paint-geometry-browser-oracle.js";

describe("paint geometry browser oracle (DM-2307)", () => {
  it("validates source-transcribed discriminators against current Chromium paint", async () => {
    const report = await runBrowserPaintOracle();
    expect(report.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.deviceScaleFactor).toBe(4);
    expect(report.probes).toHaveLength(3);
    expect(report.probes.filter((probe) => !probe.pass)).toEqual([]);
    expect(report.verdict).toBe("browser-validates-source-rules");
  }, 30_000);
});
