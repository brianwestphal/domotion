/**
 * `domotion animate` subcommand.
 *
 * Reads a JSON config describing N frames (each captured from a URL or HTML
 * file), runs each frame's actions / scroll pattern / intra-frame animations,
 * captures, and composes one animated SVG with CSS keyframe transitions.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "@playwright/test";
import {
  captureElementTree,
  clearWebfonts,
  composeScrollSvg,
  cullElementsOutsideViewBox,
  elementTreeToSvg,
  executeScrollPattern,
  generateAnimatedSvg,
  launchChromium,
  optimizeSvg,
  parseScrollPattern,
  type AnimationFrame,
  type IntraFrameAnimation,
  type AnimationOverlay,
  type SvgOverlay,
} from "../index.js";
import { attachWebfontTracker, discoverAndRegisterWebfonts } from "../capture/index.js";
import {
  applyReadyWaits,
  isSvgzPath,
  loadInputIntoPage,
  makeLogger,
  resolveOutputPath,
  timed,
  writeOutput,
} from "./common.js";

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

export async function runAnimate(args: string[], help: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output:        { type: "string", short: "o" },
      optimize:      { type: "boolean" },
      "no-optimize": { type: "boolean" },
      quiet:         { type: "boolean" },
      help:          { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(help); process.exit(0); }
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

  const log = makeLogger(values.quiet === true);
  log(`Launching Chromium…`);
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
      log(`Frame ${i + 1}/${cfg.frames.length}: loading ${input}…`);
      await timed(log, `  loaded`, () => loadInputIntoPage(page, input));
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
        log(`  scroll pattern: ${fc.scroll.pattern}`);
        const scrollPattern = parseScrollPattern(fc.scroll.pattern);
        const segments = await executeScrollPattern(page, scrollPattern, {
          selector: fc.scroll.selector,
          viewportW: cfg.width,
          viewportH: cfg.height,
          defaultSpeed: fc.scroll.speed,
          prescroll: fc.scroll.prescroll !== false,
          log,
        });
        for (const seg of segments) {
          cullElementsOutsideViewBox(seg.tree, cfg.width, cfg.height, undefined, 0, 1);
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
        const result = cullElementsOutsideViewBox(tree, cfg.width, cfg.height, resolvedAnimations, frameStartMs, totalDurationMs);
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

    let svg = await timed(log, `Composed animated SVG (${cfg.frames.length} frames)`, () =>
      Promise.resolve(generateAnimatedSvg({ width: cfg.width, height: cfg.height, frames })),
    );
    // svgz is auto-detected from the output filename; implies --optimize
    // unless --no-optimize was passed.
    const outputArg = values.output ?? cfg.output;
    const svgz = isSvgzPath(outputArg);
    const optimize =
      values.optimize === true ||
      (cfg.optimize === true && values["no-optimize"] !== true) ||
      (svgz && values["no-optimize"] !== true);
    if (optimize) {
      svg = await timed(log, `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`, () => Promise.resolve(optimizeSvg(svg)));
    }

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
function resolveSvgOverlays(rawOverlays: unknown[] | undefined, configDir: string, frameIdx: number): AnimationOverlay[] | undefined {
  if (rawOverlays == null) return undefined;
  const out: AnimationOverlay[] = [];
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
      out.push(ov as AnimationOverlay);
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
