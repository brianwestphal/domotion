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
import { resolveAnchoredOverlays } from "../animation/resolve-overlays.js";
// DM-1130: import from the feature sub-barrels rather than the package root
// (`../index.js`). This module IS re-exported from the root (so library callers
// can run the declarative pipeline in-process), so importing the root here would
// create a barrel import cycle. The sub-barrels don't depend on the root.
import {
  buildMagicMove,
  generateAnimatedSvg,
  cursorAtPoint,
  type AnimationConfig,
  type AnimationFrame,
  type IntraFrameAnimation,
  type AnimationOverlay,
  type CursorOverlay,
  type CursorEvent,
  type CursorStyle,
} from "../animation/index.js";
import { captureElementTree, launchChromium, attachWebfontTracker, discoverAndRegisterWebfonts } from "../capture/index.js";
import { borderBox } from "../capture/content-box.js";
import type { CapturedElement } from "../capture/types.js";
import { clearEmbeddedFonts, clearGlyphDefs, clearWebfonts, elementTreeToSvgInner, getEmbeddedFontFaceCss } from "../render/index.js";
import { composeScrollSvg, executeScrollPattern, parseScrollPattern } from "../scroll/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import { optimizeSvg } from "../post-processing/index.js";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { castToAnimatedSvg } from "../terminal/index.js";
import { terminalThemeSpecSchema } from "../terminal/theme.js";
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

// DM-1225 (doc 67): per-frame terminal options for a `cast` frame. All optional;
// they default to the cast header / the term tool's defaults.
// A built-in theme name, or a spec overriding bg / fg / ansi[16] on top of an
// `extends` base (default catppuccin). DM-1225. The spec form is the shared
// `terminalThemeSpecSchema` (also used by `term --theme-file`) so the two theme
// surfaces validate identically.
const termThemeSchema = z.union([z.string(), terminalThemeSpecSchema]);

const termOptionsSchema = z.object({
  theme: termThemeSchema.optional(),
  mode: z.enum(["incremental", "full"]).optional(),
  cursor: z.enum(["block", "bar", "underline", "none"]).optional(),
  cursorColor: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  padding: z.number().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  settleMs: z.number().optional(),
  minFrameMs: z.number().optional(),
  maxFrameMs: z.number().optional(),
  tailMs: z.number().optional(),
});

