import { describe, expect, it } from "vitest";
import type { CapturedElement } from "./types.js";
import { assembleCaptureDebugBundle, createCaptureDebugArtifacts } from "./debug-bundle.js";

const TREE = [{
  tagName: "DIV",
  children: [],
  rect: { x: 0, y: 0, width: 20, height: 10 },
}] as unknown as CapturedElement[];

describe("programmatic capture debug bundle", () => {
  it("snapshots PNG bytes and serializes the raw tree", () => {
    const source = new Uint8Array([137, 80, 78, 71]);
    const artifacts = createCaptureDebugArtifacts(source, TREE);
    source[0] = 0;

    expect(Array.from(artifacts.expectedPng)).toEqual([137, 80, 78, 71]);
    expect(JSON.parse(artifacts.capturedTreeJson)).toEqual(TREE);
    expect(artifacts.capturedTreeJson).toContain("\n  {");
  });

  it("assembles caller-rendered SVG and caller-recorded HAR without sharing buffers", () => {
    const artifacts = createCaptureDebugArtifacts(new Uint8Array([1, 2, 3]), TREE);
    const bundle = assembleCaptureDebugBundle(
      artifacts,
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      { captureHar: '{"log":{"entries":[]}}' },
    );
    artifacts.expectedPng[0] = 9;

    expect(Array.from(bundle.expectedPng)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(bundle.captureHar)).toBe('{"log":{"entries":[]}}');
    expect(bundle.actualSvg).toContain("<svg");
  });

  it("omits HAR when a caller did not arm its BrowserContext for recording", () => {
    const bundle = assembleCaptureDebugBundle(
      createCaptureDebugArtifacts(new Uint8Array([1]), TREE),
      "<svg/>",
    );
    expect(bundle.captureHar).toBeUndefined();
  });
});
