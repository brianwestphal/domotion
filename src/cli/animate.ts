/**
 * `domotion animate` subcommand.
 *
 * Reads a JSON config describing N frames (each captured from a URL or HTML
 * file), runs each frame's actions / scroll pattern / intra-frame animations,
 * captures, and composes one animated SVG with CSS keyframe transitions.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Browser, Page, CDPSession } from "@playwright/test";
// DM-1131: the authoring overlay / intra-frame-animation schemas below EXTEND
// these single-source-of-truth base schemas (which also derive the renderer's
// runtime types), so a field rename moves both views together instead of
// silently drifting.
import {
  typingOverlaySchema,
  tapOverlaySchema,
  blinkOverlaySchema,
  shineOverlaySchema,
  interactOverlaySchema,
  overlaySlideSchema,
  intraFrameAnimationSchema,
} from "../animation/overlay-schema.js";
import { resolveAnchoredOverlays } from "../animation/resolve-overlays.js";
import {
  captureStyleSnapshot,
  classifyHoverTransition,
  synthesizeMotionTween,
  diffHoverSnapshots,
  HOVER_DIFF_PROPERTIES,
  type HoverDiff,
} from "./hover-detect.js";
// DM-1130: import from the feature sub-barrels rather than the package root
// (`../index.js`). This module IS re-exported from the root (so library callers
// can run the declarative pipeline in-process), so importing the root here would
// create a barrel import cycle. The sub-barrels don't depend on the root.
import {
  buildMagicMove,
  generateAnimatedSvg,
  cursorAtPoint,
  composeCompressedRun,
  resolveTextTrack,
  type AnimationConfig,
  type AnimationFrame,
  type IntraFrameAnimation,
  type AnimationOverlay,
  type CursorOverlay,
  type CursorEvent,
  type CursorStyle,
  type CompressedRunState,
  type ResolvedTextTrack,
  type TextTrackSpec,
  type TextTrackSpecEvent,
} from "../animation/index.js";
import { captureElementTree, launchChromium, attachWebfontTracker, discoverAndRegisterWebfonts, injectBrandVariables } from "../capture/index.js";
import { loadBrand, brandSchema, type Brand } from "../templates/brand.js";
import { type BoxAnchor, borderBox } from "../capture/content-box.js";
import type { CapturedElement } from "../capture/types.js";
import { clearEmbeddedFonts, clearGlyphDefs, clearWebfonts, elementTreeToSvgInner, getEmbeddedFontFaceCss } from "../render/index.js";
import { composeScrollSvg, executeScrollPattern, parseScrollPattern } from "../scroll/index.js";
import { annotateAnimatedProperties, cullElementsOutsideViewBox } from "../tree-ops/index.js";
import { compressEmbeddedFontsToWoff2, optimizeSvg } from "../post-processing/index.js";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import { resolveMotionPreset, resolveEasingPreset } from "../animation/motion-presets.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { prefixSvgIds, prefixSvgClasses } from "../render/svg-inline.js";
import { castToAnimatedSvg } from "../terminal/index.js";
import { terminalThemeSpecSchema } from "../terminal/theme.js";
import { resolveFormat, type SafeInset } from "../templates/formats.js";
import { buildTypeResampleAnimation, resolveTypeResampleSpec } from "./type-resample.js";
import { buildJsRevealAnimation, resolveJsRevealSpec, MUTATION_DETECT_EVENTS } from "./mutation-detect.js";
import {
  applyReadyWaits,
  isSvgzPath,
  loadInputIntoPage,
  makeLogger,
  parseIntFlag,
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
  // DM-1524 / DM-1547: the cross-engine-safe transition/effect vocabulary
  // (docs/88). The originals plus directional pushes, clip-path reveals (`wipe` /
  // `iris` / the DM-1547 radial `wipe-radial` + angular `wipe-clock`), scale
  // dollies, and the shine sweep — all transform / clip-path / opacity / gradient
  // only (never an animated filter, so they composite on Blink / WebKit / Gecko).
  type: z.enum([
    "crossfade", "push-left", "scroll", "cut", "magic-move",
    "push-right", "push-up", "push-down",
    "wipe", "iris", "zoom-in", "zoom-out", "shine",
    "wipe-radial", "wipe-clock",
  ]),
  duration: z.number(),
  // DM-1550: optional named easing (or a raw CSS easing string) for the
  // `wipe` / `iris` clip-path reveal and the `zoom-in` / `zoom-out` scale dolly
  // this transition drives into the next frame. Resolved through the motion-
  // preset vocabulary in the animator (incl. the sampled `spring-*` curves).
  // Ignored by the other transition types. Default: linear.
  easing: z.string().optional().describe("Named/raw easing for wipe/iris/zoom reveals (spring-* etc.)."),
  // DM-1585: `wipe-clock` only — start angle (deg clockwise from 12 o'clock) and
  // counterclockwise sweep. Ignored by other transition types.
  wipeStartAngle: z.number().optional().describe("wipe-clock: start angle in degrees clockwise from 12 o'clock (default 0)."),
  wipeCounterclockwise: z.boolean().optional().describe("wipe-clock: sweep counterclockwise instead of clockwise."),
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
    // DM-1526: a named motion preset (fade-up / pop / slide-in-<dir> / wipe-in, …)
    // can supply property/from/to/fuse/easing, so those become optional here — the
    // preset fills them and any explicit field overrides. `easing` also accepts a
    // named easing preset (spring / back-out / ease-out-quart / …). Expansion runs
    // in `expandMotionPreset` before the animation is emitted.
    property: intraFrameAnimationSchema.shape.property.optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    preset: z.string().optional().describe("Named motion preset supplying property/from/to/fuse/easing."),
    presetDistance: z.coerce.number().optional().describe("Travel px for slide/fade presets."),
    presetScaleFrom: z.coerce.number().optional().describe("Start scale for the `pop` preset."),
    exit: z.boolean().optional().describe("Reverse the preset (animate the element OUT)."),
  });

/**
 * DM-1526: expand a motion preset (if any) into concrete intra-frame animation
 * fields and resolve any named easing preset. Explicit `property`/`from`/`to`/
 * `easing`/`fuse` on the animation override the preset. Throws if neither a preset
 * nor explicit property/from/to is present.
 */
type ExpandedFrameAnimation = z.infer<typeof frameAnimationSchema> & {
  property: NonNullable<z.infer<typeof frameAnimationSchema>["property"]>;
  from: string;
  to: string;
};
function expandMotionPreset(a: z.infer<typeof frameAnimationSchema>): ExpandedFrameAnimation {
  let preset: ReturnType<typeof resolveMotionPreset> | null = null;
  if (a.preset != null) {
    preset = resolveMotionPreset(a.preset, { distance: a.presetDistance, scaleFrom: a.presetScaleFrom, exit: a.exit });
  }
  const property = a.property ?? preset?.property;
  const from = a.from ?? preset?.from;
  const to = a.to ?? preset?.to;
  if (property == null || from == null || to == null) {
    throw new Error(
      `animation for "${a.selector}": needs either a "preset" or explicit property/from/to.`,
    );
  }
  return {
    ...a,
    property,
    from,
    to,
    easing: resolveEasingPreset(a.easing ?? preset?.easing),
    transformOrigin: a.transformOrigin ?? preset?.transformOrigin,
    fuse: a.fuse ?? preset?.fuse,
  } as ExpandedFrameAnimation;
}

const insertPositionSchema = z.enum(["beforebegin", "afterbegin", "beforeend", "afterend"]);
const scrollLogicalSchema = z.enum(["start", "center", "end", "nearest"]);

// DM-1742: optional cursor aim on interaction actions, consumed by
// `cursor: "auto"` when deriving the pointer target. `cursorAt` picks one of
// the nine named anchor points on the target's border box (the overlay
// `anchor.at` vocabulary, default "center"); `cursorOffset` nudges from
// there in px. Lets an auto-derived click land beside a label the viewer must
// read (e.g. a counter button whose text IS the changing value) without the
// invisible-child-pad workaround. Ignored under explicit `cursor.events`
// (those carry their own selector/at/offset) and when no cursor is shown.
const cursorAimSchema = {
  cursorAt: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
  cursorOffset: z.object({ dx: z.number().optional(), dy: z.number().optional() }).optional(),
};

