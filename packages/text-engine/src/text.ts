/**
 * `@domotion/text-engine/text` — text emission for the root renderer:
 * text-to-path rendering, bidi levels, visual-text semantics, decoration/ink and
 * emphasis-mark metrics, and stretchy-fence/radical glyphs. Sized to what root
 * production code imports; the shaping and segmentation internals the root
 * oracles probe live on `./testing`.
 */
export { bidiLevelsFor, type BidiParagraphContext } from "./render/script-segmentation.js";
export {
  visualTextOnlyHiddenAttr,
  visualTextSemantics,
  withTextEngineVisualSemanticsSuppressed,
} from "./render/text-semantics.js";
export {
  computeSkipInkGaps,
  cssWeightOf,
  getDecorationMetrics,
  measureEmphasisMarkMetrics,
  measureInkMetrics,
  measureTruncationMarker,
  renderRadicalGlyph,
  renderSourceOwnedTextBoundary,
  renderStretchyFenceGlyph,
  renderTextAsPath,
  selectedGlyphRasterSpans,
} from "./render/text-to-path.js";
export { isStretchyFenceChar } from "./render/unicode-classification.js";
