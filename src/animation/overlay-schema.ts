/**
 * Single source of truth for the animation overlay + intra-frame-animation
 * shapes (DM-1131).
 *
 * These zod schemas define the *resolved* (runtime) overlay shapes that
 * `generateAnimatedSvg` consumes — concrete `x` / `y` / `bgWidth`, no
 * selector `anchor`. The TypeScript types the public API exports
 * (`TypingOverlay`, `AnimationOverlay`, …) are derived from them via
 * `z.infer`, so there is exactly ONE definition of each shape.
 *
 * The declarative-config layer (`src/cli/animate.ts`) builds its *authoring*
 * overlay schemas by EXTENDING these base schemas (adding `anchor` /
 * `maxWidth`, relaxing `x` / `y` to defaulted), so the two views can no longer
 * drift: rename a field here and both the renderer types and the config
 * validator (plus its generated JSON Schema) move together, or fail to
 * compile. Before this split the renderer hand-wrote the interfaces and the
 * CLI hand-wrote a parallel zod schema — a rename on one side was invisible to
 * the other (the `Overlay` → `AnimationOverlay` regression that motivated this).
 *
 * Field docs live here as comments; the consumer-facing contract is
 * `docs/api.md` + `docs/08-animation-model.md` / `docs/43-declarative-animate-
 * config.md`. Keep this file's field set in lockstep with those docs.
 */

import { z } from "zod";

/**
 * Slide-in / slide-out descriptor shared by SVG overlays (`enter` / `exit`)
 * — DM-211. Sugar over an intra-frame animation.
 */
export const overlaySlideSchema = z.object({
  from: z.enum(["top", "bottom", "left", "right"]),
  duration: z.number(),
  easing: z.string().optional(),
  delay: z.number().optional(),
});
export type OverlaySlide = z.infer<typeof overlaySlideSchema>;

/**
 * A typed-text reveal layered onto a captured frame. `bgWidth` both wraps the
 * text (browser-textarea style, DM-840) AND sizes the placeholder mask; see
 * DM-1134 for the wrap-vs-mask reconciliation follow-up.
 */
export const typingOverlaySchema = z.object({
  kind: z.literal("typing"),
  text: z.string(),
  /** Top-left of the typed text in the captured frame's coordinate space. */
  x: z.number(),
  y: z.number(),
  fontSize: z.number().optional(),
  color: z.string().optional(),
  /** Delay from frame start before typing begins (ms). */
  delay: z.number().optional(),
  /** Speed per character (ms). */
  speed: z.number().optional(),
  /** Background color to mask placeholder text. */
  bgColor: z.string().optional(),
  /**
   * Field width in px. When set, the typed text WRAPS to this width like a
   * browser textarea — breaking on spaces (char-breaking over-long words),
   * advancing one line-height per wrapped line — instead of running off the
   * right edge on a single line (DM-840). Omit for unbounded single-line text.
   */
  bgWidth: z.number().optional(),
  /**
   * Field height in px (used to size the placeholder mask). The mask grows
   * beyond this if the wrapped text needs more lines, so the typed text always
   * sits on a clean background.
   */
  bgHeight: z.number().optional(),
  /**
   * DM-870: render a blinking insertion caret. The bar sweeps the type
   * position while typing, then parks at the end of the text and blinks
   * (opacity 1↔0) until the frame ends. `true` uses defaults (the typing
   * `color`, 2px wide, ~530ms cadence); an object overrides them.
   */
  caret: z
    .union([z.boolean(), z.object({ color: z.string().optional(), width: z.number().optional(), blinkMs: z.number().optional() })])
    .optional(),
});
export type TypingOverlay = z.infer<typeof typingOverlaySchema>;

/** A tap-ripple at `(x, y)`, frame-relative. */
export const tapOverlaySchema = z.object({
  kind: z.literal("tap"),
  x: z.number(),
  y: z.number(),
  /** Delay from frame start (ms). */
  delay: z.number().optional(),
});
export type TapOverlay = z.infer<typeof tapOverlaySchema>;

/**
 * Frame-local SVG overlay: composites a separately-captured SVG (inlined as
 * markup, not referenced as `<image href>`) on top of the captured frame.
 * Used for picture-in-picture effects like sliding a phone-framed preview
 * into the corner of a terminal demo.
 *
 * The overlay is positioned at (x, y), clipped to (width, height), and gets
 * its own `class="ov-<animId>"` wrapper so intra-frame animations (or
 * `enter`/`exit` sugar) can target it without colliding with elements inside
 * the embedded SVG.
 *
 * Note: this is the RESOLVED shape — the declarative config takes a `src` file
 * path and the CLI reads / namespaces it into `innerSvg` + `animId`.
 */
