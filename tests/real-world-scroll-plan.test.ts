import { describe, expect, it } from "vitest";
import { planRealWorldScroll, scrollChunkSeekTimeMs } from "./real-world-scroll-plan.js";

describe("real-world scroll planning", () => {
  it("samples heavy sites without pretending the sampled extent is full depth", () => {
    expect(planRealWorldScroll("stripe", 844, 20_256, false)).toEqual({
      extent: "sampled",
      availableEndY: 20_256,
      requestedEndY: 3_376,
      plannedTransitions: 4,
      jobTimeoutMs: 360_000,
    });
    expect(planRealWorldScroll("resend", 800, 11_391, false)).toEqual({
      extent: "sampled",
      availableEndY: 11_391,
      requestedEndY: 800,
      plannedTransitions: 1,
      jobTimeoutMs: 360_000,
    });
  });

  it("keeps other sites and short pages at full depth", () => {
    expect(planRealWorldScroll("apple", 800, 5_000, false).requestedEndY).toBe(5_000);
    expect(planRealWorldScroll("stripe", 844, 600, false).extent).toBe("full-depth");
  });

  it("gives an explicit full-depth heavy run a budget proportional to its chunks", () => {
    const stripe = planRealWorldScroll("stripe", 844, 20_256, true);
    expect(stripe).toMatchObject({ extent: "full-depth", requestedEndY: 20_256, plannedTransitions: 24 });
    expect(stripe.jobTimeoutMs).toBeGreaterThan(10 * 60_000);
    const resend = planRealWorldScroll("resend", 800, 11_391, true);
    expect(resend).toMatchObject({ extent: "full-depth", requestedEndY: 11_391, plannedTransitions: 15 });
    expect(resend.jobTimeoutMs).toBeGreaterThan(30 * 60_000);
  });
});

describe("scroll chunk screenshot seek", () => {
  it("keeps intermediate anchors exact and takes the final representable left limit", () => {
    expect(scrollChunkSeekTimeMs(8_439, 11_252)).toBe(8_439);
    expect(scrollChunkSeekTimeMs(11_252, 11_252)).toBe(11_251.999999999998);
  });
  it.each([Number.MIN_VALUE * 2, 1e-100, 1, 2, 100, 11_252, 1_000_000, Number.MAX_VALUE])(
    "returns the immediate positive-double predecessor for %s ms",
    (duration) => {
      const sample = scrollChunkSeekTimeMs(duration, duration);
      expect(sample).toBeLessThan(duration);
      const bits = new DataView(new ArrayBuffer(8));
      bits.setFloat64(0, sample);
      bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
      expect(bits.getFloat64(0)).toBe(duration);
    },
  );
  it("rejects invalid cycles/anchors and cycles without a positive interior", () => {
    expect(() => scrollChunkSeekTimeMs(0, 0)).toThrow(RangeError);
    expect(() => scrollChunkSeekTimeMs(Number.MIN_VALUE, Number.MIN_VALUE)).toThrow(RangeError);
    expect(() => scrollChunkSeekTimeMs(NaN, 1)).toThrow(RangeError);
    expect(() => scrollChunkSeekTimeMs(1, NaN)).toThrow(RangeError);
    expect(() => scrollChunkSeekTimeMs(Infinity, Infinity)).toThrow(RangeError);
    expect(() => scrollChunkSeekTimeMs(0, -1)).toThrow(RangeError);
  });
});
