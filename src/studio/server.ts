import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  HttpError,
  createRouter,
  readJsonBody,
  sendBuffer as sendBufferWith,
  sendJson as sendJsonWith,
  startLocalServer,
  type ErrorResponse,
  type RouteContext,
  type RouteHandler,
} from "../utils/local-server.js";
import { assertHeadRevision, isStaleHeadError } from "./stale-head.js";
import { verifyGeneratedProject } from "./generation-verifier.js";
import { StudioProjectValidationError, validateStudioProject } from "./project.js";
import {
  createStudioProjectFile,
  openStudioProjectFile,
  saveStudioProjectFile,
  resolveStudioWorkspaceSvgPath,
  type StudioProjectFile,
} from "./app-projects.js";
import { STUDIO_CLIENT_JS } from "./client.bundle.generated.js";
import { SCRUBBER_CLIENT_JS } from "../scrubber/client.bundle.generated.js";
import { detectAnimationPeriodMs } from "../animation/svg-meta.js";
import { applyStudioAnnotationCommand, StudioAnnotationError, studioAnnotationCommandSchema } from "./annotations.js";
import { commitStudioAuthoringRevision, studioContentRevisionId, StudioAuthoringError } from "./authoring.js";
import {
  importStudioInteractionRecording,
  persistStudioRecordingEvidence,
  StudioRecordingError,
  type StudioRecordingAiAdapter,
} from "./recording.js";
import {
  applyStudioTimelineCommand,
  buildStudioTimeline,
  studioSceneDurationMs,
  StudioTimelineError,
  studioTimelineCommandSchema,
} from "./timeline.js";
import type { StudioArtifact, StudioProject } from "./project-schema.js";

const pathField = z.string().trim().min(1, "project path is required").max(4096);
const openBodySchema = z.strictObject({ path: pathField });
const createBodySchema = z.strictObject({
  path: pathField,
  title: z.string().trim().min(1, "project title is required").max(240),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
});
const saveBodySchema = z.strictObject({
  path: pathField,
  expectedHeadRevisionId: z.string().min(1),
  project: z.unknown(),
});
const annotationBodySchema = z.strictObject({
  path: pathField,
  expectedHeadRevisionId: z.string().min(1),
  command: studioAnnotationCommandSchema,
});
const previewBodySchema = z.strictObject({
  path: pathField,
  selection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("story") }),
    z.strictObject({ kind: z.literal("scene"), sceneId: z.string().min(1) }),
  ]),
});
const generationBodySchema = z.strictObject({
  path: pathField,
  expectedHeadRevisionId: z.string().min(1),
  selection: previewBodySchema.shape.selection,
});
const recordingImportBodySchema = z.strictObject({
  path: pathField,
  expectedHeadRevisionId: z.string().min(1),
  recording: z.unknown(),
});
const timelineBodySchema = z.strictObject({
  path: pathField,
  expectedHeadRevisionId: z.string().min(1),
  command: studioTimelineCommandSchema,
});
const generationAiSchema = z.strictObject({
  healing: z.strictObject({ status: z.literal("accepted"), summary: z.string().trim().min(1) }),
  review: z.strictObject({ status: z.literal("accepted"), summary: z.string().trim().min(1) }),
});

const NO_STORE = { "cache-control": "no-store" } as const;

function sendBuffer(res: ServerResponse, status: number, contentType: string, buffer: Buffer): void {
  sendBufferWith(res, status, contentType, buffer, NO_STORE);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendJsonWith(res, status, value, NO_STORE);
}

function projectResponse(file: StudioProjectFile): Record<string, unknown> {
  const contentRevisionId = studioContentRevisionId(file.project);
  return {
    path: file.relativePath,
    project: file.project,
    generation: {
      artifactCount: file.project.artifacts.length,
      scenes: file.project.scenes.map((scene) => ({
        id: scene.id,
        generated: file.project.artifacts.some(
          (artifact) =>
            artifact.sourceRevisionId === contentRevisionId && artifact.sceneIds?.includes(scene.id) === true,
        ),
      })),
    },
  };
}

