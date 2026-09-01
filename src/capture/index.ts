/**
 * Page Capture
 *
 * Uses Playwright to navigate to a URL, wait for it to settle,
 * and capture the DOM as SVG via the dom-to-svg converter.
 */

import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type LaunchOptions, type Page } from "@playwright/test";
import { _dataUriCache, elementTreeToSvgInner, wrapSvg, rootSvgColorSchemeAttr } from "../render/element-tree-to-svg.js";
import { embedRemoteImages, type EmbedRemoteImagesOptions } from "./embed.js";
import { resizeEmbeddedImages, type FrozenAnimatedImageResizeRecord } from "../tree-ops/resize-embedded-images.js";
import { rasterizeConicGradients } from "../render/conic-raster.js";
import { rasterizeAdvancedGradients } from "../render/advanced-gradient-raster.js";
import { resetGeneration, registerLocalFontAlias, registerWebfont } from "../render/text-to-path.js";
import { CAPTURE_SCRIPT } from "./script.generated.js";
import { parseCrossOriginAllowlist } from "./script/cross-origin.js";
import { rasterizeBitmapGlyphs } from "./emoji.js";
import { rasterizeNativeControlSurfaces } from "./native-control-raster.js";
import { rasterizeNativeControlDecorations } from "./native-control-decoration-raster.js";
import { refineLineClampEllipsisFragments } from "./line-clamp.js";
import { captureResolvedControlPseudoStyles } from "./pseudo-style-cdp.js";
import { captureEffectiveAppearanceFacts } from "./effective-appearance-cdp.js";
import { finalizeScrollbarResizerOverlap, prepareCapturedScrollbarSets } from "./scrollbar-capture.js";
import { prepareFrameScrollCapture } from "./frame-scroll-state.js";
import { assertGenericFamilyTargetConsistency, ensureSessionGenericFamilyOverrides, serializeSessionGenericFamilyProbe } from "./generic-font-probe.js";
import { createCapturedTreeEnvelope, promoteCapturedSubtree } from "./tree-envelope.js";
import { primeBackgroundImageSizing } from "./background-image-sizing.js";
import { captureBrokenImageFallbackFacts } from "./broken-image-fallback.js";
import { captureSummaryMarkerGeometry } from "./summary-marker-cdp.js";
import { prepareTextPaintGeometry } from "./text-paint-geometry-cdp.js";
import { preparePseudoFragmentGeometry } from "./pseudo-fragment-cdp.js";
import { prepareCollapsedBorderFragmentRecords } from "./collapsed-border-fragment-cdp.js";
import { clipRectForScreenshot } from "./clip-rect.js";
import {
  isNonAffineProjectiveQuad,
  projectiveQuadResidual,
  type ProjectiveComputedState,
  type ProjectivePaintNodeFact,
  type ProjectivePaintQuad,
  type ProjectiveSvgRole,
} from "./projective-owner.js";
import { reverifyAnimationsAtFrame, seekAnimationsToFrame, type StableAnimationFrameState } from "./animation-frame.js";
import {
  reverifyCaptureRafClock,
  sampleCaptureRafClock,
  type CaptureRafClockHandle,
  type StableCaptureRafState,
} from "./raf-clock.js";
import {
  prepareReplacedMediaFrameTransaction,
  type ReplacedMediaFrameTransaction,
  type StableReplacedMediaFrameState,
} from "./replaced-media-frame.js";
import { rasterizeReplacedElements, SNAPSHOT_HIDE_CSS } from "./replaced-element-raster.js";
import { _resetLastCaptureWarnings } from "./warnings.js";
import type { CapturedElement, CapturedFrameScrollState, CapturedTreeEnvelope, CaptureWarning } from "./types.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { createFontRendererSession, withFontRendererSession, type FontRendererSession } from "../render/font-resolution.js";
import {
  AuthenticatedAnimatedImageByteCollector,
  type AuthenticatedAnimatedImageBytes,
  type StrictAnimatedImageFrameRequest,
} from "./authenticated-animated-image-bytes.js";
import {
  freezeAuthenticatedAnimatedImageFrames,
  type AnimatedImageStaticFrameRecord,
} from "./animated-image-static-frame.js";
// Brand kit (docs/85 + docs/92). `brand.js` has no browser/Playwright deps
// (node:fs / node:path / zod only), so importing it here creates no cycle with
// the capture pipeline (the template subsystem imports FROM this module, not the
// other way around).
import { brandCustomProperties, type Brand } from "../templates/brand.js";

export { createCapturedTreeEnvelope, promoteCapturedSubtree };
export { installCaptureRafClock } from "./raf-clock.js";
export type { CaptureRafClockHandle, CaptureRafTargetState, StableCaptureRafState } from "./raf-clock.js";
export type {
  ReplacedMediaDimensions,
  ReplacedMediaFrameOwner,
  ReplacedMediaKind,
  StableReplacedMediaFrameState,
} from "./replaced-media-frame.js";
export type {
  CapturedFrameAccess,
  CapturedFrameScrollOwner,
  CapturedFrameScrollRecord,
  CapturedFrameScrollState,
  CapturedSessionGenericFamilies,
  CapturedTreeEnvelope,
  CapturedTreeInput,
} from "./types.js";
export type {
  AuthenticatedAnimatedImageByteRecord,
  AuthenticatedAnimatedImageBytes,
  AnimatedImageByteFailureCode,
  StrictAnimatedImageFrameRequest,
} from "./authenticated-animated-image-bytes.js";
export type { AnimatedImageFrameObservation, AnimatedImageStaticFrameRecord } from "./animated-image-static-frame.js";

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
  /**
   * DM-1442: opt-in cross-origin `<iframe>` recursion. `"*"` recurses every
   * cross-origin frame; a comma-separated `host[:port]` list recurses only
   * frames whose origin matches an entry (exact host; `:port` requires an exact
   * port, otherwise any port). Undefined / omitted leaves cross-origin frames
   * as raster snapshots (same-origin frames recurse regardless). Enabling this
   * launches Chromium with web security disabled — which also disables CORS, so
   * only use it on trusted pages. See docs/81-iframe-recursion.md.
   */
  captureCrossOriginFrames?: string;
  /**
   * DM-2585: strict opt-in encoded-byte acquisition for the ratified base
   * animated-image owners. The ledger is attached before navigation only when
   * this non-empty list is present. Frame decoding/replacement is owned by
   * DM-2579 and is intentionally not performed here.
   */
  animatedImageFrames?: StrictAnimatedImageFrameRequest[];
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
  // Keep automation non-interactive by construction. Callers that genuinely
  // need a headed diagnostic must opt into `headless: false` explicitly.
  const launchOptions: LaunchOptions = { headless: true, ...opts };
  try {
    return await chromium.launch(launchOptions);
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
    return chromium.launch(launchOptions);
  }
}

function isMissingBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|playwright install|browserType\.launch.*Failed to launch/i.test(msg);
}

/**
 * DM-1442: Chromium launch args needed to make cross-origin `<iframe>`
 * documents readable from the in-page capture script. `--disable-web-security`
 * lifts the Same-Origin Policy on cross-document access; the
 * `--disable-features` flag co-locates frames in one renderer process so the
 * cross-origin `contentDocument` is reachable (some builds need it, harmless on
 * those that don't). Returns `[]` when `value` requests no cross-origin
 * recursion, so callers can spread it unconditionally:
 * `launchChromium({ args: crossOriginFramesLaunchArgs(value) })`.
 *
 * NOTE: disabling web security also disables CORS — only launch this way when
 * capturing your own / trusted pages. Callers should print a visible warning.
 */
export function crossOriginFramesLaunchArgs(value: string | undefined | null): string[] {
  if (parseCrossOriginAllowlist(value) == null) return [];
  return ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"];
}

/**
 * Brand for `capture` / `animate` (docs/92): inject the brand's CSS custom
 * properties onto the page's `:root` BEFORE it paints, so a page authored
 * against `var(--brand-primary)` etc. picks up the brand's palette / font /
 * radius. Uses `context.addInitScript`, which runs on every page + navigation in
 * the context BEFORE any page script — so the variables are present the first
 * time `getComputedStyle` resolves during capture.
 *
 * The properties are set as INLINE styles on the document element (`:root`),
 * which win over any author-stylesheet `:root { --brand-x: fallback }` the page
 * declares — the intent is "the brand overrides the page's built-in defaults".
 * Only the tokens the brand actually set are emitted (see
 * `brandCustomProperties`); a no-op when the brand maps to nothing.
 *
 * Call once, right after `browser.newContext(...)` and before the first
 * `newPage()` / navigation.
 */
