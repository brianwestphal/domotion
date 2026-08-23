import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";
import { renderInputText, renderMultiSegmentText, renderSingleLineText } from "./text.js";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
} from "./text-run-provenance.js";

const dataUri = "data:image/png;base64,Y2FwdHVyZS1yYXN0ZXI=";
const styles = {
  backgroundColor: "transparent", backgroundImage: "none", borderWidth: "0", borderColor: "black",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderRadius: "0", color: "black", fontSize: "16px", fontFamily: "sans-serif",
  fontWeight: "400", fontStyle: "normal", opacity: "1", transform: "none",
  overflowX: "visible", overflowY: "visible", display: "block", position: "static",
  zIndex: "auto", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", boxShadow: "none",
} as unknown as CapturedElement["styles"];

describe("capture-owned text terminal provenance", () => {
  beforeEach(() => {
    resetTextRunProvenance();
    setTextRunProvenanceEnabled(true);
  });
  afterEach(() => setTextRunProvenanceEnabled(false));

  it("records an atomic subtree raster before the text emitters are bypassed", () => {
    const owner = {
      tag: "mi", text: "𝛼", x: 8, y: 12, width: 18, height: 22, styles, children: [],
      transformSubtreeRaster: { x: 8, y: 12, width: 18, height: 22, dataUri },
    } as CapturedElement;

    expect(elementTreeToSvg([owner], 64, 48)).toContain(dataUri);
    expect(getTextRunProvenance()).toEqual({
      runs: [],
      transitions: [{ kind: "capture-raster", sourceText: "𝛼", reason: "transform-subtree-raster" }],
    });
  });

  it("records a segment raster before the single-line text emitter is bypassed", () => {
    const element = {
      tag: "mi", text: "𝛼", x: 8, y: 12, width: 18, height: 22, styles,
      textSegments: [{
        text: "𝛼", x: 8, y: 12, width: 18, height: 22,
        rasterRect: { x: 8, y: 12, width: 18, height: 22 }, rasterDataUri: dataUri,
      }],
    } as CapturedElement;

    expect(renderSingleLineText({ el: element, idPrefix: "dm2511", clipId: "dm2511-clip", fillColor: "black" })).toContain(dataUri);
    expect(getTextRunProvenance()).toEqual({
      runs: [],
      transitions: [{ kind: "capture-raster", sourceText: "𝛼", reason: "text-segment-raster" }],
    });
  });

  it("records a segment raster before the multi-segment text emitter is bypassed", () => {
    const segment = {
      text: "𝛼", x: 8, y: 12, width: 18, height: 22,
      rasterRect: { x: 8, y: 12, width: 18, height: 22 }, rasterDataUri: dataUri,
    };
    const element = {
      tag: "mi", text: "𝛼", x: 8, y: 12, width: 18, height: 22, styles,
      textSegments: [segment],
    } as CapturedElement;

    expect(renderMultiSegmentText({ el: element, idPrefix: "dm2511", clipId: "dm2511-clip", fillColor: "black" }, [segment])).toContain(dataUri);
    expect(getTextRunProvenance().transitions).toEqual([
      { kind: "capture-raster", sourceText: "𝛼", reason: "text-segment-raster" },
    ]);
  });

  it("records a legacy element raster before input text emission is bypassed", () => {
    const element = {
      tag: "input", text: "𝛼", x: 8, y: 12, width: 18, height: 22, styles,
      elementRaster: { x: 8, y: 12, width: 18, height: 22, dataUri },
    } as CapturedElement;

    expect(renderInputText({ el: element, idPrefix: "dm2511", clipId: "dm2511-clip", fillColor: "black" })).toContain(dataUri);
    expect(getTextRunProvenance().transitions).toEqual([
      { kind: "capture-raster", sourceText: "𝛼", reason: "element-raster" },
    ]);
  });
});
