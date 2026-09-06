import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { startLocalServer } from "../utils/local-server.js";
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
import {
  commitStudioAuthoringRevision,
  studioContentRevisionId,
  StudioAuthoringError,
} from "./authoring.js";
import {
  importStudioInteractionRecording,
  persistStudioRecordingEvidence,
  StudioRecordingError,
  type StudioRecordingAiAdapter,
} from "./recording.js";
import type { StudioArtifact, StudioProject } from "./project-schema.js";

const pathField = z.string().trim().min(1, "project path is required").max(4096);
const openBodySchema = z.strictObject({ path: pathField });
const createBodySchema = z.strictObject({
  path: pathField,
  title: z.string().trim().min(1, "project title is required").max(240),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
});
const saveBodySchema = z.strictObject({ path: pathField, expectedHeadRevisionId: z.string().min(1), project: z.unknown() });
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
const generationAiSchema = z.strictObject({
  healing: z.strictObject({ status: z.literal("accepted"), summary: z.string().trim().min(1) }),
  review: z.strictObject({ status: z.literal("accepted"), summary: z.string().trim().min(1) }),
});

class StudioHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function readJsonBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new StudioHttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioHttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new StudioHttpError(400, `invalid request: ${message}`);
  }
  return parsed.data;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, buffer: Buffer): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendBuffer(res, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(value), "utf8"));
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
        generated: file.project.artifacts.some((artifact) => artifact.sourceRevisionId === contentRevisionId && artifact.sceneIds?.includes(scene.id) === true),
      })),
    },
  };
}

function previewArtifact(project: StudioProject, selection: z.infer<typeof previewBodySchema>["selection"]): StudioArtifact {
  if (selection.kind === "scene" && !project.scenes.some((scene) => scene.id === selection.sceneId)) {
    throw new StudioHttpError(404, `scene does not exist: ${selection.sceneId}`);
  }
  const candidates = project.artifacts
    .filter((artifact) => artifact.kind === "svg" && artifact.sourceRevisionId === studioContentRevisionId(project))
    .filter((artifact) => selection.kind === "story"
      ? artifact.sceneIds == null || artifact.sceneIds.length === 0
      : artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === selection.sceneId)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  if (candidates.length === 0) {
    throw new StudioHttpError(404, selection.kind === "story"
      ? "the project has no generated whole-story SVG artifact"
      : `scene ${selection.sceneId} has no generated SVG artifact`);
  }
  return candidates[0];
}

function authoredDuration(project: StudioProject, selection: z.infer<typeof previewBodySchema>["selection"]): number {
  const sceneDuration = (scene: StudioProject["scenes"][number]): number => {
    if (scene.render.kind === "composition") return scene.render.duration ?? scene.render.composition.duration ?? 1000;
    return scene.render.recipe.duration ?? 1000;
  };
  if (selection.kind === "scene") return sceneDuration(project.scenes.find((scene) => scene.id === selection.sceneId)!);
  return project.scenes.reduce((total, scene) => total + sceneDuration(scene), 0);
}

function previewResponse(workspaceRoot: string, file: StudioProjectFile, selection: z.infer<typeof previewBodySchema>["selection"]): Record<string, unknown> {
  const artifact = previewArtifact(file.project, selection);
  const artifactPath = resolveStudioWorkspaceSvgPath(workspaceRoot, artifact.path);
  const realRoot = realpathSync(workspaceRoot);
  const realArtifactPath = realpathSync(artifactPath);
  const realRelative = relative(realRoot, realArtifactPath);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new StudioHttpError(400, `preview artifact resolves outside the Studio workspace: ${artifact.id}`);
  }
  if (statSync(realArtifactPath).size > 64 * 1024 * 1024) throw new StudioHttpError(413, "preview artifact is too large");
  const svg = readFileSync(realArtifactPath, "utf8");
  if (artifact.sha256 != null) {
    const actual = createHash("sha256").update(svg).digest("hex");
    if (actual !== artifact.sha256) throw new StudioHttpError(409, `preview artifact digest does not match project provenance: ${artifact.id}`);
  }
  const metadataDuration = artifact.metadata?.durationMs;
  const durationMs = typeof metadataDuration === "number" && Number.isFinite(metadataDuration) && metadataDuration > 0
    ? metadataDuration
    : detectAnimationPeriodMs(svg) ?? authoredDuration(file.project, selection);
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

function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof StudioHttpError) return { status: error.status, body: { error: error.message } };
  if (error instanceof StudioAnnotationError) return { status: error.message.startsWith("stale annotation change:") ? 409 : 400, body: { error: error.message } };
  if (error instanceof StudioAuthoringError) return { status: error.message.startsWith("stale authoring change:") ? 409 : 400, body: { error: error.message } };
  if (error instanceof StudioRecordingError) return { status: 400, body: { error: error.message } };
  if (error instanceof StudioProjectValidationError) {
    return { status: 400, body: { error: error.message, issues: error.issues } };
  }
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: 404, body: { error: error.message } };
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