function previewArtifact(
  project: StudioProject,
  selection: z.infer<typeof previewBodySchema>["selection"],
): StudioArtifact {
  if (selection.kind === "scene" && !project.scenes.some((scene) => scene.id === selection.sceneId)) {
    throw new HttpError(404, `scene does not exist: ${selection.sceneId}`);
  }
  const candidates = project.artifacts
    .filter((artifact) => artifact.kind === "svg" && artifact.sourceRevisionId === studioContentRevisionId(project))
    .filter((artifact) =>
      selection.kind === "story"
        ? artifact.sceneIds == null || artifact.sceneIds.length === 0
        : artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === selection.sceneId,
    )
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  if (candidates.length === 0) {
    throw new HttpError(
      404,
      selection.kind === "story"
        ? "the project has no generated whole-story SVG artifact"
        : `scene ${selection.sceneId} has no generated SVG artifact`,
    );
  }
  return candidates[0];
}

function authoredDuration(project: StudioProject, selection: z.infer<typeof previewBodySchema>["selection"]): number {
  if (selection.kind === "scene")
    return studioSceneDurationMs(project.scenes.find((scene) => scene.id === selection.sceneId)!);
  return buildStudioTimeline(project).durationMs;
}

function previewResponse(
  workspaceRoot: string,
  file: StudioProjectFile,
  selection: z.infer<typeof previewBodySchema>["selection"],
): Record<string, unknown> {
  const artifact = previewArtifact(file.project, selection);
  // `resolveStudioWorkspaceSvgPath` follows symlinks, so an artifact that escapes the workspace
  // (lexically or through a link) is rejected there.
  const realArtifactPath = realpathSync(resolveStudioWorkspaceSvgPath(workspaceRoot, artifact.path));
  if (statSync(realArtifactPath).size > 64 * 1024 * 1024) throw new HttpError(413, "preview artifact is too large");
  const svg = readFileSync(realArtifactPath, "utf8");
  if (artifact.sha256 != null) {
    const actual = createHash("sha256").update(svg).digest("hex");
    if (actual !== artifact.sha256)
      throw new HttpError(409, `preview artifact digest does not match project provenance: ${artifact.id}`);
  }
  const metadataDuration = artifact.metadata?.durationMs;
  const durationMs =
    typeof metadataDuration === "number" && Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration
      : (detectAnimationPeriodMs(svg) ?? authoredDuration(file.project, selection));
  return {
    sourceKey: selection.kind === "story" ? "story" : `scene:${selection.sceneId}`,
    artifact: {
      id: artifact.id,
      path: artifact.path,
      generatedAt: artifact.generatedAt,
      sourceRevisionId: artifact.sourceRevisionId,
      sha256: artifact.sha256 ?? createHash("sha256").update(svg).digest("hex"),
    },
    name: artifact.id,
    durationMs,
    svg,
  };
}

/** Throws (404 / 409 / 413) unless the selection's artifact resolves inside the workspace, fits, and matches its digest. */
function assertPreviewable(
  workspaceRoot: string,
  file: StudioProjectFile,
  selection: z.infer<typeof previewBodySchema>["selection"],
): void {
  previewResponse(workspaceRoot, file, selection);
}

function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
  if (isStaleHeadError(error)) return { status: 409, body: { error: (error as Error).message } };
  if (
    error instanceof StudioAnnotationError ||
    error instanceof StudioAuthoringError ||
    error instanceof StudioRecordingError ||
    error instanceof StudioTimelineError
  ) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof StudioProjectValidationError) {
    return { status: 400, body: { error: error.message, issues: error.issues } };
  }
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: 404, body: { error: error.message } };
  }
  // A filesystem or OS failure (EACCES, ENOSPC, EMFILE, ...) is the server's fault, not a bad
  // request: 500, so a client does not retry it as if it could fix the input.
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) {
    return { status: 500, body: { error: error.message } };
  }
  return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
}

export interface StudioServerInputs {
  port?: number;
  workspaceRoot?: string;
  initialProjectPath?: string;
  log?: (message: string) => void;
  generate?: (input: StudioGenerationInput) => Promise<StudioGenerationResult>;
  recordingAi?: StudioRecordingAiAdapter;
}

export type StudioGenerationSelection = z.infer<typeof previewBodySchema>["selection"];

export interface StudioGenerationInput {
  project: StudioProject;
  selection: StudioGenerationSelection;
  workspaceRoot: string;
  projectPath: string;
  aiPolicy: { healing: "required"; review: "required" };
}

