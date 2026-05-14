export { captureElementTree, captureElementTreeWithWarnings } from "./capture/index.js";
export { elementTreeToSvg, wrapSvg, rootSvgColorSchemeAttr, transparentRootBgRect } from "./render/element-tree-to-svg.js";
export { embedRemoteImages, embedResizedDataUri } from "./capture/embed.js";
export { getLastCaptureWarnings, logCaptureWarnings } from "./capture/warnings.js";
export { resizeEmbeddedImages } from "./tree-ops/resize-embedded-images.js";
export type { ResizeEmbeddedImagesOptions } from "./tree-ops/resize-embedded-images.js";
export type { CapturedElement, CaptureWarning } from "./capture/types.js";
export { generateAnimatedSvg } from "./animation/animator.js";
export type { AnimationConfig, AnimationFrame, Overlay, TypingOverlay, TapOverlay, SvgOverlay, IntraFrameAnimation } from "./animation/animator.js";
export type { CursorOverlay, CursorEvent, CursorMoveEvent, CursorClickEvent, CursorShowEvent, CursorHideEvent, CursorStyle, SelectorResolver } from "./animation/cursor-overlay.js";
export { DemoRecorder, launchChromium } from "./capture/index.js";
export type { CaptureOptions } from "./capture/index.js";
export { optimizeSvg } from "./post-processing/optimize.js";
export { gzipSvg } from "./post-processing/gzip.js";
export { cullFrame } from "./tree-ops/viewbox-culling.js";
export { diffTrees, dominantTranslate, entriesOfKind } from "./tree-ops/tree-diff.js";
export type { TreeDiff, DiffEntry, DiffEntryKind } from "./tree-ops/tree-diff.js";
export {
  parseScrollPattern,
  ScrollPatternError,
  executeScrollPattern,
  ScrollExecutionError,
  axisOfScroll,
  resolveAbsoluteTarget,
  resolveScrollAction,
  composeScrollSvg,
} from "./scroll/index.js";
export type {
  ScrollComposerOptions,
  ScrollExecutorOptions,
  ScrollSegmentCapture,
  Axis as ScrollAxis,
  PageStateSnapshot,
  SelectorBbox,
  PageQuery,
  Pattern as ScrollPattern,
  Segment as ScrollPatternSegment,
  BracketedSegment,
  FlatSegment,
  Action as ScrollPatternAction,
  ScrollAction,
  PauseAction,
  ScrollTarget,
  DeltaTarget,
  AbsoluteTarget,
  Anchor,
  NamedAnchor,
  SelectorAnchor,
  SignedLength,
  Length,
  Easing,
  UntilClause,
  PositionUntil,
  CountUntil,
} from "./scroll/index.js";
export { getGlyphDefs, clearGlyphDefs, registerWebfont, clearWebfonts } from "./render/text-to-path.js";
export { discoverAndRegisterWebfonts, attachWebfontTracker } from "./capture/index.js";
