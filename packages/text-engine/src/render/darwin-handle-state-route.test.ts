/**
 * DM-9FGPXC: CoreText can hand back the SAME fallback face with a different
 * variation-handle state depending on the cascade base it was asked from. At
 * U+0D00, 16 px, `serif` (Times base) gets an `.SFMalayalam-Regular` handle
 * with `opsz` already at 17, so Blink's `axes_reconfigured` guard never clones
 * it and Chrome reports the base name; `system-ui` (UI-font base) gets a handle
 * at the default `opsz`, which Blink clones to 17 and Chrome reports as
 * `.SFMalayalam-Regular_opsz110000_wght`.
 *
 * The handle state used to be recorded first-write-wins per (key, weight,
 * size, slant), and the per-route fallback memo held only the key — so whichever
 * route asked first decided the instance identity for both. These tests pin
 * that each route keeps its own handle state regardless of ask order.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  getFontInstance,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  stackPrimaryIsSystemUi,
} from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper-transport.js";

const MALAYALAM_ANUSVARA_ABOVE = 0x0d00;

function instantiatedNameFor(family: string, weight: number): string | null {
  const primaryKey = resolveFontKey(family);
  const primary = resolveFont(family, weight, 16);
  expect(primary).not.toBeNull();
  const resolution = resolveFontForCodepoint(
    MALAYALAM_ANUSVARA_ABOVE,
    primary!,
    primaryKey,
    weight,
    16,
    0,
    undefined,
    "en",
    resolveFontKeyChain(family),
    stackPrimaryIsSystemUi(family),
    100,
    undefined,
    family,
  );
  const instance = resolution.fontOverride ?? getFontInstance(resolution.key, weight, 16, 0);
  return instance?.instantiatedPostscriptName ?? instance?.postscriptName ?? null;
}

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("darwin fallback handle state is per route (DM-9FGPXC)", () => {
  afterEach(() => clearFontResolutionCaches());

  for (const weight of [400, 700]) {
    it(`keeps system-ui's handle state after serif reached the same face first (${weight})`, () => {
      clearFontResolutionCaches();
      const coldSystemUi = instantiatedNameFor("system-ui", weight);
      const coldSerif = (() => {
        clearFontResolutionCaches();
        return instantiatedNameFor("serif", weight);
      })();

      clearFontResolutionCaches();
      const serifFirst = instantiatedNameFor("serif", weight);
      const systemUiSecond = instantiatedNameFor("system-ui", weight);
      // And the reverse order, which must not move serif either.
      const serifThird = instantiatedNameFor("serif", weight);

      // The routes genuinely differ on this host; otherwise this test is blind.
      expect(coldSystemUi).not.toBe(coldSerif);
      expect(serifFirst).toBe(coldSerif);
      expect(systemUiSecond).toBe(coldSystemUi);
      expect(serifThird).toBe(coldSerif);
    });
  }
});
