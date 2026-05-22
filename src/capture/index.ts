/**
 * Page Capture
 *
 * Uses Playwright to navigate to a URL, wait for it to settle,
 * and capture the DOM as SVG via the dom-to-svg converter.
 */

import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type LaunchOptions, type Page } from "@playwright/test";
import { elementTreeToSvg, wrapSvg, rootSvgColorSchemeAttr } from "../render/element-tree-to-svg.js";
import { embedRemoteImages } from "./embed.js";
import { resizeEmbeddedImages } from "../tree-ops/resize-embedded-images.js";
import { rasterizeConicGradients } from "../render/conic-raster.js";
import { registerLocalFontAlias, registerWebfont } from "../render/text-to-path.js";
import { CAPTURE_SCRIPT } from "./script.generated.js";
import { rasterizeBitmapGlyphs } from "./emoji.js";
import { _resetLastCaptureWarnings } from "./warnings.js";
import type { CapturedElement, CaptureWarning } from "./types.js";

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
  /**
   * DM-512: when true, fetch every http(s) image URL referenced by the
   * captured tree and inline it as a `data:` URI in the output SVG. The
   * resulting SVG loads correctly in image viewers (Preview, QuickLook,
   * Finder thumbnail, etc.) that don't fetch remote resources from local
   * files. Adds capture-time network I/O proportional to the number of
   * unique referenced URLs; per-URL fetch failures are logged via the
   * capture-warnings pipeline but don't fail the overall capture.
   * Default: false (URLs pass through verbatim — works in browsers that
   * fetch from file:// pages but not in offline viewers).
   */
  selfContained?: boolean;
  /**
   * DM-528: per-URL fetch timeout (ms) for the `selfContained` pre-pass.
   * Caps the time a stalled CDN host can hold up the capture; total
   * pre-pass time is bounded by `embedRemoteImagesTimeoutMs` (fetches run
   * in parallel) rather than the sum across all URLs. Default 10000.
   */
  embedRemoteImagesTimeoutMs?: number;
  /**
   * DM-529: number of retry attempts for transient failures (5xx /
   * network-error / timeout) in the `selfContained` pre-pass. 4xx
   * responses are not retried. Default 1.
   */
  embedRemoteImagesRetries?: number;
  /**
   * DM-529: backoff delay (ms) between retry attempts in the
   * `selfContained` pre-pass. Default 500.
   */
  embedRemoteImagesRetryBackoffMs?: number;
  /**
   * DM-526 / DM-539: when true, run the `resizeEmbeddedImages` pre-pass
   * after `embedRemoteImages` to downscale each inlined image to its
   * consumer's render rect × `embedRemoteImagesHiDPIFactor`, re-encoded as
   * PNG. Yields 50–80 % SVG size reduction on news-site captures with no
   * visible diff at the captured viewport. No-op unless `selfContained` is
   * also true (resize only acts on what the embed pass already inlined).
   * Default false. See `docs/27-image-resize-on-embed.md`.
   */
  embedRemoteImagesResize?: boolean;
  /**
   * DM-526 / DM-539: hiDPI multiplier applied to each consumer's render rect
   * before resizing. `2.0` (default) leaves headroom for retina viewing /
   * zoom; `1.0` produces the smallest output (matches Chromium's painted
   * resolution at devicePixelRatio: 1); `3.0` covers iPhone-Pro density.
   * Values < 1 are clamped to 1.
   */
  embedRemoteImagesHiDPIFactor?: number;
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
  private selfContained: boolean;
  private embedRemoteImagesTimeoutMs: number | undefined;
  private embedRemoteImagesRetries: number | undefined;
  private embedRemoteImagesRetryBackoffMs: number | undefined;
  private embedRemoteImagesResize: boolean;
  private embedRemoteImagesHiDPIFactor: number | undefined;

  constructor(baseUrl: string, opts: CaptureOptions) {
    this.baseUrl = baseUrl;
    this.width = opts.width;
    this.height = opts.height;
    this.selfContained = opts.selfContained ?? false;
    this.embedRemoteImagesTimeoutMs = opts.embedRemoteImagesTimeoutMs;
    this.embedRemoteImagesRetries = opts.embedRemoteImagesRetries;
    this.embedRemoteImagesRetryBackoffMs = opts.embedRemoteImagesRetryBackoffMs;
    this.embedRemoteImagesResize = opts.embedRemoteImagesResize ?? false;
    this.embedRemoteImagesHiDPIFactor = opts.embedRemoteImagesHiDPIFactor;
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
    // DM-479: bump per-page Playwright operation timeouts from the 30 s
    // default to 90 s. Heavy CSS / font / image loads on real-world sites
    // and large captures push past 30 s without being genuinely stuck.
    this.page.setDefaultTimeout(90_000);
    this.page.setDefaultNavigationTimeout(90_000);
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
    if (this.selfContained) await embedRemoteImages(tree, {
      timeoutMs: this.embedRemoteImagesTimeoutMs,
      retries: this.embedRemoteImagesRetries,
      retryBackoffMs: this.embedRemoteImagesRetryBackoffMs,
    });
    if (this.selfContained && this.embedRemoteImagesResize) {
      await resizeEmbeddedImages(tree, { hiDPIFactor: this.embedRemoteImagesHiDPIFactor });
    }
    // DM-549: rasterize conic-gradient layers into PNG tiles. No-op when the
    // tree contains no conic content; otherwise the renderer (DM-550) emits
    // <pattern><image href="data:..."/></pattern> instead of dropping the layer.
    await rasterizeConicGradients(tree, { hiDPIFactor: this.embedRemoteImagesHiDPIFactor });
    return elementTreeToSvg(tree, this.width, this.height, idPrefix, true, this.embedRemoteImagesHiDPIFactor ?? 2);
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
    if (this.selfContained) await embedRemoteImages(tree, {
      timeoutMs: this.embedRemoteImagesTimeoutMs,
      retries: this.embedRemoteImagesRetries,
      retryBackoffMs: this.embedRemoteImagesRetryBackoffMs,
    });
    if (this.selfContained && this.embedRemoteImagesResize) {
      await resizeEmbeddedImages(tree, { hiDPIFactor: this.embedRemoteImagesHiDPIFactor });
    }
    // DM-549: rasterize conic-gradient layers — see captureCurrent above.
    await rasterizeConicGradients(tree, { hiDPIFactor: this.embedRemoteImagesHiDPIFactor });
    const svgContent = elementTreeToSvg(tree, this.width, pageHeight, idPrefix, true, this.embedRemoteImagesHiDPIFactor ?? 2);
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
  type FaceRule = { kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]> };
  type ResourceUrl = { kind: "resource"; url: string };
  type LocalFace = { kind: "local"; family: string; localNames: string[]; weight: string; style: string; resolvedLocalName: string | null };
  type DiscoveredItem = FaceRule | LocalFace | ResourceUrl;
  const fromPage = await page.evaluate(() => {
    // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
    // stack traces. That helper isn't injected into page.evaluate's
    // serialized scope, so we polyfill it here. Without this, our local
    // helpers below throw "__name is not defined" at construction time.
    if (typeof (window as any).__name === "undefined") {
      (window as any).__name = function (fn: any) { return fn; };
    }
    interface FaceRule { kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]> }
    interface ResourceUrl { kind: "resource"; url: string }
    interface LocalFace { kind: "local"; family: string; localNames: string[]; weight: string; style: string; resolvedLocalName: string | null }
    // Parse a CSS `unicode-range` descriptor value into inclusive [from, to]
    // intervals. Accepts the three forms in CSS Fonts 4 §4.5: single codepoint
    // (`U+26`), interval (`U+0-7F`), and wildcard (`U+4??`). Returns `null`
    // when the value is missing/unparseable so the caller treats the variant
    // as covering the default range U+0..U+10FFFF.
    const parseUnicodeRangeInline = function (value: string): Array<[number, number]> | undefined {
      const v = value.trim();
      if (v === "") return undefined;
      const out: Array<[number, number]> = [];
      for (const raw of v.split(",")) {
        const tok = raw.trim().replace(/^U\+/i, "");
        if (tok === "") continue;
        if (tok.includes("?")) {
          const lo = parseInt(tok.replace(/\?/g, "0"), 16);
          const hi = parseInt(tok.replace(/\?/g, "F"), 16);
          if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
        } else if (tok.includes("-")) {
          const [a, b] = tok.split("-");
          const lo = parseInt(a, 16);
          const hi = parseInt(b, 16);
          if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
        } else {
          const cp = parseInt(tok, 16);
          if (Number.isFinite(cp)) out.push([cp, cp]);
        }
      }
      return out.length > 0 ? out : undefined;
    };
    const out: (FaceRule | LocalFace | ResourceUrl)[] = [];
    const seenUrls = new Set<string>();
    // DM-545: stylesheets whose `cssRules` access threw (cross-origin without
    // CORS). The Node side fetches their text and parses `@font-face` rules
    // server-side. Without this, sites that serve their CSS from a CDN
    // different from the page origin (Stripe → b.stripecdn.com, Apple → many
    // sub-CDNs, …) miss every CSS-declared font-family alias and the
    // resource-fallback registers under fontkit's internal `familyName` —
    // which for license-protected fonts (Sohne) is often a copyright string.
    const crossOriginSheetUrls: string[] = [];

    // Width-probe helpers are defined inline below as needed. We avoid hoisting
    // them into named arrow consts because tsx wraps such names in __name(...)
    // calls (a runtime helper for stack traces) that isn't available inside
    // page.evaluate's serialized context. (DM-445 — original symptom: the
    // entire discovery throws "ReferenceError: __name is not defined".)
    const probeWidthInline = function (familyExpr: string, weight: string, style: string, sample: string): number {
      const span = document.createElement("span");
      span.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;font-size:16px;line-height:1;white-space:pre";
      span.style.fontFamily = familyExpr;
      span.style.fontWeight = weight;
      span.style.fontStyle = style;
      span.textContent = sample;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width;
      document.body.removeChild(span);
      return w;
    };
    // Strip trailing weight/style suffix from a local() candidate so the
    // direct family-name probe hits the installed family. e.g. "Georgia
    // Italic" → "Georgia". The font-style / font-weight descriptors of the
    // alias rule already set the right variant, so the probe gets the same
    // face Chrome's local() lookup would reach.
    const stripVariantSuffixInline = function (n: string): string {
      return n.replace(/\s+(Bold Italic|Italic Bold|Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Black)$/i, "").trim();
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let cssRules: CSSRuleList;
      try { cssRules = sheet.cssRules; } catch {
        // Cross-origin sheet — record its URL so the Node side can fetch and
        // parse it for @font-face rules. (DM-545)
        if (sheet.href) crossOriginSheetUrls.push(sheet.href);
        continue;
      }
      for (const rule of Array.from(cssRules)) {
        if (rule.constructor.name !== "CSSFontFaceRule") continue;
        const r = rule as CSSFontFaceRule;
        const family = r.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
        const weight = r.style.getPropertyValue("font-weight") || "400";
        const style = r.style.getPropertyValue("font-style") || "normal";
        const src = r.style.getPropertyValue("src");
        // DM-513: parse ALL `url(...) format(...)` pairs and return them in
        // priority order (woff2 > woff > ttf/otf > unknown). Sites like
        // Slashdot list legacy `eot`/`svg` (fontkit can't parse) alongside
        // `woff` — without ordering, we'd grab the eot, fail to register,
        // and lose every `::before` icon glyph. The Node side iterates the
        // ranked list and uses the first URL whose response fontkit parses.
        const srcEntries: { url: string; format: string }[] = [];
        const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g;
        let urlMatch;
        while ((urlMatch = urlRe.exec(src)) !== null) {
          srcEntries.push({ url: urlMatch[1], format: (urlMatch[2] ?? "").toLowerCase() });
        }
        const formatRank = (fmt: string, url: string): number => {
          const lower = fmt.toLowerCase();
          if (/embedded-opentype|svg/.test(lower)) return -1;
          if (lower.includes("woff2") || /\.woff2(\?|$)/i.test(url)) return 4;
          if (lower === "woff" || /\.woff(\?|$)/i.test(url)) return 3;
          if (/truetype|opentype/.test(lower) || /\.(ttf|otf)(\?|$)/i.test(url)) return 2;
          if (/\.eot(\?|$)/i.test(url) || /\.svg(\?|$)/i.test(url)) return -1;
          return 1;
        };
        const rankedUrls: string[] = srcEntries
          .map((e) => ({ url: e.url, rank: formatRank(e.format, e.url) }))
          .filter((e) => e.rank >= 0)
          .sort((a, b) => b.rank - a.rank)
          .map((e) => e.url);
        const m = rankedUrls.length > 0 ? [src, rankedUrls[0]] : null;
        if (m == null) {
          // No url() — but src may carry one or more local() entries. Capture
          // the local names so the Node side can register an alias to the
          // matching system font (DM-303). Without this, `font-family: Foo`
          // where Foo is declared via @font-face { src: local("Georgia") }
          // falls through the family chain to the next name and renders in
          // the wrong face.
          const locals = Array.from(src.matchAll(/local\(\s*["']?([^"')]+?)["']?\s*\)/g)).map((mm) => mm[1].trim()).filter((n) => n !== "");
          if (locals.length > 0) {
            // Probe to identify which local() candidate Chrome actually
            // resolved this alias to. A sample of common monospace + serif
            // glyphs ('mIw0') gives us enough horizontal divergence between
            // candidates to disambiguate even closely-related faces.
            const sample = "mIw0";
            // Chrome's local() lookup only matches a font's full name or
            // PostScript name (per CSS Fonts 4 §11.2), not its CSS family
            // name. So `local("Menlo")` (a family name) fails to match —
            // but the @font-face still resolves to the next candidate. To
            // figure out which one, render the alias face and compare its
            // width to each candidate via DIRECT family-name lookup (which
            // does match installed system fonts).
            const aliasW = probeWidthInline(`"${family}"`, weight, style, sample);
            let resolved: string | null = null;
            for (const cand of locals) {
              const candW = probeWidthInline(`"${stripVariantSuffixInline(cand)}"`, weight, style, sample);
              // Tolerate sub-px FP noise; match if widths agree within 0.05px.
              if (Math.abs(candW - aliasW) < 0.05) { resolved = cand; break; }
            }
            out.push({ kind: "local", family, localNames: locals, weight, style, resolvedLocalName: resolved });
          }
          continue;
        }
        const base = sheet.href ?? document.baseURI;
        let absUrl: string;
        try { absUrl = new URL(m[1], base).href; } catch { continue; }
        // Resolve the full ranked URL list to absolute URLs for the Node-side
        // iterator (DM-513). The first entry IS `absUrl`; the rest are
        // fallback candidates the Node side tries if fontkit rejects a
        // higher-priority URL's bytes.
        const absUrls: string[] = [];
        for (const ru of rankedUrls) {
          try { absUrls.push(new URL(ru, base).href); } catch { /* skip */ }
        }
        for (const u of absUrls) seenUrls.add(u);
        const unicodeRange = parseUnicodeRangeInline(r.style.getPropertyValue("unicode-range") || "");
        out.push({ kind: "font-face", family, weight, style, url: absUrl, urls: absUrls, unicodeRange });
      }
    }

    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (!/\.(woff2?|ttf|otf)(\?|$)/i.test(entry.name)) continue;
      if (seenUrls.has(entry.name)) continue;
      seenUrls.add(entry.name);
      out.push({ kind: "resource", url: entry.name });
    }
    return { entries: out, seenUrls: Array.from(seenUrls), crossOriginSheetUrls };
  });
  const discovered: DiscoveredItem[] = fromPage.entries;
  const seen = new Set(fromPage.seenUrls);
  // DM-545: fetch each cross-origin stylesheet text and parse `@font-face`
  // rules server-side. Cross-origin sheets throw on `cssRules` access from
  // the page context, so without this the page-side walker misses every
  // CDN-hosted CSS @font-face declaration. Sites affected (verified): Stripe
  // (b.stripecdn.com), and likely most marketing sites whose CSS is served
  // from a different host than the page. The resource-fallback path that
  // ran in this scenario registers under fontkit's internal `familyName`,
  // which for license-protected fonts (Sohne) is a copyright string —
  // unmatchable against the CSS-declared `font-family: sohne-var` query.
  for (const sheetUrl of fromPage.crossOriginSheetUrls) {
    let cssText: string;
    try {
      const resp = await page.context().request.get(sheetUrl);
      if (!resp.ok()) continue;
      cssText = await resp.text();
    } catch { continue; }
    for (const face of parseFontFaceRulesFromCssText(cssText, sheetUrl)) {
      // De-dupe by all URLs in the ranked list — we may have already seen
      // this src via the resource-fallback (whose entry registers under the
      // wrong name); having BOTH a font-face entry (correct name) AND a
      // resource entry (file's internal name) is fine — both will be tried.
      for (const u of face.urls ?? [face.url]) seen.add(u);
      discovered.push(face);
    }
  }
  for (const url of observedFontUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    discovered.push({ kind: "resource", url });
  }

  const report: { family: string; weight: number; style: string; url: string; source: "font-face" | "resource"; ok: boolean; error?: string }[] = [];
  for (const item of discovered) {
    if (item.kind === "local") {
      // The page-side probe identified which local() candidate Chrome
      // actually resolved the alias to (by comparing rendered widths). We
      // route to that one specifically — NOT the first candidate we happen
      // to recognize — because Chrome's local() lookup only matches a font's
      // PostScript or full name, not its CSS family name (DM-445). Walking
      // the candidate list with a family-name-based lookup table would
      // mis-route e.g. `src: local("Menlo"), local("Monaco")` to Menlo when
      // Chrome actually paints Monaco (Menlo's PostScript name is
      // "Menlo-Regular", so the bare "Menlo" form doesn't match).
      //
      // If the probe didn't identify a match (none of the candidates
      // measured the same width as the alias), we fall back to the legacy
      // family-name lookup over the full candidate list — better than
      // nothing, and preserves behavior for cases the probe can't resolve
      // (e.g. an alias whose width happened to disagree with all candidates
      // due to layout shaping that the simple sample didn't exercise).
      const declaredWeight = parseWeightDescriptor(item.weight);
      const declaredStyle = item.style.toLowerCase();
      const declaredItalic = declaredStyle !== "" && declaredStyle !== "normal";
      const candidates = item.resolvedLocalName != null ? [item.resolvedLocalName] : item.localNames;
      for (const localName of candidates) {
        const key = systemFontKeyForLocalName(localName);
        if (key != null) {
          registerLocalFontAlias(item.family, key, declaredWeight, declaredItalic);
          break;
        }
      }
      continue;
    }
    // DM-513: try each URL in the ranked list (highest-priority format first)
    // until one fetches AND fontkit can parse the bytes. Falls through eot/svg-
    // first cascades like Slashdot's sdicon font where the woff is the 3rd or
    // 4th `url()` in `src:`.
    const candidates: string[] = item.kind === "font-face" && Array.isArray(item.urls) && item.urls.length > 0
      ? item.urls
      : [item.url];
    let lastError: string | undefined;
    let registered = false;
    for (const candidateUrl of candidates) {
      try {
        const resp = await page.context().request.get(candidateUrl);
        if (!resp.ok()) {
          lastError = `HTTP ${resp.status()}`;
          continue;
        }
        const fetched = Buffer.from(await resp.body());
        const buf = await ensureNonWoff2(fetched);

        if (item.kind === "font-face") {
          // Verify fontkit can actually parse the bytes before registering;
          // otherwise the registry holds an unusable entry and `pickWebfontVariant`
          // returns it without scoring against later candidates.
          const meta = await readFontMetadata(buf);
          if (meta == null) {
            lastError = "fontkit could not parse";
            continue;
          }
          const weightNum = parseWeightDescriptor(item.weight);
          registerWebfont(item.family, weightNum, item.style, buf, item.unicodeRange);
          report.push({ family: item.family, weight: weightNum, style: item.style, url: candidateUrl, source: "font-face", ok: true });
        } else {
          const meta = await readFontMetadata(buf);
          if (meta == null) {
            lastError = "fontkit could not parse";
            continue;
          }
          registerWebfont(meta.family, meta.weight, meta.italic ? "italic" : "normal", buf);
          report.push({ family: meta.family, weight: meta.weight, style: meta.italic ? "italic" : "normal", url: candidateUrl, source: "resource", ok: true });
        }
        registered = true;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!registered) {
      report.push({ family: item.kind === "font-face" ? item.family : "", weight: item.kind === "font-face" ? parseWeightDescriptor(item.weight) : 400, style: item.kind === "font-face" ? item.style : "normal", url: item.url, source: item.kind, ok: false, error: lastError ?? "no candidates" });
    }
  }
  return report;
}