export async function injectBrandVariables(context: BrowserContext, brand: Brand): Promise<void> {
  const props = brandCustomProperties(brand);
  if (props.length === 0) return;
  await context.addInitScript((pairs: Array<[string, string]>) => {
    // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
    // stack traces; that helper isn't in the init-script's serialized scope, so
    // without this polyfill a named inner function throws "__name is not defined"
    // at construction and the whole init script silently no-ops (same footgun the
    // capture-script's discovery loop documents). Polyfill it before we use one.
    if (typeof (window as unknown as { __name?: unknown }).__name === "undefined") {
      (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
    }
    const apply = (): void => {
      const root = document.documentElement;
      if (root == null) return;
      for (const [name, value] of pairs) root.style.setProperty(name, value);
    };
    // The init script runs at document-start, where `documentElement` is often
    // still null (before the parser creates <html>) AND is replaced once the
    // real document is parsed — so an apply here alone doesn't survive. Apply
    // now (harmless if null) AND re-apply on DOMContentLoaded, which fires after
    // <html> exists and well before the capture reads `getComputedStyle`.
    apply();
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  }, props);
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
  private captureCrossOriginFrames: string | undefined;
  private readonly animatedImageFrames: StrictAnimatedImageFrameRequest[];
  private animatedImageByteCollector: AuthenticatedAnimatedImageByteCollector | null = null;
  private authenticatedAnimatedImageBytes: AuthenticatedAnimatedImageBytes[] = [];
  private animatedImageStaticFrameRecords: AnimatedImageStaticFrameRecord[] = [];
  private frozenAnimatedImageResizeRecords: FrozenAnimatedImageResizeRecord[] = [];
  private readonly fontRendererSession: FontRendererSession = createFontRendererSession();

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
    this.captureCrossOriginFrames = opts.captureCrossOriginFrames;
    this.animatedImageFrames = opts.animatedImageFrames == null
      ? []
      : opts.animatedImageFrames.map((request) => ({ ...request }));
  }

  async init(opts: CaptureOptions): Promise<void> {
    // DM-1442: when cross-origin iframe recursion is requested, launch with web
    // security disabled so cross-origin contentDocuments are readable.
    this.browser = await launchChromium({ args: crossOriginFramesLaunchArgs(opts.captureCrossOriginFrames) });
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
    if (this.animatedImageFrames.length > 0) {
      this.animatedImageByteCollector = await AuthenticatedAnimatedImageByteCollector.install(this.page);
    }
  }

  /** Navigate to a URL and capture the visible DOM as SVG. */
  async captureUrl(path: string, waitMs = 800, idPrefix = "", opts?: { networkIdle?: boolean }): Promise<string> {
    if (this.page == null) throw new Error("Call init() first");
    await this.page.goto(`${this.baseUrl}${path}`, { waitUntil: opts?.networkIdle === true ? "networkidle" : "load" });
    await this.page.waitForTimeout(waitMs);
    if (this.animatedImageByteCollector != null) {
      this.authenticatedAnimatedImageBytes = await this.animatedImageByteCollector.collect(this.animatedImageFrames);
      this.animatedImageStaticFrameRecords = await freezeAuthenticatedAnimatedImageFrames(
        this.page, this.authenticatedAnimatedImageBytes,
      );
    }
    return this.captureCurrent(idPrefix);
  }

  /** Immutable-copy handoff consumed by the later DM-2579 transaction. */
  getAuthenticatedAnimatedImageBytes(): AuthenticatedAnimatedImageBytes[] {
    return this.authenticatedAnimatedImageBytes.map(({ record, copyBytes }) => ({
      record: structuredClone(record),
      copyBytes: () => copyBytes(),
    }));
  }

  getAnimatedImageStaticFrameRecords(): AnimatedImageStaticFrameRecord[] {
    return structuredClone(this.animatedImageStaticFrameRecords);
  }

  getFrozenAnimatedImageResizeRecords(): FrozenAnimatedImageResizeRecord[] {
    return structuredClone(this.frozenAnimatedImageResizeRecords);
  }

  /**
   * Shared post-capture pipeline (DM-1434): self-contained remote-image
   * embedding + optional resize + conic fallback completion, then reset the
   * generation-scoped caches and render the tree to SVG body markup at `height`.
   * `captureCurrent` (viewport) and `captureFullPage` (scrollable) differ only in
   * the height, so they both funnel through here.
   */
  private async renderCapturedTree(tree: CapturedElement[], height: number, idPrefix: string): Promise<string> {
    if (this.selfContained) await embedRemoteImages(tree, {
      timeoutMs: this.embedRemoteImagesTimeoutMs,
      retries: this.embedRemoteImagesRetries,
      retryBackoffMs: this.embedRemoteImagesRetryBackoffMs,
    });
    if (this.selfContained && this.embedRemoteImagesResize) {
      for (const record of this.animatedImageStaticFrameRecords) {
        _dataUriCache.set(record.pngDataUrl, record.pngDataUrl);
      }
      this.frozenAnimatedImageResizeRecords = await resizeEmbeddedImages(tree, {
        hiDPIFactor: this.embedRemoteImagesHiDPIFactor,
        authenticatedAnimatedFrames: this.animatedImageStaticFrameRecords,
      });
    }
    // DM-2327: captureElementTree already asked this live Chromium page to
    // paint conic tiles. Fill only missing entries with the historical CPU
    // approximation so direct-tree/helper-absent use remains non-fatal.
    await rasterizeConicGradients(tree, { hiDPIFactor: this.embedRemoteImagesHiDPIFactor });
    // DM-839/DM-1338/DM-1435: reset the generation-scoped caches (embedded-font
    // builder + paths-mode glyph registry) so this capture's `@font-face` block /
    // <defs> contain only its own fonts/glyphs (the renderer repopulates them
    // during elementTreeToSvg, emitting into this frame's <defs>).
    resetGeneration();
    return withFontRendererSession(this.fontRendererSession, () =>
      elementTreeToSvgInner(tree, this.width, height, idPrefix, true, this.embedRemoteImagesHiDPIFactor ?? 2));
  }

  /** Capture the current page state as SVG content. */
  async captureCurrent(idPrefix = ""): Promise<string> {
    if (this.page == null) throw new Error("Call init() first");
    const tree = await captureElementTree(this.page, "body", {
      x: 0, y: 0, width: this.width, height: this.height,
    }, { crossOriginFrames: this.captureCrossOriginFrames });
    return this.renderCapturedTree(tree, this.height, idPrefix);
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
    }, { crossOriginFrames: this.captureCrossOriginFrames });
    const svgContent = await this.renderCapturedTree(tree, pageHeight, idPrefix);
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
    await this.animatedImageByteCollector?.dispose();
    this.animatedImageByteCollector = null;
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
// Node-side discovered-font item shapes (the page.evaluate body declares its
// own structurally-identical inline copies; these are the Node-side types).
type FaceRule = { kind: "font-face"; family: string; weight: string; style: string; styleDesc: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]>; stretch?: string };
type ResourceUrl = { kind: "resource"; url: string };
type LocalFace = { kind: "local"; family: string; localNames: string[]; weight: string; style: string; resolvedLocalName: string | null };
type DiscoveredItem = FaceRule | LocalFace | ResourceUrl;
/** One row of the report returned by discoverAndRegisterWebfonts. */
type WebfontRegisterReport = { family: string; weight: number; style: string; url: string; source: "font-face" | "resource"; ok: boolean; error?: string };

/**
 * Register ONE discovered font item: a local() alias, or a fetched
 * @font-face/resource URL (trying each ranked candidate until one fetches and
 * fontkit parses). Pushes a report row. Extracted verbatim from
 * discoverAndRegisterWebfonts' Node-side loop (DM-1373).
 */
