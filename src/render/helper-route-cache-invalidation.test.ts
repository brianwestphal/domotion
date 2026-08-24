import { afterAll, describe, expect, it } from "vitest";
import { clearGlyphHelperCache, isGlyphHelperAvailable } from "./glyph-helper.js";
import {
  assertComparableHelperRouteLedgers,
  helperAvailabilityContract,
  helperRouteLedgerEnvironment,
} from "./helper-availability-contract.js";

const originalDisabled = process.env.DOMOTION_DISABLE_HELPER;

afterAll(() => {
  if (originalDisabled == null) delete process.env.DOMOTION_DISABLE_HELPER;
  else process.env.DOMOTION_DISABLE_HELPER = originalDisabled;
  clearGlyphHelperCache();
});

describe("helper route cache invalidation", () => {
  it("moves the production availability probe and rejects cross-arm promotion", () => {
    delete process.env.DOMOTION_DISABLE_HELPER;
    clearGlyphHelperCache();
    const presentObserved = isGlyphHelperAvailable();
    const present = helperRouteLedgerEnvironment(helperAvailabilityContract({
      platform: process.platform as "darwin" | "linux" | "win32",
      helperObserved: presentObserved,
      explicitlyDisabled: false,
      implementationIdentity: presentObserved ? "authenticated-test-helper" : "",
    }));

    process.env.DOMOTION_DISABLE_HELPER = "1";
    clearGlyphHelperCache();
    expect(isGlyphHelperAvailable()).toBe(false);
    const absent = helperRouteLedgerEnvironment(helperAvailabilityContract({
      platform: process.platform as "darwin" | "linux" | "win32",
      helperObserved: false,
      explicitlyDisabled: true,
      implementationIdentity: "",
    }));

    expect(absent.helper.cacheIdentity).not.toBe(present.helper.cacheIdentity);
    expect(() => assertComparableHelperRouteLedgers(present, absent))
      .toThrow(/different helper availability identities/);
  });
});
