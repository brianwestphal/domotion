import { describe, expect, it } from "vitest";

import type { CapturedElement, TextSegment } from "./capture/types.js";
import {
  blinkGenericFamilyFromEntries,
  captureFontFamilyStack,
  capturedFontFamilyCss,
  parseCssFontFamilyEntries,
  serializeCapturedFontFamilyStack,
} from "./font-family-stack.js";
import { capturedElementFontFamily, capturedSegmentFontFamily } from "./render/text.js";
import { renderFormControl } from "./render/form-controls.js";

describe("DM-2518 structured Blink font-family stack", () => {
  it("parses quoted commas, escaped names, and CSS hex escapes without changing node identity", () => {
    expect(parseCssFontFamilyEntries('"ACME, Sans", Escaped\\,Name, M\\65 nlo, serif'))
      .toEqual([
        { name: "ACME, Sans", type: "family-name", quoted: true },
        { name: "Escaped,Name", type: "family-name", quoted: false },
        { name: "Menlo", type: "family-name", quoted: false },
        { name: "serif", type: "generic-family", quoted: false },
      ]);
  });

  it("keeps quoted generic-looking literals distinct from generic nodes", () => {
    expect(parseCssFontFamilyEntries('"monospace", monospace, "system-ui", system-ui'))
      .toEqual([
        { name: "monospace", type: "family-name", quoted: true },
        { name: "monospace", type: "generic-family", quoted: false },
        { name: "system-ui", type: "family-name", quoted: true },
        { name: "system-ui", type: "generic-family", quoted: false },
      ]);
  });

  it("derives the rightmost legacy generic while system-ui and math remain non-occupying", () => {
    const stack = captureFontFamilyStack("monospace, system-ui, math, serif");
    expect(stack.genericFamily).toBe("serif");
    expect(blinkGenericFamilyFromEntries(captureFontFamilyStack("serif, system-ui, math").entries))
      .toBe("serif");
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

  it("routes every captured owner from the structured record under hostile raw-string mutations", () => {
    const stack = captureFontFamilyStack('"monospace", Georgia, serif');
    const expected = '"monospace", "Georgia", serif';
    const element = {
      styles: { fontFamily: "HOSTILE-ELEMENT", fontFamilyStack: stack },
    } as unknown as CapturedElement;
    const owners: TextSegment[] = [
      { text: "ordinary", x: 0, y: 0, width: 1, height: 1 },
      { text: "generated", x: 0, y: 0, width: 1, height: 1, fontFamily: "HOSTILE-GENERATED", fontFamilyStack: stack },
      { text: "first-letter", x: 0, y: 0, width: 1, height: 1, fontFamily: "HOSTILE-FIRST", fontFamilyStack: stack },
      { text: "line-clamp", x: 0, y: 0, width: 1, height: 1, fontFamily: "HOSTILE-CLAMP", fontFamilyStack: stack, generatedLineClampEllipsis: true },
      { text: "control", x: 0, y: 0, width: 1, height: 1, fontFamily: "HOSTILE-CONTROL", fontFamilyStack: stack },
    ];
    expect(capturedElementFontFamily(element)).toBe(expected);
    expect(owners.map((owner) => capturedSegmentFontFamily(element, owner)))
      .toEqual(Array.from({ length: owners.length }, () => expected));
    expect(capturedFontFamilyCss("HOSTILE", stack)).toBe(expected);

    const mutated = structuredClone(stack);
    mutated.entries[0].type = "generic-family";
    expect(serializeCapturedFontFamilyStack(mutated)).toBe('monospace, "Georgia", serif');
  });

  it("keeps the structured list authoritative in the structural control emitter", () => {
    const stack = captureFontFamilyStack('"A, B", "monospace", serif');
    const listbox = {
      tag: "select", x: 0, y: 0, width: 180, height: 44, children: [],
      styles: {
        effectiveAppearance: "listbox",
        fontSize: "16px", fontFamily: "HOSTILE-HOST", fontFamilyStack: stack,
        color: "black",
        selectListboxOptions: [{
          text: "row", selected: false, disabled: false,
          x: 0, y: 0, width: 180, height: 22,
          paddingLeft: 0, paddingTop: 0, fontSize: 16, fontAscent: 14,
          fontFamily: "HOSTILE-OPTION", fontFamilyStack: stack,
          fontWeight: "400", fontStyle: "normal", color: "black",
        }],
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(listbox, "");
    expect(svg).toContain('font-family="&quot;A, B&quot;, &quot;monospace&quot;, serif"');
    expect(svg).not.toContain("HOSTILE");
  });
});