/**
 * Resolve a CSS `local("Name")` argument to a `resolveFontKey`-style key
 * that matches our on-disk FONT_PATHS table. Returns null when the local
 * name isn't a system font we know about (so the caller walks to the next
 * `local()` in the @font-face's src list). DM-303.
 *
 * The names we recognize are limited to the families we actually ship paths
 * for in `text-to-path.ts` — Georgia / Menlo / Monaco / Courier / Times /
 * Helvetica / Arial. For unknown names we punt; the rest of the font-family
 * chain (e.g. `, serif`) will catch the gap.
 */
function systemFontKeyForLocalName(localName: string): string | null {
  const n = localName.toLowerCase().replace(/^["']|["']$/g, "").trim();
  // Strip a trailing weight/style suffix so "Georgia Bold" / "Georgia Italic"
  // / "Georgia Bold Italic" all collapse to "georgia" — `getFontInstance`
  // dispatches to the right sibling file based on the requested CSS weight
  // and style, so the alias just needs to point at the family.
  const base = n.replace(/\s+(bold|italic|oblique|regular|light|medium|semibold|black)\b/g, "").trim();
  if (base === "georgia") return "georgia";
  if (base === "menlo") return "menlo";
  if (base === "monaco") return "monaco";
  if (base === "courier" || base === "courier new") return "courier";
  if (base === "times new roman") return "times-new-roman";
  if (base === "times") return "times";
  if (base === "helvetica" || base === "helvetica neue") return "helvetica";
  if (base === "arial") return "arial";
  if (base === "sf pro" || base === "sf pro text" || base === "sf pro display") return "sf-pro";
  if (base === "sf mono" || base === "sfmono-regular") return "sf-mono";
  return null;
}

async function readFontMetadata(buf: Buffer): Promise<{ family: string; weight: number; italic: boolean } | null> {
  const fontkit = await import("fontkit");
  try {
    const f = (fontkit as any).create(buf);
    if (f == null) return null;
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

/**
 * DM-545: parse `@font-face` rules out of a raw CSS text fetched server-side.
 * Used for cross-origin stylesheets that the page-side `cssRules` walker can't
 * read. Tolerant scanner — handles top-level `@font-face` and rules nested
 * inside any number of `@media` / `@supports` / `@layer` / `@container`
 * blocks (recurses through balanced braces). Returns the same FaceRule shape
 * the page-side walker emits so the downstream registration loop is uniform.
 *
 * Not a full CSS parser — comment-stripping handles `/* … *​/`, but exotic
 * inputs (custom properties holding @font-face strings, CSSOM-injected rules
 * that never serialised back to text) aren't covered. Adequate for the
 * mainstream marketing-site case that motivated the change.
 */
export function parseFontFaceRulesFromCssText(cssText: string, baseUrl: string): Array<{ kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]> }> {
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]> }> = [];
  const re = /@font-face\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < stripped.length && depth > 0) {
      const c = stripped[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) break;
    const body = stripped.substring(start, i - 1);
    const rule = parseFontFaceBody(body, baseUrl);
    if (rule != null) out.push(rule);
  }
  return out;
}

