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
  // DM-839: embedded-font is the default render mode; expose the controls so
  // consumers can opt back into per-pixel-faithful `paths` mode and manage the
  // embedded-font lifecycle.
  setRenderTextMode,
  getRenderTextMode,
  clearEmbeddedFonts,
  getEmbeddedFontFaceCss,
  type RenderTextMode,
} from "./text-to-path.js";
