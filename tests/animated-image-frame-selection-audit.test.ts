import { describe, expect, it } from "vitest";
import {
  adjudicateAnimatedImageFormat,
  type AnimatedImageFormatEvidence,
  type AnimatedImageFrameObservation,
} from "../tools/animated-image-frame-selection-audit.js";

function observation(index: number, rgbaSha256: string): AnimatedImageFrameObservation {
  const digest = rgbaSha256.repeat(64).slice(0, 64);
  return {
    requestedIndex: index,
    complete: true,
    rgbaSha256: digest,
    pngSha256: `${digest.slice(1)}${digest[0]}`,
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    timestamp: index * 100_000,
    duration: 100_000,
    format: "RGBA",
    colorSpace: { primaries: "bt709", transfer: "iec61966-2-1", matrix: "rgb", fullRange: true },
  };
}

function exactEvidence(): AnimatedImageFormatEvidence {
  const frame0 = () => observation(0, "a");
  const frame1 = () => observation(1, "b");
  return {
    format: "gif",
    mimeType: "image/gif",
    sourcePath: "third_party/blink/web_tests/external/wpt/images/red-green-animated.gif",
    sourceSha256: "a".repeat(64),
    sourceByteLength: 100,
    typeSupported: true,
    track: { frameCount: 2, animated: true, repetitionCount: "Infinity", selectedIndex: 0 },
    arms: [
      {
        role: "proposal",
        order: [0, 0, 1, 1],
        observations: [frame0(), frame0(), frame1(), frame1()],
      },
      {
        role: "validation",
        order: [1, 1, 0, 0],
        observations: [frame1(), frame1(), frame0(), frame0()],
      },
    ],
    outOfRange: { name: "RangeError", message: "outside range" },
  };
}

describe("animated-image frame selection adjudicator", () => {
  it("accepts exact same-frame identity across independent forward and reverse arms", () => {
    expect(adjudicateAnimatedImageFormat(exactEvidence())).toEqual([]);
  });

  it("rejects partial, inert, reordered, cache-dependent, and unbounded evidence", () => {
    const partial = structuredClone(exactEvidence());
    partial.arms[0].observations[0].complete = false;
    expect(adjudicateAnimatedImageFormat(partial)).toContain("gif/proposal: frame 0 was partial");

    const inert = structuredClone(exactEvidence());
    for (const arm of inert.arms) for (const frame of arm.observations) frame.rgbaSha256 = "same";
    expect(adjudicateAnimatedImageFormat(inert)).toContain("gif: frame-index activation control was inert");

    const reordered = structuredClone(exactEvidence());
    reordered.arms[1].order = [0, 0, 1, 1];
    expect(adjudicateAnimatedImageFormat(reordered)).toContain(
      "gif: validation order is not reverse same-frame pairs",
    );

    const cacheDependent = structuredClone(exactEvidence());
    cacheDependent.arms[1].observations[3].pngSha256 = "moved-after-reverse-decode";
    expect(adjudicateAnimatedImageFormat(cacheDependent)).toContain(
      "gif: frame 0 changed across same-frame/reverse-order controls",
    );

    const unbounded = structuredClone(exactEvidence());
    unbounded.track.frameCount = 9;
    unbounded.outOfRange.name = "none";
    expect(adjudicateAnimatedImageFormat(unbounded)).toEqual(expect.arrayContaining([
      "gif: frameCount 9 is outside bounded 2..8 corpus",
      "gif: out-of-range frame index did not reject with RangeError",
    ]));
  });

  it("rejects unauthenticated source, unsupported track, and malformed frame facts", () => {
    const malformed = structuredClone(exactEvidence());
    malformed.mimeType = "image/png";
    malformed.sourcePath = "unowned.gif";
    malformed.sourceSha256 = "not-a-digest";
    malformed.sourceByteLength = 0;
    malformed.typeSupported = false;
    malformed.track.animated = false;
    malformed.track.selectedIndex = 1;
    malformed.arms[0].observations[0].codedWidth = 0;
    malformed.arms[0].observations[0].timestamp = -1;
    malformed.arms[0].observations[0].visibleRect = null;
    expect(adjudicateAnimatedImageFormat(malformed)).toEqual(expect.arrayContaining([
      "gif: MIME type image/png does not match the format",
      "gif: pinned source path does not match the format",
      "gif: encoded source identity is incomplete",
      "gif: ImageDecoder type unsupported",
      "gif: selected track is not animated",
      "gif: preferAnimation selected unexpected track 1",
      "gif/proposal: frame 0 has invalid dimensions",
      "gif/proposal: frame 0 has invalid timing metadata",
      "gif/proposal: frame 0 has invalid visible rect",
    ]));
  });

  it("rejects missing control roles, observation reindexing, and incomplete arms", () => {
    const missingRole = structuredClone(exactEvidence());
    missingRole.arms[1].role = "proposal";
    expect(adjudicateAnimatedImageFormat(missingRole)).toContain(
      "gif: proposal/validation roles missing or reordered",
    );

    const moved = structuredClone(exactEvidence());
    moved.arms[0].observations[0].requestedIndex = 2;
    moved.arms[1].observations.pop();
    expect(adjudicateAnimatedImageFormat(moved)).toEqual(expect.arrayContaining([
      "gif/proposal: requested index moved at position 0",
      "gif/proposal: requested frame index is outside the selected track",
      "gif/validation: observation count does not match order",
    ]));
  });
});
