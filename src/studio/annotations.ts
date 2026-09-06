import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  studioAnnotationTargetSchema,
  studioIdSchema,
  studioReviewAuthorSchema,
  type StudioAnnotationRegion,
  type StudioAnnotationTarget,
  type StudioLayer,
  type StudioProject,
  type StudioReviewAnnotation,
  type StudioReviewAuthor,
  type StudioReviewRevision,
} from "./project-schema.js";
import { validateStudioProject } from "./project.js";
import { parseRegionsBlock } from "../utils/regions-parser.js";

const nonEmpty = z.string().trim().min(1);
const evidenceArtifactIdsSchema = z.array(studioIdSchema);
const annotationOriginSchema = z.strictObject({
  kind: z.enum(["studio", "svg-scrubber", "svg-review-regions"]),
  reference: nonEmpty.optional(),
  data: z.record(z.string(), z.json()).optional(),
});

const createCommandSchema = z.strictObject({
  kind: z.literal("create"),
  body: nonEmpty,
  author: studioReviewAuthorSchema,
  target: studioAnnotationTargetSchema.optional(),
  evidenceArtifactIds: evidenceArtifactIdsSchema.optional(),
  origin: annotationOriginSchema.optional(),
});

const editCommandSchema = z
  .strictObject({
    kind: z.literal("edit"),
    annotationId: studioIdSchema,
    author: studioReviewAuthorSchema,
    body: nonEmpty.optional(),
    target: studioAnnotationTargetSchema.nullable().optional(),
    evidenceArtifactIds: evidenceArtifactIdsSchema.optional(),
  })
  .refine(
    (command) => command.body != null || command.target !== undefined || command.evidenceArtifactIds != null,
    { message: "an annotation edit must change body, target, or evidence" },
  );

const statusCommandSchema = z.strictObject({
  kind: z.literal("set-status"),
  annotationId: studioIdSchema,
  author: studioReviewAuthorSchema,
  status: z.enum(["open", "resolved", "superseded"]),
});

/** One bounded command surface for both human comments and AI findings. */
export const studioAnnotationCommandSchema = z.discriminatedUnion("kind", [
  createCommandSchema,
  editCommandSchema,
  statusCommandSchema,
]);

export type StudioAnnotationCommand = z.infer<typeof studioAnnotationCommandSchema>;
export type StudioAnnotationCreateCommand = z.infer<typeof createCommandSchema>;

export interface ApplyStudioAnnotationCommandOptions {
  /** Optimistic-concurrency guard used by Studio's browser workflow. */
  expectedHeadRevisionId?: string;
  now?: string;
  annotationId?: string;
  revisionId?: string;
  /** Attach a create to an already-appended aggregate review revision. */
  attachToHeadRevision?: boolean;
}

export interface StudioAnnotationCommandResult {
  project: StudioProject;
  annotation: StudioReviewAnnotation;
  revision: StudioReviewRevision;
}

export class StudioAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioAnnotationError";
  }
}

function generatedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function portableBasename(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "imported-review-evidence";
}

function portableReference(value: string | undefined, fallback: string | undefined, label: string): string | undefined {
  if (value == null) return fallback;
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new StudioAnnotationError(`${label} must be a non-empty project-relative path without '..'`);
  }
  return normalized;
}

function appendRevision(
  project: StudioProject,
  id: string,
  createdAt: string,
  author: StudioReviewAuthor,
  summary: string,
  metadata: NonNullable<StudioReviewRevision["metadata"]>,
): StudioReviewRevision {
  if (project.review.revisions.some((revision) => revision.id === id)) {
    throw new StudioAnnotationError(`revision id already exists: ${id}`);
  }
  const revision: StudioReviewRevision = {
    id,
    parentId: project.review.headRevisionId,
    createdAt,
    author,
    kind: "review",
    summary,
    metadata,
  };
  project.review.revisions.push(revision);
  project.review.headRevisionId = revision.id;
  return revision;
}

function annotationById(project: StudioProject, id: string): StudioReviewAnnotation {
  const annotation = project.review.annotations.find((candidate) => candidate.id === id);
  if (annotation == null) throw new StudioAnnotationError(`unknown annotation id: ${id}`);
  return annotation;
}

function layerOwner(project: StudioProject, layerId: string): string | undefined {
  const hasLayer = (layers: readonly StudioLayer[]): boolean => layers.some((layer) =>
    layer.id === layerId || (layer.kind === "composition" && hasLayer(layer.composition.layers)),
  );
  return project.scenes.find((scene) => scene.render.kind === "composition" && hasLayer(scene.render.composition.layers))?.id;
}

