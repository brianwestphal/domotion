/**
 * Session generic-family overrides (live-browser authority, default ON).
 *
 * The concrete family behind a CSS generic keyword is a property of the
 * launched capture session — Playwright applies its own per-platform table
 * via CDP `Page.setFontFamilies` to every non-headful page
 * (`playwright-core/lib/server/chromium/crPage.js`, `_setDefaultFontFamilies`),
 * overriding blink's `WebPreferences` constructor defaults
 * (`third_party/blink/common/web_preferences/web_preferences.cc:25-41`, rev
 * 7d859f27). So when the capture side probes the session
 * the probed painted families must win over the static generic routes. Static
 * routes remain the degraded path when probing is explicitly disabled or
 * unavailable.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getSessionGenericFamilyOverrides,
  __resolveFontSpecForTest,
  resolveFontKey,
  setSessionGenericFamilyOverrides,
  withSessionGenericFamilyOverrides,
} from "./font-resolution.js";
import { hostPlatform } from "./host-platform.js";

afterEach(() => setSessionGenericFamilyOverrides(null));

describe("setSessionGenericFamilyOverrides", () => {
  const installedTestFamily = hostPlatform() === "darwin"
    ? "Menlo"
    : hostPlatform() === "win32" ? "Arial" : "Liberation Serif";

  const installedTestPath = (): string | undefined => {
    const key = resolveFontKey(installedTestFamily);
    expect(key).not.toBeNull();
    return __resolveFontSpecForTest(key!)?.path;
  };

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
    const expected = installedTestPath();
    setSessionGenericFamilyOverrides({ common: new Map([["monospace", installedTestFamily]]), byScript: new Map() });
    expect(__resolveFontSpecForTest(resolveFontKey("monospace")!)?.path).toBe(expected);
  });

  it("routes the implicit standard-family terminal from the session", () => {
    const expected = installedTestPath();
    setSessionGenericFamilyOverrides({ common: new Map([["standard", installedTestFamily]]), byScript: new Map() });
    expect(__resolveFontSpecForTest(resolveFontKey("DoesNotExist")!)?.path).toBe(expected);
  });

  it("routes a script-specific standard-family terminal from the session", () => {
    setSessionGenericFamilyOverrides({
      common: new Map([["standard", "Times"]]),
      byScript: new Map([["ARABIC", new Map([["standard", installedTestFamily]])]]),
    });
    expect(__resolveFontSpecForTest(resolveFontKey("DoesNotExist", "ar")!)?.path).toBe(installedTestPath());
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

  it("scopes two captured-session answers and restores the prior oracle setting", () => {
    const prior = { common: new Map([["serif", installedTestFamily]]), byScript: new Map() };
    const first = { common: new Map([["monospace", installedTestFamily]]), byScript: new Map() };
    const second = { common: new Map([["standard", installedTestFamily]]), byScript: new Map() };
    setSessionGenericFamilyOverrides(prior);

    expect(withSessionGenericFamilyOverrides(first, () => {
      expect(getSessionGenericFamilyOverrides()).toBe(first);
      return withSessionGenericFamilyOverrides(second, () => getSessionGenericFamilyOverrides());
    })).toBe(second);
    expect(getSessionGenericFamilyOverrides()).toBe(prior);
  });

  it("restores the prior setting when a scoped render throws", () => {
    const prior = { common: new Map([["serif", installedTestFamily]]), byScript: new Map() };
    const captured = { common: new Map([["monospace", installedTestFamily]]), byScript: new Map() };
    setSessionGenericFamilyOverrides(prior);
    expect(() => withSessionGenericFamilyOverrides(captured, () => {
      throw new Error("render failed");
    })).toThrow("render failed");
    expect(getSessionGenericFamilyOverrides()).toBe(prior);
  });
});
