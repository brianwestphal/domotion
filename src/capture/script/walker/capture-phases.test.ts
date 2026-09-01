// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { CAPTURE_SCRIPT } from "../../script.generated.js";
import {
  assembleCaptureResultPhase,
  captureGeometryStylePhase,
  captureTraversalPhase,
  normalizePseudoShadowPhase,
} from "./capture-phases.js";

const viewport = { x: 0, y: 0, width: 100, height: 100 };
const rect = { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 };

function element(tag = "div") {
  const node = document.createElement(tag);
  Object.defineProperty(node, "getBoundingClientRect", { value: () => ({ ...rect }) });
  return node;
}

function geometry(node: Element, style: Record<string, unknown> = {}) {
  return captureGeometryStylePhase({
    el: node,
    cs: {
      display: "block",
      visibility: "visible",
      borderCollapse: "separate",
      contentVisibility: "visible",
      clip: "auto",
      clipPath: "none",
      overflow: "visible",
      overflowX: "visible",
      overflowY: "visible",
      position: "static",
      ...style,
    },
    rect,
    vp: viewport,
    fixedAncestors: new Set(),
    transformInfluenced: new Set(),
    animInfluenced: new Set(),
    isOutsideCaptureViewport: () => false,
  });
}

describe("in-page capture phase boundaries (DM-2639)", () => {
  it("keeps the four phases in the self-contained browser bundle and call order", () => {
    const geometryIndex = CAPTURE_SCRIPT.lastIndexOf("captureGeometryStylePhase({");
    const pseudoIndex = CAPTURE_SCRIPT.lastIndexOf("normalizePseudoShadowPhase({");
    const traversalIndex = CAPTURE_SCRIPT.lastIndexOf("captureTraversalPhase({");
    const assemblyIndex = CAPTURE_SCRIPT.lastIndexOf("assembleCaptureResultPhase({");
    expect(geometryIndex).toBeGreaterThan(0);
    expect(pseudoIndex).toBeGreaterThan(geometryIndex);
    expect(traversalIndex).toBeGreaterThan(pseudoIndex);
    expect(assemblyIndex).toBeGreaterThan(traversalIndex);
  });

  it("admits geometry/style independently and rejects visibility mutations", () => {
    const first = geometry(element());
    const second = geometry(element());
    expect(first).toMatchObject({ tag: "div", bordersOnlyCell: false, contentVisibilityHidden: false });
    expect(second).not.toBe(first);
    expect(geometry(element(), { display: "none" })).toBeNull();
    expect(geometry(element(), { visibility: "hidden" })).toBeNull();
    expect(geometry(element("td"), { visibility: "hidden", borderCollapse: "collapse" }))
      .toMatchObject({ tag: "td", bordersOnlyCell: true });
  });

  it("normalizes pseudo and closed-shadow facts without sharing a session", () => {
    const owner = element("input");
    const button = element("button");
    button.style.display = "block";
    button.style.visibility = "visible";
    button.style.opacity = "1";
    document.body.append(button);
    const firstFacts: Array<{ pseudo: string; typography: { fontFamily: string; fontFamilyStack?: unknown[] } }> = [
      { pseudo: "::before", typography: { fontFamily: "A" } },
    ];
    const secondFacts: Array<{ pseudo: string; typography: { fontFamily: string; fontFamilyStack?: unknown[] } }> = [
      { pseudo: "::after", typography: { fontFamily: "B" } },
    ];
    const stack = vi.fn((_el, family, pseudo) => [family, pseudo]);
    const first = normalizePseudoShadowPhase({
      el: owner,
      pseudoFragmentFacts: firstFacts,
      fontFamilyStackFor: stack,
      nativeDecorationRefs: [{ kind: "file-selector-button", node: button, ownership: null }],
      nativeDecorationKinds: ["file-selector-button"],
    });
    const second = normalizePseudoShadowPhase({
      el: owner,
      pseudoFragmentFacts: secondFacts,
      fontFamilyStackFor: stack,
      nativeDecorationRefs: [],
      nativeDecorationKinds: [],
    });
    expect(firstFacts[0]!.typography.fontFamilyStack).toEqual(["A", "::before"]);
    expect(secondFacts[0]!.typography.fontFamilyStack).toEqual(["B", "::after"]);
    expect(first.nativeDecorationParts).toHaveLength(1);
    expect(first.nativeDecorationUnavailableReason).toContain("EffectiveAppearance");
    expect(second).toEqual({
      nativeDecorationParts: [],
      missingNativeDecorationKinds: [],
      nativeDecorationUnavailableReason: undefined,
    });
  });

  it("splices traversal overlays in paint order and isolates result arrays", () => {
    const parent = element();
    parent.append(element("span"));
    const makeCapture = () => vi.fn(() => ({
      id: "child",
      scrollMarkerGroup: { id: "marker" },
      _scrollMarkerGroupBefore: true,
      scrollButtons: [{ id: "button" }],
    }));
    const firstCapture = makeCapture();
    const first = captureTraversalPhase({ el: parent, tag: "div", contentVisibilityHidden: false, capture: firstCapture });
    const second = captureTraversalPhase({ el: parent, tag: "div", contentVisibilityHidden: true, capture: makeCapture() });
    expect(first.map((entry) => entry.id)).toEqual(["marker", "child", "button"]);
    expect(first[1]).not.toHaveProperty("scrollMarkerGroup");
    expect(first[1]).not.toHaveProperty("scrollButtons");
    expect(second).toEqual([]);
    expect(second).not.toBe(first);
  });

  it("assembles only the provided record and does not leak mutations to the next capture", () => {
    const makeCaptured = () => ({
      text: "visible",
      children: [{ id: "child" }],
      styles: { backgroundColor: "red", backgroundImage: "url(x)", overflowX: "visible", overflowY: "visible" },
      textSegments: [{}],
      imageSrc: "x",
      svgContent: "<svg/>",
      pseudoImages: [{}],
      elementRaster: {},
    });
    const dependencies = {
      detectInlineFragments: vi.fn(),
      iframeFrameAuthority: vi.fn(() => null),
      captureIframeRecursion: vi.fn(() => null),
      handleReplacedElement: vi.fn(),
      captureScrollMarkerGroup: vi.fn(() => undefined),
      captureScrollButtons: vi.fn(() => undefined),
    };
    const first = makeCaptured();
    const second = makeCaptured();
    assembleCaptureResultPhase({
      captured: first, el: element("td"), cs: {}, tag: "td", rect, vp: viewport,
      bordersOnlyCell: true, ...dependencies,
    });
    assembleCaptureResultPhase({
      captured: second, el: element(), cs: {}, tag: "div", rect, vp: viewport,
      bordersOnlyCell: false, ...dependencies,
    });
    expect(first).toMatchObject({ text: "", children: [], styles: { backgroundColor: "rgba(0, 0, 0, 0)" } });
    expect(first.imageSrc).toBeUndefined();
    expect(second).toMatchObject({ text: "visible", children: [{ id: "child" }], styles: { backgroundColor: "red" } });
  });
});