export const svgOverlaySchema = z.object({
  kind: z.literal("svg"),
  /**
   * The SVG content to inline. The CLI resolves `src` paths from the config
   * file's directory and namespaces the embedded SVG's ids before setting it.
   */
  innerSvg: z.string(),
  /** Top-left corner in the captured frame's coordinate space. */
  x: z.number(),
  y: z.number(),
  /** Render size — the embedded SVG's viewBox is preserved and scales to fit. */
  width: z.number(),
  height: z.number(),
  /** Stable id keying the overlay's wrapper class (`ov-<animId>`). */
  animId: z.string(),
  /** Slide-in entrance (DM-211). Sugar over `animations`. */
  enter: overlaySlideSchema.optional(),
  /** Slide-out exit (DM-211). */
  exit: overlaySlideSchema.optional(),
});
export type SvgOverlay = z.infer<typeof svgOverlaySchema>;

/**
 * DM-871: a standalone blinking bar/box, for carets/dots not tied to a typing
 * overlay — a recording dot, an attention pulse on a focused field, a cursor.
 * Renders a rect that toggles opacity on a `periodMs` cycle for the frame's
 * hold (sugar over a rect + a repeating opacity animation).
 */
export const blinkOverlaySchema = z.object({
  kind: z.literal("blink"),
  /** Top-left corner in the captured frame's coordinate space. */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** Full on/off cycle in ms (default 1000). */
  periodMs: z.number().optional(),
  /** Fill color (default a light gray). */
  color: z.string().optional(),
  /** Corner radius — set to half the width/height for a dot. */
  radius: z.number().optional(),
  /** Ms after the frame becomes visible before blinking starts. Default 0. */
  delay: z.number().optional(),
});
export type BlinkOverlay = z.infer<typeof blinkOverlaySchema>;

/** The resolved overlay union `generateAnimatedSvg` consumes per frame. */
export const animationOverlaySchema = z.discriminatedUnion("kind", [
  typingOverlaySchema,
  tapOverlaySchema,
  svgOverlaySchema,
  blinkOverlaySchema,
]);
export type AnimationOverlay = z.infer<typeof animationOverlaySchema>;

/**
 * Animate a CSS property on captured elements that match a selector, while the
 * frame is held on screen. The selector is resolved against the source DOM at
 * capture time (see DM-209) and the matching elements get `class="anim-<id>"`
 * on their rendered SVG groups.
 *
 * Resolution requires the consumer (CLI / `DemoRecorder`) to set
 * `data-domotion-anim="<id>"` on matching DOM elements before capture; the
 * `id` referenced here must be the same id set on the DOM.
 */
export const intraFrameAnimationSchema = z.object({
  /** Anim id — must match the `data-domotion-anim` value set on the DOM pre-capture. */
  animId: z.string(),
  /**
   * CSS property to animate. `clipPath` takes raw CSS `clip-path` values
   * (e.g. `"inset(0 100% 0 0)"` -> `"inset(0 0 0 0)"`) and is the right choice
   * for left-to-right reveals like typing-into-captured-text. When the
   * captured element is wrapped in a `<g class="anim-<id>">`, the keyframes
   * apply `clip-path` to that wrapper.
   */
  property: z.enum(["width", "height", "opacity", "transform", "translateX", "translateY", "clipPath"]),
  /** Start value (CSS string, e.g. `"0%"`, `"240px"`, `"0.3"`). */
  from: z.string(),
  /** End value (same syntax as `from`). */
  to: z.string(),
  /** Duration in ms. Must be ≤ the parent frame's `duration`. */
  duration: z.number(),
  /** CSS easing string. Default `linear`. */
  easing: z.string().optional(),
  /** Ms after the frame becomes visible before animation starts. Default 0. */
  delay: z.number().optional(),
  /**
   * DM-869: repeat count. A positive integer or `"infinite"`. When set, the
   * animation loops on its own `duration` clock (CSS `animation-iteration-
   * count`) rather than playing once — turning a property animation into a
   * blink / pulse / breathe. The loop is only visible while the frame is on
   * screen. `"infinite"` is the robust choice for a looping scene; a finite
   * count aligns to the frame's first appearance.
   */
  repeat: z.union([z.number(), z.literal("infinite")]).optional(),
  /** DM-869: when true, the loop ping-pongs `from`→`to`→`from` (CSS `animation-direction: alternate`). */
  alternate: z.boolean().optional(),
});
export type IntraFrameAnimation = z.infer<typeof intraFrameAnimationSchema>;
