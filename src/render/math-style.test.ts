import { describe, expect, it } from "vitest";
import { radicalUsesDisplayStyle } from "./element-tree-to-svg.js";

describe("radical math-style selection", () => {
  it("uses the radical's computed inherited style across parent display contexts", () => {
    expect(radicalUsesDisplayStyle("normal", "inline math")).toBe(true);
    expect(radicalUsesDisplayStyle("normal", "block math")).toBe(true);
    expect(radicalUsesDisplayStyle("compact", "block math")).toBe(false);
    expect(radicalUsesDisplayStyle("compact", "inline math")).toBe(false);
  });

  it("retains the old parent-display rule for trees captured before math-style existed", () => {
    expect(radicalUsesDisplayStyle(undefined, "block math")).toBe(true);
    expect(radicalUsesDisplayStyle(undefined, "inline math")).toBe(false);
  });
});
