/** Canonical transition authoring contract and compatibility normalization. */
import { z } from "zod";

const duration = z.number().nonnegative();
const easing = z.string().optional().describe("Named or CSS easing for the transition timeline.");
const originSchema = z.object({
  x: z.number().min(0).max(1).describe("Viewport-relative x coordinate: 0=left, 1=right."),
  y: z.number().min(0).max(1).describe("Viewport-relative y coordinate: 0=top, 1=bottom."),
}).strict();

export const legacyTransitionTypeSchema = z.enum([
  "crossfade", "push-left", "scroll", "cut", "magic-move",
  "push-right", "push-up", "push-down",
  "wipe", "iris", "zoom-in", "zoom-out", "shine",
  "wipe-radial", "wipe-clock",
]);
export const transitionTypeSchema = z.enum([...legacyTransitionTypeSchema.options, "push", "reveal", "zoom", "custom"]);

const plainLegacy = (type: "crossfade" | "cut" | "magic-move") => z.object({ type: z.literal(type), duration }).strict();
const pushLegacy = (type: "push-left" | "push-right" | "push-up" | "push-down" | "scroll") => z.object({ type: z.literal(type), duration }).strict();
const zoomLegacy = (type: "zoom-in" | "zoom-out") => z.object({ type: z.literal(type), duration, easing }).strict();
const radialLegacy = (type: "iris" | "wipe-radial") => z.object({ type: z.literal(type), duration, easing }).strict();

const pushParamsSchema = z.union([
  z.object({ direction: z.enum(["left", "right", "up", "down"]).default("left"), distance: z.number().positive().max(2).default(1) }).strict(),
  z.object({ angle: z.number().min(-360).max(360), distance: z.number().positive().max(2).default(1) }).strict(),
]);
const revealParamsSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("linear"), angle: z.number().min(-360).max(360).default(0) }).strict(),
  z.object({ shape: z.literal("radial"), origin: originSchema.default({ x: 0.5, y: 0.5 }), radius: z.number().min(1).max(2).default(1) }).strict(),
  z.object({ shape: z.literal("clock"), origin: originSchema.default({ x: 0.5, y: 0.5 }), startAngle: z.number().min(-360).max(360).default(0), direction: z.enum(["clockwise", "counterclockwise"]).default("clockwise") }).strict(),
]);
const zoomParamsSchema = z.object({
  fromScale: z.number().min(0.01).max(4).default(0.9),
  origin: originSchema.default({ x: 0.5, y: 0.5 }),
}).strict();
const shineParamsSchema = z.object({
  angle: z.number().min(-360).max(360).default(14),
  bandWidth: z.number().positive().max(2).default(0.28).describe("Band width as a fraction of viewport width."),
  color: z.string().min(1).default("#ffffff"),
  opacity: z.number().min(0).max(1).default(0.55),
}).strict();
const translatePrimitiveSchema = z.object({
  x: z.number().min(-2).max(2).default(0).describe("Horizontal viewport fraction."),
  y: z.number().min(-2).max(2).default(0).describe("Vertical viewport fraction."),
}).strict().refine(value => value.x !== 0 || value.y !== 0, "translate must move on at least one axis");
const scaleFromPrimitiveSchema = z.object({ from: z.number().min(0.01).max(4), origin: originSchema.default({ x: 0.5, y: 0.5 }) }).strict();
const scaleToPrimitiveSchema = z.object({ to: z.number().min(0.01).max(4), origin: originSchema.default({ x: 0.5, y: 0.5 }) }).strict();
const customIncomingSchema = z.object({
  opacity: z.number().min(0).max(1).optional().describe("Starting opacity; settles at 1."),
  translate: translatePrimitiveSchema.optional().describe("Starting viewport-fraction offset; settles at zero."),
  scale: scaleFromPrimitiveSchema.optional().describe("Starting scale; settles at 1."),
  clip: revealParamsSchema.optional().describe("Starting reveal clip; settles fully revealed."),
}).strict().refine(value => Object.keys(value).length > 0, "incoming must declare at least one primitive");
const customOutgoingSchema = z.object({
  opacity: z.number().min(0).max(1).optional().describe("Ending opacity; starts at 1."),
  translate: translatePrimitiveSchema.optional().describe("Ending viewport-fraction offset; starts at zero."),
  scale: scaleToPrimitiveSchema.optional().describe("Ending scale; starts at 1."),
}).strict().refine(value => Object.keys(value).length > 0, "outgoing must declare at least one primitive; outgoing clip is unsupported—put clip on incoming");
const customRecipeSchema = z.object({
  zOrder: z.literal("incoming-on-top").default("incoming-on-top"),
  incoming: customIncomingSchema,
  outgoing: customOutgoingSchema,
  overlay: shineParamsSchema.optional(),
  reducedMotion: z.enum(["crossfade", "cut"]).default("crossfade"),
  loop: z.enum(["hold-last", "crossfade-to-first"]).default("hold-last"),
}).strict().superRefine((recipe, ctx) => {
  const scaleOrigin = recipe.incoming.scale?.origin;
  const clipOrigin = recipe.incoming.clip != null && recipe.incoming.clip.shape !== "linear" ? recipe.incoming.clip.origin : undefined;
  if (scaleOrigin != null && clipOrigin != null && (scaleOrigin.x !== clipOrigin.x || scaleOrigin.y !== clipOrigin.y)) {
    ctx.addIssue({ code: "custom", path: ["incoming"], message: "combined scale + clip must use the same viewport-relative origin" });
  }
});

