/**
 * Browser-test helpers for kerf-ui `Select` controls (`<kui-select>`), which
 * replaced the browser tools' native `<select>` elements. Playwright's
 * `selectOption` / `inputValue` work only on native controls, so tests open the
 * Select through its trigger and choose an option the way a person does.
 *
 * `control` may be the `<kui-select>` root or any element inside it, such as
 * the trigger button `getByLabel` / `getByRole("combobox")` returns.
 */

import type { Locator } from "@playwright/test";

function selectRoot(control: Locator): Locator {
  return control.locator("xpath=ancestor-or-self::kui-select[1]");
}

/** Open the Select and choose the option with this value (or visible label). */
export async function chooseKerfSelectOption(control: Locator, choice: string | { label: string }): Promise<void> {
  const root = selectRoot(control);
  await root.locator(":scope > [role=combobox]").click();
  const option =
    typeof choice === "string"
      ? root.locator(`[role=option][data-value="${choice.replaceAll('"', '\\"')}"]`)
      : root.getByRole("option", { name: choice.label, exact: true });
  await option.click();
}

/** The Select's current value, read from the registered element. */
export async function kerfSelectValue(control: Locator): Promise<string> {
  return selectRoot(control).evaluate((el: Element) => {
    const value: unknown = Reflect.get(el, "value");
    if (Array.isArray(value)) return String(value[0] ?? "");
    return typeof value === "string" ? value : "";
  });
}

/** Every option value the Select offers, in order. */
export async function kerfSelectOptionValues(control: Locator): Promise<string[]> {
  return selectRoot(control)
    .locator("[role=option]")
    .evaluateAll((options) => options.map((o) => o.getAttribute("data-value") ?? ""));
}
