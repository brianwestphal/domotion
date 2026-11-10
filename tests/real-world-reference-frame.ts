import type { Page } from "@playwright/test";
import { freezeWebGlOutput } from "./real-world-webgl-freeze.js";
import { primeOffscreenCanvases } from "./real-world-webgl-preflight.js";

/** Present/prime live canvas layers, then save the reference from the frozen paint epoch. */
export async function captureRealWorldReferenceFrame(
  page: Page,
  options: {
    path: string;
    clip: { x: number; y: number; width: number; height: number };
    entirePage: boolean;
    afterWebGlFreeze?: () => Promise<unknown>;
  },
) {
  // This presentation frame is deliberately not the expected artifact: workers
  // can draw while preflight and prototype freezing cross protocol boundaries.
  await page.screenshot({ clip: options.clip });
  const canvasPreflight = options.entirePage
    ? { primed: 0, failed: 0, skipped: 0 }
    : await primeOffscreenCanvases(page);
  const webGlFreeze = await freezeWebGlOutput(page);
  try {
    await options.afterWebGlFreeze?.();
    await page.screenshot({ path: options.path, clip: options.clip });
  } catch (error) {
    // The caller receives ownership only after the reference is saved.
    await webGlFreeze.dispose();
    throw error;
  }
  return { canvasPreflight, webGlFreeze };
}
