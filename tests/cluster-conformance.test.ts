import { describe, expect, it } from "vitest";
import type { ChromeFace, OurFace } from "../tools/font-conformance.js";
import { buildCells, judgeCell, reconciles, type OurRun } from "../tools/cluster-conformance.js";

const chrome = (postScriptName: string, glyphCount = 1): ChromeFace => ({
  familyName: postScriptName,
  postScriptName,
  glyphCount,
});

const ours = (postscriptName: string, key = postscriptName): OurFace => ({
  key,
  path: null,
  postscriptName,
  covered: true,
});

const run = (face: OurFace, text: string): OurRun => ({
  face,
  text,
  cpCount: [...text].length,
});

describe("cluster conformance reconciliation", () => {
  it("contains multi-codepoint divergence cases and controls", () => {
    const cells = buildCells();
    expect(cells.length).toBeGreaterThanOrEqual(8);
    expect(cells.every((cell) => [...cell.text].length > 1)).toBe(true);
    expect(cells.map((cell) => cell.id)).toEqual(
      expect.arrayContaining([
        "helvetica-x-udev-grave",
        "helvetica-thai-ko-acute",
        "arial-lam-u08F0",
        "menlo-alpha-ypogegrammeni",
      ]),
    );
    expect(cells.find((cell) => cell.id === "webfont-partial-conjunct-ksha")?.knownSkipReason).toBeUndefined();
  });

  it("accepts the same face and rejects an extra face on either side", () => {
    const cell = buildCells()[0]!;
    expect(judgeCell(cell, [chrome("Helvetica", 2)], [run(ours("Helvetica"), cell.text)]).verdict).toBe("agree");

    const extraOurs = judgeCell(cell, [chrome("Helvetica")], [
      run(ours("Helvetica"), "x"),
      run(ours("KohinoorDevanagari-Regular"), "॑"),
    ]);
    expect(extraOurs.verdict).toBe("mismatch");
    expect(extraOurs.unmatchedOurs).toEqual(["KohinoorDevanagari-Regular"]);

    const extraChrome = judgeCell(cell, [chrome("Helvetica"), chrome("Thonburi")], [run(ours("Helvetica"), cell.text)]);
    expect(extraChrome.verdict).toBe("mismatch");
    expect(extraChrome.unmatchedChrome).toEqual(["Thonburi"]);
  });

  it("reconciles a registered webfont with Chrome's custom-font face", () => {
    const custom: ChromeFace = { familyName: "DM Cluster Partial Deva", glyphCount: 2, isCustomFont: true };
    expect(reconciles(custom, ours("DM Cluster Partial Deva", "webfont:dm-cluster-partial-deva"), "DM Cluster Partial Deva")).toBe(true);
  });
});
