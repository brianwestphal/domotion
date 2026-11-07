/**
 * `@supports` in an `<img>` SVG document's own sheets, decided by Chromium.
 *
 * Whether a supports condition holds depends on Chromium's CSS parser
 * (`CSSSupportsParser::ConsumeSupportsCondition`), which a Node-side
 * reimplementation could only approximate. So capture asks the page itself:
 * every condition found in an `<img>` SVG's sheets is decided there and
 * recorded on the `<img>` capture record (`CapturedElement.imageSvgSupports`),
 * keyed by {@link supportsConditionKey}. The renderer then freezes a decided
 * `@supports` block like an `@media` one, and the root-transform cascade treats
 * it as a decided conditional group.
 */
import { expandXmlReferences } from "./svg-image-selector-engine.js";

/** Blank comments, CDATA markers and HTML comment markers (same length). */
function blankNoise(css: string): string {
  const blank = (m: string): string => " ".repeat(m.length);
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!\[CDATA\[|\]\]>/g, blank)
    .replace(/<!--|-->/g, blank);
}

/** The lookup key of an `@supports` prelude (comments already blanked):
 *  whitespace runs collapse to one space, as Blink's `SimplifyWhiteSpace`
 *  serializes the prelude (css_parser_impl.cc:1465-1469, chromium 7d859f27). */
export function supportsConditionKey(prelude: string): string {
  return prelude.replace(/\s+/g, " ").trim();
}

/** One `@supports` condition of an image sheet: its key, and the text the
 *  DOM's sheet holds (XML references expanded outside CDATA). */
export interface ImageSupportsCondition {
  key: string;
  condition: string;
}

/** Every `@supports` condition in the SVG source's `<style>` sheets. */
export function collectImageSupportsConditions(svgText: string): ImageSupportsCondition[] {
  const out = new Map<string, ImageSupportsCondition>();
  for (const style of svgText.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1];
    const cdata = [...css.matchAll(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g)].map((m): [number, number] => [
      m.index,
      m.index + m[0].length,
    ]);
    const clean = blankNoise(css);
    for (const m of clean.matchAll(/@supports\b([^{}]*)\{/gi)) {
      const key = supportsConditionKey(m[1]);
      if (key === "" || out.has(key)) continue;
      const inCdata = cdata.some(([from, to]) => m.index >= from && m.index < to);
      const condition = inCdata ? key : expandXmlReferences(key);
      // A DTD-defined entity leaves the DOM text unknown: leave it undecided.
      if (condition != null) out.set(key, { key, condition });
    }
  }
  return [...out.values()];
}

/** The recorded answer for an `@supports` prelude, or null when capture did
 *  not decide it. */
export function decideImageSupports(
  prelude: string,
  decided: Readonly<Record<string, boolean>> | null | undefined,
): boolean | null {
  if (decided == null) return null;
  const key = supportsConditionKey(prelude);
  return Object.hasOwn(decided, key) ? decided[key] : null;
}
