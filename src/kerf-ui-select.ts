/**
 * Browser-side support for kerf-ui `Select` in Domotion's browser tools (the
 * svg-scrubber and Studio pages, plus the local `demos:review` harness). Import
 * it from a client entry that renders a `Select`. See
 * docs/273-ui-conventions.md.
 *
 * kerf-ui 5's `Select` renders a light-DOM `<kui-select>` root with a native
 * trigger button and a top-layer listbox. Its icons are inline SVG, so a page
 * that renders one makes no network request. `@kerfjs/ui/select/register`
 * defines the form-associated `kui-select` element and wires opening, keyboard
 * navigation and choosing for every Select in the document. It also announces
 * each choice with standard bubbling `input` and `change` events.
 */

import "@kerfjs/ui/select/register";

/** The `<kui-select>` element registered by `@kerfjs/ui/select/register`. */
interface KuiSelectElement extends Element {
  value: string | string[];
}

/** Read the chosen value of a single-value kerf `Select` (`<kui-select>`). */
export function selectValue(el: Element): string {
  const value = (el as KuiSelectElement).value;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Choose a value on a kerf `Select` programmatically (state → control). */
export function setSelectValue(el: Element, value: string): void {
  (el as KuiSelectElement).value = value;
}
