#!/usr/bin/env node
/**
 * Domotion CLI — DOM-to-animated-SVG renderer.
 *
 * Two commands:
 *   domotion capture  <input> [options]   single-frame capture
 *   domotion animate  <config.json>       multi-frame animated capture
 *
 * `<input>` for `capture` may be:
 *   - a URL (`https://...`, `http://...`)
 *   - a local HTML file path
 *   - `-` to read HTML from stdin
 *
 * Run `domotion --help` for the full option list.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "@playwright/test";
import {
  captureElementTree,
  elementTreeToSvg,
  wrapSvg,
  generateAnimatedSvg,
  optimizeSvg,
  gzipSvg,
  cullFrame,
  parseScrollPattern,
  executeScrollPattern,
  composeScrollSvg,
  launchChromium,
  logCaptureWarnings,
  discoverAndRegisterWebfonts,
  attachWebfontTracker,
  clearWebfonts,
  type AnimationFrame,
  type IntraFrameAnimation,
  type Overlay,
  type SvgOverlay,
} from "./index.js";

const VERSION = "0.1.0";

const HELP = `domotion ${VERSION} — DOM-to-animated-SVG renderer

Usage:
  domotion capture <input> [options]
  domotion animate <config.json>
  domotion --help | --version

Commands:
  capture   Capture a single frame from a URL or HTML file as SVG.
  animate   Capture multiple frames described by a JSON config and stitch
            them into one animated SVG with CSS keyframe transitions.

capture options:
  -o, --output <path>      Output SVG path (default: stdout, or <input>.svg
                           when input is a file).
      --width <n>          Viewport width in CSS pixels (default 800).
      --height <n>         Viewport height in CSS pixels (default 600).
      --selector <css>     Element selector to capture (default "body").
      --clip <x,y,w,h>     Capture only this region (default: full viewport).
      --scroll-to <x,y>    Scroll the page to this offset before capturing
                           (use --scroll for an animated scroll demo).
      --wait <ms>          Sleep this long after the page settles (default 200).
      --wait-for <css>     Wait for this selector to appear before capturing.
      --no-fonts-ready     Skip the document.fonts.ready wait (default: wait).
      --optimize           Run output through SVGO.
      --no-optimize        Skip SVGO. Only meaningful when -o ends in
                           .svgz (where --optimize is implied by default).
      --scroll <pattern>   Generate an animated scroll demo. Captures the
                           page at multiple scroll positions per the
                           pattern grammar (see docs) and composes one
                           animated SVG. Examples:
                             --scroll "down:bottom/8s"
                             --scroll "720px,2s until bottom"
                             --scroll "(720px,2s until bottom - 1000px), (200px,3s until bottom)"
      --scroll-speed <n>   Default scroll speed in px/s (used by pattern
                           tokens that don't specify their own /<duration>).
                           Default: 1500.
      --scroll-selector <s> CSS selector for an inner scrollable element
                           to scroll (default: window).
      --no-prescroll       Skip the pre-scroll-to-bottom-then-top step
                           that wakes lazy-loaded content. Default: on.
      --warnings           Log capture warnings to stderr after capture.
      --mobile             Emulate a mobile device (iOS UA, isMobile=true).
      --color-scheme <s>   Set prefers-color-scheme: "light" | "dark" | "no-preference".

animate config (JSON):
  {
    "width":  800,
    "height": 400,
    "output": "demo.svg",
    "optimize": true,
    "frames": [
      {
        "input":      "./frames/start.html",        // or a URL
        "duration":   1500,                         // ms held on screen
        "transition": { "type": "crossfade", "duration": 300 },
        "selector":   "body",                       // optional
        "wait":       200,                          // optional ms
        "waitFor":    ".ready",                     // optional CSS selector
        "scrollTo":   [0, 0],                       // optional [x, y] — scroll to here BEFORE capture
        "scroll":     {                             // optional — scroll-demo block (DM-612)
          "pattern":  "down:bottom/8s",             //   pattern grammar (see docs)
          "speed":    1500,                         //   optional default px/s
          "selector": ".panel",                     //   optional inner-element to scroll
          "prescroll": true                         //   optional, default true
        },
        "actions": [                                // optional, run before capture
          { "type": "click",     "selector": ".btn" },
          { "type": "fill",      "selector": "input", "value": "hi" },
          { "type": "press",     "key": "Enter" },
          { "type": "scroll",    "y": 200 },
          { "type": "hover",     "selector": ".tooltip" },
          { "type": "wait",      "ms": 300 }
        ],
        "overlays": [                               // see Overlay types
          { "kind": "tap",    "x": 100, "y": 50 },
          { "kind": "typing", "text": "Hello", "x": 20, "y": 40 }
        ],
        "animations": [                             // intra-frame motion
          {
            "selector": ".bar",                     // CSS selector in source HTML
            "property": "transform",                // or width/height/opacity/translateX/translateY
            "from": "scaleX(0)",
            "to":   "scaleX(1)",
            "duration": 2000,
            "easing": "ease-out",                   // optional, default "linear"
            "delay": 150                            // optional ms after frame start
          }
        ]
      }
    ]
  }

  Transition types: "crossfade" | "push-left" | "scroll" | "cut".
                  ("cut" = instant; duration is ignored.)
  Paths in "input" are resolved relative to the config file's directory.

Examples:
  # Capture the front page of example.com at 1280×720.
  domotion capture https://example.com --width 1280 --height 720 -o demo.svg

  # Capture a local HTML file, optimized, only the .hero region.
  domotion capture ./hero.html --selector ".hero" --optimize -o hero.svg

  # Capture HTML piped on stdin.
  cat my.html | domotion capture - -o out.svg

  # Capture as gzip-compressed .svgz (auto-detected from -o extension;
  # implies --optimize unless --no-optimize is also passed).
  domotion capture ./hero.html -o hero.svgz

  # Build a 3-frame animated demo from a config.
  domotion animate ./demo.json
`;

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    if (cmd === "capture") {
      await runCapture(rest);
    } else if (cmd === "animate") {
      await runAnimate(rest);
    } else {
      process.stderr.write(`domotion: unknown command "${cmd}"\n\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`domotion: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

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

async function runCapture(args: string[]): Promise<void> {
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
      help:               { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(HELP); process.exit(0); }
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

    await loadInputIntoPage(page, input);
    await applyReadyWaits(page, flags);

    // Webfont discovery: now that document.fonts.ready resolved, walk the
    // page's @font-face rules, fetch the actual bytes via the browser's
    // request stack, and register them with text-to-path so the renderer
    // draws with the real webfont glyphs instead of a system substitute.
    clearWebfonts();
    await discoverAndRegisterWebfonts(page, tracker.urls);
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
      const segments = await executeScrollPattern(page, pattern, {
        selector: values["scroll-selector"],
        viewportW: clip[2],
        viewportH: clip[3],
        defaultSpeed: speed,
        prescroll: values["no-prescroll"] !== true,
      });
      // Cull each segment's tree (DM-603) before composition so off-viewBox
      // elements don't contribute paint cost in the animated output.
      for (const seg of segments) {
        cullFrame(seg.tree, clip[2], clip[3], undefined, 0, 1);
      }
      svg = composeScrollSvg(segments, { viewportW: clip[2], viewportH: clip[3] });
    } else {
      const tree = await captureElementTree(page, flags.selector, {
        x: clip[0], y: clip[1], width: clip[2], height: clip[3],
      });
      // DM-603: single-frame static cull — mark any captured element whose
      // bbox doesn't intersect the clip viewBox. Capture already filters most
      // off-viewport elements (`outsideViewport` early-return in CAPTURE_SCRIPT),
      // so this is a defense-in-depth pass for the position:fixed-descendant
      // escape cases where an off-viewport ancestor still gets captured.
      cullFrame(tree, clip[2], clip[3], undefined, 0, 1);
      const inner = elementTreeToSvg(tree, clip[2], clip[3]);
      svg = wrapSvg(inner, clip[2], clip[3]);
    }
    if (flags.optimize) svg = optimizeSvg(svg);

    if (flags.warnings) logCaptureWarnings("capture");

    const outPath = resolveOutputPath(flags.output, input, ".svg");
    writeOutput(svg, outPath, svgz);
  } finally {
    await browser.close();
  }
}

interface AnimateConfig {
  width: number;
  height: number;
  output?: string;
  optimize?: boolean;
  mobile?: boolean;
  colorScheme?: "light" | "dark" | "no-preference";
  frames: AnimateFrameConfig[];
}

interface AnimateFrameConfig {
  input: string;
  duration: number;
  transition?: { type: "crossfade" | "push-left" | "scroll" | "cut"; duration: number };
  selector?: string;
  wait?: number;
  waitFor?: string;
  /**
   * Scroll the page (or `selector`'s element) to this offset BEFORE the
   * capture. For static positioning before a fold-style capture. See
   * `scroll` (below) for the new pattern-based animated-scroll demo flow.
   */
  scrollTo?: [number, number];
  /**
   * DM-612: pattern-based scroll-demo block. When present, the frame's
   * `input` is loaded normally and the scroll executor runs against it; the
   * resulting per-segment captures are composed into one animated SVG that
   * becomes this frame's content. Set the frame's `duration` to ≈ the
   * pattern's total scroll time so the outer scene cycle matches the inner
   * scroll's infinite loop (the two animations are independent; mismatched
   * durations desync visibly).
   */
  scroll?: AnimateFrameScrollConfig;
  actions?: AnimateAction[];
  // Overlays passed through verbatim — typed as unknown[] here, validated by AnimationFrame at runtime.
  overlays?: unknown[];
  /** Intra-frame animations (DM-209). Selector resolved against the captured DOM. */
  animations?: AnimateFrameAnimationConfig[];
}

