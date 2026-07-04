// Post-processing public surface. Optional passes that run after
// `elementTreeToSvg` to shrink the output. Both are pure string-in / string-out.

export { optimizeSvg } from "./optimize.js";
export { compressEmbeddedFontsToWoff2 } from "./woff2-fonts.js";
export { gzipSvg } from "./gzip.js";
export { findFillBoxInClipOrMask, assertNoFillBoxInClipOrMask } from "./clip-transform-safety.js";
