import { describe, expect, it } from "vitest";

import { runTimelineSamplingOwnershipOracle } from "../tools/timeline-sampling-ownership-oracle.js";

describe("DM-2531 live timeline sampling ownership", () => {
  it("discriminates progress holds, source ownership, rAF clocks, and OOPIF scope without pixels", async () => {
    const report = await runTimelineSamplingOwnershipOracle();

    expect(report.pass).toBe(true);
    expect(report.native.targets.distinctOopifTargets).toBe(true);
    expect(report.native.frames.map((frame) => frame.role)).toEqual(["main", "oopif"]);
    expect(report.native.frames.every((frame) => frame.absoluteSeek.rejected)).toBe(true);
    expect(report.native.frames.every((frame) => frame.transformedScroller.timelineTimeExact
      && frame.transformedScroller.quadChanged)).toBe(true);
    expect(report.native.frames.every((frame) => frame.projectiveHtmlSubject.timelineTimeExact
      && frame.projectiveHtmlSubject.quadChanged
      && !frame.projectiveHtmlSubject.beforeQuadIsExactParallelogram
      && !frame.projectiveHtmlSubject.afterQuadIsExactParallelogram)).toBe(true);
    expect(report.native.frames.every((frame) => frame.transformedSvgSubject.timelineTimeChanged
      && frame.transformedSvgSubject.quadChanged)).toBe(true);
    expect(report.native.frames.every((frame) => frame.heldEffects.sourceTimelineChanged
      && frame.heldEffects.animationTimesExact
      && frame.heldEffects.effectProgressExact
      && frame.heldEffects.computedStylesExact)).toBe(true);

    expect(report.native.captureBoundary.progressTimelineRejected).toBe(true);
    expect(report.native.captureBoundary.rafMutatedDuringCaptureSettle).toBe(true);
    expect(report.native.captureBoundary.shadowOnlyStrictAccepted).toBe(true);
    expect(report.clocks.benignPreNavigation.targets.distinctOopifTargets).toBe(true);
    expect(report.clocks.benignPreNavigation.targetLocalTimesExact).toBe(true);
    expect(report.clocks.benignPreNavigation.countersFrozen).toBe(true);
    expect(report.clocks.preNavigationEscapes.exposedNativeCallbacksAdvanced).toBe(true);
    expect(report.clocks.preNavigationEscapes.workerCallbacksAdvanced).toBe(true);
    expect(report.clocks.lateNativeEscape.exposedClocksFrozen).toBe(true);
    expect(report.clocks.lateNativeEscape.savedNativeCallbacksAdvanced).toBe(true);
    expect(Object.values(report.discriminators).every(Boolean)).toBe(true);
  }, 30_000);
});
