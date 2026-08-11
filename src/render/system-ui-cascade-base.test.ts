/**
 * DM-1859: a `system-ui` run's per-codepoint fallback is walked from the CoreText
 * UI font, not from the run's named primary face.
 *
 * Blink splits what our key table merges. `system-ui` / `BlinkMacSystemFont` go
 * to `MatchSystemUIFont` — the platform UI font, built by
 * `CTFontCreateUIFontForLanguage`, which carries its OWN cascade list and is the
 * only way to reach Apple's hidden `.…UI` faces — while an explicitly-named
 * `"SF Pro Text"` goes to `MatchFontFamily`
 * (`mac/font_cache_mac.mm:409-417`, Chromium rev 7d859f27). All of them land on
 * our single `sf-pro` key, so **the key cannot carry the distinction** and the
 * signal has to travel beside it.
 *
 * These tests pin that separation, because collapsing it is a bug this codebase
 * has already shipped once in the other direction: `matchFamilyNameToKey` used to
 * conflate an explicitly-named `"Helvetica Neue"` with plain Helvetica, which
 * painted the wrong face across ten Unicode blocks. Deriving the UI-font base
 * from the key instead of from the stack would mis-fire the same way — every page
 * that names SF Pro explicitly would silently get the UI cascade.
 *
 * Registry-level: no font extraction, runs cross-platform. (The one test
 * gated on the key-collapse precondition probes the installed-family registry,
 * which consults the helper where one exists.)
 */
import { describe, expect, it } from "vitest";
import { resolveFontKey, stackPrimaryIsSystemUi } from "./font-resolution.js";

describe("system-ui cascade-base signal (DM-1859)", () => {
  it("treats the generic UI families as system-ui primaries", () => {
    expect(stackPrimaryIsSystemUi("system-ui, -apple-system, sans-serif")).toBe(true);
    expect(stackPrimaryIsSystemUi("BlinkMacSystemFont, Segoe UI, sans-serif")).toBe(true);
    expect(stackPrimaryIsSystemUi("system-ui")).toBe(true);
  });

  it("does NOT treat an explicitly-named SF Pro family as system-ui", () => {
    // The load-bearing case: same key, different Blink entry point.
    expect(stackPrimaryIsSystemUi('"SF Pro Text", sans-serif')).toBe(false);
    expect(stackPrimaryIsSystemUi('"SF Pro Display", sans-serif')).toBe(false);
    expect(stackPrimaryIsSystemUi("SF Pro")).toBe(false);
  });

  // The key-collapse is a macOS-with-SF-Pro fact, so the run-gate is the
  // collapse's own precondition: the named family resolving to the same
  // `sf-pro` key as the generic. Where it does not — a macOS host without
  // Apple's SF Pro download, and every Linux/Windows host — the keys
  // legitimately diverge, and that divergence is Chrome's own behavior:
  // Linux resolves `system-ui` through fontconfig's raw default (WenQuanYi
  // Zen Hei on the noble image, verified via getPlatformFontsForNode) while a
  // named "SF Pro Text" falls through the stack. There the signal COULD be
  // derived from the key, but the mechanism must serve the platform where it
  // cannot, which is what this pins.
  it.runIf(resolveFontKey("SF Pro Text") === "sf-pro")(
    "keeps the distinction the font key provably cannot carry", () => {
      // If this ever stops holding, the signal could be derived from the key and
      // this whole mechanism simplifies. Until then, it cannot.
      const viaGeneric = resolveFontKey("system-ui, sans-serif");
      const viaNamedFamily = resolveFontKey('"SF Pro Text", sans-serif');
      expect(viaGeneric).toBe(viaNamedFamily);
      expect(stackPrimaryIsSystemUi("system-ui, sans-serif"))
        .not.toBe(stackPrimaryIsSystemUi('"SF Pro Text", sans-serif'));
    });

  it("excludes bare -apple-system, matching how the key table already treats it", () => {
    // Chrome resolves `-apple-system` to the UA standard font rather than to the
    // UI font, so it falls THROUGH the stack instead of becoming the primary —
    // which is also why it is excluded from the `sf-pro` mapping (DM-291
    // measured SF Pro's advances ~3% wider than Helvetica's).
    expect(stackPrimaryIsSystemUi("-apple-system, system-ui, sans-serif")).toBe(false);
  });

  it("matches on the FIRST family only, since that is the primary the cascade is walked from", () => {
    expect(stackPrimaryIsSystemUi("Georgia, system-ui")).toBe(false);
    expect(stackPrimaryIsSystemUi('"Helvetica Neue", BlinkMacSystemFont')).toBe(false);
  });

  it("normalizes quoting, casing and whitespace the way a computed style may present it", () => {
    expect(stackPrimaryIsSystemUi("'system-ui', sans-serif")).toBe(true);
    expect(stackPrimaryIsSystemUi('"system-ui"')).toBe(true);
    expect(stackPrimaryIsSystemUi("  System-UI , sans-serif")).toBe(false);
    expect(stackPrimaryIsSystemUi("blinkmacsystemfont")).toBe(false);
    expect(stackPrimaryIsSystemUi('"System-ui", Menlo')).toBe(false);
  });

  it("is false for an absent or empty stack rather than throwing", () => {
    expect(stackPrimaryIsSystemUi(undefined)).toBe(false);
    expect(stackPrimaryIsSystemUi("")).toBe(false);
  });
});
