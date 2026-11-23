import type { Page } from "@playwright/test";
import { evaluateInFrame } from "./evaluate-in-frame.js";

export const EXTERNAL_CSS_SVG_PIXEL_BUDGET = 16_777_216;
export const EXTERNAL_CSS_SVG_SCREENSHOT_MS = 5000;

export interface ExternalCssSvgScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function readExternalCssSvgScreenshotSpace(page: Page, fullPage: boolean) {
  return evaluateInFrame(
    page,
    (fullPage) => {
      const root = document.documentElement;
      const body = document.body ?? root;
      // Match Playwright's full-page document bounds. Full-page clips start
      // at the document origin, whereas ordinary clips start at the viewport.
      return {
        x: fullPage ? scrollX : 0,
        y: fullPage ? scrollY : 0,
        width: fullPage
          ? Math.max(
              body.scrollWidth,
              root.scrollWidth,
              body.offsetWidth,
              root.offsetWidth,
              body.clientWidth,
              root.clientWidth,
            )
          : innerWidth,
        height: fullPage
          ? Math.max(
              body.scrollHeight,
              root.scrollHeight,
              body.offsetHeight,
              root.offsetHeight,
              body.clientHeight,
              root.clientHeight,
            )
          : innerHeight,
        scale: devicePixelRatio,
      };
    },
    fullPage,
  );
}

/** Keep geometry discovery and the screenshot inside the same deadline. */
export function cssSvgScreenshotTimeLeft(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("external CSS SVG paint screenshot timed out");
  return remaining;
}
