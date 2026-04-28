/**
 * Page Capture
 *
 * Uses Playwright to navigate to a URL, wait for it to settle,
 * and capture the DOM as SVG via the dom-to-svg converter.
 */

import { spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvg } from "./dom-to-svg.js";
import { registerWebfont } from "./text-to-path.js";

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

/**
 * Install a `requestfinished` listener that records every font-file URL the
 * browser fetches into a Set. Returns the set + a detach handle. Pair with
 * `discoverAndRegisterWebfonts(page, tracker.urls)` after the page loads.
 *
 * Needed because `performance.getEntriesByType("resource")` omits
 * cross-origin fonts that don't send `Timing-Allow-Origin: *` (most CDNs
 * don't), and most webfonts in the wild are served cross-origin.
 *
 * Attach BEFORE navigation so the listener catches the initial fetches.
 */
export function attachWebfontTracker(page: Page): { urls: Set<string>; detach: () => void } {
  const urls = new Set<string>();
  const handler = (req: { url: () => string }): void => {
    const u = req.url();
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(u)) urls.add(u);
  };
  page.on("requestfinished", handler);
  return { urls, detach: () => page.off("requestfinished", handler) };
}

/**
 * Discover all `@font-face` rules in the page's stylesheets, fetch each
 * font file via the browser context's request API (so cookies / CORS / auth
 * follow whatever the browser is using), and register the bytes with
 * `text-to-path.ts` so the renderer can draw with the actual webfont glyphs
 * instead of falling through to the system-font substitutes.
 *
 * Should be called AFTER `await page.evaluate(() => document.fonts.ready)`
 * — otherwise late-loading fonts may not be in `document.styleSheets` yet.
 *
 * Cross-origin stylesheets whose `cssRules` throw a SecurityError are silently
 * skipped (we can't enumerate their rules from JS). Same-origin sheets and
 * inline `<style>` blocks always work.
 *
 * Caller is responsible for `clearWebfonts()` between captures if needed.
 * No-op when the page declares no `@font-face` rules.
 */
