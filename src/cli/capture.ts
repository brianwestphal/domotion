/**
 * `domotion capture` subcommand.
 *
 * Single-frame capture from a URL, file, or stdin; or, when `--scroll <pattern>`
 * is passed, an animated multi-segment scroll demo composed via the DM-604
 * scroll machinery.
 */

import { parseArgs } from "node:util";
import {
  captureElementTree,
  clearEmbeddedFonts,
  clearGlyphDefs,
  clearWebfonts,
  composeScrollSvg,
  cullElementsOutsideViewBox,
  elementTreeToSvgInner,
  executeScrollPattern,
  isDeviceChrome,
  DEVICE_CHROMES,
  isChromeTheme,
  CHROME_THEMES,
  launchChromium,
  logCaptureWarnings,
  optimizeSvg,
  parseScrollPattern,
  wrapInDeviceChrome,
  wrapSvg,
} from "../index.js";
import { attachWebfontTracker, crossOriginFramesLaunchArgs, discoverAndRegisterWebfonts } from "../capture/index.js";
import { parseCrossOriginAllowlist } from "../capture/script/cross-origin.js";
import {
  applyReadyWaits,
  inferHarPageUrl,
  isHarPath,
  isSvgzPath,
  loadInputIntoPage,
  makeLogger,
  parseColorScheme,
  parseIntFlag,
  parseTuple,
  resolveOutputPath,
  timed,
  writeOutput,
} from "./common.js";

interface CaptureFlags {
  output?: string;
  width: number;
  height: number;
  selector: string;
  clip?: [number, number, number, number];
  scroll?: [number, number];
  wait: number;
  waitFor?: string;
  fontsReady: boolean;
  optimize: boolean;
  warnings: boolean;
  mobile: boolean;
  colorScheme?: "light" | "dark" | "no-preference";
  crossOriginFrames?: string;
}

