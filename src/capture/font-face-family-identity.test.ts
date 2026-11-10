import { describe, expect, it } from "vitest";
import { faceRuleFromFontFaceDescriptors, localFaceFromFontFaceDescriptors } from "./cross-origin-font-face.js";
import { serializeCapturedFontFamilyStack } from "../font-family-stack.js";

describe("DM-N80HJW CSSOM font-face descriptor identity", () => {
  it.each([" Face ", " Face", "Face ", "\tFace\t", "\u00a0Face\u00a0", " ", "", '"Quote"'])(
    "decodes %j without trimming its name data",
    (name) => {
      const family = serializeCapturedFontFamilyStack({
        source: "blink-font-family-stack-v1",
        entries: [{ name, type: "family-name" }],
        genericFamily: "none",
      });
      const descriptor = { family, src: 'url("font.ttf")', weight: "", style: "", stretch: "", unicodeRange: "" };
      expect(faceRuleFromFontFaceDescriptors(descriptor, "https://font.test/")?.family).toBe(name);
      expect(localFaceFromFontFaceDescriptors({ ...descriptor, src: 'local("Arial")' })?.family).toBe(name);
    },
  );
  it("still normalizes CSS token padding and identifier-sequence gaps", () => {
    expect(
      faceRuleFromFontFaceDescriptors(
        { family: "  A   B  ", src: "url(font.ttf)", weight: "", style: "", stretch: "", unicodeRange: "" },
        "https://font.test/",
      )?.family,
    ).toBe("A B");
  });
});
