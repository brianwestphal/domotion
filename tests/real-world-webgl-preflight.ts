import type { Page } from "@playwright/test";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";

/** Small, fixed budget: one offscreen screenshot can trigger a full WebGL readback. */
const MAX_CANVASES = 8;
const MAX_CLIP_SIDE = 512;
const MAX_DISCOVERY_MS = 3_000;
const MAX_PREFLIGHT_MS = 10_000;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface CanvasPreflightResult {
  primed: number;
  failed: number;
  skipped: number;
}

/**
 * Make off-viewport canvas layers compositor-visible before the WebGL freeze.
 * Ordinary page.screenshot clips cannot reach beyond the viewport, while CDP's
 * captureBeyondViewport does so without scrolling or changing the page's rAF.
 * The caller has already taken its reference screenshot. The capture context
 * is closed after the job, so this CDP session and its effects are job-scoped.
 */
export async function primeOffscreenCanvases(page: Page): Promise<CanvasPreflightResult> {
  const discovery = evaluateInFrame(
    page,
    (maxSide): Clip[] => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const documentWidth = Math.max(document.documentElement.scrollWidth, viewportWidth);
      const documentHeight = Math.max(document.documentElement.scrollHeight, viewportHeight);
      return Array.from(document.querySelectorAll("canvas")).flatMap((canvas) => {
        const style = getComputedStyle(canvas);
        if (style.display === "none" || style.visibility === "hidden") return [];
        const rect = canvas.getBoundingClientRect();
        const outsideViewport =
          rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight;
        if (!outsideViewport || rect.width <= 0 || rect.height <= 0) return [];
        const x = Math.max(0, Math.floor(rect.left + window.scrollX));
        const y = Math.max(0, Math.floor(rect.top + window.scrollY));
        const width = Math.min(maxSide, Math.ceil(rect.right + window.scrollX) - x, documentWidth - x);
        const height = Math.min(maxSide, Math.ceil(rect.bottom + window.scrollY) - y, documentHeight - y);
        return width > 0 && height > 0 ? [{ x, y, width, height, scale: 1 }] : [];
      });
    },
    MAX_CLIP_SIDE,
  ).catch(() => null);
  let discoveryTimer: NodeJS.Timeout | undefined;
  const discoveryTimeout = new Promise<null>((resolve) => {
    discoveryTimer = setTimeout(() => resolve(null), MAX_DISCOVERY_MS);
  });
  const clips = await Promise.race([discovery, discoveryTimeout]);
  clearTimeout(discoveryTimer);
  if (clips == null) return { primed: 0, failed: 1, skipped: 0 };
  const chosen = clips.slice(0, MAX_CANVASES);
  const result: CanvasPreflightResult = { primed: 0, failed: 0, skipped: clips.length - chosen.length };
  if (chosen.length === 0) return result;
  const session = await page
    .context()
    .newCDPSession(page)
    .catch(() => null);
  if (session == null) return { ...result, failed: chosen.length };
  const deadline = Date.now() + MAX_PREFLIGHT_MS;
  try {
    for (const clip of chosen) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        result.skipped += chosen.length - result.primed - result.failed;
        break;
      }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      });
      const captured = session
        .send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip })
        .then(() => true)
        .catch(() => false);
      const ok = await Promise.race([captured, timedOut]);
      clearTimeout(timer);
      if (ok) result.primed++;
      else result.failed++;
      if (Date.now() >= deadline) {
        result.skipped += chosen.length - result.primed - result.failed;
        break;
      }
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
  return result;
}
