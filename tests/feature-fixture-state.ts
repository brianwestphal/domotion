import { clearGlyphDefs, clearWebfonts } from "../src/render/text-to-path.js";

/** A fixture begins with no browser URL accumulator or renderer font state. */
export function resetFeatureFixtureState(fontUrls: Set<string>): void {
  clearWebfonts();
  clearGlyphDefs();
  fontUrls.clear();
}
