import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { startLocalServer } from "../utils/local-server.js";
import { StudioProjectValidationError } from "./project.js";
import {
  createStudioProjectFile,
  openStudioProjectFile,
  saveStudioProjectFile,
  type StudioProjectFile,
} from "./app-projects.js";
import { STUDIO_CLIENT_JS } from "./client.bundle.generated.js";

const pathField = z.string().trim().min(1, "project path is required").max(4096);
const openBodySchema = z.strictObject({ path: pathField });
const createBodySchema = z.strictObject({
  path: pathField,
  title: z.string().trim().min(1, "project title is required").max(240),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
});
const saveBodySchema = z.strictObject({ path: pathField, project: z.unknown() });

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
  return {
    path: file.relativePath,
    project: file.project,
    generation: {
      artifactCount: file.project.artifacts.length,
      scenes: file.project.scenes.map((scene) => ({
        id: scene.id,
        generated: file.project.artifacts.some((artifact) => artifact.sceneIds?.includes(scene.id) === true),
      })),
    },
  };
}

function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof StudioHttpError) return { status: error.status, body: { error: error.message } };
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
}

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
        const { path, project } = await readJsonBody(req, saveBodySchema);
        sendJson(res, 200, projectResponse(saveStudioProjectFile(workspaceRoot, path, project)));
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