const actionSchema = z.discriminatedUnion("type", [
  // Interaction (Playwright-native).
  z.object({ type: z.literal("click"),  selector: z.string(), ...cursorAimSchema }),
  z.object({ type: z.literal("fill"),   selector: z.string(), value: z.string(), ...cursorAimSchema }),
  z.object({ type: z.literal("press"),  key: z.string() }),
  z.object({ type: z.literal("scroll"), x: z.number().optional(), y: z.number().optional() }),
  z.object({ type: z.literal("hover"),  selector: z.string(), ...cursorAimSchema }),
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
const anchorFields = {
  selector: z.string(),
  at: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
};
// Strict so an anchor key that isn't supported on this overlay kind — e.g.
// `baseline` on anything but a typing overlay (DM-1750) — fails validation at
// its config path instead of being silently stripped.
const anchorSchema = z.strictObject(anchorFields);
// DM-1750: typing overlays additionally take `baseline: true` — resolve the
// overlay's `y` (its text baseline) to the anchored element's measured
// first-line text baseline, killing the hand-tuned ascent `dy`.
const typingAnchorSchema = z.strictObject({ ...anchorFields, baseline: z.boolean().optional() });

// DM-1131: overlay *authoring* shapes derive from the runtime base schemas in
// `../animation/overlay-schema.ts`. Each adds the config-only conveniences —
// `x`/`y` defaulted to 0 (an `anchor` can supply them), and selector
// `anchor` / typing `maxWidth` (resolved at capture time, see
// `resolveOverlayAnchors`). The `svg` kind is its own shape because authoring
// takes a `src` file path that the CLI later reads / namespaces into the
// runtime `innerSvg` + `animId` (see `resolveSvgOverlays`).
// Exported so the `storyboard` runner can offer the SAME per-scene overlay
// authoring vocabulary (typing / tap / svg / blink / shine) without redefining
// it — DM-1554 reuses this schema + `resolveEmbeddedFrameOverlays` verbatim.
export const overlaySchema = z.discriminatedUnion("kind", [
  typingOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    // DM-850 §5: anchor to an element bbox; maxWidth wraps to the anchored
    // element's content width ("anchor") or a fixed px. DM-1750: the typing
    // anchor additionally accepts `baseline: true` (y → the element's
    // first-line text baseline).
    anchor: typingAnchorSchema.optional(),
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
  shineOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    // DM-1549: an `anchor` can auto-size + auto-position the glint, so width /
    // height default to 0 (like x / y). Unanchored, they must be given; anchored,
    // the resolver fills them from the element's box (radius from its
    // border-radius) unless an explicit positive value is supplied.
    width: z.number().default(0),
    height: z.number().default(0),
    anchor: anchorSchema.optional(),
  }),
  // DM-1565: the synthetic interaction-feedback overlay. Like `shine`, an
  // `anchor` can auto-size + auto-position the treatment, so width / height
  // default to 0 (the resolver fills them from the anchored element's box, and
  // the radius from its border-radius) unless explicit positive values are given.
  interactOverlaySchema.extend({
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().default(0),
    height: z.number().default(0),
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

// DM-1516 (docs/94): forced CSS pseudo-state capture. Before a frame is
// captured, each `selector` is forced into the listed pseudo-classes via CDP
// `CSS.forcePseudoState`, so the page's OWN `:hover` / `:active` / `:focus`
// styling is what gets painted and serialized — no fake overlay, zero authoring
// on top of the page's real rules. The enum is the well-supported subset of
// CDP's `forcedPseudoClasses`; pair it with a cursor event/action so the pointer
// sits on the element it's hovering.
const forcePseudoClassSchema = z.enum([
  "hover", "active", "focus", "focus-within", "focus-visible",
  "visited", "target", "enabled", "disabled", "checked",
  "indeterminate", "read-only", "read-write", "link",
]);
const forceStateSchema = z
  .object({
    selector: z.string(),
    /** Pseudo-states to force (`:hover` / `:active` / `:focus` / …). Required
     *  unless `reset` is set. */
    states: z.array(forcePseudoClassSchema).optional(),
    /**
     * DM-1566 (docs/94): DROP any forced pseudo-state on the matched element(s)
     * instead of setting one — the un-hover / return-to-rest verb. In a
     * continuous-session (`continue`) flow this lets a later frame release a hover
     * a previous frame forced and capture the element back at rest. Mutually
     * exclusive with `states`. Under the hood it re-issues `CSS.forcePseudoState`
     * with an EMPTY class list on the SAME CDP session that set the override
     * (a different session can't clear another's override), so it truly reverts.
     */
    reset: z.boolean().optional(),
  })
  .refine((v) => v.reset === true || (v.states != null && v.states.length >= 1), {
    message: "must list at least one pseudo-state, or set reset:true to clear",
  })
  .refine((v) => !(v.reset === true && v.states != null && v.states.length > 0), {
    message: "cannot set both `states` and `reset` (force a state, or clear it — not both)",
  });
/** DM-1516 / DM-1566 (docs/94): one forced-pseudo-state entry. Either forces the
 *  element(s) matching `selector` into `states` (`:hover` / `:active` / `:focus`
 *  / …) via CDP before capture, or — with `reset: true` — clears any state a
 *  previous frame forced on them (the un-hover verb). Consumed by
 *  `applyForcedPseudoStates` and the animate config's per-frame `forceState`
 *  array. */

// DM-1556 (docs/93 §2): per-keystroke real-site re-sampling. Unlike the `typing`
// OVERLAY (which synthesizes text as a `<text>` reveal on top of one capture),
// this drives the live field one keystroke at a time and re-captures the page
// after each keystroke, so the field's OWN input masking / auto-formatting /
// validation styling / font is what gets serialized. The N captures compose into
// one nested animated SVG (the `cast`/`template` nesting pattern) — heavier than
// the overlay, so it's an explicit opt-in per frame. Mutually exclusive with the
// other content-producing frame kinds (`scroll` / `cast` / `template`).
const typeResampleSchema = z.object({
  /** The input / textarea to type into. Must match a focusable element. */
  selector: z.string(),
  /** The keystrokes to send — one re-captured state per character. */
  text: z.string().min(1, "must be a non-empty string"),
  /** Per-keystroke hold in ms (the flipbook step). Default 60. */
  speed: z.number().positive().optional(),
  /** Hold before the first keystroke (ms). Default 0. */
  delay: z.number().nonnegative().optional(),
  /** Hold on the fully-typed final state (ms) before the internal loop restarts. Default 700. */
  tailMs: z.number().nonnegative().optional(),
  /** Clear the field before typing so the re-sample starts empty. Default true. */
  clear: z.boolean().optional(),
  /** Draw the field's REAL caret (from `selectionEnd`) as a blinking bar. Default true. */
  caret: z.boolean().optional(),
  /** Caret shape (DM-1591). `"auto"` (default) honors the field's computed CSS
   *  `caret-shape`; `bar`/`block`/`underscore` force a shape. */
  caretShape: z.enum(["auto", "bar", "block", "underscore"]).optional(),
  /** DM-1581: capture only the field's region per keystroke onto a static base,
   *  cutting output size (O(N·page) → O(page + N·field)). Off by default — with it
   *  ON, changes OUTSIDE the field aren't animated (only the field is). */
  regionOnly: z.boolean().optional(),
});

// DM-1564 (docs/94 option 3): MutationObserver JS-change harness. `forceState`
// captures a page's CSS `:hover`/`:focus` styling, but not feedback a page drives
// with JAVASCRIPT — a class flip, an injected tooltip/menu, an aria change. This
// dispatches a real pointer event, runs a MutationObserver with an async
// settle/debounce, and synthesizes the JS-driven reveal (added/removed nodes) as
// a rest→after crossfade nested into this frame's content (the same nesting as
// `typeResample`/`cast`, so no animator change). Opt-in (heavier: two captures +
// a live settle). Mutually exclusive with the other content-producing kinds.
const jsRevealSchema = z.object({
  /** The element to dispatch the pointer event at. */
  selector: z.string(),
  /** The pointer event to dispatch. Default `mouseover`. */
  event: z.enum(MUTATION_DETECT_EVENTS).optional(),
  /** Max ms to wait for the page's JS mutations to settle. Default 600. */
  settleMs: z.number().positive().optional(),
  /** Quiet window (ms) with no mutations that counts as "settled". Default 120. */
  debounceMs: z.number().positive().optional(),
  /** Rest hold + after hold, each in ms. Default 700. */
  holdMs: z.number().positive().optional(),
  /** The rest→after crossfade duration (ms). Default 300. */
  crossfadeMs: z.number().nonnegative().optional(),
});
export type ForceState = z.infer<typeof forceStateSchema>;

// DM-1747 (docs/100 Primitive 1): compressed editing run — the `states: [...]`
// block. One config frame captures N editing states of the live page (each
// state runs its actions, then is captured) and composes them via
// `composeCompressedRun` into ONE nested animated SVG: shared content emitted
// once, every later state contributing only what changed (step-end glyph
// births/deaths, tail shifts, recolors). The frame's content is the composed
// run — the typeResample/cast nesting precedent, zero animator changes.
const runStateSchema = z.object({
  /** Actions applied to the live page before this state is captured. State 0
   *  is the frame's own post-`actions` state, so it usually omits them. */
  actions: z.array(actionSchema).optional(),
  /** How long this state holds (ms) before snapping to the next. */
  duration: z.number().positive("must be a positive number (ms)"),
});

// The run's opt-in auto-caret (docs/101 machinery): the compressor derives the
// per-state edit points, so the caret rides the run with zero addressing.
const statesCaretSchema = z.union([
  z.boolean(),
  z.object({
    shape: z.enum(["bar", "block", "underscore"]).optional().describe("Caret shape (docs/97). Default bar."),
    color: z.string().optional().describe("Caret color. Default #111111."),
  }),
]);

// DM-1747 (docs/101): declarative caret + selection track. Events address
// character positions inside a captured element (`selector` resolved at
// capture time via the `data-domotion-anim` stamp, exactly like intra-frame
// animations); `at` is ms within the frame, mapped to global time like cursor
// events. Offsets count Unicode code points.
const textTrackEventSchema = z.discriminatedUnion("type", [
  /** Place the caret at the offset (shows it if hidden); blinks while parked. */
  z.object({ type: z.literal("park"), at: z.number().nonnegative(), charOffset: z.number().int().nonnegative(), selector: z.string().optional() }),
  /** Step-end jump to the offset (same semantics as park; reads better in scripts). */
  z.object({ type: z.literal("move"), at: z.number().nonnegative(), charOffset: z.number().int().nonnegative(), selector: z.string().optional() }),
  /** Hide the caret until the next park/move. */
  z.object({ type: z.literal("hide"), at: z.number().nonnegative() }),
  /** Sweep a selection over [charStart, charEnd), growing over sweepMs. */
  z.object({
    type: z.literal("select"),
    at: z.number().nonnegative(),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().positive(),
    sweepMs: z.number().nonnegative().optional(),
    color: z.string().optional(),
    selector: z.string().optional(),
  }),
  /** Clear the most recent selection. */
  z.object({ type: z.literal("clearSelection"), at: z.number().nonnegative() }),
]);

const textTrackSchema = z
  .object({
    /** The element whose text the events address (first match; stamped with
     *  `data-domotion-anim` at capture — a no-match is a hard error). */
    selector: z.string(),
    /** Caret shape (docs/97): bar (default) / block / underscore. */
    shape: z.enum(["bar", "block", "underscore"]).optional(),
    /** Caret color. Default #111111. */
    color: z.string().optional(),
    /** Bar-caret width px (default 2). */
    barWidthPx: z.number().positive().optional(),
    /** Blink period ms (default 1060). */
    blinkMs: z.number().positive().optional(),
    /** Default selection fill (per-event `color` overrides). Default a translucent blue. */
    selectionColor: z.string().optional(),
    events: z.array(textTrackEventSchema).min(1, "must be a non-empty array"),
  })
  .superRefine((tt, ctx) => {
    tt.events.forEach((ev, j) => {
      if (ev.type === "select" && ev.charEnd <= ev.charStart) {
        ctx.addIssue({ code: "custom", path: ["events", j, "charEnd"], message: "`charEnd` must be greater than `charStart`" });
      }
    });
  });
type TextTrackInput = z.infer<typeof textTrackSchema>;

// DM-1562 (docs/94 Option 1): `hoverReveal` sugar. A one-field per-frame reveal
// that auto-expands (BEFORE the capture loop, in `expandHoverReveal`) into two
// frames — the frame at REST, then a `continue` frame that forces `:hover`
// (`forceState`) on the same selector — cross-fading between them, plus a cursor
// move onto the element so the pointer sits where the hover happens. Pure sugar
// over the shipped `forceState` + cursor + crossfade primitives; the 80% hover
// demo without hand-wiring two frames.
const hoverRevealSchema = z.object({
  /** Element to reveal the interaction state on (forced + cursor target). */
  selector: z.string(),
  /** Pseudo-states to force on the reveal frame. Default `["hover"]` — set e.g.
   *  `["focus", "focus-visible"]` for a focus reveal. */
  states: z.array(forcePseudoClassSchema).min(1).optional(),
  /** Crossfade duration into the reveal frame (ms). Default 400. */
  crossfadeMs: z.number().positive().optional(),
  /** How long the revealed (hover) frame holds (ms). Default: the frame's own
   *  `duration` (the rest hold). */
  hoverMs: z.number().positive().optional(),
  /** Inject a cursor move onto `selector` on the reveal frame. Default `true`
   *  (skipped when the config's cursor is `"auto"`, which can't mix with explicit
   *  events). */
  cursor: z.boolean().optional(),
});

// DM-1563 (docs/94 Option 2): `hoverDetect` — auto-DETECT what the page changes
// on hover and synthesize the transition. A pre-pass (`expandHoverDetect`) drives
// a real pointer via `forceState`, diffs `getComputedStyle` (+ geometry) on the
// target and its descendants before → after, and picks a synthesis:
//   - a PAINT change (color / background / border / box-shadow) → a rest→hover
//     crossfade (blends the deltas faithfully, box-shadow included);
//   - a MOTION-only change (transform / opacity on the target alone) → a single
//     frame with an intra-frame keyframe TWEEN so the element animates in place.
// Cross-engine `@keyframes` only. Only supported on a frame that loads an `input`
// (a `continue`/`cast`/`template` frame has no standalone page to probe).
const hoverDetectSchema = z.object({
  /** Element whose hover response is detected (probed + cursor target). */
  selector: z.string(),
  /** Pseudo-states to enter while probing. Default `["hover"]`. */
  states: z.array(forcePseudoClassSchema).min(1).optional(),
  /** Transition duration into / of the synthesized reveal (ms). Default 400. */
  transitionMs: z.number().positive().optional(),
  /** How long the revealed state holds (ms). Default: the frame's `duration`. */
  hoverMs: z.number().positive().optional(),
  /** Inject a cursor move onto `selector`. Default `true`. */
  cursor: z.boolean().optional(),
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
  /**
   * DM-1516 (docs/94): force real CSS pseudo-state on selectors before capture,
   * so this frame paints the page's OWN `:hover` / `:active` / `:focus` styling
   * (via CDP `CSS.forcePseudoState`) instead of a fake overlay. Applied after
   * `actions`, so it reflects the post-action DOM. Combine with a `cursor` event
   * to place the pointer on the hovered element.
   */
  forceState: z.array(forceStateSchema).optional(),
  /**
   * DM-1562 (docs/94): `hoverReveal` sugar. Expands this frame into a rest frame
   * + a forced-`:hover` `continue` frame with a crossfade and a cursor move onto
   * the element — the one-field version of the hand-wired two-frame hover demo.
   * The frame must load an `input` or `continue` a live page (not a cast/template
   * frame). Its `duration` becomes the rest hold.
   */
  hoverReveal: hoverRevealSchema.optional(),
  /**
   * DM-1563 (docs/94): `hoverDetect` — auto-detect the page's hover response and
   * synthesize the transition (paint change → crossfade, motion-only → intra-frame
   * tween). Only on a frame that loads an `input`. Its `duration` becomes the rest
   * hold.
   */
  hoverDetect: hoverDetectSchema.optional(),
  /**
   * DM-1556 (docs/93 §2): re-capture the live field after each keystroke instead
   * of synthesizing a `typing` overlay — the high-fidelity path that renders the
   * page's OWN input masking / auto-formatting / validation / font. Composes into
   * this frame's content (a nested per-keystroke animated SVG). Applied after
   * `actions` / `forceState` (types into the post-action DOM). Mutually exclusive
   * with `scroll` / `cast` / `template` (all produce the frame's content).
   */
  typeResample: typeResampleSchema.optional(),
  /**
   * DM-1564 (docs/94 option 3): detect JS-driven feedback. Dispatch a pointer
   * event on `selector`, observe the page's own DOM mutations (a class flip, an
   * injected tooltip / dropdown, an aria change) until they settle, and
   * synthesize the reveal (added/removed nodes) as a rest→after crossfade that
   * becomes this frame's content. Applied after `actions` / `forceState`.
   * Mutually exclusive with `scroll` / `cast` / `template` / `typeResample`.
   */
  jsReveal: jsRevealSchema.optional(),
  /**
   * DM-1747 (docs/100 Primitive 1): compressed editing run. Captures N states
   * of the live page inside this ONE frame — state 0 is the frame's own
   * post-`actions` state; each later state runs its `actions` then captures —
   * and composes them via the frame-sequence compressor into a nested animated
   * SVG that becomes this frame's content (shared content once, step-end glyph
   * births / tail shifts / recolors; layout SNAPS at state boundaries).
   * Mutually exclusive with `scroll` / `cast` / `template` / `typeResample` /
   * `jsReveal` (all produce the frame's content).
   */
  states: z.array(runStateSchema).min(1, "must be a non-empty array").optional(),
  /**
   * DM-1747: the compressed run's auto-caret — `true` (bar, #111111) or
   * `{ shape, color }`. The compressor derives each state's edit point, so the
   * caret rides the run with zero addressing. Requires `states`.
   */
  caret: statesCaretSchema.optional(),
  /**
   * DM-1747 (docs/101): declarative caret + selection tracks anchored to this
   * frame's captured text. Each track's `selector` is stamped at capture time
   * (`data-domotion-anim`, the intra-frame-animation mechanism) and events
   * address character positions by code-point offset; `at` is ms within the
   * frame. Requires a captured frame (not scroll/cast/template/typeResample/
   * jsReveal/states, which have no single captured tree).
   */
  textTracks: z.array(textTrackSchema).optional(),
  overlays: z.array(overlaySchema).optional(),
  /** Intra-frame animations (DM-209). Selector resolved against the captured DOM. */
  animations: z.array(frameAnimationSchema).optional(),
});

// DM-851 §6 — config-level cursor overlay. Either "auto" (derive a move +
// click-pulse per click/hover/fill action) or an explicit event list.
// Exported so the `storyboard` runner reuses the SAME cursor style / event
// authoring shapes for its storyboard-level cursor track (DM-1554).
export const cursorStyleSchema = z.object({
  scale: z.number().optional(),
  color: z.string().optional(),
  pulseColor: z.string().optional(),
  pulseRadius: z.number().optional(),
  pulseDurationMs: z.number().optional(),
});

export const cursorEventSchema = z
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
    /**
     * DM-1544 (docs/85 + docs/92): an inline brand for the whole run, so a config
     * is self-contained without the `--brand` CLI flag. Either a path (resolved
     * relative to the config's directory) to a brand JSON file, or an inline brand
     * object validated by the same `brandSchema`. The brand themes captured frames
     * (CSS-variable injection, docs/92) AND `template` frames (their brand
     * defaults, docs/85). Precedence: an explicit `--brand` flag overrides this
     * config key. A relative `logo` inside an inline object resolves against the
     * config's directory (a string path defers to `loadBrand`'s file-relative
     * resolution).
     */
    brand: z.union([z.string(), brandSchema]).optional(),
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
      // DM-1556: `typeResample` produces the frame's content (a nested
      // per-keystroke animated SVG), so it can't coexist with the other
      // content-producing frame kinds. It DOES drive the live page, so it's fine
      // on a `continue` frame or a fresh `input` load (unlike cast/template).
      if (f.typeResample != null && f.scroll != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "typeResample"], message: "a frame cannot set both `typeResample` and `scroll`" });
      }
      if (f.typeResample != null && f.cast != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "typeResample"], message: "a frame cannot set both `typeResample` and `cast`" });
      }
      if (f.typeResample != null && f.template != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "typeResample"], message: "a frame cannot set both `typeResample` and `template`" });
      }
      // DM-1564: `jsReveal` also produces the frame's content (a nested
      // rest→after crossfade), so it can't coexist with the other
      // content-producing kinds. It drives the live page, so it's fine on a
      // `continue` frame or a fresh `input` load.
      if (f.jsReveal != null && f.scroll != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "jsReveal"], message: "a frame cannot set both `jsReveal` and `scroll`" });
      }
      if (f.jsReveal != null && f.cast != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "jsReveal"], message: "a frame cannot set both `jsReveal` and `cast`" });
      }
      if (f.jsReveal != null && f.template != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "jsReveal"], message: "a frame cannot set both `jsReveal` and `template`" });
      }
      if (f.jsReveal != null && f.typeResample != null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "jsReveal"], message: "a frame cannot set both `jsReveal` and `typeResample`" });
      }
      // DM-1747: `states` produces the frame's content (a compressed-run nested
      // animated SVG), so it can't coexist with the other content-producing
      // kinds. It drives the live page, so it's fine on a `continue` frame or a
      // fresh `input` load (like `typeResample`).
      if (f.states != null) {
        const conflicts: Array<[string, unknown]> = [
          ["scroll", f.scroll], ["cast", f.cast], ["template", f.template],
          ["typeResample", f.typeResample], ["jsReveal", f.jsReveal],
        ];
        for (const [key, present] of conflicts) {
          if (present != null) {
            ctx.addIssue({ code: "custom", path: ["frames", i, "states"], message: `a frame cannot set both \`states\` and \`${key}\`` });
          }
        }
      }
      if (f.caret != null && f.states == null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "caret"], message: "`caret` requires a `states` compressed run (the typing overlay and `typeResample` carry their own caret options)" });
      }
      // DM-1747: `textTracks` resolves addresses against THIS frame's single
      // captured tree, so it can't ride a frame whose content is a nested
      // composition (no single tree to resolve against).
      if (f.textTracks != null) {
        const conflicts: Array<[string, unknown]> = [
          ["scroll", f.scroll], ["cast", f.cast], ["template", f.template],
          ["typeResample", f.typeResample], ["jsReveal", f.jsReveal], ["states", f.states],
        ];
        for (const [key, present] of conflicts) {
          if (present != null) {
            ctx.addIssue({ code: "custom", path: ["frames", i, "textTracks"], message: `\`textTracks\` needs this frame's captured tree — it cannot be combined with \`${key}\`` });
          }
        }
      }
      // DM-1294: `duration` is required (and positive) except on a `template`
      // frame, which derives it from the template's play time when omitted (the
      // `0` default is the "unset" sentinel).
      if (f.duration <= 0 && f.template == null) {
        ctx.addIssue({ code: "custom", path: ["frames", i, "duration"], message: "`duration` is required and must be > 0 (only a `template` frame may omit it — it inherits the template's play time)" });
      }
      // DM-1562: `hoverReveal` expands into captured frames — it needs a page
      // (an `input` or a `continue`), not a self-contained cast/template frame.
      if (f.hoverReveal != null) {
        if (f.cast != null || f.template != null) {
          ctx.addIssue({ code: "custom", path: ["frames", i, "hoverReveal"], message: "`hoverReveal` needs a captured page — it can't be used on a `cast` or `template` frame" });
        }
        if (f.forceState != null) {
          ctx.addIssue({ code: "custom", path: ["frames", i, "hoverReveal"], message: "`hoverReveal` already forces the hover state — don't combine it with `forceState` on the same frame" });
        }
        if (f.hoverDetect != null) {
          ctx.addIssue({ code: "custom", path: ["frames", i, "hoverReveal"], message: "set either `hoverReveal` or `hoverDetect` on a frame, not both" });
        }
      }
      // DM-1563: `hoverDetect` probes a standalone page — it needs an `input`
      // (a `continue`/`cast`/`template` frame has no page to load-and-probe).
      if (f.hoverDetect != null) {
        if (f.input == null || f.continue === true) {
          ctx.addIssue({ code: "custom", path: ["frames", i, "hoverDetect"], message: "`hoverDetect` requires an `input` (it loads-and-probes a standalone page; it can't run on a `continue`/`cast`/`template` frame)" });
        }
        if (f.forceState != null) {
          ctx.addIssue({ code: "custom", path: ["frames", i, "hoverDetect"], message: "`hoverDetect` synthesizes the state itself — don't combine it with `forceState` on the same frame" });
        }
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
      format:        { type: "string" },
      width:         { type: "string" },
      height:        { type: "string" },
      optimize:      { type: "boolean" },
      "no-optimize": { type: "boolean" },
      brand:         { type: "string" },
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

  // DM-1538: `--format <name|WxH>` re-targets the config's canvas (the animate
  // viewport). Precedence: explicit `--width`/`--height` > format > the config's
  // own `width`/`height` (which act as the default). The format's safe-area inset
  // rides through to any `template` frame's render context (page/captured frames
  // don't reflow — the format only sizes their viewport).
  let safeInset: SafeInset | undefined;
  if (values.format != null) {
    const fmt = resolveFormat(values.format);
    cfg.width = fmt.width;
    cfg.height = fmt.height;
    safeInset = fmt.safeInset;
  }
  if (values.width != null) cfg.width = parseIntFlag(values.width, "width", cfg.width);
  if (values.height != null) cfg.height = parseIntFlag(values.height, "height", cfg.height);

  const log = makeLogger(values.quiet === true);
  // DM-1540 (docs/92): `--brand <file>` themes every CAPTURED frame by injecting
  // the brand's CSS custom properties onto each page's `:root` before capture
  // (template/cast frames carry their own theming). Loaded here so a bad file
  // fails before Chromium launches.
  const brand: Brand | undefined = values.brand != null ? loadBrand(resolve(values.brand)) : undefined;
  log(`Launching Chromium…`);
  const browser = await launchChromium();
  let svg: string;
  try {
    svg = await composeAnimateConfig(browser, cfg, {
      configDir,
      log,
      ...(brand != null ? { brand } : {}),
      ...(safeInset != null ? { safeInset } : {}),
    });
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
    svg = await timed(log, `Optimizing SVG (${(svg.length / 1024).toFixed(1)} KB → …)`, () => compressEmbeddedFontsToWoff2(optimizeSvg(svg)));
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
  /** DM-1540 (docs/92): brand kit whose CSS custom properties are injected onto
   *  every CAPTURED frame's `:root` before capture, so pages authored against
   *  `var(--brand-*)` pick up the palette / font / radius. DM-1543: it ALSO feeds
   *  every `template` frame's param defaults (docs/85), so one brand themes both.
   *  Takes precedence over the config's inline `brand` key (DM-1544). Omitted (and
   *  no config `brand`) → no brand. Cast frames theme themselves. */
  brand?: Brand;
  /**
   * DM-1538: resolved safe-area inset (px per side) from a `--format` preset. It
   * rides through to any `template` frame's render context (so a themeable
   * built-in honors the format's safe margins + adaptive scale, DM-1537/DM-1541).
   * Captured/page frames don't reflow to it — the format only sizes their
   * viewport. Omitted → no inset.
   */
  safeInset?: SafeInset;
}

/** Normalize the `(configDir?, log?)` positional form OR the `(opts?)` object
 *  form into a single shape (DM-1138). */
function normalizeComposeArgs(
  configDirOrOpts?: string | ComposeAnimateOptions,
  log?: (msg: string) => void,
): { configDir: string; log: (msg: string) => void; onFrame?: OnFrameHook; brand?: Brand; safeInset?: SafeInset } {
  if (configDirOrOpts != null && typeof configDirOrOpts === "object") {
    return {
      configDir: configDirOrOpts.configDir ?? process.cwd(),
      log: configDirOrOpts.log ?? (() => {}),
      onFrame: configDirOrOpts.onFrame,
      brand: configDirOrOpts.brand,
      safeInset: configDirOrOpts.safeInset,
    };
  }
  return { configDir: configDirOrOpts ?? process.cwd(), log: log ?? (() => {}), onFrame: undefined };
}

/**
 * DM-1544: resolve a config's inline `brand` key into a `Brand`. A string is a
 * path to a brand JSON file (resolved relative to `configDir`, then parsed +
 * validated by `loadBrand`, which also resolves that file's own relative `logo`).
 * An object is an inline brand already validated by `brandSchema` at config-parse
 * time; here we only resolve a relative `logo` against `configDir` (mirroring
 * `loadBrand`'s file-relative behavior) so a template's logo slot gets an
 * absolute path. Returns `undefined` when the config sets no `brand`.
 */
export function resolveConfigBrand(brand: AnimateConfig["brand"], configDir: string): Brand | undefined {
  if (brand == null) return undefined;
  if (typeof brand === "string") return loadBrand(resolve(configDir, brand));
  const resolved: Brand = { ...brand };
  if (resolved.logo != null && resolved.logo !== "" && !isAbsolute(resolved.logo) && !/^https?:\/\//i.test(resolved.logo)) {
    resolved.logo = resolve(configDir, resolved.logo);
  }
  return resolved;
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
  safeInset?: SafeInset,
  brand?: Brand,
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
      result = await renderTemplateToSvg(template, rawParams, {
        browser,
        log: (m) => log(`  ${m}`),
        // DM-1538: a `--format` on `animate` passes its safe-area inset through to
        // template frames, so a themeable built-in honors the format's safe margins
        // + adaptive scale (DM-1537/DM-1541) — the same context a standalone
        // `domotion template --format …` render gets.
        ...(safeInset != null ? { safeInset } : {}),
        // DM-1543: the run's brand (from `--brand` or the config's `brand` key)
        // supplies each template frame's param defaults — the SAME `applyBrandDefaults`
        // merge `domotion template --brand` uses — so one flag/key themes both
        // captured frames (CSS-var injection, docs/92) and template frames (docs/85).
        ...(brand != null ? { brand } : {}),
      });
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

type AnimateFrameCfg = AnimateConfig["frames"][number];

/**
 * Build a `cast` frame (DM-1225): render the recorded terminal session to a
 * self-contained animated SVG, namespace its document-global names, and return
 * the frame. Extracted from `composeAnimateFrames`' loop (DM-1376); the caller
 * pushes it and resets `prevFrameTree`/`frameTrees` (a cast has no captured tree).
 */
async function buildCastFrame(
  fc: AnimateFrameCfg,
  i: number,
  cfg: AnimateConfig,
  configDir: string,
  browser: Browser,
  log: (msg: string) => void,
): Promise<AnimationFrame> {
  const castPath = resolveFrameInput(fc.cast!, configDir);
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
  return {
    svgContent: termSvg.replace(/^<\?xml[^>]*\?>\s*/, ""),
    duration: fc.duration,
    transition: fc.transition,
    // DM-1320: overlays render on top of the cast (explicit x/y); a selector
    // anchor can't resolve (no DOM) and now warns instead of vanishing.
    overlays: resolveEmbeddedFrameOverlays(fc.overlays, configDir, i, "cast", log),
    // DM-1319: the nested cast is a self-contained animated SVG with its own
    // internal period (the rendered cast length). Tell the animator so it
    // re-anchors the cast's timeline to start when THIS frame is shown, rather
    // than running on the shared document origin (which desyncs a cast that
    // isn't frame 0 to its back half).
    embeddedAnimationPeriodMs: totalDurationMs,
  };
}

/**
 * Build a `template` frame (DM-1287): wrap a template's pre-rendered (self-
 * contained, possibly animated) SVG. Extracted from `composeAnimateFrames`'
 * loop (DM-1376); the caller pushes it and resets `prevFrameTree`/`frameTrees`.
 */
function buildTemplateFrame(
  fc: AnimateFrameCfg,
  i: number,
  cfg: AnimateConfig,
  configDir: string,
  templateRenders: Awaited<ReturnType<typeof renderTemplateFrames>>,
  log: (msg: string) => void,
): AnimationFrame {
  log(`Frame ${i + 1}/${cfg.frames.length}: embedding template "${fc.template}"…`);
  const tr = templateRenders.get(i)!;
  return {
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
  };
}

/**
 * Per-frame loop state threaded into `buildCapturedFrame` (DM-1379). These are
 * the slices of `composeAnimateFrames`' shared state the captured/default frame
 * body reads or appends to: the live `page`, the run config + paths + logger,
 * the shared webfont tracker, and the cursor-recording accumulators (`auto`
 * targets get pushed; explicit-event selector boxes get set). Everything else
 * the loop owns (frames array, prevFrameTree, frameTrees, canvasBg) stays in the
 * caller — the helper returns what the caller needs to update them.
 */
interface CapturedFrameContext {
  page: Page;
  cfg: AnimateConfig;
  configDir: string;
  log: (msg: string) => void;
  tracker: ReturnType<typeof attachWebfontTracker>;
  cursorAuto: boolean;
  explicitCursorEvents: CursorEventInput[];
  autoCursorTargets: Array<{ frame: number; cx: number; cy: number }>;
  explicitCursorBoxes: Map<string, { cx: number; cy: number }>;
  /** DM-1747 (docs/101): resolved caret/selection tracks accumulated across
   *  frames (global-time geometry) for `AnimationConfig.textTracks`. */
  textTracks: ResolvedTextTrack[];
}

/**
 * Build a captured/default frame (DM-1379): the loop's main fall-through path —
 * continue-vs-load → readyWaits → webfont discovery → scrollTo → cursor
 * recording → actions → intra-frame animations → scroll-block-vs-capture →
 * overlays. Extracted from `composeAnimateFrames`' loop; unlike the cast/template
 * continue-branches (`buildCastFrame` / `buildTemplateFrame`) this is entangled
 * with shared loop state, so it takes a `CapturedFrameContext` (DM-1342-style
 * context struct) and returns `{ frame, frameTree, rootBg }` rather than pushing
 * itself. The caller owns the cross-frame after-build orchestration: set
 * `canvasBg` from `rootBg` on frame 0, push the frame, fire the `onFrame` hook,
 * build the magic-move bridge, and update `prevFrameTree` / `frameTrees`.
 *
 * The cursor-recording paths (`autoCursorTargets.push` / `explicitCursorBoxes
 * .set`) are byte-gated by the `cursor-auto` / `cursor-events` examples.
 */
async function buildCapturedFrame(
  fc: AnimateFrameCfg,
  i: number,
  ctx: CapturedFrameContext,
): Promise<{ frame: AnimationFrame; frameTree: CapturedElement[] | null; rootBg: string | undefined }> {
  const { page, cfg, configDir, log, tracker, cursorAuto, explicitCursorEvents, autoCursorTargets, explicitCursorBoxes } = ctx;
  // The captured root background of this frame (the caller stamps it onto the
  // composed canvas only for frame 0 — see DM-893); computed in both the scroll
  // and capture branches below.
  let rootBg: string | undefined;
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
  // aim point BEFORE the action runs (that's where the pointer clicks).
  // DM-1742: the action's optional `cursorAt` / `cursorOffset` aim the
  // pointer at a named border-box anchor + px nudge instead of the center.
  if (cursorAuto && fc.actions != null) {
    for (const a of fc.actions) {
      if (a.type === "click" || a.type === "hover" || a.type === "fill") {
        const c = await queryCursorBox(page, a.selector, a.cursorAt, a.cursorOffset);
        if (c != null) autoCursorTargets.push({ frame: i, cx: c.cx, cy: c.cy });
      }
    }
  }
  if (fc.actions != null) await runActions(page, fc.actions, log);
  // DM-1516 (docs/94): force real CSS pseudo-state (:hover / :active / :focus)
  // on the listed selectors via CDP BEFORE capture, so this frame paints the
  // page's OWN hover/focus styling. Runs after `actions` (reflects the
  // post-action DOM) and before the capture below (the forced paint is what gets
  // serialized). A no-op when the frame declares no `forceState`.
  await applyForcedPseudoStates(page, fc.forceState, log);
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
      const a = expandMotionPreset(fc.animations[ai]); // DM-1526: preset → concrete fields
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
        fuse: a.fuse,
      });
    }
  }

  // DM-1747 (docs/101): stamp each text track's target (and any per-event
  // selector override) with `data-domotion-anim` on the live DOM — the exact
  // mechanism intra-frame animations use above — so the captured tree carries
  // the animId the text-address resolver looks up. One target element per
  // track (first match); a selector matching nothing is a hard error naming
  // the frame + config path.
  if (fc.textTracks != null && fc.textTracks.length > 0) {
    const stamp = async (selector: string, animId: string, label: string): Promise<void> => {
      const matched = await page.evaluate(
        (args: { selector: string; animId: string }) => {
          const el = document.querySelector(args.selector);
          if (el instanceof HTMLElement) {
            el.dataset.domotionAnim = args.animId;
            return true;
          }
          return false;
        },
        { selector, animId },
      );
      if (!matched) throw new Error(`animate: ${label} selector "${selector}" matched no element in frame ${i}`);
    };
    for (let k = 0; k < fc.textTracks.length; k++) {
      const tt = fc.textTracks[k];
      await stamp(tt.selector, `f${i}tt${k}`, `frames[${i}].textTracks[${k}]`);
      for (let j = 0; j < tt.events.length; j++) {
        const ev = tt.events[j];
        if ("selector" in ev && ev.selector != null) {
          await stamp(ev.selector, `f${i}tt${k}e${j}`, `frames[${i}].textTracks[${k}].events[${j}]`);
        }
      }
    }
  }

  let svgContent: string;
  let frameCullCss: string;
  // DM-898: retain this frame's captured tree so a magic-move transition
  // can diff it against the next frame's. `null` for scroll-block frames
  // (no single tree) — magic-move then falls back to crossfade.
  let frameTree: CapturedElement[] | null = null;
  // DM-1556: a `typeResample` frame nests a per-keystroke animated SVG with its
  // own internal timeline; set so the animator re-anchors it to this frame's
  // master-loop offset (same as a `cast` / animated-`template` frame).
  let embeddedAnimationPeriodMs: number | undefined;
  if (fc.typeResample != null) {
    // DM-1556 (docs/93 §2): drive the field one keystroke at a time, re-capturing
    // after each keystroke, and compose the captures into one nested animated SVG
    // that becomes this frame's content. No single captured tree (like a scroll /
    // cast block), so magic-move to/from it falls back to crossfade.
    const spec = resolveTypeResampleSpec(fc.typeResample);
    const res = await buildTypeResampleAnimation(page, spec, {
      width: cfg.width, height: cfg.height, framePrefix: `tr${i}_`, log,
    });
    svgContent = res.svgContent;
    frameCullCss = "";
    rootBg = res.rootBg;
    embeddedAnimationPeriodMs = res.periodMs;
    if (fc.duration < res.periodMs) {
      log(`  note: frame duration ${fc.duration}ms < type-resample play time ${res.periodMs}ms — the typing will be cut off; size duration to ≈ ${res.periodMs}ms`);
    }
  } else if (fc.jsReveal != null) {
    // DM-1564 (docs/94 option 3): dispatch a pointer event, observe the page's
    // own JS-driven DOM mutations until they settle, and synthesize the reveal as
    // a rest→after crossfade nested into this frame's content. No single captured
    // tree (like a scroll / cast block), so magic-move to/from it crossfades.
    const spec = resolveJsRevealSpec(fc.jsReveal);
    const res = await buildJsRevealAnimation(page, spec, {
      width: cfg.width, height: cfg.height, framePrefix: `jr${i}_`, log,
    });
    svgContent = res.svgContent;
    frameCullCss = "";
    rootBg = res.rootBg;
    embeddedAnimationPeriodMs = res.periodMs;
    if (fc.duration < res.periodMs) {
      log(`  note: frame duration ${fc.duration}ms < jsReveal play time ${res.periodMs}ms — the reveal will be cut off; size duration to ≈ ${res.periodMs}ms`);
    }
  } else if (fc.states != null) {
    // DM-1747 (docs/100 Primitive 1): compressed editing run. Each state runs
    // its actions against the live page and is captured; the N states compose
    // via `composeCompressedRun` into ONE nested animated SVG (shared content
    // emitted once, step-end birth/shift/recolor tracks, snap at boundaries)
    // that becomes this frame's content — the typeResample/cast nesting
    // precedent, so the animator needs zero changes. No single captured tree
    // (magic-move to/from it falls back to crossfade).
    const res = await buildStatesRunContent(page, fc, i, cfg, log);
    svgContent = res.svgContent;
    frameCullCss = "";
    rootBg = res.rootBg;
    embeddedAnimationPeriodMs = res.periodMs;
    if (fc.duration < res.periodMs) {
      log(`  note: frame duration ${fc.duration}ms < compressed-run play time ${res.periodMs}ms — the run will be cut off; size duration to ≈ ${res.periodMs}ms`);
    }
  } else if (fc.scroll != null) {
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
      annotateAnimatedProperties(seg.tree, resolvedAnimations);
      cullElementsOutsideViewBox(seg.tree, cfg.width, cfg.height, undefined, 0, 1);
    }
    rootBg = segments[0]?.tree?.[0]?.styles?.rootBgComputed;
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
    // Record which CSS properties each animation animates on its target
    // elements (`el.animatedProperties`) so the renderer can hand those
    // channels over to the animation — e.g. not bake the captured opacity
    // onto the wrapper (it would multiply with the animated value) and not
    // drop `opacity: 0` elements a fade-in needs to exist. Must run BEFORE
    // `elementTreeToSvg`, same as the cull pass.
    annotateAnimatedProperties(tree, resolvedAnimations);
    // DM-603: viewBox-cull pass — mutates the tree (sets `displayNone` /
    // `cullClass` on elements that fall outside the viewBox during this
    // frame's segment of the scene cycle) and returns the keyframes CSS
    // mapping each window-derived `cull-<start>-<end>` class to its visible window. Must run BEFORE
    // `elementTreeToSvg` so the renderer sees the mutated tree.
    let frameStartMs = 0;
    for (let pi = 0; pi < i; pi++) {
      frameStartMs += frameAdvanceMs(cfg.frames[pi]);
    }
    const totalDurationMs = cfg.frames.reduce((sum, f) => sum + frameAdvanceMs(f), 0);
    const result = cullElementsOutsideViewBox(tree, cfg.width, cfg.height, resolvedAnimations, frameStartMs, totalDurationMs);
    frameCullCss = result.css;
    rootBg = tree[0]?.styles?.rootBgComputed;
    svgContent = elementTreeToSvgInner(tree, cfg.width, cfg.height, `f${i}-`, true, 2, false);
    frameTree = tree;
    // DM-1747 (docs/101): resolve this frame's declarative text tracks against
    // the captured tree — frame-relative `at` mapped to global time (the cursor
    // events' frame→global mapping) — and accumulate for the animator's
    // `AnimationConfig.textTracks`.
    if (fc.textTracks != null && fc.textTracks.length > 0) {
      for (let k = 0; k < fc.textTracks.length; k++) {
        ctx.textTracks.push(resolveTextTrack(tree, configTextTrackSpec(fc.textTracks[k], i, k, frameStartMs)));
      }
    }
  }

  // DM-850 §5: resolve selector-anchored overlays against the live page
  // (bbox → x/y, and maxWidth:"anchor" → the element's content width) BEFORE
  // the svg-inlining pass, while the page is still loaded.
  const anchoredOverlays = await resolveOverlayAnchors(page, fc.overlays, i);
  // Resolve SVG-kind overlays: read each `src` from disk, namespace its
  // ids, and replace with `innerSvg`. Other overlay kinds pass through
  // verbatim. (DM-210.)
  const overlays = resolveSvgOverlays(anchoredOverlays, configDir, i);

  const frame: AnimationFrame = {
    svgContent,
    cullCss: frameCullCss === "" ? undefined : frameCullCss,
    duration: fc.duration,
    transition: fc.transition,
    overlays,
    animations: resolvedAnimations.length > 0 ? resolvedAnimations : undefined,
    ...(embeddedAnimationPeriodMs != null ? { embeddedAnimationPeriodMs } : {}),
  };
  return { frame, frameTree, rootBg };
}

