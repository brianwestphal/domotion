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
