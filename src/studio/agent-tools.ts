import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { applyStudioAnnotationCommand } from "./annotations.js";
import { createStudioProjectDocument } from "./app-projects.js";
import { validateStudioProject } from "./project.js";
import {
  studioAnnotationTargetSchema,
  studioIdSchema,
  studioReviewAuthorSchema,
  studioSceneRenderSchema,
  studioSceneSchema,
  studioSemanticTrackSchema,
  type StudioLayer,
  type StudioProject,
  type StudioReviewAuthor,
} from "./project-schema.js";
import { studioTreatmentsSchema } from "./treatment-schema.js";

export const STUDIO_AGENT_TOOL_VERSION = 1 as const;
const nonEmpty = z.string().trim().min(1);
const pathField = nonEmpty.max(4096);
const requestBase = { version: z.literal(STUDIO_AGENT_TOOL_VERSION) };

const selectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({ kind: z.literal("scenes"), sceneIds: z.array(studioIdSchema).min(1) }),
]);

const destructiveIntentSchema = z.strictObject({
  allow: z.literal(true),
  reason: nonEmpty,
  expectedProjectDigest: z.string().regex(/^[a-f0-9]{64}$/i),
});

const narrativePatchSchema = z.strictObject({
  title: nonEmpty.optional(),
  summary: nonEmpty.nullable().optional(),
  objective: nonEmpty.nullable().optional(),
  audience: nonEmpty.nullable().optional(),
  tone: nonEmpty.nullable().optional(),
});

const scenePatchSchema = z.strictObject({
  sceneId: studioIdSchema,
  title: nonEmpty.nullable().optional(),
  description: nonEmpty.nullable().optional(),
  render: studioSceneRenderSchema.optional(),
  treatments: studioTreatmentsSchema.nullable().optional(),
  tracks: z.array(studioSemanticTrackSchema).nullable().optional(),
});

const projectChangesSchema = z.strictObject({
  narrative: narrativePatchSchema.optional(),
  scenes: z.array(scenePatchSchema).optional(),
  addScenes: z.array(studioSceneSchema).optional(),
  removeSceneIds: z.array(studioIdSchema).optional(),
});

const annotationPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create"),
    body: nonEmpty,
    target: studioAnnotationTargetSchema.optional(),
    evidenceArtifactIds: z.array(studioIdSchema).optional(),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    annotationId: studioIdSchema,
    body: nonEmpty.optional(),
    target: studioAnnotationTargetSchema.nullable().optional(),
    evidenceArtifactIds: z.array(studioIdSchema).optional(),
  }).refine((value) => value.body != null || value.target !== undefined || value.evidenceArtifactIds != null, {
    message: "an annotation edit must change body, target, or evidence",
  }),
  z.strictObject({
    kind: z.literal("set-status"),
    annotationId: studioIdSchema,
    status: z.enum(["open", "resolved", "superseded"]),
  }),
]);

export const studioAgentToolRequestSchema = z.discriminatedUnion("tool", [
  z.strictObject({
    ...requestBase,
    tool: z.literal("project.inspect"),
    include: z.enum(["summary", "annotations", "project"]).optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("project.create"),
    title: nonEmpty,
    width: z.number().int().positive().max(16_384).optional(),
    height: z.number().int().positive().max(16_384).optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("project.edit"),
    expectedProjectDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    changes: projectChangesSchema,
    destructive: destructiveIntentSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("capture.compile"),
    selection: selectionSchema.optional(),
    artifactDir: pathField,
    overwrite: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("render.preview"),
    selection: selectionSchema.optional(),
    outputPath: pathField,
    overwrite: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("render.video"),
    selection: selectionSchema.optional(),
    inputSvgPath: pathField,
    outputPath: pathField,
    review: z.literal("required"),
    overwrite: z.boolean().optional(),
  }),
  z.strictObject({
    ...requestBase,
    tool: z.literal("annotation.apply"),
    expectedProjectDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    command: annotationPayloadSchema,
  }),
]);