function parseFontFaceBody(body: string, baseUrl: string): { kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]> } | null {
  const familyMatch = /font-family\s*:\s*([^;}]+)/i.exec(body);
  if (familyMatch == null) return null;
  const family = familyMatch[1].trim().replace(/^["']|["']$/g, "").trim();
  if (family === "") return null;
  const weight = (/font-weight\s*:\s*([^;}]+)/i.exec(body)?.[1].trim()) ?? "400";
  const style = (/font-style\s*:\s*([^;}]+)/i.exec(body)?.[1].trim()) ?? "normal";
  const urMatch = /unicode-range\s*:\s*([^;}]+)/i.exec(body);
  const unicodeRange = urMatch != null ? parseUnicodeRangeDescriptor(urMatch[1]) : undefined;
  const srcMatch = /src\s*:\s*([\s\S]+?)(?:;|$)/i.exec(body);
  if (srcMatch == null) return null;
  const src = srcMatch[1];
  const srcEntries: { url: string; format: string }[] = [];
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(src)) !== null) {
    srcEntries.push({ url: um[1], format: (um[2] ?? "").toLowerCase() });
  }
  if (srcEntries.length === 0) return null;
  // Same ranking as the page-side walker (woff2 > woff > ttf/otf, skip
  // eot/svg). Keeping the two ranks identical means the Node-side iterator
  // tries URLs in the same order whether they came from the page-side or
  // server-side path.
  const formatRank = (fmt: string, url: string): number => {
    const lower = fmt.toLowerCase();
    if (/embedded-opentype|svg/.test(lower)) return -1;
    if (lower.includes("woff2") || /\.woff2(\?|$)/i.test(url)) return 4;
    if (lower === "woff" || /\.woff(\?|$)/i.test(url)) return 3;
    if (/truetype|opentype/.test(lower) || /\.(ttf|otf)(\?|$)/i.test(url)) return 2;
    if (/\.eot(\?|$)/i.test(url) || /\.svg(\?|$)/i.test(url)) return -1;
    return 1;
  };
  const ranked = srcEntries
    .map((e) => ({ url: e.url, rank: formatRank(e.format, e.url) }))
    .filter((e) => e.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .map((e) => e.url);
  if (ranked.length === 0) return null;
  const absUrls: string[] = [];
  for (const u of ranked) {
    try { absUrls.push(new URL(u, baseUrl).href); } catch { /* skip */ }
  }
  if (absUrls.length === 0) return null;
  return { kind: "font-face", family, weight, style, url: absUrls[0], urls: absUrls, unicodeRange };
}

