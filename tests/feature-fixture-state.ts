import { resetGeneration } from "@domotion/text-engine/testing";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearGlyphDefs, clearWebfonts, withRenderTextMode } from "../src/render/text-to-path.js";

/** A fixture begins with no browser URL accumulator or renderer font state. */
export function resetFeatureFixtureState(fontUrls: Set<string>): void {
  clearWebfonts();
  clearGlyphDefs();
  fontUrls.clear();
}

/**
 * Render one feature fixture's SVG body in `paths` mode, as its own generation.
 *
 * The paths-mode glyph registry is process-global, and the harness worker pool
 * runs fixtures concurrently in one process. A reset at the start of a fixture
 * is therefore not enough: every `await` between that reset and the render lets
 * other workers render and register their own `<path id="gN">` defs, which then
 * appeared, unreferenced, in this fixture's `<defs>` and shifted its ids, so the
 * emitted SVG depended on scheduling. `elementTreeToSvgInner` never awaits, so
 * resetting the generation inside the same synchronous call (the shape
 * `html-test-suite.tsx` uses) gives each fixture exactly its own defs, numbered
 * from `g0`.
 */
export function renderFixtureSvgInner(
  tree: Parameters<typeof elementTreeToSvgInner>[0],
  width: number,
  height: number,
): string {
  return withRenderTextMode("paths", () => {
    resetGeneration();
    return elementTreeToSvgInner(tree, width, height);
  });
}
