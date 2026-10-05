/**
 * `@domotion/text-engine/testing` — the unstable surface for the root
 * repository's oracles, probes, fixture tooling, and root tests: resolver and
 * shaping internals, helper/ICU queries, provenance and cache/registry
 * introspection, deterministic resets, platform overrides, and the
 * synthetic-font builder. NOT a stable API: any symbol may change or disappear
 * without a version bump.
 *
 * The stable entry points carry only what root production code imports, and
 * everything else a root tool or test still needs lives here. Root production
 * `src/` code must not import this entry (tests/conventions.test.ts), and every
 * symbol here must still be imported by a root tool or test
 * (src/render/text-engine-boundary.test.ts). Move a symbol to a stable entry
 * point when production starts needing it. Tests of engine internals live in
 * this workspace and import the modules directly.
 */
export {
  __skiaLastResortKeysForTest,
  __clusterFallbackCountersForTest,
  splitTextIntoFontRunsShaped,
} from "./render/cluster-fallback.js";
export {
  clearEmbeddedFontBuilder,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
} from "./render/embedded-font-builder.js";
export {
  type FakeBoldSvgPaintPass,
  resolveFakeBoldTextPaint,
  type SkiaFakeBoldPaintStage,
} from "./render/embolden-outline.js";
export { type SourcePriorityItem, sourcePriorityItems } from "./render/emoji-presentation-priority.js";
export {
  __resolveSystemFallbackKeyForCpForTest,
  __setWin32FamilyKeyResolverForTest,
  beginCharacterFallbackDocument,
  blinkGenericFamilyFromDeclaredStack,
  clearCharacterFallbackRendererScopesForTest,
  collectDarwinFontDataAfterOracleGc,
  clearPrimaryNotdefShapesAfterOracleGc,
  clearFontResolutionCaches,
  createFontFallbackSemanticContext,
  createFontRendererSession,
  declaredFamilyHeadIdentity,
  endCharacterFallbackDocument,
  darwinFontDataIdentity,
  darwinFontDataLruForTest,
  recordDarwinFontDataUse,
  hasPrimaryNotdefShape,
  primaryNotdefShapeKey,
  recordPrimaryNotdefShape,
  fallbackFontChain,
  fontHasSupportedColorTable,
  type FontInstance,
  type FontRun,
  getFontSourceInfo,
  getSessionGenericFamilyOverrides,
  glyphIdForCp,
  invalidateFontEnvironmentCaches,
  ITALIC_SLNT,
  opticalCutOpszFor,
  platformFontKeys,
  resetGeneration,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKeyChain,
  resolveFontSpec,
  selectCharacterFallbackRendererScope,
  setSessionGenericFamilyOverrides,
  shapingFaceFor,
  skiaLastResortFamilyQuestionOrder,
  skiaLastResortInitialFamily,
  stackPrimaryIsSystemUi,
  stretchPercent,
  win32FallbackChain,
  withFontRendererSession,
  withSessionGenericFamilyOverrides,
  withSystemFallbackResolution,
} from "./render/font-resolution.js";
export { createGlyphHelperFont } from "./render/glyph-helper-font.js";
export { isGlyphHelperAvailable, resolvedGlyphHelperPathForEvidence } from "./render/glyph-helper-transport.js";
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
export {
  harfbuzzGlyphQuery,
  harfbuzzShapeRun,
  registerHbBufferSource,
  type ShapeResult,
} from "./render/harfbuzz-shaper.js";
export { hbSubsetRetainGids, injectPuaCmap } from "./render/hb-subset.js";
export { assetNameFor } from "./render/helper-acquire.js";
export {
  helperAvailabilityContract,
  type HelperAvailabilityContract,
  helperRouteLedgerEnvironment,
} from "./render/helper-availability-contract.js";
export {
  acquireIcuCompanionSync,
  ICU_COMPANION_VERSION,
  resolveIcuCompanionTarget,
} from "./render/icu-helper-acquire.js";
export {
  ICU_BINARY,
  icuCodepointProperties,
  type IcuCodepointProperties,
  isIcuHelperAvailable,
  queryIcuCodepoints,
} from "./render/icu-helper.js";
export { profReset, profSnapshot } from "./render/render-profile.js";
export { segmentForShaping } from "./render/script-segmentation.js";
export { buildSfnt } from "./render/synth-test-fonts.js";
export { faceNeedsSyntheticBold, faceNeedsSyntheticOblique } from "./render/synthesis-decision.js";
export {
  getFixtureTextRunProvenance,
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
  type TextEmitterTransitionDiagnostic,
  type TextRunProvenanceDiagnostic,
  textRunProvenanceEnabled,
} from "./render/text-run-provenance.js";
export {
  glyphRasterRepresentation,
  positionShapedClusters,
  splitTextIntoGlyphPathRuns,
} from "./render/text-to-path.js";
export { isHarfbuzzDefaultIgnorable, usesHarfbuzzShaping } from "./render/unicode-classification.js";
export {
  blinkWinFallbackLocale,
  blinkWinHardcodedFamilies,
  winFallbackPriorityForTextRun,
  type WinGenericFamily,
} from "./render/win-font-fallback.js";
export { win32FamilySuffixAdjustment } from "./render/win32-family-suffix.js";
