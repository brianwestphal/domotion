import { describe, expect, it } from "vitest";
import { cssPropertySampleSchedule } from "./css-property-resample.js";
import { validateAnimateConfig } from "./animate-orchestrator.js";

describe("CSS property animation sample schedule", () => {
  it("retains the exact frame period and a final source-painted state", () => {
    const samples = cssPropertySampleSchedule(120, 25);
    expect(samples).toEqual([
      { atMs: 0, holdMs: 40 },
      { atMs: 40, holdMs: 40 },
      { atMs: 80, holdMs: 39 },
      { atMs: 119, holdMs: 1 },
    ]);
    expect(samples.reduce((sum, sample) => sum + sample.holdMs, 0)).toBe(120);
  });

  it("keeps a sub-millisecond frame as one positive hold", () => {
    expect(cssPropertySampleSchedule(0.5, 30)).toEqual([{ atMs: 0, holdMs: 0.5 }]);
  });

  it("rejects budgets that would require excessive page captures", () => {
    expect(() => cssPropertySampleSchedule(10_000, 30)).toThrow("exceeds 120 captures");
    expect(() => cssPropertySampleSchedule(100, 31)).toThrow("fps <= 30");
  });
});

describe("CSS property resample config", () => {
  it("accepts a live frame and rejects competing nested content", () => {
    expect(() =>
      validateAnimateConfig({
        width: 100,
        height: 100,
        frames: [{ input: "page.html", duration: 120, cssPropertyResample: { selector: "#art", fps: 25 } }],
      }),
    ).not.toThrow();
    expect(() =>
      validateAnimateConfig({
        width: 100,
        height: 100,
        frames: [
          {
            input: "page.html",
            duration: 120,
            cssPropertyResample: { selector: "#art" },
            typeResample: { selector: "#field", text: "x" },
          },
        ],
      }),
    ).toThrow(/cssPropertyResample.*typeResample/);
  });
});
