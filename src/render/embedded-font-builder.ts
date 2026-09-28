// Root adapter over the text-engine workspace's public entry points (packages/text-engine/README.md).
export {
  clearEmbeddedFontBuilder,
  type EmbeddedFontBuildDiagnostic,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
  restoreEmbeddedFonts,
  snapshotEmbeddedFonts,
  trackGlyphInEmbedFont,
} from "@domotion/text-engine/font-resolution";
