import { describe, expect, it } from "vitest";

import type { CapturedElement, CapturedPseudoFragmentSet } from "../capture/types.js";
import {
  pseudoFragmentPaintSlot,
  pseudoFragmentRecordErrors,
  renderPseudoFragmentRecord,
  renderPseudoFragmentSlot,
} from "./pseudo-fragments.js";

function record(pseudo: "::before" | "::after" = "::before"): CapturedPseudoFragmentSet {
  return {
    source: "blink-pseudo-fragment-v1",
    pseudo,
    status: "exact",
    writingMode: "horizontal-tb",
    direction: "ltr",
    boxDecorationBreak: "slice",
    edges: {
      border: { top: 1, right: 5, bottom: 3, left: 2 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    contentItems: [{ index: 0, kind: "text", layoutIndex: 1, text: "Hi" }],
    boxFragments: [{
      index: 0,
      localBorderRect: { x: 0, y: 0, width: 40, height: 20 },
      localContentRect: { x: 5, y: 2, width: 24, height: 16 },
      physicalQuad: [{ x: 90, y: 40 }, { x: 130, y: 40 }, { x: 130, y: 60 }, { x: 90, y: 60 }],
      physicalRect: { x: 90, y: 40, width: 40, height: 20 },
      edgeOwnership: { inlineStart: true, inlineEnd: true, blockStart: true, blockEnd: true },
      fragmentainerTranslation: { x: 90, y: 40 },
    }],
    fragments: [{
      kind: "text",
      contentItemIndex: 0,
      sourceStartUtf16: 0,
      sourceEndUtf16: 2,
      text: "Hi",
      visualOrder: 0,
      boxFragmentIndex: 0,
      localRect: { x: 5, y: 2, width: 24, height: 16 },
      physicalRect: { x: 95, y: 42, width: 24, height: 16 },
      physicalQuad: [{ x: 95, y: 42 }, { x: 119, y: 42 }, { x: 119, y: 58 }, { x: 95, y: 58 }],
      protocolInlineAdvance: 24,
      shapedInlineAdvance: 24,
      baseline: {
        origin: { x: 95, y: 54 },
        end: { x: 119, y: 54 },
        ascent: 12,
        source: "TextFragmentPainter.primary-font-ascent+writing-transform",
      },
    }],
    typography: {
      fontFamily: "Arial, sans-serif",
      fontSize: 16,
      paintFontSize: 16,
      fontWeight: "400",
      fontStyle: "normal",
      fontStretch: "100%",
      fontVariant: "normal",
      fontFeatureSettings: "normal",
      fontVariationSettings: "normal",
      fontKerning: "auto",
      lineHeight: 20,
      letterSpacing: "normal",
      wordSpacing: "0px",
      textOrientation: "mixed",
      whiteSpace: "normal",
      language: "en",
      effectiveZoom: 1,
      primaryFontAscent: 12,
      primaryFontDescent: 4,
      resolvedFonts: [],
    },
    paint: {
      visibility: "visible",
      position: "static",
      unicodeBidi: "normal",
      color: "rgb(1, 2, 3)",
      backgroundColor: "rgb(240, 230, 220)",
      backgroundImage: "none",
      backgroundPosition: "0% 0%",
      backgroundSize: "auto",
      backgroundRepeat: "repeat",
      borderTopColor: "red",
      borderRightColor: "green",
      borderBottomColor: "blue",
      borderLeftColor: "black",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderRadius: "2px",
      opacity: 1,
      filter: "none",
      transform: "none",
      transformOrigin: "20px 10px",
    },
  };
}

describe("DM-2468 direct generated-pseudo paint", () => {
  it("uses retained box transforms/baselines and never reads host text anchors", () => {
    const source = record();
    const first = renderPseudoFragmentSlot({ pseudoFragments: [source] }, "before").join("");
    const mutatedHost = {
      pseudoFragments: [source],
      textLeft: -99_999,
      textTop: 99_999,
      fontAscent: -500,
      textSegments: [{ text: "wrong", x: -1, y: -1, width: 1, height: 1 }],
    } as unknown as CapturedElement;
    const second = renderPseudoFragmentSlot(mutatedHost, "before").join("");
    expect(second).toBe(first);
    expect(first).toContain('data-domotion-pseudo-owner="source-fragments"');
    expect(first).toContain('transform="matrix(1 0 0 1 90 40)"');
    expect(first).toContain('transform="matrix(1 0 0 1 95 54)"');
  });

  it("honors source slots and never merges ::after into host-first paint", () => {
    const before = record("::before");
    const after = record("::after");
    expect(pseudoFragmentPaintSlot(before)).toBe("before");
    expect(pseudoFragmentPaintSlot(after)).toBe("after");
    after.paint.position = "absolute";
    expect(pseudoFragmentPaintSlot(after)).toBe("positioned");
    before.paint.zIndex = -2;
    expect(pseudoFragmentPaintSlot(before)).toBe("negative");
    after.paint.zIndex = 4;
    expect(pseudoFragmentPaintSlot(after)).toBe("positive");
  });

  it("fails closed for collapsed baselines/quads instead of reviving legacy anchors", () => {
    const collapsedBaseline = record();
    const text = collapsedBaseline.fragments[0];
    if (text.kind === "text") text.baseline.end = { ...text.baseline.origin };
    expect(pseudoFragmentRecordErrors(collapsedBaseline)).toContain("fragment 0 has a collapsed baseline");
    expect(renderPseudoFragmentRecord(collapsedBaseline)).toContain("data-domotion-pseudo-boundary");
    expect(renderPseudoFragmentRecord(collapsedBaseline)).not.toContain("source-fragments");

    const collapsedQuad = record();
    collapsedQuad.boxFragments[0].physicalQuad[1] = { ...collapsedQuad.boxFragments[0].physicalQuad[0] };
    expect(pseudoFragmentRecordErrors(collapsedQuad)).toContain("box 0 has collapsed/non-affine geometry");
  });

  it("uses per-fragment slice ownership and retained text/image visual order", () => {
    const source = record();
    source.boxDecorationBreak = "slice";
    source.boxFragments[0].edgeOwnership.inlineEnd = false;
    source.contentItems.push({ index: 1, kind: "image", layoutIndex: 2, resolvedUrl: "data:image/png;base64,AAAA" });
    source.fragments.push({
      kind: "image",
      contentItemIndex: 1,
      visualOrder: 1,
      boxFragmentIndex: 0,
      localRect: { x: 29, y: 4, width: 7, height: 7 },
      physicalRect: { x: 119, y: 44, width: 7, height: 7 },
      physicalQuad: [{ x: 119, y: 44 }, { x: 126, y: 44 }, { x: 126, y: 51 }, { x: 119, y: 51 }],
    });
    const markup = renderPseudoFragmentRecord(source, { imageHref: (url) => url });
    expect(markup).not.toContain('stroke="green"');
    expect(markup.indexOf('aria-label="Hi"')).toBeLessThan(markup.indexOf("<image"));
  });

  it("does not paint hidden/transparent records and stamps terminal rasters once", () => {
    const hidden = record();
    hidden.paint.visibility = "hidden";
    expect(renderPseudoFragmentRecord(hidden)).toBe("");
    const transparent = record();
    transparent.paint.opacity = 0;
    expect(renderPseudoFragmentRecord(transparent)).toBe("");
    const terminal = record();
    terminal.status = "terminal-raster";
    terminal.fragments = [];
    terminal.boxFragments = [];
    terminal.terminalRaster = {
      dataUri: "data:image/png;base64,AAAA",
      rect: { x: 7, y: 8, width: 9, height: 10 },
      isolated: true,
    };
    expect(renderPseudoFragmentRecord(terminal).match(/<image/g)).toHaveLength(1);
    expect(renderPseudoFragmentRecord(terminal)).toContain('data-domotion-pseudo-owner="chromium-raster"');
  });
});
