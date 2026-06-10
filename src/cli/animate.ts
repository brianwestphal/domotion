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
import { z } from "zod";
import type { Browser, Page } from "@playwright/test";
// DM-1131: the authoring overlay / intra-frame-animation schemas below EXTEND
// these single-source-of-truth base schemas (which also derive the renderer's
// runtime types), so a field rename moves both views together instead of
// silently drifting.
import {
  typingOverlaySchema,
  tapOverlaySchema,
  blinkOverlaySchema,
  overlaySlideSchema,
  intraFrameAnimationSchema,
} from "../animation/overlay-schema.js";
import {
  buildMagicMove,
  captureElementTree,
  clearEmbeddedFonts,
  clearWebfonts,
  composeScrollSvg,
  cullElementsOutsideViewBox,
  elementTreeToSvgInner,
  executeScrollPattern,
  generateAnimatedSvg,
  getEmbeddedFontFaceCss,
  launchChromium,
  optimizeSvg,
  parseScrollPattern,
  cursorAtPoint,
  type AnimationFrame,
  type IntraFrameAnimation,
  type AnimationOverlay,
  type CursorOverlay,
  type CursorEvent,
  type CursorStyle,
  type CapturedElement,
} from "../index.js";
import { attachWebfontTracker, discoverAndRegisterWebfonts } from "../capture/index.js";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import {
  applyReadyWaits,
  isSvgzPath,
  loadInputIntoPage,
  makeLogger,
  resolveOutputPath,
  timed,
  writeOutput,
} from "./common.js";

// ── Config schema (DM-843) ──────────────────────────────────────────────────
// The animate config is external `JSON.parse`'d input, so it's validated with
// a zod schema rather than hand-rolled type guards. The schema is the single
// source of truth for the config's shape; the exported/used types below are
// inferred from it (`z.infer`), so type and runtime check can't drift apart.

const transitionSchema = z.object({
  type: z.enum(["crossfade", "push-left", "scroll", "cut", "magic-move"]),
  duration: z.number(),
});

const scrollSchema = z.object({
  // Pattern string per the scroll-pattern grammar (docs/37). Validated by
  // running the real parser so a malformed pattern fails at config-parse time.
  pattern: z
    .string()
    .min(1, "must be a non-empty string")
    .superRefine((val, ctx) => {
      try {
        parseScrollPattern(val);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `is not a valid scroll pattern: ${e instanceof Error ? e.message : String(e)}` });
      }
    }),
  /** Default scroll speed in px/s for tokens without an explicit `/<duration>`. */
  speed: z.number().positive("must be a positive number (px/s)").optional(),
  /** CSS selector for an inner scrollable element (default: window). */
  selector: z.string().optional(),
  /** Skip the pre-scroll-to-bottom-then-top step. Default: false. */
  prescroll: z.boolean().optional(),
});

// DM-1131: the authoring form of an intra-frame animation is the runtime shape
// (SSOT `intraFrameAnimationSchema`) with the resolved `animId` swapped for the
// authoring `selector` (resolved against the captured DOM → `animId`), and the
// `repeat` count tightened to a positive integer for config-author ergonomics.
const frameAnimationSchema = intraFrameAnimationSchema
  .omit({ animId: true })
  .extend({
    selector: z.string(),
    // DM-869: loop the animation (blink / pulse). Positive integer or "infinite".
    repeat: z.union([z.number().int().positive(), z.literal("infinite")]).optional(),
  });

const insertPositionSchema = z.enum(["beforebegin", "afterbegin", "beforeend", "afterend"]);
const scrollLogicalSchema = z.enum(["start", "center", "end", "nearest"]);

