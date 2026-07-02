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
 * The placeholder cover painted behind a typing overlay's text, sized
 * independently of the wrap width (DM-1134). All three fields are optional:
 * `width` defaults to the wrap width (then to the longest typed line),
 * `height` grows to fit the wrapped lines, and the mask only paints when a
 * `color` is resolvable.
 */
export const typingMaskSchema = z.object({
  /** Mask width in px. Defaults to `wrapWidth` (then the longest typed line). */
  width: z.number().optional(),
  /** Mask height in px. Grows beyond this if the wrapped text needs more lines. */
  height: z.number().optional(),
  /** Mask fill color. The mask only paints when this resolves (here or legacy `bgColor`). */
  color: z.string().optional(),
});
export type TypingMask = z.infer<typeof typingMaskSchema>;

/**
 * A typed-text reveal layered onto a captured frame.
 *
 * DM-1134: wrapping and the placeholder mask are now separate knobs —
 * `wrapWidth` controls where the text line-breaks (browser-textarea style,
 * DM-840) and `mask: { width, height, color }` controls the cover. The legacy
 * `bgWidth` / `bgHeight` / `bgColor` fields still work (deprecated aliases):
 * `bgWidth` feeds both `wrapWidth` and `mask.width`, `bgHeight` → `mask.height`,
 * `bgColor` → `mask.color`. Prefer the new fields in new code.
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
  /**
   * DM-1518: how the text enters the field.
   *   - `"type"` (default) — character-by-character, one glyph revealed per
   *     keystroke with the caret glued to the growing text edge.
   *   - `"paste"` — the whole string appears at once after `delay` (a clipboard
   *     paste), the caret jumping straight to the end. `speed` / `jitter` are
   *     ignored in paste mode.
   */
  mode: z.enum(["type", "paste"]).optional(),
  /**
   * DM-1518: humanize the per-character cadence. A fraction in `[0, 1]`: each
   * keystroke's delay is `speed × (1 ± jitter)` drawn from a DETERMINISTIC
   * seeded PRNG (seeded off the text), so the output SVG is byte-stable across
   * runs while the typing no longer marches at a robotic fixed interval. `0`
   * (default) keeps the even cadence. Ignored in `mode: "paste"`.
   */
  jitter: z.number().min(0).max(1).optional(),
  /**
   * DM-1134: wrap width in px. When set, the typed text WRAPS to this width like
   * a browser textarea — breaking on spaces (char-breaking over-long words),
   * advancing one line-height per wrapped line — instead of running off the
   * right edge on a single line (DM-840). Omit for unbounded single-line text.
   * (The CLI's `maxWidth: "anchor"` resolves into this.)
   */
  wrapWidth: z.number().optional(),
  /** DM-1134: the placeholder cover behind the text, sized independently of the wrap. */
  mask: typingMaskSchema.optional(),
  /** @deprecated DM-1134 — use `mask.color`. Background color to mask placeholder text. */
  bgColor: z.string().optional(),
  /**
   * @deprecated DM-1134 — use `wrapWidth` (and `mask.width` for the cover).
   * Field width in px: feeds both the wrap width and the mask width.
   */
  bgWidth: z.number().optional(),
  /** @deprecated DM-1134 — use `mask.height`. Field height in px (sizes the placeholder mask). */
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

/**
 * DM-1542: a "shine / shimmer" sweep over a box — the classic moving-highlight
 * glint (the `shine` motion preset). A diagonal linear-gradient band travels
 * across the box, clipped to it, driven ONLY by `transform: translateX` on a
 * gradient-filled rect (no animated CSS `filter`, so it composites consistently
 * on Blink + WebKit — docs/84). Backed by the shared `buildShineSweep` helper,
 * which also powers the `shine` frame transition (DM-1524). Outside its sweep the
 * band parks off-box (invisible), so the underlying content rests untouched.
 */
