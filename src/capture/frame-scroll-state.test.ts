import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CapturedFrameScrollRecord } from "./types.js";
import {
  frameIdentityUnavailableDiagnostic,
  retainIdentifiedFrameScrollRecords,
  sealCapturedFrameScrollState,
  validateCapturedFrameScrollState,
} from "./frame-scroll-state.js";

describe("frameIdentityUnavailableDiagnostic", () => {
  it("keeps the historical wording when nothing threw", () => {
    expect(frameIdentityUnavailableDiagnostic()).toBe(
      "frame identity could not be authenticated against Chromium's default execution context; retained the Chromium raster and read no frame scroll state",
    );
  });

  it("names the OOPIF handshake failure when there was one", () => {
    expect(frameIdentityUnavailableDiagnostic("attaching a CDP session to the frame failed: Target closed")).toBe(
      "frame identity could not be authenticated against Chromium's default execution context (attaching a CDP session to the frame failed: Target closed); retained the Chromium raster and read no frame scroll state",
    );
  });
});

describe("unidentified Chromium frame records", () => {
  it("keeps the authenticated graph and raster-only diagnostics without sealing empty ids", () => {
    const top: CapturedFrameScrollRecord = {
      frameId: "top",
      parentFrameId: null,
      origin: "https://example.test",
      access: "top",
      allowlistMatched: false,
      readableFromParent: true,
      reachableFromTop: true,
      scrollOwners: [
        {
          ownerId: "top:0",
          frameId: "top",
          elementIndex: 0,
          kind: "viewport",
          tag: "html",
          direction: "ltr",
          writingMode: "horizontal-tb",
          scrollLeft: 0,
          scrollTop: 0,
          scrollWidth: 320,
          scrollHeight: 800,
          clientWidth: 320,
          clientHeight: 240,
        },
      ],
    };
    const unidentified: CapturedFrameScrollRecord = {
      ...top,
      frameId: "",
      parentFrameId: "top",
      access: "identity-unavailable",
      readableFromParent: false,
      reachableFromTop: false,
      scrollOwners: [],
      diagnostic: "retained the Chromium raster and read no frame scroll state",
    };
    const identified = { ...unidentified, frameId: "known" };
    const orphan = { ...unidentified, frameId: "orphan", parentFrameId: null };
    const belowUnknown = { ...unidentified, frameId: "below-unknown", parentFrameId: "" };
    const raw = [top, unidentified, identified, orphan, belowUnknown];
    const retained = retainIdentifiedFrameScrollRecords(raw, "top");
    expect(retained.map(({ frameId }) => frameId)).toEqual(["top", "known"]);
    const seal = (frames: CapturedFrameScrollRecord[]) =>
      sealCapturedFrameScrollState({
        source: "chromium-cdp-frame-scroll-v1",
        captureId: "capture-a",
        topFrameId: "top",
        allowlist: { canonical: "", sha256: createHash("sha256").update("").digest("hex") },
        frames,
      });
    expect(validateCapturedFrameScrollState(seal(raw))).toContain("empty frame id");
    expect(validateCapturedFrameScrollState(seal(retained))).toEqual([]);
  });

  it("fails closed when the top frame has no authenticated id", () => {
    expect(() => retainIdentifiedFrameScrollRecords([], "")).toThrow(/top Chromium frame identity/);
  });
});