const frameSchema = z.object({
  // DM-846 §1 — `input` is optional. Frame 0 must load an input; a later frame
  // that omits `input` (or sets `continue: true`) keeps the previous frame's
  // live page. The frame-0 / continue+input rules are enforced in the
  // config-level superRefine below (they need cross-frame context).
  input: z.string().optional(),
  // DM-1225 (doc 67): a `cast` frame embeds a recorded terminal session
  // (asciinema v2 .cast) as this frame's content — a self-contained animated
  // terminal SVG, nested like a `scroll` block. Size `duration` to ≈ the cast's
  // recorded length (the tool logs it). Mutually exclusive with `input`.
  cast: z.string().optional(),
  term: termOptionsSchema.optional(),
  // DM-1287 (doc 73): a `template` frame embeds a named Domotion template's
  // output (e.g. a `lower-third` banner or a `kinetic-text` title) as this
  // frame's content — most templates emit an animated SVG, which nests like a
  // `cast` frame. `params` is validated against the named template's own schema
  // at compose time (path-specific errors). The template inherits the config's
  // `width`/`height` when its schema has those params and they're unset, so it
  // fills the frame by default; a smaller/larger output is centered (+ clipped).
  // Mutually exclusive with `input` / `cast` / `continue`.
  template: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  // DM-1293: how a `template` frame's output is placed when its size differs from
  // the canvas. `center` (default) places it 1:1 (oversized → clipped); `contain`
  // scales it down to fit, preserving aspect (letterboxed); `cover` scales it up
  // to fill, preserving aspect (cropped). Only meaningful on a template frame.
  fit: z.enum(["center", "contain", "cover"]).optional(),
  continue: z.boolean().optional(),
  // DM-1294: `duration` is required on every frame EXCEPT a `template` frame,
  // which may omit it to inherit the template's own play time (its generator
  // reports `durationMs`). Defaults to `0` (a sentinel for "unset" — a 0 ms frame
  // is never valid), so the type stays `number` for the timeline math; the
  // "required-and-positive unless template" rule is enforced in the config-level
  // superRefine below (it needs the sibling `template` field).
  duration: z.number().default(0),
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
      if (i === 0 && f.input == null && f.cast == null && f.template == null) {
        ctx.addIssue({ code: "custom", path: ["frames", 0, "input"], message: "frame 0 must load an `input`, a `cast`, or a `template`" });
      }
      if (i === 0 && f.continue === true) {
        ctx.addIssue({ code: "custom", path: ["frames", 0, "continue"], message: "frame 0 cannot continue — it has no predecessor" });
      }
      if (f.continue === true && f.input != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "continue"], message: "a frame cannot set both `continue` and `input` (reload or continue, not both)" });
      }
      // DM-1225: a `cast` frame is its own content source — it can't also load
      // an `input`, continue a live page, or run page-oriented options.
      if (f.cast != null && f.input != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "cast"], message: "a frame cannot set both `cast` and `input`" });
      }
      if (f.cast != null && f.continue === true) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "cast"], message: "a `cast` frame cannot also `continue` a live page" });
      }
      // DM-1287: a `template` frame is its own content source — it can't also
      // load an `input`, embed a `cast`, or continue a live page. `params`
      // without a `template` has nothing to validate against.
      if (f.template != null && f.input != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "template"], message: "a frame cannot set both `template` and `input`" });
      }
      if (f.template != null && f.cast != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "template"], message: "a frame cannot set both `template` and `cast`" });
      }
      if (f.template != null && f.continue === true) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "template"], message: "a `template` frame cannot also `continue` a live page" });
      }
      if (f.params != null && f.template == null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "params"], message: "`params` requires a `template`" });
      }
      // DM-1293: `fit` only governs how a template frame's output is placed.
      if (f.fit != null && f.template == null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "fit"], message: "`fit` requires a `template`" });
      }
      // DM-1294: `duration` is required (and positive) except on a `template`
      // frame, which derives it from the template's play time when omitted (the
      // `0` default is the "unset" sentinel).
      if (f.duration <= 0 && f.template == null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "duration"], message: "`duration` is required and must be > 0 (only a `template` frame may omit it — it inherits the template's play time)" });
      }
    });
  });

export type AnimateConfig = z.infer<typeof animateConfigSchema>;
/** The intra-frame `animations` array of a frame — the working type templates build. */
export type Anims = NonNullable<AnimateConfig["frames"][number]["animations"]>;
/** DM-1140 (doc 63 §2): the declarative action union accepted by `runActions`
 *  (and the `actions` field of an animate config). Interaction actions (click /
 *  fill / press / hover / focus / selectOption / scroll / wait / evaluate) plus
 *  the DOM-mutation set (setText / setHtml / remove / setAttribute / addClass /
 *  toggleClass / setStyle / insert / setValue / check / clear / scrollIntoView /
 *  blur / dispatch / selectText / replaceText). Re-exported from the package root. */