/**
 * Parse a CSS `unicode-range` descriptor value (CSS Fonts 4 §4.5) into a list
 * of inclusive `[from, to]` codepoint intervals. Accepts the three forms:
 * single (`U+26`), interval (`U+0-7F`), and wildcard (`U+4??`). Multiple
 * ranges are comma-separated. Returns `undefined` for empty / unparseable
 * input — callers treat that as the CSS default coverage (U+0..U+10FFFF).
 *
 * This is the Node-side twin of the in-page parser inlined inside
 * `discoverAndRegisterWebfonts`'s `page.evaluate` body. The page-side copy
 * can't import from here (it runs in the browser context), but the logic must
 * stay aligned — covered by tests on this exported version.
 */
export function parseUnicodeRangeDescriptor(value: string): Array<[number, number]> | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const out: Array<[number, number]> = [];
  for (const raw of v.split(",")) {
    const tok = raw.trim().replace(/^U\+/i, "");
    if (tok === "") continue;
    if (tok.includes("?")) {
      const lo = parseInt(tok.replace(/\?/g, "0"), 16);
      const hi = parseInt(tok.replace(/\?/g, "F"), 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
    } else if (tok.includes("-")) {
      const [a, b] = tok.split("-");
      const lo = parseInt(a, 16);
      const hi = parseInt(b, 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
    } else {
      const cp = parseInt(tok, 16);
      if (Number.isFinite(cp)) out.push([cp, cp]);
    }
  }
  return out.length > 0 ? out : undefined;
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

// ────────────────────────────────────────────────────────────────────────
// CAPTURE ENTRY POINT — moved from src/render/element-tree-to-svg.ts (DM-619d follow-up).
// `captureElementTree*` orchestrate the page.evaluate(CAPTURE_SCRIPT) call,
// then run the three post-capture passes (bitmap-glyph raster, replaced-element
// raster, mask-source raster) that need Node-side state. `calibrateBaselines`
// is a development-only round-trip helper that re-renders the captured tree
// and measures glyph-baseline drift for the per-font ascent table.
// ────────────────────────────────────────────────────────────────────────

/**
 * Capture the visual tree of elements within a viewport region. Warnings about
 * unsupported features encountered during capture are stored and accessible
 * via getLastCaptureWarnings() / logCaptureWarnings().
 */
export async function captureElementTree(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
): Promise<CapturedElement[]> {
  const { tree } = await captureElementTreeWithWarnings(page, selector, viewport);
  return tree;
}

/**
 * Same capture as `captureElementTree` but returns the warnings inline so
 * callers running multiple captures concurrently don't race on the
 * `lastCaptureWarnings` module global. The global is still updated so
 * single-capture callers using `getLastCaptureWarnings()` keep working.
 */
export async function captureElementTreeWithWarnings(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  opts?: {
    /** DM-562: when provided, `rasterizeReplacedElements` crops replaced-
     *  element rects from this PNG instead of taking fresh page.screenshot
     *  calls. Eliminates timing drift between the expected screenshot and
     *  rotating cross-origin-iframe content. Caller is responsible for
     *  ensuring the source covers the same coordinate space as `viewport`. */
    rasterizeFromImagePath?: string;
  },
): Promise<{ tree: CapturedElement[]; warnings: CaptureWarning[] }> {
  const result = await page.evaluate(`(${CAPTURE_SCRIPT})({sel: ${JSON.stringify(selector)}, vp: ${JSON.stringify(viewport)}})`);
  const typed = result as { tree: CapturedElement[]; warnings: CaptureWarning[] };
  const warnings = typed.warnings ?? [];
  _resetLastCaptureWarnings(warnings);
  await rasterizeBitmapGlyphs(page, typed.tree, viewport);
  await rasterizeReplacedElements(page, typed.tree, viewport, { sourceImagePath: opts?.rasterizeFromImagePath });
  await rasterizeMaskSources(page, typed.tree, viewport);
  return { tree: typed.tree, warnings };
}


/**
 * DM-457: rasterize each <canvas> / <video> / <iframe> / <object> / <embed>
 * captured in the tree. CAPTURE_SCRIPT tagged the live DOM nodes with
 * `data-domotion-rid="dr<n>"` and recorded the matching content-box rect on
 * `el.replacedSnapshot`. We hide everything else on the page via a temporary
 * stylesheet so the screenshot of each target rect contains only that
 * element's painted pixels (not overlays, sticky chrome, sibling positioned
 * elements, or non-ancestor `::before`/`::after` pseudos), then attach the PNG
 * back to the captured tree as a data URI for the renderer to emit as an
 * <image>. See `docs/17-replaced-element-snapshots.md` for the contract.
 */
async function rasterizeReplacedElements(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  opts?: { sourceImagePath?: string },
): Promise<void> {
  interface Target {
    rid: string;
    tag: string;
    rect: { x: number; y: number; width: number; height: number };
    setDataUri: (uri: string) => void;
    // DM-598: when the bitmap is smaller than the requested rect (e.g. cropped
    // from a viewport-sized expected.png and the element overflows the
    // viewport), narrow the rendered rect to match the bitmap so the renderer
    // doesn't stretch with preserveAspectRatio="none". Receives the bitmap's
    // viewport-relative position + dimensions and writes them back to the
    // captured replacedSnapshot — including x/y shifts when the element
    // overflowed the LEFT or TOP edge (framer-mobile tile videos at
    // x=-115 cropped from expected.png at x=0; without shifting x the
    // snapshot painted with a 115-px content offset).
    setRect: (x: number, y: number, w: number, h: number) => void;
  }
  const targets: Target[] = [];
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      if (el.replacedSnapshot != null) {
        const rs = el.replacedSnapshot;
        targets.push({
          rid: rs.rid,
          tag: el.tag,
          rect: { x: rs.x, y: rs.y, width: rs.width, height: rs.height },
          setDataUri: (uri) => { rs.dataUri = uri; },
          setRect: (x, y, w, h) => { rs.x = x; rs.y = y; rs.width = w; rs.height = h; },
        });
      }
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (targets.length === 0) return;

  // DM-562: custom elements (hyphenated tag — DM-511 routed them through
  // replacedSnapshot when they have shadow DOM) have light-DOM children that
  // ALSO paint inside the rect. Cropping from expected.png captures both the
  // shadow-DOM paint AND the overlapping light-DOM paint as a single image,
  // and then the renderer composites that crop on top of its own rendering
  // of the same light-DOM children — producing stacking artifacts (e.g.
  // doubled video-controls or text seen through translucent custom-element
  // backgrounds). For iframe / canvas / video / object / embed the rect is
  // truly opaque-replaced — there's no light-DOM content to double-paint —
  // so the image crop is clean. Split targets accordingly.
  const _replacedTagSet = new Set(["iframe", "canvas", "video", "object", "embed"]);
  const cropTargets: Target[] = [];
  const screenshotTargets: Target[] = [];
  for (const t of targets) {
    if (opts?.sourceImagePath != null && _replacedTagSet.has(t.tag)) {
      cropTargets.push(t);
    } else {
      screenshotTargets.push(t);
    }
  }

  // DM-562: when the caller supplies a `sourceImagePath` (the expected.png
  // already on disk), crop each rid's rect from it instead of taking fresh
  // page.screenshot calls. The per-rid screenshots originally provided
  // isolation via the hide-everything-else CSS trick, but they also happened
  // hundreds of milliseconds after the expected screenshot — so cross-origin
  // iframes with rotating carousels (Google Ads on NYT) ended up with
  // rasterized content that drifted from the expected. Cropping from the
  // SAME PNG that produced the expected eliminates the drift entirely. For
  // typical replaced elements (iframe / canvas / video / custom-element with
  // shadow DOM) the rid's content-box rect doesn't overlap with siblings, so
  // the loss of CSS-trick isolation is a no-op visually.
  if (cropTargets.length > 0 && opts?.sourceImagePath != null) {
    const sharp = (await import("sharp")).default;
    const srcMeta = await sharp(opts.sourceImagePath).metadata();
    const srcW = srcMeta.width ?? 0;
    const srcH = srcMeta.height ?? 0;
    for (const t of cropTargets) {
      // Requested viewport-relative crop region (may extend off any edge).
      const reqLeft = Math.floor(t.rect.x + viewport.x);
      const reqTop = Math.floor(t.rect.y + viewport.y);
      const reqW = Math.max(1, Math.ceil(t.rect.width));
      const reqH = Math.max(1, Math.ceil(t.rect.height));
      // Clamp to the source image bounds.
      const left = Math.max(0, reqLeft);
      const top = Math.max(0, reqTop);
      const leftDelta = left - reqLeft;
      const topDelta = top - reqTop;
      const clippedW = Math.max(1, Math.min(reqW - leftDelta, srcW - left));
      const clippedH = Math.max(1, Math.min(reqH - topDelta, srcH - top));
      if (left >= srcW || top >= srcH) continue;
      try {
        const buf = await sharp(opts.sourceImagePath)
          .extract({ left, top, width: clippedW, height: clippedH })
          .png()
          .toBuffer();
        t.setDataUri(`data:image/png;base64,${buf.toString("base64")}`);
        // DM-598 / DM-582: if the source clipped on any edge (element
        // overflowed left/top/right/bottom of the expected.png viewport),
        // narrow the captured rect AND shift x/y so the renderer paints the
        // bitmap at the corresponding viewport position. Without the shift,
        // a video at x=-115 cropped from x=0 would still paint at x=-115,
        // sliding the cropped content 115 px to the left of where Chrome
        // painted it.
        if (clippedW !== reqW || clippedH !== reqH || leftDelta !== 0 || topDelta !== 0) {
          t.setRect(t.rect.x + leftDelta, t.rect.y + topDelta, clippedW, clippedH);
        }
      } catch {
        /* leave dataUri undefined; renderer falls back to the bare box. */
      }
    }
  }
  if (screenshotTargets.length === 0) {
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-domotion-rid]").forEach(
          (el) => el.removeAttribute("data-domotion-rid"),
        );
      });
    } catch {}
    return;
  }

  // Inject hide-everything-else stylesheet. Two rules: hide every element by
  // default; revive only the element bearing data-domotion-snapshot-target
  // (and its descendants, since visibility:visible on a descendant overrides
  // the inherited hidden from an ancestor). Body/html backgrounds are forced
  // transparent so partially-transparent canvases composite cleanly via
  // omitBackground: true. Restored unconditionally in finally.
  const HIDE_CSS = [
    "*, *::before, *::after { visibility: hidden !important; }",
    "[data-domotion-snapshot-target], [data-domotion-snapshot-target] *,",
    "[data-domotion-snapshot-target] *::before, [data-domotion-snapshot-target] *::after,",
    "[data-domotion-snapshot-target]::before, [data-domotion-snapshot-target]::after { visibility: visible !important; }",
    "html, body { background: transparent !important; }",
  ].join("\n");
  let styleHandle: ElementHandle | null = null;
  try {
    styleHandle = await page.addStyleTag({ content: HIDE_CSS });
    for (const t of screenshotTargets) {
      // Move the snapshot-target marker to this element and read the LIVE
      // getBoundingClientRect at the same time. DM-584: the captured t.rect
      // is the freeze-pass rect (transforms cleared), but by the time we
      // reach rasterize, the freeze wrapper has restored every element's
      // transform — so the page now paints the element at its live post-
      // transform position. Screenshotting at the frozen page clip captures
      // the wrong region (typically blank where the element WOULD have been
      // if no transform applied, e.g. apple.com's hero `<video>` at frozen
      // x=195 / live x=-172 with `transform: matrix(1,0,0,1,-367,0)`).
      //
      // The renderer will wrap the resulting `<image>` in the same captured
      // transform `<g>` as the element's other children, so the snapshot's
      // stored rect must STAY in pre-transform (frozen) coords. We keep
      // t.rect in frozen coords but offset by the live-clamp delta so the
      // bitmap dimensions match — for pure translations (the common case),
      // a left/top delta in live coords applies identically in frozen coords.
      const liveRect = await page.evaluate((rid) => {
        const prev = document.querySelectorAll("[data-domotion-snapshot-target]");
        prev.forEach((el) => el.removeAttribute("data-domotion-snapshot-target"));
        const next = document.querySelector(`[data-domotion-rid="${rid}"]`);
        if (next == null) return null;
        next.setAttribute("data-domotion-snapshot-target", "");
        const r = next.getBoundingClientRect();
        const cs = getComputedStyle(next as HTMLElement);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        const pl = parseFloat(cs.paddingLeft) || 0;
        const pr = parseFloat(cs.paddingRight) || 0;
        const pt = parseFloat(cs.paddingTop) || 0;
        const pb = parseFloat(cs.paddingBottom) || 0;
        return {
          x: r.left + bl + pl,
          y: r.top + bt + pt,
          width: Math.max(0, r.width - bl - br - pl - pr),
          height: Math.max(0, r.height - bt - bb - pt - pb),
        };
      }, t.rid);
      // Live rect used for the screenshot clip; frozen rect stays for the
      // stored snapshot. Fall back to frozen for both when the live read
      // fails (rare — page mutated and the rid element vanished).
      const clipRect = liveRect != null && liveRect.width > 0 && liveRect.height > 0
        ? liveRect
        : t.rect;
      // page.screenshot clip wants page-absolute pixels, snapped outward.
      const reqLeft = Math.floor(clipRect.x + viewport.x);
      const reqTop = Math.floor(clipRect.y + viewport.y);
      const reqW = Math.max(1, Math.ceil(clipRect.width));
      const reqH = Math.max(1, Math.ceil(clipRect.height));
      // Clamp to page bounds (Playwright errors if clip extends past the
      // page; same logic as the cropTargets path above). Track left/top
      // deltas so we can shift the stored frozen rect by the same amount.
      const pageW = viewport.x + viewport.width;
      const pageH = viewport.y + viewport.height;
      const left = Math.max(0, reqLeft);
      const top = Math.max(0, reqTop);
      const leftDelta = left - reqLeft;
      const topDelta = top - reqTop;
      const clippedW = Math.max(1, Math.min(reqW - leftDelta, pageW - left));
      const clippedH = Math.max(1, Math.min(reqH - topDelta, pageH - top));
      if (left >= pageW || top >= pageH) continue;
      const clip = { x: left, y: top, width: clippedW, height: clippedH };
      try {
        const buf = await page.screenshot({ clip, omitBackground: true, type: "png" });
        t.setDataUri(`data:image/png;base64,${Buffer.from(buf).toString("base64")}`);
        // Adjust the FROZEN rect by the same delta as the live clip so the
        // renderer's `<image>` is sized to the bitmap (preventing the
        // stretched-bytes artifact when the page clipped the screenshot to
        // its boundaries). For pure translations the delta applies
        // identically in both coord spaces; for scaled/rotated transforms
        // on the element itself this approximation may misposition the
        // snapshot, but no currently-supported real-world fixture exercises
        // that combination on a `<video>` / `<canvas>` / `<iframe>`.
        if (clippedW !== reqW || clippedH !== reqH || leftDelta !== 0 || topDelta !== 0) {
          t.setRect(t.rect.x + leftDelta, t.rect.y + topDelta, clippedW, clippedH);
        }
      } catch {
        // Screenshot failed (e.g. clip went off-page after a layout shift).
        // Leave dataUri undefined; the renderer falls back to the bare box.
      }
    }
  } finally {
    // Strip both attributes from every element we may have touched, plus
    // remove the hide stylesheet so the live page is back to its original
    // visual state (matters when the same page is captured again, or when
    // tests inspect the page after capture).
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-domotion-snapshot-target]").forEach(
          (el) => el.removeAttribute("data-domotion-snapshot-target"),
        );
        document.querySelectorAll("[data-domotion-rid]").forEach(
          (el) => el.removeAttribute("data-domotion-rid"),
        );
      });
    } catch {}
    if (styleHandle != null) {
      try { await styleHandle.evaluate((node: Element) => { node.remove(); }); } catch {}
    }
  }
}


