import { describe, expect, it } from "vitest";

import type { CapturedElement, TextSegment } from "./capture/types.js";
import {
  captureFontFamilyStack,
  capturedFontFamilyCss,
  serializeCapturedFontFamilyStack,
} from "./font-family-stack.js";
import { capturedElementFontFamily, capturedSegmentFontFamily } from "./render/text.js";
import { renderFormControl } from "./render/form-controls.js";

// Parsing, generic derivation and serialization of the structured stack are
// engine logic, tested in packages/text-engine/src/font-family-stack.test.ts;
// this file covers the root renderers that consume the captured record.
describe("DM-2518 structured Blink font-family stack", () => {
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
      {
        text: "line-clamp",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        fontFamily: "HOSTILE-CLAMP",
        fontFamilyStack: stack,
        generatedLineClampEllipsis: true,
      },
      { text: "control", x: 0, y: 0, width: 1, height: 1, fontFamily: "HOSTILE-CONTROL", fontFamilyStack: stack },
    ];
    expect(capturedElementFontFamily(element)).toBe(expected);
    expect(owners.map((owner) => capturedSegmentFontFamily(element, owner))).toEqual(
      Array.from({ length: owners.length }, () => expected),
    );
    expect(capturedFontFamilyCss("HOSTILE", stack)).toBe(expected);

    const mutated = structuredClone(stack);
    mutated.entries[0].type = "generic-family";
    expect(serializeCapturedFontFamilyStack(mutated)).toBe('monospace, "Georgia", serif');
  });

  it("keeps the structured list authoritative in the structural control emitter", () => {
    const stack = captureFontFamilyStack('"A, B", "monospace", serif');
    const listbox = {
      tag: "select",
      x: 0,
      y: 0,
      width: 180,
      height: 44,
      children: [],
      styles: {
        effectiveAppearance: "listbox",
        fontSize: "16px",
        fontFamily: "HOSTILE-HOST",
        fontFamilyStack: stack,
        color: "black",
        selectListboxOptions: [
          {
            text: "row",
            selected: false,
            disabled: false,
            x: 0,
            y: 0,
            width: 180,
            height: 22,
            paddingLeft: 0,
            paddingTop: 0,
            fontSize: 16,
            fontAscent: 14,
            fontFamily: "HOSTILE-OPTION",
            fontFamilyStack: stack,
            fontWeight: "400",
            fontStyle: "normal",
            color: "black",
          },
        ],
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(listbox, "");
    expect(svg).toContain('font-family="&quot;A, B&quot;, &quot;monospace&quot;, serif"');
    expect(svg).not.toContain("HOSTILE");
  });
});
