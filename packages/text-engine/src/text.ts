/**
 * `@domotion/text-engine/text` — shaping and glyph emission: text-to-path
 * rendering, HarfBuzz shaping, script/bidi segmentation, Unicode and emoji
 * classification, decoration/ink metrics, synthetic-bold paint, and embedded
 * subset construction.
 */
export {
  type FakeBoldSvgPaintPass,
  resolveFakeBoldTextPaint,
  type SkiaFakeBoldPaintStage,
} from "./render/embolden-outline.js";
export { type SourcePriorityItem, sourcePriorityItems } from "./render/emoji-presentation-priority.js";
export {
  harfbuzzGlyphQuery,
  harfbuzzShapeRun,
  registerHbBufferSource,
  type ShapeResult,
} from "./render/harfbuzz-shaper.js";
export { hbSubsetRetainGids, injectPuaCmap } from "./render/hb-subset.js";
export { bidiLevelsFor, type BidiParagraphContext, segmentForShaping } from "./render/script-segmentation.js";
export {
  visualTextOnlyHiddenAttr,
  visualTextSemantics,
  withTextEngineVisualSemanticsSuppressed,
} from "./render/text-semantics.js";
export {
  computeSkipInkGaps,
  cssWeightOf,
  getDecorationMetrics,
  glyphRasterRepresentation,
  measureEmphasisMarkMetrics,
  measureInkMetrics,
  positionShapedClusters,
  renderRadicalGlyph,
  renderSourceOwnedTextBoundary,
  renderStretchyFenceGlyph,
  renderTextAsPath,
  selectedGlyphRasterSpans,
  splitTextIntoGlyphPathRuns,
} from "./render/text-to-path.js";
export {
  isHarfbuzzDefaultIgnorable,
  isStretchyFenceChar,
  usesHarfbuzzShaping,
} from "./render/unicode-classification.js";
