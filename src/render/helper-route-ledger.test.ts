import { describe, expect, it } from "vitest";
import {
  assertComparableHelperRouteLedgers,
  helperAvailabilityContract,
  helperRouteLedgerEnvironment,
} from "./helper-availability-contract.js";

const present = helperRouteLedgerEnvironment(helperAvailabilityContract({
  platform: "linux",
  helperObserved: true,
  explicitlyDisabled: false,
  implementationIdentity: "helper-build-a",
}));
const absent = helperRouteLedgerEnvironment(helperAvailabilityContract({
  platform: "linux",
  helperObserved: false,
  explicitlyDisabled: true,
  implementationIdentity: "helper-build-a",
}));

describe("renderer route helper identity", () => {
  it("allows only ledgers with the same helper environment", () => {
    expect(() => assertComparableHelperRouteLedgers(present, structuredClone(present))).not.toThrow();
    expect(() => assertComparableHelperRouteLedgers(present, absent)).toThrow(/different helper availability/);
  });

  it("withholds every native-only fact in the absent route", () => {
    expect(absent.helper.logicalFacts).toMatchObject({
      installedFaceNomination: "withheld",
      systemFallbackOrdering: "withheld",
      nativeTraitsAndAxes: "withheld",
      nativeGlyphGeometry: "withheld",
    });
    const forged = structuredClone(absent);
    forged.helper.logicalFacts.nativeGlyphGeometry = "native-observed";
    expect(() => assertComparableHelperRouteLedgers(forged, forged)).toThrow(/claimed native-only facts/);
  });

  it("separates helper implementation builds in cache identity and ledger fingerprint", () => {
    const other = helperRouteLedgerEnvironment(helperAvailabilityContract({
      platform: "linux", helperObserved: true, explicitlyDisabled: false,
      implementationIdentity: "helper-build-b",
    }));
    expect(other.helper.cacheIdentity).not.toBe(present.helper.cacheIdentity);
    expect(other.fingerprint).not.toBe(present.fingerprint);
  });
});
