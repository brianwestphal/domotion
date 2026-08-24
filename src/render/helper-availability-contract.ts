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

export interface HelperRouteLedgerEnvironment {
  schemaVersion: 1;
  helper: HelperAvailabilityContract;
  fingerprint: string;
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

/** Bind a renderer-route ledger to the helper contract that owned its native facts. */
export function helperRouteLedgerEnvironment(
  helper: HelperAvailabilityContract,
): HelperRouteLedgerEnvironment {
  const payload = JSON.stringify({
    schemaVersion: 1,
    helperVersion: helper.version,
    platform: helper.platform,
    mode: helper.mode,
    reason: helper.reason,
    cacheIdentity: helper.cacheIdentity,
    logicalFacts: helper.logicalFacts,
  });
  return {
    schemaVersion: 1,
    helper: structuredClone(helper),
    fingerprint: createHash("sha256").update(payload).digest("hex"),
  };
}

/**
 * Fail closed before comparing or promoting route records from different
 * helper environments. Native facts from an absent arm are explicitly
 * withheld; they are never treated as a static-chain Chromium answer.
 */
export function assertComparableHelperRouteLedgers(
  left: HelperRouteLedgerEnvironment,
  right: HelperRouteLedgerEnvironment,
): void {
  if (left.fingerprint !== right.fingerprint
      || left.helper.cacheIdentity !== right.helper.cacheIdentity) {
    throw new Error("renderer route ledgers have different helper availability identities");
  }
  if (left.helper.mode === "helper-absent") {
    const nativeFacts = [
      left.helper.logicalFacts.installedFaceNomination,
      left.helper.logicalFacts.systemFallbackOrdering,
      left.helper.logicalFacts.nativeTraitsAndAxes,
      left.helper.logicalFacts.nativeGlyphGeometry,
    ];
    if (nativeFacts.some((fact) => fact !== "withheld")) {
      throw new Error("helper-absent route ledger claimed native-only facts");
    }
  }
}