/**
 * DM-1747 (docs/100 Primitive 1): build a `states` frame's content. Runs each
 * state's actions against the live page, captures the tree, and composes the N
 * captured states via `composeCompressedRun` into one nested animated SVG:
 * content shared across states is emitted once; later states contribute only
 * their changes as `step-end` tracks (glyph births/deaths, uniform tail
 * shifts, recolors), snapping at every state boundary. Fonts are deferred to
 * the outer run's shared embedded-font builder (`manageFonts: false`, the
 * cast/typeResample pattern), and the run's document-global names are
 * namespaced per frame so nested runs can't collide. The compressor's pairing
 * log line (`compress: run of N states, X% glyphs paired, …`) surfaces through
 * the CLI logger.
 */
async function buildStatesRunContent(
  page: Page,
  fc: AnimateFrameCfg,
  i: number,
  cfg: AnimateConfig,
  log: (msg: string) => void,
): Promise<{ svgContent: string; periodMs: number; rootBg: string | undefined }> {
  const stateCfgs = fc.states!;
  log(`  states: capturing ${stateCfgs.length} editing state${stateCfgs.length === 1 ? "" : "s"} for the compressed run…`);
  const states: CompressedRunState[] = [];
  for (let j = 0; j < stateCfgs.length; j++) {
    const st = stateCfgs[j];
    // State 0 is the frame's own post-`actions` state; each state's own
    // actions (if any) run before its capture.
    if (st.actions != null && st.actions.length > 0) await runActions(page, st.actions, log);
    const tree = await captureElementTree(page, fc.selector ?? "body", {
      x: 0, y: 0, width: cfg.width, height: cfg.height,
    });
    cullElementsOutsideViewBox(tree, cfg.width, cfg.height, undefined, 0, 1);
    states.push({ tree, holdMs: st.duration });
  }
  const rootBg = states[0].tree[0]?.styles?.rootBgComputed;
  const run = composeCompressedRun(states, {
    width: cfg.width,
    height: cfg.height,
    idPrefix: `cr${i}`,
    ...(rootBg != null ? { background: rootBg } : {}),
    ...(fc.caret != null ? { caret: fc.caret } : {}),
    // Defer @font-face to the outer run's shared embedded-font builder (one
    // scene-wide block, collected after the loop) — the cast pattern.
    manageFonts: false,
    log: (m) => log(`  ${m}`),
  });
  // Namespace the run's document-global names (ids, classes, @keyframes) so
  // it can't collide with the outer animation or sibling nested frames — but
  // NOT font-family refs (they point at the shared builder's already-unique
  // dmfN names), same as a `cast` frame.
  const namespaced = namespaceEmbeddedAnimatedSvg(run.svg, `cr${i}_`, { namespaceFonts: false });
  return {
    svgContent: namespaced.replace(/^<\?xml[^>]*\?>\s*/, ""),
    periodMs: run.durationMs,
    rootBg,
  };
}