interface AnimateFrameScrollConfig {
  /** Required. Pattern string per the DM-604 grammar (`docs/...`). */
  pattern: string;
  /** Default scroll speed in px/s for tokens without explicit `/<duration>`. */
  speed?: number;
  /** CSS selector for an inner scrollable element (default: window). */
  selector?: string;
  /** Skip the pre-scroll-to-bottom-then-top step. Default: false. */
  prescroll?: boolean;
}

interface AnimateFrameAnimationConfig {
  selector: string;
  property: IntraFrameAnimation["property"];
  from: string;
  to: string;
  duration: number;
  easing?: string;
  delay?: number;
}

type AnimateAction =
  | { type: "click";  selector: string }
  | { type: "fill";   selector: string; value: string }
  | { type: "press";  key: string }
  | { type: "scroll"; x?: number; y?: number }
  | { type: "hover";  selector: string }
  | { type: "wait";   ms: number };

async function runAnimate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output:        { type: "string", short: "o" },
      optimize:      { type: "boolean" },
      "no-optimize": { type: "boolean" },
      help:          { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(HELP); process.exit(0); }
  if (positionals.length === 0) throw new Error("animate: missing <config.json>");
  if (positionals.length > 1) throw new Error(`animate: unexpected extra argument "${positionals[1]}"`);
  if (values.optimize === true && values["no-optimize"] === true) {
    throw new Error("animate: --optimize and --no-optimize are mutually exclusive");
  }

  const configPath = resolve(positionals[0]);
  if (!existsSync(configPath)) throw new Error(`animate: config not found: ${configPath}`);

  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as AnimateConfig;
  validateAnimateConfig(cfg);
  const configDir = dirname(configPath);

  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({
      viewport: { width: cfg.width, height: cfg.height },
      isMobile: cfg.mobile === true,
      ...(cfg.mobile === true ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
      ...(cfg.colorScheme != null ? { colorScheme: cfg.colorScheme } : {}),
    });
    const page = await ctx.newPage();
    // DM-479: 90 s instead of Playwright's 30 s default.
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    const frames: AnimationFrame[] = [];
    // Frames may pull from different documents with different webfonts.
    // Clear once at the start; each frame's discovery accumulates into the
    // same registry. Multiple frames declaring the same family register
    // multiple variants and the resolver picks the closest weight/style.
    clearWebfonts();
    // One tracker for the whole animate run — fonts fetched by any frame
    // get accumulated, and we deduplicate URLs inside discoverAndRegister.
    const tracker = attachWebfontTracker(page);

    for (let i = 0; i < cfg.frames.length; i++) {
      const fc = cfg.frames[i];
      const input = resolveFrameInput(fc.input, configDir);
      await loadInputIntoPage(page, input);
      await applyReadyWaits(page, {
        wait: fc.wait ?? 200,
        waitFor: fc.waitFor,
        fontsReady: true,
      });
      await discoverAndRegisterWebfonts(page, tracker.urls);
      if (fc.scrollTo != null) {
        const sx = fc.scrollTo[0], sy = fc.scrollTo[1];
        await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [sx, sy]);
      }
      if (fc.actions != null) await runActions(page, fc.actions);

      // Intra-frame animations (DM-209): tag the live DOM with
      // `data-domotion-anim="<id>"` for each animation's selector. The capture
      // pass picks up the data attribute and the renderer surfaces it as
      // class="anim-<id>" on the rendered group, which the animator targets
      // with a CSS keyframe block.
      const resolvedAnimations: IntraFrameAnimation[] = [];
      if (fc.animations != null && fc.animations.length > 0) {
        for (let ai = 0; ai < fc.animations.length; ai++) {
          const a = fc.animations[ai];
          const animId = `f${i}a${ai}`;
          await page.evaluate(
            (args: { selector: string; animId: string }) => {
              const els = document.querySelectorAll(args.selector);
              els.forEach((el) => {
                if (el instanceof HTMLElement) el.dataset.domotionAnim = args.animId;
              });
            },
            { selector: a.selector, animId },
          );
          resolvedAnimations.push({
            animId,
            property: a.property,
            from: a.from,
            to: a.to,
            duration: a.duration,
            easing: a.easing,
            delay: a.delay,
          });
        }
      }

      let svgContent: string;
      let frameCullCss: string;
      if (fc.scroll != null) {
        // DM-612: scroll-demo block. Run the executor against the loaded
        // page, cull each segment's tree (DM-603), compose into one
        // animated SVG, and use as this frame's svgContent. The composed
        // SVG carries its own internal keyframes loop (animation-duration =
        // pattern's total scroll time) — caller is expected to size the
        // frame's `duration` to match so the outer scene cycle aligns with
        // the inner scroll loop.
        const scrollPattern = parseScrollPattern(fc.scroll.pattern);
        const segments = await executeScrollPattern(page, scrollPattern, {
          selector: fc.scroll.selector,
          viewportW: cfg.width,
          viewportH: cfg.height,
          defaultSpeed: fc.scroll.speed,
          prescroll: fc.scroll.prescroll !== false,
        });
        for (const seg of segments) {
          cullFrame(seg.tree, cfg.width, cfg.height, undefined, 0, 1);
        }
        const composed = composeScrollSvg(segments, { viewportW: cfg.width, viewportH: cfg.height });
        // The composer emits a full `<?xml ...><svg>...</svg>` document. The
        // outer animator wraps `svgContent` in a `<g class="f f-N">`, which
        // happily contains a nested `<svg>` element — strip just the XML
        // prolog so we don't end up with `<?xml ...>` inside a `<g>`.
        svgContent = composed.replace(/^<\?xml[^>]*\?>\s*/, "");
        frameCullCss = "";
      } else {
        const tree = await captureElementTree(page, fc.selector ?? "body", {
          x: 0, y: 0, width: cfg.width, height: cfg.height,
        });
        // DM-603: viewBox-cull pass — mutates the tree (sets `displayNone` /
        // `cullClass` on elements that fall outside the viewBox during this
        // frame's segment of the scene cycle) and returns the keyframes CSS
        // mapping each `cull-N` class to its visible window. Must run BEFORE
        // `elementTreeToSvg` so the renderer sees the mutated tree.
        let frameStartMs = 0;
        for (let pi = 0; pi < i; pi++) {
          frameStartMs += cfg.frames[pi].duration + (cfg.frames[pi].transition?.type === "cut" ? 0 : (cfg.frames[pi].transition?.duration ?? 300));
        }
        const totalDurationMs = cfg.frames.reduce((sum, f) => sum + f.duration + (f.transition?.type === "cut" ? 0 : (f.transition?.duration ?? 300)), 0);
        const result = cullFrame(tree, cfg.width, cfg.height, resolvedAnimations, frameStartMs, totalDurationMs);
        frameCullCss = result.css;
        svgContent = elementTreeToSvg(tree, cfg.width, cfg.height, `f${i}-`);
      }

      // Resolve SVG-kind overlays: read each `src` from disk, namespace its
      // ids, and replace with `innerSvg`. Other overlay kinds pass through
      // verbatim. (DM-210.)
      const overlays = resolveSvgOverlays(fc.overlays, configDir, i);

      frames.push({
        svgContent,
        cullCss: frameCullCss === "" ? undefined : frameCullCss,
        duration: fc.duration,
        transition: fc.transition,
        overlays,
        animations: resolvedAnimations.length > 0 ? resolvedAnimations : undefined,
      });
    }
    tracker.detach();

    let svg = generateAnimatedSvg({ width: cfg.width, height: cfg.height, frames });
    // svgz is auto-detected from the output filename; implies --optimize
    // unless --no-optimize was passed.
    const outputArg = values.output ?? cfg.output;
    const svgz = isSvgzPath(outputArg);
    const optimize =
      values.optimize === true ||
      (cfg.optimize === true && values["no-optimize"] !== true) ||
      (svgz && values["no-optimize"] !== true);
    if (optimize) svg = optimizeSvg(svg);

    const outPath = resolveOutputPath(outputArg, configPath, ".svg");
    writeOutput(svg, outPath, svgz, `, ${cfg.frames.length} frames`);
  } finally {
    await browser.close();
  }
}

