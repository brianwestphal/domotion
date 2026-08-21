import { describe, expect, it } from "vitest";
import { POSITIVE_RECORDS, ZERO_DIFF_CONTROLS, classifyTerminalRaster, type TerminalRasterRecord } from "../tools/macos-terminal-raster-oracle.js";

const copy = (record: TerminalRasterRecord): TerminalRasterRecord => structuredClone(record);

describe("macOS terminal-raster evidence oracle", () => {
  it("classifies all seven positives and every exact-zero same-face control", () => {
    for (const record of [...POSITIVE_RECORDS, ...ZERO_DIFF_CONTROLS]) {
      expect(classifyTerminalRaster(record), record.id).toMatchObject({ classification: "terminal-raster-evidence" });
    }
  });

  it.each(["face", "gid", "cluster", "advance", "upem", "fontSize", "paint", "outline", "position"])("withholds when %s identity moves", (field) => {
    const r = copy(POSITIVE_RECORDS[0]);
    if (field === "face") r.face += "-other";
    if (field === "gid") r.glyphs[0].gid++;
    if (field === "cluster") r.glyphs[0].cluster++;
    if (field === "advance") r.glyphs[0].advance++;
    if (field === "upem") r.upem++;
    if (field === "fontSize") r.fontSizePx++;
    if (field === "paint") r.paint = "fill:#000;stroke:none";
    if (field === "outline") r.subsetOutline.maxCoordinateDelta = 0.01;
    if (field === "position") r.emittedPositionKey[0]++;
    expect(classifyTerminalRaster(r)).toMatchObject({ classification: "unclassified" });
  });

  it("does not use script or codepoint as an activation key", () => {
    const r = { ...copy(POSITIVE_RECORDS[0]), script: "Zzzz", codepoint: 0x41 };
    expect(classifyTerminalRaster(r)).toMatchObject({ classification: "terminal-raster-evidence" });
  });

  it("reports envelope violations without changing a visual threshold", () => {
    const edge = copy(POSITIVE_RECORDS[0]); edge.residual.maxEdgeDistance = 2;
    const area = copy(POSITIVE_RECORDS[0]); area.residual.area = 48;
    expect(classifyTerminalRaster(edge)).toMatchObject({ classification: "envelope-violation" });
    expect(classifyTerminalRaster(area)).toMatchObject({ classification: "envelope-violation" });
  });

  it("requires controls to remain exact-zero", () => {
    const r = copy(ZERO_DIFF_CONTROLS[0]); r.residual.area = 1;
    expect(classifyTerminalRaster(r)).toMatchObject({ classification: "envelope-violation" });
  });
});
