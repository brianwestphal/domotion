/** Browser/context/font lifecycle for one declarative animation capture run. */

import type { Browser, Page } from "@playwright/test";
import { attachWebfontTracker, injectBrandVariables } from "../capture/index.js";
import { clearEmbeddedFonts, clearGlyphDefs, clearWebfonts } from "../render/index.js";
import type { Brand } from "../templates/brand.js";

export interface AnimateCaptureSessionOptions {
  width: number;
  height: number;
  mobile: boolean;
  colorScheme?: "light" | "dark" | "no-preference";
  brand?: Brand;
  /** DM-2636: one shared HAR for every page-backed animation frame. */
  recordHarPath?: string;
}

export interface AnimateCaptureSession {
  page: Page;
  tracker: ReturnType<typeof attachWebfontTracker>;
  close(): Promise<void>;
}

/**
 * Open the one persistent page shared by continued frames. This boundary owns
 * browser-context creation, brand injection, font-generation reset, webfont
 * tracking, timeout policy, and teardown; frame orchestration only consumes the
 * returned page and tracker.
 */
export async function openAnimateCaptureSession(
  browser: Browser,
  options: AnimateCaptureSessionOptions,
): Promise<AnimateCaptureSession> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    isMobile: options.mobile,
    ...(options.mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
    ...(options.colorScheme != null ? { colorScheme: options.colorScheme } : {}),
    ...(options.recordHarPath != null
      ? { recordHar: { path: options.recordHarPath, mode: "minimal" as const } }
      : {}),
  });
  if (options.brand != null) await injectBrandVariables(context, options.brand);
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  clearWebfonts();
  clearEmbeddedFonts();
  clearGlyphDefs();
  const tracker = attachWebfontTracker(page);
  let closed = false;
  return {
    page,
    tracker,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      tracker.detach();
      await context.close();
    },
  };
}
