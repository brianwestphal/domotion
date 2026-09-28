// Root adapter over the text-engine workspace's public entry points (packages/text-engine/README.md).
export {
  clearGlyphHelperCache,
  createGlyphHelperFont,
  glyphHelperCodepointMemoSize,
  isGlyphHelperAvailable,
  resolvedGlyphHelperPathForEvidence,
  resolveFcFallbackDiagnostic,
  resolveInstalledFont,
  resolveLinuxFamilyMatch,
  resolveSystemFallbackFonts,
  resolveSystemUiFontFace,
  type SystemUiFontFace,
} from "@domotion/text-engine/helpers";