async function registerDiscoveredFont(item: DiscoveredItem, page: Page, report: WebfontRegisterReport[]): Promise<void> {
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
    return;
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
        // `item.weight` is the RAW descriptor string ("" = auto/absent) —
        // the registry parses it into selection capabilities; `weightNum` is
        // the legacy pre-collapsed scalar for the report row. `item.styleDesc`
        // is the same idea for `font-style`: RAW ("" = auto/absent), kept
        // separate from `item.style` because `item.style` is defaulted to
        // "normal" for the legacy italic-boolean/local()-probe uses above and
        // so cannot tell "declared normal" apart from "no descriptor at all"
        // — a real distinction for the webfont synthetic-italic rule's
        // variable-`slnt`-axis exemption (`webfontSyntheticItalic`), which
        // only reaches an AUTO descriptor.
        registerWebfont(item.family, weightNum, item.style, buf, item.unicodeRange, item.stretch, item.weight, item.styleDesc);
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
export async function discoverAndRegisterWebfonts(page: Page, observedFontUrls: Iterable<string> = []): Promise<WebfontRegisterReport[]> {
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
  const fromPage = await page.evaluate(() => {
    // tsx/esbuild wraps named arrow consts in `__name(fn, "name")` for nicer
    // stack traces. That helper isn't injected into page.evaluate's
    // serialized scope, so we polyfill it here. Without this, our local
    // helpers below throw "__name is not defined" at construction time.
    if (typeof (window as any).__name === "undefined") {
      (window as any).__name = function (fn: any) { return fn; };
    }
    interface FaceRule { kind: "font-face"; family: string; weight: string; style: string; styleDesc: string; url: string; urls?: string[]; unicodeRange?: Array<[number, number]>; stretch?: string }
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
        // The RAW `font-weight` DESCRIPTOR. Empty string = auto/absent — kept
        // distinct from a declared "400": an auto descriptor lets a variable
        // face's own wght range bound the instancing, while a declared value
        // (even "normal"/"400") PINS the axis to the descriptor clamp
        // (Blink's RangeSetFromAuto vs SetExplicitly split). The legacy
        // numeric collapse for report rows happens Node-side
        // (`parseWeightDescriptor`, which maps "" to 400).
        const weight = r.style.getPropertyValue("font-weight") || "";
        const styleRaw = r.style.getPropertyValue("font-style") || "";
        const style = styleRaw || "normal";
        // The RAW `font-style` DESCRIPTOR, mirroring `weight` just above —
        // empty string = auto/absent, kept distinct from `style`'s
        // "normal" default so the Node-side registry can tell "declared
        // normal" apart from "no descriptor at all" for the webfont
        // synthetic-italic rule's variable-`slnt`-axis exemption.
        const styleDesc = styleRaw;
        // The `font-stretch` DESCRIPTOR (Chrome also serializes it under the
        // spec's newer `font-width` name). Empty string = auto/absent — the
        // registry then treats the face's selection capabilities as normal
        // width and lets a variable face's own wdth range bound the instancing
        // (Blink's RangeSetFromAuto branch).
        const stretchDesc = r.style.getPropertyValue("font-stretch")
          || r.style.getPropertyValue("font-width") || "";
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
        out.push({ kind: "font-face", family, weight, style, styleDesc, url: absUrl, urls: absUrls, unicodeRange, ...(stretchDesc !== "" ? { stretch: stretchDesc } : {}) });
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

  const report: WebfontRegisterReport[] = [];
  for (const item of discovered) await registerDiscoveredFont(item, page, report);
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
  if (base === "courier") return "courier";
  // Courier New is its own face (its own key on all three platform tables);
  // conflating it with Courier pre-empted the direct match Chrome makes.
  if (base === "courier new") return "courier-new";
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
export function parseFontFaceRulesFromCssText(cssText: string, baseUrl: string): FaceRule[] {
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: FaceRule[] = [];
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

function parseFontFaceBody(body: string, baseUrl: string): FaceRule | null {
  const familyMatch = /font-family\s*:\s*([^;}]+)/i.exec(body);
  if (familyMatch == null) return null;
  const family = familyMatch[1].trim().replace(/^["']|["']$/g, "").trim();
  if (family === "") return null;
  // The raw `font-weight` descriptor; "" = auto/absent (kept distinct from a
  // declared "400" — only a declared value pins a variable face's wght axis).
  const weight = (/font-weight\s*:\s*([^;}]+)/i.exec(body)?.[1].trim()) ?? "";
  const styleMatch = /font-style\s*:\s*([^;}]+)/i.exec(body)?.[1].trim();
  const style = styleMatch ?? "normal";
  // The RAW `font-style` descriptor, kept separate from `style` above for the
  // same reason `weight` is kept separate from `parseWeightDescriptor`'s
  // collapse — see the call-site comment in `registerDiscoveredFont`.
  const styleDesc = styleMatch ?? "";
  // The `font-stretch` descriptor (or its spec-renamed `font-width` form).
  // Undefined = auto/absent; the registry then treats the face's selection
  // capabilities as normal width and instancing clamps to the font's own
  // wdth axis range (Blink's RangeSetFromAuto branch).
  const stretch = (/font-(?:stretch|width)\s*:\s*([^;}]+)/i.exec(body)?.[1].trim()) || undefined;
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
  return { kind: "font-face", family, weight, style, styleDesc, url: absUrls[0], urls: absUrls, unicodeRange, ...(stretch != null ? { stretch } : {}) };
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

interface ProjectivePaintProbe {
  key: string;
  facts: ProjectivePaintNodeFact[];
  dispose(): Promise<void>;
}

/**
 * Read Blink's live paint planes through CDP without appending marker children.
 *
 * DOM.getContentQuads works for the outer SVG layout box, SVG graphics
 * children, and HTML boxes inside <foreignObject>.  Correlation uses a private
 * page-global array of the actual Element objects, so the probe cannot activate
 * an author attribute selector or perturb layout.  The in-page capture bundle
 * consumes the array synchronously and the projective raster post-pass keeps it
 * alive only long enough to isolate the selected owner.
 */
async function measureProjectivePaintQuads(
  page: Page,
  selector: string,
  viewport: { x: number; y: number; width: number; height: number },
  includeComputedFrameState: boolean,
): Promise<ProjectivePaintProbe> {
  const key = `__domotionProjectivePaintNodes_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  interface PreparedNode {
    parent: number | null;
    influenced: boolean;
    measure: boolean;
    activationPlane: boolean;
    inlineSvgRoot: number | null;
    role: ProjectiveSvgRole;
    computed: ProjectiveComputedState | null;
    usedPreserve3d: boolean | null;
    groupingReasons: string[];
    preserve3dLayoutApplicable: boolean;
  }

  const prepared = await page.evaluate(({ sel, key, includeComputed }): Promise<PreparedNode[]> | PreparedNode[] => {
    const root = document.querySelector(sel);
    if (root == null) {
      (globalThis as typeof globalThis & Record<string, unknown>)[key] = [];
      return [];
    }

    const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
    const indexByNode = new Map<Element, number>();
    for (let index = 0; index < nodes.length; index++) indexByNode.set(nodes[index], index);
    const influenced = new Set<Element>();
    const measure = new Set<Element>();
    const activationPlanes = new Set<Element>();
    const computedByElement = new Map<Element, ProjectiveComputedState>();
    const SVG_NS = "http://www.w3.org/2000/svg";

    for (const element of nodes) {
      const style = getComputedStyle(element);
      const transform = style.transform ?? "none";
      let has3dMatrix = transform.startsWith("matrix3d(");
      if (transform !== "" && transform !== "none") {
        try { has3dMatrix = !new DOMMatrixReadOnly(transform).is2D; } catch { /* serialized fallback above */ }
      }
      const translate = style.translate ?? "none";
      const rotate = style.rotate ?? "none";
      const scale = style.scale ?? "none";
      const hasIndependent3d = /\s/.test(translate.trim()) && translate.trim().split(/\s+/).length >= 3
        || /^(?:x|y)\b/i.test(rotate.trim())
        || rotate.trim().split(/\s+/).length >= 4
        || scale.trim().split(/\s+/).length >= 3;
      const hasPerspective = style.perspective != null
        && style.perspective !== ""
        && style.perspective !== "none";
      const signal = has3dMatrix || hasIndependent3d
        || style.transformStyle === "preserve-3d"
        || hasPerspective;
      if (!signal) continue;

      if (includeComputed) {
        computedByElement.set(element, {
          transform,
          translate,
          rotate,
          scale,
          transformOrigin: style.transformOrigin ?? "",
          transformStyle: style.transformStyle ?? "flat",
          perspective: style.perspective ?? "none",
          perspectiveOrigin: style.perspectiveOrigin ?? "",
          overflowX: style.overflowX ?? "visible",
          overflowY: style.overflowY ?? "visible",
        });
      }

      influenced.add(element);
      for (const descendant of Array.from(element.querySelectorAll("*"))) {
        influenced.add(descendant);
        if (includeComputed && !computedByElement.has(descendant)) {
          const descendantStyle = getComputedStyle(descendant);
          computedByElement.set(descendant, {
            transform: descendantStyle.transform ?? "none",
            translate: descendantStyle.translate ?? "none",
            rotate: descendantStyle.rotate ?? "none",
            scale: descendantStyle.scale ?? "none",
            transformOrigin: descendantStyle.transformOrigin ?? "",
            transformStyle: descendantStyle.transformStyle ?? "flat",
            perspective: descendantStyle.perspective ?? "none",
            perspectiveOrigin: descendantStyle.perspectiveOrigin ?? "",
            overflowX: descendantStyle.overflowX ?? "visible",
            overflowY: descendantStyle.overflowY ?? "visible",
          });
        }
      }
    }

    for (const element of nodes) {
      if (!influenced.has(element)) continue;
      const style = getComputedStyle(element);
      const hasTransform = (style.transform != null && style.transform !== "" && style.transform !== "none")
        || (style.translate != null && style.translate !== "" && style.translate !== "none")
        || (style.rotate != null && style.rotate !== "" && style.rotate !== "none")
        || (style.scale != null && style.scale !== "" && style.scale !== "none")
        || style.backfaceVisibility === "hidden";
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) measure.add(element);
      if (hasTransform && rect.width > 0 && rect.height > 0) activationPlanes.add(element);
    }

    (globalThis as typeof globalThis & Record<string, unknown>)[key] = nodes;
    const result: PreparedNode[] = [];
    for (const element of nodes) {
      const parent = element === root ? null : (indexByNode.get(element.parentElement!) ?? null);
      const isSvg = element.namespaceURI === SVG_NS;
      const role: ProjectiveSvgRole = !isSvg
        ? "html-box"
        : element.localName === "svg" && (element as SVGSVGElement).ownerSVGElement == null
          ? "svg-root-box"
          : "svg-graphics";
      const style = getComputedStyle(element);
      const tag = element.localName;
      const replaced = !isSvg && /^(?:img|input|textarea|select|video|canvas|iframe|object|embed)$/.test(tag);
      const preserve3dLayoutApplicable = role !== "svg-graphics"
        && style.display !== "contents"
        && (style.display !== "inline" || replaced);
      const groupingReasons: string[] = [];
      const willChange = new Set((style.willChange ?? "").split(",").map((v) => v.trim()));
      let animatedOpacity = false;
      let animatedFilter = false;
      let animatedBackdrop = false;
      try {
        for (const animation of element.getAnimations()) {
          if (animation.playState === "idle" || animation.playState === "finished") continue;
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || effect.target !== element) continue;
          for (const frame of effect.getKeyframes()) {
            animatedOpacity ||= Object.prototype.hasOwnProperty.call(frame, "opacity");
            animatedFilter ||= Object.prototype.hasOwnProperty.call(frame, "filter");
            animatedBackdrop ||= Object.prototype.hasOwnProperty.call(frame, "backdropFilter");
          }
        }
      } catch { /* Animation inspection unavailable: static used values remain authoritative. */ }
      const extended = style as CSSStyleDeclaration & {
        webkitBoxReflect?: string;
        webkitMaskBoxImageSource?: string;
        backdropFilter?: string;
        webkitBackdropFilter?: string;
        viewTransitionName?: string;
      };
      if (Number.parseFloat(style.opacity || "1") < 1 || willChange.has("opacity") || animatedOpacity) groupingReasons.push("opacity");
      if (style.filter !== "none" || willChange.has("filter") || animatedFilter) groupingReasons.push("filter");
      if ((extended.webkitBoxReflect ?? "none") !== "none") groupingReasons.push("reflection");
      if (style.clipPath !== "none") groupingReasons.push("clip-path");
      if (style.isolation !== "auto") groupingReasons.push("isolation");
      if (style.maskImage !== "none" || (extended.webkitMaskBoxImageSource ?? "none") !== "none") groupingReasons.push("mask");
      if (style.mixBlendMode !== "normal") groupingReasons.push("blend");
      if ((extended.backdropFilter ?? extended.webkitBackdropFilter ?? "none") !== "none"
        || willChange.has("backdrop-filter") || animatedBackdrop) groupingReasons.push("backdrop-filter");
      if ((extended.viewTransitionName ?? "none") !== "none") groupingReasons.push("view-transition");
      if ((style.position === "absolute" || style.position === "fixed") && style.clip !== "auto") groupingReasons.push("css-clip");
      if (style.overflowX !== "visible" || style.overflowY !== "visible") groupingReasons.push("overflow");
      let activeViewTransition: boolean | null = null;
      try { activeViewTransition = document.documentElement.matches(":active-view-transition"); } catch { /* unsupported selector */ }
      const usedPreserve3d = style.transformStyle !== "preserve-3d" || !preserve3dLayoutApplicable
        ? false
        : activeViewTransition == null || (activeViewTransition && !groupingReasons.includes("view-transition"))
          ? null
          : groupingReasons.length === 0;
      let inlineSvgRoot: number | null = null;
      let cursor: Element | null = element;
      while (cursor != null) {
        if (cursor.namespaceURI === SVG_NS && cursor.localName === "svg") {
          inlineSvgRoot = indexByNode.get(cursor) ?? null;
        }
        cursor = cursor.parentElement;
      }
      result.push({
        parent,
        influenced: influenced.has(element),
        measure: measure.has(element),
        activationPlane: activationPlanes.has(element),
        inlineSvgRoot,
        role,
        computed: computedByElement.get(element) ?? null,
        usedPreserve3d,
        groupingReasons,
        preserve3dLayoutApplicable,
      });
    }
    return result;
  }, { sel: selector, key, includeComputed: includeComputedFrameState });

  const quadByIndex = new Map<number, { quad: ProjectivePaintQuad | null; borderQuad: ProjectivePaintQuad | null }>();
  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    await Promise.all([cdp.send("DOM.enable"), cdp.send("Runtime.enable")]);
    for (let index = 0; index < prepared.length; index++) {
      if (!prepared[index].measure) continue;
      let objectId: string | undefined;
      try {
        const evaluated = await cdp.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(key)}]?.[${index}]`,
          returnByValue: false,
          silent: true,
        });
        objectId = evaluated.result.objectId;
        if (objectId == null) throw new Error("projective paint node detached");
        const described = await cdp.send("DOM.describeNode", { objectId });
        const backendNodeId = described.node.backendNodeId;
        const content = await cdp.send("DOM.getContentQuads", { backendNodeId });
        const contentQuad = content.quads.length === 1 && content.quads[0].length === 8
          && content.quads[0].every(Number.isFinite)
          ? content.quads[0] as unknown as ProjectivePaintQuad
          : null;
        let borderQuad: ProjectivePaintQuad | null = null;
        try {
          const box = await cdp.send("DOM.getBoxModel", { backendNodeId });
          const border = box.model.border;
          if (border.length === 8 && border.every(Number.isFinite)) {
            borderQuad = border as unknown as ProjectivePaintQuad;
          }
        } catch { /* SVG graphics nodes need not expose a CSS box model. */ }
        const localize = (quad: ProjectivePaintQuad | null): ProjectivePaintQuad | null => quad == null ? null : [
          quad[0] - viewport.x, quad[1] - viewport.y,
          quad[2] - viewport.x, quad[3] - viewport.y,
          quad[4] - viewport.x, quad[5] - viewport.y,
          quad[6] - viewport.x, quad[7] - viewport.y,
        ];
        quadByIndex.set(index, { quad: localize(contentQuad), borderQuad: localize(borderQuad) });
      } catch {
        quadByIndex.set(index, { quad: null, borderQuad: null });
      } finally {
        if (objectId != null) await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } catch {
    // Missing CDP is an explicit unknown. Measured planes below become
    // non-affine so capture crosses the conservative Chromium surface boundary.
  } finally {
    await cdp?.detach().catch(() => undefined);
  }

  const facts: ProjectivePaintNodeFact[] = prepared.map((node, index) => {
    const measured = quadByIndex.get(index);
    const quad = measured?.quad ?? null;
    return {
      parent: node.parent,
      influenced: node.influenced,
      usedPreserve3d: node.usedPreserve3d,
      nonAffine: node.activationPlane && (quad == null || isNonAffineProjectiveQuad(quad)),
      inlineSvgRoot: node.inlineSvgRoot,
      role: node.role,
      quad,
      borderQuad: measured?.borderQuad ?? null,
      residual: quad == null ? null : projectiveQuadResidual(quad),
      computed: node.computed,
      groupingReasons: node.groupingReasons,
      preserve3dLayoutApplicable: node.preserve3dLayoutApplicable,
    };
  });

  return {
    key,
    facts,
    dispose: async () => {
      await page.evaluate((probeKey) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[probeKey];
      }, key).catch(() => undefined);
    },
  };
}

