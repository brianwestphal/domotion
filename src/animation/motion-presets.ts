/**
 * Motion preset library (DM-1526).
 *
 * A curated, named motion vocabulary so authors (and templates) don't hand-tune
 * cubic-beziers or re-derive from/to transforms. Two layers:
 *
 *  - **Easing presets** — named curves (the standard eases + a back/overshoot
 *    "spring-ish" set), resolved to plain CSS `cubic-bezier(...)` strings so the
 *    output stays cross-engine-safe (no runtime, no JS). A raw CSS easing string
 *    passes through untouched.
 *  - **Motion presets** — named enter motions (`fade`, `fade-up`, `pop`,
 *    `slide-in-<dir>`, `wipe-in`) that expand to the intra-frame animation fields
 *    (`property` / `from` / `to` / `fuse` / a default `easing`). Passing
 *    `{ exit: true }` reverses a motion for an outgoing element.
 *
 * These expand to the EXISTING intra-frame animation shape (docs/08, DM-1512/1517)
 * — opacity is fused into the transform track so the two can't desync — so nothing
 * new is needed in the keyframe emitter; presets are pure config sugar. `shine`
 * (a gradient sweep) needs a mask/gradient overlay mechanism and is tracked
 * separately.
 */

/** A fused secondary track (mirrors the intra-frame `fuse[]` entry shape). */
export interface PresetFuseTrack {
  property: "opacity" | "translateX" | "translateY" | "scale" | "transform" | "clipPath" | "width" | "height";
  from: string;
  to: string;
}

/** The intra-frame animation fields a motion preset expands to. */
export interface ResolvedMotion {
  property: "opacity" | "translateX" | "translateY" | "scale" | "transform" | "clipPath" | "width" | "height";
  from: string;
  to: string;
  /** Suggested easing (a resolved cubic-bezier); the caller may override. */
  easing: string;
  /** Center-origin etc. for scale/transform motions. */
  transformOrigin?: string;
  /** Fused secondary tracks (e.g. opacity riding a translate). */
  fuse?: PresetFuseTrack[];
}

/**
 * Named easing curves → CSS `cubic-bezier(...)` (or a bare CSS keyword). The
 * `back-*` / `spring` curves overshoot for a lively, springy feel while staying a
 * single monotonic-time cubic-bezier (cross-engine-safe). A true multi-oscillation
 * spring (sampled to keyframes via the DM-1517 sampler) is a follow-up.
 */
export const EASING_PRESETS: Record<string, string> = {
  linear: "linear",
  ease: "ease",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
  "ease-out-quad": "cubic-bezier(0.25,0.46,0.45,0.94)",
  "ease-out-cubic": "cubic-bezier(0.215,0.61,0.355,1)",
  "ease-out-quart": "cubic-bezier(0.165,0.84,0.44,1)",
  "ease-out-expo": "cubic-bezier(0.19,1,0.22,1)",
  "ease-in-cubic": "cubic-bezier(0.55,0.055,0.675,0.19)",
  "ease-in-out-cubic": "cubic-bezier(0.645,0.045,0.355,1)",
  // Signature "smooth" ease-out the templates already use (DM-1512).
  smooth: "cubic-bezier(0.22,1,0.36,1)",
  // Overshoot family.
  "back-out": "cubic-bezier(0.34,1.56,0.64,1)",
  "back-in": "cubic-bezier(0.36,0,0.66,-0.56)",
  "back-in-out": "cubic-bezier(0.68,-0.55,0.265,1.55)",
  spring: "cubic-bezier(0.34,1.56,0.64,1)",
};

/** Names of the built-in easing presets (for help / validation / the UI). */
export function easingPresetNames(): string[] {
  return Object.keys(EASING_PRESETS);
}

/**
 * Resolve an easing name to a CSS easing string. A known preset name maps to its
 * curve; anything else (a raw `cubic-bezier(...)`, `steps(...)`, or an unknown
 * name) passes through unchanged so authors can still supply raw CSS. `undefined`
 * → `undefined` (the emitter's own default applies).
 */
export function resolveEasingPreset(easing: string | undefined): string | undefined {
  if (easing == null) return undefined;
  return EASING_PRESETS[easing] ?? easing;
}

/** Options for {@link resolveMotionPreset}. */
export interface MotionPresetOptions {
  /** Travel distance in px for slide/fade-translate motions. Default 24 (48 for slides). */
  distance?: number;
  /** Start scale for `pop`. Default 0.8. */
  scaleFrom?: number;
  /** Reverse the motion (an element leaving instead of entering). */
  exit?: boolean;
}

/** The enter-motion definitions, keyed by name. Each returns the ENTER form; the
 *  resolver reverses it for `exit`. */
const MOTIONS: Record<string, (o: Required<Pick<MotionPresetOptions, "distance" | "scaleFrom">>) => ResolvedMotion> = {
  fade: () => ({ property: "opacity", from: "0", to: "1", easing: EASING_PRESETS["ease-out"] }),
  "fade-up": (o) => ({
    property: "translateY", from: `${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  "fade-down": (o) => ({
    property: "translateY", from: `-${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  pop: (o) => ({
    property: "scale", from: `${o.scaleFrom}`, to: "1", easing: EASING_PRESETS["back-out"], transformOrigin: "center",
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  "slide-in-left": (o) => ({
    property: "translateX", from: `-${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  "slide-in-right": (o) => ({
    property: "translateX", from: `${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  "slide-in-up": (o) => ({
    property: "translateY", from: `${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  "slide-in-down": (o) => ({
    property: "translateY", from: `-${o.distance}px`, to: "0px", easing: EASING_PRESETS.smooth,
    fuse: [{ property: "opacity", from: "0", to: "1" }],
  }),
  // Left-to-right clip reveal (no motion of the box; the content is unveiled).
  "wipe-in": () => ({
    property: "clipPath", from: "inset(0 100% 0 0)", to: "inset(0 0 0 0)", easing: EASING_PRESETS["ease-out-quart"],
  }),
};

/** Names of the built-in motion presets (for help / validation / the UI). */
export function motionPresetNames(): string[] {
  return Object.keys(MOTIONS);
}

/** Swap from/to of a resolved motion (and its fused tracks) for an exit. */
function reverse(m: ResolvedMotion): ResolvedMotion {
  return {
    ...m,
    from: m.to,
    to: m.from,
    fuse: m.fuse?.map((t) => ({ ...t, from: t.to, to: t.from })),
  };
}

/**
 * Resolve a named motion preset to intra-frame animation fields. Throws on an
 * unknown name (with the valid list). `exit: true` reverses the motion so the
 * element animates OUT the way it would have come in.
 */
export function resolveMotionPreset(name: string, opts: MotionPresetOptions = {}): ResolvedMotion {
  const def = MOTIONS[name];
  if (def == null) {
    throw new Error(`motion preset: unknown preset "${name}". Available: ${motionPresetNames().join(", ")}.`);
  }
  // Slides read better with a larger default travel than fades/pops.
  const isSlide = name.startsWith("slide-");
  const distance = opts.distance ?? (isSlide ? 48 : 24);
  const scaleFrom = opts.scaleFrom ?? 0.8;
  const enter = def({ distance, scaleFrom });
  const resolved = opts.exit === true ? reverse(enter) : enter;
  // An exit generally reads better easing IN (accelerating away).
  if (opts.exit === true && (resolved.easing === EASING_PRESETS.smooth || resolved.easing === EASING_PRESETS["ease-out"])) {
    return { ...resolved, easing: EASING_PRESETS["ease-in-cubic"] };
  }
  return resolved;
}
