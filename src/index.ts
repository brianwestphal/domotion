export { captureElementTree, elementTreeToSvg, wrapSvg, getLastCaptureWarnings, logCaptureWarnings } from "./dom-to-svg.js";
export type { CapturedElement, CaptureWarning } from "./dom-to-svg.js";
export { generateAnimatedSvg } from "./animator.js";
export type { AnimationConfig, AnimationFrame, Overlay, TypingOverlay, TapOverlay } from "./animator.js";
export { DemoRecorder, launchChromium } from "./capture.js";
export type { CaptureOptions } from "./capture.js";
export { optimizeSvg } from "./optimize.js";
export { wrapWithChrome, buildChrome } from "./chrome.js";
export type { DeviceChromeConfig, DeviceChromeKind, ChromeFrame } from "./chrome.js";