export type StudioAgentToolRequest = z.infer<typeof studioAgentToolRequestSchema>;
export type StudioAgentSelection = z.infer<typeof selectionSchema>;

/** Project the MCP/CLI input contract directly from the runtime request schema. */
export function buildStudioAgentToolRequestJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(studioAgentToolRequestSchema, {
      target: "draft-2020-12",
      io: "input",
      reused: "ref",
    }) as Record<string, unknown>,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Domotion Studio agent tool request",
    description: `Version ${STUDIO_AGENT_TOOL_VERSION} transport for one bounded Studio agent operation.`,
  };
}

export const studioAgentToolArtifactSchema = z.strictObject({
  kind: z.enum(["svg", "video", "image", "capture-evidence", "review-report", "other"]),
  path: pathField,
  workspacePath: pathField,
  id: studioIdSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  sourceRevisionId: studioIdSchema.optional(),
  sceneIds: z.array(studioIdSchema).optional(),
});

export type StudioAgentToolArtifact = z.infer<typeof studioAgentToolArtifactSchema>;

export const studioAgentToolResponseSchema = z.strictObject({
  version: z.literal(STUDIO_AGENT_TOOL_VERSION),
  tool: z.string(),
  status: z.enum(["ok", "clarification", "permission-required", "conflict"]),
  summary: nonEmpty,
  projectDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  headRevisionId: studioIdSchema.optional(),
  project: z.unknown().optional(),
  data: z.record(z.string(), z.json()).optional(),
  artifacts: z.array(studioAgentToolArtifactSchema).optional(),
  clarification: z.strictObject({ question: nonEmpty, reason: nonEmpty, choices: z.array(z.string()).optional() }).optional(),
  permission: z.strictObject({ name: nonEmpty, reason: nonEmpty, destructiveIds: z.array(studioIdSchema).optional() }).optional(),
});

export type StudioAgentToolResponse = z.infer<typeof studioAgentToolResponseSchema> & { project?: StudioProject };

export interface StudioAgentToolPermissions {
  editProject?: boolean;
  destructiveProjectEdits?: boolean;
  capture?: boolean;
  artifactWrites?: boolean;
  overwriteArtifacts?: boolean;
  renderVideo?: boolean;
}

export interface StudioAgentGenerationInput {
  project: StudioProject;
  selection: StudioAgentSelection;
  absolutePath: string;
  workspacePath: string;
  overwrite: boolean;
  /** Generation adapters cannot opt out of the user's required AI stages. */
  aiPolicy: { healing: "required"; review: "required" };
}

export interface StudioAgentGenerationResult {
  project?: StudioProject;
  artifacts: StudioAgentToolArtifact[];
  evidence?: Record<string, z.infer<ReturnType<typeof z.json>>>;
}

export interface RunStudioAgentToolOptions {
  workspaceRoot: string;
  actor?: StudioReviewAuthor;
  permissions?: StudioAgentToolPermissions;
  timestamp?: () => string;
  capture?: (input: StudioAgentGenerationInput) => Promise<StudioAgentGenerationResult>;
  preview?: (input: StudioAgentGenerationInput) => Promise<StudioAgentGenerationResult>;
  video?: (input: StudioAgentGenerationInput & { inputSvgPath: string; inputSvgWorkspacePath: string; review: "required" }) => Promise<StudioAgentGenerationResult | {
    clarification: { question: string; reason: string; choices?: string[] };
    evidence?: Record<string, z.infer<ReturnType<typeof z.json>>>;
  }>;
}

export class StudioAgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioAgentToolError";
  }
}

export function studioAgentProjectDigest(project: StudioProject): string {
  return createHash("sha256").update(JSON.stringify(validateStudioProject(project))).digest("hex");
}

