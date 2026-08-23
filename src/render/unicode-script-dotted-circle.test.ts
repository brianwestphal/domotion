import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fontkit from "fontkit";
import { harfbuzzShapeRun } from "./harfbuzz-shaper.js";
import { hbSubsetRetainGids } from "./hb-subset.js";
import { isIcuHelperAvailable } from "./icu-helper.js";
import {
  clearEmbeddedFonts,
  clearWebfonts,
  registerWebfont,
  renderTextAsPath,
  setRenderTextMode,
} from "./text-to-path.js";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
  type TextRunProvenanceDiagnostic,
} from "./text-run-provenance.js";

/**
 * DM-2522's browser oracle face. The stock macOS file is the exact face CDP
 * reported for the four representative count mismatches. Registering its
 * bytes as a webfont isolates the itemization + shaping decision from the
 * machine's declared-family availability while retaining the original gids.
 */
const ARIAL_UNICODE = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
const HAVE_ORACLE_FACE = existsSync(ARIAL_UNICODE) && isIcuHelperAvailable();
const FAMILY = "DM2522 Arial Unicode";
const NO_CIRCLE_FAMILY = "DM2522 Arial Unicode No Circle";

const CASES = [
  { cp: 0x16120, script: "Gukh", ids: [4285, 0], width: 2 },
  // The ticket text transposed this as U+1D77; run 32626096295 contains U+1CF7.
  { cp: 0x1CF7, script: "Beng", ids: [4285, 0], width: 1 },
  { cp: 0x113C8, script: "Tutg", ids: [0, 4285], width: 2 },
  { cp: 0x11930, script: "Diak", ids: [4285, 0], width: 2 },
  { cp: 0x11941, script: "Diak", ids: [4285, 0], width: 2 },
] as const;

interface ExactLogicalGlyph {
  id: number;
  cluster: number;
  sourceSpan: [number, number];
  sourceCodepointSpan: [number, number];
}

function exactGlyphs(glyphs: TextRunProvenanceDiagnostic["glyphs"]): ExactLogicalGlyph[] {
  return glyphs.map(({ id, cluster, sourceSpan, sourceCodepointSpan }) => ({
    id, cluster, sourceSpan, sourceCodepointSpan,
  }));
}

function expectedGlyphs(ids: readonly number[], width: number): ExactLogicalGlyph[] {
  return ids.map((id) => ({
    id,
    cluster: 0,
    sourceSpan: [0, width],
    sourceCodepointSpan: [0, 1],
  }));
}

function renderRecord(cp: number, family = FAMILY): TextRunProvenanceDiagnostic {
  const text = String.fromCodePoint(cp);
  resetTextRunProvenance();
  const markup = renderTextAsPath(text, 0, 64, {
    fontSize: 32,
    fontFamily: `"${family}"`,
    fontWeight: "400",
    fontStyle: "normal",
    fill: "#000",
    // An empty capture answer vetoes the legacy synthetic prepass. This test
    // owns the selected-face HarfBuzz result, exactly like the logical oracle.
    dottedCircleMarks: [],
    xOffsets: [0],
  });
  expect(markup).not.toBeNull();
  const runs = getTextRunProvenance().runs.filter((run) => run.emitter === "paths");
  expect(runs).toHaveLength(1);
  return runs[0];
}

(HAVE_ORACLE_FACE ? describe : describe.skip)("pinned-ICU dotted-circle logical records (DM-2522)", () => {
  let bytes: Buffer;
  let noCircleBytes: Buffer;

  beforeAll(() => {
    bytes = readFileSync(ARIAL_UNICODE);
    const face = fontkit.openSync(ARIAL_UNICODE);
    expect(face.glyphForCodePoint(0x25CC).id).toBe(4285);
    // Keep one ordinary cmap entry so fontkit can open the mutation face, but
    // remove U+25CC. `retain_gids=true` preserves every surviving gid number.
    noCircleBytes = hbSubsetRetainGids(bytes, [0, face.glyphForCodePoint(0x41).id], 0, true, null);
  });

  beforeEach(() => {
    clearEmbeddedFonts();
    clearWebfonts();
    registerWebfont(FAMILY, 400, "normal", bytes);
    registerWebfont(NO_CIRCLE_FAMILY, 400, "normal", noCircleBytes);
    setRenderTextMode("paths");
    setTextRunProvenanceEnabled(true);
    resetTextRunProvenance();
  });

  afterAll(() => {
    setTextRunProvenanceEnabled(false);
    resetTextRunProvenance();
    clearEmbeddedFonts();
    clearWebfonts();
  });

  it.each(CASES)("emits exact gid/cluster/source spans for U+$cp", ({ cp, script, ids, width }) => {
    const run = renderRecord(cp);
    const expected = expectedGlyphs(ids, width);
    const actual = exactGlyphs(run.glyphs);
    expect(run).toMatchObject({
      sourceText: String.fromCodePoint(cp),
      sourceSpan: [0, width],
      sourceCodepointSpan: [0, 1],
      mechanism: "first-candidate-notdef",
      request: { script, direction: "ltr" },
      selected: { shapesWithHarfbuzz: true },
    });
    expect(actual).toEqual(expected);

    // Negative controls prove the oracle is sensitive to each logical field,
    // rather than merely reasserting the two-glyph count from CDP.
    const gidMutation = structuredClone(actual);
    gidMutation[0].id = gidMutation[0].id === 0 ? 1 : 0;
    expect(gidMutation).not.toEqual(expected);
    const clusterMutation = structuredClone(actual);
    clusterMutation[0].cluster = 1;
    expect(clusterMutation).not.toEqual(expected);
    const spanMutation = structuredClone(actual);
    spanMutation[0].sourceSpan = [0, width === 1 ? 2 : 1];
    expect(spanMutation).not.toEqual(expected);
  });

  it.each(CASES)("loses the inserted glyph under the stale Zyyy-script mutation for U+$cp", ({ cp, ids, width }) => {
    const text = String.fromCodePoint(cp);
    const mutated = harfbuzzShapeRun(ARIAL_UNICODE, 0, text, "ltr", 32, null, undefined, { script: "Zyyy" });
    expect(mutated).not.toBeNull();
    const logical = mutated!.glyphs.map((glyph, index) => ({
      id: glyph.id,
      cluster: mutated!.clusters[index],
      sourceSpan: [0, width] as [number, number],
      sourceCodepointSpan: [0, 1] as [number, number],
    }));
    expect(logical).toEqual(expectedGlyphs([0], width));
    expect(logical).not.toEqual(expectedGlyphs(ids, width));
  });

  it.each(CASES)("loses the inserted glyph when the selected face has no nominal U+25CC for U+$cp", ({ cp, width }) => {
    const run = renderRecord(cp, NO_CIRCLE_FAMILY);
    expect(exactGlyphs(run.glyphs)).toEqual(expectedGlyphs([0], width));
  });
});
