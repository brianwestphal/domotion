import { z } from "zod";
import { CHROME_THEMES, DEVICE_CHROMES } from "../render/device-chrome.js";
import { storyboardTransitionSchema } from "../animation/transition-schema.js";

const pointSchema = z.strictObject({ x: z.number(), y: z.number() });
const regionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  radius: z.number().nonnegative().optional(),
});

export const studioTreatmentTimingSchema = z.strictObject({
  startMs: z.number().nonnegative().default(0),
  durationMs: z.number().positive().default(500),
  easing: z.string().trim().min(1).default("cubic-bezier(0.22,1,0.36,1)"),
});

export const studioTreatmentLayerPrimitiveSchema = z.strictObject({
  id: z.string().trim().min(1),
  opacity: z.number().min(0).max(1).default(1),
  blendMode: z.enum(["normal", "multiply", "screen", "overlay"]).default("normal"),
});

export const studioTreatmentMaskPrimitiveSchema = z.strictObject({
  region: regionSchema,
});

export const studioTreatmentTransformPrimitiveSchema = z.strictObject({
  from: z.strictObject({ ...pointSchema.shape, scale: z.number().positive().default(1) }),
  to: z.strictObject({ ...pointSchema.shape, scale: z.number().positive().default(1) }),
  origin: pointSchema.optional(),
});

export const studioTreatmentOverlayPrimitiveSchema = z.strictObject({
  region: regionSchema,
  fill: z.string().trim().min(1).optional(),
  stroke: z.string().trim().min(1).optional(),
  strokeWidth: z.number().positive().default(2),
});

const timing = studioTreatmentTimingSchema.optional();
const chromeFields = {
  label: z.string().optional(),
  theme: z.enum(CHROME_THEMES).default("dark"),
};

export const studioTreatmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("device-frame"), device: z.enum(DEVICE_CHROMES).default("phone"), ...chromeFields }),
  z.strictObject({ kind: z.literal("browser-chrome"), ...chromeFields }),
  z.strictObject({ kind: z.literal("terminal-chrome"), title: z.string().default("Terminal"), theme: z.enum(CHROME_THEMES).default("dark") }),
  z.strictObject({
    kind: z.literal("zoom-pan"),
    transform: studioTreatmentTransformPrimitiveSchema,
    timing,
  }),
  z.strictObject({
    kind: z.literal("spotlight"),
    mask: studioTreatmentMaskPrimitiveSchema,
    color: z.string().default("#000000"),
    opacity: z.number().min(0).max(1).default(0.68),
    timing,
  }),
  z.strictObject({
    kind: z.literal("callout"),
    text: z.string().trim().min(1),
    anchor: pointSchema,
    box: regionSchema,
    fill: z.string().optional(),
    color: z.string().optional(),
    accent: z.string().optional(),
    timing,
  }),
  z.strictObject({
    kind: z.literal("title-card"),
    title: z.string().trim().min(1),
    subtitle: z.string().trim().min(1).optional(),
    align: z.enum(["left", "center"]).default("center"),
    background: z.string().optional(),
    color: z.string().optional(),
    accent: z.string().optional(),
    timing,
  }),
  z.strictObject({
    kind: z.literal("logo-reveal"),
    logo: z.string().trim().min(1).optional(),
    position: pointSchema.optional(),
    width: z.number().positive().optional(),
    timing,
  }),
  z.strictObject({ kind: z.literal("scene-transition"), transition: storyboardTransitionSchema }),
]);

export const studioTreatmentsSchema = z.array(studioTreatmentSchema).max(32).superRefine((treatments, ctx) => {
  const transitions = treatments.flatMap((treatment, index) => treatment.kind === "scene-transition" ? [index] : []);
  transitions.slice(1).forEach((index) => ctx.addIssue({ code: "custom", path: [index], message: "only one scene-transition treatment is allowed" }));
});

export type StudioTreatmentTiming = z.infer<typeof studioTreatmentTimingSchema>;
export type StudioTreatmentLayerPrimitive = z.infer<typeof studioTreatmentLayerPrimitiveSchema>;
export type StudioTreatmentMaskPrimitive = z.infer<typeof studioTreatmentMaskPrimitiveSchema>;
export type StudioTreatmentTransformPrimitive = z.infer<typeof studioTreatmentTransformPrimitiveSchema>;
export type StudioTreatmentOverlayPrimitive = z.infer<typeof studioTreatmentOverlayPrimitiveSchema>;
export type StudioTreatment = z.infer<typeof studioTreatmentSchema>;