export async function runCapture(args: string[], help: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output:        { type: "string", short: "o" },
      width:         { type: "string" },
      height:        { type: "string" },
      selector:      { type: "string" },
      clip:          { type: "string" },
      "scroll-to":   { type: "string" },
      wait:          { type: "string" },
      "wait-for":    { type: "string" },
      "no-fonts-ready": { type: "boolean" },
      optimize:           { type: "boolean" },
      "no-optimize":      { type: "boolean" },
      warnings:           { type: "boolean" },
      mobile:             { type: "boolean" },
      chrome:             { type: "string" },
      "chrome-label":     { type: "string" },
      "chrome-theme":     { type: "string" },
      "color-scheme":     { type: "string" },
      "cross-origin-frames": { type: "string" },
      scroll:             { type: "string" },
      "scroll-speed":     { type: "string" },
      "scroll-selector":  { type: "string" },
      "no-prescroll":     { type: "boolean" },
      url:                { type: "string" },
      "har-fallback":     { type: "boolean" },
      quiet:              { type: "boolean" },
      debug:              { type: "boolean" },
      "debug-dir":        { type: "string" },
      help:               { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(help); process.exit(0); }
  if (positionals.length === 0) throw new Error("capture: missing <input> (URL, path, or '-')");
  if (positionals.length > 1) throw new Error(`capture: unexpected extra argument "${positionals[1]}"`);
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new Error("capture: --optimize and --no-optimize are mutually exclusive");
  }
  if (values.chrome != null && !isDeviceChrome(values.chrome)) {
    throw new Error(`capture: --chrome expects one of ${DEVICE_CHROMES.join(", ")}, got "${values.chrome}"`);
  }
  if (values["chrome-theme"] != null && !isChromeTheme(values["chrome-theme"])) {
    throw new Error(`capture: --chrome-theme expects one of ${CHROME_THEMES.join(", ")}, got "${values["chrome-theme"]}"`);
  }
  // DM-1442: --cross-origin-frames must be `*` or a non-empty comma-separated
  // host[:port] allowlist. Reject an empty value rather than silently no-op'ing.
  if (values["cross-origin-frames"] != null && parseCrossOriginAllowlist(values["cross-origin-frames"]) == null) {
    throw new Error(`capture: --cross-origin-frames expects "*" or a comma-separated host[:port] list, got "${values["cross-origin-frames"]}"`);
  }

  const input = positionals[0];
  // DM-889: a `.har` input is replayed offline via routeFromHAR (auto-detected
  // by extension, like `.svgz` output). `--url` / `--har-fallback` only apply
  // there, so reject them on a non-HAR input rather than silently ignoring.
  const har = isHarPath(input);
  if (!har && (values.url != null || values["har-fallback"] === true)) {
    throw new Error("capture: --url / --har-fallback only apply to a .har input");
  }
  // svgz is auto-detected from the output filename extension; it implies
  // --optimize unless the caller passed --no-optimize.
  const svgz = isSvgzPath(values.output);
  const flags: CaptureFlags = {
    output:      values.output,
    width:       parseIntFlag(values.width, "width", 800),
    height:      parseIntFlag(values.height, "height", 600),
    selector:    values.selector ?? "body",
    clip:        values.clip != null ? parseTuple(values.clip, 4, "clip") as [number, number, number, number] : undefined,
    scroll:      values["scroll-to"] != null ? parseTuple(values["scroll-to"], 2, "scroll-to") as [number, number] : undefined,
    wait:        parseIntFlag(values.wait, "wait", 200),
    waitFor:     values["wait-for"],
    fontsReady:  values["no-fonts-ready"] !== true,
    optimize:    values.optimize === true || (svgz && values["no-optimize"] !== true),
    warnings:    values.warnings === true,
    mobile:      values.mobile === true,
    colorScheme: parseColorScheme(values["color-scheme"]),
    crossOriginFrames: values["cross-origin-frames"],
  };

  const log = makeLogger(values.quiet === true);
  // DM-945: `--debug` records a HAR + a 1× page screenshot + the
  // captured-tree JSON to `<output>.debug/` (overridable with
  // `--debug-dir <path>`), giving consumers a turnkey reproduction
  // bundle to attach to bug reports — including the `expected.png`
  // and `actual.svg` pair `svg-review` (DM-946) consumes directly.
  const debug = values.debug === true || values["debug-dir"] != null;
  let debugDir: string | undefined;
  if (debug) {
    const { mkdirSync } = await import("node:fs");
    const { resolve, dirname, basename } = await import("node:path");
    if (values["debug-dir"] != null) {
      debugDir = resolve(values["debug-dir"]);
    } else if (flags.output != null) {
      const outPath = resolve(flags.output);
      debugDir = resolve(dirname(outPath), `${basename(outPath, ".svg").replace(/\.svgz$/, "")}.debug`);
    } else {
      throw new Error("capture: --debug requires either --output (so we can derive <output>.debug/) or --debug-dir <path>");
    }
    mkdirSync(debugDir, { recursive: true });
    log(`Debug bundle → ${debugDir}/`);
  }
  // DM-1442: opt-in cross-origin iframe recursion launches Chromium with web
  // security disabled (so cross-origin contentDocuments are readable). That
  // ALSO disables CORS for the whole capture session, so a malicious/untrusted
  // page could read cross-origin data and reach internal endpoints from inside
  // the capture browser. Print a visible warning (to stderr, regardless of
  // --quiet) so the operator knows the safety trade-off they opted into.
  if (flags.crossOriginFrames != null) {
    process.stderr.write(
      `⚠️  --cross-origin-frames is enabled: Chromium is launched with web security DISABLED ` +
      `(CORS off) so cross-origin iframe documents can be recursed into native SVG. ` +
      `Only use this on pages you trust. Allowlist: ${flags.crossOriginFrames}\n`,
    );
  }
  log(`Launching Chromium…`);
  const browser = await launchChromium({ args: crossOriginFramesLaunchArgs(flags.crossOriginFrames) });
  try {
    const ctx = await browser.newContext({
      viewport: { width: flags.width, height: flags.height },
      isMobile: flags.mobile,
      ...(flags.mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
      ...(flags.colorScheme != null ? { colorScheme: flags.colorScheme } : {}),
      // DM-945: record HAR for `--debug` so the consumer can reproduce
      // the exact network state offline (the same `tests/cache/real-
      // world/*.har` pattern the in-repo regression suites use).
      ...(debug && debugDir != null ? { recordHar: { path: `${debugDir}/capture.har`, mode: "minimal" as const } } : {}),
    });
    const page = await ctx.newPage();
    // DM-479: bump Playwright's 30 s defaults to 90 s. Long captures on
    // heavy pages routinely push past 30 s.
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    // Track every font URL the browser fetches during the page load. Most
    // webfonts are cross-origin (Google Fonts, Adobe Fonts CDNs) and don't
    // expose their resource-timing entries to JS, so this listener-based
    // tracker is how `discoverAndRegisterWebfonts` learns about them.
    const tracker = attachWebfontTracker(page);

    if (har) {
      // DM-889: replay the HAR offline. Route every request through the archive
      // (notFound: "abort" → strict, every asset must be in the HAR; opt into
      // the live network with --har-fallback), then navigate to the inferred
      // (or --url-overridden) main document URL.
      const harUrl = values.url ?? inferHarPageUrl(input);
      await ctx.routeFromHAR(input, {
        url: "**/*",
        notFound: values["har-fallback"] === true ? "fallback" : "abort",
      });
      log(`Loading ${harUrl} from HAR ${input}…`);
      await timed(log, "  loaded (HAR replay)", () => page.goto(harUrl, { waitUntil: "load" }));
    } else {
      log(`Loading ${input}…`);
      await timed(log, "  loaded", () => loadInputIntoPage(page, input));
    }
    await timed(log, "  page settled", () => applyReadyWaits(page, flags));

    // Webfont discovery: now that document.fonts.ready resolved, walk the
    // page's @font-face rules, fetch the actual bytes via the browser's
    // request stack, and register them with text-to-path so the renderer
    // draws with the real webfont glyphs instead of a system substitute.
    clearWebfonts();
    await timed(log, `  registered webfonts (${tracker.urls.size})`, () => discoverAndRegisterWebfonts(page, tracker.urls));
    tracker.detach();

    const clip = flags.clip ?? [0, 0, flags.width, flags.height];
    let svg: string;
    if (values.scroll != null) {
      // DM-609: scroll-demo mode. Parse the pattern, run the executor against
      // the live page (which captures + diffs per segment), compose the
      // multi-capture animated SVG.
      const pattern = parseScrollPattern(values.scroll);
      const speedRaw = values["scroll-speed"];
      const speed = speedRaw != null ? Number(speedRaw) : undefined;
      if (speed != null && (!Number.isFinite(speed) || speed <= 0)) {
        throw new Error(`--scroll-speed expects a positive number (px/s), got "${speedRaw}"`);
      }
      log(`Running scroll pattern: ${values.scroll}`);
      const segments = await executeScrollPattern(page, pattern, {
        selector: values["scroll-selector"],
        viewportW: clip[2],
        viewportH: clip[3],
        defaultSpeed: speed,
        prescroll: values["no-prescroll"] !== true,
        log,
      });
      // Cull each segment's tree (DM-603) before composition so off-viewBox
      // elements don't contribute paint cost in the animated output.
      await timed(log, `  culled ${segments.length} segments`, () => {
        for (const seg of segments) {
          cullElementsOutsideViewBox(seg.tree, clip[2], clip[3], undefined, 0, 1);
        }
        return Promise.resolve();
      });
      svg = await timed(log, `  composed scroll SVG`, () =>
        Promise.resolve(composeScrollSvg(segments, { viewportW: clip[2], viewportH: clip[3] })),
      );
    } else {
      log(`Capturing element tree…`);
      // DM-945: snapshot what Chrome actually painted BEFORE we run the
      // capture script (the script doesn't disturb paint, but ordering
      // keeps the debug artifact a faithful pre-capture reference for
      // svg-review (DM-946) to diff our SVG output against).
      if (debug && debugDir != null) {
        await timed(log, "  debug: expected.png", () => page.screenshot({
          clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] },
          path: `${debugDir}/expected.png`,
          omitBackground: false,
        }));
      }
      const tree = await timed(log, "  captured", () => captureElementTree(page, flags.selector, {
        x: clip[0], y: clip[1], width: clip[2], height: clip[3],
      }, { crossOriginFrames: flags.crossOriginFrames }));
      if (debug && debugDir != null) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(`${debugDir}/captured-tree.json`, JSON.stringify(tree, null, 2));
        log(`  debug: captured-tree.json (${(JSON.stringify(tree).length / 1024).toFixed(1)} KB)`);
      }
      // DM-603: single-frame static cull — mark any captured element whose
      // bbox doesn't intersect the clip viewBox. Capture already filters most
      // off-viewport elements (`outsideViewport` early-return in CAPTURE_SCRIPT),
      // so this is a defense-in-depth pass for the position:fixed-descendant
      // escape cases where an off-viewport ancestor still gets captured.
      cullElementsOutsideViewBox(tree, clip[2], clip[3], undefined, 0, 1);
      clearEmbeddedFonts(); // DM-839: reset embedded-font builder before this single-frame render
      clearGlyphDefs(); // DM-1338: glyph registry (paths mode) shares the per-generation lifecycle
      const inner = elementTreeToSvgInner(tree, clip[2], clip[3]);
      svg = wrapSvg(inner, clip[2], clip[3]);
    }
    // DM-1206: wrap the finished capture in a device bezel. Nests the produced
    // SVG (no re-render), so glyph paths match the bare capture exactly.
    if (values.chrome != null && isDeviceChrome(values.chrome)) {
      const theme = isChromeTheme(values["chrome-theme"] ?? "") ? (values["chrome-theme"] as "light" | "dark") : undefined;
      const framed = wrapInDeviceChrome(svg, values.chrome, clip[2], clip[3], { label: values["chrome-label"], theme });
      svg = framed.svg;
      log(`Wrapped in ${values.chrome} chrome (${framed.width}×${framed.height})`);
    }
    if (flags.optimize) {
      svg = await timed(log, `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`, () => Promise.resolve(optimizeSvg(svg)));
    }

    if (flags.warnings) logCaptureWarnings("capture");

    const outPath = resolveOutputPath(flags.output, input, ".svg");
    writeOutput(svg, outPath, svgz);
    if (debug && debugDir != null && outPath != null) {
      // Also drop a copy of the produced SVG into the debug dir so the
      // whole reproduction bundle lives in one folder consumers can zip
      // and attach to an issue.
      const { copyFileSync } = await import("node:fs");
      copyFileSync(outPath, `${debugDir}/actual.svg`);
    }
    // Playwright flushes `recordHar` only on `context.close()` — `browser
    // .close()` cascades but the cascade doesn't always wait for the HAR
    // write. Close the context explicitly when `--debug` so the HAR
    // lands on disk before we move on.
    if (debug) await ctx.close();
    if (debug && debugDir != null && outPath != null) {
      log(`Debug bundle written:\n` +
          `  ${debugDir}/capture.har          (Playwright HAR)\n` +
          `  ${debugDir}/expected.png         (Chrome screenshot of source)\n` +
          `  ${debugDir}/actual.svg           (copy of the produced SVG)\n` +
          `  ${debugDir}/captured-tree.json   (intermediate element tree)\n` +
          `Review with: svg-review --expected ${debugDir}/expected.png --actual ${debugDir}/actual.svg`);
    }
  } finally {
    await browser.close();
  }
}
