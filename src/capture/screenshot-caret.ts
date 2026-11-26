import type { Page, PageScreenshotOptions } from "@playwright/test";

/**
 * Playwright's default caret suppression writes inline styles to every input,
 * textarea and editable node. Its cleanup restores just the CSSOM property,
 * which can leave an absent style attribute empty or reserialize authored CSS.
 */
export async function screenshotWithoutUnneededCaretWrites(
  page: Page,
  options: PageScreenshotOptions,
): Promise<Buffer> {
  const noCaret = await page
    .evaluate(() => {
      if (document.designMode.toLowerCase() === "on") return false;
      const focused = document.activeElement;
      if (focused === document.body || focused === document.documentElement) {
        // An explicitly focused document root can have a shadow or editing
        // context. The ordinary unfocused root has no :focus match.
        return !focused?.matches(":focus") && !(focused instanceof HTMLElement && focused.isContentEditable);
      }
      // Focus in a child frame or a shadow tree is retargeted to its host.
      // Keep Playwright's default when that host might contain an editor.
      return focused instanceof HTMLInputElement && (focused.type === "checkbox" || focused.type === "radio");
    })
    .catch(() => false);
  return page.screenshot(noCaret ? { ...options, caret: "initial" } : options);
}