async function runActions(page: Page, actions: AnimateAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type === "click")       await page.click(a.selector);
    else if (a.type === "fill")   await page.fill(a.selector, a.value);
    else if (a.type === "press")  await page.keyboard.press(a.key);
    else if (a.type === "scroll") await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [a.x ?? 0, a.y ?? 0]);
    else if (a.type === "hover")  await page.hover(a.selector);
    else if (a.type === "wait")   await page.waitForTimeout(a.ms);
    else throw new Error(`animate: unknown action type "${(a as { type: string }).type}"`);
  }
}

async function loadInputIntoPage(page: Page, input: string): Promise<void> {
  if (input === "-") {
    const html = readFileSync(0, "utf8"); // stdin
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return;
  }
  if (/^https?:\/\//i.test(input)) {
    await page.goto(input, { waitUntil: "networkidle" });
    return;
  }
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`input file not found: ${path}`);
  await page.goto(pathToFileURL(path).href, { waitUntil: "networkidle" });
}

async function applyReadyWaits(page: Page, flags: { wait: number; waitFor?: string; fontsReady: boolean }): Promise<void> {
  if (flags.fontsReady) {
    await page.evaluate(() => document.fonts.ready);
  }
  if (flags.waitFor != null) {
    await page.waitForSelector(flags.waitFor, { state: "visible" });
  }
  if (flags.wait > 0) {
    await page.waitForTimeout(flags.wait);
  }
}

