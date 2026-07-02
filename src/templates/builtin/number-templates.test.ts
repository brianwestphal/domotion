import { describe, it, expect } from "vitest";
import {
  formatNumber, planOdometer, formatTimer, planTimer, buildOdometerMarkup, MAX_SPINS,
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

  it("each digit column records its start/end digit + direction", () => {
    const ds = digits(planOdometer(7, 1250).columns);
    expect(ds.every((d) => d.up)).toBe(true);
    expect(ds[ds.length - 1].endDigit).toBe(0); // units of 1250
    const down = digits(planOdometer(50, 30).columns);
    expect(down.every((d) => !d.up)).toBe(true);
  });

  it("a place that never ticks doesn't move; lower places that tick do", () => {
    // 105 → 125: the hundreds place never changes (floor/100 is 1 throughout) →
    // steps 0. The tens place changes, and the units place — though it starts AND
    // ends on 5 — ticks 20 times over the count (105→…→125), so it spins. That's
    // real odometer behavior, not a bug.
    const ds = digits(planOdometer(105, 125).columns);
    expect(ds[0].steps).toBe(0);           // hundreds — never ticks
    expect(ds[1].steps).toBeGreaterThan(0); // tens — changes
    expect(ds[2].steps).toBe(20);           // units — ticks 20× (2 full turns), lands on 5
  });

  it("low-order digits of a big count spin through multiple turns", () => {
    // counting 0 → 128,500: the units place ticks 128,500 times → capped spin.
    const ds = digits(planOdometer(0, 128500, { grouping: true }).columns);
    const units = ds[ds.length - 1];
    expect(units.steps).toBe(MAX_SPINS * 10); // full capped spins, lands back on 0
    // the top digit (hundred-thousands 0→1) only nudges.
    expect(ds[0].steps).toBe(1);
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
    expect(digits(p.columns)[digits(p.columns).length - 1].endDigit).toBe(5);
  });
});

describe("odometer.buildOdometerMarkup — Domotion-safe shape (DM-1532)", () => {
  it("every reel animation rests at IDENTITY (to: 0px) so capture can't double-transform", () => {
    // The bug that broke the first cut: a non-identity resting transform gets baked
    // into captured glyph positions AND re-applied as the keyframe → garbled output.
    const plan = planOdometer(0, 1234, { grouping: true });
    const m = buildOdometerMarkup(plan, { cellPx: 100, durationMs: 1000 });
    expect(m.animations.length).toBeGreaterThan(0);
    expect(m.animations.every((a) => a.to === "0px")).toBe(true);
    expect(m.animations.every((a) => a.property === "translateY")).toBe(true);
  });

  it("each reel's resting (top) cell is the FINAL digit (reduced-motion shows the target)", () => {
    const plan = planOdometer(0, 7);
    const m = buildOdometerMarkup(plan, { cellPx: 100, durationMs: 800 });
    // First digit glyph inside the reel strip = seq[0] = endDigit (7).
    const firstReelDigit = /od-strip[^>]*><span class="od-d">(\d)/.exec(m.html)?.[1];
    expect(firstReelDigit).toBe("7");
  });

  it("from offset = -steps*cellPx (rolls in from the start digit)", () => {
    const plan = planOdometer(0, 5); // steps=5
    const m = buildOdometerMarkup(plan, { cellPx: 120, durationMs: 800 });
    expect(m.animations[0].from).toBe(`-${5 * 120}px`);
  });

  it("emits one animation per CHANGED digit column, and staggers left→right", () => {
    const plan = planOdometer(0, 123); // 3 changing digits
    const m = buildOdometerMarkup(plan, { cellPx: 100, durationMs: 800, staggerMs: 100 });
    expect(m.animations).toHaveLength(3);
    expect(m.animations.map((a) => a.delay)).toEqual([0, 100, 200]);
  });

  it("a non-ticking digit renders as a single static glyph (no reel/animation)", () => {
    // 3 → 5: one digit place; it's the only reel. (No higher/other place ticks.)
    const plan = planOdometer(3, 5);
    const m = buildOdometerMarkup(plan, { cellPx: 100, durationMs: 800 });
    expect(m.animations).toHaveLength(1);
    // 205 → 205: nothing ticks → no animations at all.
    const same = buildOdometerMarkup(planOdometer(205, 205), { cellPx: 100, durationMs: 800 });
    expect(same.animations).toHaveLength(0);
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
    expect(animations.every((a) => a.to === "0px")).toBe(true); // identity rest
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
    expect(rolled.animations.some((a) => a.property === "translateY")).toBe(true);
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