/** Convert legacy v1 aliases into the one normalized target shape emitted by all new commands. */
export function normalizeStudioAnnotationTarget(project: StudioProject, rawTarget: StudioAnnotationTarget): StudioAnnotationTarget {
  const target = studioAnnotationTargetSchema.parse(rawTarget);
  const ownerScenes = new Set<string>();
  if (target.sceneId != null) ownerScenes.add(target.sceneId);
  if (target.trackId != null) {
    const owner = project.scenes.find((scene) => scene.tracks?.some((track) => track.id === target.trackId));
    if (owner != null) ownerScenes.add(owner.id);
  }
  if (target.eventId != null) {
    const owner = project.scenes.find((scene) => scene.tracks?.some((track) => track.events.some((event) => event.id === target.eventId)));
    if (owner != null) ownerScenes.add(owner.id);
  }
  if (target.layerId != null) {
    const owner = layerOwner(project, target.layerId);
    if (owner != null) ownerScenes.add(owner);
  }
  if (target.scope?.kind === "scene") ownerScenes.add(target.scope.sceneId);
  if (ownerScenes.size > 1) throw new StudioAnnotationError("annotation target combines references from different scenes");
  const inferredScene = [...ownerScenes][0];
  const scope = target.scope ?? (inferredScene == null ? { kind: "project" as const } : { kind: "scene" as const, sceneId: inferredScene });
  if (scope.kind === "project" && (target.domTarget != null || target.domIdentity != null)) {
    throw new StudioAnnotationError("a DOM-grounded annotation must declare or imply scene scope");
  }
  if (scope.kind === "project" && target.regions?.some((region) => region.coordinateSpace === "scene")) {
    throw new StudioAnnotationError("scene-coordinate regions require scene scope");
  }
  const time = target.time ?? (target.atMs == null
    ? undefined
    : {
        pointMs: target.atMs,
        ...(target.endMs == null ? {} : { range: { startMs: target.atMs, endMs: target.endMs } }),
      });
  const { sceneId: _sceneId, atMs: _atMs, endMs: _endMs, ...normalized } = target;
  return studioAnnotationTargetSchema.parse({
    ...normalized,
    scope,
    ...(time == null ? {} : { time }),
  });
}

/**
 * Apply exactly one review mutation, append its provenance revision, and return
 * a fully revalidated project. Human and AI authors use this same function.
 */
