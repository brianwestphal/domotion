/**
 * `@domotion/text-engine/font-resolution` — the font-selection state Domotion's
 * renderer drives: family-key and face lookup, webfont/local-alias
 * registration, render-text mode, and glyph-definition and embedded-font
 * generation state. Sized to what root production code imports; the resolver
 * internals the root oracles probe live on `./testing`.
 */
export {
  type EmbeddedFontBuildDiagnostic,
  type EmbeddedFontEmbeddingRestriction,
  takeEmbeddedFontEmbeddingRestrictions,
} from "./render/embedded-font-builder.js";
export {
  clearEmbeddedFonts,
  clearGlyphDefs,
  clearWebfonts,
  type FontVariantEmojiOverride,
  getEmbeddedFontFaceCss,
  getFontInstance,
  getGlyphDefs,
  getGlyphDefsSince,
  getRenderTextMode,
  glyphDefCount,
  isRenderTextMode,
  registerLocalFontAlias,
  registerWebfont,
  type RegisteredFontFamily,
  RENDER_TEXT_MODES,
  type RenderTextMode,
  resolveFontKey,
  restoreGeneration,
  type SessionGenericFamilyOverrides,
  setRenderTextMode,
  snapshotGeneration,
  truncateGlyphDefs,
  withRenderTextMode,
} from "./render/font-resolution.js";
export { linuxFontEnvironmentKey } from "./render/linux-font-render-style.js";
export type { FontRenderHinting, LinuxFontRenderContext } from "./render/linux-font-render-style.js";
export { isolatedPrimaryFontMetrics } from "./render/isolated-primary-font-metrics.js";
export type { IsolatedFontFace } from "./render/isolated-primary-font-metrics.js";
export { localeToScriptCodeForFontSelection } from "./render/generic-script-families.js";
export { type FontSynthesisAllowance } from "./render/synthesis-decision.js";