export type AnimateAction = z.infer<typeof actionSchema>;
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
 * DM-1138 (doc 62 §2): per-frame hook fired by `composeAnimateConfig` /
 * `composeAnimateFrames` after each frame is captured + culled + overlays/anchors
 * resolved and **pushed**, before the prior frame's magic-move bridge is built.
 * `frame` is the just-pushed `AnimationFrame` (mutating `frame.overlays` etc. IS
 * reflected in the final SVG); `page` is the live Playwright page (still on this
 * frame's DOM); `tree` is the captured element tree — `null` for scroll-block
 * frames, which compose their own sub-SVG and have no single tree. Caveat:
 * mutating `tree` after the fact does NOT re-render `frame.svgContent` (it was
 * already serialized) — edit `frame.svgContent` / `frame.overlays` instead. May
 * be async; it's awaited before the next frame.
 */
export type OnFrameHook = (
  frame: AnimationFrame,
  ctx: { page: Page; tree: CapturedElement[] | null; index: number },
) => void | Promise<void>;

/**
 * DM-1138 (doc 62 "Signature compatibility"): the options-object form of the
 * `composeAnimateConfig` / `composeAnimateFrames` trailing arguments. Accepted as
 * the 3rd argument in place of the positional `(configDir?, log?)` — both forms
 * are supported (the positional form is kept for the already-published callers).
 */
export interface ComposeAnimateOptions {
  /** Resolves a frame's relative `input` / svg-overlay `src` paths. Default `process.cwd()`. */
  configDir?: string;
  /** Progress logger. Default no-op. */
  log?: (msg: string) => void;
  /** DM-1138: per-frame hook (see `OnFrameHook`). */
  onFrame?: OnFrameHook;
}

/** Normalize the `(configDir?, log?)` positional form OR the `(opts?)` object
 *  form into a single shape (DM-1138). */
function normalizeComposeArgs(
  configDirOrOpts?: string | ComposeAnimateOptions,
  log?: (msg: string) => void,
): { configDir: string; log: (msg: string) => void; onFrame?: OnFrameHook } {
  if (configDirOrOpts != null && typeof configDirOrOpts === "object") {
    return {
      configDir: configDirOrOpts.configDir ?? process.cwd(),
      log: configDirOrOpts.log ?? (() => {}),
      onFrame: configDirOrOpts.onFrame,
    };
  }
  return { configDir: configDirOrOpts ?? process.cwd(), log: log ?? (() => {}), onFrame: undefined };
}

/**
 * DM-1137 (doc 62 §1): the "frames-out" variant of `composeAnimateConfig`. Runs
 * the exact same capture + action + overlay/cursor resolution + cull + magic-move
 * pipeline but STOPS before `generateAnimatedSvg`, returning the assembled
 * `AnimationConfig` (`{ width, height, frames, fontFaceCss, cursorOverlay,
 * resolveCursorAt, background }`). Lets callers inspect / mutate the composed
 * frames (add an overlay, drop a frame, post-process glyphs) before rendering —
 * the render is then just `generateAnimatedSvg(config)`. `composeAnimateConfig`
 * is reduced to exactly that, so the two can't diverge (the doc 60/61 one-engine-
 * two-callers pattern).
 *
 * Creates one browser context (sized / emulated per `cfg`) and closes it before
 * returning; the caller owns the `browser` lifecycle. The trailing args accept
 * EITHER the positional `(configDir?, log?)` form OR a single
 * `ComposeAnimateOptions` object `{ configDir?, log?, onFrame? }` (DM-1138) — the
 * options form is how you pass the per-frame `onFrame` hook. `configDir` resolves
 * a frame's relative `input` / svg-overlay `src` paths (default `process.cwd()`);
 * `log` defaults to a no-op.
 */
/**
 * DM-1287 (doc 73): render every `template` frame's named template to a finished
 * SVG string, ready to nest as that frame's `svgContent`. Returns a map keyed by
 * frame index (only template frames appear).
 *
 * Runs BEFORE the caller's outer font lifecycle so the nested per-template
 * `composeAnimateFrames` (a template is a front-end onto the same engine) can
 * clear + manage the module-global font builders without clobbering the outer
 * run's frames — each template's output carries its own `@font-face`.
 *
 * Sizing: the template inherits the config's `width`/`height` when its params
 * schema declares those fields and the caller left them unset, so it fills the
 * frame by default. A template whose output differs from the canvas (e.g.
 * `device-mockup`, which grows by its bezel) is centered; an oversized output is
 * centered and clipped by the frame viewport. The template's own internal
 * timeline plays within the frame's `duration` (size `duration` to ≈ the
 * template's play time, same rule as a `cast` frame).
 *
 * Loaded via dynamic `import()` to avoid a static import cycle (the template
 * subsystem already imports `composeAnimateConfig` from this module).
 */
/**
 * DM-1293: place a nested frame's `content` (a `srcW × srcH` SVG body) inside a
 * `dstW × dstH` canvas per the `fit` policy, wrapping it in a `<g transform>` when
 * a translate/scale is needed (and returning it untouched when neither is — the
 * exact-fit common case). All modes keep the content centered:
 *  - `center` — 1:1, no scale (oversized content is clipped by the frame viewport).
 *  - `contain` — scale to fit, preserving aspect (letterboxed).
 *  - `cover` — scale to fill, preserving aspect (the overflow is clipped).
 * Exported for unit testing the geometry without a browser.
 */
export function placeEmbeddedFrame(
  content: string,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  fit: "center" | "contain" | "cover" = "center",
): string {
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  let scale = 1;
  if (fit === "contain") scale = Math.min(dstW / srcW, dstH / srcH);
  else if (fit === "cover") scale = Math.max(dstW / srcW, dstH / srcH);
  const ox = r((dstW - srcW * scale) / 2);
  const oy = r((dstH - srcH * scale) / 2);
  const parts: string[] = [];
  if (ox !== 0 || oy !== 0) parts.push(`translate(${ox},${oy})`);
  // `transform` applies right-to-left, so `translate(…) scale(…)` scales first
  // (about the content's own origin) then offsets — i.e. the scaled box is centered.
  if (scale !== 1) parts.push(`scale(${r(scale)})`);
  return parts.length > 0 ? `<g transform="${parts.join(" ")}">${content}</g>` : content;
}

async function renderTemplateFrames(
  cfg: AnimateConfig,
  browser: Browser,
  log: (msg: string) => void,
): Promise<Map<number, { content: string; durationMs: number | null }>> {
  const out = new Map<number, { content: string; durationMs: number | null }>();
  const idxs = cfg.frames.flatMap((f, i) => (f.template != null ? [i] : []));
  if (idxs.length === 0) return out;

  const { loadTemplate } = await import("../templates/registry.js");
  const { renderTemplateToSvg } = await import("../templates/render.js");

  for (const i of idxs) {
    const fc = cfg.frames[i];
    const name = fc.template as string;
    log(`Rendering template "${name}" for frame ${i + 1}/${cfg.frames.length}…`);

    let template;
    try {
      template = await loadTemplate(name);
    } catch (e) {
      throw new Error(`animate: frames[${i}].template: ${(e as Error).message}`);
    }

    // Inherit the canvas size into the template's `width`/`height` params when
    // its schema declares them and the caller didn't set them, so the template
    // fills the frame. Introspect the zod object shape; templates without those
    // params (or non-object schemas) just get no injection.
    const shape = (template.paramsSchema as { shape?: Record<string, unknown> }).shape;
    const base: Record<string, unknown> = {};
    if (shape != null && Object.prototype.hasOwnProperty.call(shape, "width")) base.width = cfg.width;
    if (shape != null && Object.prototype.hasOwnProperty.call(shape, "height")) base.height = cfg.height;
    const rawParams = { ...base, ...(fc.params ?? {}) };

    let result;
    try {
      result = await renderTemplateToSvg(template, rawParams, { browser, log: (m) => log(`  ${m}`) });
    } catch (e) {
      // Param-validation errors already carry their own `template "x": …` path.
      throw new Error(`animate: frames[${i}]: ${(e as Error).message}`);
    }

    const fit = fc.fit ?? "center";
    if (fit === "center" && (result.width > cfg.width || result.height > cfg.height)) {
      log(`  note: template output ${result.width}×${result.height} exceeds the ${cfg.width}×${cfg.height} canvas — it will be centered and clipped (set "fit":"contain" to scale it down)`);
    }

    // DM-1294: resolve the frame's duration. When the author omitted it, inherit
    // the template's own play time (`durationMs`); a static template (no intrinsic
    // duration) MUST carry an explicit `duration`. When the author set one that's
    // shorter than the template plays, warn — the template will be cut off (same
    // rule as a `cast` frame).
    if (fc.duration <= 0) {
      if (result.durationMs == null) {
        throw new Error(`animate: frames[${i}].duration: template "${name}" has no intrinsic play time (it's a static template) — set an explicit "duration"`);
      }
      fc.duration = result.durationMs;
      log(`  frame duration defaulted to the template's play time: ${result.durationMs}ms`);
    } else if (result.durationMs != null && fc.duration < result.durationMs) {
      log(`  note: frame duration ${fc.duration}ms < template play time ${result.durationMs}ms — the template will be cut off; size duration to ≈ ${result.durationMs}ms`);
    }

    // Namespace the template's document-global names (ids, font families, frame
    // classes, @keyframes, --scene-dur) with a per-frame token so they can't
    // collide with the outer animation or sibling template frames once nested
    // into one document (a template is a full `generateAnimatedSvg` SVG, and
    // SVG/CSS names are document-global, not scoped to a nested `<svg>`).
    let content = namespaceEmbeddedAnimatedSvg(result.svg, `tf${i}_`);
    // Strip the XML prolog so the `<svg>` nests cleanly in the animator's frame
    // group (same as a `cast` frame). Center within the canvas when smaller.
    content = content.replace(/^<\?xml[^>]*\?>\s*/, "");
    content = placeEmbeddedFrame(content, result.width, result.height, cfg.width, cfg.height, fit);
    out.set(i, { content, durationMs: result.durationMs ?? null });
  }
  return out;
}

export async function composeAnimateFrames(
  browser: Browser,
  cfg: AnimateConfig,
  configDirOrOpts?: string | ComposeAnimateOptions,
  logArg?: (msg: string) => void,
): Promise<AnimationConfig> {
  const { configDir, log, onFrame } = normalizeComposeArgs(configDirOrOpts, logArg);
  // DM-852: resolve `${vars}` across every string field before anything runs.
  cfg = interpolateConfigVars(cfg);
  // DM-1287 (doc 73): render `template` frames UP FRONT, before the outer run's
  // font lifecycle (clearWebfonts / clearEmbeddedFonts) starts below. A template
  // is itself a front-end onto `composeAnimateConfig`, so rendering one runs a
  // NESTED `composeAnimateFrames` that clears + manages the module-global font
  // builders. Doing it here — before the outer clears — keeps each template's
  // output fully self-contained (its own `@font-face`) and stops the nested run
  // from clobbering the outer frames' embedded fonts. Each rendered template SVG
  // is a finished string by the time the outer loop reaches its frame.
  const templateRenders = await renderTemplateFrames(cfg, browser, log);
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
    clearGlyphDefs(); // DM-1338: reset the paths-mode glyph registry per generation too
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
      // DM-1225 (doc 67): a `cast` frame embeds a recorded terminal session as
      // this frame's content — a self-contained animated terminal SVG nested
      // like a `scroll` block. It bypasses the page-load/capture path entirely.
      if (fc.cast != null) {
        const castPath = resolveFrameInput(fc.cast, configDir);
        log(`Frame ${i + 1}/${cfg.frames.length}: rendering terminal cast ${castPath}…`);
        const castText = readFileSync(castPath, "utf8");
        const t = fc.term ?? {};
        // manageFonts: false — share THIS pipeline's embedded-font builder (the
        // loop already cleared it at the start and collects it once below), so
        // the terminal font lands in the scene-wide @font-face block exactly
        // once and its glyph PUA family names stay unique vs the other frames'
        // (no clobber, no per-cast duplicate). The nested terminal SVG is then
        // composed WITHOUT its own font CSS — it defers to that block. The cast
        // renders via the chosen mode (incremental by default).
        const { svg: castSvg, totalDurationMs } = await castToAnimatedSvg(castText, browser, {
          theme: t.theme, mode: t.mode, cursor: t.cursor, cursorColor: t.cursorColor,
          fontSize: t.fontSize, fontFamily: t.fontFamily, padding: t.padding,
          cols: t.cols, rows: t.rows,
          settleMs: t.settleMs, minFrameMs: t.minFrameMs, maxFrameMs: t.maxFrameMs, tailMs: t.tailMs,
          manageFonts: false,
          log: (m) => log(`  ${m}`),
        });
        if (fc.duration < totalDurationMs) {
          log(`  note: frame duration ${fc.duration}ms < cast play time ${totalDurationMs}ms — the terminal will be cut off; size duration to ≈ ${totalDurationMs}ms`);
        }
        // DM-1292: the cast SVG is a full `generateAnimatedSvg` document, so its
        // document-global names (ids, `.f-N` frame classes + `@keyframes fv-N` in
        // `mode: "full"`, the incremental `ln…` / `tcur…` keyframes, `--scene-dur`)
        // collide with the outer animation's identical names, or with a sibling
        // cast frame's, once concatenated — a duplicate `@keyframes`/rule wins
        // globally and hijacks the wrong frame's timeline (visible when the
        // timeline is SEEKED, like the DM-1145 id-collision bug). Namespace them
        // with a per-frame token, exactly like a `template` frame. Fonts are the
        // ONE exception: `manageFonts: false` defers them to this pipeline's shared
        // embedded-font builder (one `@font-face` block, already-unique `dmfN`
        // names) collected after the loop, so we must NOT prefix the cast's
        // `font-family` references or they'd dangle.
        const termSvg = namespaceEmbeddedAnimatedSvg(castSvg, `cf${i}_`, { namespaceFonts: false });
        // The animator wraps `svgContent` in `<g class="f f-N">`, which holds a
        // nested `<svg>` fine — strip just the XML prolog (same as scroll).
        frames.push({
          svgContent: termSvg.replace(/^<\?xml[^>]*\?>\s*/, ""),
          duration: fc.duration,
          transition: fc.transition,
          // DM-1320: overlays render on top of the cast (explicit x/y); a selector
          // anchor can't resolve (no DOM) and now warns instead of vanishing.
          overlays: resolveEmbeddedFrameOverlays(fc.overlays, configDir, i, "cast", log),
          // DM-1319: the nested cast is a self-contained animated SVG with its
          // own internal period (the rendered cast length). Tell the animator
          // so it re-anchors the cast's timeline to start when THIS frame is
          // shown, rather than running on the shared document origin (which
          // desyncs a cast that isn't frame 0 to its back half).
          embeddedAnimationPeriodMs: totalDurationMs,
        });
        // A cast frame has no single captured tree; magic-move to/from it falls
        // back to crossfade, and the cursor/overlay machinery is skipped.
        prevFrameTree = null;
        frameTrees.push(null);
        continue;
      }
      // DM-1287 (doc 73): a `template` frame embeds a named template's output,
      // pre-rendered above into a finished (self-contained, possibly animated)
      // SVG string. Nest it exactly like a `cast` frame.
      if (fc.template != null) {
        log(`Frame ${i + 1}/${cfg.frames.length}: embedding template "${fc.template}"…`);
        const tr = templateRenders.get(i)!;
        frames.push({
          svgContent: tr.content,
          duration: fc.duration,
          transition: fc.transition,
          // DM-1320: same as a cast frame — a template frame has no captured DOM,
          // so a selector anchor warns and falls back to explicit x/y.
          overlays: resolveEmbeddedFrameOverlays(fc.overlays, configDir, i, "template", log),
          // DM-1319: an ANIMATED template (one with an intrinsic play time) is a
          // self-contained animated SVG, same as a `cast` frame — re-anchor its
          // timeline to this frame's master-loop offset so it begins when shown.
          // A static template (durationMs == null) carries no internal animation.
          ...(tr.durationMs != null ? { embeddedAnimationPeriodMs: tr.durationMs } : {}),
        });
        prevFrameTree = null;
        frameTrees.push(null);
        continue;
      }
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
            transformOrigin: a.transformOrigin,
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

      // DM-1138 (doc 62 §2): per-frame hook — fired after the frame is pushed
      // (so `frame.overlays` mutations land in the final SVG) and while the page
      // is still on this frame's DOM, BEFORE the magic-move bridge below.
      if (onFrame != null) {
        await onFrame(frames[frames.length - 1], { page, tree: frameTree, index: i });
      }

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
    // DM-1137: return the assembled config instead of rendering it here — the
    // render lives in `composeAnimateConfig` so callers can mutate frames first.
    return { width: cfg.width, height: cfg.height, frames, fontFaceCss, cursorOverlay, resolveCursorAt, background: canvasBg };
  } finally {
    await ctx.close();
  }
}

