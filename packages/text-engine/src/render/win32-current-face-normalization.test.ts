import { describe, expect, it } from "vitest";
import { glyphIdForCp } from "./font-instance.js";
import { resolveFontForCodepoint } from "./codepoint-resolver.js";
import { resolveFont, resolveFontKey, resolveFontKeyChain } from "./family-match.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Windows current-face normalization", () => {
  windowsIt("keeps normalized and inkless scalars in Consolas across repeated queries", () => {
    const family = "monospace";
    const description = { weight: 400, size: 16, slant: 0, stretch: 100 };
    const key = resolveFontKey(family, "en", description);
    const primary = resolveFont(family, 400, 16, 0, undefined, 100, "en");
    const chain = resolveFontKeyChain(family, "en", description);
    expect(primary).not.toBeNull();
    expect(key).toBe("sysfb:Consolas");
    expect(glyphIdForCp(primary!, 0x2010)).not.toBe(0);
    expect(glyphIdForCp(primary!, 0x004b)).not.toBe(0);

    const expected = new Map([
      [0x2011, "\u2010"],
      [0x2028, " "],
      [0x2029, " "],
      [0x212a, "K"],
    ]);
    for (const cp of [0x2011, 0x2028, 0x212a, 0x2029, 0x004b, 0x2011, 0x212a]) {
      const result = resolveFontForCodepoint(cp, primary!, key, 400, 16, 0, undefined, "en", chain);
      if (expected.has(cp)) {
        expect(result).toMatchObject({ key, emitCh: expected.get(cp), decomposed: true, covered: true });
      } else {
        expect(result).toMatchObject({ key, covered: true });
      }
    }
  });
});
