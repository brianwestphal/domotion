import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  capturedScrollOwnerBindingSha256,
  sealCapturedFrameScrollState,
} from "../capture/frame-scroll-state.js";
import type {
  CapturedElement,
  CapturedFrameScrollRecord,
  CapturedFrameScrollState,
} from "../capture/types.js";
import { assertScrollFrameOwnership } from "./composer.js";
import type { ScrollSegmentCapture } from "./executor.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function owner(frameId: string, scrollLeft = 0, scrollTop = 0) {
  return {
    ownerId: `${frameId}:0`,
    frameId,
    elementIndex: 0,
    kind: "viewport" as const,
    tag: "html",
    direction: "ltr",
    writingMode: "horizontal-tb",
    scrollLeft,
    scrollTop,
    scrollWidth: 800,
    scrollHeight: 1200,
    clientWidth: 320,
    clientHeight: 240,
  };
}

function state(captureId: string, scrollY: number, allowlist = "inner.test"): CapturedFrameScrollState {
  const frames: CapturedFrameScrollRecord[] = [
    {
      frameId: "top",
      parentFrameId: null,
      origin: "https://outer.test",
      access: "top",
      allowlistMatched: false,
      readableFromParent: true,
      reachableFromTop: true,
      scrollOwners: [owner("top", 0, scrollY)],
    },
    {
      frameId: "child",
      parentFrameId: "top",
      origin: "https://inner.test",
      access: "cross-origin-allowlisted",
      allowlistMatched: true,
      readableFromParent: true,
      reachableFromTop: true,
      scrollOwners: [owner("child")],
    },
  ];
  return sealCapturedFrameScrollState({
    source: "chromium-cdp-frame-scroll-v1",
    captureId,
    topFrameId: "top",
    allowlist: { canonical: allowlist, sha256: digest(allowlist) },
    frames,
  });
}

function segment(authority: CapturedFrameScrollState, scrollY: number): ScrollSegmentCapture {
  const scrollOwnerId = "top:0";
  return {
    scrollX: 0,
    scrollY,
    segmentStartMs: scrollY,
    segmentEndMs: scrollY + 100,
    tree: [],
    diffFromPrev: null,
    frameScrollState: authority,
    scrollOwnerId,
    scrollOwnerBindingSha256: capturedScrollOwnerBindingSha256(authority, scrollOwnerId, 0, scrollY),
  };
}

describe("scroll composition frame authority (DM-2537)", () => {
  it("accepts fresh exact Chromium frame/owner records per segment", () => {
    expect(() => assertScrollFrameOwnership([
      segment(state("capture-a", 0), 0),
      segment(state("capture-b", 40), 40),
    ])).not.toThrow();
  });

  it("destructively rejects a sibling-frame owner substitution", () => {
    const authority = state("capture-a", 0);
    const mutated = segment(authority, 0);
    mutated.scrollOwnerId = "child:0";
    mutated.scrollOwnerBindingSha256 = capturedScrollOwnerBindingSha256(authority, "child:0", 0, 0);
    expect(() => assertScrollFrameOwnership([mutated])).toThrow(/top Chromium frame/);
  });

  it("destructively rejects a frame-local scrollbar assigned to the wrong frame", () => {
    const authority = state("capture-a", 0);
    const mutated = segment(authority, 0);
    mutated.tree = [{
      tag: "iframe",
      frameScrollIdentity: {
        source: "chromium-cdp-frame-scroll-v1",
        captureId: authority.captureId,
        frameId: "child",
        parentFrameId: "top",
        access: "cross-origin-allowlisted",
        allowlistSha256: authority.allowlist.sha256,
      },
      children: [{
        tag: "div",
        scrollbars: {
          owner: { frameId: "top", ownerId: "top:0" },
          horizontal: { currentPosition: 0 },
        },
        children: [],
      }],
    }] as unknown as CapturedElement[];
    expect(() => assertScrollFrameOwnership([mutated])).toThrow(/wrong Chromium frame/);
  });

  it("destructively rejects an omitted/changed allowlist between captures", () => {
    const first = segment(state("capture-a", 0), 0);
    const secondState = state("capture-b", 40, "inner.test,unused.test");
    const second = segment(secondState, 40);
    expect(() => assertScrollFrameOwnership([first, second])).toThrow(/allowlist/);
  });

  it("destructively rejects omitted frame/allowlist authority", () => {
    const omitted = segment(state("capture-a", 0), 0);
    delete omitted.frameScrollState;
    expect(() => assertScrollFrameOwnership([omitted])).toThrow(/omitted frame-scroll authority/);
  });

  it("rejects leaked capture-local state reused by another segment", () => {
    const authority = state("capture-a", 0);
    expect(() => assertScrollFrameOwnership([
      segment(authority, 0),
      segment(authority, 0),
    ])).toThrow(/reused capture-local frame state/);
  });

  it("rejects an offset mutation without resealing the source record", () => {
    const authority = state("capture-a", 0);
    authority.frames[0]!.scrollOwners[0]!.scrollTop = 9;
    expect(() => assertScrollFrameOwnership([segment(authority, 0)])).toThrow(/integrity mismatch/);
  });
});
