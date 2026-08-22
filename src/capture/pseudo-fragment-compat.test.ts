import { describe, expect, it } from "vitest";

import { projectPseudoFragmentCompatibility } from "./pseudo-fragment-compat.js";
import type { CapturedElement, CapturedPseudoFragmentSet } from "./types.js";

const record: CapturedPseudoFragmentSet = {
  source: "blink-pseudo-fragment-v1",
  pseudo: "::before",
  status: "exact",
  writingMode: "horizontal-tb",
  direction: "ltr",
  boxDecorationBreak: "slice",
  edges: {
    border: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  },
  contentItems: [{ index: 0, kind: "text", layoutIndex: 1, text: "pre" }],
  boxFragments: [{
    index: 0,
    physicalQuad: [{ x: 10, y: 20 }, { x: 34, y: 20 }, { x: 34, y: 36 }, { x: 10, y: 36 }],
    physicalRect: { x: 10, y: 20, width: 24, height: 16 },
    localContentRect: { x: 0, y: 0, width: 24, height: 16 },
    localBorderRect: { x: 0, y: 0, width: 24, height: 16 },
    edgeOwnership: { inlineStart: true, inlineEnd: true, blockStart: true, blockEnd: true },
    fragmentainerTranslation: { x: 10, y: 20 },
  }],
  fragments: [{
    kind: "text",
    contentItemIndex: 0,
    sourceStartUtf16: 0,
    sourceEndUtf16: 3,
    text: "pre",
    visualOrder: 0,
    boxFragmentIndex: 0,
    localRect: { x: 0, y: 0, width: 24, height: 16 },
    physicalRect: { x: 10, y: 20, width: 24, height: 16 },
    physicalQuad: [{ x: 10, y: 20 }, { x: 34, y: 20 }, { x: 34, y: 36 }, { x: 10, y: 36 }],
    protocolInlineAdvance: 24,
    shapedInlineAdvance: 23.5,
    baseline: { origin: { x: 10, y: 32 }, end: { x: 33.5, y: 32 }, ascent: 12, source: "TextFragmentPainter.primary-font-ascent+writing-transform" },
  }],
  typography: {
    fontFamily: "Arial", fontSize: 16, paintFontSize: 16, fontWeight: "400", fontStyle: "normal", fontStretch: "100%", fontVariant: "normal",
    fontFeatureSettings: "normal", fontVariationSettings: "normal", fontKerning: "auto", lineHeight: 24, letterSpacing: "normal", wordSpacing: "0px",
    textOrientation: "mixed", whiteSpace: "normal", language: "en", effectiveZoom: 1, primaryFontAscent: 12, primaryFontDescent: 4, resolvedFonts: [],
  },
  paint: {
    color: "rgb(1, 2, 3)", backgroundColor: "transparent", backgroundImage: "none", backgroundPosition: "0% 0%", backgroundSize: "auto",
    borderTopColor: "transparent", borderRightColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "transparent",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderRadius: "0px",
    opacity: 1, filter: "none", transform: "none", transformOrigin: "12px 8px",
  },
};

describe("DM-2467 legacy projection", () => {
  it("derives compatibility text/box fields only from the protocol record", () => {
    const element: CapturedElement = {
      tag: "div", text: "host", x: 0, y: 0, width: 100, height: 40, styles: {} as CapturedElement["styles"], children: [], pseudoFragments: [record],
    };
    projectPseudoFragmentCompatibility([element]);
    expect(element.text).toBe("prehost");
    expect(element.textSegments?.[0]).toMatchObject({ text: "pre", x: 10, y: 20, baseline: 32, shapedWidth: 23.5 });
    expect(element.pseudoBoxes?.[0]).toMatchObject({ pseudo: "::before", x: 10, y: 20, width: 24, height: 16 });
  });

  it("projects an isolated terminal surface without inventing vector geometry", () => {
    const terminal: CapturedPseudoFragmentSet = {
      ...record,
      status: "terminal-raster",
      reason: "ambiguous protocol rows",
      contentItems: [], boxFragments: [], fragments: [],
      terminalRaster: { dataUri: "data:image/png;base64,AA==", rect: { x: 4, y: 5, width: 6, height: 7 }, isolated: true },
    };
    const element: CapturedElement = { tag: "div", text: "", x: 0, y: 0, width: 1, height: 1, styles: {} as CapturedElement["styles"], children: [], pseudoFragments: [terminal] };
    projectPseudoFragmentCompatibility([element]);
    expect(element.textSegments).toBeUndefined();
    expect(element.pseudoBoxes).toBeUndefined();
    expect(element.pseudoImages).toEqual([{ url: "data:image/png;base64,AA==", x: 4, y: 5, width: 6, height: 7 }]);
  });
});
