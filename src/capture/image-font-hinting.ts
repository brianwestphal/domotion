/** Capture the explicit global font style of a headless-shell session.
 * Chromium 7d859f27: command_line_handler.cc:128-149, headless_web_contents_impl.cc:461,
 * font_platform_data.cc:109-126,226-243. Multiprocess fontconfig can override the
 * global style per face, so its launch flag alone is insufficient evidence.
 * RendererBlinkPlatformImpl::sandboxEnabled (317-327) disables that IPC only
 * for --single-process; --no-sandbox does NOT bypass the fontconfig override.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  linuxFontEnvironmentKey,
  type FontRenderHinting,
  type LinuxFontRenderContext,
} from "@domotion/text-engine/font-resolution";
import type { CapturedElement } from "./types.js";
import { withCdpSession } from "./cdp-lifecycle.js";
import { forEachElement } from "../tree-ops/for-each-element.js";

export function explicitGlobalFontHinting(args: readonly string[]): FontRenderHinting | undefined {
  // This switch belongs to headless-shell. A custom Chrome executable may
  // accept an unknown switch without applying it. Do not infer its behavior.
  const executable = args[0]?.replaceAll("\\", "/").split("/").at(-1);
  if (!/^(?:chrome[-_]headless[-_]shell|headless_shell)(?:\.exe)?$/.test(executable ?? "")) return undefined;
  if (!args.includes("--single-process")) return undefined;
  // Duplicate switches use the final value, as base::CommandLine does.
  const value = args
    .filter((arg) => arg.startsWith("--font-render-hinting="))
    .at(-1)
    ?.split("=")[1];
  return value === "none" || value === "slight" || value === "medium" || value === "full" ? value : undefined;
}

const launchEnvironments = new WeakMap<Browser, string>();

/** Called only by the launch wrapper that knows the actual child environment. */
export function recordBrowserFontEnvironment(browser: Browser, env: NodeJS.ProcessEnv = process.env): Browser {
  launchEnvironments.set(browser, linuxFontEnvironmentKey(env));
  return browser;
}

const observations = new WeakMap<BrowserContext, Promise<FontRenderHinting | undefined>>();

export function observeImageFontHinting(page: Page): Promise<FontRenderHinting | undefined> {
  const context = page.context();
  const cached = observations.get(context);
  if (cached != null) return cached;
  const observed = withCdpSession(page, async (session) => {
    const result = await session.send("Browser.getBrowserCommandLine");
    return explicitGlobalFontHinting(result.arguments);
  }).catch(() => undefined);
  observations.set(context, observed);
  return observed;
}

export async function captureImageFontHinting(page: Page, tree: CapturedElement[]): Promise<void> {
  if (process.platform !== "linux") return;
  const browser = page.context().browser();
  const environmentKey = browser == null ? undefined : launchEnvironments.get(browser);
  if (environmentKey == null || environmentKey !== linuxFontEnvironmentKey()) return;
  const context = await withCdpSession(page, async (session): Promise<LinuxFontRenderContext | undefined> => {
    const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
    const executable = args[0]?.replaceAll("\\", "/").split("/").at(-1);
    if (!/^(?:chrome[-_]headless[-_]shell|headless_shell)(?:\.exe)?$/.test(executable ?? "")) return undefined;
    const singleProcess = args.includes("--single-process");
    const launchHinting = explicitGlobalFontHinting(args);
    if (singleProcess && launchHinting == null) return undefined;
    const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
    return {
      source: "shared-fontconfig-v1",
      environmentKey,
      singleProcess,
      launchHinting,
      deviceScaleFactor,
      disableSubpixelPositioning: args.includes("--disable-font-subpixel-positioning"),
    };
  }).catch(() => undefined);
  if (context == null) return;
  forEachElement(tree, (element) => {
    if (element.imageSrc != null) element.imageDocumentFontRendering = context;
  });
}
