import { describe, expect, it } from "vitest";
import { planRealWorldScroll } from "./real-world-scroll-plan.js";

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
