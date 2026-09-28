/**
 * `@domotion/text-engine/font-resolution` — font selection, fallback, and the
 * process-global font registries: key/face resolution,
 * the per-codepoint and cluster fallback resolvers, webfont/local-alias
 * registration, render-text mode, glyph-definition and embedded-font generation
 * state, and the platform fallback tables' query functions.
 */
export { splitTextIntoFontRunsShaped } from "./render/cluster-fallback.js";
export {
  clearEmbeddedFontBuilder,
  type EmbeddedFontBuildDiagnostic,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
} from "./render/embedded-font-builder.js";
export {
  beginCharacterFallbackDocument,
  blinkGenericFamilyFromDeclaredStack,
  clearEmbeddedFonts,
  clearFontResolutionCaches,
  clearGlyphDefs,
  clearWebfonts,
  createFontFallbackSemanticContext,
  createFontRendererSession,
  declaredFamilyHeadIdentity,
  endCharacterFallbackDocument,
  ensureGlyphDef,
  fallbackFontChain,
  fontHasSupportedColorTable,
  type FontInstance,
  type FontRun,
  type FontVariantEmojiOverride,
  getEmbeddedFontFaceCss,
  getFontInstance,
  getFontSourceInfo,
  getGlyphDefs,
  getGlyphDefsSince,
  getRenderTextMode,
  getSessionGenericFamilyOverrides,
  glyphDefCount,
  glyphIdForCp,
  invalidateFontEnvironmentCaches,
  isRenderTextMode,
  ITALIC_SLNT,
  opticalCutOpszFor,
  platformFontKeys,
  registerLocalFontAlias,
  registerWebfont,
  RENDER_TEXT_MODES,
  type RenderTextMode,
  resetGeneration,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  restoreGeneration,
  selectCharacterFallbackRendererScope,
  type SessionGenericFamilyOverrides,
  setRenderTextMode,
  setSessionGenericFamilyOverrides,
  shapingFaceFor,
  skiaLastResortFamilyQuestionOrder,
  skiaLastResortInitialFamily,
  snapshotGeneration,
  stackPrimaryIsSystemUi,
  stretchPercent,
  truncateGlyphDefs,
  unicodeRangeCovers,
  win32FallbackChain,
  withFontRendererSession,
  withRenderTextMode,
  withSessionGenericFamilyOverrides,
  withSystemFallbackResolution,
} from "./render/font-resolution.js";
export { localeToScriptCodeForFontSelection } from "./render/generic-script-families.js";
export {
  faceNeedsSyntheticBold,
  faceNeedsSyntheticOblique,
  type FontSynthesisAllowance,
} from "./render/synthesis-decision.js";
export {
  blinkWinFallbackLocale,
  blinkWinHardcodedFamilies,
  winFallbackPriorityForTextRun,
  type WinGenericFamily,
} from "./render/win-font-fallback.js";
export { win32FamilySuffixAdjustment } from "./render/win32-family-suffix.js";