export interface BlinkPlatformResizerMetrics {
  /** ScrollbarTheme::ScrollbarThickness in CSS viewport pixels. */
  themeThickness: number;
  /** ChromeClient::WindowToViewportScalar, not devicePixelRatio. */
  scaleFromDIP: number;
}

const blinkPlatformResizerMetricsByPage = new WeakMap<Page, Promise<BlinkPlatformResizerMetrics>>();

/**
 * Ask the active Chromium session to paint one custom ::-webkit-resizer and
 * recover its exact CornerRect size from pixels. There is intentionally no
 * hard-coded 15/16px constant: ScrollbarTheme differs across Aura, Windows,
 * macOS overlay, and macOS legacy themes. The screenshot density is divided
 * out, so deviceScaleFactor/DPR never leaks into CSS geometry.
 */
export async function measureBlinkPlatformResizer(page: Page): Promise<BlinkPlatformResizerMetrics> {
  const cached = blinkPlatformResizerMetricsByPage.get(page);
  if (cached != null) return cached;

  const runProbe = async (probePage: Page): Promise<BlinkPlatformResizerMetrics> => {
    const token = `domotion-resizer-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const probeSize = 64;
    const position = await probePage.evaluate(({ token, probeSize }) => {
      const style = document.createElement("style");
      style.dataset.domotionResizerProbe = token;
      style.textContent = `[data-domotion-resizer-probe="${token}"]::-webkit-resizer{background:rgb(1,254,2)!important;border:0!important;box-shadow:none!important}`;
      const probe = document.createElement("div");
      probe.dataset.domotionResizerProbe = token;
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = `all:initial;position:fixed;left:0;top:0;width:${probeSize}px;height:${probeSize}px;overflow:hidden;resize:both;border:0;padding:0;background:rgb(255,0,253);z-index:2147483647;pointer-events:none;`;
      document.documentElement.append(style, probe);
      return {
        x: window.scrollX,
        y: window.scrollY,
        scaleFromDIP: window.visualViewport?.scale ?? 1,
      };
    }, { token, probeSize });

    try {
      const png = await probePage.screenshot({
        clip: { x: position.x, y: position.y, width: probeSize, height: probeSize },
        type: "png",
      });
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let minX = info.width;
      let minY = info.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels;
          if (Math.abs(data[i] - 1) <= 1
              && Math.abs(data[i + 1] - 254) <= 1
              && Math.abs(data[i + 2] - 2) <= 1) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      if (maxX < minX || maxY < minY) {
        throw new Error("Chromium platform-resizer probe painted no custom corner pixels");
      }
      const pixelsPerCssX = info.width / probeSize;
      const pixelsPerCssY = info.height / probeSize;
      const width = (maxX - minX + 1) / pixelsPerCssX;
      const height = (maxY - minY + 1) / pixelsPerCssY;
      if (Math.abs(width - height) > 0.51 || width < 1) {
        throw new Error(`Chromium platform-resizer probe returned ${width}x${height}`);
      }
      return {
        themeThickness: Math.round((width + height) / 2),
        scaleFromDIP: Number.isFinite(position.scaleFromDIP) && position.scaleFromDIP > 0
          ? position.scaleFromDIP
          : 1,
      };
    } finally {
      await probePage.evaluate((token) => {
        document.querySelectorAll(`[data-domotion-resizer-probe="${token}"]`).forEach((node) => node.remove());
      }, token).catch(() => {});
    }
  };
  const pending = (async (): Promise<BlinkPlatformResizerMetrics> => {
    try {
      return await runProbe(page);
    } catch (pageError) {
      // A strict page CSP can reject both the temporary style element and the
      // probe's inline layout declarations. The platform theme belongs to the
      // BrowserContext, so retry in a clean about:blank page from that same
      // context; retain the captured page's viewport scale for the stroke leg.
      const capturedScale = await page.evaluate(() => window.visualViewport?.scale ?? 1).catch(() => 1);
      let isolated: Page;
      try {
        isolated = await page.context().newPage();
      } catch {
        // Browser.newPage() owns its implicit context and Playwright refuses
        // context.newPage() for it. Keep the fallback in the same Browser so
        // it still samples the same platform theme and device scale.
        const browser = page.context().browser();
        if (browser == null) throw pageError;
        const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio).catch(() => 1);
        isolated = await browser.newPage({
          viewport: page.viewportSize() ?? { width: 64, height: 64 },
          deviceScaleFactor: Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
            ? deviceScaleFactor
            : 1,
        });
      }
      try {
        const fallback = await runProbe(isolated);
        return {
          themeThickness: fallback.themeThickness,
          scaleFromDIP: Number.isFinite(capturedScale) && capturedScale > 0 ? capturedScale : 1,
        };
      } catch {
        throw pageError;
      } finally {
        await isolated.close().catch(() => {});
      }
    }
  })();
  blinkPlatformResizerMetricsByPage.set(page, pending);
  try {
    return await pending;
  } catch (error) {
    blinkPlatformResizerMetricsByPage.delete(page);
    throw error;
  }
}

/**
 * Capture the visual tree of elements within a viewport region. Warnings about
 * unsupported features encountered during capture are stored and accessible
 * via getLastCaptureWarnings() / logCaptureWarnings().
 */
export interface CaptureElementTreeOptions {
  /** DM-562 / DM-2456: authoritative compositor frame for replaced-element
   * crops, alpha-proven static native pixels, and atomic time-dependent
   * native-control crops. Native controls additionally use one transparent
   * isolation frame for static alpha and overlap ownership.
   * Caller is responsible for ensuring the PNG covers the same coordinate
   * space as the capture viewport; invalid dimensions fail over to one live
   * atomic source frame instead of stretching the supplied image. */
  rasterizeFromImagePath?: string;
  /** DM-1442: the raw `--cross-origin-frames` allowlist value (`"*"` or a
   * comma-separated `host[:port]` list). Passed into the capture script so
   * cross-origin iframes whose origin is on the list recurse into native SVG
   * instead of staying a raster snapshot. Requires web security disabled via
   * `crossOriginFramesLaunchArgs`; same-origin recursion always applies. */
  crossOriginFrames?: string;
  /**
   * DM-2359: pause every document timeline at this exact millisecond before
   * any geometry/paint prepass. A refused or drifting timeline fails capture
   * explicitly instead of mixing two animation frames.
   */
  animationTimeMs?: number;
  /**
   * Pre-navigation rAF owner installed with `installCaptureRafClock()`.
   * Required to make script callback quiescence part of an animated capture;
   * when paired with `animationTimeMs`, it also activates the atomic
   * preflight/freeze/capture/reverify transaction for finite seekable video and
   * origin-clean canvas owners. Omitted legacy captures retain their existing
   * observational document-timeline/replaced-snapshot behavior.
   */
  rafClock?: CaptureRafClockHandle;
}

export async function captureElementTree(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  opts?: CaptureElementTreeOptions,
): Promise<CapturedElement[]> {
  const { tree } = await captureElementTreeWithWarnings(page, selector, viewport, opts);
  return tree;
}

/**
 * Capture into the JSON-stable Page-ownership envelope used when callers may
 * promote a descendant to a later independent render root. Legacy
 * `captureElementTree()` remains array-shaped; this opt-in form stores the live
 * Page generic-family record once beside the roots instead of requiring a
 * consumer to copy it onto promoted nodes.
 */
export async function captureElementTreeEnvelope(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  opts?: CaptureElementTreeOptions,
): Promise<CapturedTreeEnvelope> {
  return createCapturedTreeEnvelope(await captureElementTree(page, selector, viewport, opts));
}

/**
 * Await Chromium's decoder for generated `content: url(...)` images before the
 * synchronous capture walk. Blink creates an anonymous LayoutImage for the
 * content item: the pseudo's CSS width/height own inline layout advance, while
 * the child image paints at its natural size. A fresh synchronous Image probe
 * can still report zero even after the generated content has painted.
 */
async function primePseudoImageIntrinsics(page: Page): Promise<{
  propertyKey: string;
  dispose(): Promise<void>;
}> {
  const frames = page.frames();
  const propertyKey = `__domotionPseudoImageIntrinsic_${Math.random().toString(36).slice(2)}`;
  await Promise.all(frames.map(async (frame) => {
    try {
      await frame.evaluate(async (key) => {
        type PseudoImageIntrinsic = { url: string; width: number; height: number };
        type PseudoImageRecords = Partial<Record<"::before" | "::after", PseudoImageIntrinsic>>;
        const host = globalThis as unknown as { __domotionPseudoImageIntrinsicTargets?: Element[] };
        for (const prior of host.__domotionPseudoImageIntrinsicTargets ?? []) {
          try { delete (prior as unknown as Record<string, unknown>)[key]; } catch {}
        }
        const targets: Element[] = [];
        host.__domotionPseudoImageIntrinsicTargets = targets;
        const cssUrl = (content: string): string | null => {
          const match = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)]+))\s*\)/i.exec(content);
          const raw = match?.[1] ?? match?.[2] ?? match?.[3];
          if (raw == null) return null;
          try { return new URL(raw.replace(/\\(.)/g, "$1"), document.baseURI).href; } catch { return null; }
        };
        const cache = new Map<string, Promise<PseudoImageIntrinsic | null>>();
        const dimensions = (url: string): Promise<PseudoImageIntrinsic | null> => {
          const hit = cache.get(url);
          if (hit != null) return hit;
          const pending = (async () => {
            const image = new Image();
            image.src = url;
            if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
              await Promise.race([
                image.decode().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 3000)),
              ]);
            }
            return image.naturalWidth > 0 && image.naturalHeight > 0
              ? { url, width: image.naturalWidth, height: image.naturalHeight }
              : null;
          })();
          cache.set(url, pending);
          return pending;
        };
        const elements = [document.documentElement, ...Array.from(document.getElementsByTagName("*"))];
        await Promise.all(elements.map(async (element) => {
          const records: PseudoImageRecords = {};
          await Promise.all((["::before", "::after"] as const).map(async (pseudo) => {
            const content = getComputedStyle(element, pseudo).content;
            if (content == null || content === "none" || content === "normal") return;
            const url = cssUrl(content);
            if (url == null) return;
            const intrinsic = await dimensions(url);
            if (intrinsic != null) records[pseudo] = intrinsic;
          }));
          if (records["::before"] == null && records["::after"] == null) return;
          Object.defineProperty(element, key, { configurable: true, value: records });
          targets.push(element);
        }));
      }, propertyKey);
    } catch {
      // Detached/cross-origin frames are already handled as raster boundaries.
    }
  }));
  return {
    propertyKey,
    async dispose(): Promise<void> {
      await Promise.all(frames.map(async (frame) => {
        try {
          await frame.evaluate((key) => {
            const host = globalThis as unknown as { __domotionPseudoImageIntrinsicTargets?: Element[] };
            for (const target of host.__domotionPseudoImageIntrinsicTargets ?? []) {
              try { delete (target as unknown as Record<string, unknown>)[key]; } catch {}
            }
            delete host.__domotionPseudoImageIntrinsicTargets;
          }, propertyKey);
        } catch {}
      }));
    },
  };
}

/**
 * DM-2379: await Chromium's image decoder for every URL-backed mask layer and
 * leave the natural dimensions on the live element for CAPTURE_SCRIPT's
 * synchronous walk. `new Image().naturalWidth` immediately after assigning
 * src is observably zero even when the same URL already painted as a CSS mask,
 * so this async ownership boundary is required rather than a timing guess.
 */
async function primeMaskImageIntrinsics(page: Page): Promise<{ dispose(): Promise<void> }> {
  const frames = page.frames();
  await Promise.all(frames.map(async (frame) => {
    try {
      await frame.evaluate(async () => {
        const host = globalThis as unknown as {
          __domotionMaskIntrinsicTargets?: Element[];
        };
        for (const prior of host.__domotionMaskIntrinsicTargets ?? []) {
          try { delete (prior as Element & { __domotionMaskIntrinsic?: unknown }).__domotionMaskIntrinsic; } catch {}
        }
        const targets: Element[] = [];
        host.__domotionMaskIntrinsicTargets = targets;

        const splitLayers = (value: string): string[] => {
          const out: string[] = [];
          let depth = 0;
          let start = 0;
          for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (ch === "," && depth === 0) {
              out.push(value.slice(start, i));
              start = i + 1;
            }
          }
          out.push(value.slice(start));
          return out;
        };
        const cssUrl = (layer: string): string | null => {
          const match = /^\s*url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)]+))\s*\)\s*$/i.exec(layer);
          const raw = match?.[1] ?? match?.[2] ?? match?.[3];
          return raw == null ? null : raw.replace(/\\(.)/g, "$1");
        };
        const cache = new Map<string, Promise<{ w: number; h: number; ratio: number } | null>>();
        const dimensions = (url: string): Promise<{ w: number; h: number; ratio: number } | null> => {
          const hit = cache.get(url);
          if (hit != null) return hit;
          const pending = (async () => {
            const image = new Image();
            image.src = url;
            if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
              await Promise.race([
                image.decode().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 3000)),
              ]);
            }
            if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
            let ratio = image.naturalWidth / image.naturalHeight;
            // HTMLImageElement naturalWidth/Height are integers. That loses a
            // fractional SVG viewBox ratio (e.g. 3/7 reports 64x150). Ask the
            // same Chromium image layout for a large-width auto-height box so
            // the aspect survives at LayoutUnit precision.
            try {
              image.style.cssText = "all:initial;position:fixed;left:-100000px;top:0;display:block;width:4096px;height:auto;max-width:none;max-height:none;visibility:hidden;pointer-events:none";
              (document.body || document.documentElement).appendChild(image);
              const measured = getComputedStyle(image);
              const measuredWidth = Number.parseFloat(measured.width);
              const measuredHeight = Number.parseFloat(measured.height);
              if (measuredWidth > 0 && measuredHeight > 0
                  && Number.isFinite(measuredWidth) && Number.isFinite(measuredHeight)) {
                ratio = measuredWidth / measuredHeight;
              }
            } finally {
              image.remove();
            }
            return { w: image.naturalWidth, h: image.naturalHeight, ratio };
          })();
          cache.set(url, pending);
          return pending;
        };

        const elements = [document.documentElement, ...Array.from(document.getElementsByTagName("*"))];
        await Promise.all(elements.map(async (element) => {
          const style = getComputedStyle(element);
          const maskImage = style.maskImage
            || (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage
            || "";
          if (maskImage === "" || maskImage === "none") return;
          const sizes = splitLayers(style.maskSize
            || (style as CSSStyleDeclaration & { webkitMaskSize?: string }).webkitMaskSize
            || "auto");
          const resolved = await Promise.all(splitLayers(maskImage).map(async (layer, index) => {
            // The DM-2379 route activates only for contain/cover. Explicit and
            // auto sizing retain their established geometry and must not add a
            // decoder wait merely because the element happens to have a mask.
            const size = (sizes[index % sizes.length] ?? "auto").trim().toLowerCase();
            if (size !== "contain" && size !== "cover") return null;
            const url = cssUrl(layer);
            return url == null ? null : dimensions(url);
          }));
          Object.defineProperty(element, "__domotionMaskIntrinsic", {
            configurable: true,
            value: resolved,
          });
          targets.push(element);
        }));
      });
    } catch {
      // Detached/cross-origin frames are already handled as raster boundaries.
    }
  }));

  return {
    async dispose(): Promise<void> {
      await Promise.all(frames.map(async (frame) => {
        try {
          await frame.evaluate(() => {
            const host = globalThis as unknown as {
              __domotionMaskIntrinsicTargets?: Element[];
            };
            for (const target of host.__domotionMaskIntrinsicTargets ?? []) {
              try { delete (target as Element & { __domotionMaskIntrinsic?: unknown }).__domotionMaskIntrinsic; } catch {}
            }
            delete host.__domotionMaskIntrinsicTargets;
          });
        } catch {}
      }));
    },
  };
}

/**
 * `captureElementTree` + the remote-image embed pass, in one call. **Prefer this
 * over bare `captureElementTree` for any tree whose render reaches output.**
 *
 * Inlining an `<img src="https://…">`'s bytes is not optional for a Domotion
 * output: the whole contract is a self-contained SVG (fonts are embedded, glyph
 * paths are embedded, conic gradients are rasterized), and a tree that skips
 * this pass serializes the literal origin URL — which renders as blank space
 * anywhere the origin is unreachable, silently and with no warning, looking
 * correct until it is viewed somewhere else.
 *
 * It exists because that has now been found twice. `Capturer` runs the embed
 * pass internally, but the several pipelines that call `captureElementTree`
 * directly each had to remember to run it themselves, and each new capture site
 * re-opened the same hole. Pairing the two calls in one entry point means the
 * default is correct and skipping the embed has to be a deliberate choice
 * (call `captureElementTree` directly, as the paths that embed later with their
 * own warning collection / timing do).
 */
export async function captureElementTreeSelfContained(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
  opts?: {
    /** Forwarded to `captureElementTree`. */
    crossOriginFrames?: string;
    /** Forwarded to `embedRemoteImages` (fetch timeout / retries / warning sink). */
    embed?: EmbedRemoteImagesOptions;
    /** Pause all document timelines at this exact capture time. */
    animationTimeMs?: number;
  },
): Promise<CapturedElement[]> {
  const tree = await captureElementTree(page, selector, viewport, {
    ...(opts?.crossOriginFrames != null ? { crossOriginFrames: opts.crossOriginFrames } : {}),
    ...(opts?.animationTimeMs != null ? { animationTimeMs: opts.animationTimeMs } : {}),
  });
  await embedRemoteImages(tree, opts?.embed ?? {});
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
  opts?: CaptureElementTreeOptions,
): Promise<{ tree: CapturedElement[]; warnings: CaptureWarning[]; frameScrollState: CapturedFrameScrollState; animationFrameState?: StableAnimationFrameState; rafClockState?: StableCaptureRafState; replacedMediaFrameState?: StableReplacedMediaFrameState }> {
  let animationFrameState: StableAnimationFrameState | undefined;
  let rafClockState: StableCaptureRafState | undefined;
  if (opts?.animationTimeMs != null) {
    if (opts.rafClock != null) {
      rafClockState = await sampleCaptureRafClock(page, opts.rafClock, opts.animationTimeMs);
    }
    animationFrameState = await seekAnimationsToFrame(page, opts.animationTimeMs, {
      strict: true,
      includeChildFrames: true,
      settleWithAnimationFrame: opts.rafClock == null,
    });
    if (opts.rafClock != null && rafClockState != null) {
      await reverifyCaptureRafClock(page, opts.rafClock, rafClockState);
    }
  }
  const reverifyAnimationFrame = async (): Promise<void> => {
    if (animationFrameState == null) return;
    await reverifyAnimationsAtFrame(page, animationFrameState, {
      includeChildFrames: true,
      settleWithAnimationFrame: opts?.rafClock == null,
    });
    if (opts?.rafClock != null && rafClockState != null) {
      await reverifyCaptureRafClock(page, opts.rafClock, rafClockState);
    }
  };
  let replacedMediaTransaction: ReplacedMediaFrameTransaction | undefined;
  try {
    if (animationFrameState != null && rafClockState != null) {
      if (opts?.rasterizeFromImagePath != null) {
        throw new Error("atomic replaced-media capture cannot authenticate an external source image");
      }
      replacedMediaTransaction = await prepareReplacedMediaFrameTransaction(
        page,
        selector,
        viewport,
        animationFrameState,
        rafClockState,
      );
    }
  // DM-829 / DM-496: external-file `clip-path` / `mask-image` fragment refs
  // (`url("./shapes.svg#id")`) can't be resolved by the synchronous capture
  // walk (it can't fetch). Run an async pre-pass that fetches the external
  // `.svg`, inlines its `<clipPath>` / `<mask>` as a same-document def, and
  // rewrites the element's ref to `url(#localId)` — so the existing
  // same-document paths (clip-path: DM-826/DM-828; mask: DM-493) handle it
  // unchanged. A no-op (one getComputedStyle sweep, no fetches) when no
  // external refs exist; a fetch failure leaves the ref intact so the walk
  // warns as before.
  await inlineExternalSvgRefs(page);
  await reverifyAnimationFrame();

  // Default-on (DOMOTION_GENERIC_PROBE=0 disables): probe THIS capture Page's
  // painted generic families and serialize them on its captured root(s) — the
  // concrete family
  // behind `serif` / `monospace` / ... is a property of the launched session
  // (Playwright applies its own table via CDP `Page.setFontFamilies`), so the
  // Page is the only authority. Legacy arrays retain top-level annotations;
  // captureElementTreeEnvelope moves them into one JSON-stable Page envelope.
  // The renderer scopes either form to this tree, so independently captured
  // pages cannot contaminate one another. See `generic-font-probe.ts`.
  const sessionGenericFamilies = await ensureSessionGenericFamilyOverrides(page);
  await assertGenericFamilyTargetConsistency(page, sessionGenericFamilies);
  await reverifyAnimationFrame();

  const [maskIntrinsicPrime, backgroundImagePrime, pseudoImagePrime] = await Promise.all([
    primeMaskImageIntrinsics(page),
    primeBackgroundImageSizing(page),
    primePseudoImageIntrinsics(page),
  ]);
  const frameScrollCapture = await prepareFrameScrollCapture(page, opts?.crossOriginFrames).catch(async (error) => {
    await Promise.all([
      maskIntrinsicPrime.dispose().catch(() => undefined),
      backgroundImagePrime.dispose().catch(() => undefined),
      pseudoImagePrime.dispose().catch(() => undefined),
    ]);
    throw error;
  });
  await reverifyAnimationFrame();
  let pseudoStyles: Awaited<ReturnType<typeof captureResolvedControlPseudoStyles>> | undefined;
  let effectiveAppearance: Awaited<ReturnType<typeof captureEffectiveAppearanceFacts>> | undefined;
  let scrollbarCapture: Awaited<ReturnType<typeof prepareCapturedScrollbarSets>> | undefined;
  let projectiveProbe: ProjectivePaintProbe | undefined;
  let collapsedBorderFragmentProbe: Awaited<ReturnType<typeof prepareCollapsedBorderFragmentRecords>> | undefined;
  let pseudoFragmentProbe: Awaited<ReturnType<typeof preparePseudoFragmentGeometry>> | undefined;
  let textPaintProbe: Awaited<ReturnType<typeof prepareTextPaintGeometry>> | undefined;
  let result: unknown;
  try {
    const resizerMetrics = await measureBlinkPlatformResizer(page);
    await reverifyAnimationFrame();
    pseudoStyles = await captureResolvedControlPseudoStyles(page);
    await reverifyAnimationFrame();
    effectiveAppearance = await captureEffectiveAppearanceFacts(page);
    await reverifyAnimationFrame();
    scrollbarCapture = await prepareCapturedScrollbarSets(page, selector, viewport, pseudoStyles, {
      sourceImagePath: opts?.rasterizeFromImagePath,
      frameScrollCapture,
    });
    await reverifyAnimationFrame();
    projectiveProbe = await measureProjectivePaintQuads(
      page,
      selector,
      viewport,
      animationFrameState != null,
    );
    await reverifyAnimationFrame();
    collapsedBorderFragmentProbe = await prepareCollapsedBorderFragmentRecords(page, selector);
    await reverifyAnimationFrame();
    pseudoFragmentProbe = await preparePseudoFragmentGeometry(page, selector, viewport);
    await reverifyAnimationFrame();
    const captureArgs = {
      sel: selector,
      vp: viewport,
      cof: opts?.crossOriginFrames ?? "",
      rt: resizerMetrics.themeThickness,
      rs: resizerMetrics.scaleFromDIP,
      pk: pseudoStyles.propertyKey,
      ps: pseudoStyles.stylesByHost,
      ndk: pseudoStyles.decorationPropertyKey,
      ivk: pseudoStyles.inputValuePropertyKey,
      eak: effectiveAppearance.propertyKey,
      ear: effectiveAppearance.setupFailure,
      sk: scrollbarCapture.propertyKey,
      fk: frameScrollCapture.propertyKey,
      pq: projectiveProbe.facts,
      pqk: projectiveProbe.key,
      pqt: animationFrameState?.requestedTimeMs,
      pqa: animationFrameState?.animationCount,
      cbfk: collapsedBorderFragmentProbe.key,
      pgk: pseudoFragmentProbe.key,
      pik: pseudoImagePrime.propertyKey,
    };
    textPaintProbe = await prepareTextPaintGeometry(
      page,
      selector,
      viewport,
      async (textPaintKey) => {
        const neutralResult = await page.evaluate(
          `(${CAPTURE_SCRIPT})(${JSON.stringify({ ...captureArgs, tgk: textPaintKey, tgp: true })})`,
        );
        return neutralResult as { tree: CapturedElement[] };
      },
    );
    await reverifyAnimationFrame();
    result = await page.evaluate(`(${CAPTURE_SCRIPT})(${JSON.stringify({
      ...captureArgs,
      tgk: textPaintProbe.key,
    })})`);
  } finally {
    if (result == null) await frameScrollCapture.dispose();
    await collapsedBorderFragmentProbe?.dispose();
    await pseudoFragmentProbe?.dispose();
    await scrollbarCapture?.dispose();
    await effectiveAppearance?.dispose();
    await maskIntrinsicPrime.dispose();
    await backgroundImagePrime.dispose();
    await pseudoImagePrime.dispose();
    if (result == null) {
      await pseudoStyles?.dispose();
      await projectiveProbe?.dispose();
    }
  }
  try {
  const typed = result as { tree: CapturedElement[]; warnings: CaptureWarning[] };
  await replacedMediaTransaction?.bindCapturedOwners(typed.tree);
  const warnings = typed.warnings ?? [];
  for (let index = 0; index < (projectiveProbe?.facts.length ?? 0); index++) {
    const fact = projectiveProbe!.facts[index];
    if (fact.usedPreserve3d !== null) continue;
    warnings.push({
      selector: `${selector} projective-node[${index}]`,
      feature: "transform-style: preserve-3d",
      detail: "Blink used rendering-context grouping state was not observable in the paused source frame; retained the conservative outer Chromium surface.",
      status: "partial",
    });
  }
  warnings.push(...(scrollbarCapture?.warnings ?? []));
  warnings.push(...(collapsedBorderFragmentProbe?.warnings ?? []));
  warnings.push(...(pseudoFragmentProbe?.warnings ?? []));
  warnings.push(...(textPaintProbe?.warnings ?? []));
  const frameScrollState = await frameScrollCapture.snapshot();
  warnings.push(...frameScrollCapture.warnings);
  finalizeScrollbarResizerOverlap(typed.tree);
  _resetLastCaptureWarnings(warnings);
  try {
    // DM-2455: structural hosts keep their vector box/text while one separate
    // transparent Chromium atlas supplies only the closed-shadow/native
    // decoration layer. The CDP-retained part references remain alive until
    // this pass validates and consumes them.
    await reverifyAnimationFrame();
    await rasterizeNativeControlDecorations(page, typed.tree, viewport, {
      warnings,
      sourceNodeKey: projectiveProbe?.key,
      decorationNodeKey: pseudoStyles?.decorationPropertyKey,
    });
    // DM-2456: materialize native controls first, while their platform state is
    // nearest to the synchronous DOM capture. One authoritative source frame
    // plus one atomic alpha-isolation frame replace the old per-control
    // screenshots; failures append to this capture's own warnings array.
    await reverifyAnimationFrame();
    await rasterizeNativeControlSurfaces(page, typed.tree, viewport, {
      warnings,
      sourceNodeKey: projectiveProbe?.key,
      sourceImagePath: opts?.rasterizeFromImagePath,
    });
    // DM-2463: closed broken-image UA shadow roots are only available through
    // Chromium CDP. Consume their geometry/text/AX facts while the same private
    // live-node registry used by the projective/control passes is still alive.
    await reverifyAnimationFrame();
    await captureBrokenImageFallbackFacts(
      page,
      typed.tree,
      viewport,
      warnings,
      projectiveProbe?.key,
    );
    await reverifyAnimationFrame();
    await captureSummaryMarkerGeometry(page, typed.tree, viewport, warnings, projectiveProbe?.key);
    await reverifyAnimationFrame();
    await rasterizeProjectiveSurfaces(page, typed.tree, viewport, projectiveProbe?.key);
  } finally {
    await pseudoStyles?.dispose();
    pseudoStyles = undefined;
    await projectiveProbe?.dispose();
    projectiveProbe = undefined;
  }
  await reverifyAnimationFrame();
  await refineLineClampEllipsisFragments(page, typed.tree, viewport, warnings);
  await reverifyAnimationFrame();
  await rasterizeUrlFilterSurfaces(page, typed.tree, viewport);
  if (textPaintProbe != null) {
    // Bitmap glyphs and pseudo fallbacks belong to the same pre-transform
    // plane as vector glyphs. Materialize only affine-owned candidates while
    // the source DOM is neutral, then let the live pass handle everything
    // without an authoritative text geometry record.
    await reverifyAnimationFrame();
    await textPaintProbe.withNeutralTransforms(() => rasterizeBitmapGlyphs(
      page,
      typed.tree,
      viewport,
      {
        skipBackdropFilters: true,
        includeElement: (element) => element.textPaintGeometry?.neutral?.textSegments != null,
        textSegmentsFor: (element) => element.textPaintGeometry?.neutral?.textSegments,
      },
    ));
  }
  await rasterizeBitmapGlyphs(page, typed.tree, viewport, {
    includeElement: (element) => element.textPaintGeometry?.neutral == null,
    warnings,
  });
  await reverifyAnimationFrame();
  await rasterizeReplacedElements(page, typed.tree, viewport, {
    sourceImagePath: opts?.rasterizeFromImagePath,
    warnings,
  });
  await reverifyAnimationFrame();
  const replacedMediaFrameState = await replacedMediaTransaction?.finalize(typed.tree);
  await rasterizeMaskSources(page, typed.tree, viewport);
  await rasterizeAdvancedGradients(typed.tree, page);
  if (sessionGenericFamilies != null) {
    const captured = serializeSessionGenericFamilyProbe(sessionGenericFamilies);
    for (const root of typed.tree) root.sessionGenericFamilies = captured;
  }
  return {
    tree: typed.tree,
    warnings,
    frameScrollState,
    ...(animationFrameState == null ? {} : { animationFrameState }),
    ...(rafClockState == null ? {} : { rafClockState }),
    ...(replacedMediaFrameState == null ? {} : { replacedMediaFrameState }),
  };
  } finally {
    await frameScrollCapture.dispose();
    await pseudoStyles?.dispose();
    await projectiveProbe?.dispose();
    await textPaintProbe?.dispose();
  }
  } finally {
    await replacedMediaTransaction?.dispose();
  }
}

/**
 * DM-829 / DM-496: resolve external-file `clip-path` / `mask-image`
 * (`url("./shapes.svg#id")`) refs in the live page before the (synchronous)
 * capture walk runs. For each element whose computed `clip-path` or
 * `mask-image` points at a file fragment (a non-empty path before the `#`, vs
 * the same-document `url("#id")` form), fetch the `.svg` same-origin, extract
 * the referenced `<clipPath>` / `<mask>`, inline a copy into a hidden
 * in-document SVG, and rewrite the element's inline ref to `url(#localId)`.
 * Blink parses URL clip sources and geometry boxes as mutually exclusive
 * operations, so there is no trailing box token to preserve. The downstream walk
 * then sees a normal same-document fragment and the existing renderer paths
 * handle it unchanged (clip-path: DM-826/DM-828; mask: DM-493).
 *
 * Only meaningful on http(s) pages — Chrome doesn't resolve external fragment
 * refs over `file://`, and `fetch()` of a sibling file is blocked there. Any
 * failure (fetch error / non-2xx / missing or wrong-tag fragment) leaves the
 * element's ref intact, so the walk emits its existing "could not be resolved"
 * warning and the element paints unclipped / unmasked — the prior baseline.
 */
async function inlineExternalSvgRefs(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // External form: a non-empty, non-`#`-only path before the fragment.
    // `url("#id")` (same-document) has nothing before the `#` → skipped.
    const EXT = /url\(\s*["']?([^"')#]+)#([^"')\s]+)["']?\s*\)/i;
    const SVGNS = "http://www.w3.org/2000/svg";

    type Hit = { el: HTMLElement; absUrl: string; fragId: string; kind: "clip" | "mask" };
    // First sweep: collect the hits. Bail fast — the common case has none, so
    // we never fetch or mutate.
    const hits: Hit[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      const cp = cs.clipPath;
      if (cp != null && cp !== "none" && cp !== "") {
        const m = EXT.exec(cp);
        if (m != null) {
          try { hits.push({ el, absUrl: new URL(m[1], document.baseURI).href, fragId: m[2], kind: "clip" }); } catch { /* bad URL */ }
        }
      }
      const mi = cs.maskImage || (cs as unknown as { webkitMaskImage?: string }).webkitMaskImage || "";
      if (mi !== "" && mi !== "none") {
        const m = EXT.exec(mi);
        if (m != null) {
          try { hits.push({ el, absUrl: new URL(m[1], document.baseURI).href, fragId: m[2], kind: "mask" }); } catch { /* bad URL */ }
        }
      }
    }
    if (hits.length === 0) return;

    const fileCache = new Map<string, Document | null>(); // absUrl → parsed doc (null = failed)
    const localIdFor = new Map<string, string>();         // `${kind}|${absUrl}#${fragId}` → injected local id
    let host: SVGSVGElement | null = null;
    let counter = 0;

    for (const hit of hits) {
      const wantTag = hit.kind === "clip" ? "clippath" : "mask";
      const key = `${hit.kind}|${hit.absUrl}#${hit.fragId}`;
      let localId = localIdFor.get(key);
      if (localId == null) {
        let doc = fileCache.get(hit.absUrl);
        if (doc === undefined) {
          try {
            const res = await fetch(hit.absUrl);
            doc = res.ok ? new DOMParser().parseFromString(await res.text(), "image/svg+xml") : null;
          } catch { doc = null; }
          fileCache.set(hit.absUrl, doc);
        }
        if (doc == null) continue; // fetch/parse failed → leave ref intact (walk warns)
        const frag = doc.getElementById(hit.fragId);
        if (frag == null || frag.tagName.toLowerCase() !== wantTag) continue;
        if (host == null) {
          host = document.createElementNS(SVGNS, "svg");
          host.setAttribute("width", "0");
          host.setAttribute("height", "0");
          host.setAttribute("aria-hidden", "true");
          host.style.position = "absolute";
          document.body.appendChild(host);
        }
        const imported = document.importNode(frag, true) as Element;
        localId = `domotion-ext${hit.kind}-${counter++}`;
        imported.setAttribute("id", localId);
        host.appendChild(imported);
        localIdFor.set(key, localId);
      }
      if (hit.kind === "clip") {
        hit.el.style.clipPath = `url(#${localId})`;
      } else {
        // Override just the image longhand; mask-mode/size/position/repeat stay
        // from the original CSS so DM-493's same-document path reads them.
        hit.el.style.maskImage = `url(#${localId})`;
        (hit.el.style as unknown as { webkitMaskImage?: string }).webkitMaskImage = `url(#${localId})`;
      }
    }
  });
}


