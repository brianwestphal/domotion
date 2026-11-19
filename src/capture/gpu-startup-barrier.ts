import type { Browser } from "@playwright/test";

/**
 * Upper bound on the GPU startup wait. Chromium normally publishes its GPU
 * feature info within tens of milliseconds of launch; the bound only keeps a
 * wedged GPU process from blocking a launch indefinitely.
 */
export const GPU_FEATURE_INFO_TIMEOUT_MS = 5_000;

export type GpuFeatureInfoBarrierResult = "ready" | "timeout" | "unavailable";

/**
 * Wait until the browser's GPU feature info has been initialized before any
 * page is created.
 *
 * A renderer that creates canvas contexts before that point can have them
 * lost a few milliseconds later. Measured on macOS against Playwright's
 * headless shell: a page created right after launch, with a 2D or WebGL
 * canvas drawn once at load, fired `contextlost` in 20–70% of fresh
 * browsers (runs of 10 and 20 launches). Loss occurred only for canvases
 * created before, or within about 1 ms of, the moment the browser's GPU
 * feature info became available, and it arrived 4–7 ms after that moment.
 * Shared-image-backed canvases, which include software 2D canvases, lose
 * their context when the renderer's GPU channel is lost
 * (`Canvas2DResourceProviderSharedImage::OnGpuChannelLost` in
 * `third_party/blink/renderer/platform/graphics/canvas_resource_provider.cc`,
 * Chromium 7d859f27). Chromium then paints the broken-canvas placeholder and,
 * for 2D, restores a cleared context about 500 ms later. A page that drew
 * once at load never repaints, so Chromium's own output, and therefore the
 * capture, lose the drawing. Launching with `--use-angle=swiftshader` also
 * removed the loss (0 of 20), which points at the automatic backend's startup
 * fallback, applied when the feature info arrives
 * (`GpuDataManagerImplPrivate::UpdateGpuFeatureInfo` calls
 * `FallBackToNextGpuMode()` for an unsupported context type). How that drops
 * the renderer's channel has not been read in Chromium's source. Production
 * launches keep the automatic backend, so they wait instead.
 *
 * `SystemInfo.getInfo` on the browser target responds only once
 * `GpuDataManagerImpl::IsGpuFeatureInfoAvailable()` is true, or the GPU
 * process crashed (`content/browser/devtools/protocol/system_info_handler.cc`,
 * `SystemInfoHandlerGpuObserver`). After awaiting it, no first page lost its
 * context in 72 fresh launches.
 *
 * Best effort: a failure or timeout never fails the launch. A timeout leaves
 * Chromium's own request observer armed; its watchdog is a `NOTREACHED()`
 * after 10 s (30 s on macOS, Windows and Ozone builds). The browser would
 * reach it only if GPU feature info stayed uninitialized for that long and
 * the GPU process did not crash.
 */
export async function awaitGpuFeatureInfo(
  browser: Pick<Browser, "newBrowserCDPSession">,
  timeoutMs: number = GPU_FEATURE_INFO_TIMEOUT_MS,
): Promise<GpuFeatureInfoBarrierResult> {
  let session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>;
  try {
    session = await browser.newBrowserCDPSession();
  } catch {
    return "unavailable";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = session.send("SystemInfo.getInfo").then(
      () => "ready" as const,
      () => "unavailable" as const,
    );
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    return await Promise.race([info, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
    await session.detach().catch(() => undefined);
  }
}
