/**
 * Page Capture
 *
 * Uses Playwright to navigate to a URL, wait for it to settle,
 * and capture the DOM as SVG via the dom-to-svg converter.
 */

import { spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, embedRemoteImages } from "./dom-to-svg.js";
import { resizeEmbeddedImages } from "./resize-embedded-images.js";
import { rasterizeConicGradients } from "./conic-raster.js";
import { registerLocalFontAlias, registerWebfont } from "./text-to-path.js";

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
  type FaceRule = { kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[] };
  type ResourceUrl = { kind: "resource"; url: string };
  type DiscoveredItem = FaceRule | ResourceUrl;
  const fromPage = await page.evaluate(() => {
    // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
    // stack traces. That helper isn't injected into page.evaluate's
    // serialized scope, so we polyfill it here. Without this, our local
    // helpers below throw "__name is not defined" at construction time.
    if (typeof (window as any).__name === "undefined") {
      (window as any).__name = function (fn: any) { return fn; };
    }
    interface FaceRule { kind: "font-face"; family: string; weight: string; style: string; url: string; urls?: string[] }
    interface ResourceUrl { kind: "resource"; url: string }
    const out: (FaceRule | ResourceUrl)[] = [];
    const seenUrls = new Set<string>();

    interface LocalFace { kind: "local"; family: string; localNames: string[]; weight: string; style: string; resolvedLocalName: string | null }
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
      try { cssRules = sheet.cssRules; } catch { continue; }
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
            (out as any[]).push({ kind: "local", family, localNames: locals, weight, style, resolvedLocalName: resolved });
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
        out.push({ kind: "font-face", family, weight, style, url: absUrl, urls: absUrls });
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
  for (const item of discovered as any[]) {
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
      const declaredWeight = parseWeightDescriptor((item as any).weight);
      const declaredStyle = String((item as any).style ?? "normal").toLowerCase();
      const declaredItalic = declaredStyle !== "" && declaredStyle !== "normal";
      const resolved = (item as any).resolvedLocalName as string | null | undefined;
      const candidates = resolved != null ? [resolved] : (item.localNames as string[]);
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
    const candidates: string[] = item.kind === "font-face" && Array.isArray((item as any).urls) && (item as any).urls.length > 0
      ? (item as any).urls
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
          registerWebfont(item.family, weightNum, item.style, buf);
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
