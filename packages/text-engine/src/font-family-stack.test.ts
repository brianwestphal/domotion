import { describe, expect, it } from "vitest";

import {
  blinkGenericFamilyFromEntries,
  captureFontFamilyStack,
  parseCssFontFamilyEntries,
  serializeCapturedFontFamilyStack,
} from "./font-family-stack.js";

// The captured-owner and form-control emitter cases for the same stack record
// live in the root `src/font-family-stack.test.ts`, which owns those renderers.
describe("DM-2518 structured Blink font-family stack", () => {
  it("parses quoted commas, escaped names, and CSS hex escapes without changing node identity", () => {
    expect(parseCssFontFamilyEntries('"ACME, Sans", Escaped\\,Name, M\\65 nlo, serif')).toEqual([
      { name: "ACME, Sans", type: "family-name", quoted: true },
      { name: "Escaped,Name", type: "family-name", quoted: false },
      { name: "Menlo", type: "family-name", quoted: false },
      { name: "serif", type: "generic-family", quoted: false },
    ]);
  });

  it("keeps quoted generic-looking literals distinct from generic nodes", () => {
    expect(parseCssFontFamilyEntries('"monospace", monospace, "system-ui", system-ui')).toEqual([
      { name: "monospace", type: "family-name", quoted: true },
      { name: "monospace", type: "generic-family", quoted: false },
      { name: "system-ui", type: "family-name", quoted: true },
      { name: "system-ui", type: "generic-family", quoted: false },
    ]);
  });

  it("derives the rightmost legacy generic while system-ui and math remain non-occupying", () => {
    const stack = captureFontFamilyStack("monospace, system-ui, math, serif");
    expect(stack.genericFamily).toBe("serif");
    expect(blinkGenericFamilyFromEntries(captureFontFamilyStack("serif, system-ui, math").entries)).toBe("serif");
    expect(captureFontFamilyStack("system-ui, math").genericFamily).toBe("none");
  });

  it("represents Blink kStandardFamily as a generic sentinel instead of fitting a concrete name", () => {
    expect(captureFontFamilyStack("Times", true)).toEqual({
      source: "blink-font-family-stack-v1",
      entries: [{ name: "-webkit-standard", type: "generic-family" }],
      genericFamily: "standard",
    });
  });

  it("serializes literals unambiguously and round-trips their decoded names", () => {
    const stack = captureFontFamilyStack('"A, B", Escaped\\,Name, "monospace", serif');
    const css = serializeCapturedFontFamilyStack(stack);
    expect(css).toBe('"A, B", "Escaped,Name", "monospace", serif');
    expect(captureFontFamilyStack(css)).toEqual(stack);
  });
});
