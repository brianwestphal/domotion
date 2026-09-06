import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { StoryboardConfig, StoryboardScene } from "../cli/storyboard.js";
import { validateStoryboardConfig } from "../cli/storyboard.js";
import {
  STUDIO_PROJECT_FORMAT,
  STUDIO_PROJECT_SCHEMA_ID,
  STUDIO_PROJECT_VERSION,
  studioProjectSchema,
  type StudioProject,
} from "./project-schema.js";

export interface StudioProjectValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** One error carries every actionable path instead of hiding after the first. */
export class StudioProjectValidationError extends Error {
  readonly issues: readonly StudioProjectValidationIssue[];

  constructor(issues: readonly StudioProjectValidationIssue[], source = "studio project") {
    super(`${source} is invalid:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "StudioProjectValidationError";
    this.issues = issues;
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "$";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : `.${String(part)}`;
  }
  return out;
}

function unsupportedVersionIssue(raw: unknown): StudioProjectValidationIssue | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw) || !("version" in raw)) return null;
  const version = (raw as { version?: unknown }).version;
  if (version === STUDIO_PROJECT_VERSION) return null;
  return {
    path: "$.version",
    code: "unsupported_version",
    message: `unsupported Studio project version ${JSON.stringify(version)}; this build supports version ${STUDIO_PROJECT_VERSION}`,
  };
}

export function validateStudioProject(raw: unknown, source = "studio project"): StudioProject {
  const unsupported = unsupportedVersionIssue(raw);
  if (unsupported != null) throw new StudioProjectValidationError([unsupported], source);

  const parsed = studioProjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StudioProjectValidationError(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
        code: issue.code,
      })),
      source,
    );
  }
  return parsed.data;
}

export function parseStudioProjectJson(text: string, source = "studio project JSON"): StudioProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StudioProjectValidationError(
      [{ path: "$", code: "invalid_json", message: `invalid JSON: ${detail}` }],
      source,
    );
  }
  return validateStudioProject(raw, source);
}

/** Canonical pretty JSON. Parsing first gives Studio-owned objects stable key order. */
export function serializeStudioProject(raw: unknown): string {
  return `${JSON.stringify(validateStudioProject(raw), null, 2)}\n`;
}

export function loadStudioProject(path: string): StudioProject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read Studio project "${path}": ${detail}`);
  }
  return parseStudioProjectJson(text, `Studio project "${path}"`);
}

export function saveStudioProject(path: string, raw: unknown): StudioProject {
  const project = validateStudioProject(raw);
  try {
    writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not save Studio project "${path}": ${detail}`);
  }
  return project;
}

export interface ImportStoryboardOptions {
  projectId?: string;
  narrativeTitle?: string;
  createdAt?: string;
  revisionId?: string;
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function sourceTitle(scene: StoryboardScene, index: number): string {
  if (scene.template != null) return `Template: ${scene.template}`;
  if (scene.capture != null) return `Capture: ${scene.capture.url ?? scene.capture.file}`;
  if (scene.cast != null) return `Terminal: ${scene.cast}`;
  if (scene.svg != null) return `SVG: ${scene.svg}`;
  return `Scene ${index + 1}`;
}

/**
 * One-way migration from the shipped storyboard recipe. The recipe remains
 * embedded verbatim under each stable Studio scene, so compilation can keep
 * delegating to the existing compositor without maintaining a second renderer.
 */
export function importStoryboardConfig(raw: unknown, options: ImportStoryboardOptions = {}): StudioProject {
  const storyboard = validateStoryboardConfig(raw);
  const fingerprint = shortHash(storyboard);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const revisionId = options.revisionId ?? `revision-import-${fingerprint}`;
  const occurrences = new Map<string, number>();
  const sceneIds = storyboard.scenes.map((scene) => {
    const digest = shortHash(scene);
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    return `scene-${digest}-${occurrence}`;
  });

  const beats = storyboard.scenes.map((scene, index) => ({
    id: `beat-${sceneIds[index]}`,
    title: sourceTitle(scene, index),
    sceneIds: [sceneIds[index]],
  }));

  const project: StudioProject = {
    $schema: STUDIO_PROJECT_SCHEMA_ID,
    format: STUDIO_PROJECT_FORMAT,
    version: STUDIO_PROJECT_VERSION,
    id: options.projectId ?? `project-${fingerprint}`,
    createdAt,
    canvas: {
      width: storyboard.width,
      height: storyboard.height,
      ...(storyboard.background != null ? { background: storyboard.background } : {}),
      ...(storyboard.title != null ? { title: storyboard.title } : {}),
      ...(storyboard.desc != null ? { desc: storyboard.desc } : {}),
    },
    narrative: {
      title: options.narrativeTitle ?? storyboard.title ?? "Imported storyboard",
      ...(storyboard.desc != null ? { summary: storyboard.desc } : {}),
      beats,
    },
    scenes: storyboard.scenes.map((recipe, index) => ({
      id: sceneIds[index],
      title: sourceTitle(recipe, index),
      narrativeBeatIds: [beats[index].id],
      render: { kind: "storyboard", recipe },
    })),
    ...(storyboard.cursor != null ? { playback: { cursor: storyboard.cursor } } : {}),
    review: {
      headRevisionId: revisionId,
      revisions: [{
        id: revisionId,
        createdAt,
        author: { kind: "system", name: "Domotion storyboard importer" },
        summary: "Imported the legacy storyboard recipe into Studio project version 1.",
      }],
      annotations: [],
    },
    artifacts: [],
    ...(storyboard.output != null ? { exportTargets: { svgPath: storyboard.output } } : {}),
  };
  return validateStudioProject(project);
}

/** Project the direct-storyboard subset back onto the existing compositor API. */
export function studioProjectToStoryboardConfig(raw: unknown): StoryboardConfig {
  const project = validateStudioProject(raw);
  const scenes = project.scenes.map((scene, index) => {
    if (scene.render.kind !== "storyboard") {
      throw new Error(`studio project: $.scenes[${index}].render is a composition and must be materialized before storyboard projection`);
    }
    if ((scene.treatments?.length ?? 0) > 0) {
      throw new Error(`studio project: $.scenes[${index}].treatments must be materialized by the Studio compiler before storyboard projection`);
    }
    return scene.render.recipe;
  });
  return validateStoryboardConfig({
    width: project.canvas.width,
    height: project.canvas.height,
    ...(project.exportTargets?.svgPath != null ? { output: project.exportTargets.svgPath } : {}),
    ...(project.canvas.background != null ? { background: project.canvas.background } : {}),
    ...(project.canvas.title != null ? { title: project.canvas.title } : {}),
    ...(project.canvas.desc != null ? { desc: project.canvas.desc } : {}),
    ...(project.playback?.cursor != null ? { cursor: project.playback.cursor } : {}),
    scenes,
  });
}