export type StudioGenerationResult =
  | {
      status: "completed";
      project: StudioProject;
      ai: {
        healing: { status: "accepted"; summary: string };
        review: { status: "accepted"; summary: string };
      };
    }
  | {
      status: "clarification";
      question: string;
      reason: string;
    };

export interface StudioServerHandle {
  url: string;
  port: number;
  workspaceRoot: string;
  close: () => Promise<void>;
}

interface StudioBootstrap {
  workspaceRoot: string;
  path: string;
  project: StudioProjectFile["project"] | null;
  issues: readonly { path: string; message: string; code: string }[];
  error: string;
  generationAvailable: boolean;
  recordingImportAvailable: boolean;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function shell(bootstrap: StudioBootstrap): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Domotion Studio</title>
</head>
<body>
  <div id="app"></div>
  <script>window.__DOMOTION_STUDIO__=${scriptJson(bootstrap)};</script>
  <script src="/client.js"></script>
</body>
</html>`;
}

const embeddedScrubberShell = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio scene preview</title></head><body>
<div id="app"></div>
<script>window.__SCRUBBER_BOOTSTRAP__={"svg":null,"name":null,"embedded":true};</script>
<script src="/scrubber/client.js"></script>
</body></html>`;

export async function startStudioServer(inputs: StudioServerInputs = {}): Promise<StudioServerHandle> {
  const workspaceRoot = resolve(inputs.workspaceRoot ?? process.cwd());
  const log = inputs.log ?? (() => {});
  let initialFile: StudioProjectFile | null = null;
  let initialError = "";
  let initialIssues: StudioBootstrap["issues"] = [];
  if (inputs.initialProjectPath != null) {
    try {
      initialFile = openStudioProjectFile(workspaceRoot, inputs.initialProjectPath);
    } catch (error) {
      initialError = error instanceof Error ? error.message : String(error);
      if (error instanceof StudioProjectValidationError) initialIssues = error.issues;
    }
  }
  const bootstrap: StudioBootstrap = {
    workspaceRoot,
    path: initialFile?.relativePath ?? inputs.initialProjectPath ?? "demo.studio.json",
    project: initialFile?.project ?? null,
    issues: initialIssues,
    error: initialError,
    generationAvailable: inputs.generate != null,
    recordingImportAvailable: inputs.recordingAi != null,
  };
  const html = shell(bootstrap);

  const page = (contentType: string, body: string) => (context: RouteContext) =>
    sendBuffer(context.res, 200, contentType, Buffer.from(body, "utf8"));
  const requireHead = (path: string, expectedHeadRevisionId: string): StudioProjectFile => {
    const current = openStudioProjectFile(workspaceRoot, path);
    assertHeadRevision(
      "authoring",
      expectedHeadRevisionId,
      current.project.review.headRevisionId,
      (message, code) => new StudioAuthoringError(message, code),
    );
    return current;
  };

  const routes: Record<string, RouteHandler> = {
    "GET /": page("text/html; charset=utf-8", html),
    "GET /index.html": page("text/html; charset=utf-8", html),
    "GET /client.js": page("application/javascript; charset=utf-8", STUDIO_CLIENT_JS),
    "GET /scrubber": page("text/html; charset=utf-8", embeddedScrubberShell),
    "GET /scrubber/client.js": page("application/javascript; charset=utf-8", SCRUBBER_CLIENT_JS),

    "POST /api/open": async ({ req, res }) => {
      const { path } = await readJsonBody(req, openBodySchema);
      sendJson(res, 200, projectResponse(openStudioProjectFile(workspaceRoot, path)));
    },

    "POST /api/create": async ({ req, res }) => {
      const body = await readJsonBody(req, createBodySchema);
      sendJson(res, 201, projectResponse(createStudioProjectFile(workspaceRoot, body.path, body)));
    },

    "POST /api/save": async ({ req, res }) => {
      const { path, project, expectedHeadRevisionId } = await readJsonBody(req, saveBodySchema);
      const current = requireHead(path, expectedHeadRevisionId);
      const proposed = validateStudioProject(project);
      const committed = validateStudioProject(
        commitStudioAuthoringRevision(current.project, proposed, { expectedHeadRevisionId }),
      );
      sendJson(res, 200, projectResponse(saveStudioProjectFile(workspaceRoot, path, committed)));
    },

    "POST /api/annotation": async ({ req, res }) => {
      const body = await readJsonBody(req, annotationBodySchema);
      const current = openStudioProjectFile(workspaceRoot, body.path);
      const command = studioAnnotationCommandSchema.parse({
        ...body.command,
        author: {
          kind: "human",
          ...(body.command.author.name == null ? {} : { name: body.command.author.name }),
        },
      });
      const result = applyStudioAnnotationCommand(current.project, command, {
        expectedHeadRevisionId: body.expectedHeadRevisionId,
      });
      sendJson(res, 200, projectResponse(saveStudioProjectFile(workspaceRoot, body.path, result.project)));
    },

    "POST /api/timeline": async ({ req, res }) => {
      const body = await readJsonBody(req, timelineBodySchema);
      const current = openStudioProjectFile(workspaceRoot, body.path);
      const result = applyStudioTimelineCommand(current.project, body.command, {
        expectedHeadRevisionId: body.expectedHeadRevisionId,
        author: { kind: "human" },
      });
      const saved = saveStudioProjectFile(workspaceRoot, body.path, result.project, result.project.updatedAt);
      sendJson(res, 200, { ...projectResponse(saved), inverse: result.inverse });
    },

    "POST /api/preview": async ({ req, res }) => {
      const body = await readJsonBody(req, previewBodySchema);
      const file = openStudioProjectFile(workspaceRoot, body.path);
      sendJson(res, 200, previewResponse(workspaceRoot, file, body.selection));
    },

    "POST /api/recording/import": async ({ req, res }) => {
      const body = await readJsonBody(req, recordingImportBodySchema);
      const current = requireHead(body.path, body.expectedHeadRevisionId);
      if (inputs.recordingAi == null)
        throw new HttpError(501, "Studio recording import requires configured AI healing and review adapters");
      const imported = await importStudioInteractionRecording(current.project, body.recording, {
        ai: inputs.recordingAi,
        generatorVersion: "1",
      });
      if (imported.status === "clarification") {
        sendJson(res, 200, { ...projectResponse(current), recordingImportResult: imported });
        return;
      }
      persistStudioRecordingEvidence(workspaceRoot, imported);
      const saved = saveStudioProjectFile(workspaceRoot, body.path, imported.project, imported.project.updatedAt);
      sendJson(res, 200, {
        ...projectResponse(saved),
        recordingImportResult: {
          status: "imported",
          sceneId: imported.scene.id,
          evidencePath: imported.evidencePath,
          ai: imported.ai,
        },
      });
    },

    "POST /api/generate": async ({ req, res }) => {
      const body = await readJsonBody(req, generationBodySchema);
      const current = requireHead(body.path, body.expectedHeadRevisionId);
      if (inputs.generate == null)
        throw new HttpError(501, "Studio generation requires a configured AI healing and review adapter");
      const generated = await inputs.generate({
        project: structuredClone(current.project),
        selection: body.selection,
        workspaceRoot,
        projectPath: current.path,
        aiPolicy: { healing: "required", review: "required" },
      });
      if (generated.status === "clarification") {
        z.strictObject({
          status: z.literal("clarification"),
          question: z.string().trim().min(1),
          reason: z.string().trim().min(1),
        }).parse(generated);
        sendJson(res, 200, { ...projectResponse(current), generationResult: generated });
        return;
      }
      const ai = generationAiSchema.parse(generated.ai);
      const next = validateStudioProject(generated.project);
      verifyGeneratedProject(current.project, next, body.selection);
      // The saved project must also be previewable: this resolves the artifact inside the workspace, bounds
      // its size and checks its provenance digest, so an artifact that cannot be shown is refused before
      // the save rather than discovered on the next preview. The response is not used.
      assertPreviewable(workspaceRoot, { ...current, project: next }, body.selection);
      const saved = saveStudioProjectFile(workspaceRoot, body.path, next);
      sendJson(res, 200, { ...projectResponse(saved), generationResult: { status: "completed", ai } });
    },
  };

  const handler = createRouter(routes, {
    mapError: errorResponse,
    onError: ({ req, path }, response) =>
      log(`Studio request ${req.method ?? "?"} ${path}: ${String(response.body.error)}`),
  });

  const local = await startLocalServer(handler, inputs.port ?? 0);
  return {
    url: local.url,
    port: local.port,
    workspaceRoot,
    close: local.close,
  };
}