/**
 * DM-1747 (docs/101): map a config-level text track (frame-relative `at`
 * times, capture-stamped selectors) to the engine's `TextTrackSpec` (global
 * `t` times, `animId` targets). The animIds follow the stamping convention in
 * `buildCapturedFrame`: `f{frame}tt{track}` for the track target,
 * `f{frame}tt{track}e{event}` for a per-event selector override. Pure —
 * exported for unit tests.
 */
export function configTextTrackSpec(tt: TextTrackInput, frameIdx: number, trackIdx: number, frameStartMs: number): TextTrackSpec {
  const events: TextTrackSpecEvent[] = tt.events.map((ev, j) => {
    const t = frameStartMs + ev.at;
    const override = "selector" in ev && ev.selector != null
      ? { target: { animId: `f${frameIdx}tt${trackIdx}e${j}` } }
      : {};
    switch (ev.type) {
      case "park":
      case "move":
        return { type: ev.type, t, charOffset: ev.charOffset, ...override };
      case "select":
        return {
          type: "select", t, charStart: ev.charStart, charEnd: ev.charEnd,
          ...(ev.sweepMs != null ? { sweepMs: ev.sweepMs } : {}),
          ...(ev.color != null ? { color: ev.color } : {}),
          ...override,
        };
      case "hide":
        return { type: "hide", t };
      case "clearSelection":
        return { type: "clearSelection", t };
    }
  });
  return {
    target: { animId: `f${frameIdx}tt${trackIdx}` },
    ...(tt.shape != null ? { shape: tt.shape } : {}),
    ...(tt.color != null ? { color: tt.color } : {}),
    ...(tt.barWidthPx != null ? { barWidthPx: tt.barWidthPx } : {}),
    ...(tt.blinkMs != null ? { blinkMs: tt.blinkMs } : {}),
    ...(tt.selectionColor != null ? { selectionColor: tt.selectionColor } : {}),
    events,
  };
}

