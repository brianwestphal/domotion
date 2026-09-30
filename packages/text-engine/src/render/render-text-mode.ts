/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { invokeSynchronousCallback, type SynchronousCallback } from "./synchronous-scope.js";

// ── Text render mode (DM-652 / DM-655 / DM-839) ──
// `embedded-font` (the DEFAULT, DM-839): the renderer emits `<text>` elements
// against a `@font-face`-declared subset TTF built from the captured glyph
// outlines, addressed by private-use codepoints so the consumer browser does
// zero shaping. `paths`: the renderer emits `<use href="#gN">` references into
// per-glyph `<path>` defs.
//
// Tradeoff: embedded-font hands rasterization to the consumer browser's text
// engine (its own hinting / AA), so output isn't byte-identical across
// browsers — but it's far smaller and faster for text-heavy content (the
// compositor caches the rasterized glyph atlas; WebKit scroll composites that
// ran at 14.7 fps in paths mode jump back toward Chromium's 119 fps). `paths`
// is the per-pixel-faithful mode; opt back into it via `setRenderTextMode`
// (e.g. for visual-regression diffing against the live Chromium paint).
//
// Lifecycle: top-level SVG producers must `clearEmbeddedFonts()` before
// rendering and emit `getEmbeddedFontFaceCss()` into the output `<style>` once
// (single-frame producers do this via `elementTreeToSvg`'s `includeGlyphDefs`
// defs block; multi-frame producers — animator, scroll composer — collect it
// at the top level). The `paths`-mode glyph registry (`getGlyphDefs()`) shares
// this exact per-generation lifecycle, so producers call `clearGlyphDefs()`
// alongside `clearEmbeddedFonts()` — otherwise the module-global glyph map
// accumulates across renders and back-to-back generations emit prior glyphs as
// dead `<defs>` bloat (DM-1338).
// `"system-font"` (DM-2716) is an OPT-IN departure from the pixel-faithful
// contract: text emits as ordinary painted `<text>` carrying the authored
// `font-family` stack, and the CONSUMER's installed fonts paint it — no
// embedded `@font-face` subset (`"embedded-font"`) and no glyph outlines
// (`"paths"`). Positioning is run-anchor-only: the run's captured origin is
// emitted and the viewing browser reflows with the system font's own metrics,
// so horizontal positions drift from the capture when the viewer's font differs
// from the capture host's. Chosen for smaller output where the fonts are known
// to be present.
export type RenderTextMode = "paths" | "embedded-font" | "system-font";

/** The valid `RenderTextMode` values, in the order shown in CLI help. Shared by
 *  the `capture` and `animate` CLIs so `--text-mode`'s accepted set lives in one
 *  place next to the type (DM-2716 / DM-FJZQ34). */
export const RENDER_TEXT_MODES: readonly RenderTextMode[] = ["embedded-font", "paths", "system-font"];

export function isRenderTextMode(value: string): value is RenderTextMode {
  return (RENDER_TEXT_MODES as readonly string[]).includes(value);
}

export let currentRenderTextMode: RenderTextMode = "embedded-font";

export function setRenderTextMode(mode: RenderTextMode): void {
  currentRenderTextMode = mode;
}

export function getRenderTextMode(): RenderTextMode {
  return currentRenderTextMode;
}

/**
 * Run `fn` with the module-global render-text mode set to `mode`, restoring the
 * prior value afterward — even if `fn` throws. `currentRenderTextMode` is a
 * PROCESS-GLOBAL, so a caller that flips it with a bare `setRenderTextMode` and
 * forgets to restore leaks the mode into every later render in the same process.
 * Prefer this save/restore wrapper for a scoped change (mirrors
 * `withSystemFallbackResolution`, DM-1350 / DM-1435). Async/Promise-like
 * callbacks are rejected at the type boundary and at runtime because the mode
 * cannot remain process-globally scoped across an `await` (DM-2637).
 */
export function withRenderTextMode<F extends () => unknown>(
  mode: RenderTextMode,
  fn: SynchronousCallback<F>,
): ReturnType<F> {
  const prev = currentRenderTextMode;
  currentRenderTextMode = mode;
  try {
    return invokeSynchronousCallback("withRenderTextMode", fn);
  } finally {
    currentRenderTextMode = prev;
  }
}