export const shineOverlaySchema = z.object({
  kind: z.literal("shine"),
  /** Top-left of the box the glint is clipped to, in the frame's coordinate space. */
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** Ms after the frame becomes visible before the first sweep. Default 200. */
  delay: z.number().optional(),
  /** Length of ONE sweep in ms (one-shot; ignored when `repeat` is set). Default 900. */
  duration: z.number().optional(),
  /** Highlight color. Default a soft white. */
  color: z.string().optional(),
  /** Peak opacity of the glint band (0–1). Default 0.55. */
  opacity: z.number().optional(),
  /** Band thickness in px. Default ~28% of `width`. */
  bandWidth: z.number().optional(),
  /** Skew of the band from vertical, in degrees. Default 14. */
  skewDeg: z.number().optional(),
  /**
   * DM-1551: corner radius (px) of the clipped box, so the glint follows a
   * rounded element (a pill / button) instead of showing square corners.
   * Clamped to half the shorter side by `buildShineSweep`. Omit / 0 for a
   * square clip. When the overlay is anchored to a captured element (CLI /
   * `resolveOverlays`), this AUTO-derives from the element's computed
   * `border-radius` unless an explicit value is given (DM-1549).
   */
  radius: z.number().optional(),
  /** Repeat the sweep for an ambient shimmer: a count or `"infinite"`. */
  repeat: z.union([z.number(), z.literal("infinite")]).optional(),
  /** Period of ONE ambient sweep in ms (only with `repeat`). Default 1400. */
  repeatPeriodMs: z.number().optional(),
});
export type ShineOverlay = z.infer<typeof shineOverlaySchema>;

/** The resolved overlay union `generateAnimatedSvg` consumes per frame. */
export const animationOverlaySchema = z.discriminatedUnion("kind", [
  typingOverlaySchema,
  tapOverlaySchema,
  svgOverlaySchema,
  blinkOverlaySchema,
  shineOverlaySchema,
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
  property: z.enum(["width", "height", "opacity", "transform", "translateX", "translateY", "scale", "clipPath"]),
  /** Start value (CSS string, e.g. `"0%"`, `"240px"`, `"0.3"`). For `scale`,
   *  a unitless factor (`"0.6"` -> `"1"`). */
  from: z.string(),
  /** End value (same syntax as `from`). */
  to: z.string(),
  /** Duration in ms. Must be ≤ the parent frame's `duration`. */
  duration: z.number(),
  /** CSS easing string. Default `linear`. */
  easing: z.string().optional(),
  /**
   * DM-1297: transform-origin for a `transform` / `scale` / `translate*`
   * animation (e.g. `"center"`, `"50% 50%"`, `"left top"`). SVG transforms are
   * origin-(0,0) by default, so a `scale`/`rotate` would shrink/orbit toward the
   * SVG origin instead of the element's own box. Setting this emits
   * `transform-box: fill-box; transform-origin: <value>` on the animated group so
   * the transform resolves about the element's OWN bounding box — e.g. a
   * center-origin scale-pop. Ignored for non-transform properties.
   */
  transformOrigin: z.string().optional(),
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
  /**
   * DM-1512/1513: additional property tracks fused into THIS animation so they
   * animate as ONE CSS animation on one element — a single timeline that can't
   * desync. Firefox composites `opacity`/`transform` off the main thread and,
   * under load, can demote one of two SEPARATE animations to the main thread
   * while the other stays on the compositor, drifting them apart (e.g. a fade
   * running ahead of its slide/scale). A single animation is always sampled at
   * one instant regardless of thread, so fusing removes that failure mode.
   *
   * By default each fused track rides the primary entry's window (`delay` +
   * `duration`) and `easing`, emitted as from/to stops. A track MAY override
   * `duration` / `delay` / `easing` for independent timing (e.g. a fast fade over
   * a slower slide, or a different curve) — when any track does, the whole
   * animation is emitted by SAMPLING each track's eased value over its own window
   * at many stops with `linear` timing (DM-1517), so it stays one animation / one
   * timeline. The primary `property` is track 0; these are the rest. Multiple
   * transform-family tracks (`translateX`/`translateY`/`scale`/`transform`) are
   * composed into a single `transform:` declaration; other properties (`opacity`,
   * `clip-path`, …) emit alongside. See docs/84-viewer-browser-support.md.
   */
  fuse: z.array(z.object({
    property: z.enum(["width", "height", "opacity", "transform", "translateX", "translateY", "scale", "clipPath"]),
    from: z.string(),
    to: z.string(),
    /** Override the primary's duration for this track (ms). Triggers sampling. */
    duration: z.number().optional(),
    /** Override the primary's delay for this track (ms). Triggers sampling. */
    delay: z.number().optional(),
    /** Override the primary's easing for this track. Triggers sampling. */
    easing: z.string().optional(),
  })).optional(),
});
export type IntraFrameAnimation = z.infer<typeof intraFrameAnimationSchema>;
