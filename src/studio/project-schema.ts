import { z } from "zod";
import {
  storyboardCursorSchema,
  storyboardScenePresentationSchema,
  storyboardSceneSchema,
} from "../cli/storyboard.js";
import {
  compositeLayerPlacementSchema,
  compositeLayerSchema,
  type CompositeLayerConfig,
  type CompositeLayerPlacement,
} from "../cli/composite.js";

/** Durable file identity. The numeric version changes only through an explicit migration. */
export const STUDIO_PROJECT_FORMAT = "domotion-studio-project" as const;
export const STUDIO_PROJECT_VERSION = 1 as const;
export const STUDIO_PROJECT_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/domotion-studio-project.schema.json";

/** IDs are deliberately human-readable as well as machine-stable. */
export const studioIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must start with an alphanumeric character and contain only letters, numbers, '.', '_', ':', or '-'");

const nonEmptyString = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const metadataSchema = z.record(z.string(), z.json());
const pointSchema = z.strictObject({ x: z.number(), y: z.number() });

export const studioSemanticTargetSchema = z
  .strictObject({
    role: nonEmptyString.optional(),
    name: nonEmptyString.optional(),
    label: nonEmptyString.optional(),
    text: nonEmptyString.optional(),
    testId: nonEmptyString.optional(),
    domId: nonEmptyString.optional(),
    selector: nonEmptyString.optional(),
  })
  .refine((target) => Object.values(target).some((value) => value != null), {
    message: "declare at least one semantic locator (prefer role/name/label/text; selector is the explicit fallback)",
  });

const semanticEventBase = {
  id: studioIdSchema,
  atMs: z.number().nonnegative(),
  durationMs: z.number().positive().optional(),
  note: nonEmptyString.optional(),
};

const clickEventSchema = z.strictObject({
  ...semanticEventBase,
  kind: z.literal("click"),
  target: studioSemanticTargetSchema,
  button: z.enum(["left", "middle", "right"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
});

const hoverEventSchema = z.strictObject({
  ...semanticEventBase,
  kind: z.literal("hover"),
  target: studioSemanticTargetSchema,
});

const typeEventSchema = z.strictObject({
  ...semanticEventBase,
  kind: z.literal("type"),
  target: studioSemanticTargetSchema,
  text: z.string(),
  replace: z.boolean().optional(),
});

const scrollToEventSchema = z
  .strictObject({
    ...semanticEventBase,
    kind: z.literal("scrollTo"),
    target: studioSemanticTargetSchema.optional(),
    position: pointSchema.optional(),
    behavior: z.enum(["instant", "smooth"]).optional(),
  })
  .refine((event) => Number(event.target != null) + Number(event.position != null) === 1, {
    message: "declare exactly one of `target` or `position`",
    path: ["target"],
  });

const dragDestinationSchema = z.union([
  z.strictObject({ target: studioSemanticTargetSchema }),
  z.strictObject({ point: pointSchema }),
]);

const dragEventSchema = z.strictObject({
  ...semanticEventBase,
  kind: z.literal("drag"),
  target: studioSemanticTargetSchema,
  to: dragDestinationSchema,
});

const waitForStateEventSchema = z
  .strictObject({
    ...semanticEventBase,
    kind: z.literal("waitForState"),
    target: studioSemanticTargetSchema,
    state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "disabled", "checked", "unchecked", "text"]),
    value: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .refine((event) => event.state !== "text" || event.value != null, {
    message: "a text wait requires `value`",
    path: ["value"],
  });

const scriptHookEventSchema = z.strictObject({
  ...semanticEventBase,
  kind: z.literal("scriptHook"),
  hookId: studioIdSchema,
  input: metadataSchema.optional(),
});

/** Intent-level events are durable authoring facts, not lowered Playwright coordinates. */
export const studioSemanticEventSchema = z.discriminatedUnion("kind", [
  clickEventSchema,
  hoverEventSchema,
  typeEventSchema,
  scrollToEventSchema,
  dragEventSchema,
  waitForStateEventSchema,
  scriptHookEventSchema,
]);

export const studioSemanticTrackSchema = z
  .strictObject({
    id: studioIdSchema,
    kind: z.literal("semantic-interactions"),
    name: nonEmptyString.optional(),
    events: z.array(studioSemanticEventSchema),
  })
  .superRefine((track, ctx) => {
    track.events.forEach((event, index) => {
      if (index === 0) return;
      const previous = track.events[index - 1];
      if (event.atMs < previous.atMs) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "atMs"],
          message: `must be greater than or equal to the previous event time (${previous.atMs}ms)`,
        });
      }
      if (previous.durationMs != null && previous.atMs + previous.durationMs > event.atMs) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "atMs"],
          message: `overlaps the previous event, which ends at ${previous.atMs + previous.durationMs}ms`,
        });
      }
    });
  });

