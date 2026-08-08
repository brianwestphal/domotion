// Quoted <generic-family> spellings are LITERAL family names, not keywords.
//
// Blink keeps the distinction end-to-end: `FontSelector::FamilyNameFromSettings`
// refuses the settings substitution for them ("Quoted <font-family> values
// corresponding to a <generic-family> keyword should not be converted to a
// family name via user settings" — `platform/fonts/font_selector.cc:25-32`,
// rev 7d859f27, gated on `!generic_family.FamilyIsGeneric()`), and the
// computed style DELIVERS the distinction to our capture: `SerializeFontFamily`
// (`core/css/css_markup.cc:224-230`) force-quotes exactly the spellings
// `FontFamily::InferredTypeFor` (`platform/fonts/font_family.cc:63-74`)
// classifies as generic, so an unquoted lowercase `monospace` in
// `getComputedStyle().fontFamily` is the keyword and a quoted `"monospace"`
// is a family name. A quoted spelling therefore looks up like any other
// family — not installed on macOS/win32 — and the stack walks on:
// `font-family: "monospace", Menlo` paints Menlo, never Courier.
//
// Pre-fix, `splitFontFamilyNames` stripped quotes unconditionally, so every
// quoted spelling collapsed onto the keyword's route. Each `walks past`
// assertion below fails against that code.
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  resolveFontKey, resolveFontKeyChain,
  setSessionGenericFamilyOverrides,
  getSystemFallbackResolution, setSystemFallbackResolution,
  clearFontResolutionCaches,
} from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

// Pin the live resolvers off: these tests assert the platform-independent
// keyword-vs-literal logic (same rig as family-pin-parity.test.ts).
let prevResolver: boolean;
beforeAll(() => { prevResolver = getSystemFallbackResolution(); setSystemFallbackResolution(false); });
afterAll(() => { setSystemFallbackResolution(prevResolver); });
afterEach(() => { setSessionGenericFamilyOverrides(null); clearFontResolutionCaches(); });

describe("quoted generic spellings are literal family names (font_selector.cc:25-32)", () => {
  it('walks past a quoted "monospace" to the next declared family', () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey('"monospace", Menlo')).toBe("menlo");
    });
  });

  it('walks past a quoted "serif" / "sans-serif" / "cursive" / "fantasy"', () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey('"serif", Georgia')).toBe("georgia");
      expect(resolveFontKey('"sans-serif", Georgia')).toBe("georgia");
      expect(resolveFontKey('"cursive", Georgia')).toBe("georgia");
      expect(resolveFontKey('"fantasy", Georgia')).toBe("georgia");
    });
  });

  it('quoted "system-ui" still resolves the platform UI font — the dispatch is keyed on the family NAME, not the generic bit', () => {
    withHostPlatform("darwin", () => {
      // `font_cache_mac.mm:402-417` (and `font_cache.cc:161-166` off macOS)
      // compare `creation_params.Family()` against the "system-ui" string; a
      // quoted literal spelling matches it the same way the keyword does.
      // Measured live: Chrome paints .SFNS-Regular for
      // `font-family: "system-ui", Georgia` (425/425 oracle rows on macOS).
      expect(resolveFontKey('"system-ui", Georgia')).toBe("sf-pro");
    });
  });

  it("a BARE quoted generic exhausts the stack and lands on the standard-family terminal", () => {
    withHostPlatform("darwin", () => {
      // Chrome: literal family "monospace" is not installed → walk past →
      // stack exhausted → the UA standard font (Times). Same terminal the
      // keyword would reach only via Courier — the KEY differs.
      expect(resolveFontKey('"monospace"')).toBe("times");
    });
  });

  it("the unquoted keyword keeps its calibrated generic route", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("monospace, Menlo")).toBe("courier");
      expect(resolveFontKey("serif, Georgia")).toBe("times");
    });
  });

  it("the chain resolver applies the same classification per entry", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKeyChain('"monospace", Menlo')).toEqual(["menlo"]);
      expect(resolveFontKeyChain("monospace, Menlo")).toEqual(["courier", "menlo"]);
    });
  });

  it("a case-variant spelling is a literal family name — the keyword serializes canonically lowercase", () => {
    withHostPlatform("darwin", () => {
      // `FontFamily::InferredTypeFor` compares by case-sensitive AtomicString
      // equality, and generic keywords compute to canonical lowercase — so an
      // unquoted `Monospace` in a computed stack can only be a literal family
      // (e.g. a webfont named "Monospace", which `FontFamilyNeedsQuoting`
      // serializes unquoted).
      expect(resolveFontKey("Monospace, Menlo")).toBe("menlo");
    });
  });

  it("a quoted spelling bypasses the session-probed generic override; the keyword takes it", () => {
    withHostPlatform("darwin", () => {
      setSessionGenericFamilyOverrides(new Map([["monospace", "Menlo"]]));
      // Keyword: routed through the probed override to Menlo.
      expect(resolveFontKey("monospace")).toBe("menlo");
      // Literal name: never consults the override — walks past to Georgia.
      expect(resolveFontKey('"monospace", Georgia')).toBe("georgia");
    });
  });
});

describe("math stays on the walk-past route (settings value 'Latin Modern Math' is uninstalled — measured, not routed to STIX)", () => {
  it("bare math lands on the standard-family terminal, matching the harness's measured paint (Times on macOS)", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("math")).toBe("times");
    });
  });

  it("math with a later declared family walks on to it", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("math, Menlo")).toBe("menlo");
    });
  });
});
