import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import {
  createTextEngineSession,
  withTextEngineDocument,
  type TextEngineDocumentCallback,
  type TextEngineSession,
} from "../src/render/text-engine.js";

/**
 * Begin one feature fixture: clear its browser font-URL accumulator and return
 * the text-engine session that owns its webfont registrations.
 *
 * The harness worker pool runs fixtures concurrently in one process, and the
 * webfont registry behind the legacy `registerWebfont` / `clearWebfonts` API is
 * process-global. A fixture used to clear that registry at its start, then
 * await page load, the screenshot, discovery, capture, image embedding and
 * conic rasterization before rendering, so another worker starting a fixture
 * during those awaits wiped this fixture's discovered webfonts and its render
 * fell back to system fonts. Discovery cannot move into the synchronous render
 * because it is async, so each fixture registers into its own session instead
 * (pass it to `discoverAndRegisterWebfonts`), the same shape the production
 * `CaptureSession` uses. Nothing here touches the ambient registry, so no
 * fixture can clear another's.
 */
export function resetFeatureFixtureState(fontUrls: Set<string>): TextEngineSession {
  fontUrls.clear();
  return createTextEngineSession({ defaultRenderTextMode: "paths" });
}

/**
 * Run one synchronous render as a feature fixture's own `paths`-mode document:
 * exactly the fixture session's webfonts, and a fresh glyph generation.
 *
 * The paths-mode glyph registry is process-global too. Resetting the generation
 * inside the same synchronous call (not at the start of the fixture) keeps other
 * workers' `<path id="gN">` defs, registered during this fixture's awaits, out
 * of its `<defs>`, so each fixture's defs are its own and numbered from `g0`.
 */
export function renderFixtureDocument<T>(session: TextEngineSession, render: TextEngineDocumentCallback<T>): T {
  return withTextEngineDocument({ session, generation: "reset", renderTextMode: "paths" }, render).value;
}

/** Render one feature fixture's SVG body (see `renderFixtureDocument`). */
export function renderFixtureSvgInner(
  session: TextEngineSession,
  tree: Parameters<typeof elementTreeToSvgInner>[0],
  width: number,
  height: number,
): string {
  return renderFixtureDocument(session, () => elementTreeToSvgInner(tree, width, height));
}
