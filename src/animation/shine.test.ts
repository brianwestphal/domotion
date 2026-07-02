import { describe, expect, it } from "vitest";
import { buildShineSweep } from "./shine.js";

describe("buildShineSweep (DM-1542 / DM-1524)", () => {
  const base = { id: "x", x: 10, y: 20, width: 200, height: 80, totalSec: 3 };

  it("clips the glint to the box and fills it with a 3-stop gradient", () => {
    const { markup } = buildShineSweep({ ...base, startPct: 30, endPct: 60 });
    // Clip rect matches the box.
    expect(markup).toContain(`<clipPath id="shine-clip-x"><rect x="10" y="20" width="200" height="80" />`);
    expect(markup).toContain(`clip-path="url(#shine-clip-x)"`);
    // transparent → color → transparent band.
    expect(markup).toContain(`stop-opacity="0"`);
    expect(markup).toContain(`stop-opacity="0.55"`); // default peak
    expect(markup).toContain(`url(#shine-grad-x)`);
  });

  it("animates ONLY transform (no filter — cross-engine-safe per docs/84)", () => {
    const { css } = buildShineSweep({ ...base, startPct: 30, endPct: 60 });
    expect(css).toContain("translateX(");
    expect(css).not.toContain("filter");
    expect(css).not.toContain("blur");
  });

  it("one-shot sweep parks the band off the box before and after (rest at identity)", () => {
    const { css } = buildShineSweep({ ...base, startPct: 40, endPct: 70 });
    // Parked-left before the window, parked-right after — so outside [40,70] the
    // band sits off the clipped box and paints nothing.
    expect(css).toMatch(/0% \{ transform: translateX\(-\d/); // starts parked left
    expect(css).toContain("39.999% { transform: translateX("); // holds parked until window
    expect(css).toMatch(/70\.000% \{ transform: translateX\(\d/); // swept fully right by window end
    expect(css).toMatch(/100% \{ transform: translateX\(\d/); // stays parked right
    expect(css).toContain("linear infinite");
  });

  it("repeat mode loops on its own clock with a start delay", () => {
    const { css } = buildShineSweep({ ...base, startPct: 10, endPct: 20, repeat: "infinite", repeatPeriodMs: 1200 });
    expect(css).toContain("1200ms linear");
    expect(css).toContain("infinite");
    // 10% of a 3s scene = 300ms delay.
    expect(css).toContain("300ms");
  });

  it("honors color / opacity / bandWidth / skew overrides", () => {
    const { markup } = buildShineSweep({ ...base, startPct: 0, endPct: 100, color: "#ffcc00", opacity: 0.8, bandWidth: 50, skewDeg: 30 });
    expect(markup).toContain(`stop-color="#ffcc00"`);
    expect(markup).toContain(`stop-opacity="0.8"`);
    expect(markup).toContain(`width="50"`);
    expect(markup).toContain(`skewX(-30)`);
  });

  it("accepts percent-string windows (from the animator) as well as numbers", () => {
    const { css } = buildShineSweep({ ...base, startPct: "25.00%", endPct: "50.00%" });
    expect(css).toContain("50.000% { transform: translateX(");
  });
});
