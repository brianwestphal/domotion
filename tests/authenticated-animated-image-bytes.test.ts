import { describe, expect, it } from "vitest";
import {
  AnimatedImageByteCollectorError,
  AUTHENTICATED_ANIMATED_IMAGE_BYTE_PROTOCOL,
  authenticatedAnimatedImageRecordDigest,
  verifyAuthenticatedAnimatedImageBytes,
  type AuthenticatedAnimatedImageByteRecord,
} from "../src/capture/authenticated-animated-image-bytes.js";

const bytes = Uint8Array.from([1, 2, 3, 4]);
const logical: Omit<AuthenticatedAnimatedImageByteRecord, "epochDigest"> = {
  protocol: AUTHENTICATED_ANIMATED_IMAGE_BYTE_PROTOCOL,
  selector: "#image", requestedFrameIndex: 2, ownerKind: "html-image", ownerSlot: "html-current",
  ownerSlotIndex: null, ownerSerializedValue: "https://example.test/image.gif",
  backendNodeId: 10, frameId: "frame", documentLoaderId: "loader", documentNonce: "nonce",
  selectedUrl: "https://example.test/image.gif", currentSrc: "https://example.test/image.gif",
  devicePixelRatio: 1, viewport: { width: 800, height: 600 }, requestId: "request",
  redirectHops: [], responseUrl: "https://example.test/image.gif", responseStatus: 200,
  mimeType: "image/gif", rawContentType: "image/gif", requestMode: "no-cors",
  credentialsMode: "include", transport: "network-get-response-body", byteLength: 4,
  sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
};

describe("authenticated animated-image exact comparator", () => {
  const record = (): AuthenticatedAnimatedImageByteRecord => ({
    ...structuredClone(logical), epochDigest: authenticatedAnimatedImageRecordDigest(logical),
  });

  it("accepts exact record and entity bytes", () => {
    expect(() => verifyAuthenticatedAnimatedImageBytes(record(), bytes)).not.toThrow();
  });

  it.each([
    ["logical drift", (value: AuthenticatedAnimatedImageByteRecord) => { value.responseStatus = 304; }, "response-drift"],
    ["length drift", (_value: AuthenticatedAnimatedImageByteRecord) => undefined, "body-length-mismatch", Uint8Array.from([1])],
    ["digest drift", (_value: AuthenticatedAnimatedImageByteRecord) => undefined, "body-digest-mismatch", Uint8Array.from([4, 3, 2, 1])],
  ])("rejects %s with a stable body-free reason", (_name, mutate, code, supplied = bytes) => {
    const candidate = record(); mutate(candidate);
    const error = (() => { try { verifyAuthenticatedAnimatedImageBytes(candidate, supplied); } catch (value) { return value; } })();
    expect(error).toBeInstanceOf(AnimatedImageByteCollectorError);
    expect((error as Error).message).toBe(code);
    expect((error as Error).message).not.toContain(logical.selectedUrl);
  });
});
