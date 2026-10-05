/** Compatibility barrel for font resolution. Implementation lives in focused modules. */
export type { BlinkGenericFamily } from "../font-family-stack.js";
export { getEmbeddedFontBuildDiagnostics, withHintedSubsetEnabled } from "./embedded-font-builder.js";
export type { EmbeddedFontBuildDiagnostic, HintedSourceDisqualificationReason } from "./embedded-font-builder.js";
export { restoreEmbeddedFonts, snapshotEmbeddedFonts } from "./embedded-font-builder.js";
export type { EmbeddedFontSnapshot } from "./embedded-font-builder.js";
export * from "./win-font-fallback.js";
export {
  mathAlphaToBase,
  isLegitimatelyInklessCodepoint,
  isHarfbuzzSameFontSpaceFallback,
  complexShaperBaseMarkDecomposition,
  nfdBaseMarkDecomposition,
  isStrippableOrphanIgnorable,
  usesComplexShaperDottedCircle,
  isLeftReorderingMatra,
  isStretchyFenceChar,
} from "./unicode-classification.js";
export { WebfontSynthesisFace } from "./font-instance.js";
export { FontInstance } from "./font-instance.js";
export { glyphIdForCp } from "./font-instance.js";
export { fontCoversCp } from "./font-instance.js";
export { RenderTextMode } from "./render-text-mode.js";
export { RENDER_TEXT_MODES } from "./render-text-mode.js";
export { isRenderTextMode } from "./render-text-mode.js";
export { currentRenderTextMode } from "./render-text-mode.js";
export { setRenderTextMode } from "./render-text-mode.js";
export { getRenderTextMode } from "./render-text-mode.js";
export { withRenderTextMode } from "./render-text-mode.js";
export { clearEmbeddedFonts } from "./generation.js";
export { resetGeneration } from "./generation.js";
export { getEmbeddedFontFaceCss } from "./generation.js";
export { registerWebfont } from "./webfont-registry.js";
export { parseFontStretchDescriptor } from "./webfont-registry.js";
export { parseFontWeightDescriptor } from "./webfont-registry.js";
export { parseFontStyleDescriptor } from "./webfont-registry.js";
export { BLINK_ITALIC_SLOPE_VALUE } from "./webfont-registry.js";
export { BLINK_NORMAL_SLOPE } from "./webfont-registry.js";
export { webfontSyntheticBold } from "./webfont-registry.js";
export { webfontSyntheticItalic } from "./webfont-registry.js";
export { unicodeRangeCovers } from "./webfont-registry.js";
export { pickWebfontVariantForCodepoint } from "./webfont-registry.js";
export { webfontVariantsInDeclarationOrder } from "./webfont-registry.js";
export { __pickWebfontVariantMetaForTest } from "./webfont-registry.js";
export { __pickWebfontVariantMetaForCodepointForTest } from "./webfont-registry.js";
export { clearWebfonts } from "./webfont-registry.js";
export { FontRegistrationSnapshot } from "./webfont-registry.js";
export { snapshotFontRegistrations } from "./webfont-registry.js";
export { restoreFontRegistrations } from "./webfont-registry.js";
export { emptyFontRegistrations } from "./webfont-registry.js";
export { registerLocalFontAlias } from "./webfont-registry.js";
export { __pickLocalFontAliasVariantForTest } from "./webfont-registry.js";
export { ITALIC_SLNT } from "./font-paths.darwin.js";
export { __resetLinuxFontProfileForTest } from "./font-paths.linux.js";
export { __linuxFontProfileForTest } from "./font-paths.linux.js";
export { win } from "./font-paths.win32.js";
export { platformFontKeys } from "./font-spec.js";
export { resolveFontSpec } from "./font-spec.js";
export { __systemFallbackKeyCacheSizeForTest } from "./font-spec.js";
export { setSystemFallbackResolution } from "./system-fallback-resolver.js";
export { getSystemFallbackResolution } from "./system-fallback-resolver.js";
export { withSystemFallbackResolution } from "./system-fallback-resolver.js";
export { stackPrimaryIsSystemUi } from "./system-fallback-resolver.js";
export { FontRendererSession } from "./system-fallback-resolver.js";
export { createFontRendererSession } from "./system-fallback-resolver.js";
export {
  darwinFontDataIdentity,
  darwinFontDataLruForTest,
  recordDarwinFontDataUse,
} from "./darwin-font-data-lifetime.js";
export { withFontRendererSession } from "./system-fallback-resolver.js";
export { beginCharacterFallbackDocument } from "./system-fallback-resolver.js";
export { endCharacterFallbackDocument } from "./system-fallback-resolver.js";
export {
  collectDarwinFontDataAfterOracleGc,
  clearPrimaryNotdefShapesAfterOracleGc,
  hasPrimaryNotdefShape,
  primaryNotdefShapeKey,
  recordPrimaryNotdefShape,
} from "./system-fallback-resolver.js";
export { selectCharacterFallbackRendererScope } from "./system-fallback-resolver.js";
export { clearCharacterFallbackRendererScopesForTest } from "./system-fallback-resolver.js";
export { __characterFallbackDocumentCacheForTest } from "./system-fallback-resolver.js";
export { __characterFallbackIdentityForTest } from "./system-fallback-resolver.js";
export { resolveSystemFallbackKeyForCp } from "./system-fallback-resolver.js";
export { fcLangProperty } from "./emoji-presentation.js";
export { isEmojiPresentationCp } from "./emoji-presentation.js";
export { FontVariantEmojiOverride } from "./emoji-presentation.js";
export { isEmojiCharCp } from "./emoji-presentation.js";
export { forcesEmojiPresentation } from "./emoji-presentation.js";
export { fontHasSupportedColorTable } from "./emoji-presentation.js";
export { resolveColorEmojiKeyForCp } from "./system-fallback-resolver.js";
export { blinkEmojiFallbackQuery } from "./system-fallback-resolver.js";
export { __resolveSystemFallbackKeyForCpForTest } from "./system-fallback-resolver.js";
export { __resolveFontSpecForTest } from "./font-spec.js";
export { __resolveDarwinFontSpecForTest } from "./font-spec.js";
export { pingfangKeyForLang } from "./font-spec.js";
export { linuxFallbackChain } from "./fallback-chain.linux.js";
export { __darwinPrimaryCutKeyForTest } from "./family-match.js";
export { blinkAlternateFamilyName } from "./family-match.js";
export { __setWin32FamilyKeyResolverForTest } from "./family-match.js";
export { win32FallbackChain } from "./fallback-chain.win32.js";
export { fallbackFontChain } from "./fallback-chain.js";
export { CssFallbackDescription } from "./fallback-chain.js";
export { FontFallbackSemanticContext } from "./fallback-chain.js";
export { createFontFallbackSemanticContext } from "./fallback-chain.js";
export { skiaLastResortInitialFamily } from "./fallback-chain.js";
export { skiaLastResortFamilyQuestionOrder } from "./fallback-chain.js";
export { skiaLastResortInitialKey } from "./fallback-chain.js";
export { splitDeclaredFontFamily } from "./fallback-chain.js";
export { blinkGenericFamilyFromDeclaredStack } from "./fallback-chain.js";
export { declaredFamilyHeadIdentity } from "./fallback-chain.js";
export { darwinFallbackChain } from "./fallback-chain.darwin.js";
export { fallbackFontKey } from "./fallback-chain.js";
export { isPrivateUseCodepoint } from "./fallback-chain.js";
export { isNonCharacterCodepoint } from "./fallback-chain.js";
export { subBoldWeightCutSuffix } from "./font-instance.js";
export { hiraginoWeightCut } from "./font-instance.js";
export { __darwinSystemUiWdthForTest } from "./font-instance.js";
export { fontInstanceCacheKey } from "./font-instance.js";
export { getFontInstance } from "./font-instance.js";
export { getFontSourceInfo } from "./font-instance.js";
export { FontSourceInfo } from "./font-instance.js";
export { fontHasOutlineTable } from "./font-instance.js";
export { PathCommand } from "./font-instance.js";
export { __fontShapeRouteForTest } from "./font-instance.js";
export { FileFaceInfo } from "./font-instance.js";
export { makeFontkitShaper } from "./font-instance.js";
export { __resolveFaceInfoForFileForTest } from "./font-instance.js";
export { __registerDynamicSystemFontForTest } from "./font-instance.js";
export { shapingFaceFor } from "./font-instance.js";
export { resolveAxisLocationForFile } from "./font-instance.js";
export { resolveDarwinAxisLocation } from "./font-instance.js";
export { DarwinHandleAxis } from "./font-instance.js";
export { darwinCloneInstanceName } from "./font-instance.js";
export { GlyphCommandDisposition } from "./font-instance.js";
export { GlyphCommandResolution } from "./font-instance.js";
export { CoreTextDesignOutlineEligibility } from "./font-instance.js";
export { coreTextDesignOutlineEligibility } from "./font-instance.js";
export { EmptyGlyphOutlineEvidence } from "./font-instance.js";
export { classifyEmptyGlyphOutline } from "./font-instance.js";
export { resolveGlyphCommands } from "./font-instance.js";
export { commandsFor } from "./font-instance.js";
export { __clearGlyphFallbackCachesForTest } from "./font-instance.js";
export { skiaFamilyMatchAcceptable } from "./family-match.js";
export { __authorFamilyAvailableForTest } from "./family-match.js";
export { __familyAvailabilityCacheKeysForTest } from "./family-match.js";
export { SessionGenericFamilyOverrides } from "./family-match.js";
export { setSessionGenericFamilyOverrides } from "./family-match.js";
export { getSessionGenericFamilyOverrides } from "./family-match.js";
export { withSessionGenericFamilyOverrides } from "./family-match.js";
export { genericSettingsFamilyName } from "./family-match.js";
export { resolveFontKey } from "./family-match.js";
export { resolveFontKeyChain } from "./family-match.js";
export { opticalCutOpszFor } from "./family-match.js";
export { stretchPercent } from "./family-match.js";
export { resolveFont } from "./family-match.js";
export { ensureGlyphDef } from "./generation.js";
export { getGlyphDefs } from "./generation.js";
export { glyphDefCount } from "./generation.js";
export { getGlyphDefsSince } from "./generation.js";
export { clearFontResolutionCaches } from "./generation.js";
export { registerFontEnvironmentInvalidator } from "./generation.js";
export { invalidateFontEnvironmentCaches } from "./generation.js";
export { __primaryCutCacheSizesForTest } from "./generation.js";
export { __seedPrimaryCutCachesForTest } from "./generation.js";
export { clearGlyphDefs } from "./generation.js";
export { truncateGlyphDefs } from "./generation.js";
export { GlyphDefsSnapshot } from "./generation.js";
export { snapshotGlyphDefs } from "./generation.js";
export { restoreGlyphDefs } from "./generation.js";
export { GenerationSnapshot } from "./generation.js";
export { snapshotGeneration } from "./generation.js";
export { restoreGeneration } from "./generation.js";
export type { TextPathOwnershipSpan, TextPathOwnership, TextPathResult } from "./text-to-path.js";
export { resolveDottedCircleHbRun } from "./shaping-route.js";
export { AlternateHalfWidthInfo } from "./shaping-route.js";
export { haltInfoFor } from "./shaping-route.js";
export { glyphInkXRange } from "./shaping-route.js";
export { codepointResolvesToNotdef } from "./shaping-route.js";
export { resolvedFaceNeedsHarfbuzzShaping } from "./shaping-route.js";
export { resolvedFaceUsesDefaultOpenTypeShaper } from "./shaping-route.js";
export { harfbuzzShapedRunOverride } from "./shaping-route.js";
export { webfontShapingFace } from "./shaping-route.js";
export { fontFeatureValueShapingOverride } from "./shaping-route.js";
export { FontStageStats } from "./codepoint-resolver.js";
export { __getFontStageStatsForTest } from "./codepoint-resolver.js";
export { __resetFontStageStatsForTest } from "./codepoint-resolver.js";
export { resolveFontForCodepoint } from "./codepoint-resolver.js";
export { coveredFontResolution } from "./codepoint-resolver.js";
export { __resolveFontForCodepointForTest } from "./codepoint-resolver.js";
export { FontRun } from "./codepoint-resolver.js";
export { DecorationMetrics } from "./decoration-geometry.js";
export { mergeGaps } from "./decoration-geometry.js";
export { glyphPathIntercepts } from "./decoration-geometry.js";
