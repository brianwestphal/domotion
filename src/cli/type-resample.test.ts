/**
 * DM-1556 (docs/93 §2): unit coverage for the pure per-keystroke re-sampling
 * helpers — the flipbook timeline math and the spec defaulting. The browser-
 * driven capture loop (`buildTypeResampleAnimation`) is covered by
 * `type-resample.e2e.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { resolveTypeResampleSpec, typeResampleDurations, TYPE_RESAMPLE_DEFAULTS } from "./type-resample.js";

describe("typeResampleDurations (DM-1556)", () => {
  it("produces charCount+1 states (0..charCount chars typed)", () => {
    expect(typeResampleDurations(10, 60, 0, 700)).toHaveLength(11);
    expect(typeResampleDurations(1, 60, 0, 700)).toHaveLength(2);
  });

  it("state 0 folds the initial delay into the first keystroke interval", () => {
    const durs = typeResampleDurations(5, 60, 300, 700);
    expect(durs[0]).toBe(360); // delay + speed
  });

  it("intermediate states hold one keystroke interval, the last holds tailMs", () => {
    const durs = typeResampleDurations(4, 60, 0, 700);
    // states: [0,1,2,3,4] chars → durs [speed, speed, speed, speed, tailMs]
    expect(durs).toEqual([60, 60, 60, 60, 700]);
  });

  it("sums to delay + charCount*speed + tailMs (the internal loop period)", () => {
    const [charCount, speed, delay, tail] = [10, 130, 300, 900];
    const total = typeResampleDurations(charCount, speed, delay, tail).reduce((a, b) => a + b, 0);
    expect(total).toBe(delay + charCount * speed + tail); // 300 + 1300 + 900 = 2500
  });

  it("a single-character re-sample is empty-state then typed-state", () => {
    // charCount 1 → [delay+speed, tailMs]; the j===0 branch wins over j===last.
    expect(typeResampleDurations(1, 60, 300, 700)).toEqual([360, 700]);
  });
});

describe("resolveTypeResampleSpec (DM-1556)", () => {
  it("applies the documented defaults when only selector/text are given", () => {
    const spec = resolveTypeResampleSpec({ selector: "#phone", text: "4155550142" });
    expect(spec).toEqual({
      selector: "#phone",
      text: "4155550142",
      speed: TYPE_RESAMPLE_DEFAULTS.speed,
      delay: TYPE_RESAMPLE_DEFAULTS.delay,
      tailMs: TYPE_RESAMPLE_DEFAULTS.tailMs,
      clear: TYPE_RESAMPLE_DEFAULTS.clear,
      caret: TYPE_RESAMPLE_DEFAULTS.caret,
    });
  });

  it("respects explicit overrides, including falsy ones (clear:false, caret:false, delay:0)", () => {
    const spec = resolveTypeResampleSpec({
      selector: "#f", text: "ab", speed: 40, delay: 0, tailMs: 100, clear: false, caret: false,
    });
    expect(spec.speed).toBe(40);
    expect(spec.delay).toBe(0);
    expect(spec.tailMs).toBe(100);
    expect(spec.clear).toBe(false);
    expect(spec.caret).toBe(false);
  });
});
