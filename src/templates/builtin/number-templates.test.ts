import { describe, it, expect } from "vitest";
import {
  formatNumber, planOdometer, formatTimer, planTimer, buildOdometerMarkup, ODOMETER_CYCLES,
  type OdometerColumn,
} from "./odometer.js";
import { counterTemplate, buildCounterHtml, planCounter, counterParamsSchema } from "./counter.js";
import { statTemplate, buildStatHtml, resolveDeltaDir, statParamsSchema } from "./stat.js";
import type { Brand } from "../brand.js";

const BRAND: Brand = {
  palette: { primary: "#2f6df6", accent: "#22d3ee", text: "#e6edf3" },
  font: { family: "Inter, sans-serif" },
  background: "#0b1020",
};

const digits = (cols: OdometerColumn[]): Extract<OdometerColumn, { type: "digit" }>[] =>
  cols.filter((c): c is Extract<OdometerColumn, { type: "digit" }> => c.type === "digit");

describe("odometer.formatNumber (DM-1532)", () => {
  it("applies decimals, grouping, and integer padding", () => {
    expect(formatNumber(1234)).toBe("1234");
    expect(formatNumber(1234, { grouping: true })).toBe("1,234");
    expect(formatNumber(1234567, { grouping: true })).toBe("1,234,567");
    expect(formatNumber(42.5, { decimals: 2 })).toBe("42.50");
    expect(formatNumber(5, {}, 4)).toBe("0005"); // left-pad to align columns
    expect(formatNumber(-12, {})).toBe("-12");
  });
});

describe("odometer.planOdometer (DM-1532)", () => {
  it("aligns from/to to the same width and structure", () => {
    const p = planOdometer(7, 1250, { grouping: true });
    expect(p.toText).toBe("1,250");
    expect(p.fromText).toBe("0,007"); // padded + grouped to align columns
    expect(p.fromText.length).toBe(p.toText.length);
  });

  it("every digit column rests on its target digit (index % 10 === endDigit)", () => {
    for (const [from, to] of [[7, 1250], [90, 30], [0, 1234], [999, 1000]] as const) {
      const p = planOdometer(from, to);
      for (const d of digits(p.columns)) {
        expect(d.endIndex % 10).toBe(d.endDigit);
      }
    }
  });

  it("count-up rolls forward (endIndex ≥ startIndex), count-down backward", () => {
    const up = digits(planOdometer(0, 5).columns)[0];
    expect(up.endIndex).toBeGreaterThan(up.startIndex);
    const down = digits(planOdometer(5, 0).columns)[0];
    expect(down.endIndex).toBeLessThan(down.startIndex);
  });

  it("an unchanged digit does not move", () => {
    // 105 → 125: hundreds (1) and units (5) unchanged, tens 0→2 moves.
    const p = planOdometer(105, 125);
    const ds = digits(p.columns);
    expect(ds[0].startIndex).toBe(ds[0].endIndex); // hundreds
    expect(ds[2].startIndex).toBe(ds[2].endIndex); // units
    expect(ds[1].startIndex).not.toBe(ds[1].endIndex); // tens
  });

  it("separators and the decimal point become static columns", () => {
    const p = planOdometer(0, 1234.5, { grouping: true, decimals: 1 });
    const statics = p.columns.filter((c) => c.type === "static").map((c) => (c as { char: string }).char);
    expect(statics).toContain(",");
    expect(statics).toContain(".");
  });
});

describe("odometer timer (DM-1532)", () => {
  it("formatTimer: M:SS and H:MM:SS", () => {
    expect(formatTimer(5)).toBe("0:05");
    expect(formatTimer(90)).toBe("1:30");
    expect(formatTimer(3661)).toBe("1:01:01");
  });

  it("planTimer keeps the colon static and aligns widths", () => {
    const p = planTimer(90, 5); // "1:30" → "0:05"
    expect(p.toText).toBe("0:05");
    expect(p.fromText).toBe("1:30");
    expect(p.columns.some((c) => c.type === "static" && c.char === ":")).toBe(true);
    for (const d of digits(p.columns)) expect(d.endIndex % 10).toBe(d.endDigit);
  });
});

