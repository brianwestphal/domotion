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
  clearWebfonts,
  composeScrollSvg,
  cullElementsOutsideViewBox,
  elementTreeToSvg,
  executeScrollPattern,
  launchChromium,
  logCaptureWarnings,
  optimizeSvg,
  parseScrollPattern,
  wrapSvg,
} from "../index.js";
import { attachWebfontTracker, discoverAndRegisterWebfonts } from "../capture/index.js";
import {
  applyReadyWaits,
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
      "color-scheme":     { type: "string" },
      scroll:             { type: "string" },
      "scroll-speed":     { type: "string" },
      "scroll-selector":  { type: "string" },
      "no-prescroll":     { type: "boolean" },
      quiet:              { type: "boolean" },
      help:               { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(help); process.exit(0); }
  if (positionals.length === 0) throw new Error("capture: missing <input> (URL, path, or '-')");
  if (positionals.length > 1) throw new Error(`capture: unexpected extra argument "${positionals[1]}"`);
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new Error("capture: --optimize and --no-optimize are mutually exclusive");
  }

  const input = positionals[0];
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
  };

  const log = makeLogger(values.quiet === true);
  log(`Launching Chromium…`);
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({
      viewport: { width: flags.width, height: flags.height },
      isMobile: flags.mobile,
      ...(flags.mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
      ...(flags.colorScheme != null ? { colorScheme: flags.colorScheme } : {}),
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

    log(`Loading ${input}…`);
    await timed(log, "  loaded", () => loadInputIntoPage(page, input));
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
      const tree = await timed(log, "  captured", () => captureElementTree(page, flags.selector, {
        x: clip[0], y: clip[1], width: clip[2], height: clip[3],
      }));
      // DM-603: single-frame static cull — mark any captured element whose
      // bbox doesn't intersect the clip viewBox. Capture already filters most
      // off-viewport elements (`outsideViewport` early-return in CAPTURE_SCRIPT),
      // so this is a defense-in-depth pass for the position:fixed-descendant
      // escape cases where an off-viewport ancestor still gets captured.
      cullElementsOutsideViewBox(tree, clip[2], clip[3], undefined, 0, 1);
      const inner = elementTreeToSvg(tree, clip[2], clip[3]);
      svg = wrapSvg(inner, clip[2], clip[3]);
    }
    if (flags.optimize) {
      svg = await timed(log, `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`, () => Promise.resolve(optimizeSvg(svg)));
    }

    if (flags.warnings) logCaptureWarnings("capture");

    const outPath = resolveOutputPath(flags.output, input, ".svg");
    writeOutput(svg, outPath, svgz);
  } finally {
    await browser.close();
  }
}
