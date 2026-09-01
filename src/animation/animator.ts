/**
 * Stable public facade for animated SVG composition.
 *
 * The implementation lives in `svg-generator.ts`; timeline arithmetic is
 * isolated in `frame-timeline.ts`. Keeping this facade preserves existing
 * imports while preventing CLI/capture plumbing from becoming part of the SVG
 * generator's ownership boundary.
 */

export * from "./svg-generator.js";