/**
 * DM-494: Rasterise each element referenced by `mask-image: element(#id)`.
 * Mirrors `rasterizeReplacedElements` (doc 17): hide-everything-else
 * stylesheet → screenshot the target's painted box → encode as a data URI →
 * stash on `tree[0].maskRasters[i].dataUri`. The renderer's `buildMaskDef`
 * picks up the data URI from the root tree's lookup table when it sees an
 * `element()` mask layer.
 *
 * Same-document only — CSS spec doesn't define cross-document `element()`.
 * Always-on (no opt-in flag) — dedupe by referenced id (one screenshot per
 * unique target regardless of how many consumers reference it). Targets that
 * are display:none / 0-area are filtered at capture time and never reach
 * here. See `docs/22-mask-element-paint-references.md`.
 */
async function rasterizeMaskSources(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (tree.length === 0 || tree[0].maskRasters == null || tree[0].maskRasters.length === 0) return;
  const rasters = tree[0].maskRasters;

  const HIDE_CSS = [
    "*, *::before, *::after { visibility: hidden !important; }",
    "[data-domotion-snapshot-target], [data-domotion-snapshot-target] *,",
    "[data-domotion-snapshot-target] *::before, [data-domotion-snapshot-target] *::after,",
    "[data-domotion-snapshot-target]::before, [data-domotion-snapshot-target]::after { visibility: visible !important; }",
    "html, body { background: transparent !important; }",
  ].join("\n");
  let styleHandle: ElementHandle | null = null;
  try {
    styleHandle = await page.addStyleTag({ content: HIDE_CSS });
    for (const mr of rasters) {
      await page.evaluate((rid) => {
        const prev = document.querySelectorAll("[data-domotion-snapshot-target]");
        prev.forEach((el) => el.removeAttribute("data-domotion-snapshot-target"));
        const next = document.querySelector(`[data-domotion-rid="${rid}"]`);
        if (next != null) next.setAttribute("data-domotion-snapshot-target", "");
      }, mr.rid);
      const clip = {
        x: Math.max(0, Math.floor(mr.rect.x + viewport.x)),
        y: Math.max(0, Math.floor(mr.rect.y + viewport.y)),
        width: Math.max(1, Math.ceil(mr.rect.width)),
        height: Math.max(1, Math.ceil(mr.rect.height)),
      };
      try {
        const buf = await page.screenshot({ clip, omitBackground: true, type: "png" });
        mr.dataUri = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
      } catch {
        // Screenshot failed — leave dataUri undefined; renderer skips emission.
      }
    }
  } finally {
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-domotion-snapshot-target]").forEach(
          (el) => el.removeAttribute("data-domotion-snapshot-target"),
        );
      });
    } catch {}
    if (styleHandle != null) {
      try { await styleHandle.evaluate((node: Element) => { node.remove(); }); } catch {}
    }
  }
}

