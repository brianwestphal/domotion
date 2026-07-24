import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWebfont } from "../src/render/index.js";

/**
 * Deterministic faces for the frame-sequence compressor's e2e fixtures.
 *
 * WHY EVERY COMPRESSOR FIXTURE MUST USE THESE
 *
 * These fixtures assert pixel parity between a compressed run and the
 * uncompressed flipbook of the same state, bounded by the no-motion caps in
 * `src/review/compare-pngs.ts` (`strictCapsFor`). Both images come out of our
 * own renderer, so the caps only have to absorb the sub-pixel phase difference
 * the compressor's transform groups introduce — but how big that drift gets
 * depends on which glyph outlines are being rasterized.
 *
 * While the fixtures asked for host-dependent families (`Menlo`, `system-ui`,
 * `Georgia`) they resolved to a different face on every platform, so the clean
 * drift ceiling moved with the host: 88 px largest strict region on macOS
 * against 829 px in the Linux container, the latter overlapping a known
 * compressor break at 3712 px. No single cap could both pass a correct build
 * and fail a broken one, so the bar was calibrated on macOS only and degraded
 * to a weaker gate everywhere else. Pinning the fixtures to these bundled
 * faces collapses the ceiling to one number on every platform, which is what
 * lets ONE cap set gate all three.
 *
 * HOW TO USE IT — a fixture needs BOTH halves, for two different consumers:
 *
 *   1. Put `FIXTURE_FONT_CSS` in the page's `<style>` and reference
 *      `FIXTURE_MONO_STACK` / `FIXTURE_SERIF_STACK` from its rules. This is
 *      what CHROME lays out with, so it fixes the captured metrics.
 *   2. Call `registerFixtureFonts()` before capturing. This is what DOMOTION
 *      renders the glyph outlines from. Registering is idempotent-safe to
 *      repeat, and survives `clearEmbeddedFonts()` / `clearGlyphDefs()` (only
 *      `clearWebfonts()` drops it, which these fixtures don't call).
 *
 * Miss either half and the fixture silently goes back to a host font on one
 * side, reintroducing the platform spread the caps can't absorb.
 *
 * The files are subsetted from JetBrains Mono and IBM Plex Serif, both under
 * the SIL Open Font License 1.1 — see `assets/fonts/fixture/` for the license
 * text and `tools/build-fixture-fonts.mjs` to regenerate them.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts", "fixture");
const MONO_BYTES = readFileSync(join(DIR, "DomotionFixtureMono-Regular.ttf"));
const SERIF_BYTES = readFileSync(join(DIR, "DomotionFixtureSerif-Regular.ttf"));

export const FIXTURE_MONO_FAMILY = "Domotion Fixture Mono";
export const FIXTURE_SERIF_FAMILY = "Domotion Fixture Serif";

/** Use these in fixture CSS rather than naming the family directly — the
 *  generic tail is a visible-failure canary, not a real fallback: if the
 *  bundled face ever fails to load the text reflows obviously instead of
 *  quietly drifting. */
export const FIXTURE_MONO_STACK = `"${FIXTURE_MONO_FAMILY}", monospace`;
export const FIXTURE_SERIF_STACK = `"${FIXTURE_SERIF_FAMILY}", serif`;

/** `@font-face` rules to drop into a fixture page's `<style>`. Data URIs, so
 *  the page has no network dependency and no local-file access to negotiate. */
export const FIXTURE_FONT_CSS = `
  @font-face { font-family: "${FIXTURE_MONO_FAMILY}"; font-weight: 400; font-style: normal;
    src: url(data:font/ttf;base64,${MONO_BYTES.toString("base64")}) format("truetype"); }
  @font-face { font-family: "${FIXTURE_SERIF_FAMILY}"; font-weight: 400; font-style: normal;
    src: url(data:font/ttf;base64,${SERIF_BYTES.toString("base64")}) format("truetype"); }`;

/** Register the same bytes with the renderer. Call once at module scope in the
 *  fixture file — vitest forks per test file and nothing here calls
 *  `clearWebfonts()`, so one call covers every test in it. */
export function registerFixtureFonts(): void {
  registerWebfont(FIXTURE_MONO_FAMILY, 400, "normal", MONO_BYTES);
  registerWebfont(FIXTURE_SERIF_FAMILY, 400, "normal", SERIF_BYTES);
}
