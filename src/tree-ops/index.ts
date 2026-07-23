// Tree-ops public surface. Mutate / inspect / diff captured trees between
// capture and render — useful for resizing embedded images, viewBox culling
// before animation composition, and diffing two captures to drive merge.

export { cullElementsOutsideViewBox } from "./viewbox-culling.js";

export { annotateAnimatedProperties } from "./annotate-animated-properties.js";
export type { AnimatedPropertySpec } from "./annotate-animated-properties.js";

export { resizeEmbeddedImages } from "./resize-embedded-images.js";
export type { ResizeEmbeddedImagesOptions } from "./resize-embedded-images.js";

export { diffTrees } from "./tree-diff.js";
export type { TreeDiff, DiffEntry, DiffEntryKind } from "./tree-diff.js";

// NOTE: `propagateTextDecorations` (decoration-propagation.ts) is intentionally
// NOT re-exported — it runs automatically inside the renderer's
// `buildRenderState`, so callers never need to invoke it themselves.