export type StudioSemanticTarget = z.infer<typeof studioSemanticTargetSchema>;
export type StudioSemanticEvent = z.infer<typeof studioSemanticEventSchema>;
export type StudioSemanticTrack = z.infer<typeof studioSemanticTrackSchema>;

export interface StudioComposition {
  width: number;
  height: number;
  background?: string;
  duration?: number;
  layers: StudioLayer[];
}

export interface StudioSourceLayer {
  id: string;
  kind: "source";
  name?: string;
  source: CompositeLayerConfig;
  metadata?: Record<string, unknown>;
}

export interface StudioCompositionLayer {
  id: string;
  kind: "composition";
  name?: string;
  placement?: CompositeLayerPlacement;
  composition: StudioComposition;
  metadata?: Record<string, unknown>;
}

export type StudioLayer = StudioSourceLayer | StudioCompositionLayer;

/** Recursive compositions wrap the shipped flat composite recipe at each leaf. */
export const studioLayerSchema: z.ZodType<StudioLayer> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      id: studioIdSchema,
      kind: z.literal("source"),
      name: nonEmptyString.optional(),
      source: compositeLayerSchema,
      metadata: metadataSchema.optional(),
    }),
    z.strictObject({
      id: studioIdSchema,
      kind: z.literal("composition"),
      name: nonEmptyString.optional(),
      placement: compositeLayerPlacementSchema.strict().optional(),
      composition: studioCompositionSchema,
      metadata: metadataSchema.optional(),
    }),
  ]),
);

export const studioCompositionSchema: z.ZodType<StudioComposition> = z.lazy(() =>
  z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: z.string().optional(),
    duration: z.number().positive().optional(),
    layers: z.array(studioLayerSchema).min(1),
  }),
);

const storyboardRenderSchema = z.strictObject({
  kind: z.literal("storyboard"),
  recipe: storyboardSceneSchema,
});

const compositionRenderSchema = z
  .strictObject({
    kind: z.literal("composition"),
    composition: studioCompositionSchema,
    ...storyboardScenePresentationSchema.shape,
  })
  .refine((render) => render.duration != null || render.composition.duration != null, {
    message: "a composition scene needs `duration` or an intrinsic `composition.duration`",
    path: ["duration"],
  });

export const studioSceneRenderSchema = z.discriminatedUnion("kind", [
  storyboardRenderSchema,
  compositionRenderSchema,
]);

const sceneHookReferenceSchema = z.strictObject({
  hookId: studioIdSchema,
  phase: z.enum(["beforeCapture", "afterCapture", "beforeCompile", "afterCompile"]),
});

export const studioSceneSchema = z.strictObject({
  id: studioIdSchema,
  title: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  narrativeBeatIds: z.array(studioIdSchema).optional(),
  render: studioSceneRenderSchema,
  tracks: z.array(studioSemanticTrackSchema).optional(),
  scriptHooks: z.array(sceneHookReferenceSchema).optional(),
  metadata: metadataSchema.optional(),
});

const narrativeBeatSchema = z.strictObject({
  id: studioIdSchema,
  title: nonEmptyString,
  summary: nonEmptyString.optional(),
  sceneIds: z.array(studioIdSchema),
});

