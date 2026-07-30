// Post-processing public surface. Passes that run after `elementTreeToSvg` to
// shrink the output — all pure string-in / string-out. Most are opt-in;
// `hoistDuplicateImagePayloads` is applied automatically by the document
// producers (`wrapSvg`, `generateAnimatedSvg`, the scroll composer) and exposed
// here for callers that assemble a multi-frame document themselves.

export { optimizeSvg } from "./optimize.js";
export { hoistDuplicateImagePayloads, type HoistImagePayloadsOptions } from "./hoist-image-payloads.js";
export { compressEmbeddedFontsToWoff2 } from "./woff2-fonts.js";
export { gzipSvg } from "./gzip.js";
export { findFillBoxInClipOrMask, assertNoFillBoxInClipOrMask } from "./clip-transform-safety.js";
