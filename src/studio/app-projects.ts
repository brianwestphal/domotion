import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nativePath from "node:path";
import {
  STUDIO_PROJECT_FORMAT,
  STUDIO_PROJECT_SCHEMA_ID,
  STUDIO_PROJECT_VERSION,
  type StudioProject,
} from "./project-schema.js";
import {
  parseStudioProjectJson,
  serializeStudioProject,
  validateStudioProject,
} from "./project.js";

export interface StudioPathApi {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  sep: string;
}

/** Resolve a UI-supplied project path without letting it escape the workspace. */
export function resolveStudioWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  pathApi: StudioPathApi = nativePath,
): string {
  const requested = requestedPath.trim();
  if (requested === "") throw new Error("project path is required");
  const root = pathApi.resolve(workspaceRoot);
  const resolved = pathApi.resolve(root, requested);
  const relative = pathApi.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(`project path must stay inside the Studio workspace: ${root}`);
  }
  if (pathApi.extname(resolved).toLowerCase() !== ".json") {
    throw new Error("Studio project files must use a .json extension");
  }
  return resolved;
}

export function relativeStudioProjectPath(
  workspaceRoot: string,
  absolutePath: string,
  pathApi: StudioPathApi = nativePath,
): string {
  return pathApi.relative(pathApi.resolve(workspaceRoot), absolutePath);
}

function idSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "untitled";
}

export interface CreateStudioProjectOptions {
  title: string;
  width?: number;
  height?: number;
  createdAt?: string;
}

/** Create the smallest useful Studio document: one editable narrative + title scene. */
export function createStudioProjectDocument(options: CreateStudioProjectOptions): StudioProject {
  const title = options.title.trim();
  if (title === "") throw new Error("project title is required");
  const createdAt = options.createdAt ?? new Date().toISOString();
  const slug = idSlug(title);
  const revisionId = "revision-initial";
  const sceneId = "scene-opening";
  const beatId = "beat-opening";
  return validateStudioProject({
    $schema: STUDIO_PROJECT_SCHEMA_ID,
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: `project-${slug}`,
    createdAt,
    canvas: {
      width: options.width ?? 1280,
      height: options.height ?? 720,
      background: "#0b1020",
      title,
      desc: `${title} product demo`,
    },
    narrative: {
      title,
      objective: "Explain the product clearly and persuasively.",
      audience: "Prospective users",
      tone: "Confident, concise, and polished",
      beats: [{ id: beatId, title: "Opening", sceneIds: [sceneId] }],
    },
    scenes: [{
      id: sceneId,
      title: "Opening",
      narrativeBeatIds: [beatId],
      render: {
        kind: "storyboard",
        recipe: { template: "title-card", params: { title }, duration: 1600 },
      },
    }],
    review: {
      headRevisionId: revisionId,
      revisions: [{
        id: revisionId,
        createdAt,
        author: { kind: "human" },
        kind: "content",
        summary: "Created the Studio project.",
      }],
      annotations: [],
    },
    artifacts: [],
  });
}

export interface StudioProjectFile {
  path: string;
  relativePath: string;
  project: StudioProject;
}

export function openStudioProjectFile(workspaceRoot: string, requestedPath: string): StudioProjectFile {
  const path = resolveStudioWorkspacePath(workspaceRoot, requestedPath);
  const project = parseStudioProjectJson(readFileSync(path, "utf8"), `Studio project "${path}"`);
  return { path, relativePath: relativeStudioProjectPath(workspaceRoot, path), project };
}

function writeProjectAtomically(path: string, project: StudioProject): void {
  const temporary = nativePath.resolve(nativePath.dirname(path), `.${nativePath.basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serializeStudioProject(project), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createStudioProjectFile(
  workspaceRoot: string,
  requestedPath: string,
  options: CreateStudioProjectOptions,
): StudioProjectFile {
  const path = resolveStudioWorkspacePath(workspaceRoot, requestedPath);
  if (existsSync(path)) throw new Error(`project already exists: ${relativeStudioProjectPath(workspaceRoot, path)}`);
  mkdirSync(nativePath.dirname(path), { recursive: true });
  const project = createStudioProjectDocument(options);
  writeProjectAtomically(path, project);
  return { path, relativePath: relativeStudioProjectPath(workspaceRoot, path), project };
}
export function saveStudioProjectFile(
  workspaceRoot: string,
  requestedPath: string,
  rawProject: unknown,
  updatedAt = new Date().toISOString(),
): StudioProjectFile {
  const path = resolveStudioWorkspacePath(workspaceRoot, requestedPath);
  if (!existsSync(path)) throw new Error(`project does not exist: ${relativeStudioProjectPath(workspaceRoot, path)}`);
  const project = validateStudioProject({
    ...(rawProject as Record<string, unknown>),
    updatedAt,
  });
  writeProjectAtomically(path, project);
  return { path, relativePath: relativeStudioProjectPath(workspaceRoot, path), project };
}