export const transitionSchema = z.discriminatedUnion("type", [
  plainLegacy("crossfade"), plainLegacy("cut"), plainLegacy("magic-move"),
  pushLegacy("push-left"), pushLegacy("push-right"), pushLegacy("push-up"), pushLegacy("push-down"), pushLegacy("scroll"),
  z.object({ type: z.literal("wipe"), duration, easing, wipeAngle: z.number().optional() }).strict(),
  radialLegacy("iris"), radialLegacy("wipe-radial"),
  z.object({ type: z.literal("wipe-clock"), duration, easing, wipeStartAngle: z.number().optional(), wipeCounterclockwise: z.boolean().optional() }).strict(),
  zoomLegacy("zoom-in"), zoomLegacy("zoom-out"),
  z.object({ type: z.literal("shine"), duration, shine: shineParamsSchema.optional() }).strict(),
  z.object({ type: z.literal("push"), duration, easing, push: pushParamsSchema }).strict(),
  z.object({ type: z.literal("reveal"), duration, easing, reveal: revealParamsSchema }).strict(),
  z.object({ type: z.literal("zoom"), duration, easing, zoom: zoomParamsSchema }).strict(),
  z.object({ type: z.literal("custom"), duration, easing, custom: customRecipeSchema }).strict(),
]);

/** Opaque storyboard scenes cannot build the element-tree bridge magic-move needs. */
export const storyboardTransitionSchema = z.union(transitionSchema.options.filter(option => option.shape.type.value !== "magic-move"));

export type Transition = z.infer<typeof transitionSchema>;
export type TransitionType = z.infer<typeof transitionTypeSchema>;
export type LegacyTransitionType = z.infer<typeof legacyTransitionTypeSchema>;
export type TransitionAxis = "X" | "Y";
export type TransitionRevealShape = "wipe" | "iris" | "clock";
export interface ViewportOrigin { x: number; y: number }

export interface NormalizedTransitionPlan {
  legacyType: TransitionType;
  duration: number;
  easing?: string;
  parameterized: boolean;
  incoming: {
    opacity: "hold" | "fade";
    opacityFrom?: number;
    translate?: { axis: TransitionAxis; sign: 1 | -1; distance: number } | { x: number; y: number };
    scale?: { from: number; origin?: ViewportOrigin };
    clip?: { shape: TransitionRevealShape; angle?: number; startAngle?: number; counterclockwise?: boolean; origin?: ViewportOrigin; radius?: number };
  };
  outgoing: {
    opacity: "hold" | "fade" | "cut";
    opacityTo?: number;
    translate?: { axis: TransitionAxis; sign: 1 | -1; distance: number } | { x: number; y: number };
    scale?: { to: number; origin?: ViewportOrigin };
  };
  overlay?: "shine" | "magic-move";
  shine?: { angle: number; bandWidth: number; color: string; opacity: number };
  custom?: { reducedMotion: "crossfade" | "cut"; loop: "hold-last" | "crossfade-to-first"; zOrder: "incoming-on-top" };
}

const push = (legacyType: TransitionType, durationMs: number, axis: TransitionAxis, sign: 1 | -1): NormalizedTransitionPlan => ({
  legacyType, duration: durationMs, parameterized: false,
  incoming: { opacity: "hold", translate: { axis, sign, distance: 1 } },
  outgoing: { opacity: "hold", translate: { axis, sign, distance: 1 } },
});

function directionVector(direction: "left" | "right" | "up" | "down", distance: number): { x: number; y: number } {
  if (direction === "left") return { x: -distance, y: 0 };
  if (direction === "right") return { x: distance, y: 0 };
  if (direction === "up") return { x: 0, y: -distance };
  return { x: 0, y: distance };
}

