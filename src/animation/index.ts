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

export {
  cursorOverlayMarkup,
  resolveCursorScript,
  type CursorOverlay,
  type CursorEvent,
  type CursorMoveEvent,
  type CursorClickEvent,
  type CursorShowEvent,
  type CursorHideEvent,
  type CursorStyle,
  type SelectorResolver,
} from "./cursor-overlay.js";
