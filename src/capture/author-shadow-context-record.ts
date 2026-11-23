/** A private, live source-realm capability. It is passed as an actual owned
 * remote object, never serialized or recovered through mutable page globals. */
export type AuthorShadowContextMode = "selected-root" | "inline-svg-roots";
export type AuthorShadowDisposition = "none" | "present" | "unavailable";
export interface AuthorShadowExpectation {
  mode: AuthorShadowContextMode;
  purpose: string;
  markUsed?: boolean;
}
export interface AuthorShadowContextCapability {
  readonly source: "domotion-author-shadow-capability-v1";
  adopt(element: Element, expected: AuthorShadowExpectation): AuthorShadowDisposition;
}
export interface AuthorShadowContextCapabilities {
  selectedRoot?: AuthorShadowContextCapability;
  inlineSvgRoots?: AuthorShadowContextCapability;
}

/** Consumers call only after their own admission checks pass. The carrier
 * injects the original frozen capability. Its method rejects copied receivers
 * and marks the original private ledger, including across repeated captures. */
export function adoptAuthorShadowContext(
  element: Element,
  capability: AuthorShadowContextCapability | undefined,
  expected: AuthorShadowExpectation,
): AuthorShadowDisposition {
  if (capability?.source !== "domotion-author-shadow-capability-v1" || typeof capability.adopt !== "function")
    return "unavailable";
  return capability.adopt(element, expected);
}