export async function composeAnimateFrames(
  browser: Browser,
  cfg: AnimateConfig,
  configDirOrOpts?: string | ComposeAnimateOptions,
  logArg?: (msg: string) => void,
): Promise<AnimationConfig> {
  const { configDir, log, onFrame, brand, safeInset } = normalizeComposeArgs(configDirOrOpts, logArg);
  // DM-852: resolve `${vars}` across every string field before anything runs.
  cfg = interpolateConfigVars(cfg);
  // DM-1562: expand `hoverReveal` sugar (pure) into rest + forced-hover frames.
  cfg = expandHoverReveal(cfg, log);
  // DM-1563: `hoverDetect` — probe each such frame's page for its hover response
  // and synthesize the transition. A browser pre-pass (its own throwaway context)
  // that rewrites the frame(s) before the main capture loop runs.
  cfg = await expandHoverDetect(cfg, browser, configDir, log);
  // DM-1544: an explicit `--brand` (passed in `opts.brand`) wins over the config's
  // own `brand` key; when the flag is absent, fall back to the config-inline brand
  // (a path relative to `configDir`, or a validated inline object). One brand then
  // themes captured frames (CSS-var injection below) AND template frames (their
  // brand defaults, wired through `renderTemplateFrames`).
  const runBrand = brand ?? resolveConfigBrand(cfg.brand, configDir);
  // DM-1287 (doc 73): render `template` frames UP FRONT, before the outer run's
  // font lifecycle (clearWebfonts / clearEmbeddedFonts) starts below. A template
  // is itself a front-end onto `composeAnimateConfig`, so rendering one runs a
  // NESTED `composeAnimateFrames` that clears + manages the module-global font
  // builders. Doing it here — before the outer clears — keeps each template's
  // output fully self-contained (its own `@font-face`) and stops the nested run
  // from clobbering the outer frames' embedded fonts. Each rendered template SVG
  // is a finished string by the time the outer loop reaches its frame.
  const templateRenders = await renderTemplateFrames(cfg, browser, log, safeInset, runBrand);
  const ctx = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    isMobile: cfg.mobile === true,
    ...(cfg.mobile === true ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
    ...(cfg.colorScheme != null ? { colorScheme: cfg.colorScheme } : {}),
  });
  // DM-1540 (docs/92): inject the brand's CSS custom properties onto every
  // captured frame's `:root` before it paints. On the context, so it applies to
  // each frame's navigation. Template/cast frames render before this loop and
  // carry their own theming (template frames via their brand defaults, DM-1543).
  // `runBrand` is `--brand` or the config's `brand` key (DM-1544).
  if (runBrand != null) await injectBrandVariables(ctx, runBrand);
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

    // DM-1747 (docs/101): resolved caret/selection tracks accumulated across
    // captured frames, threaded into the animator's `textTracks`.
    const textTracks: ResolvedTextTrack[] = [];

    // DM-1379: the per-frame loop state `buildCapturedFrame` reads/appends to.
    const capturedCtx: CapturedFrameContext = {
      page, cfg, configDir, log, tracker,
      cursorAuto, explicitCursorEvents, autoCursorTargets, explicitCursorBoxes,
      textTracks,
    };

    for (let i = 0; i < cfg.frames.length; i++) {
      const fc = cfg.frames[i];
      // DM-1225 (doc 67): a `cast` frame embeds a recorded terminal session as
      // this frame's content — a self-contained animated terminal SVG nested
      // like a `scroll` block. It bypasses the page-load/capture path entirely.
      if (fc.cast != null) {
        frames.push(await buildCastFrame(fc, i, cfg, configDir, browser, log));
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
        frames.push(buildTemplateFrame(fc, i, cfg, configDir, templateRenders, log));
        prevFrameTree = null;
        frameTrees.push(null);
        continue;
      }
      // DM-1379: the captured/default frame body (continue-vs-load →
      // readyWaits → webfont discovery → scrollTo → cursor recording → actions
      // → intra-frame animations → scroll-block-vs-capture → overlays) lives in
      // `buildCapturedFrame`. It appends to the shared cursor accumulators via
      // `capturedCtx`; we keep the cross-frame after-build orchestration here.
      const { frame, frameTree, rootBg } = await buildCapturedFrame(fc, i, capturedCtx);
      if (i === 0) canvasBg = rootBg;
      frames.push(frame);

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
    return {
      width: cfg.width, height: cfg.height, frames, fontFaceCss, cursorOverlay, resolveCursorAt, background: canvasBg,
      // DM-1747 (docs/101): declarative caret/selection tracks resolved during
      // capture. Omitted when none are declared (byte-identical output).
      ...(textTracks.length > 0 ? { textTracks } : {}),
    };
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
 * DM-1516 (docs/94): force each `{ selector, states }` entry into its CSS
 * pseudo-classes via the Chrome DevTools Protocol (`CSS.forcePseudoState`), so a
 * subsequent capture paints the page's REAL `:hover` / `:active` / `:focus`
 * styling. Unlike a synthetic overlay this triggers the page's own rules
 * (including cascade siblings like `.card:has(.cta:hover)`) with no authoring —
 * it's the state the browser itself enters on pointer/keyboard interaction.
 * Applied to EVERY element the selector matches (CDP `DOM.querySelectorAll`),
 * matching `runActions`' "apply across all matched" semantics; throws if a
 * selector matches nothing. `log` defaults to a no-op. A no-op on an empty /
 * absent list, so callers can pass through unconditionally.
 *
 * IMPORTANT — the CDP session is intentionally left ATTACHED and REUSED per page
 * (`getForcedStateSession`). A `CSS.forcePseudoState` override lives for the
 * lifetime of the session that set it: detaching (or disabling the CSS domain)
 * immediately clears the override, so the forced paint would vanish before the
 * capture that's supposed to record it. Leaving the session open lets the forced
 * state survive into the very next `captureElementTree`; it's reclaimed when the
 * page / context closes. The forced state therefore persists on the live page
 * until navigation, carrying into a `continue` frame like any other pre-capture
 * mutation.
 *
 * DM-1566: pass `{ selector, reset: true }` to DROP a state a previous frame
 * forced (the un-hover verb) — it re-issues an empty forced-class list on the
 * SAME cached session, so a continue-frame flow can force `:hover`, capture, then
 * release it and capture the return-to-rest. (A fresh session couldn't clear
 * another session's override, which is why the session is cached per page.)
 *
 * Re-exported from the package root so imperative capture callers can force the
 * same states before their own `captureElementTree`, not just the declarative
 * `animate` config (the doc-63 "expose the per-feature primitive" pattern).
 */
export async function applyForcedPseudoStates(
  page: Page,
  forceState: ForceState[] | undefined,
  log: (msg: string) => void = () => {},
): Promise<void> {
  if (forceState == null || forceState.length === 0) return;
  const entry = await getForcedStateSession(page);
  // DM-1566: resolve the document root ONCE per document and reuse it for every
  // `querySelectorAll`. This is load-bearing for `reset`: calling `DOM.getDocument`
  // again re-issues node ids in a FRESH id space, and a `CSS.forcePseudoState([])`
  // on a new-space id does NOT clear an override set on the old-space id (even for
  // the same element — verified against Chromium). Querying under one cached root
  // keeps all ids in one space, so a later re-query returns the same id the force
  // was set on, and the clear lands. The root is invalidated on navigation (a
  // reload frame gets a new document, which clears forced overrides anyway).
  if (entry.rootNodeId == null) {
    // `depth: -1` returns the full node tree so `querySelectorAll` can resolve
    // selectors anywhere in the document (not just the shallow default depth).
    const { root } = await entry.session.send("DOM.getDocument", { depth: -1 });
    entry.rootNodeId = root.nodeId;
  }
  for (const fs of forceState) {
    const { nodeIds } = await entry.session.send("DOM.querySelectorAll", { nodeId: entry.rootNodeId, selector: fs.selector });
    if (nodeIds.length === 0) {
      throw new Error(`animate: forceState selector "${fs.selector}" matched no element`);
    }
    // `reset: true` clears the override by re-issuing an EMPTY forced-class list.
    const forcedPseudoClasses = fs.reset === true ? [] : fs.states ?? [];
    for (const nodeId of nodeIds) {
      await entry.session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses });
    }
    const label = fs.reset === true
      ? `cleared forced state on`
      : `forced ${forcedPseudoClasses.map((s) => `:${s}`).join("")} on`;
    log(`  ${label} "${fs.selector}" (${nodeIds.length} element${nodeIds.length === 1 ? "" : "s"})`);
  }
}

