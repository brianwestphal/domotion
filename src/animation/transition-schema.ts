/** Canonical transition authoring contract and legacy-name normalization. */
import { z } from "zod";

export const transitionTypeSchema = z.enum([
  "crossfade", "push-left", "scroll", "cut", "magic-move",
  "push-right", "push-up", "push-down",
  "wipe", "iris", "zoom-in", "zoom-out", "shine",
  "wipe-radial", "wipe-clock",
]);

export const transitionSchema = z.object({
  type: transitionTypeSchema,
  duration: z.number().nonnegative(),
  easing: z.string().optional().describe("Named/raw easing for wipe/iris/zoom reveals (spring-* etc.)."),
  wipeAngle: z.number().optional().describe("wipe: reveal angle in degrees clockwise from left-to-right (default 0)."),
  wipeStartAngle: z.number().optional().describe("wipe-clock: start angle in degrees clockwise from 12 o'clock (default 0)."),
  wipeCounterclockwise: z.boolean().optional().describe("wipe-clock: sweep counterclockwise instead of clockwise."),
});

/** Opaque storyboard scenes cannot build the element-tree bridge magic-move needs. */
export const storyboardTransitionSchema = transitionSchema.extend({
  type: transitionTypeSchema.exclude(["magic-move"]),
});

export type Transition = z.infer<typeof transitionSchema>;
export type TransitionType = z.infer<typeof transitionTypeSchema>;
export type TransitionAxis = "X" | "Y";
export type TransitionRevealShape = "wipe" | "iris" | "clock";

export interface NormalizedTransitionPlan {
  legacyType: TransitionType;
  duration: number;
  easing?: string;
  incoming: {
    opacity: "hold" | "fade";
    translate?: { axis: TransitionAxis; sign: 1 | -1 };
    scale?: { from: number };
    clip?: { shape: TransitionRevealShape; angle?: number; startAngle?: number; counterclockwise?: boolean };
  };
  outgoing: {
    opacity: "hold" | "fade" | "cut";
    translate?: { axis: TransitionAxis; sign: 1 | -1 };
  };
  overlay?: "shine" | "magic-move";
}

const push = (legacyType: TransitionType, duration: number, axis: TransitionAxis, sign: 1 | -1): NormalizedTransitionPlan => ({
  legacyType, duration,
  incoming: { opacity: "hold", translate: { axis, sign } },
  outgoing: { opacity: "hold", translate: { axis, sign } },
});

/** Normalize all compatibility spellings into the renderer's safe motion channels. */
export function normalizeTransition(transition: Transition): NormalizedTransitionPlan {
  const { type, duration, easing } = transition;
  switch (type) {
    case "push-left": return push(type, duration, "X", -1);
    case "push-right": return push(type, duration, "X", 1);
    case "push-up":
    case "scroll": return push(type, duration, "Y", -1);
    case "push-down": return push(type, duration, "Y", 1);
    case "wipe":
      return { legacyType: type, duration, easing, incoming: { opacity: "hold", clip: { shape: "wipe", angle: transition.wipeAngle } }, outgoing: { opacity: "hold" } };
    case "iris":
    case "wipe-radial":
      return { legacyType: type, duration, easing, incoming: { opacity: "hold", clip: { shape: "iris" } }, outgoing: { opacity: "hold" } };
    case "wipe-clock":
      return { legacyType: type, duration, easing, incoming: { opacity: "hold", clip: { shape: "clock", startAngle: transition.wipeStartAngle, counterclockwise: transition.wipeCounterclockwise } }, outgoing: { opacity: "hold" } };
    case "zoom-in":
    case "zoom-out":
      return { legacyType: type, duration, easing, incoming: { opacity: "fade", scale: { from: type === "zoom-in" ? 0.9 : 1.1 } }, outgoing: { opacity: "fade" } };
    case "shine":
      return { legacyType: type, duration, incoming: { opacity: "fade" }, outgoing: { opacity: "fade" }, overlay: "shine" };
    case "magic-move":
      return { legacyType: type, duration, incoming: { opacity: "hold" }, outgoing: { opacity: "cut" }, overlay: "magic-move" };
    case "cut":
      return { legacyType: type, duration, incoming: { opacity: "hold" }, outgoing: { opacity: "cut" } };
    case "crossfade":
      return { legacyType: type, duration, incoming: { opacity: "fade" }, outgoing: { opacity: "fade" } };
  }
}
