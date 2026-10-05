import { describe, expect, it } from "vitest";
import {
  CJK_CANONICAL_PROBE_CODEPOINTS,
  CJK_CANONICAL_PROBE_FAMILIES,
  CJK_CANONICAL_PROBE_LANGUAGES,
  cjkCanonicalProbeStacks,
  sameNativeFace,
} from "../tools/cjk-canonical-singleton-platform-probe.js";
import type { OurFace } from "../tools/font-conformance.js";

describe("CJK canonical singleton native probe", () => {
  it("selects one regular synthetic stack for every requested family and language", () => {
    const stacks = cjkCanonicalProbeStacks();
    expect(stacks).toHaveLength(12);
    expect(CJK_CANONICAL_PROBE_CODEPOINTS).toEqual([0xf900, 0xfa00, 0x2f800, 0x2f900, 0x2fa00]);
    expect(stacks.map((stack) => `${stack.fontFamily}/${stack.lang}`)).toEqual(
      CJK_CANONICAL_PROBE_FAMILIES.flatMap((family) =>
        CJK_CANONICAL_PROBE_LANGUAGES.map((lang) => `${family}/${lang}`),
      ),
    );
    expect(stacks.every((stack) => stack.fontWeight === 400 && stack.fontSize === 16)).toBe(true);
  });

  it("requires a named identical native face for a candidate/splitter match", () => {
    const face: OurFace = { key: "face", postscriptName: "Face-Regular", path: "C:\\Fonts\\Face.ttf", covered: true };
    expect(sameNativeFace(face, { ...face, path: "c:\\fonts\\face.ttf" })).toBe(true);
    expect(sameNativeFace(face, { ...face, key: "different" })).toBe(false);
    expect(sameNativeFace(face, { ...face, postscriptName: "Other-Regular" })).toBe(false);
    expect(sameNativeFace(face, { ...face, path: null })).toBe(false);
    expect(sameNativeFace({ ...face, postscriptName: null }, { ...face, postscriptName: null })).toBe(false);
  });
});
