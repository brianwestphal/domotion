import { describe, expect, it } from "vitest";
import { browserControlMovement, joinShapingEvidence, type ExactRecord } from "../tools/unified-shaping-oracle.js";

const record: ExactRecord = {
  environment: { platform: "test" },
  face: { key: "face", path: "/font.ttf", member: 0, postscriptName: "Face-Regular", localPostscriptName: "Face-Regular", namedInstance: null, axes: { wght: 400 } },
  input: { text: "fi", utf16Span: [0, 2], direction: "ltr", fontSizePx: 16, script: "Latn", language: "en", features: ["liga"], bufferFlags: 3, clusterLevel: 1 },
  fallbackRuns: [{ utf16Span: [0, 2], face: "/font.ttf#0" }],
  glyphs: [{ id: 12, cluster: 0, sourceSpan: [0, 2], xAdvance: 10, yAdvance: 0, xOffset: 1, yOffset: 2, flags: 0, unsafeToBreak: false }],
};

describe("unified shaping evidence", () => {
  it("joins every required face, glyph, cluster, metric, input, and painted-origin field", () => {
    const joined = joinShapingEvidence(
      record,
      [{ familyName: "Face", postScriptName: "Face-Regular", glyphCount: 1, isCustomFont: false }],
      [{ utf16Span: [0, 1], left: 4, top: 5, right: 8, bottom: 12 }],
    );
    expect(joined).toMatchObject({
      input: { direction: "ltr", features: ["liga"] },
      chrome: { paintedFaces: [{ postScriptName: "Face-Regular" }], paintedOrigins: [{ left: 4 }], glyphIds: { status: "not-exposed-by-cdp" } },
      helper: { path: "/font.ttf", member: 0, axes: { wght: 400 }, fallbackRuns: [{ utf16Span: [0, 2] }] },
      glyphs: [{ id: 12, cluster: 0, xAdvance: 10, xOffset: 1, yOffset: 2 }],
      comparison: { faceAgreement: true, glyphIds: "source-equivalent-same-face" },
    });
  });

  it("keeps CSS-unaddressable protected faces visibly non-equivalent", () => {
    const joined = joinShapingEvidence(
      record,
      [{ familyName: "Fallback", postScriptName: "Fallback-Regular", glyphCount: 2, isCustomFont: false }],
      [{ utf16Span: [0, 1], left: 4, top: 5, right: 8, bottom: 12 }],
      "css-unaddressable-after-candidate-walk",
    );
    expect(joined).toMatchObject({
      comparison: {
        faceAgreement: false,
        faceObservation: "css-unaddressable-after-candidate-walk",
        glyphIds: "not-compared-across-different-faces",
      },
    });
  });

  it("requires each browser instrument's discriminator to move independently", () => {
    const base = [{ left: 0, top: 0, right: 10, bottom: 10 }];
    expect(browserControlMovement({ base, face: [{ ...base[0], right: 11 }], direction: base, paintedOrigins: [{ ...base[0], left: 20 }] }))
      .toEqual({ face: true, direction: false, paintedOrigins: true });
  });
});
