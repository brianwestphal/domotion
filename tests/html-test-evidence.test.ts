import { afterEach, describe, expect, it } from "vitest";
import { setTextRunProvenanceEnabled, textRunProvenanceEnabled } from "@domotion/text-engine/testing";
import { parseTextEvidenceSelection, renderWithTextEvidence, shouldCollectTextEvidence } from "./html-test/evidence.js";

afterEach(() => setTextRunProvenanceEnabled(false));

describe("HTML text evidence scope", () => {
  it("parses an explicit fixture and Unicode interval", () => {
    expect(parseTextEvidenceSelection("block.111:270ef-270f4")).toEqual({
      fixture: "block.111",
      lo: 0x270ef,
      hi: 0x270f4,
    });
    expect(() => parseTextEvidenceSelection("block.111:270f4-270ef")).toThrow(/range/);
    expect(() => parseTextEvidenceSelection("block.111")).toThrow(/Invalid/);
    expect(shouldCollectTextEvidence("block.111", parseTextEvidenceSelection("block.111:270ef-270f4"), "darwin")).toBe(
      true,
    );
    expect(shouldCollectTextEvidence("other", parseTextEvidenceSelection("block.111:270ef-270f4"), "darwin")).toBe(
      false,
    );
  });

  it("restores the previous provenance flag after a render throws", () => {
    const selection = parseTextEvidenceSelection("fixture:0041-005a");
    setTextRunProvenanceEnabled(false);
    expect(() =>
      renderWithTextEvidence(
        "fixture",
        () => {
          expect(textRunProvenanceEnabled()).toBe(true);
          throw new Error("render");
        },
        selection,
        "darwin",
      ),
    ).toThrow("render");
    expect(textRunProvenanceEnabled()).toBe(false);
    setTextRunProvenanceEnabled(true);
    expect(renderWithTextEvidence("fixture", () => "svg", selection, "darwin").result).toBe("svg");
    expect(textRunProvenanceEnabled()).toBe(true);
  });
});
