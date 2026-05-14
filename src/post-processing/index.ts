// Post-processing public surface. Optional passes that run after
// `elementTreeToSvg` to shrink the output. Both are pure string-in / string-out.

export { optimizeSvg } from "./optimize.js";
export { gzipSvg } from "./gzip.js";