export type StudioGenerationResult = {
  status: "completed";
  project: StudioProject;
  ai: {
    healing: { status: "accepted"; summary: string };
    review: { status: "accepted"; summary: string };
  };
} | {
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

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        sendBuffer(res, 200, "text/html; charset=utf-8", Buffer.from(html, "utf8"));
        return;
      }
      if (req.method === "GET" && url === "/client.js") {
        sendBuffer(res, 200, "application/javascript; charset=utf-8", Buffer.from(STUDIO_CLIENT_JS, "utf8"));
        return;
      }
      if (req.method === "GET" && url === "/scrubber") {
        sendBuffer(res, 200, "text/html; charset=utf-8", Buffer.from(embeddedScrubberShell, "utf8"));
        return;
      }
      if (req.method === "GET" && url === "/scrubber/client.js") {
        sendBuffer(res, 200, "application/javascript; charset=utf-8", Buffer.from(SCRUBBER_CLIENT_JS, "utf8"));
        return;
      }
      if (req.method === "POST" && url === "/api/open") {
        const { path } = await readJsonBody(req, openBodySchema);
        sendJson(res, 200, projectResponse(openStudioProjectFile(workspaceRoot, path)));
        return;
      }
      if (req.method === "POST" && url === "/api/create") {
        const body = await readJsonBody(req, createBodySchema);
        sendJson(res, 201, projectResponse(createStudioProjectFile(workspaceRoot, body.path, body)));
        return;
      }
      if (req.method === "POST" && url === "/api/save") {
        const { path, project, expectedHeadRevisionId } = await readJsonBody(req, saveBodySchema);
        const current = openStudioProjectFile(workspaceRoot, path);
        if (current.project.review.headRevisionId !== expectedHeadRevisionId) {
          throw new StudioAnnotationError(`stale annotation change: expected review head ${expectedHeadRevisionId}, found ${current.project.review.headRevisionId}`);
        }
        const proposed = validateStudioProject(project);
        const committed = validateStudioProject(commitStudioAuthoringRevision(current.project, proposed, { expectedHeadRevisionId }));
        sendJson(res, 200, projectResponse(saveStudioProjectFile(workspaceRoot, path, committed)));
        return;
      }
      if (req.method === "POST" && url === "/api/annotation") {
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
        return;
      }
      if (req.method === "POST" && url === "/api/preview") {
        const body = await readJsonBody(req, previewBodySchema);
        const file = openStudioProjectFile(workspaceRoot, body.path);
        sendJson(res, 200, previewResponse(workspaceRoot, file, body.selection));
        return;
      }
      if (req.method === "POST" && url === "/api/recording/import") {
        const body = await readJsonBody(req, recordingImportBodySchema);
        const current = openStudioProjectFile(workspaceRoot, body.path);
        if (current.project.review.headRevisionId !== body.expectedHeadRevisionId) {
          throw new StudioAuthoringError(`stale authoring change: expected review head ${body.expectedHeadRevisionId}, found ${current.project.review.headRevisionId}`);
        }
        if (inputs.recordingAi == null) throw new StudioHttpError(501, "Studio recording import requires configured AI healing and review adapters");
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
        return;
      }
      if (req.method === "POST" && url === "/api/generate") {
        const body = await readJsonBody(req, generationBodySchema);
        const current = openStudioProjectFile(workspaceRoot, body.path);
        if (current.project.review.headRevisionId !== body.expectedHeadRevisionId) {
          throw new StudioAuthoringError(`stale authoring change: expected review head ${body.expectedHeadRevisionId}, found ${current.project.review.headRevisionId}`);
        }
        if (inputs.generate == null) throw new StudioHttpError(501, "Studio generation requires a configured AI healing and review adapter");
        const generated = await inputs.generate({
          project: structuredClone(current.project),
          selection: body.selection,
          workspaceRoot,
          projectPath: current.path,
          aiPolicy: { healing: "required", review: "required" },
        });
        if (generated.status === "clarification") {
          z.strictObject({ status: z.literal("clarification"), question: z.string().trim().min(1), reason: z.string().trim().min(1) }).parse(generated);
          sendJson(res, 200, { ...projectResponse(current), generationResult: generated });
          return;
        }
        const ai = generationAiSchema.parse(generated.ai);
        const next = validateStudioProject(generated.project);
        const authored = ({ review: _review, artifacts: _artifacts, updatedAt: _updatedAt, ...value }: StudioProject): unknown => value;
        if (!isDeepStrictEqual(authored(next), authored(current.project))) {
          throw new StudioHttpError(400, "generation adapters must preserve authored narrative, scenes, and settings");
        }
        if (!isDeepStrictEqual(next.review.revisions.slice(0, current.project.review.revisions.length), current.project.review.revisions)
          || !isDeepStrictEqual(next.review.annotations.slice(0, current.project.review.annotations.length), current.project.review.annotations)) {
          throw new StudioHttpError(400, "generation adapters must preserve existing review provenance");
        }
        if (studioContentRevisionId(next) !== studioContentRevisionId(current.project)) {
          throw new StudioHttpError(400, "generation adapters cannot replace the saved authoring content revision");
        }
        if (current.project.artifacts.some((artifact) => !next.artifacts.some((candidate) => isDeepStrictEqual(candidate, artifact)))) {
          throw new StudioHttpError(400, "generation adapters must preserve existing artifacts");
        }
        const contentRevisionId = studioContentRevisionId(next);
        const matches = next.artifacts.some((artifact) => artifact.kind === "svg"
          && artifact.sourceRevisionId === contentRevisionId
          && (body.selection.kind === "story"
            ? artifact.sceneIds == null || artifact.sceneIds.length === 0
            : artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === body.selection.sceneId));
        if (!matches) throw new StudioHttpError(400, "generation adapter did not return a current SVG artifact for the requested selection");
        previewResponse(workspaceRoot, { ...current, project: next }, body.selection);
        const saved = saveStudioProjectFile(workspaceRoot, body.path, next);
        sendJson(res, 200, { ...projectResponse(saved), generationResult: { status: "completed", ai } });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${url}`);
    } catch (error) {
      const response = errorResponse(error);
      log(`Studio request ${req.method ?? "?"} ${url}: ${String(response.body.error)}`);
      if (!res.headersSent) sendJson(res, response.status, response.body);
      else res.end();
    }
  };

  const local = await startLocalServer(handler, inputs.port ?? 0);
  return {
    url: local.url,
    port: local.port,
    workspaceRoot,
    close: local.close,
  };
}
