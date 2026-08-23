import { describe, expect, it } from "vitest";

import {
  REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS,
  TIMELINE_OWNERSHIP_SOURCE_PINS,
  validateTimelineOwnershipCorpus,
} from "../tools/timeline-sampling-ownership-oracle.js";

describe("DM-2531 timeline sampling ownership investigation corpus", () => {
  it("pins the browser ownership sources and all logical discriminators", () => {
    expect(validateTimelineOwnershipCorpus()).toEqual([]);
    expect(TIMELINE_OWNERSHIP_SOURCE_PINS.chromium).toBe("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(REQUIRED_TIMELINE_OWNERSHIP_DISCRIMINATORS).toEqual([
      "absolute-milliseconds-rejected",
      "transformed-scroller-does-not-retime-scroll-timeline",
      "projective-html-box-does-not-retime-view-timeline",
      "transformed-svg-subject-retimes-view-timeline",
      "percentage-hold-freezes-effect-not-source",
      "document-enumeration-misses-shadow-progress",
      "current-helper-rejects-enumerated-progress-but-raf-mutates",
      "pre-navigation-clock-freezes-benign-main-and-oopif-raf",
      "pre-navigation-clock-exposes-native-raf-escape",
      "pre-navigation-clock-does-not-own-worker-raf",
      "late-clock-cannot-own-saved-native-raf",
    ]);
  });
});