describe("odometer.buildOdometerMarkup (DM-1532)", () => {
  it("emits one animation per CHANGED digit column and a strip of cycles*10 cells", () => {
    const plan = planOdometer(105, 125); // only the tens digit changes
    const m = buildOdometerMarkup(plan, { durationMs: 1000, staggerMs: 50 });
    expect(m.animations).toHaveLength(1);
    expect(m.animations[0]).toMatchObject({ property: "translateY" });
    // strip rendered once, reused per column: cycles*10 digit cells in the markup per reel.
    const cellCount = (m.html.match(/od-d/g) ?? []).length / digits(plan.columns).length;
    expect(cellCount).toBe(ODOMETER_CYCLES * 10);
  });

  it("rests each strip at its FINAL index (reduced-motion shows the target)", () => {
    const plan = planOdometer(0, 7);
    const m = buildOdometerMarkup(plan, { durationMs: 800 });
    const endIndex = digits(plan.columns)[0].endIndex;
    expect(m.html).toContain(`translateY(-${endIndex}em)`);
  });

  it("staggers digit columns left→right", () => {
    const plan = planOdometer(0, 123);
    const m = buildOdometerMarkup(plan, { durationMs: 800, staggerMs: 100 });
    const delays = m.animations.map((a) => a.delay);
    expect(delays).toEqual([0, 100, 200]);
  });
});

describe("counter template (DM-1532)", () => {
  it("planCounter uses timer plan in timer mode, number plan otherwise", () => {
    expect(planCounter(counterParamsSchema.parse({ to: 5, from: 90, mode: "timer" })).toText).toBe("0:05");
    expect(planCounter(counterParamsSchema.parse({ to: 1234, grouping: true })).toText).toBe("1,234");
  });

  it("buildCounterHtml wraps the reel with prefix/suffix and includes the odometer css", () => {
    const { html, animations } = buildCounterHtml(counterParamsSchema.parse({ to: 1234, prefix: "$", suffix: "+" }));
    expect(html).toContain('class="ct-affix">$');
    expect(html).toContain('class="ct-affix">+');
    expect(html).toContain(".od-cell");
    expect(animations.length).toBeGreaterThan(0);
  });

  it("brandDefaults maps text→color, background, font", () => {
    expect(counterTemplate.brandDefaults!(BRAND)).toEqual({
      color: "#e6edf3", background: "#0b1020", fontFamily: "Inter, sans-serif",
    });
  });
});

describe("stat template (DM-1532)", () => {
  it("resolveDeltaDir: explicit wins; else parses the sign from the delta text", () => {
    expect(resolveDeltaDir(statParamsSchema.parse({ value: 1, delta: "8.1%" }))).toBe("up");
    expect(resolveDeltaDir(statParamsSchema.parse({ value: 1, delta: "-3%" }))).toBe("down");
    expect(resolveDeltaDir(statParamsSchema.parse({ value: 1, delta: "▼ 2%" }))).toBe("down");
    expect(resolveDeltaDir(statParamsSchema.parse({ value: 1, delta: "5%", deltaDir: "down" }))).toBe("down");
  });

  it("animateValue rolls from 0; off shows it static (no roll animations)", () => {
    const rolled = buildStatHtml(statParamsSchema.parse({ value: 950, animateValue: true }));
    expect(rolled.animations.length).toBeGreaterThan(0);
    const staticStat = buildStatHtml(statParamsSchema.parse({ value: 950, animateValue: false }));
    expect(staticStat.animations.filter((a) => a.property === "translateY")).toHaveLength(0);
  });

  it("the delta chip fades in AFTER the value roll ends", () => {
    const p = statParamsSchema.parse({ value: 950, delta: "8.1%", durationMs: 1000 });
    const { html, animations } = buildStatHtml(p);
    expect(html).toContain("st-delta");
    expect(html).toContain("▲");
    const chip = animations.find((a) => a.selector === ".st-delta")!;
    expect(chip.property).toBe("opacity");
    expect(chip.delay!).toBeGreaterThan(1000); // after the 1000ms roll
  });

  it("omits the chip when there's no delta", () => {
    const { html, animations } = buildStatHtml(statParamsSchema.parse({ value: 5 }));
    expect(html).not.toContain('class="st-delta"');
    expect(animations.find((a) => a.selector === ".st-delta")).toBeUndefined();
  });

  it("brandDefaults maps primary→accent", () => {
    expect(statTemplate.brandDefaults!(BRAND)).toMatchObject({ accent: "#2f6df6", color: "#e6edf3" });
  });
});
