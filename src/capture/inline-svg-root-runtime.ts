import type { Browser, Page } from "@playwright/test";
import { withTimeout } from "../utils/with-timeout.js";
import { withCdpSession } from "./cdp-lifecycle.js";

export type InlineSvgRootRuntime = "unscaled" | "shrink" | "pinned-unknown";
const REVISION = "@6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050";
const FEATURE = "SvgInlineRootPixelSnappingScaleAdjustment";

/** Chromium 147 marks this a test-only feature. Explicit Blink disable is
 * applied after enable, including the base::Feature and test defaults.
 * Restrict default-state inference to headless shell without field trials. */
export function inlineSvgRootRuntimeForBrowser(
  revision: string,
  args: readonly string[],
): InlineSvgRootRuntime | undefined {
  if (revision !== REVISION) return undefined;
  const binary = args[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (binary !== "chrome-headless-shell" && binary !== "chrome-headless-shell.exe") return "pinned-unknown";
  const terminator = args.indexOf("--");
  const switches = args.slice(1, terminator === -1 ? undefined : terminator).reverse();
  const has = (name: string) => switches.some((arg) => arg === name || arg.startsWith(`${name}=`));
  const values = (name: string) =>
    (switches.find((arg) => arg === name || arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "")
      .split(",")
      .map((entry) => entry.trim());
  if (values("--disable-blink-features").includes(FEATURE)) return "unscaled";
  if (values("--enable-blink-features").includes(FEATURE)) return "shrink";
  if (
    !has("--disable-field-trial-config") ||
    [
      "--enable-blink-test-features",
      "--enable-experimental-web-platform-features",
      "--run-web-tests",
      "--force-fieldtrials",
      "--force-fieldtrial-params",
    ].some(has) ||
    ["--enable-features", "--disable-features"].some((flag) =>
      values(flag).some((entry) => entry.split(/[<:]/)[0] === FEATURE),
    )
  )
    return "pinned-unknown";
  return "unscaled";
}

const runtimeByBrowser = new WeakMap<Browser, Promise<InlineSvgRootRuntime | undefined>>();

export function readInlineSvgRootRuntime(page: Page): Promise<InlineSvgRootRuntime | undefined> {
  const browser = page.context().browser();
  if (browser == null) return Promise.resolve(undefined);
  let runtime = runtimeByBrowser.get(browser);
  if (runtime == null) {
    runtime = withTimeout(
      withCdpSession(page, async (cdp) => {
        const { revision } = await cdp.send("Browser.getVersion");
        if (revision !== REVISION) return undefined;
        const args = await cdp.send("Browser.getBrowserCommandLine").catch(() => ({ arguments: [] }));
        return inlineSvgRootRuntimeForBrowser(revision, args.arguments);
      }),
      2000,
    ).catch(() => undefined);
    runtimeByBrowser.set(browser, runtime);
    void runtime.then((known) => {
      if (known == null) runtimeByBrowser.delete(browser);
    });
  }
  return runtime;
}
