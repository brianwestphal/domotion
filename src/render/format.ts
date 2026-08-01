/**
 * Small number / string formatters used across the SVG renderer.
 *
 * - `r(n)`   — one-decimal-place number formatter for SVG coordinates / sizes.
 * - `esc(s)` — escape an arbitrary string for use as SVG attribute text.
 * - `stopFmt(n)` — four-decimal-place number formatter for gradient stop offsets
 *   (the extra precision keeps multi-stop gradients from snapping).
 */

export function r(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/**
 * Codepoints the XML 1.0 `Char` production does not admit, which therefore
 * cannot appear in SVG markup in ANY form — not raw, and not as a numeric
 * character reference either (the spec forbids referencing them, so `&#xFFFE;`
 * is just as fatal as the literal):
 *
 *     Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * So: the C0 controls other than tab/LF/CR, unpaired surrogates, and U+FFFE /
 * U+FFFF. Note the scope — the OTHER Unicode noncharacters are legal XML
 * (U+FDD0..U+FDEF fall inside `[#xE000-#xFFFD]`, and the per-plane pairs like
 * U+1FFFE inside `[#x10000-#x10FFFF]`), so this drops strictly less than
 * "noncharacters" and must not be conflated with `isNonCharacterCodepoint`.
 *
 * These reach the markup through the accessible name — the `aria-label` and
 * `<title>` carrying a text run's source characters — where a single U+FFFE
 * makes the whole document unparseable and the consumer renders a broken-image
 * icon instead of the drawing. That is a strictly worse failure than the glyph
 * question this came up alongside, and it is not hypothetical: Chrome paints a
 * `.notdef` box for U+FFFE, so a page containing one has visible text we render
 * correctly inside a document that then fails to open.
 *
 * Dropping is the right disposition rather than substituting U+FFFD: this is
 * accessibility text, the paint is unaffected (glyph outlines and advances are
 * emitted as geometry, and embedded-subset mode remaps every glyph to its own
 * private-use codepoint anyway), and a screen reader has nothing to say about a
 * codepoint permanently guaranteed never to be a character.
 */
const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function esc(s: string): string {
  return s
    .replace(XML_ILLEGAL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stopFmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/**
 * Build the root-`<svg>` accessibility bits (DM-1488): a `role="img"` attribute
 * plus `<title>`/`<desc>` child markup to inject as the FIRST children of the
 * root `<svg>`, so an inline-embedded demo has an accessible name for screen
 * readers. Emitted ONLY when an accessible name (`title`) is provided — an
 * `<svg role="img">` with no name is an a11y anti-pattern (announced as an
 * unlabeled image), so without a title we emit nothing and the output stays
 * byte-for-byte unchanged. (When embedded via `<img src alt>` the host `alt`
 * already names it; this covers the inline-`<svg>` case.)
 */
export function rootSvgA11y(title?: string, desc?: string): { roleAttr: string; markup: string } {
  if (title == null || title === "") return { roleAttr: "", markup: "" };
  const titleEl = `<title>${esc(title)}</title>`;
  const descEl = desc != null && desc !== "" ? `<desc>${esc(desc)}</desc>` : "";
  return { roleAttr: ` role="img"`, markup: titleEl + descEl };
}
