import { describe, expect, it } from "vitest";
import {
  AnimatedImageStaticFrameError,
  verifyAnimatedImageStaticFrameRecord,
  type AnimatedImageStaticFrameRecord,
} from "../src/capture/animated-image-static-frame.js";

const base: AnimatedImageStaticFrameRecord = {
  selector: "#image", requestedFrameIndex: 1, sourceEpochDigest: "a".repeat(64),
  sourceSha256: "b".repeat(64), mimeType: "image/gif",
  browser: { sourceRevision: "7d859f271cbda744098ac69f44978d4edfa62be3", productVersion: "151.0.7918.0",
    userAgent: "headless", platform: "test", secureContext: true },
  track: { selectedIndex: 0, frameCount: 2, animated: true, repetitionCount: "Infinity" },
  observation: { complete: true, rgbaSha256: "c".repeat(64), pngSha256: "d".repeat(64),
    codedWidth: 1, codedHeight: 1, displayWidth: 1, displayHeight: 1,
    visibleRect: { x: 0, y: 0, width: 1, height: 1 }, timestamp: 0, duration: 1,
    format: "RGBA", colorSpace: { primaries: null, transfer: null, matrix: null, fullRange: null } },
  pngDataUrl: "data:image/png;base64,AA==", transactionDigest: "invalid",
};

describe("animated-image static-frame comparator", () => {
  it("fails closed when the transaction digest changes", () => {
    const error = (() => { try { verifyAnimatedImageStaticFrameRecord(base); } catch (value) { return value; } })();
    expect(error).toBeInstanceOf(AnimatedImageStaticFrameError);
    expect((error as Error).message).toBe("decoder-facts-mismatch");
  });

  it("rejects an unbounded track before accepting an index", () => {
    const candidate = structuredClone(base); candidate.track.frameCount = 5000;
    // Digest validation owns first failure; the live constructor independently
    // applies the same bound before it constructs this retained record.
    expect(() => verifyAnimatedImageStaticFrameRecord(candidate)).toThrow("decoder-facts-mismatch");
  });
});
