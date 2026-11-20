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
 * capture, lose the drawing.
 *
 * The channel is dropped by Chromium's software-compositing fallback
 * (Chromium 7d859f27). When the headless GPU process reports accelerated GL
 * as unavailable, `GpuDataManagerImplPrivate::UpdateGpuFeatureInfo` moves the
 * browser's GPU mode from hardware to `SOFTWARE_GL` (`FallBackToNextGpuMode`,
 * `content/browser/gpu/gpu_data_manager_impl_private.cc`). That only changes
 * bookkeeping. The browser compositor then fails to create GPU contexts
 * (`TryCreateContextsForGpuCompositing` returns `kFatalFailure`) and calls
 * `VizProcessTransportFactory::DisableGpuCompositing`, which tells every
 * registered compositing-mode watcher to fall back to software
 * (`content/browser/compositor/viz_process_transport_factory.cc`,
 * `components/viz/host/compositing_mode_reporter_impl.cc`). A renderer's
 * watcher answers with `gpu_->LoseChannel()`
 * (`RenderThreadImpl::CompositingModeFallbackToSoftware`), and losing the
 * channel loses its canvases. A renderer registers that watcher only when it
 * launched without `--disable-gpu-compositing`
 * (`content/renderer/render_thread_impl.cc`). The browser adds the switch
 * whenever `GpuDataManagerImpl::IsGpuCompositingDisabled()` is already true at
 * renderer launch (`render_process_host_impl.cc`), which holds once the
 * feature info has moved the mode to `SOFTWARE_GL`. Waiting for the feature
 * info therefore launches the first page's renderer in software compositing
 * from the start, with no watcher for the later fallback to reach.
 *
 * Measured on macOS: the first page's renderer carried
 * `--disable-gpu-compositing` with the wait (6 of 6) and lacked it without
 * (6 of 6); `--disable-gpu-compositing` alone also removed the loss (0 of 10);
 * and `--disable-software-compositing-fallback`, which turns the fallback into
 * a fatal error, crashed every launch with or without the wait, so the
 * fallback still runs and the wait only orders it after renderer launch.
 * `--use-angle=swiftshader` removed the loss differently: SwiftShader then
 * reports accelerated GL, GPU compositing stays enabled, and no fallback
 * occurs. Production launches keep the automatic backend, so they wait
 * instead.
 *
 * On Linux and Windows the first page's renderer launches without
 * `--disable-gpu-compositing` even after the wait (the feature info has not
 * made `IsGpuCompositingDisabled()` true; why is not yet read in source), and
 * the fallback runs during page creation,
 * before the document's canvas exists. No loss was measured there either way
 * (10 of 10 launches each), so the wait is inert on those hosts.
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
