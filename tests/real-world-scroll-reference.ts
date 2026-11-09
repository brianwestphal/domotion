import type { Page } from "@playwright/test";
import { captureElementTreeWithDebug, type CaptureElementTreeOptions } from "../src/capture/index.js";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";

/** Keep anchor source pixels with the tree, without advancing finite animations. */
export async function captureRealWorldScrollReference(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  options?: CaptureElementTreeOptions,
) {
  for (const frame of page.frames()) {
    await evaluateInFrame(frame, async () => {
      for (const animation of document.getAnimations()) animation.pause();
      await Promise.all(document.getAnimations().map((animation) => animation.ready));
    });
  }
  return captureElementTreeWithDebug(page, selector, viewport, options);
}
