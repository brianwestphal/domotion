import { describe, expect, it } from "vitest";
import { planFrameTimeline } from "./frame-timeline.js";

describe("planFrameTimeline", () => {
  it("plans one deterministic clock for default, cut, and explicit transitions", () => {
    const plan = planFrameTimeline([
      { duration: 100 },
      { duration: 200, transition: { type: "cut", duration: 999 } },
      { duration: 50, transition: { type: "crossfade", duration: 25 } },
    ]);

    expect(plan.totalDurationMs).toBe(675);
    expect(plan.totalSeconds).toBe(0.675);
    expect(plan.frames).toEqual([
      { index: 0, startMs: 0, holdEndMs: 100, endMs: 400, startPct: 0 },
      { index: 1, startMs: 400, holdEndMs: 600, endMs: 600, startPct: (400 / 675) * 100 },
      { index: 2, startMs: 600, holdEndMs: 650, endMs: 675, startPct: (600 / 675) * 100 },
    ]);
  });
});
