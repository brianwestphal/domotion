import { describe, expect, it } from "vitest";
import { StudioAnnotationError } from "./annotations.js";
import { StudioAuthoringError } from "./authoring.js";
import { StudioTimelineError } from "./timeline.js";
import { STALE_HEAD_CODE, assertHeadRevision, isStaleHeadError, staleHeadMessage } from "./stale-head.js";

describe("assertHeadRevision", () => {
  it("passes when the heads match or no precondition was supplied", () => {
    expect(() => assertHeadRevision("authoring", "r1", "r1", (m, c) => new StudioAuthoringError(m, c))).not.toThrow();
    expect(() =>
      assertHeadRevision("timeline", undefined, "r2", (m, c) => new StudioTimelineError(m, c)),
    ).not.toThrow();
    expect(() => assertHeadRevision("annotation", null, "r2", (m, c) => new StudioAnnotationError(m, c))).not.toThrow();
  });

  it("throws the caller's own class tagged with the stale-head code", () => {
    try {
      assertHeadRevision("annotation", "old", "new", (m, c) => new StudioAnnotationError(m, c));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StudioAnnotationError);
      expect((error as StudioAnnotationError).code).toBe(STALE_HEAD_CODE);
      expect((error as Error).message).toBe(staleHeadMessage("annotation", "old", "new"));
      expect(isStaleHeadError(error)).toBe(true);
    }
  });

  it("classifies by code, not by wording", () => {
    expect(isStaleHeadError(new StudioAuthoringError("stale authoring change: reworded"))).toBe(false);
    expect(isStaleHeadError(new StudioAuthoringError("anything at all", STALE_HEAD_CODE))).toBe(true);
    expect(isStaleHeadError("stale-head")).toBe(false);
    expect(isStaleHeadError(undefined)).toBe(false);
  });
});
