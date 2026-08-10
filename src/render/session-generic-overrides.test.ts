/**
 * Session generic-family overrides (flag-gated prototype, default OFF).
 *
 * The concrete family behind a CSS generic keyword is a property of the
 * launched capture session — Playwright applies its own per-platform table
 * via CDP `Page.setFontFamilies` to every non-headful page
 * (`playwright-core/lib/server/chromium/crPage.js`, `_setDefaultFontFamilies`),
 * overriding blink's `WebPreferences` constructor defaults
 * (`third_party/blink/common/web_preferences/web_preferences.cc:25-41`, rev
 * 7d859f27). So when the capture side probes the session
 * (`DOMOTION_GENERIC_PROBE=1`), the probed painted families must win over the
 * static generic routes; when no overrides are installed (the default), the
 * static routes must be untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getSessionGenericFamilyOverrides,
  resolveFontKey,
  setSessionGenericFamilyOverrides,
} from "./font-resolution.js";
import { hostPlatform } from "./host-platform.js";

afterEach(() => setSessionGenericFamilyOverrides(null));

describe("setSessionGenericFamilyOverrides", () => {
  it("defaults to null and round-trips through the accessor", () => {
    expect(getSessionGenericFamilyOverrides()).toBeNull();
    const overrides = { common: new Map([["monospace", "Menlo"]]), byScript: new Map() };
    setSessionGenericFamilyOverrides(overrides);
    expect(getSessionGenericFamilyOverrides()).toBe(overrides);
    setSessionGenericFamilyOverrides(null);
    expect(getSessionGenericFamilyOverrides()).toBeNull();
  });

  it("routes a generic keyword to the probed family's key", () => {
    // On the darwin static route `monospace` → courier; a session that
    // painted Menlo must win. (Key names are platform-independent here — the
    // probed name goes back through the ordinary family matcher.)
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", "Menlo"]]), byScript: new Map() });
    expect(resolveFontKey("monospace")).toBe("menlo");
  });

  it("falls back to the static route when the probed family is unrecognized", () => {
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", "DoesNotExist"]]), byScript: new Map() });
    const withOverride = resolveFontKey("monospace");
    setSessionGenericFamilyOverrides(null);
    expect(withOverride).toBe(resolveFontKey("monospace"));
  });

  it("falls back to the static route for generics the probe did not answer", () => {
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", "Menlo"]]), byScript: new Map() });
    const withOverride = resolveFontKey("serif");
    setSessionGenericFamilyOverrides(null);
    expect(withOverride).toBe(resolveFontKey("serif"));
  });

  it("does not intercept non-generic family names", () => {
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", "Menlo"]]), byScript: new Map() });
    if (hostPlatform() === "darwin") {
      expect(resolveFontKey("courier")).toBe("courier");
    }
    expect(resolveFontKey("monaco, monospace")).not.toBeNull();
  });

  it("leaves everything untouched when cleared (the default path)", () => {
    const before = resolveFontKey("monospace");
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", "Menlo"]]), byScript: new Map() });
    setSessionGenericFamilyOverrides(null);
    expect(resolveFontKey("monospace")).toBe(before);
  });
});