export const studioNarrativeSchema = z.strictObject({
  title: nonEmptyString,
  summary: nonEmptyString.optional(),
  objective: nonEmptyString.optional(),
  audience: nonEmptyString.optional(),
  tone: nonEmptyString.optional(),
  beats: z.array(narrativeBeatSchema),
});

export const studioScriptHookSchema = z.strictObject({
  id: studioIdSchema,
  module: nonEmptyString,
  export: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "must be a 64-character hexadecimal SHA-256 digest").optional(),
});

export const studioReviewAuthorSchema = z.strictObject({
  kind: z.enum(["human", "ai", "system"]),
  name: nonEmptyString.optional(),
});

export const studioReviewRevisionSchema = z.strictObject({
  id: studioIdSchema,
  parentId: studioIdSchema.optional(),
  createdAt: timestampSchema,
  author: studioReviewAuthorSchema,
  summary: nonEmptyString,
  metadata: metadataSchema.optional(),
});

export const studioAnnotationRegionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const studioAnnotationTargetSchema = z
  .strictObject({
    sceneId: studioIdSchema.optional(),
    trackId: studioIdSchema.optional(),
    eventId: studioIdSchema.optional(),
    layerId: studioIdSchema.optional(),
    atMs: z.number().nonnegative().optional(),
    endMs: z.number().nonnegative().optional(),
    regions: z.array(studioAnnotationRegionSchema).optional(),
    domIdentity: nonEmptyString.optional(),
  })
  .refine((target) => target.endMs == null || (target.atMs != null && target.endMs >= target.atMs), {
    message: "`endMs` requires `atMs` and must be greater than or equal to it",
    path: ["endMs"],
  });

export const studioReviewAnnotationSchema = z.strictObject({
  id: studioIdSchema,
  status: z.enum(["open", "resolved", "superseded"]),
  body: nonEmptyString,
  author: studioReviewAuthorSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema.optional(),
  createdRevisionId: studioIdSchema,
  resolvedRevisionId: studioIdSchema.optional(),
  target: studioAnnotationTargetSchema.optional(),
  evidenceArtifactIds: z.array(studioIdSchema).optional(),
});

export const studioReviewHistorySchema = z.strictObject({
  headRevisionId: studioIdSchema,
  revisions: z.array(studioReviewRevisionSchema).min(1),
  annotations: z.array(studioReviewAnnotationSchema),
});

export const studioArtifactSchema = z.strictObject({
  id: studioIdSchema,
  kind: z.enum(["svg", "review-video", "image", "capture-evidence", "other"]),
  path: nonEmptyString,
  generatedAt: timestampSchema,
  generator: z.strictObject({ name: nonEmptyString, version: nonEmptyString.optional() }),
  sourceRevisionId: studioIdSchema,
  sceneIds: z.array(studioIdSchema).optional(),
  derivedFromArtifactIds: z.array(studioIdSchema).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "must be a 64-character hexadecimal SHA-256 digest").optional(),
  metadata: metadataSchema.optional(),
});

const canvasSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  background: z.string().optional(),
  title: z.string().optional(),
  desc: z.string().optional(),
});

const exportTargetsSchema = z.strictObject({
  svgPath: nonEmptyString.optional(),
  reviewVideoPath: nonEmptyString.optional(),
});

function addDuplicateIssues(
  values: readonly { id: string; path: PropertyKey[] }[],
  label: string,
  ctx: z.RefinementCtx,
): void {
  const first = new Map<string, PropertyKey[]>();
  for (const value of values) {
    const previous = first.get(value.id);
    if (previous == null) {
      first.set(value.id, value.path);
    } else {
      ctx.addIssue({
        code: "custom",
        path: value.path,
        message: `duplicate ${label} id "${value.id}" (first declared at ${previous.join(".")})`,
      });
    }
  }
}

function collectLayerIds(layers: readonly StudioLayer[], path: PropertyKey[], out: { id: string; path: PropertyKey[] }[]): void {
  layers.forEach((layer, index) => {
    const layerPath = [...path, index];
    out.push({ id: layer.id, path: [...layerPath, "id"] });
    if (layer.kind === "composition") collectLayerIds(layer.composition.layers, [...layerPath, "composition", "layers"], out);
  });
}

