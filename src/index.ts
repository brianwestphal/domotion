export { captureElementTree, captureElementTreeWithWarnings, elementTreeToSvg, wrapSvg, rootSvgColorSchemeAttr, transparentRootBgRect, getLastCaptureWarnings, logCaptureWarnings, embedRemoteImages, embedResizedDataUri } from "./dom-to-svg.js";
export { resizeEmbeddedImages } from "./resize-embedded-images.js";
export type { ResizeEmbeddedImagesOptions } from "./resize-embedded-images.js";
export type { CapturedElement, CaptureWarning } from "./dom-to-svg.js";
export { generateAnimatedSvg } from "./animator.js";
export type { AnimationConfig, AnimationFrame, Overlay, TypingOverlay, TapOverlay, SvgOverlay, IntraFrameAnimation } from "./animator.js";
export type { CursorOverlay, CursorEvent, CursorMoveEvent, CursorClickEvent, CursorShowEvent, CursorHideEvent, CursorStyle, SelectorResolver } from "./cursor-overlay.js";
export { DemoRecorder, launchChromium } from "./capture.js";
export type { CaptureOptions } from "./capture.js";
export { optimizeSvg, gzipSvg } from "./optimize.js";
export { cullFrame } from "./viewbox-culling.js";
export { parseScrollPattern, ScrollPatternError } from "./scroll-pattern.js";
export { diffTrees, dominantTranslate, entriesOfKind } from "./tree-diff.js";
export type { TreeDiff, DiffEntry, DiffEntryKind } from "./tree-diff.js";
export { executeScrollPattern, ScrollExecutionError, axisOfScroll, resolveAbsoluteTarget, resolveScrollAction } from "./scroll-executor.js";
export { composeScrollSvg } from "./scroll-composer.js";
export type { ScrollComposerOptions } from "./scroll-composer.js";
export type {
  ScrollExecutorOptions,
  ScrollSegmentCapture,
  Axis as ScrollAxis,
  PageStateSnapshot,
  SelectorBbox,
  PageQuery,
} from "./scroll-executor.js";
export type {
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
} from "./scroll-pattern.js";
export { getGlyphDefs, clearGlyphDefs, registerWebfont, clearWebfonts } from "./text-to-path.js";
export { discoverAndRegisterWebfonts, attachWebfontTracker } from "./capture.js";
