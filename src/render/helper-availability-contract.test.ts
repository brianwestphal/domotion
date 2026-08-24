import { describe, expect, it } from "vitest";
import { helperAvailabilityContract } from "./helper-availability-contract.js";

const platforms = ["darwin", "linux", "win32"] as const;

describe("native helper availability contract", () => {
  it.each(platforms)("separates helper-present and disabled %s sessions", (platform) => {
    const present = helperAvailabilityContract({
      platform, helperObserved: true, explicitlyDisabled: false,
      implementationIdentity: `${platform}-fixture-v1`,
    });
    const absent = helperAvailabilityContract({
      platform, helperObserved: false, explicitlyDisabled: true,
      implementationIdentity: `${platform}-fixture-v1`,
    });

    expect(present.mode).toBe("helper-present");
    expect(present.verdict).toBe("exact-native-route");
    expect(present.logicalFacts.installedFaceNomination).toBe("native-observed");
    expect(absent).toMatchObject({
      mode: "helper-absent",
      reason: "explicitly-disabled",
      verdict: "explicit-degraded-route",
      logicalFacts: {
        capturedWebfontBytes: "preserved",
        deterministicStaticTermination: "preserved",
        installedFaceNomination: "withheld",
        systemFallbackOrdering: "withheld",
        nativeTraitsAndAxes: "withheld",
        nativeGlyphGeometry: "withheld",
      },
    });
    expect(absent.cacheIdentity).not.toBe(present.cacheIdentity);
  });

  it("rejects contradictory or unauthenticated native observations", () => {
    expect(() => helperAvailabilityContract({
      platform: "darwin", helperObserved: true, explicitlyDisabled: true,
      implementationIdentity: "fixture",
    })).toThrow("disabled helper cannot be classified as observed");
    expect(() => helperAvailabilityContract({
      platform: "darwin", helperObserved: true, explicitlyDisabled: false,
      implementationIdentity: "",
    })).toThrow("require an implementation identity");
  });
});