/**
 * Calibrate `fontAscent` on text-bearing elements by scanning a reference
 * PNG (Chrome's actual paint) for each element's painted ink top, then
 * back-solving the sub-pixel baseline as
 * `inkTop - textTop + actualBoundingBoxAscent(text)` where the cap-height
 * comes from `canvas.measureText(text).actualBoundingBoxAscent` (sub-pixel
 * accurate, unlike `fontBoundingBoxAscent` which Chrome integer-rounds).
 *
 * Closes the residual ±0.6 px text-baseline drift documented in DM-397 /
 * DM-418. Empirical extraction at capture time — uses Chrome's actual
 * painted output as ground truth instead of trying to mirror Chromium's
 * per-platform LayoutNG strut math.
 *
 * Caller must provide PNG bytes from a Chrome screenshot of the same
 * viewport that was captured. For the test pipeline this is the same
 * `expected.png` we already write to disk for diffing.
 */
export async function calibrateBaselines(
  page: Page,
  elements: CapturedElement[],
  pngBytes: Buffer | Uint8Array,
): Promise<void> {
  // Flatten the tree into a list of text-bearing elements with stable keys
  const flat: Array<{ key: string; el: CapturedElement }> = [];
  let counter = 0;
  const walk = (els: CapturedElement[]) => {
    for (const e of els) {
      if ((e.text != null && e.text !== "") && e.textTop != null && e.textWidth != null && e.textWidth > 0 && e.textHeight != null && e.textHeight > 0) {
        flat.push({ key: `c${counter++}`, el: e });
      }
      if (e.children != null && e.children.length > 0) walk(e.children);
    }
  };
  walk(elements);
  if (flat.length === 0) return;

  const items = flat.map((f) => ({
    key: f.key,
    text: f.el.text!,
    textTop: f.el.textTop!,
    textLeft: f.el.textLeft ?? f.el.x,
    textWidth: f.el.textWidth!,
    textHeight: f.el.textHeight!,
    fontSize: parseFloat(f.el.styles.fontSize) || 14,
    fontFamily: f.el.styles.fontFamily,
    fontWeight: f.el.styles.fontWeight,
    fontStyle: f.el.styles.fontStyle,
    color: f.el.styles.color,
  }));

  const b64 = `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`;

  // The body of this evaluate is sent to the browser as a string. Keep it
  // free of TypeScript-only helpers that tsc/tsx might emit references to
  // (notably `__name` for class metadata). Plain function expressions and
  // var/let work; arrow functions are also fine, but explicit `function`
  // declarations avoid edge-cases in the transpiler output.
  const adjustments = await page.evaluate(async function (args: { b64: string; items: typeof items }) {
    var img = new Image();
    img.src = args.b64;
    await img.decode();
    var c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    var ctx = c.getContext("2d");
    if (ctx == null) return [];
    ctx.drawImage(img, 0, 0);
    var pix = ctx.getImageData(0, 0, img.width, img.height).data;
    var W = img.width;
    var bgLum = 0.299 * pix[0] + 0.587 * pix[1] + 0.114 * pix[2];

    var measureCv = document.createElement("canvas").getContext("2d");
    var out: Array<{ key: string; ascent: number | null }> = [];

    for (var ii = 0; ii < args.items.length; ii++) {
      var it = args.items[ii];
      var x0 = Math.max(0, Math.floor(it.textLeft));
      var x1 = Math.min(W, Math.ceil(it.textLeft + it.textWidth));
      var y0 = Math.max(0, Math.floor(it.textTop) - 2);
      var y1 = Math.min(img.height, Math.ceil(it.textTop + it.textHeight) + 2);
      var inkTop = -1;
      for (var y = y0; y < y1 && inkTop < 0; y++) {
        for (var x = x0; x < x1; x++) {
          var i = (y * W + x) * 4;
          var lum = 0.299 * pix[i] + 0.587 * pix[i + 1] + 0.114 * pix[i + 2];
          if (Math.abs(lum - bgLum) > 30) { inkTop = y; break; }
        }
      }
      if (inkTop < 0) { out.push({ key: it.key, ascent: null }); continue; }

      if (measureCv == null) { out.push({ key: it.key, ascent: null }); continue; }
      measureCv.font = (it.fontStyle || "normal") + " " + (it.fontWeight || "400") + " " + it.fontSize + "px " + it.fontFamily;
      var tm = measureCv.measureText(it.text);
      var subPixelAscent = tm.actualBoundingBoxAscent;
      if (!isFinite(subPixelAscent) || subPixelAscent <= 0) { out.push({ key: it.key, ascent: null }); continue; }

      var correctedAscent = (inkTop - it.textTop) + subPixelAscent;
      if (correctedAscent < it.fontSize * 0.3 || correctedAscent > it.fontSize * 1.5) {
        out.push({ key: it.key, ascent: null });
        continue;
      }
      out.push({ key: it.key, ascent: correctedAscent });
    }
    return out;
  }, { b64, items });

  for (let i = 0; i < adjustments.length; i++) {
    const adj = adjustments[i];
    if (adj.ascent != null) flat[i].el.fontAscent = adj.ascent;
  }
}
