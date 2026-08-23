import {
  FREE_SANS_NOBLE_PACKAGE,
  LINUX_MATHML_GREEK_SUBSETS,
  LINUX_MATHML_GREEK_TOKENS,
  type LinuxMathmlGreekPreterminalEvidence,
} from "../../tools/linux-mathml-greek-raster-contract.js";

export function exactLinuxMathmlGreekPreterminal(): LinuxMathmlGreekPreterminalEvidence {
  return {
    schemaVersion: 1,
    package: {
      suite: FREE_SANS_NOBLE_PACKAGE.suite, name: FREE_SANS_NOBLE_PACKAGE.name, source: FREE_SANS_NOBLE_PACKAGE.source,
      version: FREE_SANS_NOBLE_PACKAGE.version, architecture: FREE_SANS_NOBLE_PACKAGE.architecture,
      filename: FREE_SANS_NOBLE_PACKAGE.filename, byteLength: FREE_SANS_NOBLE_PACKAGE.byteLength, sha256: FREE_SANS_NOBLE_PACKAGE.sha256,
    },
    inventory: {
      fontconfigVersion: "fontconfig version 2.15.0", configSha256: "a".repeat(64), inventorySha256: "b".repeat(64),
      entries: [{ path: "/isolated/FreeSans.ttf", byteLength: FREE_SANS_NOBLE_PACKAGE.fontByteLength, sha256: FREE_SANS_NOBLE_PACKAGE.fontSha256, familyName: "FreeSans", postscriptName: "FreeSans", faceIndex: 0 }],
    },
    sourceFont: {
      packagePath: FREE_SANS_NOBLE_PACKAGE.fontPath, runtimePath: "/isolated/FreeSans.ttf",
      byteLength: FREE_SANS_NOBLE_PACKAGE.fontByteLength, sha256: FREE_SANS_NOBLE_PACKAGE.fontSha256,
      familyName: "FreeSans", postscriptName: "FreeSans", faceIndex: 0,
      unitsPerEm: 1000, ascent: 900, descent: -300, lineGap: 100, glyphCount: 8536,
    },
    subset: {
      retainedGids: [0, 6548, 6549, 6555, 6563],
      hinted: { ...LINUX_MATHML_GREEK_SUBSETS.hinted }, unhinted: { ...LINUX_MATHML_GREEK_SUBSETS.unhinted },
    },
    tokens: LINUX_MATHML_GREEK_TOKENS.map((token, index) => ({
      id: token.id, source: token.source, transformed: token.transformed,
      sourceCodePoint: token.sourceCodePoint, transformedCodePoint: token.transformedCodePoint,
      textTransform: "math-auto" as const, computedFontStyle: "normal" as const,
      geometry: { x: 48 + index * 20, y: 52, width: 16, height: 28, textTop: 52, fontAscent: 22, baseline: 74, matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number] },
      nativeFace: { familyName: "FreeSans" as const, postscriptName: "FreeSans" as const, isCustomFont: false as const, glyphCount: 1 as const },
      glyph: { ...token.glyph },
    })),
  };
}
