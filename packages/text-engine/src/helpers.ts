/**
 * `@domotion/text-engine/helpers` — native glyph-helper and ICU companion
 * acquisition, availability, and direct queries.
 */
export {
  clearGlyphHelperCache,
  glyphHelperCodepointMemoSize,
  resolveFcFallbackDiagnostic,
  resolveInstalledFont,
  resolveLinuxFamilyMatch,
  resolveSystemFallbackFonts,
  resolveSystemUiFontFace,
  type SystemUiFontFace,
} from "./render/glyph-helper.js";
export { createGlyphHelperFont } from "./render/glyph-helper-font.js";
export { isGlyphHelperAvailable, resolvedGlyphHelperPathForEvidence } from "./render/glyph-helper-transport.js";
export { acquireGlyphHelper, assetNameFor } from "./render/helper-acquire.js";
export {
  helperAvailabilityContract,
  type HelperAvailabilityContract,
  helperRouteLedgerEnvironment,
} from "./render/helper-availability-contract.js";
export {
  ICU_BINARY,
  icuCodepointProperties,
  type IcuCodepointProperties,
  isIcuHelperAvailable,
  queryIcuCodepoints,
} from "./render/icu-helper.js";
export {
  acquireIcuCompanion,
  acquireIcuCompanionSync,
  ICU_COMPANION_VERSION,
  resolveIcuCompanionTarget,
} from "./render/icu-helper-acquire.js";