/**
 * Capture and compose every frame in `cfg` into one animated SVG string
 * (unoptimized). Shared by the `animate` CLI, the example-regression harness,
 * and library callers who run the declarative pipeline in-process (DM-1130) —
 * all exercise the exact same capture→compose path. The caller owns the
 * `browser` lifecycle.
 *
 * DM-1137: this is now exactly `generateAnimatedSvg(await composeAnimateFrames(
 * …))` — one engine, two callers. Reach for `composeAnimateFrames` directly when
 * you need to inspect / mutate the assembled `AnimationConfig` before rendering.
 *
 * The trailing args accept EITHER the positional `(configDir?, log?)` form OR a
 * single `ComposeAnimateOptions` object `{ configDir?, log?, onFrame? }`
 * (DM-1138). `configDir` resolves a frame's relative `input` / svg-overlay `src`
 * paths (default `process.cwd()`); `log` defaults to a no-op. A typical
 * programmatic call is just `composeAnimateConfig(browser, cfg)` after
 * `validateAnimateConfig(json)`.
 */
export async function composeAnimateConfig(
  browser: Browser,
  cfg: AnimateConfig,
  configDirOrOpts?: string | ComposeAnimateOptions,
  logArg?: (msg: string) => void,
): Promise<string> {
  const config = await composeAnimateFrames(browser, cfg, configDirOrOpts, logArg);
  const { log } = normalizeComposeArgs(configDirOrOpts, logArg);
  return await timed(log, `Composed animated SVG (${config.frames.length} frames)`, () =>
    Promise.resolve(generateAnimatedSvg(config)),
  );
}

