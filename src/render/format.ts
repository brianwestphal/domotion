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

export function esc(s: string): string {
  return s
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