export async function discoverAndRegisterWebfonts(page: Page, observedFontUrls: Iterable<string> = []): Promise<{ family: string; weight: number; style: string; url: string; source: "font-face" | "resource"; ok: boolean; error?: string }[]> {
  // Two-pass discovery:
  //
  //   1. Same-origin `@font-face` rules — gives us the CSS-declared family
  //      name verbatim. Cross-origin sheets (Google Fonts, etc.) throw a
  //      SecurityError on cssRules access and are skipped here.
  //
  //   2. Resource-based fallback — every font URL the browser actually
  //      fetched. Cross-origin entries don't appear in
  //      `performance.getEntriesByType("resource")` without a
  //      `Timing-Allow-Origin: *` header from the font CDN, so callers
  //      should pass the URL set captured from a `requestfinished` listener
  //      registered before navigation. We download anything ending in
  //      .woff2/.woff/.ttf/.otf, parse with fontkit, and register under
  //      the font's own internal `familyName`.
  //
  // Pass 1 names match CSS exactly (good when authors rename a face);
  // pass 2 catches fonts that pass 1 missed and uses the font's internal
  // name (good for Google Fonts which keep names in sync).
  type FaceRule = { kind: "font-face"; family: string; weight: string; style: string; url: string };
  type ResourceUrl = { kind: "resource"; url: string };
  type DiscoveredItem = FaceRule | ResourceUrl;
  const fromPage = await page.evaluate(() => {
    interface FaceRule { kind: "font-face"; family: string; weight: string; style: string; url: string }
    interface ResourceUrl { kind: "resource"; url: string }
    const out: (FaceRule | ResourceUrl)[] = [];
    const seenUrls = new Set<string>();

    for (const sheet of Array.from(document.styleSheets)) {
      let cssRules: CSSRuleList;
      try { cssRules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(cssRules)) {
        if (rule.constructor.name !== "CSSFontFaceRule") continue;
        const r = rule as CSSFontFaceRule;
        const family = r.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
        const weight = r.style.getPropertyValue("font-weight") || "400";
        const style = r.style.getPropertyValue("font-style") || "normal";
        const src = r.style.getPropertyValue("src");
        const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(src);
        if (m == null) continue;
        const base = sheet.href ?? document.baseURI;
        let absUrl: string;
        try { absUrl = new URL(m[1], base).href; } catch { continue; }
        seenUrls.add(absUrl);
        out.push({ kind: "font-face", family, weight, style, url: absUrl });
      }
    }

    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (!/\.(woff2?|ttf|otf)(\?|$)/i.test(entry.name)) continue;
      if (seenUrls.has(entry.name)) continue;
      seenUrls.add(entry.name);
      out.push({ kind: "resource", url: entry.name });
    }
    return { entries: out, seenUrls: Array.from(seenUrls) };
  });
  const discovered = fromPage.entries as DiscoveredItem[];
  const seen = new Set(fromPage.seenUrls);
  for (const url of observedFontUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    discovered.push({ kind: "resource", url });
  }

  const report: { family: string; weight: number; style: string; url: string; source: "font-face" | "resource"; ok: boolean; error?: string }[] = [];
  for (const item of discovered) {
    try {
      const resp = await page.context().request.get(item.url);
      if (!resp.ok()) {
        report.push({ family: "", weight: 400, style: "normal", url: item.url, source: item.kind, ok: false, error: `HTTP ${resp.status()}` });
        continue;
      }
      const fetched = Buffer.from(await resp.body());
      const buf = await ensureNonWoff2(fetched);

      if (item.kind === "font-face") {
        const weightNum = parseWeightDescriptor(item.weight);
        registerWebfont(item.family, weightNum, item.style, buf);
        report.push({ family: item.family, weight: weightNum, style: item.style, url: item.url, source: "font-face", ok: true });
      } else {
        // Resource-only path: read family + weight + italic from the font itself.
        const meta = await readFontMetadata(buf);
        if (meta == null) {
          report.push({ family: "", weight: 400, style: "normal", url: item.url, source: "resource", ok: false, error: "fontkit could not parse" });
          continue;
        }
        registerWebfont(meta.family, meta.weight, meta.italic ? "italic" : "normal", buf);
        report.push({ family: meta.family, weight: meta.weight, style: meta.italic ? "italic" : "normal", url: item.url, source: "resource", ok: true });
      }
    } catch (e) {
      report.push({ family: "", weight: 400, style: "normal", url: item.url, source: item.kind, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

async function readFontMetadata(buf: Buffer): Promise<{ family: string; weight: number; italic: boolean } | null> {
  const fontkit = await import("fontkit");
  try {
    const f = (fontkit as any).create(buf);
    const family = f.familyName ?? "";
    if (family === "") return null;
    const weight = (f["OS/2"]?.usWeightClass) ?? 400;
    const italic = !!(f["OS/2"]?.fsSelection?.italic);
    return { family, weight, italic };
  } catch {
    return null;
  }
}

/**
 * If `buf` is WOFF2 (magic `wOF2`), decompress it to plain TTF bytes via
 * `wawoff2`. Otherwise return the buffer untouched.
 *
 * Why we need this: fontkit *parses* WOFF2 fine, but `getVariation()` on a
 * WOFF2 font returns an instance whose internal stream can't read the
 * parent's tables (`unitsPerEm` / `layout()` throw). Most webfonts in the
 * wild are WOFF2, so without this step variable-axis support (DM-228 / 229)
 * would silently degrade to the registered base instance for every weight.
 *
 * Decompressing to TTF before fontkit.create produces a font whose variation
 * results retain access to all tables — same as a TTF loaded from disk.
 */
async function ensureNonWoff2(buf: Buffer): Promise<Buffer> {
  if (buf.length < 4) return buf;
  const isWoff2 = buf[0] === 0x77 && buf[1] === 0x4F && buf[2] === 0x46 && buf[3] === 0x32;
  if (!isWoff2) return buf;
  try {
    // wawoff2 ships no .d.ts; the runtime export is `{ compress, decompress }`.
    const wawoff = await (import("wawoff2" as string) as Promise<{ decompress: (b: Uint8Array) => Promise<Uint8Array> }>);
    const ttf = await wawoff.decompress(new Uint8Array(buf));
    return Buffer.from(ttf);
  } catch {
    return buf; // fall through: register the WOFF2 anyway, variations just won't work
  }
}

function parseWeightDescriptor(value: string): number {
  // CSS keywords and numeric, including weight ranges like "100 900".
  const v = value.trim().toLowerCase();
  if (v === "normal") return 400;
  if (v === "bold") return 700;
  // Range form: take the first number.
  const m = /-?\d+/.exec(v);
  if (m != null) {
    const n = parseInt(m[0], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n;
  }
  return 400;
}