export function applyStudioAnnotationCommand(
  rawProject: StudioProject,
  rawCommand: StudioAnnotationCommand,
  options: ApplyStudioAnnotationCommandOptions = {},
): StudioAnnotationCommandResult {
  const project = validateStudioProject(structuredClone(rawProject));
  const command = studioAnnotationCommandSchema.parse(rawCommand);
  if (options.expectedHeadRevisionId != null && project.review.headRevisionId !== options.expectedHeadRevisionId) {
    throw new StudioAnnotationError(
      `stale annotation change: expected review head ${options.expectedHeadRevisionId}, found ${project.review.headRevisionId}`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  const revisionId = options.attachToHeadRevision
    ? project.review.headRevisionId
    : (options.revisionId ?? generatedId("revision-annotation"));
  let annotation: StudioReviewAnnotation;
  let revision: StudioReviewRevision;

  if (command.kind === "create") {
    const annotationId = options.annotationId ?? generatedId("annotation");
    if (project.review.annotations.some((candidate) => candidate.id === annotationId)) {
      throw new StudioAnnotationError(`annotation id already exists: ${annotationId}`);
    }
    const target = command.target == null ? undefined : normalizeStudioAnnotationTarget(project, command.target);
    annotation = {
      id: annotationId,
      status: "open",
      body: command.body,
      author: command.author,
      createdAt: now,
      createdRevisionId: revisionId,
      ...(target == null ? {} : { target }),
      ...(command.evidenceArtifactIds == null ? {} : { evidenceArtifactIds: command.evidenceArtifactIds }),
    };
    if (options.attachToHeadRevision) {
      revision = project.review.revisions.find((candidate) => candidate.id === project.review.headRevisionId)!;
      if (revision.author.kind !== command.author.kind || revision.author.name !== command.author.name) {
        throw new StudioAnnotationError("an annotation can attach to the head only when its author matches that revision");
      }
    } else {
      revision = appendRevision(project, revisionId, now, command.author, "Created a review annotation.", {
        operation: "studio.annotation.create",
        annotationId,
        after: annotation,
        ...(command.origin == null ? {} : { origin: command.origin }),
        ...(command.evidenceArtifactIds == null ? {} : { evidenceArtifactIds: command.evidenceArtifactIds }),
      });
    }
    project.review.annotations.push(annotation);
  } else if (command.kind === "edit") {
    annotation = annotationById(project, command.annotationId);
    if (annotation.status !== "open") {
      throw new StudioAnnotationError(`annotation ${annotation.id} must be open before it can be edited`);
    }
    const before = structuredClone(annotation);
    if (command.body != null) annotation.body = command.body;
    if (command.target === null) delete annotation.target;
    else if (command.target !== undefined) annotation.target = normalizeStudioAnnotationTarget(project, command.target);
    if (command.evidenceArtifactIds != null) annotation.evidenceArtifactIds = command.evidenceArtifactIds;
    if (isDeepStrictEqual(before, annotation)) throw new StudioAnnotationError(`annotation ${annotation.id} edit did not change anything`);
    annotation.updatedAt = now;
    annotation.updatedRevisionId = revisionId;
    revision = appendRevision(project, revisionId, now, command.author, "Edited a review annotation.", {
      operation: "studio.annotation.edit",
      annotationId: annotation.id,
      changedFields: [
        ...(command.body == null ? [] : ["body"]),
        ...(command.target === undefined ? [] : ["target"]),
        ...(command.evidenceArtifactIds == null ? [] : ["evidenceArtifactIds"]),
      ],
      before,
      after: annotation,
    });
  } else {
    annotation = annotationById(project, command.annotationId);
    if (annotation.status === command.status) {
      throw new StudioAnnotationError(`annotation ${annotation.id} is already ${command.status}`);
    }
    const previousStatus = annotation.status;
    if (previousStatus === "superseded") throw new StudioAnnotationError(`annotation ${annotation.id} is superseded and cannot be reopened or resolved`);
    if (previousStatus === "resolved" && command.status !== "open") {
      throw new StudioAnnotationError(`annotation ${annotation.id} must be reopened before another lifecycle transition`);
    }
    const before = structuredClone(annotation);
    annotation.status = command.status;
    annotation.updatedAt = now;
    annotation.statusRevisionId = revisionId;
    if (command.status === "resolved") annotation.resolvedRevisionId = revisionId;
    else delete annotation.resolvedRevisionId;
    revision = appendRevision(project, revisionId, now, command.author, `Changed a review annotation to ${command.status}.`, {
      operation: "studio.annotation.set-status",
      annotationId: annotation.id,
      previousStatus,
      status: command.status,
      before,
      after: annotation,
    });
  }

  project.updatedAt = now;
  const validated = validateStudioProject(project);
  return {
    project: validated,
    annotation: annotationById(validated, annotation.id),
    revision: validated.review.revisions.find((candidate) => candidate.id === revision.id)!,
  };
}

const scrubberRegionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

/** The durable JSON emitted by `svg-scrubber --review`; unknown legacy fields are ignored. */
export const svgScrubberReviewTicketSchema = z.object({
  tool: z.literal("svg-scrubber"),
  version: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  title: nonEmpty,
  svg: z.string().nullable().optional(),
  svgName: nonEmpty,
  frameTimeMs: z.number().nonnegative(),
  range: z.strictObject({ startMs: z.number().nonnegative(), endMs: z.number().nonnegative() })
    .refine((range) => range.endMs >= range.startMs, { message: "range end must not be before its start", path: ["endMs"] }),
  regions: z.array(scrubberRegionSchema).optional(),
  region: scrubberRegionSchema.nullable().optional(),
  framePng: z.string().nullable().optional(),
  note: z.string().optional(),
}).passthrough();

export interface ImportSvgScrubberAnnotationOptions {
  author: StudioReviewAuthor;
  sceneId?: string;
  layerId?: string;
  /** Studio artifact containing the source SVG; region units bind to this. */
  sourceArtifactId?: string;
  /** Staged Studio artifact containing the optional frame snapshot evidence. */
  frameArtifactId?: string;
  /** Portable project-relative references after the caller stages source files. */
  sourceReference?: string;
  frameReference?: string;
}

/** Migrate SVG Scrubber review JSON into Studio's annotation command model. */
export function importSvgScrubberReviewAnnotation(
  rawTicket: unknown,
  options: ImportSvgScrubberAnnotationOptions,
): StudioAnnotationCreateCommand {
  const ticket = svgScrubberReviewTicketSchema.parse(rawTicket);
  if (options.layerId != null && options.sceneId == null) throw new StudioAnnotationError("an imported layer requires sceneId");
  const sourceRegions = ticket.regions?.length ? ticket.regions : (ticket.region == null ? [] : [ticket.region]);
  const evidenceArtifactIds = [options.sourceArtifactId, options.frameArtifactId].filter((id): id is string => id != null);
  const sourceReference = portableReference(options.sourceReference, ticket.svg == null ? undefined : portableBasename(ticket.svg), "sourceReference");
  const frameReference = portableReference(options.frameReference, ticket.framePng == null ? undefined : portableBasename(ticket.framePng), "frameReference");
  const sourceDigest = createHash("sha256").update(JSON.stringify(ticket)).digest("hex");
  const target: StudioAnnotationTarget = {
    scope: options.sceneId == null ? { kind: "project" } : { kind: "scene", sceneId: options.sceneId },
    ...(options.layerId == null ? {} : { layerId: options.layerId }),
    time: {
      pointMs: ticket.frameTimeMs,
      range: ticket.range,
    },
    ...(sourceRegions.length === 0 ? {} : {
      regions: sourceRegions.map((region) => ({
        x: region.x,
        y: region.y,
        width: region.w,
        height: region.h,
        coordinateSpace: "svg-user-space" as const,
        ...(options.sourceArtifactId == null ? {} : { artifactId: options.sourceArtifactId }),
      })),
    }),
  };
  const note = ticket.note?.trim() ?? "";
  return createCommandSchema.parse({
    kind: "create",
    body: note === "" ? ticket.title : `${ticket.title}\n\n${note}`,
    author: options.author,
    ...(Object.keys(target).length === 0 ? {} : { target }),
    ...(evidenceArtifactIds.length === 0 ? {} : { evidenceArtifactIds }),
    origin: {
      kind: "svg-scrubber",
      ...(sourceReference == null ? {} : { reference: sourceReference }),
      data: {
        svgName: ticket.svgName,
        sourceCreatedAt: ticket.createdAt,
        sourceDigest,
        frameTimeMs: ticket.frameTimeMs,
        range: ticket.range,
        ...(frameReference == null ? {} : { frameReference }),
      },
    },
  });
}

export interface SvgReviewRegion extends StudioAnnotationRegion {
  index: number;
  image?: string;
  caption?: string;
}

/** Parse the legacy review tool's `REGIONS:` clipboard block at the import boundary. */
export function parseSvgReviewRegions(text: string): SvgReviewRegion[] {
  const parsed = parseRegionsBlock(text);
  if (parsed.warnings.length > 0) throw new StudioAnnotationError(parsed.warnings.join("; "));
  const regions = parsed.regions.map((region) => ({
    index: region.index,
    ...(region.image == null ? {} : { image: region.image }),
    x: region.x,
    y: region.y,
    width: region.w,
    height: region.h,
    ...(region.caption == null ? {} : { caption: region.caption }),
  }));
  if (regions.length === 0) throw new StudioAnnotationError("SVG review REGIONS: block is empty");
  return regions;
}

export interface ImportSvgReviewRegionsOptions {
  body: string;
  author: StudioReviewAuthor;
  target?: Omit<StudioAnnotationTarget, "regions">;
}

/** Migrate copied REGIONS data into Studio without retaining its text syntax as project format. */
export function importSvgReviewRegionsAnnotation(
  text: string,
  options: ImportSvgReviewRegionsOptions,
): StudioAnnotationCreateCommand {
  const regions = parseSvgReviewRegions(text);
  return createCommandSchema.parse({
    kind: "create",
    body: options.body,
    author: options.author,
    target: {
      ...options.target,
      regions: regions.map(({ x, y, width, height, image, caption }) => ({
        x,
        y,
        width,
        height,
        coordinateSpace: "artifact-pixels" as const,
        ...(image == null ? {} : { sourceImage: portableBasename(image) }),
        ...(caption == null ? {} : { label: caption }),
      })),
    },
    origin: {
      kind: "svg-review-regions",
      data: {
        regionCount: regions.length,
        captions: regions.flatMap((region) => region.caption == null ? [] : [region.caption]),
        images: regions.flatMap((region) => region.image == null ? [] : [portableBasename(region.image)]),
      },
    },
  });
}