export const studioProjectSchema = z
  .strictObject({
    $schema: z.string().optional(),
    format: z.literal(STUDIO_PROJECT_FORMAT),
    version: z.literal(STUDIO_PROJECT_VERSION),
    id: studioIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema.optional(),
    canvas: canvasSchema,
    narrative: studioNarrativeSchema,
    scenes: z.array(studioSceneSchema).min(1),
    playback: z.strictObject({ cursor: storyboardCursorSchema.optional() }).optional(),
    scriptHooks: z.array(studioScriptHookSchema).optional(),
    review: studioReviewHistorySchema,
    artifacts: z.array(studioArtifactSchema),
    exportTargets: exportTargetsSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .superRefine((project, ctx) => {
    const sceneIds = project.scenes.map((scene, index) => ({ id: scene.id, path: ["scenes", index, "id"] }));
    const beatIds = project.narrative.beats.map((beat, index) => ({ id: beat.id, path: ["narrative", "beats", index, "id"] }));
    const hookIds = (project.scriptHooks ?? []).map((hook, index) => ({ id: hook.id, path: ["scriptHooks", index, "id"] }));
    const revisionIds = project.review.revisions.map((revision, index) => ({ id: revision.id, path: ["review", "revisions", index, "id"] }));
    const annotationIds = project.review.annotations.map((annotation, index) => ({ id: annotation.id, path: ["review", "annotations", index, "id"] }));
    const artifactIds = project.artifacts.map((artifact, index) => ({ id: artifact.id, path: ["artifacts", index, "id"] }));
    const trackIds: { id: string; path: PropertyKey[] }[] = [];
    const eventIds: { id: string; path: PropertyKey[] }[] = [];
    const layerIds: { id: string; path: PropertyKey[] }[] = [];

    project.scenes.forEach((scene, sceneIndex) => {
      (scene.tracks ?? []).forEach((track, trackIndex) => {
        trackIds.push({ id: track.id, path: ["scenes", sceneIndex, "tracks", trackIndex, "id"] });
        track.events.forEach((event, eventIndex) => {
          eventIds.push({ id: event.id, path: ["scenes", sceneIndex, "tracks", trackIndex, "events", eventIndex, "id"] });
        });
      });
      if (scene.render.kind === "composition") {
        collectLayerIds(scene.render.composition.layers, ["scenes", sceneIndex, "render", "composition", "layers"], layerIds);
      }
    });

    addDuplicateIssues(sceneIds, "scene", ctx);
    addDuplicateIssues(beatIds, "narrative beat", ctx);
    addDuplicateIssues(hookIds, "script hook", ctx);
    addDuplicateIssues(revisionIds, "revision", ctx);
    addDuplicateIssues(annotationIds, "annotation", ctx);
    addDuplicateIssues(artifactIds, "artifact", ctx);
    addDuplicateIssues(trackIds, "track", ctx);
    addDuplicateIssues(eventIds, "event", ctx);
    addDuplicateIssues(layerIds, "layer", ctx);

    const sceneSet = new Set(sceneIds.map(({ id }) => id));
    const beatSet = new Set(beatIds.map(({ id }) => id));
    const hookSet = new Set(hookIds.map(({ id }) => id));
    const revisionSet = new Set(revisionIds.map(({ id }) => id));
    const artifactSet = new Set(artifactIds.map(({ id }) => id));
    const trackSet = new Set(trackIds.map(({ id }) => id));
    const eventSet = new Set(eventIds.map(({ id }) => id));
    const layerSet = new Set(layerIds.map(({ id }) => id));

    const requireRef = (set: Set<string>, id: string, path: PropertyKey[], label: string): void => {
      if (!set.has(id)) ctx.addIssue({ code: "custom", path, message: `references unknown ${label} id "${id}"` });
    };

    project.narrative.beats.forEach((beat, beatIndex) => {
      beat.sceneIds.forEach((id, index) => requireRef(sceneSet, id, ["narrative", "beats", beatIndex, "sceneIds", index], "scene"));
    });
    project.scenes.forEach((scene, sceneIndex) => {
      (scene.narrativeBeatIds ?? []).forEach((id, index) => requireRef(beatSet, id, ["scenes", sceneIndex, "narrativeBeatIds", index], "narrative beat"));
      (scene.scriptHooks ?? []).forEach((ref, index) => requireRef(hookSet, ref.hookId, ["scenes", sceneIndex, "scriptHooks", index, "hookId"], "script hook"));
      (scene.tracks ?? []).forEach((track, trackIndex) => {
        track.events.forEach((event, eventIndex) => {
          if (event.kind === "scriptHook") requireRef(hookSet, event.hookId, ["scenes", sceneIndex, "tracks", trackIndex, "events", eventIndex, "hookId"], "script hook");
        });
      });
    });

    requireRef(revisionSet, project.review.headRevisionId, ["review", "headRevisionId"], "revision");
    project.review.revisions.forEach((revision, index) => {
      if (revision.parentId != null) {
        requireRef(revisionSet, revision.parentId, ["review", "revisions", index, "parentId"], "revision");
        if (revision.parentId === revision.id) ctx.addIssue({ code: "custom", path: ["review", "revisions", index, "parentId"], message: "a revision cannot be its own parent" });
      }
    });
    project.review.annotations.forEach((annotation, index) => {
      requireRef(revisionSet, annotation.createdRevisionId, ["review", "annotations", index, "createdRevisionId"], "revision");
      if (annotation.resolvedRevisionId != null) requireRef(revisionSet, annotation.resolvedRevisionId, ["review", "annotations", index, "resolvedRevisionId"], "revision");
      annotation.evidenceArtifactIds?.forEach((id, artifactIndex) => requireRef(artifactSet, id, ["review", "annotations", index, "evidenceArtifactIds", artifactIndex], "artifact"));
      const target = annotation.target;
      if (target?.sceneId != null) requireRef(sceneSet, target.sceneId, ["review", "annotations", index, "target", "sceneId"], "scene");
      if (target?.trackId != null) requireRef(trackSet, target.trackId, ["review", "annotations", index, "target", "trackId"], "track");
      if (target?.eventId != null) requireRef(eventSet, target.eventId, ["review", "annotations", index, "target", "eventId"], "event");
      if (target?.layerId != null) requireRef(layerSet, target.layerId, ["review", "annotations", index, "target", "layerId"], "layer");
    });
    project.artifacts.forEach((artifact, index) => {
      requireRef(revisionSet, artifact.sourceRevisionId, ["artifacts", index, "sourceRevisionId"], "revision");
      artifact.sceneIds?.forEach((id, sceneIndex) => requireRef(sceneSet, id, ["artifacts", index, "sceneIds", sceneIndex], "scene"));
      artifact.derivedFromArtifactIds?.forEach((id, artifactIndex) => requireRef(artifactSet, id, ["artifacts", index, "derivedFromArtifactIds", artifactIndex], "artifact"));
    });
  });

export type StudioSceneRender = z.infer<typeof studioSceneRenderSchema>;
export type StudioScene = z.infer<typeof studioSceneSchema>;
export type StudioNarrative = z.infer<typeof studioNarrativeSchema>;
export type StudioScriptHook = z.infer<typeof studioScriptHookSchema>;
export type StudioReviewHistory = z.infer<typeof studioReviewHistorySchema>;
export type StudioReviewAuthor = z.infer<typeof studioReviewAuthorSchema>;
export type StudioReviewRevision = z.infer<typeof studioReviewRevisionSchema>;
export type StudioAnnotationRegion = z.infer<typeof studioAnnotationRegionSchema>;
export type StudioAnnotationTarget = z.infer<typeof studioAnnotationTargetSchema>;
export type StudioReviewAnnotation = z.infer<typeof studioReviewAnnotationSchema>;
export type StudioArtifact = z.infer<typeof studioArtifactSchema>;
export type StudioProject = z.infer<typeof studioProjectSchema>;