/**
 * DM-1516 / DM-1566: the per-page CDP session that carries forced-pseudo-state
 * overrides. It's cached (and never detached) for two reasons:
 *   1. A `CSS.forcePseudoState` override lives for the lifetime of the session
 *      that set it — detaching (or disabling the CSS domain) clears it instantly,
 *      so it must outlive the capture that records the forced paint (DM-1516).
 *   2. Clearing a forced state (`reset`) only works from the SAME session that set
 *      it, so a continue-frame flow that forces `:hover` on one frame then resets
 *      it on a later frame must reuse one session across both calls (DM-1566).
 * The session is reclaimed when the page / context closes. Keyed weakly by page so
 * it can't leak across runs.
 */
interface ForcedStateSession {
  session: CDPSession;
  /** Cached `DOM.getDocument` root id, kept stable so `reset` clears the id it set
   *  (see `applyForcedPseudoStates`). Nulled on main-frame navigation. */
  rootNodeId: number | null;
}
const forcedStateSessions = new WeakMap<Page, ForcedStateSession>();
async function getForcedStateSession(page: Page): Promise<ForcedStateSession> {
  let entry = forcedStateSessions.get(page);
  if (entry == null) {
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const created: ForcedStateSession = { session, rootNodeId: null };
    forcedStateSessions.set(page, created);
    // A reload frame navigates the SAME page object; its new document invalidates
    // the cached root id (and clears any forced overrides). Re-fetch on next use.
    if (typeof (page as { on?: unknown }).on === "function") {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) created.rootNodeId = null;
      });
    }
    entry = created;
  }
  return entry;
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
 * DM-1562 (docs/94 Option 1): expand each frame's `hoverReveal` sugar into two
 * concrete frames — the frame at REST, then a `continue` frame that forces the
 * hover state — with a crossfade between them and a cursor move onto the element.
 * A pure config → config transform (no browser); runs before the capture loop so
 * the rest of the pipeline sees ordinary `forceState` + cursor frames. The
 * original frame's own `transition` (if any) carries out of the reveal pair;
 * existing explicit `cursor.events` frame indices are remapped to the post-
 * expansion numbering. A config with no `hoverReveal` is returned untouched.
 */
