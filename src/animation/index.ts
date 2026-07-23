// Public surface of the animation pipeline. The composer
// (`generateAnimatedSvg`) consumes per-frame element trees + transition /
// overlay config and emits one self-contained SVG with `@keyframes` cross-
// fade / push-left / scroll / cut / magic-move transitions and optional
// typing / tap / SVG / cursor overlays.

export {
  buildMagicMove,
  type MagicMove,
  type MagicMoveSlide,
} from "./magic-move.js";

// DM-1323: general animated-SVG compositing — stack already-rendered (animated)
// SVGs into one, each placed + on its own timeline, with animation intact.
export {
  composeAnimatedLayers,
  type CompositeLayer,
  type CompositeLayerAnimation,
  type ComposeLayersOptions,
  type CompositeResult,
} from "./composite.js";

// DM-1319 / DM-1323: the nesting building blocks (namespace + per-layer timeline)
// exposed for callers assembling composites by hand.
export { namespaceEmbeddedAnimatedSvg, type NamespaceEmbedOptions } from "./embed-namespace.js";
export { offsetEmbeddedAnimatedSvgTimeline, type OffsetTimelineOptions, type EmbeddedTimelineMode } from "./embed-timeline.js";

export {
  generateAnimatedSvg,
  type AnimationConfig,
  type AnimationFrame,
  type AnimationOverlay,
  type TypingOverlay,
  type TapOverlay,
  type SvgOverlay,
  type IntraFrameAnimation,
} from "./animator.js";

// Caret + selection track (docs/101): node-side captured-text addressing plus
// the declarative caret / selection track `generateAnimatedSvg` layers above
// frame content via `AnimationConfig.textTracks`.
export {
  resolveCaretPoint,
  resolveRangeRects,
  findAddressedElement,
  addressableLength,
  type TextAddressTarget,
  type CaretPoint,
  type SelectionRectPlan,
  type RangeRects,
} from "./text-address.js";
export {
  resolveTextTrack,
  textTrackMarkup,
  CARET_BLINK_MS,
  DEFAULT_SELECTION_COLOR,
  type TextTrackSpec,
  type TextTrackSpecEvent,
  type ResolvedTextTrack,
  type ResolvedCaretWaypoint,
  type ResolvedSelection,
} from "./caret-track.js";

export {
  cursorOverlayMarkup,
  resolveCursorScript,
  cursorAtPoint,
  type CursorOverlay,
  type CursorEvent,
  type CursorMoveEvent,
  type CursorClickEvent,
  type CursorShowEvent,
  type CursorHideEvent,
  type CursorStyle,
  type CursorTimelineEntry,
  type SelectorResolver,
  type CursorAtResolver,
} from "./cursor-overlay.js";
export { CURSOR_GLYPHS, CURSOR_CATEGORIES, cursorGlyphSvg, type CursorGlyph } from "./cursor-glyphs.js";

// DM-1132: lower selector-anchored overlays into concrete-coordinate overlays
// against a live page — the resolution step the declarative CLI uses, now
// reachable by imperative `captureElementTree` + `generateAnimatedSvg` callers.
export { resolveOverlays, type OverlayAnchor, type AnchoredOverlay } from "./resolve-overlays.js";

// DM-1526: named motion + easing preset vocabulary for intra-frame animations.
export {
  EASING_PRESETS,
  easingPresetNames,
  resolveEasingPreset,
  motionPresetNames,
  resolveMotionPreset,
  type ResolvedMotion,
  type MotionPresetOptions,
  type PresetFuseTrack,
} from "./motion-presets.js";
