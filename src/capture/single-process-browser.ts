import type { Browser, Page } from "@playwright/test";
import { withCdpSession } from "./cdp-lifecycle.js";

/**
 * Whether the Chromium behind `page` runs with `--single-process`, read from the
 * browser's own command line (`Browser.getBrowserCommandLine`). `undefined` means
 * unknown: a browser without `--enable-automation` withholds its command line
 * (browser_handler.cc, Chromium 7d859f27), and a non-Chromium browser has no CDP.
 *
 * Callers need this before opening a page in a NEW BrowserContext. Single-process
 * mode runs every page in the one in-process renderer of the first context:
 * `RenderProcessHost::IsProcessLimitReached()` is always true there and
 * `RenderProcessHostImpl::IsSuitableHost` DCHECKs "Single-process mode does not
 * support multiple browser contexts" (render_process_host_impl.cc:4903-4906,
 * 5232-5234 at 7d859f27). Measured with Playwright 1.59's headless shell, the
 * second context's `newPage` crashes the browser on macOS and in the Linux
 * container, and stayed pending with the browser busy on an x64 Linux CI runner.
 * A second page in the SAME context is supported and works.
 */
const singleProcessByBrowser = new WeakMap<Browser, Promise<boolean | undefined>>();

export function browserRunsSingleProcess(page: Page): Promise<boolean | undefined> {
  const browser = page.context().browser();
  if (browser == null) return Promise.resolve(undefined);
  let known = singleProcessByBrowser.get(browser);
  if (known == null) {
    known = withCdpSession(page, async (session) => {
      const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
      return args.length === 0 ? undefined : args.includes("--single-process");
    }).catch(() => {
      // A transient CDP failure is not an answer: let the next caller ask again.
      singleProcessByBrowser.delete(browser);
      return undefined;
    });
    singleProcessByBrowser.set(browser, known);
  }
  return known;
}