function response(
  tool: string,
  status: StudioAgentToolResponse["status"],
  summary: string,
  project?: StudioProject,
  extra: Omit<StudioAgentToolResponse, "version" | "tool" | "status" | "summary" | "project" | "projectDigest" | "headRevisionId"> = {},
  includeProject = true,
): StudioAgentToolResponse {
  return studioAgentToolResponseSchema.parse({
    version: STUDIO_AGENT_TOOL_VERSION,
    tool,
    status,
    summary,
    ...(project == null ? {} : {
      ...(includeProject ? { project } : {}),
      projectDigest: studioAgentProjectDigest(project),
      headRevisionId: project.review.headRevisionId,
    }),
    ...extra,
  }) as StudioAgentToolResponse;
}

function permissionResponse(tool: string, project: StudioProject | undefined, name: string, reason: string, destructiveIds?: string[]): StudioAgentToolResponse {
  return response(tool, "permission-required", reason, project, {
    permission: { name, reason, ...(destructiveIds == null ? {} : { destructiveIds }) },
  });
}

function requireProject(project: StudioProject | null, tool: string): StudioProject {
  if (project == null) throw new StudioAgentToolError(`${tool} requires a loaded Studio project`);
  return validateStudioProject(project);
}

function actorFor(options: RunStudioAgentToolOptions, tool: string): StudioReviewAuthor {
  if (options.actor == null) throw new StudioAgentToolError(`${tool} requires a trusted host-supplied actor`);
  return studioReviewAuthorSchema.parse(options.actor);
}

function workspacePath(workspaceRoot: string, requested: string): { absolutePath: string; workspacePath: string } {
  const root = resolve(workspaceRoot);
  const absolutePath = resolve(root, requested);
  const local = relative(root, absolutePath);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new StudioAgentToolError(`artifact path must stay inside the Studio workspace: ${root}`);
  }
  return { absolutePath, workspacePath: local.replaceAll("\\", "/") };
}

function resolveSelection(project: StudioProject, selection: StudioAgentSelection | undefined, tool: string): StudioAgentSelection | StudioAgentToolResponse {
  if (selection == null) {
    if (project.scenes.length !== 1) {
      return response(tool, "clarification", "Scene selection is ambiguous.", project, {
        clarification: {
          question: "Should this operation use the complete project or specific scenes?",
          reason: `The project contains ${project.scenes.length} scenes and no selection was supplied.`,
          choices: ["complete project", ...project.scenes.map((scene) => scene.id)],
        },
      });
    }
    return { kind: "scenes", sceneIds: [project.scenes[0].id] };
  }
  if (selection.kind === "scenes") {
    const unknown = selection.sceneIds.filter((id) => !project.scenes.some((scene) => scene.id === id));
    if (unknown.length > 0) {
      return response(tool, "clarification", "One or more selected scenes do not exist.", project, {
        clarification: {
          question: "Which current scene should the operation use?",
          reason: `Unknown scene ids: ${unknown.join(", ")}.`,
          choices: project.scenes.map((scene) => scene.id),
        },
      });
    }
  }
  return selection;
}

function stableIds(project: StudioProject): Set<string> {
  const ids = new Set<string>([project.id]);
  const addLayers = (layers: readonly StudioLayer[]): void => {
    for (const layer of layers) {
      ids.add(layer.id);
      if (layer.kind === "composition") addLayers(layer.composition.layers);
    }
  };
  for (const scene of project.scenes) {
    ids.add(scene.id);
    for (const track of scene.tracks ?? []) {
      ids.add(track.id);
      for (const event of track.events) ids.add(event.id);
    }
    if (scene.render.kind === "composition") addLayers(scene.render.composition.layers);
  }
  return ids;
}

