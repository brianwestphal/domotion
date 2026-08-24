import { createHash } from "node:crypto";

export const HELPER_AVAILABILITY_CONTRACT_VERSION =
  "native-helper-availability-v1" as const;

export type HelperAvailabilityMode = "helper-present" | "helper-absent";
export type HelperAvailabilityReason =
  | "native-helper-observed"
  | "explicitly-disabled"
  | "helper-unavailable";

export interface HelperAvailabilityContract {
  version: typeof HELPER_AVAILABILITY_CONTRACT_VERSION;
  platform: "darwin" | "linux" | "win32";
  mode: HelperAvailabilityMode;
  reason: HelperAvailabilityReason;
  verdict: "exact-native-route" | "explicit-degraded-route";
  cacheIdentity: string;
  logicalFacts: {
    capturedWebfontBytes: "preserved";
    deterministicStaticTermination: "preserved";
    installedFaceNomination: "native-observed" | "withheld";
    systemFallbackOrdering: "native-observed" | "withheld";
    nativeTraitsAndAxes: "native-observed" | "withheld";
    nativeGlyphGeometry: "native-observed" | "withheld";
  };
}

/**
 * Classify the helper route without converting absence into a parity claim.
 * `implementationIdentity` is the authenticated helper version/build digest in
 * a retained report. It is deliberately part of the cache identity: an answer
 * learned with native ownership must never be reused by a helper-absent run.
 */
export function helperAvailabilityContract(input: {
  platform: "darwin" | "linux" | "win32";
  helperObserved: boolean;
  explicitlyDisabled: boolean;
  implementationIdentity: string;
}): HelperAvailabilityContract {
  if (input.helperObserved && input.explicitlyDisabled) {
    throw new Error("a disabled helper cannot be classified as observed");
  }
  if (input.helperObserved && input.implementationIdentity.trim() === "") {
    throw new Error("helper-present reports require an implementation identity");
  }

  const mode = input.helperObserved ? "helper-present" : "helper-absent";
  const reason = input.helperObserved
    ? "native-helper-observed"
    : input.explicitlyDisabled
      ? "explicitly-disabled"
      : "helper-unavailable";
  const nativeFact = input.helperObserved ? "native-observed" : "withheld";
  const identityPayload = [
    HELPER_AVAILABILITY_CONTRACT_VERSION,
    input.platform,
    mode,
    reason,
    input.helperObserved ? input.implementationIdentity : "no-native-owner",
  ].join("\0");

  return {
    version: HELPER_AVAILABILITY_CONTRACT_VERSION,
    platform: input.platform,
    mode,
    reason,
    verdict: input.helperObserved ? "exact-native-route" : "explicit-degraded-route",
    cacheIdentity: createHash("sha256").update(identityPayload).digest("hex"),
    logicalFacts: {
      capturedWebfontBytes: "preserved",
      deterministicStaticTermination: "preserved",
      installedFaceNomination: nativeFact,
      systemFallbackOrdering: nativeFact,
      nativeTraitsAndAxes: nativeFact,
      nativeGlyphGeometry: nativeFact,
    },
  };
}