export function expandHoverReveal(cfg: AnimateConfig, log: (msg: string) => void = () => {}): AnimateConfig {
  if (!cfg.frames.some((f) => f.hoverReveal != null)) return cfg;
  const newFrames: AnimateFrameCfg[] = [];
  // Old frame index → the new index of its (rest) frame, for remapping cursor events.
  const restIndexForOld: number[] = [];
  const injectedCursorEvents: CursorEventInput[] = [];
  cfg.frames.forEach((f, oldIdx) => {
    restIndexForOld[oldIdx] = newFrames.length;
    const hr = f.hoverReveal;
    if (hr == null) { newFrames.push(f); return; }
    const origTransition = f.transition;
    const crossfadeMs = hr.crossfadeMs ?? 400;
    // Rest frame: the original frame minus the sugar, cross-fading INTO the reveal.
    const restFrame: AnimateFrameCfg = { ...f, transition: { type: "crossfade", duration: crossfadeMs } };
    delete (restFrame as { hoverReveal?: unknown }).hoverReveal;
    const hoverIdx = newFrames.length + 1;
    // Reveal frame: continue the live page, force the state, and carry the
    // ORIGINAL frame's transition (the transition OUT of the pair) if any.
    const hoverFrame: AnimateFrameCfg = {
      continue: true,
      duration: hr.hoverMs ?? f.duration,
      forceState: [{ selector: hr.selector, states: hr.states ?? ["hover"] }],
      ...(origTransition != null ? { transition: origTransition } : {}),
    };
    newFrames.push(restFrame, hoverFrame);
    if (hr.cursor !== false) {
      // DM-1586: glide the cursor onto the element DURING the rest frame so it's
      // settled on the target when the hover crossfade begins. Injecting the move
      // on the hover frame (at 0) instead makes the pointer depart the same instant
      // the paint starts, so the element reaches full hover before the cursor lands.
      // Arrive at the rest frame's end (= the hover frame's start).
      const restIdx = hoverIdx - 1;
      injectedCursorEvents.push({
        frame: restIdx,
        at: Math.max(0, (restFrame.duration ?? 0) - CURSOR_MOVE_DUR_MS),
        type: "move",
        selector: hr.selector,
      });
    }
  });
  const cursor = mergeInjectedCursorEvents(cfg.cursor, restIndexForOld, injectedCursorEvents, log, "hoverReveal");
  return { ...cfg, frames: newFrames, ...(cursor !== undefined ? { cursor } : {}) };
}

/**
 * Merge sugar-injected cursor moves (from `hoverReveal` / `hoverDetect`) into the
 * config's cursor, remapping any existing explicit `cursor.events` frame indices
 * through `restIndexForOld` (the frame numbering shifted when sugar frames
 * expanded). `"auto"` can't carry explicit events, so injected moves are dropped
 * with a warning (a hover cursor still can't derive from a forced state, which has
 * no action for `"auto"` to key off). Returns the (possibly rebuilt) cursor.
 */
function mergeInjectedCursorEvents(
  cursor: AnimateConfig["cursor"],
  restIndexForOld: number[],
  injected: CursorEventInput[],
  log: (msg: string) => void,
  sugar: string,
): AnimateConfig["cursor"] {
  const remap = (c: { style?: CursorStyleInput; events: CursorEventInput[] }): { style?: CursorStyleInput; events: CursorEventInput[] } => ({
    ...c,
    events: c.events.map((e) => ({ ...e, frame: restIndexForOld[e.frame] ?? e.frame })),
  });
  if (injected.length === 0) {
    return cursor != null && cursor !== "auto" ? remap(cursor) : cursor;
  }
  if (cursor === "auto") {
    log(`  note: ${sugar} can't inject a cursor move under cursor:"auto" (auto derives the pointer from actions, and a forced state has none) — set an explicit cursor or "cursor": false on the ${sugar} to silence this`);
    return cursor;
  }
  if (cursor == null) return { events: injected };
  const remapped = remap(cursor);
  return { ...remapped, events: [...remapped.events, ...injected] };
}