function validateAnimateConfig(cfg: AnimateConfig): void {
  if (typeof cfg.width !== "number" || typeof cfg.height !== "number") {
    throw new Error("animate: config requires numeric width and height");
  }
  if (!Array.isArray(cfg.frames) || cfg.frames.length === 0) {
    throw new Error("animate: config.frames must be a non-empty array");
  }
  for (let i = 0; i < cfg.frames.length; i++) {
    const f = cfg.frames[i];
    if (typeof f.input !== "string") throw new Error(`animate: frames[${i}].input must be a string`);
    if (typeof f.duration !== "number") throw new Error(`animate: frames[${i}].duration must be a number`);
    if (f.scroll != null) {
      if (typeof f.scroll.pattern !== "string" || f.scroll.pattern.trim() === "") {
        throw new Error(`animate: frames[${i}].scroll.pattern must be a non-empty string`);
      }
      // Parse the pattern eagerly so config errors surface before the run
      // starts (instead of mid-Playwright session). Throws on invalid
      // grammar with the original error including source position.
      try {
        parseScrollPattern(f.scroll.pattern);
      } catch (e) {
        throw new Error(`animate: frames[${i}].scroll.pattern is invalid: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (f.scroll.speed != null && (!Number.isFinite(f.scroll.speed) || f.scroll.speed <= 0)) {
        throw new Error(`animate: frames[${i}].scroll.speed must be a positive number (px/s)`);
      }
    }
  }
}

/**
 * Walk a frame's overlay list, expand `kind: "svg"` entries by reading the
 * referenced SVG file, namespacing its ids, and replacing `src` with the
 * inlined `innerSvg`. Other overlay kinds pass through verbatim.
 */
function resolveSvgOverlays(rawOverlays: unknown[] | undefined, configDir: string, frameIdx: number): Overlay[] | undefined {
  if (rawOverlays == null) return undefined;
  const out: Overlay[] = [];
  let svgIdx = 0;
  for (const ov of rawOverlays) {
    if (ov != null && typeof ov === "object" && (ov as { kind?: string }).kind === "svg") {
      const raw = ov as { kind: "svg"; src: string; x: number; y: number; width: number; height: number; enter?: SvgOverlay["enter"]; exit?: SvgOverlay["exit"] };
      const srcPath = resolve(configDir, raw.src);
      if (!existsSync(srcPath)) throw new Error(`animate: svg overlay file not found: ${srcPath}`);
      const fileText = readFileSync(srcPath, "utf8");
      const animId = `s${svgIdx++}`;
      const namespaced = namespaceSvgIds(fileText, `f${frameIdx}o${animId}-`);
      out.push({
        kind: "svg",
        innerSvg: namespaced,
        x: raw.x, y: raw.y, width: raw.width, height: raw.height,
        animId,
        enter: raw.enter, exit: raw.exit,
      });
    } else {
      out.push(ov as Overlay);
    }
  }
  return out;
}

/**
 * Strip the outer `<svg>` wrapper (if present) from an SVG file's contents,
 * then prefix every `id="..."`, `href="#..."`, and `xlink:href="#..."` with
 * the given prefix so multiple inlined SVGs can coexist in one document
 * without id collisions.
 */
function namespaceSvgIds(svg: string, prefix: string): string {
  // Strip XML decl + outer <svg ...> wrapper.
  let inner = svg;
  inner = inner.replace(/<\?xml[^>]*\?>/, "");
  inner = inner.replace(/<svg\b[^>]*>/, "");
  inner = inner.replace(/<\/svg>\s*$/, "");
  // Prefix ids and hash references.
  inner = inner.replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`);
  inner = inner.replace(/\b(href|xlink:href)="#([^"]+)"/g, (_m, attr: string, id: string) => `${attr}="#${prefix}${id}"`);
  inner = inner.replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`);
  return inner;
}

function resolveFrameInput(input: string, configDir: string): string {
  if (input === "-") return input;
  if (/^https?:\/\//i.test(input)) return input;
  return resolve(configDir, input);
}

function parseIntFlag(value: string | undefined, name: string, def: number): number {
  if (value == null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) {
    throw new Error(`--${name} expects a positive integer, got "${value}"`);
  }
  return n;
}

function parseColorScheme(value: string | undefined): "light" | "dark" | "no-preference" | undefined {
  if (value == null) return undefined;
  if (value === "light" || value === "dark" || value === "no-preference") return value;
  throw new Error(`--color-scheme expects one of "light", "dark", "no-preference"; got "${value}"`);
}

function parseTuple(value: string, len: number, name: string): number[] {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== len) throw new Error(`--${name} expects ${len} comma-separated numbers, got "${value}"`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`--${name} contains a non-numeric component: "${value}"`);
  return nums;
}

function resolveOutputPath(output: string | undefined, input: string, ext: string): string | null {
  if (output === "-") return null;
  if (output != null) return resolve(output);
  if (input === "-" || /^https?:\/\//i.test(input)) return null; // stream to stdout
  // Local file → write next to it with the same basename.
  const stem = basename(input).replace(/\.[^.]+$/, "");
  return resolve(dirname(input), `${stem}${ext}`);
}

/** True iff the path's extension is `.svgz` (case-insensitive). */
function isSvgzPath(path: string | undefined): boolean {
  return path != null && path !== "-" && /\.svgz$/i.test(path);
}

/**
 * Write the SVG out — gzip-compressed when `svgz` is true (always Buffer),
 * raw text otherwise. Stdout gets the same payload kind. `extraInfo` is
 * appended to the "Wrote ..." stderr line (e.g. frame count for animate).
 */
function writeOutput(svg: string, outPath: string | null, svgz: boolean, extraInfo: string = ""): void {
  if (svgz) {
    const buf = gzipSvg(svg);
    if (outPath === null) {
      process.stdout.write(buf);
    } else {
      writeFileSync(outPath, buf);
      process.stderr.write(`Wrote ${outPath} (${(buf.length / 1024).toFixed(1)} KB svgz${extraInfo})\n`);
    }
    return;
  }
  if (outPath === null) {
    process.stdout.write(svg);
  } else {
    writeFileSync(outPath, svg);
    process.stderr.write(`Wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB${extraInfo})\n`);
  }
}
