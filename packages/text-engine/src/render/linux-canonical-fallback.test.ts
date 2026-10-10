import { describe, expect, it } from "vitest";
import { getFontInstance, glyphIdForCp } from "./font-instance.js";
import { resolveFontForCodepoint } from "./codepoint-resolver.js";
import { resolveFont, resolveFontKey, resolveFontKeyChain } from "./family-match.js";

const linuxIt = process.platform === "linux" ? it : it.skip;

describe("Linux current-face normalization before fontconfig fallback", () => {
  linuxIt("uses the primary face's hyphen glyph for U+2011", () => {
    const primary = getFontInstance("times", 400, 16, 0);
    expect(primary).not.toBeNull();
    expect(glyphIdForCp(primary!, 0x2011)).toBe(0);
    expect(glyphIdForCp(primary!, 0x2010)).not.toBe(0);

    const result = resolveFontForCodepoint(0x2011, primary!, "times", 400, 16, 0, undefined, "en", ["times"]);
    expect(result).toMatchObject({ key: "times", emitCh: "\u2010", decomposed: true, covered: true });
  });

  linuxIt("uses a canonically equivalent Greek glyph in WenQuanYi", () => {
    const primary = getFontInstance("cjk", 400, 16, 0);
    expect(primary).not.toBeNull();
    expect(glyphIdForCp(primary!, 0x1f71)).toBe(0);
    expect(glyphIdForCp(primary!, 0x03ac)).not.toBe(0);

    const result = resolveFontForCodepoint(0x1f71, primary!, "cjk", 400, 16, 0, undefined, "en", ["cjk"]);
    expect(result).toMatchObject({ key: "cjk", emitCh: "\u03ac", decomposed: true, covered: true });
  });

  linuxIt("keeps line separators inkless in the primary face", () => {
    const primary = getFontInstance("times", 400, 16, 0);
    expect(primary).not.toBeNull();
    expect(glyphIdForCp(primary!, 0x20)).not.toBe(0);
    for (const cp of [0x2028, 0x2029]) {
      const result = resolveFontForCodepoint(cp, primary!, "times", 400, 16, 0, undefined, "en", ["times"]);
      expect(result).toMatchObject({ key: "times", emitCh: " ", decomposed: true, covered: true });
    }
  });

  linuxIt("uses the standard family after an emoji family for U+2011", () => {
    const family = "emoji";
    const description = { weight: 400, size: 16, slant: 0, stretch: 100 };
    const primaryKey = resolveFontKey(family, "en", description);
    const primary = resolveFont(family, 400, 16, 0, undefined, 100, "en");
    const chain = resolveFontKeyChain(family, "en", description);
    expect(primary).not.toBeNull();
    expect(chain).toContain("sysfb:LiberationSerif");
    expect(glyphIdForCp(primary!, 0x2010)).toBe(0);

    const hyphen = resolveFontForCodepoint(0x2011, primary!, primaryKey, 400, 16, 0, undefined, "en", chain);
    expect(hyphen).toMatchObject({ key: "sysfb:LiberationSerif", emitCh: "\u2010", decomposed: true, covered: true });

    for (const cp of [0x2028, 0x2029]) {
      const separator = resolveFontForCodepoint(cp, primary!, primaryKey, 400, 16, 0, undefined, "en", chain);
      expect(separator).toMatchObject({ key: primaryKey, emitCh: " ", decomposed: true, covered: true });
    }
  });
});
