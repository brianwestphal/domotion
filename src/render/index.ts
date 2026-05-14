// Render-side public surface. Pure functions that take a captured element
// tree (or fragments of one) and emit SVG markup.

export {
  elementTreeToSvg,
  wrapSvg,
} from "./element-tree-to-svg.js";

export {
  getGlyphDefs,
  clearGlyphDefs,
  registerWebfont,
  clearWebfonts,
} from "./text-to-path.js";
