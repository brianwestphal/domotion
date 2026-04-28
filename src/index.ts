export { captureElementTree, elementTreeToSvg, wrapSvg, getLastCaptureWarnings, logCaptureWarnings } from "./dom-to-svg.js";
export type { CapturedElement, CaptureWarning } from "./dom-to-svg.js";
export { generateAnimatedSvg } from "./animator.js";
export type { AnimationConfig, AnimationFrame, Overlay, TypingOverlay, TapOverlay, SvgOverlay, IntraFrameAnimation } from "./animator.js";
export { DemoRecorder, launchChromium } from "./capture.js";
export type { CaptureOptions } from "./capture.js";
export { optimizeSvg } from "./optimize.js";
export { getGlyphDefs, clearGlyphDefs } from "./text-to-path.js";
