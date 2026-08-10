import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve("tools/linux-glyph-extractor/src/main.cpp"), "utf8");
const winSource = readFileSync(resolve("tools/win32-glyph-extractor/src/main.cpp"), "utf8");

describe("Linux helper italic-style metadata", () => {
  it("reports FreeType's native italic bit in the optional meta field", () => {
    expect(source).toContain("face->style_flags & FT_STYLE_FLAG_ITALIC");
    expect(source).toContain('\\"traitItalic\\"');
  });
});

describe("Windows helper italic-style metadata", () => {
  it("reports the DirectWrite style source Chromium's pinned SkTypeface reads", () => {
    expect(winSource).toContain("IDWriteFontFace3");
    expect(winSource).toContain("face3->GetStyle() != DWRITE_FONT_STYLE_NORMAL");
  });
});