function applyProjectChanges(project: StudioProject, changes: z.infer<typeof projectChangesSchema>): StudioProject | StudioAgentToolResponse {
  const next = structuredClone(project);
  const narrative = changes.narrative;
  if (narrative != null) {
    if (narrative.title != null) next.narrative.title = narrative.title;
    for (const field of ["summary", "objective", "audience", "tone"] as const) {
      const value = narrative[field];
      if (value === null) delete next.narrative[field];
      else if (value !== undefined) next.narrative[field] = value;
    }
  }
  for (const patch of changes.scenes ?? []) {
    const scene = next.scenes.find((candidate) => candidate.id === patch.sceneId);
    if (scene == null) {
      return response("project.edit", "clarification", `Scene ${patch.sceneId} does not exist.`, project, {
        clarification: {
          question: "Which current scene should be edited?",
          reason: `No scene has id ${patch.sceneId}.`,
          choices: project.scenes.map((candidate) => candidate.id),
        },
      });
    }
    for (const field of ["title", "description"] as const) {
      const value = patch[field];
      if (value === null) delete scene[field];
      else if (value !== undefined) scene[field] = value;
    }
    if (patch.render != null) scene.render = patch.render;
    if (patch.treatments === null) delete scene.treatments;
    else if (patch.treatments !== undefined) scene.treatments = patch.treatments;
    if (patch.tracks === null) delete scene.tracks;
    else if (patch.tracks !== undefined) scene.tracks = patch.tracks;
  }
  for (const scene of changes.addScenes ?? []) {
    if (next.scenes.some((candidate) => candidate.id === scene.id)) throw new StudioAgentToolError(`scene id already exists: ${scene.id}`);
    next.scenes.push(scene);
  }
  const removed = new Set(changes.removeSceneIds ?? []);
  if (removed.size > 0) {
    next.scenes = next.scenes.filter((scene) => !removed.has(scene.id));
    next.narrative.beats.forEach((beat) => { beat.sceneIds = beat.sceneIds.filter((id) => !removed.has(id)); });
  }
  return next;
}

function compactInspection(project: StudioProject): Record<string, z.infer<ReturnType<typeof z.json>>> {
  return {
    id: project.id,
    title: project.narrative.title,
    canvas: project.canvas,
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title ?? null,
      renderKind: scene.render.kind,
      trackIds: (scene.tracks ?? []).map((track) => track.id),
      eventIds: (scene.tracks ?? []).flatMap((track) => track.events.map((event) => event.id)),
      treatmentKinds: (scene.treatments ?? []).map((treatment) => treatment.kind),
    })),
    review: {
      headRevisionId: project.review.headRevisionId,
      openAnnotationIds: project.review.annotations.filter((annotation) => annotation.status === "open").map((annotation) => annotation.id),
      resolvedAnnotationIds: project.review.annotations.filter((annotation) => annotation.status === "resolved").map((annotation) => annotation.id),
    },
    artifacts: project.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, path: artifact.path, sha256: artifact.sha256 ?? null })),
  };
}

function ensureArtifacts(artifacts: StudioAgentToolArtifact[], root: string): StudioAgentToolArtifact[] {
  return artifacts.map((artifact) => {
    const resolved = workspacePath(root, artifact.workspacePath);
    if (!isAbsolute(artifact.path)) throw new StudioAgentToolError(`generation adapter artifact path must be absolute: ${artifact.path}`);
    if (resolve(artifact.path) !== resolved.absolutePath) throw new StudioAgentToolError(`artifact absolute/workspace paths disagree: ${artifact.path}`);
    if (!existsSync(resolved.absolutePath)) throw new StudioAgentToolError(`generation adapter reported a missing artifact: ${resolved.workspacePath}`);
    return studioAgentToolArtifactSchema.parse({ ...artifact, path: resolved.absolutePath, workspacePath: resolved.workspacePath });
  });
}

