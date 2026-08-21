import fs from "node:fs";
import * as fontkit from "fontkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LINUX_VEDIC_DOTTED_CIRCLE_RECORDS } from "../review/linux-unicode-evidence.js";
import { hbSubsetRetainGids } from "./hb-subset.js";
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
} from "./text-run-provenance.js";

const FREE_SERIF = "/usr/share/fonts/truetype/freefont/FreeSerif.ttf";
const FAMILY = '"Mukta", "Arial Unicode MS", "Apple Symbols", "Apple Color Emoji", "Noto Sans", "Noto Serif", sans-serif';
const itLinux = process.platform === "linux" && fs.existsSync(FREE_SERIF) ? it : it.skip;

function compactGlyphs(run: ReturnType<typeof getTextRunProvenance>["runs"][number]) {
  return run.glyphs.map(({ id, cluster, xAdvance, yAdvance, xOffset, yOffset }) =>
    ({ id, cluster, xAdvance, yAdvance, xOffset, yOffset }));
}

describe("Linux Vedic selected-face dotted circles", () => {
  let noCircleSubset: Buffer;

  const render = (text: string, fontFamily = FAMILY, clusterFallback = true) => {
    clearEmbeddedFonts();
    resetTextRunProvenance();
    if (clusterFallback) delete process.env.DOMOTION_CLUSTER_FALLBACK;
    else process.env.DOMOTION_CLUSTER_FALLBACK = "0";
    expect(renderTextAsPath(text, 0, 0, {
      fontSize: 32,
      fontFamily,
      fontWeight: "400",
      fill: "#000",
      dottedCircleMarks: [],
      xOffsets: Array.from({ length: text.length }, (_, index) => index * 20),
      features: ["chws"],
      lang: "en",
    })).not.toBeNull();
    const evidence = getTextRunProvenance();
    expect(evidence.runs).toHaveLength(1);
    return evidence.runs[0];
  };

  beforeAll(() => {
    if (!fs.existsSync(FREE_SERIF)) return;
    const face = fontkit.openSync(FREE_SERIF);
    noCircleSubset = hbSubsetRetainGids(fs.readFileSync(FREE_SERIF), [0, face.glyphForCodePoint(0x1CD1).id], 0, true, null);
  });
  beforeEach(() => {
    clearWebfonts();
    setRenderTextMode("embedded-font");
    setTextRunProvenanceEnabled(true);
  });
  afterEach(() => {
    delete process.env.DOMOTION_CLUSTER_FALLBACK;
    setTextRunProvenanceEnabled(false);
    setRenderTextMode("paths");
    clearWebfonts();
  });
  afterAll(() => { delete process.env.DOMOTION_CLUSTER_FALLBACK; });

  itLinux("pins the 14 exact FreeSans/FreeSerif glyph streams from the visual fixture", () => {
    for (const expected of LINUX_VEDIC_DOTTED_CIRCLE_RECORDS) {
      const run = render(String.fromCodePoint(expected.codepoint));
      expect(run, `U+${expected.codepoint.toString(16).toUpperCase()}`).toMatchObject({
        mechanism: "dotted-circle-pin",
        request: { script: expected.script, direction: "ltr" },
        selected: { postscriptName: expected.postscriptName, sourcePath: expected.sourcePath, faceIndex: 0, shapesWithHarfbuzz: true },
      });
      expect(compactGlyphs(run)).toEqual(expected.glyphs);
    }
  });

  itLinux("keeps a well-formed base+mark cluster free of an inserted U+25CC", () => {
    const run = render("\u0915\u1CD1", '"FreeSerif"');
    expect(run).toMatchObject({ mechanism: "declared-family", request: { script: "Deva" }, selected: { postscriptName: "FreeSerif", sourcePath: FREE_SERIF, faceIndex: 0 } });
    expect(compactGlyphs(run)).toEqual([
      { id: 1873, cluster: 0, xAdvance: 743, yAdvance: 0, xOffset: 0, yOffset: 0 },
      { id: 3402, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: -228, yOffset: 29 },
    ]);
  });

  itLinux("does not insert U+25CC when the selected face has no nominal circle glyph", () => {
    registerWebfont("DM2420 No Circle", 400, "normal", noCircleSubset);
    const run = render("\u1CD1", '"DM2420 No Circle"');
    expect(run).toMatchObject({ mechanism: "declared-family", request: { script: "Deva" }, selected: { fontKey: "webfont:dm2420 no circle", postscriptName: "FreeSerif" } });
    expect(compactGlyphs(run)).toEqual([
      { id: 3402, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 },
    ]);
  });

  itLinux("proves activation by removing the inserted base on the disabled cluster route", () => {
    expect(compactGlyphs(render("\u1CD1"))).toHaveLength(2);
    const disabled = render("\u1CD1", FAMILY, false);
    expect(disabled.mechanism).toBe("cluster-disabled-legacy");
    expect(compactGlyphs(disabled)).toEqual([
      { id: 3402, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 },
    ]);
  });
});
