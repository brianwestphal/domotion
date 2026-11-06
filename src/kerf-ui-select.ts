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

/**
 * Temporary workaround for a kerf-ui 5 positioning bug. `positionPopup` bounds
 * the listbox by `document.documentElement` with fixed positioning, and that
 * boundary is offset by the scroll distance, so in a scrolled page (Studio)
 * the popup can open on the wrong side, squeezed to a few pixels. A floor on
 * its height (CSS lets `min-height` win over the inline `max-height`) keeps
 * the list usable. The floor grows with the option count but stays under the
 * real row height (about 3rem), so a short list never gains empty space.
 * Remove this once kerf-ui bounds the popup by the viewport.
 */
export const SELECT_POPUP_FLOOR_CSS = [2, 3, 4, 5, 6]
  .map(
    (n) =>
      `kui-select > .kui-select__popup:has([role="option"]:nth-child(${n})) { min-height: min(${n * 2.5}rem, 40vh); }`,
  )
  .join("\n");
const floor = document.createElement("style");
floor.setAttribute("data-kerf-ui-select-floor", "");
floor.textContent = SELECT_POPUP_FLOOR_CSS;
document.head.append(floor);

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
