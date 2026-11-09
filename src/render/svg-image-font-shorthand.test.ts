import { describe, expect, it } from "vitest";
import { parseImageFontShorthand } from "./svg-image-font-shorthand.js";
import { parseImageRootFontShorthand } from "./svg-image-root-font.js";
import { imageRootFontSizeLength } from "./svg-image-root-transform.js";

describe("balanced image font shorthands (DM-2K0K01, DM-53WRGR)", () => {
  it("resets variant caps for CSS-wide root font shorthands", () => {
    for (const keyword of ["initial", "inherit", "unset", "revert"])
      expect(parseImageRootFontShorthand(keyword)?.get("font-variant-caps"), keyword).toBe("normal");
  });

  it("finds family after nested size math and optional line-height", () => {
    expect(
      parseImageFontShorthand(
        'italic small-caps 550 clamp(12px, calc(1em + 2px), 30px)/calc(1em + 4px) "Shared Face", serif',
      ),
    ).toMatchObject({
      size: "clamp(12px, calc(1em + 2px), 30px)",
      family: '"Shared Face", serif',
      lineHeight: "calc(1em + 4px)",
      weight: "550",
      style: "italic",
      variant: "small-caps",
    });
    expect(parseImageRootFontShorthand("small-caps 550 max(1em, 20px) serif")?.get("font-size")).toBe("max(1em, 20px)");
    expect(parseImageRootFontShorthand("oblique 12deg 20px serif")?.get("font-style")).toBe("oblique 12deg");
    expect(parseImageRootFontShorthand('20px "var(--literal)"')?.get("font-family")).toBe('"var(--literal)"');
  });

  it("does not guess system fonts, unresolved variables, or malformed tokens", () => {
    for (const value of [
      "caption",
      "var(--font)",
      "italic calc(20px serif",
      "20px/ serif",
      "20px/blah serif",
      "20px serif/extra",
      "20px calc(serif)",
      "italic italic 20px serif",
      "20px",
    ])
      expect(parseImageFontShorthand(value), value).toBeNull();
  });

  it("keeps math dimensions, arity and recursive work bounded", () => {
    expect(imageRootFontSizeLength("max(10px, calc(2em + 4px))", 16)).toBe(36);
    for (const value of [
      "min(10px,2)",
      "clamp(10px,20px)",
      "max()",
      "calc(20px / 0)",
      "calc(".repeat(600) + "20px" + ")".repeat(600),
    ])
      expect(imageRootFontSizeLength(value, 16)).toBeNull();
  });
});