/**
 * DM-1140 (doc 63 §2): apply the declarative action vocabulary against a live
 * Playwright page, in order. Re-exported from the package root so imperative
 * scripting-API callers get the DOM-mutation actions (setText / addClass /
 * insert / replaceText / setStyle / dispatch / …) — the ones that AREN'T
 * one-line Playwright calls and that already encode the "apply across every
 * matched element, throw if the selector matches nothing" semantics (doc 43 →
 * Selectors) — without authoring a whole JSON config. `log` defaults to a no-op
 * (the CLI passes a logger for the `evaluate`-too-long nudge); the public form
 * doesn't need one. Throws on the first failing action (e.g. a DOM-mutation
 * selector that matches nothing), surfacing the bug rather than silently
 * skipping.
 */
export async function runActions(page: Page, actions: AnimateAction[], log: (msg: string) => void = () => {}): Promise<void> {
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
        const EVALUATE_NUDGE_MAX_CHARS = 200;
        const EVALUATE_NUDGE_MAX_LINES = 2;
        if (a.script.length > EVALUATE_NUDGE_MAX_CHARS || a.script.split("\n").length > EVALUATE_NUDGE_MAX_LINES) {
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

/**
 * DM-850 §5 / DM-1132: resolve any overlay `anchor` (and typing `maxWidth`)
 * against the live page into concrete `x` / `y` / `bgWidth`. Delegates to the
 * shared `resolveAnchoredOverlays` engine so the CLI and the public
 * `resolveOverlays` primitive can't diverge; this wrapper only supplies the
 * frame-indexed error label.
 */
function resolveOverlayAnchors(page: Page, overlays: OverlayInput[] | undefined, frameIdx: number): Promise<OverlayInput[] | undefined> {
  return resolveAnchoredOverlays(page, overlays, (kind) => `animate: frames[${frameIdx}] ${kind} overlay`);
}

// ── Cursor overlay (DM-851 §6) ──────────────────────────────────────────────

type CursorEventInput = z.infer<typeof cursorEventSchema>;
type CursorStyleInput = z.infer<typeof cursorStyleSchema>;

/** Resolve a selector's BORDER-box center in page (viewport) coords, or null if
 *  absent. DM-1139: collapsed onto the shared `borderBox` primitive (doc 63) so
 *  the CLI cursor and the public `resolveCursorTarget` can't diverge. `borderBox`
 *  throws on no-match; the `"auto"` recording path tolerates a missing selector
 *  (the action itself fails later, the cursor recording just skips it), so we map
 *  that throw back to null here. */
async function queryCursorBox(page: Page, sel: string): Promise<{ cx: number; cy: number } | null> {
  try {
    const [cx, cy] = (await borderBox(page, sel, { at: "center" })).at;
    return { cx, cy };
  } catch {
    return null;
  }
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
/**
 * DM-1320: overlays on an embedded-content frame (`cast` / `template`). These
 * frames have NO captured DOM, so a selector `anchor` (or typing `maxWidth:
 * "anchor"`) can't resolve — previously the whole overlay was silently dropped,
 * leaving the author with a vanished overlay and no clue why. Instead: warn
 * clearly that selector anchoring isn't supported here (use explicit `x`/`y`),
 * strip the unresolvable anchor so the overlay falls back to its `x`/`y`, then
 * resolve `svg` overlays as usual so explicit-coordinate overlays DO render on
 * top of the embedded animation.
 */
export function resolveEmbeddedFrameOverlays(
  overlays: OverlayInput[] | undefined,
  configDir: string,
  frameIdx: number,
  frameKind: "cast" | "template",
  log: (msg: string) => void,
): AnimationOverlay[] | undefined {
  if (overlays == null) return undefined;
  const stripped = overlays.map((ov) => {
    let next = ov;
    if ("anchor" in next && next.anchor != null) {
      log(`  warning: overlay anchor { selector: ${JSON.stringify(next.anchor.selector)} } is ignored on a ${frameKind} frame — it has no captured DOM to resolve a selector against. The overlay falls back to its x/y (default 0,0); set explicit "x"/"y" to position it.`);
      next = { ...next, anchor: undefined };
    }
    if (next.kind === "typing" && next.maxWidth === "anchor") {
      log(`  warning: typing overlay maxWidth:"anchor" is ignored on a ${frameKind} frame (no DOM); set a fixed px width instead.`);
      next = { ...next, maxWidth: undefined };
    }
    return next;
  });
  return resolveSvgOverlays(stripped, configDir, frameIdx);
}

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