const actionSchema = z.discriminatedUnion("type", [
  // Interaction (Playwright-native).
  z.object({ type: z.literal("click"),  selector: z.string() }),
  z.object({ type: z.literal("fill"),   selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("press"),  key: z.string() }),
  z.object({ type: z.literal("scroll"), x: z.number().optional(), y: z.number().optional() }),
  z.object({ type: z.literal("hover"),  selector: z.string() }),
  z.object({ type: z.literal("wait"),   ms: z.number() }),
  // DM-848 §3 — interaction actions beyond click/fill.
  z.object({ type: z.literal("scrollIntoView"), selector: z.string(), block: scrollLogicalSchema.optional(), inline: scrollLogicalSchema.optional() }),
  z.object({ type: z.literal("dispatch"),       selector: z.string(), event: z.string(), bubbles: z.boolean().optional() }),
  z.object({ type: z.literal("focus"),          selector: z.string() }),
  z.object({ type: z.literal("blur"),           selector: z.string() }),
  z.object({ type: z.literal("selectText"),     selector: z.string() }),
  z.object({ type: z.literal("clear"),          selector: z.string() }),
  // DM-847 §2 — declarative DOM mutations.
  z.object({ type: z.literal("setText"),        selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("setHtml"),        selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("remove"),         selector: z.string() }),
  z.object({ type: z.literal("setAttribute"),   selector: z.string(), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("removeAttribute"),selector: z.string(), name: z.string() }),
  z.object({ type: z.literal("addClass"),       selector: z.string(), class: z.string() }),
  z.object({ type: z.literal("removeClass"),    selector: z.string(), class: z.string() }),
  z.object({ type: z.literal("toggleClass"),    selector: z.string(), class: z.string() }),
  z.object({ type: z.literal("setStyle"),       selector: z.string(), props: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("insert"),         selector: z.string(), position: insertPositionSchema, html: z.string() }),
  z.object({ type: z.literal("setValue"),       selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("check"),          selector: z.string(), checked: z.boolean() }),
  z.object({ type: z.literal("selectOption"),   selector: z.string(), value: z.string() }),
  z.object({
    type: z.literal("replaceText"),
    selector: z.string(),
    pattern: z.string().superRefine((val, ctx) => {
      try {
        new RegExp(val);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}` });
      }
    }),
    replacement: z.string(),
    flags: z.string().optional(),
  }),
  // DM-853 §8 — last-resort escape hatch.
  z.object({ type: z.literal("evaluate"), script: z.string() }),
]);

// DM-850 §5 — anchor an overlay to an element's bounding box (resolved at
// capture time), replacing hardcoded x/y. `at` picks the box corner/edge;
// `dx`/`dy` offset from it.
const anchorSchema = z.object({
  selector: z.string(),
  at: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
});

// DM-1131: overlay *authoring* shapes derive from the runtime base schemas in
// `../animation/overlay-schema.ts`. Each adds the config-only conveniences —
// `x`/`y` defaulted to 0 (an `anchor` can supply them), and selector
// `anchor` / typing `maxWidth` (resolved at capture time, see
// `resolveOverlayAnchors`). The `svg` kind is its own shape because authoring
// takes a `src` file path that the CLI later reads / namespaces into the
// runtime `innerSvg` + `animId` (see `resolveSvgOverlays`).
const overlaySchema = z.discriminatedUnion("kind", [
  typingOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    // DM-850 §5: anchor to an element bbox; maxWidth wraps to the anchored
    // element's content width ("anchor") or a fixed px.
    anchor: anchorSchema.optional(),
    maxWidth: z.union([z.literal("anchor"), z.number()]).optional(),
  }),
  tapOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    anchor: anchorSchema.optional(),
  }),
  z.object({
    kind: z.literal("svg"),
    src: z.string(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number(),
    height: z.number(),
    enter: overlaySlideSchema.optional(),
    exit: overlaySlideSchema.optional(),
    anchor: anchorSchema.optional(),
  }),
  blinkOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    anchor: anchorSchema.optional(),
  }),
]);

const frameSchema = z.object({
  // DM-846 §1 — `input` is optional. Frame 0 must load an input; a later frame
  // that omits `input` (or sets `continue: true`) keeps the previous frame's
  // live page. The frame-0 / continue+input rules are enforced in the
  // config-level superRefine below (they need cross-frame context).
  input: z.string().optional(),
  continue: z.boolean().optional(),
  duration: z.number(),
  transition: transitionSchema.optional(),
  selector: z.string().optional(),
  wait: z.number().optional(),
  waitFor: z.string().optional(),
  // DM-849 §4 — richer readiness waits (poll page context until satisfied).
  waitForText: z
    .object({ selector: z.string(), equals: z.string().optional(), contains: z.string().optional() })
    .refine((v) => v.equals != null || v.contains != null, { message: "requires `equals` or `contains`" })
    .optional(),
  waitForGone: z.string().optional(),
  waitForCount: z
    .object({ selector: z.string(), equals: z.number().optional(), atLeast: z.number().optional(), atMost: z.number().optional() })
    .refine((v) => v.equals != null || v.atLeast != null || v.atMost != null, { message: "requires `equals`, `atLeast`, or `atMost`" })
    .optional(),
  /**
   * Scroll the page (or `selector`'s element) to this offset BEFORE the
   * capture — static positioning for a fold-style capture. See `scroll` for
   * the pattern-based animated-scroll flow.
   */
  scrollTo: z.tuple([z.number(), z.number()]).optional(),
  /**
   * DM-612: pattern-based scroll-demo block. The frame's `input` is loaded and
   * the scroll executor runs against it; the per-segment captures are composed
   * into one animated SVG that becomes the frame's content. Size the frame's
   * `duration` to ≈ the pattern's total scroll time so the outer scene cycle
   * matches the inner scroll's loop.
   */
  scroll: scrollSchema.optional(),
  actions: z.array(actionSchema).optional(),
  overlays: z.array(overlaySchema).optional(),
  /** Intra-frame animations (DM-209). Selector resolved against the captured DOM. */
  animations: z.array(frameAnimationSchema).optional(),
});

// DM-851 §6 — config-level cursor overlay. Either "auto" (derive a move +
// click-pulse per click/hover/fill action) or an explicit event list.
const cursorStyleSchema = z.object({
  scale: z.number().optional(),
  color: z.string().optional(),
  pulseColor: z.string().optional(),
  pulseRadius: z.number().optional(),
  pulseDurationMs: z.number().optional(),
});

const cursorEventSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    at: z.number().default(0),
    type: z.enum(["move", "click", "moveClick", "hide"]),
    selector: z.string().optional(),
    to: z.object({ x: z.number(), y: z.number() }).optional(),
    offset: z.object({ dx: z.number(), dy: z.number() }).optional(),
    duration: z.number().optional(),
    button: z.enum(["primary", "secondary", "middle"]).optional(),
  })
  .refine((e) => (e.type !== "move" && e.type !== "moveClick") || e.selector != null || e.to != null, {
    message: "a move / moveClick event requires `selector` or `to`",
  });

const cursorSchema = z.union([
  z.literal("auto"),
  z.object({ style: cursorStyleSchema.optional(), events: z.array(cursorEventSchema).min(1, "must be a non-empty array") }),
]);

// Exported so the published JSON Schema can be generated from it (see
// `src/cli/animate-config-json-schema.ts` and `scripts/generate-animate-schema.ts`).
// Keeping the zod schema the single source of truth means the JSON Schema we
// ship to consumers can never drift from what `validateAnimateConfig` enforces.
export const animateConfigSchema = z
  .object({
    width: z.number(),
    height: z.number(),
    output: z.string().optional(),
    optimize: z.boolean().optional(),
    mobile: z.boolean().optional(),
    colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
    /** DM-852 §7 — string vars interpolated into `${name}` in any string field. */
    vars: z.record(z.string(), z.string()).optional(),
    /** DM-851 §6 — config-level cursor overlay. */
    cursor: cursorSchema.optional(),
    frames: z.array(frameSchema).min(1, "must be a non-empty array"),
  })
  .superRefine((cfg, ctx) => {
    // DM-846 §1 cross-frame rules for the continuous-session model.
    cfg.frames.forEach((f, i) => {
      if (i === 0 && f.input == null) {
        ctx.addIssue({ code: "custom", path: ["frames", 0, "input"], message: "frame 0 must load an input" });
      }
      if (i === 0 && f.continue === true) {
        ctx.addIssue({ code: "custom", path: ["frames", 0, "continue"], message: "frame 0 cannot continue — it has no predecessor" });
      }
      if (f.continue === true && f.input != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "continue"], message: "a frame cannot set both `continue` and `input` (reload or continue, not both)" });
      }
    });
  });

export type AnimateConfig = z.infer<typeof animateConfigSchema>;
type AnimateAction = z.infer<typeof actionSchema>;
type OverlayInput = z.infer<typeof overlaySchema>;

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

  const cfgRaw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const cfg = validateAnimateConfig(cfgRaw);
  const configDir = dirname(configPath);

  const log = makeLogger(values.quiet === true);
  log(`Launching Chromium…`);
  const browser = await launchChromium();
  let svg: string;
  try {
    svg = await composeAnimateConfig(browser, cfg, configDir, log);
  } finally {
    await browser.close();
  }

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
}

/**
 * Capture and compose every frame in `cfg` into one animated SVG string
 * (unoptimized). Shared by the `animate` CLI and the example-regression
 * harness so both exercise the exact same capture→compose path. Creates one
 * browser context (sized / emulated per `cfg`) and closes it before returning;
 * the caller owns the `browser` lifecycle.
 */
export async function composeAnimateConfig(
  browser: Browser,
  cfg: AnimateConfig,
  configDir: string,
  log: (msg: string) => void,
): Promise<string> {
  // DM-852: resolve `${vars}` across every string field before anything runs.
  cfg = interpolateConfigVars(cfg);
  const ctx = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    isMobile: cfg.mobile === true,
    ...(cfg.mobile === true ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
    ...(cfg.colorScheme != null ? { colorScheme: cfg.colorScheme } : {}),
  });
  try {
    const page = await ctx.newPage();
    // DM-479: 90 s instead of Playwright's 30 s default.
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    const frames: AnimationFrame[] = [];
    // DM-898: the previous frame's captured tree, kept so a magic-move
    // transition can diff (prev, next) once both are captured.
    let prevFrameTree: CapturedElement[] | null = null;
    // DM-1106: every frame's captured tree, indexed by frame, so the cursor
    // overlay can hit-test the cursor TYPE under each pointer position.
    const frameTrees: (CapturedElement[] | null)[] = [];
    // Canvas background for the composed SVG: the captured root background of
    // the first frame, so animated output matches single-frame `capture`
    // output (a transparent page → transparent SVG). Stamped per-frame by the
    // capture script as `rootBgComputed`; the animator paints no rect when it's
    // transparent/absent (DM-893).
    let canvasBg: string | undefined;
    // Frames may pull from different documents with different webfonts.
    // Clear once at the start; each frame's discovery accumulates into the
    // same registry. Multiple frames declaring the same family register
    // multiple variants and the resolver picks the closest weight/style.
    clearWebfonts();
    // DM-839: embedded-font is the default render mode. Reset the builder once
    // here; each frame renders with includeEmbeddedFontCss=false (below) and we
    // collect the deduped @font-face block once into the animator's top-level
    // <style> after the loop — so the base64 font bytes appear once, not per frame.
    clearEmbeddedFonts();
    // One tracker for the whole animate run — fonts fetched by any frame
    // get accumulated, and we deduplicate URLs inside discoverAndRegister.
    const tracker = attachWebfontTracker(page);

    // DM-851 §6: config-level cursor. We resolve selectors to absolute coords
    // during capture, then assemble a global-time CursorOverlay after the loop.
    const cursorCfg = cfg.cursor;
    const cursorAuto = cursorCfg === "auto";
    const explicitCursorEvents = cursorCfg != null && cursorCfg !== "auto" ? cursorCfg.events : [];
    const cursorStyleCfg = cursorCfg != null && cursorCfg !== "auto" ? cursorCfg.style : undefined;
    const autoCursorTargets: Array<{ frame: number; cx: number; cy: number }> = [];
    const explicitCursorBoxes = new Map<string, { cx: number; cy: number }>();
    const frameStartsMs: number[] = [];
    {
      let acc = 0;
      for (const f of cfg.frames) {
        frameStartsMs.push(acc);
        acc += frameAdvanceMs(f);
      }
    }
    for (const ev of explicitCursorEvents) {
      if (ev.frame >= cfg.frames.length) {
        throw new Error(`animate: cursor.events references frame ${ev.frame}, but there are only ${cfg.frames.length} frames`);
      }
    }

    for (let i = 0; i < cfg.frames.length; i++) {
      const fc = cfg.frames[i];
      // DM-846 §1: a continued frame (explicit `continue: true`, or a non-first
      // frame that omits `input`) captures the previous frame's live page after
      // running its own actions, instead of reloading. The page persists across
      // the whole loop, so "continue" simply means "don't navigate".
      const isContinue = i > 0 && (fc.continue === true || fc.input == null);
      if (isContinue) {
        log(`Frame ${i + 1}/${cfg.frames.length}: continuing live page…`);
      } else {
        const inputStr = fc.input;
        if (inputStr == null) throw new Error(`animate: frames[${i}] has no input and is not a continue frame`);
        const input = resolveFrameInput(inputStr, configDir);
        log(`Frame ${i + 1}/${cfg.frames.length}: loading ${input}…`);
        await timed(log, `  loaded`, () => loadInputIntoPage(page, input));
      }
      await applyReadyWaits(page, {
        wait: fc.wait ?? 200,
        waitFor: fc.waitFor,
        fontsReady: true,
        frameIndex: i,
        waitForText: fc.waitForText,
        waitForGone: fc.waitForGone,
        waitForCount: fc.waitForCount,
      });
      await discoverAndRegisterWebfonts(page, tracker.urls);
      if (fc.scrollTo != null) {
        const sx = fc.scrollTo[0], sy = fc.scrollTo[1];
        await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [sx, sy]);
      }
      // DM-851 §6: for `cursor: "auto"`, record each interaction target's
      // center BEFORE the action runs (that's where the pointer clicks).
      if (cursorAuto && fc.actions != null) {
        for (const a of fc.actions) {
          if (a.type === "click" || a.type === "hover" || a.type === "fill") {
            const c = await queryCursorBox(page, a.selector);
            if (c != null) autoCursorTargets.push({ frame: i, cx: c.cx, cy: c.cy });
          }
        }
      }
      if (fc.actions != null) await runActions(page, fc.actions, log);
      // Explicit cursor-event selectors resolve against the post-action DOM.
      for (const ev of explicitCursorEvents) {
        if (ev.frame === i && ev.selector != null) {
          const c = await queryCursorBox(page, ev.selector);
          if (c == null) throw new Error(`animate: cursor.events selector "${ev.selector}" matched no element in frame ${i}`);
          explicitCursorBoxes.set(`${i}:${ev.selector}`, c);
        }
      }

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
            repeat: a.repeat,
            alternate: a.alternate,
          });
        }
      }

      let svgContent: string;
      let frameCullCss: string;
      // DM-898: retain this frame's captured tree so a magic-move transition
      // can diff it against the next frame's. `null` for scroll-block frames
      // (no single tree) — magic-move then falls back to crossfade.
      let frameTree: CapturedElement[] | null = null;
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
        if (i === 0) canvasBg = segments[0]?.tree?.[0]?.styles?.rootBgComputed;
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
          frameStartMs += frameAdvanceMs(cfg.frames[pi]);
        }
        const totalDurationMs = cfg.frames.reduce((sum, f) => sum + frameAdvanceMs(f), 0);
        const result = cullElementsOutsideViewBox(tree, cfg.width, cfg.height, resolvedAnimations, frameStartMs, totalDurationMs);
        frameCullCss = result.css;
        if (i === 0) canvasBg = tree[0]?.styles?.rootBgComputed;
        svgContent = elementTreeToSvgInner(tree, cfg.width, cfg.height, `f${i}-`, true, 2, false);
        frameTree = tree;
      }

      // DM-850 §5: resolve selector-anchored overlays against the live page
      // (bbox → x/y, and maxWidth:"anchor" → the element's content width) BEFORE
      // the svg-inlining pass, while the page is still loaded.
      const anchoredOverlays = await resolveOverlayAnchors(page, fc.overlays, i);
      // Resolve SVG-kind overlays: read each `src` from disk, namespace its
      // ids, and replace with `innerSvg`. Other overlay kinds pass through
      // verbatim. (DM-210.)
      const overlays = resolveSvgOverlays(anchoredOverlays, configDir, i);

      frames.push({
        svgContent,
        cullCss: frameCullCss === "" ? undefined : frameCullCss,
        duration: fc.duration,
        transition: fc.transition,
        overlays,
        animations: resolvedAnimations.length > 0 ? resolvedAnimations : undefined,
      });

      // DM-898: when the PREVIOUS frame's transition is magic-move and both it
      // and this frame captured a tree, build the bridge layer now — BEFORE the
      // glyph/font @font-face defs are finalized below (getEmbeddedFontFaceCss),
      // since the bridge re-renders subtrees and must contribute its glyphs to
      // those defs — and attach it to that frame. Falls back to crossfade when
      // either tree is absent (e.g. a scroll-block neighbor) or buildMagicMove
      // finds nothing to animate (returns null).
      if (i > 0 && frames[i - 1]?.transition?.type === "magic-move" && prevFrameTree != null && frameTree != null) {
        frames[i - 1].magicMove = buildMagicMove(
          prevFrameTree, frameTree,
          (roots, prefix) => elementTreeToSvgInner(roots, cfg.width, cfg.height, prefix, true, 2, false),
          `mm${i - 1}-`,
        );
      }
      prevFrameTree = frameTree;
      frameTrees[i] = frameTree;
    }
    tracker.detach();

    // DM-851 §6: assemble the cursor overlay from the resolved coords + the
    // frame timeline. Move events carry absolute `to` coords (selectors already
    // resolved during capture), so no resolveSelector callback is needed.
    const cursorOverlay = buildCursorOverlay(
      cursorAuto, explicitCursorEvents, cursorStyleCfg, autoCursorTargets, explicitCursorBoxes, frameStartsMs, cfg.frames,
    );
    // DM-1106: hit-test the cursor TYPE under each pointer position against the
    // frame's captured tree, so the overlay paints the matching glyph (hand over
    // links, I-beam over text, …) and switches at element boundaries.
    const resolveCursorAt = (x: number, y: number, frameIndex: number): string =>
      cursorAtPoint(frameTrees[frameIndex] ?? [], x, y);

    // DM-839: collect the embedded-font @font-face rules accumulated across all
    // frames once, for the animator's top-level <style>.
    const fontFaceCss = getEmbeddedFontFaceCss();
    return await timed(log, `Composed animated SVG (${cfg.frames.length} frames)`, () =>
      Promise.resolve(generateAnimatedSvg({ width: cfg.width, height: cfg.height, frames, fontFaceCss, cursorOverlay, resolveCursorAt, background: canvasBg })),
    );
  } finally {
    await ctx.close();
  }
}

async function runActions(page: Page, actions: AnimateAction[], log: (msg: string) => void): Promise<void> {
  for (const a of actions) {
    switch (a.type) {
      // Playwright-native interactions (handle actionability + waiting).
      case "click":        await page.click(a.selector); break;
      case "fill":         await page.fill(a.selector, a.value); break;
      case "press":        await page.keyboard.press(a.key); break;
      case "hover":        await page.hover(a.selector); break;
      case "focus":        await page.focus(a.selector); break;
      case "selectOption": await page.selectOption(a.selector, a.value); break;
      case "scroll":       await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [a.x ?? 0, a.y ?? 0]); break;
      case "wait":         await page.waitForTimeout(a.ms); break;
      case "evaluate": {
        // DM-853 §8: last resort. Nudge toward declarative actions / the API
        // once a snippet outgrows a line or two, but don't block it.
        if (a.script.length > 200 || a.script.split("\n").length > 2) {
          log(`  warning: evaluate script is ${a.script.length} chars / ${a.script.split("\n").length} lines — more than a line or two means you've outgrown the config; consider the declarative actions or the programmatic API`);
        }
        await page.evaluate(a.script);
        break;
      }
      // DM-847 §2 + DM-848 §3: DOM mutations and the remaining interactions run
      // in page context against all matched elements.
      default: await applyDomAction(page, a); break;
    }
  }
}

/**
 * Apply a DOM-mutation / interaction action (the cases not handled by a
 * Playwright-native call in `runActions`) in page context, across every matched
 * element. Throws if the selector matches nothing (a silently-skipped step
 * usually means the demo is subtly wrong — see docs/43 → Selectors).
 */
async function applyDomAction(page: Page, action: AnimateAction): Promise<void> {
  const selector = "selector" in action ? action.selector : undefined;
  const matched = await page.evaluate((a) => {
    const sel = "selector" in a ? a.selector : "";
    const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    for (const h of els) {
      switch (a.type) {
        case "setText":         h.textContent = a.value; break;
        case "setHtml":         h.innerHTML = a.value; break;
        case "remove":          h.remove(); break;
        case "setAttribute":    h.setAttribute(a.name, a.value); break;
        case "removeAttribute": h.removeAttribute(a.name); break;
        case "addClass":        h.classList.add(a.class); break;
        case "removeClass":     h.classList.remove(a.class); break;
        case "toggleClass":     h.classList.toggle(a.class); break;
        case "setStyle":        for (const [k, v] of Object.entries(a.props)) h.style.setProperty(k, v); break;
        case "insert":          h.insertAdjacentHTML(a.position, a.html); break;
        case "setValue":        (h as HTMLInputElement).value = a.value; break;
        case "check":           (h as HTMLInputElement).checked = a.checked; break;
        case "clear":           (h as HTMLInputElement).value = ""; break;
        case "scrollIntoView":  h.scrollIntoView({ block: a.block ?? "center", inline: a.inline ?? "nearest" }); break;
        case "blur":            h.blur(); break;
        case "dispatch":        h.dispatchEvent(new Event(a.event, { bubbles: a.bubbles ?? true })); break;
        case "selectText": {
          const range = document.createRange();
          range.selectNodeContents(h);
          const sics = window.getSelection();
          sics?.removeAllRanges();
          sics?.addRange(range);
          break;
        }
        case "replaceText": {
          const re = new RegExp(a.pattern, a.flags ?? "");
          const walk = (n: Node): void => {
            if (n.nodeType === 3) n.textContent = (n.textContent ?? "").replace(re, a.replacement);
            else n.childNodes.forEach(walk);
          };
          walk(h);
          break;
        }
      }
    }
    return els.length;
  }, action);
  if (matched === 0) {
    throw new Error(`animate: action "${action.type}" selector "${selector ?? "?"}" matched no elements`);
  }
}

/**
 * DM-852 §7: resolve `${name}` against `cfg.vars` in every string field of the
 * config (recursively), returning a new config. `$${` escapes to a literal
 * `${`; an unknown `${name}` is a hard error (typo-catching). No-op when there
 * are no vars.
 */
export function interpolateConfigVars(cfg: AnimateConfig): AnimateConfig {
  const vars = cfg.vars ?? {};
  if (Object.keys(vars).length === 0) return cfg;
  const sub = (s: string): string =>
    s.replace(/\$\$\{|\$\{([^}]*)\}/g, (match, name: string | undefined) => {
      if (match === "$${") return "${";
      if (name == null || !(name in vars)) throw new Error(`animate: unknown variable \${${name ?? ""}}`);
      return vars[name];
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v != null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      // Don't interpolate into the `vars` map itself (no nested vars in v1).
      for (const [k, val] of Object.entries(v)) out[k] = k === "vars" ? val : walk(val);
      return out;
    }
    return v;
  };
  return walk(cfg) as AnimateConfig;
}

/**
 * Validate a parsed config object against {@link animateConfigSchema}. Returns
 * the typed config on success; on failure throws an `animate:`-prefixed Error
 * listing each offending path + message (the CLI surfaces it as
 * `domotion: animate: …`). zod's default issue messages are specific enough on
 * their own — "Invalid input: expected number, received string" etc. — so we
 * just prefix each with its dotted/bracketed path rather than re-authoring them.
 */
export function validateAnimateConfig(raw: unknown): AnimateConfig {
  const result = animateConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(`animate: ${formatConfigIssues(result.error)}`);
}

function formatConfigIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path
        .map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`))
        .join("")
        .replace(/^\./, "");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

interface AnchorBox { x: number; y: number; width: number; height: number; contentWidth: number }

/**
 * DM-850 §5: resolve any overlay `anchor` against the live page. For each
 * anchored overlay, query the selector's bounding box and set the overlay's
 * x/y from the requested corner + dx/dy. For a typing overlay's `maxWidth`,
 * set `bgWidth` to the anchored element's content width ("anchor") or the
 * given px. A missing anchor selector is a hard error.
 */
async function resolveOverlayAnchors(page: Page, overlays: OverlayInput[] | undefined, frameIdx: number): Promise<OverlayInput[] | undefined> {
  if (overlays == null) return undefined;
  const out: OverlayInput[] = [];
  for (const ov of overlays) {
    const anchor = ov.anchor;
    const maxWidth = ov.kind === "typing" ? ov.maxWidth : undefined;
    if (anchor == null && maxWidth == null) {
      out.push(ov);
      continue;
    }

    let box: AnchorBox | null = null;
    if (anchor != null) {
      box = await page.evaluate((sel: string): AnchorBox | null => {
        const el = document.querySelector(sel);
        if (el == null) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        return { x: r.x, y: r.y, width: r.width, height: r.height, contentWidth: Math.max(0, el.clientWidth - padL - padR) };
      }, anchor.selector);
      if (box == null) throw new Error(`animate: frames[${frameIdx}] overlay anchor selector "${anchor.selector}" matched no element`);
    }

    const resolved = { ...ov };
    if (anchor != null && box != null) {
      const [ax, ay] = anchorPoint(box, anchor.at ?? "top-left");
      resolved.x = ax + (anchor.dx ?? 0);
      resolved.y = ay + (anchor.dy ?? 0);
    }
    if (resolved.kind === "typing" && maxWidth != null) {
      if (maxWidth === "anchor") {
        if (box == null) throw new Error(`animate: frames[${frameIdx}] typing overlay maxWidth:"anchor" requires an anchor`);
        resolved.bgWidth = box.contentWidth;
      } else {
        resolved.bgWidth = maxWidth;
      }
    }
    out.push(resolved);
  }
  return out;
}

function anchorPoint(box: AnchorBox, at: string): [number, number] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  switch (at) {
    case "top": return [cx, box.y];
    case "top-right": return [right, box.y];
    case "left": return [box.x, cy];
    case "center": return [cx, cy];
    case "right": return [right, cy];
    case "bottom-left": return [box.x, bottom];
    case "bottom": return [cx, bottom];
    case "bottom-right": return [right, bottom];
    case "top-left":
    default: return [box.x, box.y];
  }
}

// ── Cursor overlay (DM-851 §6) ──────────────────────────────────────────────

type CursorEventInput = z.infer<typeof cursorEventSchema>;
type CursorStyleInput = z.infer<typeof cursorStyleSchema>;

/** Resolve a selector's center in page (viewport) coords, or null if absent. */
async function queryCursorBox(page: Page, sel: string): Promise<{ cx: number; cy: number } | null> {
  return page.evaluate((s: string) => {
    const el = document.querySelector(s);
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, sel);
}

/**
 * Assemble a global-time `CursorOverlay` from resolved coords + the frame
 * timeline. "auto" derives a move + click-pulse per recorded interaction
 * target, spaced across each frame's hold; the explicit form maps each
 * `{ frame, at }` event to global time. Move events carry absolute `to` coords.
 */
export function buildCursorOverlay(
  auto: boolean,
  explicitEvents: CursorEventInput[],
  styleCfg: CursorStyleInput | undefined,
  autoTargets: Array<{ frame: number; cx: number; cy: number }>,
  explicitBoxes: Map<string, { cx: number; cy: number }>,
  frameStarts: number[],
  frames: AnimateConfig["frames"],
): CursorOverlay | undefined {
  const moveDur = 400;
  const events: CursorEvent[] = [];

  if (auto) {
    // DM-1050: stage each interaction over the image it visually happens ON.
    // In the continuous-session model a frame's CONTENT is the RESULT of its
    // actions — capture runs AFTER the actions — and the transition INTO that
    // frame is what reveals the result. So a click captured into a `continue`
    // frame must be shown during the PREVIOUS frame's hold (the "before" image),
    // landing just before that transition. Otherwise the click pulse fires in
    // the middle of the frame that already shows the change it caused — the
    // reported bug: "the mouse moves and clicks after the change is shown."
    // A click in frame 0 (or a reload frame, which loads a fresh page) has no
    // prior before-image, so it stays within its own hold.
    const stageFor = (actionFrame: number): number => {
      if (actionFrame === 0) return 0;
      const fc = frames[actionFrame];
      const isContinue = fc.continue === true || fc.input == null;
      return isContinue ? actionFrame - 1 : actionFrame;
    };
    const byStage = new Map<number, Array<{ cx: number; cy: number }>>();
    for (const tgt of autoTargets) {
      const stage = stageFor(tgt.frame);
      const arr = byStage.get(stage) ?? [];
      arr.push({ cx: tgt.cx, cy: tgt.cy });
      byStage.set(stage, arr);
    }
    for (const [stage, targets] of byStage) {
      const start = frameStarts[stage];
      const holdEnd = start + frames[stage].duration;
      // Leave a short beat after the last click before the transition reveals
      // the result, so the click reads as cause-then-effect rather than landing
      // exactly on the cut.
      const tail = Math.min(250, frames[stage].duration * 0.25);
      const lastHit = holdEnd - tail;
      const span = Math.max(0, lastHit - start);
      targets.forEach((tg, m) => {
        // Single click → land at `lastHit` (just before the transition).
        // Multiple → spread across the hold so the LAST still lands at lastHit.
        const tHit = targets.length === 1 ? lastHit : start + (span * (m + 1)) / targets.length;
        events.push({ type: "move", t: Math.max(start, tHit - moveDur), duration: moveDur, to: { x: tg.cx, y: tg.cy } });
        events.push({ type: "click", t: tHit });
      });
    }
  } else {
    for (const ev of explicitEvents) {
      const t = frameStarts[ev.frame] + ev.at;
      if (ev.type === "hide") { events.push({ type: "hide", t }); continue; }
      if (ev.type === "click") { events.push({ type: "click", t, button: ev.button }); continue; }
      // move / moveClick
      let pos: { x: number; y: number } | null = null;
      if (ev.to != null) {
        pos = { x: ev.to.x + (ev.offset?.dx ?? 0), y: ev.to.y + (ev.offset?.dy ?? 0) };
      } else if (ev.selector != null) {
        const b = explicitBoxes.get(`${ev.frame}:${ev.selector}`);
        if (b != null) pos = { x: b.cx + (ev.offset?.dx ?? 0), y: b.cy + (ev.offset?.dy ?? 0) };
      }
      if (pos == null) continue;
      const d = ev.duration ?? moveDur;
      events.push({ type: "move", t, duration: d, to: pos });
      if (ev.type === "moveClick") events.push({ type: "click", t: t + d, button: ev.button });
    }
  }

  if (events.length === 0) return undefined;
  return { events, style: mapCursorStyle(styleCfg) };
}

/** Map the config-facing cursor style to the renderer's `Partial<CursorStyle>`. */
function mapCursorStyle(s: CursorStyleInput | undefined): Partial<CursorStyle> | undefined {
  if (s == null) return undefined;
  const style: Partial<CursorStyle> = {};
  if (s.scale != null) style.cursorScale = s.scale;
  if (s.color != null) style.cursorFill = s.color;
  if (s.pulseColor != null) style.pulseStroke = s.pulseColor;
  if (s.pulseRadius != null) style.pulseRadius = s.pulseRadius;
  if (s.pulseDurationMs != null) style.pulseDurationMs = s.pulseDurationMs;
  return style;
}

/**
 * Walk a frame's overlay list, expand `kind: "svg"` entries by reading the
 * referenced SVG file, namespacing its ids, and replacing `src` with the
 * inlined `innerSvg`. Other overlay kinds pass through verbatim.
 */
function resolveSvgOverlays(overlays: OverlayInput[] | undefined, configDir: string, frameIdx: number): AnimationOverlay[] | undefined {
  if (overlays == null) return undefined;
  const out: AnimationOverlay[] = [];
  let svgIdx = 0;
  for (const ov of overlays) {
    if (ov.kind === "svg") {
      // Inline the referenced file and swap `src` → `innerSvg`/`animId`.
      const srcPath = resolve(configDir, ov.src);
      if (!existsSync(srcPath)) throw new Error(`animate: svg overlay file not found: ${srcPath}`);
      const fileText = readFileSync(srcPath, "utf8");
      const animId = `s${svgIdx++}`;
      const namespaced = namespaceSvgIds(fileText, `f${frameIdx}o${animId}-`);
      out.push({
        kind: "svg",
        innerSvg: namespaced,
        x: ov.x, y: ov.y, width: ov.width, height: ov.height,
        animId,
        enter: ov.enter, exit: ov.exit,
      });
    } else {
      // typing / tap / blink already match their runtime overlay shapes verbatim.
      out.push(ov);
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