/**
 * DM-1563 (docs/94 Option 2): the browser pre-pass behind `hoverDetect`. For each
 * frame carrying the sugar it opens a THROWAWAY context, loads the frame's
 * `input`, snapshots the target subtree's computed style at rest, forces the
 * hover state, snapshots again, and diffs. From the diff it rewrites the frame:
 *   - `none`   — no detectable change: keep the frame as-is (rest only), log why;
 *   - `motion` — a clean transform/opacity change on the target: keep ONE frame
 *                and add an intra-frame keyframe TWEEN so it animates in place;
 *   - `paint`  — anything else: expand to a rest + forced-hover crossfade pair
 *                (like `hoverReveal`), which blends the color/shadow/border deltas.
 * A cursor move onto the element is injected (unless `cursor:false`). Returns the
 * rewritten config; a config with no `hoverDetect` is returned untouched without
 * launching anything.
 */
async function expandHoverDetect(
  cfg: AnimateConfig,
  browser: Browser,
  configDir: string,
  log: (msg: string) => void,
): Promise<AnimateConfig> {
  if (!cfg.frames.some((f) => f.hoverDetect != null)) return cfg;
  const newFrames: AnimateFrameCfg[] = [];
  const restIndexForOld: number[] = [];
  const injectedCursorEvents: CursorEventInput[] = [];
  for (let oldIdx = 0; oldIdx < cfg.frames.length; oldIdx++) {
    const f = cfg.frames[oldIdx];
    restIndexForOld[oldIdx] = newFrames.length;
    const hd = f.hoverDetect;
    if (hd == null) { newFrames.push(f); continue; }
    const states = hd.states ?? ["hover"];
    const transitionMs = hd.transitionMs ?? 400;

    // Probe the page in a throwaway context: load → snapshot rest → force → snapshot.
    const ctx = await browser.newContext({
      viewport: { width: cfg.width, height: cfg.height },
      isMobile: cfg.mobile === true,
      ...(cfg.mobile === true ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } : {}),
      ...(cfg.colorScheme != null ? { colorScheme: cfg.colorScheme } : {}),
    });
    let diff: HoverDiff;
    try {
      const page = await ctx.newPage();
      const input = resolveFrameInput(f.input!, configDir);
      log(`Frame ${oldIdx + 1}/${cfg.frames.length}: hoverDetect probing "${hd.selector}" (${input})…`);
      await loadInputIntoPage(page, input);
      await applyReadyWaits(page, {
        wait: f.wait ?? 200, waitFor: f.waitFor, fontsReady: true, frameIndex: oldIdx,
        waitForText: f.waitForText, waitForGone: f.waitForGone, waitForCount: f.waitForCount,
      });
      const rest = await captureStyleSnapshot(page, hd.selector, HOVER_DIFF_PROPERTIES);
      await applyForcedPseudoStates(page, [{ selector: hd.selector, states }], () => {});
      const hover = await captureStyleSnapshot(page, hd.selector, HOVER_DIFF_PROPERTIES);
      diff = diffHoverSnapshots(rest, hover);
    } finally {
      await ctx.close();
    }
    const mode = classifyHoverTransition(diff);

    if (mode === "none") {
      log(`  hoverDetect: no hover-state change detected on "${hd.selector}" — keeping the frame as rest-only (check the selector, or that the page defines a :${states.join("/:")} rule)`);
      const plain: AnimateFrameCfg = { ...f };
      delete (plain as { hoverDetect?: unknown }).hoverDetect;
      newFrames.push(plain);
      continue;
    }

    const frameIdx = newFrames.length;
    if (hd.cursor !== false) {
      // DM-1586: land the cursor on the target BEFORE the hover reveal fires.
      // Motion mode is a single frame — glide the cursor in from the start and
      // DELAY the tween by the glide (below) so it reacts after the pointer lands.
      // Paint mode has a rest frame (frameIdx) then a reveal frame — glide the
      // cursor during the rest frame so it arrives as the crossfade begins.
      const cursorAt = mode === "motion" ? 0 : Math.max(0, f.duration - CURSOR_MOVE_DUR_MS);
      injectedCursorEvents.push({ frame: frameIdx, at: cursorAt, type: "move", selector: hd.selector });
    }

    if (mode === "motion") {
      // DM-1586: hold the tween until the cursor has glided in (when a cursor was injected).
      const tweenDelay = hd.cursor !== false ? CURSOR_MOVE_DUR_MS : 0;
      const anims = synthesizeMotionAnimations(diff, hd.selector, transitionMs, tweenDelay);
      const frame: AnimateFrameCfg = { ...f, animations: [...(f.animations ?? []), ...anims] };
      delete (frame as { hoverDetect?: unknown }).hoverDetect;
      newFrames.push(frame);
      log(`  hoverDetect: motion-only hover on "${hd.selector}" → intra-frame ${anims.map((a) => a.property).join("+")} tween`);
    } else {
      // paint: rest + forced-hover crossfade pair (like hoverReveal).
      const origTransition = f.transition;
      const restFrame: AnimateFrameCfg = { ...f, transition: { type: "crossfade", duration: transitionMs } };
      delete (restFrame as { hoverDetect?: unknown }).hoverDetect;
      const hoverFrame: AnimateFrameCfg = {
        continue: true,
        duration: hd.hoverMs ?? f.duration,
        forceState: [{ selector: hd.selector, states }],
        ...(origTransition != null ? { transition: origTransition } : {}),
      };
      newFrames.push(restFrame, hoverFrame);
      const props = [...new Set(diff.paint.map((d) => d.property))].join(", ");
      log(`  hoverDetect: paint hover on "${hd.selector}" (${props}) → rest→hover crossfade`);
    }
  }
  const cursor = mergeInjectedCursorEvents(cfg.cursor, restIndexForOld, injectedCursorEvents, log, "hoverDetect");
  return { ...cfg, frames: newFrames, ...(cursor !== undefined ? { cursor } : {}) };
}

/**
 * DM-1563: build the intra-frame animation(s) for a MOTION-mode hover — a single
 * fused tween of the target's transform (and/or opacity) from its rest baseline
 * to the hover value, so the element animates in place. `transform` is the
 * primary track (center transform-origin — the common hover-scale case) with
 * `opacity` fused in; an opacity-only change becomes a plain opacity tween. The
 * caller has already guaranteed clean baselines via `classifyHoverTransition`.
 */
function synthesizeMotionAnimations(diff: HoverDiff, selector: string, durationMs: number, delayMs = 0): Anims {
  // DM-1582: the transform-primary-with-fused-opacity / opacity-only synthesis is
  // the shared `synthesizeMotionTween` (also used by jsReveal, DM-1580); this just
  // attaches the config-form `selector` key. `delayMs` (DM-1586) holds the tween
  // until an injected cursor lands on the target.
  return synthesizeMotionTween(diff, durationMs, delayMs).map((track) => ({ selector, ...track }));
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

/** Resolve a selector's BORDER-box aim point in page (viewport) coords, or null
 *  if absent. DM-1139: collapsed onto the shared `borderBox` primitive (doc 63)
 *  so the CLI cursor and the public `resolveCursorTarget` can't diverge.
 *  DM-1742: `at` picks one of the nine named anchor points (default center) and
 *  `offset` nudges from there — the auto-cursor aim vocabulary. `borderBox`
 *  throws on no-match; the `"auto"` recording path tolerates a missing selector
 *  (the action itself fails later, the cursor recording just skips it), so we map
 *  that throw back to null here. */
async function queryCursorBox(
  page: Page,
  sel: string,
  at: BoxAnchor = "center",
  offset?: { dx?: number; dy?: number },
): Promise<{ cx: number; cy: number } | null> {
  try {
    const [cx, cy] = (await borderBox(page, sel, { at, dx: offset?.dx ?? 0, dy: offset?.dy ?? 0 })).at;
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
// Auto-cursor timing. Each interaction glides the pointer to its target over
// CURSOR_MOVE_DUR_MS, then a short beat (CURSOR_CLICK_TAIL_FRAC of the frame's
// hold, capped at CURSOR_CLICK_TAIL_MAX_MS) elapses before the transition so the
// click reads as cause-then-effect rather than landing on the cut.
const CURSOR_MOVE_DUR_MS = 400;
const CURSOR_CLICK_TAIL_MAX_MS = 250;
const CURSOR_CLICK_TAIL_FRAC = 0.25;

export function buildCursorOverlay(
  auto: boolean,
  explicitEvents: CursorEventInput[],
  styleCfg: CursorStyleInput | undefined,
  autoTargets: Array<{ frame: number; cx: number; cy: number }>,
  explicitBoxes: Map<string, { cx: number; cy: number }>,
  frameStarts: number[],
  frames: AnimateConfig["frames"],
): CursorOverlay | undefined {
  const moveDur = CURSOR_MOVE_DUR_MS;
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
      const tail = Math.min(CURSOR_CLICK_TAIL_MAX_MS, frames[stage].duration * CURSOR_CLICK_TAIL_FRAC);
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
  frameKind: string,
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
  // Strip XML decl + outer <svg ...> wrapper, then namespace ids/refs via the
  // shared prefixer (DM-1588 — same regexes back the native SVG-image inliner).
  let inner = svg;
  inner = inner.replace(/<\?xml[^>]*\?>/, "");
  inner = inner.replace(/<svg\b[^>]*>/, "");
  inner = inner.replace(/<\/svg>\s*$/, "");
  inner = prefixSvgIds(inner, prefix);
  // DM-1595: also namespace CSS class names when the overlay SVG carries a
  // `<style>` block, so two svg overlays that both define e.g. `.cls-1` can't
  // cross-contaminate. Gated on `<style>` presence → no-op (byte-identical) for
  // the common presentation-attribute overlay.
  if (/<style[\s>]/i.test(inner)) inner = prefixSvgClasses(inner, prefix);
  return inner;
}

function resolveFrameInput(input: string, configDir: string): string {
  if (input === "-") return input;
  if (/^https?:\/\//i.test(input)) return input;
  return resolve(configDir, input);
}
