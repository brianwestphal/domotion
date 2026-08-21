import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEmbeddedFonts,
  clearGlyphDefs,
  getTextRunProvenance,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "./text-to-path.js";

const options = {
  fontSize: 24,
  fontFamily: "Helvetica, Arial, sans-serif",
  fontWeight: "400",
  fill: "#000",
};

describe("production text-run provenance", () => {
  beforeEach(() => {
    clearEmbeddedFonts();
    clearGlyphDefs();
    resetTextRunProvenance();
    setTextRunProvenanceEnabled(true);
    setRenderTextMode("paths");
  });
  afterEach(() => {
    setTextRunProvenanceEnabled(false);
    setRenderTextMode("paths");
    delete process.env.DOMOTION_CLUSTER_FALLBACK;
  });

  it("links a path-emitted run to its request, concrete source, shaping, and emitted identity", () => {
    expect(renderTextAsPath("AV", 0, 0, options)).not.toBeNull();
    const evidence = getTextRunProvenance();
    expect(evidence.transitions).toContainEqual({ kind: "paths-succeeded", sourceText: "AV" });
    expect(evidence.runs[0]).toMatchObject({
      emitter: "paths",
      sourceSpan: [0, 2],
      sourceCodepointSpan: [0, 2],
      emittedText: "AV",
      mechanism: "declared-family",
      request: { fontFamily: options.fontFamily, fontWeight: 400, fontSizePx: 24 },
      selected: { sourcePath: expect.any(String), faceIndex: expect.any(Number), shapesWithHarfbuzz: true },
      emittedIdentity: expect.stringMatching(/^paths:/),
      finalRepresentation: "svg-paths",
    });
    expect(evidence.runs[0].glyphs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(Number), cluster: expect.any(Number), xAdvance: expect.any(Number),
        sourceSpan: expect.any(Array), sourceCodepointSpan: expect.any(Array),
        sourceOutline: expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      }),
    ]));
  });

  it("records the embedded emitter and its transition independently", () => {
    setRenderTextMode("embedded-font");
    expect(renderTextAsPath("Hello", 0, 0, options)).not.toBeNull();
    const evidence = getTextRunProvenance();
    expect(evidence.runs.some((run) => run.emitter === "embedded-font")).toBe(true);
    expect(evidence.transitions).toContainEqual({ kind: "embedded-succeeded", sourceText: "Hello" });
  });

  it("proves the legacy assignment mechanism moves when cluster fallback is disabled", () => {
    process.env.DOMOTION_CLUSTER_FALLBACK = "0";
    expect(renderTextAsPath("AV", 0, 0, options)).not.toBeNull();
    expect(getTextRunProvenance().runs.map((run) => run.mechanism)).toContain("cluster-disabled-legacy");
  });
});