/**
 * Snapshot each selected CSS-3D owner as one isolated Chromium surface.
 *
 * The capture bundle stores the source node's index in the private live-DOM
 * correlation array created by measureProjectivePaintQuads.  Isolation hides
 * every non-descendant through inline visibility (restored exactly afterward),
 * leaves the owner's transforms/clips/effects and authored descendant
 * visibility intact, then trims the full capture viewport by real alpha.  This
 * avoids both sibling double-paint and guessed filter/overflow padding.
 */
export async function rasterizeProjectiveSurfaces(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
  sourceNodeKey?: string,
): Promise<void> {
  const targets: NonNullable<CapturedElement["transformSubtreeRaster"]>[] = [];
  forEachElement(tree, (element) => {
    if (element.transformSubtreeRaster != null) targets.push(element.transformSubtreeRaster);
  });
  if (targets.length === 0) return;
  if (sourceNodeKey == null) {
    throw new Error("projective raster owners are missing their Chromium source-node registry");
  }

  const restoreVisibility = async (): Promise<void> => {
    await page.evaluate(() => {
      const host = globalThis as typeof globalThis & {
        __domotionProjectiveVisibilityRestore?: Array<{
          element: Element;
          property: string;
          value: string;
          priority: string;
        }>;
      };
      for (const item of host.__domotionProjectiveVisibilityRestore ?? []) {
        const html = item.element as HTMLElement;
        if (item.value === "") html.style.removeProperty(item.property);
        else html.style.setProperty(item.property, item.value, item.priority);
      }
      delete host.__domotionProjectiveVisibilityRestore;
    }).catch(() => undefined);
  };

  for (const target of targets) {
    const sourceNodeIndex = target.sourceNodeIndex;
    if (sourceNodeIndex == null) {
      throw new Error("projective raster owner is missing its Chromium source-node correlation");
    }
    try {
      const prepared = await page.evaluate(({ index, sourceNodeKey }) => {
        const host = globalThis as typeof globalThis & {
          __domotionProjectiveVisibilityRestore?: Array<{
            element: Element;
            property: string;
            value: string;
            priority: string;
          }>;
        };
        const sourceNodes = (host as typeof host & Record<string, unknown>)[sourceNodeKey] as Element[] | undefined;
        const sourceOwner = sourceNodes?.[index];
        if (sourceOwner == null || !sourceOwner.isConnected) return false;
        const restore: NonNullable<typeof host.__domotionProjectiveVisibilityRestore> = [];
        // Publish before the first mutation so a mid-preparation exception can
        // still restore every declaration already recorded by the finally path.
        host.__domotionProjectiveVisibilityRestore = restore;
        const ownerVisibility = getComputedStyle(sourceOwner).visibility;
        for (const element of Array.from(document.querySelectorAll("*"))) {
          if (element === sourceOwner || sourceOwner.contains(element)) continue;
          const html = element as HTMLElement;
          restore.push({
            element,
            property: "visibility",
            value: html.style.getPropertyValue("visibility"),
            priority: html.style.getPropertyPriority("visibility"),
          });
          html.style.setProperty("visibility", "hidden", "important");
        }
        // A hidden ancestor's visibility is inherited. Reassert only the
        // owner's original used value; authored hidden descendants remain hidden.
        const ownerHtml = sourceOwner as HTMLElement;
        restore.push({
          element: sourceOwner,
          property: "visibility",
          value: ownerHtml.style.getPropertyValue("visibility"),
          priority: ownerHtml.style.getPropertyPriority("visibility"),
        });
        ownerHtml.style.setProperty("visibility", ownerVisibility, "important");

        // The document canvas background is propagated from html/body even
        // when those ancestor boxes have visibility:hidden. It is backdrop,
        // not paint owned by a nested projective surface, and would otherwise
        // turn an empty/backface-hidden owner into a viewport-sized opaque PNG.
        // Preserve it only when html/body is itself inside the selected owner.
        for (const canvasElement of [document.documentElement, document.body]) {
          if (canvasElement == null
              || canvasElement === sourceOwner
              || sourceOwner.contains(canvasElement)) continue;
          restore.push({
            element: canvasElement,
            property: "background",
            value: canvasElement.style.getPropertyValue("background"),
            priority: canvasElement.style.getPropertyPriority("background"),
          });
          canvasElement.style.setProperty("background", "transparent", "important");
        }

        // Ancestor effects represented by SVG wrappers must not be baked into
        // this already-global bitmap and then applied a second time. Rotation /
        // skew is likewise serialized by the capture walk; pure scale/translate
        // stays live-baked and is intentionally left in place.
        let ancestor = sourceOwner.parentElement;
        while (ancestor != null) {
          const html = ancestor as HTMLElement;
          const style = getComputedStyle(ancestor);
          const neutral: Array<[string, string]> = [];
          if (style.opacity !== "1") neutral.push(["opacity", "1"]);
          if (style.filter != null && style.filter !== "" && style.filter !== "none") {
            neutral.push(["filter", "none"]);
          }
          const mask = style.mask || (style as CSSStyleDeclaration & { webkitMask?: string }).webkitMask || "";
          if (mask !== "" && mask !== "none") {
            neutral.push(["mask", "none"], ["-webkit-mask", "none"]);
          }
          if (style.mixBlendMode !== "normal") neutral.push(["mix-blend-mode", "normal"]);

          const transform = style.transform ?? "none";
          const matrix2d = /^matrix\(\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)\s*,\s*([-.\deE+]+)/.exec(transform);
          const matrix3d = /^matrix3d\(([^)]+)\)/.exec(transform);
          const rotatesOrSkews = matrix2d != null
            ? Math.abs(Number.parseFloat(matrix2d[2])) > 1e-6 || Math.abs(Number.parseFloat(matrix2d[3])) > 1e-6
            : matrix3d != null
              ? (() => {
                  const values = matrix3d[1].split(",").map(Number.parseFloat);
                  return Math.abs(values[1] ?? 0) > 1e-6 || Math.abs(values[4] ?? 0) > 1e-6;
                })()
              : false;
          const independentRotate = style.rotate != null && style.rotate !== "" && style.rotate !== "none";
          if (rotatesOrSkews || independentRotate) {
            neutral.push(
              ["transform", "none"],
              ["translate", "none"],
              ["rotate", "none"],
              ["scale", "none"],
            );
          }
          const neutralSnapshots = neutral.map(([property, value]) => ({
            property,
            value,
            originalValue: html.style.getPropertyValue(property),
            originalPriority: html.style.getPropertyPriority(property),
          }));
          // Snapshot the entire alias set before mutating it: `mask` and
          // `-webkit-mask` share CSSOM storage, so recording the second alias
          // after setting the first would falsely restore `none !important`.
          for (const { property, value, originalValue, originalPriority } of neutralSnapshots) {
            restore.push({
              element: ancestor,
              property,
              value: originalValue,
              priority: originalPriority,
            });
            html.style.setProperty(property, value, "important");
          }
          ancestor = ancestor.parentElement;
        }
        return true;
      }, { index: sourceNodeIndex, sourceNodeKey });
      if (!prepared) throw new Error("projective raster owner detached before Chromium snapshot");

      const shot = await page.screenshot({
        clip: viewport,
        omitBackground: true,
        type: "png",
      });
      const decoded = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { data, info } = decoded;
      let minX = info.width;
      let minY = info.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3] === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < minX || maxY < minY) {
        target.empty = true;
        continue;
      }

      const pixelWidth = maxX - minX + 1;
      const pixelHeight = maxY - minY + 1;
      const cropped = await sharp(shot)
        .extract({ left: minX, top: minY, width: pixelWidth, height: pixelHeight })
        .png()
        .toBuffer();
      const scaleX = info.width / viewport.width;
      const scaleY = info.height / viewport.height;
      target.x = minX / scaleX;
      target.y = minY / scaleY;
      target.width = pixelWidth / scaleX;
      target.height = pixelHeight / scaleY;
      target.dataUri = `data:image/png;base64,${cropped.toString("base64")}`;
    } finally {
      delete target.sourceNodeIndex;
      await restoreVisibility();
    }
  }
}