async function runGeneration(
  tool: "capture.compile" | "render.preview",
  project: StudioProject,
  request: Extract<StudioAgentToolRequest, { tool: "capture.compile" | "render.preview" }>,
  options: RunStudioAgentToolOptions,
): Promise<StudioAgentToolResponse> {
  const permission = tool === "capture.compile" ? "capture" : "artifactWrites";
  if (options.permissions?.[permission] !== true) return permissionResponse(tool, project, permission, `${tool} requires explicit ${permission} permission.`);
  if (options.permissions?.artifactWrites !== true) return permissionResponse(tool, project, "artifactWrites", `${tool} writes generated artifacts.`);
  const overwrite = request.overwrite === true;
  if (overwrite && options.permissions.overwriteArtifacts !== true) return permissionResponse(tool, project, "overwriteArtifacts", `${tool} requested replacement of existing artifacts.`);
  const selection = resolveSelection(project, request.selection, tool);
  if ("status" in selection) return selection;
  const requestedPath = request.tool === "capture.compile" ? request.artifactDir : request.outputPath;
  const path = workspacePath(options.workspaceRoot, requestedPath);
  if (existsSync(path.absolutePath) && !overwrite) throw new StudioAgentToolError(`${path.workspacePath} already exists; request overwrite explicitly`);
  const adapter = tool === "capture.compile" ? options.capture : options.preview;
  if (adapter == null) throw new StudioAgentToolError(`${tool} requires a host generation adapter`);
  const generated = await adapter({
    project,
    selection,
    ...path,
    overwrite,
    aiPolicy: { healing: "required", review: "required" },
  });
  const next = generated.project == null ? project : validateStudioProject(generated.project);
  return response(tool, "ok", tool === "capture.compile" ? "Capture artifacts compiled." : "Preview rendered.", next, {
    artifacts: ensureArtifacts(generated.artifacts, options.workspaceRoot),
    ...(generated.evidence == null ? {} : { data: generated.evidence }),
  });
}

