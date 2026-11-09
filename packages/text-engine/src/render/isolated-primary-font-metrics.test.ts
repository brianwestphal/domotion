import { describe, expect, it } from "vitest";
import type { FontInstance } from "./font-instance.js";
import { normalLineSpacing, parseVdmxStrike } from "./isolated-primary-font-metrics.js";

describe("Linux normal line spacing", () => {
  it("uses OS/2 typo metrics only when USE_TYPO_METRICS is selected", () => {
    const face = {
      unitsPerEm: 1000,
      ascent: 900,
      descent: -200,
      lineGap: 100,
      "OS/2": {
        version: 4,
        fsSelection: { useTypoMetrics: true },
        typoAscender: 700,
        typoDescender: -300,
        typoLineGap: 100,
      },
    } as unknown as FontInstance;
    expect(normalLineSpacing(face, 20, "linux")).toBe(22);
    expect(normalLineSpacing(face, 20, "darwin")).toBe(24);
  });

  it("reads the first matching 1:1 VDMX strike and ignores other sizes", () => {
    // Header, one ratio, one group offset, then a group with two strikes.
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 1);
    bytes.set([0, 1, 0, 1], 6);
    view.setUint16(10, 12);
    view.setUint16(12, 2);
    view.setUint16(14, 16);
    view.setUint16(16, 13);
    view.setInt16(18, 12);
    view.setInt16(20, -4);
    view.setUint16(22, 16);
    view.setInt16(24, 15);
    expect(parseVdmxStrike(bytes, 13)).toEqual([12, 4]);
    expect(parseVdmxStrike(bytes, 12)).toBeNull();
  });
});