/**
 * DM-2415: preserve the final Chromium surface for HTML CSS URL filters whose
 * graph contains feConvolveMatrix. Blink creates SourceGraphic from a painted
 * layer and Skia applies the matrix in layer-pixel space, including the filter
 * crop and edge tile mode. Reconstructing the subtree as vectors changes that
 * input before the primitive runs, so this deliberately snapshots the narrow
 * ownership boundary instead of approximating the kernel.
 *
 * The whole capture viewport is sampled, then trimmed by real alpha. That
 * preserves filter-region overflow without inventing a padding constant or a
 * pixel threshold. Ordinary URL filters never receive a placeholder and stay
 * vector-owned.
 */
export async function rasterizeUrlFilterSurfaces(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const targets: NonNullable<CapturedElement["urlFilterRaster"]>[] = [];
  forEachElement(tree, (el) => {
    if (el.urlFilterRaster?.token != null) targets.push(el.urlFilterRaster);
  });
  if (targets.length === 0) return;

  let styleHandle: ElementHandle | null = null;
  try {
    styleHandle = await page.addStyleTag({ content: SNAPSHOT_HIDE_CSS });
    for (const target of targets) {
      const found = await page.evaluate((token) => {
        document.querySelectorAll("[data-domotion-snapshot-target]").forEach(
          (el) => el.removeAttribute("data-domotion-snapshot-target"),
        );
        const el = document.querySelector(`[data-domotion-url-filter-raster="${token}"]`);
        if (el == null) return false;
        el.setAttribute("data-domotion-snapshot-target", "");
        return true;
      }, target.token);
      if (!found) continue;
      try {
        const shot = await page.screenshot({
          clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
          omitBackground: true,
          type: "png",
        });
        const decoded = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const { data, info } = decoded;
        let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (maxX < minX || maxY < minY) {
          target.empty = true;
          continue;
        }
        const pixelWidth = maxX - minX + 1;
        const pixelHeight = maxY - minY + 1;
        const cropped = await sharp(shot).extract({ left: minX, top: minY, width: pixelWidth, height: pixelHeight }).png().toBuffer();
        const scaleX = info.width / viewport.width;
        const scaleY = info.height / viewport.height;
        target.x = minX / scaleX;
        target.y = minY / scaleY;
        target.width = pixelWidth / scaleX;
        target.height = pixelHeight / scaleY;
        target.dataUri = `data:image/png;base64,${cropped.toString("base64")}`;
      } catch {
        // A failed screenshot leaves the existing vector URL-filter path live.
      }
    }
  } finally {
    try {
      await page.evaluate(() => {
        document.querySelectorAll("[data-domotion-snapshot-target]").forEach(
          (el) => el.removeAttribute("data-domotion-snapshot-target"),
        );
        document.querySelectorAll("[data-domotion-url-filter-raster]").forEach(
          (el) => el.removeAttribute("data-domotion-url-filter-raster"),
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
export async function rasterizeMaskSources(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (tree.length === 0 || tree[0].maskRasters == null || tree[0].maskRasters.length === 0) return;
  const rasters = tree[0].maskRasters;

  // DM-1447: a mask-image: element(#id) target can live inside a recursed
  // same-origin <iframe>. Isolating it for the clipped screenshot means hiding
  // everything in BOTH the top document AND the owning frame, while keeping the
  // enclosing <iframe> element(s) visible so the target shows through. So inject
  // the hide-everything CSS into every accessible frame, then per target mark
  // it (in its own frame) + each enclosing <iframe> element up the chain. The
  // screenshot clip is already in top-document px (the capture recorded the
  // rect against the iframe-shifted viewport — DM-1441). For a top-document
  // target the chain is just the target itself, identical to the prior path.
  const main = page.mainFrame();
  const frames = page.frames();
  const styleHandles: ElementHandle[] = [];
  const clearMarkers = async (): Promise<void> => {
    for (const f of frames) {
      try {
        await f.evaluate(() => document.querySelectorAll("[data-domotion-snapshot-target]").forEach((el) => el.removeAttribute("data-domotion-snapshot-target")));
      } catch { /* cross-origin / detached frame */ }
    }
  };
  try {
    for (const f of frames) {
      try { styleHandles.push(await f.addStyleTag({ content: SNAPSHOT_HIDE_CSS })); } catch { /* cross-origin / detached */ }
    }
    for (const mr of rasters) {
      await clearMarkers();
      // Locate the frame whose document holds the rid'd target.
      let owner: typeof main | null = null;
      for (const f of frames) {
        try {
          if (await f.evaluate((rid) => document.querySelector(`[data-domotion-rid="${rid}"]`) != null, mr.rid)) { owner = f; break; }
        } catch { /* cross-origin / detached */ }
      }
      if (owner == null) continue;
      try {
        await owner.evaluate((rid) => {
          const t = document.querySelector(`[data-domotion-rid="${rid}"]`);
          if (t != null) t.setAttribute("data-domotion-snapshot-target", "");
        }, mr.rid);
        // Mark each enclosing <iframe> element up to the main frame so the
        // target shows through (a visible child shows even inside a hidden
        // ancestor; the inner frame's own hide-CSS isolates the target there).
        let f: typeof main | null = owner;
        while (f != null && f !== main) {
          const iframeEl = await f.frameElement();
          await iframeEl.evaluate((el: Element) => el.setAttribute("data-domotion-snapshot-target", ""));
          f = f.parentFrame();
        }
      } catch { continue; }
      const clip = clipRectForScreenshot(mr.rect, viewport);
      try {
        const buf = await page.screenshot({ clip, omitBackground: true, type: "png" });
        mr.dataUri = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
      } catch {
        // Screenshot failed — leave dataUri undefined; renderer skips emission.
      }
    }
  } finally {
    await clearMarkers();
    for (const h of styleHandles) { try { await h.evaluate((node: Element) => { node.remove(); }); } catch {} }
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
  forEachElement(elements, (e) => {
    if ((e.text != null && e.text !== "") && e.textTop != null && e.textWidth != null && e.textWidth > 0 && e.textHeight != null && e.textHeight > 0) {
      flat.push({ key: `c${counter++}`, el: e });
    }
  });
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