/** Execute one versioned, MCP-shaped Studio request against an in-process project value. */
export async function runStudioAgentTool(
  rawProject: StudioProject | null,
  rawRequest: StudioAgentToolRequest,
  options: RunStudioAgentToolOptions,
): Promise<StudioAgentToolResponse> {
  const request = studioAgentToolRequestSchema.parse(rawRequest);
  if (request.tool === "project.create") {
    if (rawProject != null) return permissionResponse(request.tool, validateStudioProject(rawProject), "replaceProject", "Creating here would replace the loaded project; start with an empty tool session.");
    if (options.permissions?.editProject !== true) return permissionResponse(request.tool, undefined, "editProject", "Project creation requires explicit editProject permission.");
    const actor = actorFor(options, request.tool);
    const project = createStudioProjectDocument({ title: request.title, width: request.width, height: request.height, createdAt: options.timestamp?.() });
    project.review.revisions[0].author = actor;
    return response(request.tool, "ok", "Studio project created.", validateStudioProject(project), { data: compactInspection(project) });
  }

  const project = requireProject(rawProject, request.tool);
  if (request.tool === "project.inspect") {
    const include = request.include ?? "summary";
    return response(request.tool, "ok", "Studio project inspected.", project, {
      data: {
        ...compactInspection(project),
        ...(include === "annotations" ? { annotations: project.review.annotations } : {}),
      },
    }, include === "project");
  }

  if (request.tool === "project.edit" || request.tool === "annotation.apply") {
    const actualDigest = studioAgentProjectDigest(project);
    if (request.expectedProjectDigest !== actualDigest) {
      return response(request.tool, "conflict", "The project changed after this tool request was prepared.", project, {
        data: { expectedProjectDigest: request.expectedProjectDigest, actualProjectDigest: actualDigest },
      });
    }
  }

  if (request.tool === "project.edit") {
    if (options.permissions?.editProject !== true) return permissionResponse(request.tool, project, "editProject", "Project editing requires explicit editProject permission.");
    const proposed = applyProjectChanges(project, request.changes);
    if ("status" in proposed) return proposed;
    if (isDeepStrictEqual(project, proposed)) {
      return response(request.tool, "clarification", "The requested edit makes no project change.", project, {
        clarification: { question: "What should change in the project?", reason: "Every supplied field already has the requested value." },
      });
    }
    const removedIds = [...stableIds(project)].filter((id) => !stableIds(proposed).has(id));
    if (removedIds.length > 0) {
      if (request.destructive == null) return permissionResponse(request.tool, project, "destructiveProjectEdits", "The edit removes stable project identities.", removedIds);
      if (request.destructive.expectedProjectDigest !== request.expectedProjectDigest) {
        return response(request.tool, "conflict", "Destructive confirmation was prepared for a different project digest.", project);
      }
      if (options.permissions.destructiveProjectEdits !== true) return permissionResponse(request.tool, project, "destructiveProjectEdits", request.destructive.reason, removedIds);
    }
    const actor = actorFor(options, request.tool);
    const createdAt = options.timestamp?.() ?? new Date().toISOString();
    const revisionId = `revision-agent-${createHash("sha256").update(JSON.stringify({ parent: project.review.headRevisionId, changes: request.changes, createdAt })).digest("hex").slice(0, 16)}`;
    proposed.review.revisions.push({
      id: revisionId,
      parentId: project.review.headRevisionId,
      createdAt,
      author: actor,
      kind: "content",
      summary: "Applied a bounded Studio agent edit.",
      metadata: {
        tool: {
          version: STUDIO_AGENT_TOOL_VERSION,
          name: request.tool,
          changes: z.json().parse(JSON.parse(JSON.stringify(request.changes))),
        },
        ...(request.destructive == null ? {} : { destructive: { reason: request.destructive.reason, removedIds } }),
      },
    });
    proposed.review.headRevisionId = revisionId;
    proposed.updatedAt = createdAt;
    const validated = validateStudioProject(proposed);
    return response(request.tool, "ok", "Studio project revised.", validated, { data: { revisionId, removedIds } });
  }

  if (request.tool === "annotation.apply") {
    if (options.permissions?.editProject !== true) return permissionResponse(request.tool, project, "editProject", "Annotation changes require explicit editProject permission.");
    const actor = actorFor(options, request.tool);
    const result = applyStudioAnnotationCommand(project, { ...request.command, author: actor, ...(request.command.kind === "create" ? { origin: { kind: "studio", data: { producer: "studio-agent-tool", version: STUDIO_AGENT_TOOL_VERSION } } } : {}) }, {
      expectedHeadRevisionId: project.review.headRevisionId,
      now: options.timestamp?.(),
    });
    return response(request.tool, "ok", "Studio annotation updated.", result.project, {
      data: { annotationId: result.annotation.id, annotationStatus: result.annotation.status, revisionId: result.revision.id },
    });
  }

  if (request.tool === "capture.compile" || request.tool === "render.preview") return runGeneration(request.tool, project, request, options);

  if (options.permissions?.renderVideo !== true) return permissionResponse(request.tool, project, "renderVideo", "Video rendering requires explicit renderVideo permission.");
  if (options.permissions.artifactWrites !== true) return permissionResponse(request.tool, project, "artifactWrites", "Video rendering writes generated artifacts.");
  const overwrite = request.overwrite === true;
  if (overwrite && options.permissions.overwriteArtifacts !== true) return permissionResponse(request.tool, project, "overwriteArtifacts", "Video rendering requested replacement of an existing artifact.");
  const selection = resolveSelection(project, request.selection, request.tool);
  if ("status" in selection) return selection;
  const output = workspacePath(options.workspaceRoot, request.outputPath);
  const input = workspacePath(options.workspaceRoot, request.inputSvgPath);
  if (existsSync(output.absolutePath) && !overwrite) throw new StudioAgentToolError(`${output.workspacePath} already exists; request overwrite explicitly`);
  if (options.video == null) throw new StudioAgentToolError("render.video requires a host video + required-AI-review adapter");
  const generated = await options.video({
    project,
    selection,
    absolutePath: output.absolutePath,
    workspacePath: output.workspacePath,
    overwrite,
    inputSvgPath: input.absolutePath,
    inputSvgWorkspacePath: input.workspacePath,
    review: "required",
    aiPolicy: { healing: "required", review: "required" },
  });
  if ("clarification" in generated) {
    return response(request.tool, "clarification", "Required AI review needs user direction.", project, {
      clarification: generated.clarification,
      ...(generated.evidence == null ? {} : { data: generated.evidence }),
    });
  }
  const next = generated.project == null ? project : validateStudioProject(generated.project);
  return response(request.tool, "ok", "Video rendered and AI-reviewed.", next, {
    artifacts: ensureArtifacts(generated.artifacts, options.workspaceRoot),
    ...(generated.evidence == null ? {} : { data: generated.evidence }),
  });
}
