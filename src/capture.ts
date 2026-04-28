/**
 * Page Capture
 *
 * Uses Playwright to navigate to a URL, wait for it to settle,
 * and capture the DOM as SVG via the dom-to-svg converter.
 */

import { spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvg } from "./dom-to-svg.js";

export interface CaptureOptions {
  width: number;
  height: number;
  mobile?: boolean;
  /**
   * Sets the browser context's `prefers-color-scheme` media feature, which
   * controls how dark-mode-aware sites resolve their CSS. Default behavior
   * (undefined) follows Playwright's own default of "light".
   */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Authenticate via dev-login API before capturing */
  devUser?: string;
}

/**
 * Launch Chromium via Playwright, auto-installing the browser binary on first
 * use if it's missing. Use this instead of importing `chromium` from
 * `@playwright/test` directly when you want a frictionless first-run
 * experience for users of your tool.
 *
 * The install step is `npx playwright install chromium` and runs synchronously
 * (stdout / stderr inherited) so the user sees its progress. Subsequent calls
 * are a normal `chromium.launch()` with no overhead.
 */
export async function launchChromium(opts?: LaunchOptions): Promise<Browser> {
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;

    console.error("[domotion] Chromium binary not found — installing via 'npx playwright install chromium'…");
    const result = spawnSync("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      throw new Error(
        "[domotion] Failed to auto-install Playwright Chromium. " +
        "Run 'npx playwright install chromium' manually and try again.",
      );
    }
    return chromium.launch(opts);
  }
}

function isMissingBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|playwright install|browserType\.launch.*Failed to launch/i.test(msg);
}

export class DemoRecorder {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private width: number;
  private height: number;
  private baseUrl: string;

  constructor(baseUrl: string, opts: CaptureOptions) {
    this.baseUrl = baseUrl;
    this.width = opts.width;
    this.height = opts.height;
  }

  async init(opts: CaptureOptions): Promise<void> {
    this.browser = await launchChromium();
    this.context = await this.browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      isMobile: opts.mobile ?? false,
      ...(opts.mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
      ...(opts.colorScheme != null ? { colorScheme: opts.colorScheme } : {}),
    });

    // Dev auth if requested
    if (opts.devUser != null) {
      const res = await fetch(`${this.baseUrl}/api/v1/auth/dev-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: opts.devUser }),
        redirect: "manual",
      });
      if (res.ok) {
        const json = await res.json() as { data: { token: string } };
        const setCookie = res.headers.get("set-cookie") ?? "";
        if (setCookie !== "") {
          const parts = setCookie.split(";")[0].split("=");
          await this.context.addCookies([{
            name: parts[0],
            value: parts.slice(1).join("="),
            domain: new URL(this.baseUrl).hostname,
            path: "/",
          }]);
        }
        // Set localStorage for client-side auth
        await this.context.addInitScript((token: string) => {
          localStorage.setItem("sk_token", token);
          localStorage.setItem("sk_csrf", "");
        }, json.data.token);
      }
    }

    this.page = await this.context.newPage();
  }

  /** Navigate to a URL and capture the visible DOM as SVG. */
  async captureUrl(path: string, waitMs = 800, idPrefix = ""): Promise<string> {
    if (this.page == null) throw new Error("Call init() first");
    await this.page.goto(`${this.baseUrl}${path}`, { waitUntil: "networkidle" });
    await this.page.waitForTimeout(waitMs);
    return this.captureCurrent(idPrefix);
  }

  /** Capture the current page state as SVG content. */
  async captureCurrent(idPrefix = ""): Promise<string> {
    if (this.page == null) throw new Error("Call init() first");
    const tree = await captureElementTree(this.page, "body", {
      x: 0, y: 0, width: this.width, height: this.height,
    });
    return elementTreeToSvg(tree, this.width, this.height, idPrefix);
  }

  /**
   * Capture a full-page (scrollable) DOM as SVG.
   * Returns SVG content that may be taller than the viewport.
   */
  async captureFullPage(idPrefix = ""): Promise<{ svgContent: string; pageHeight: number }> {
    if (this.page == null) throw new Error("Call init() first");
    const pageHeight = await this.page.evaluate(() => document.body.scrollHeight);
    const tree = await captureElementTree(this.page, "body", {
      x: 0, y: 0, width: this.width, height: pageHeight,
    });
    const svgContent = elementTreeToSvg(tree, this.width, pageHeight, idPrefix);
    return { svgContent, pageHeight };
  }

  /** Get the underlying Playwright page for custom interactions. */
  getPage(): Page {
    if (this.page == null) throw new Error("Call init() first");
    return this.page;
  }

  /** Get the bounding box of an element (for positioning overlays). */
  async getBoundingBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (this.page == null) return null;
    const el = this.page.locator(selector).first();
    return el.boundingBox();
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}