/** Normalize compatibility aliases and parameter families into safe motion channels. */
export function normalizeTransition(transition: Transition): NormalizedTransitionPlan {
  const { type, duration: durationMs } = transition;
  switch (type) {
    case "push-left": return push(type, durationMs, "X", -1);
    case "push-right": return push(type, durationMs, "X", 1);
    case "push-up": case "scroll": return push(type, durationMs, "Y", -1);
    case "push-down": return push(type, durationMs, "Y", 1);
    case "push": {
      const p = transition.push;
      const v = "angle" in p
        ? { x: Math.cos(p.angle * Math.PI / 180) * p.distance, y: Math.sin(p.angle * Math.PI / 180) * p.distance }
        : directionVector(p.direction, p.distance);
      return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: true, incoming: { opacity: "hold", translate: v }, outgoing: { opacity: "hold", translate: v } };
    }
    case "wipe": return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: false, incoming: { opacity: "hold", clip: { shape: "wipe", angle: transition.wipeAngle } }, outgoing: { opacity: "hold" } };
    case "iris": case "wipe-radial": return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: false, incoming: { opacity: "hold", clip: { shape: "iris" } }, outgoing: { opacity: "hold" } };
    case "wipe-clock": return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: false, incoming: { opacity: "hold", clip: { shape: "clock", startAngle: transition.wipeStartAngle, counterclockwise: transition.wipeCounterclockwise } }, outgoing: { opacity: "hold" } };
    case "reveal": {
      const r = transition.reveal;
      const clip = r.shape === "linear" ? { shape: "wipe" as const, angle: r.angle }
        : r.shape === "radial" ? { shape: "iris" as const, origin: r.origin, radius: r.radius }
        : { shape: "clock" as const, origin: r.origin, startAngle: r.startAngle, counterclockwise: r.direction === "counterclockwise" };
      return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: true, incoming: { opacity: "hold", clip }, outgoing: { opacity: "hold" } };
    }
    case "zoom-in": case "zoom-out": return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: false, incoming: { opacity: "fade", scale: { from: type === "zoom-in" ? 0.9 : 1.1 } }, outgoing: { opacity: "fade" } };
    case "zoom": return { legacyType: type, duration: durationMs, easing: transition.easing, parameterized: true, incoming: { opacity: "fade", scale: { from: transition.zoom.fromScale, origin: transition.zoom.origin } }, outgoing: { opacity: "fade" } };
    case "shine": return { legacyType: type, duration: durationMs, parameterized: transition.shine != null, incoming: { opacity: "fade" }, outgoing: { opacity: "fade" }, overlay: "shine", shine: transition.shine };
    case "custom": {
      const recipe = transition.custom;
      const clip = recipe.incoming.clip;
      const normalizedClip = clip == null ? undefined : clip.shape === "linear" ? { shape: "wipe" as const, angle: clip.angle }
        : clip.shape === "radial" ? { shape: "iris" as const, origin: clip.origin, radius: clip.radius }
        : { shape: "clock" as const, origin: clip.origin, startAngle: clip.startAngle, counterclockwise: clip.direction === "counterclockwise" };
      return {
        legacyType: type, duration: durationMs, easing: transition.easing, parameterized: true,
        incoming: { opacity: recipe.incoming.opacity == null ? "hold" : "fade", opacityFrom: recipe.incoming.opacity,
          translate: recipe.incoming.translate == null ? undefined : { x: -recipe.incoming.translate.x, y: -recipe.incoming.translate.y },
          scale: recipe.incoming.scale == null ? undefined : { from: recipe.incoming.scale.from, origin: recipe.incoming.scale.origin }, clip: normalizedClip },
        outgoing: { opacity: recipe.outgoing.opacity == null ? "hold" : "fade", opacityTo: recipe.outgoing.opacity, translate: recipe.outgoing.translate, scale: recipe.outgoing.scale },
        overlay: recipe.overlay == null ? undefined : "shine", shine: recipe.overlay,
        custom: { reducedMotion: recipe.reducedMotion, loop: recipe.loop, zOrder: recipe.zOrder },
      };
    }
    case "magic-move": return { legacyType: type, duration: durationMs, parameterized: false, incoming: { opacity: "hold" }, outgoing: { opacity: "cut" }, overlay: "magic-move" };
    case "cut": return { legacyType: type, duration: durationMs, parameterized: false, incoming: { opacity: "hold" }, outgoing: { opacity: "cut" } };
    case "crossfade": return { legacyType: type, duration: durationMs, parameterized: false, incoming: { opacity: "fade" }, outgoing: { opacity: "fade" } };
  }
}
