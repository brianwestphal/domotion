import type {
  StudioLayer,
  StudioProject,
  StudioReviewAnnotation,
  StudioScene,
} from "./project-schema.js";

export type StudioAuthoringCommand =
  | { kind: "scene.add"; afterSceneId?: string; scene?: StudioScene }
  | { kind: "scene.duplicate"; sceneId: string }
  | { kind: "scene.remove"; sceneId: string }
  | { kind: "scene.move"; sceneId: string; toIndex: number }
  | { kind: "scene.update"; sceneId: string; patch: Partial<Pick<StudioScene, "title" | "description" | "generationInstructions" | "narrativeBeatIds" | "render" | "treatments">> }
  | { kind: "beat.add"; afterBeatId?: string; title?: string }
  | { kind: "beat.update"; beatId: string; title?: string; summary?: string | null }
  | { kind: "beat.remove"; beatId: string }
  | { kind: "restore"; project: StudioProject };

export interface StudioAuthoringResult {
  project: StudioProject;
  /** Exact snapshot suitable for a local single-step undo; server commits validate it. */
  undo: Extract<StudioAuthoringCommand, { kind: "restore" }>;
}

export interface ApplyStudioAuthoringOptions {
  id?: (prefix: string) => string;
}

export interface CommitStudioAuthoringOptions {
  expectedHeadRevisionId: string;
  now?: string;
  revisionId?: string;
}

export class StudioAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioAuthoringError";
  }
}

function defaultId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** The newest content revision; later review-only revisions do not stale a render. */
export function studioContentRevisionId(project: StudioProject): string {
  return [...project.review.revisions].reverse().find((revision) => revision.kind !== "review")?.id
    ?? project.review.revisions[0].id;
}

function authoredJson(project: StudioProject): string {
  const { review: _review, artifacts: _artifacts, updatedAt: _updatedAt, ...authored } = project;
  return JSON.stringify(authored);
}

/**
 * Commit a browser-authored project snapshot with optimistic concurrency and a
 * new content revision. Review history and generated artifacts are server-owned.
 */
export function commitStudioAuthoringRevision(
  rawCurrent: StudioProject,
  rawProposed: StudioProject,
  options: CommitStudioAuthoringOptions,
): StudioProject {
  const current = structuredClone(rawCurrent);
  const proposed = structuredClone(rawProposed);
  if (current.review.headRevisionId !== options.expectedHeadRevisionId) {
    throw new StudioAuthoringError(`stale authoring change: expected review head ${options.expectedHeadRevisionId}, found ${current.review.headRevisionId}`);
  }
  if (JSON.stringify(proposed.review) !== JSON.stringify(current.review)) {
    throw new StudioAuthoringError("review history must be changed through /api/annotation");
  }
  if (JSON.stringify(proposed.artifacts) !== JSON.stringify(current.artifacts)) {
    throw new StudioAuthoringError("generated artifacts must be changed through the generation API (/api/generate)");
  }
  if (authoredJson(proposed) === authoredJson(current)) return current;
  const now = options.now ?? new Date().toISOString();
  const revisionId = options.revisionId ?? defaultId("revision-content");
  if (current.review.revisions.some((revision) => revision.id === revisionId)) {
    throw new StudioAuthoringError(`revision id already exists: ${revisionId}`);
  }
  proposed.review = structuredClone(current.review);
  proposed.artifacts = structuredClone(current.artifacts);
  proposed.review.revisions.push({
    id: revisionId,
    parentId: current.review.headRevisionId,
    createdAt: now,
    author: { kind: "human" },
    kind: "content",
    summary: "Saved Studio authoring changes.",
    metadata: { operation: "studio.authoring.save" },
  });
  proposed.review.headRevisionId = revisionId;
  proposed.updatedAt = now;
  return proposed;
}

function uniqueId(project: StudioProject, prefix: string, id: (prefix: string) => string): string {
  const occupied = new Set<string>();
  const layers = (values: readonly StudioLayer[]): void => values.forEach((layer) => {
    occupied.add(layer.id);
    if (layer.kind === "composition") layers(layer.composition.layers);
  });
  project.scenes.forEach((scene) => {
    occupied.add(scene.id);
    scene.tracks?.forEach((track) => {
      occupied.add(track.id);
      track.events.forEach((event) => occupied.add(event.id));
    });
    if (scene.render.kind === "composition") layers(scene.render.composition.layers);
  });
  project.narrative.beats.forEach((beat) => occupied.add(beat.id));
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = id(prefix);
    if (!occupied.has(candidate)) return candidate;
  }
  throw new StudioAuthoringError(`could not allocate a unique ${prefix} id`);
}

function sceneById(project: StudioProject, sceneId: string): StudioScene {
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  if (scene == null) throw new StudioAuthoringError(`unknown scene id: ${sceneId}`);
  return scene;
}

function annotationReferencesScene(annotation: StudioReviewAnnotation, scene: StudioScene): boolean {
  const target = annotation.target;
  if (target?.scope?.kind === "scene" && target.scope.sceneId === scene.id) return true;
  if (target?.sceneId === scene.id) return true;
  const trackIds = new Set(scene.tracks?.map((track) => track.id) ?? []);
  const eventIds = new Set(scene.tracks?.flatMap((track) => track.events.map((event) => event.id)) ?? []);
  const layerIds = new Set<string>();
  const collect = (layers: readonly StudioLayer[]): void => layers.forEach((layer) => {
    layerIds.add(layer.id);
    if (layer.kind === "composition") collect(layer.composition.layers);
  });
  if (scene.render.kind === "composition") collect(scene.render.composition.layers);
  return (target?.trackId != null && trackIds.has(target.trackId))
    || (target?.eventId != null && eventIds.has(target.eventId))
    || (target?.layerId != null && layerIds.has(target.layerId));
}

function duplicateScene(project: StudioProject, source: StudioScene, id: (prefix: string) => string): StudioScene {
  const copy = structuredClone(source);
  copy.id = uniqueId(project, "scene", id);
  copy.title = `${source.title ?? "Scene"} copy`;
  copy.tracks?.forEach((track) => {
    track.id = uniqueId(project, "track", id);
    track.events.forEach((event) => { event.id = uniqueId(project, "event", id); });
  });
  const remapLayers = (layers: StudioLayer[]): void => layers.forEach((layer) => {
    layer.id = uniqueId(project, "layer", id);
    if (layer.kind === "composition") remapLayers(layer.composition.layers);
  });
  if (copy.render.kind === "composition") remapLayers(copy.render.composition.layers);
  return copy;
}

function defaultScene(project: StudioProject, id: (prefix: string) => string): StudioScene {
  const sceneId = uniqueId(project, "scene", id);
  const beatId = project.narrative.beats[0]?.id;
  return {
    id: sceneId,
    title: "New scene",
    ...(beatId == null ? {} : { narrativeBeatIds: [beatId] }),
    render: {
      kind: "storyboard",
      recipe: { template: "title-card", params: { title: "New scene" }, duration: 1600 },
    },
  };
}

/** Apply one validated authoring operation without mutating its input. */
export function applyStudioAuthoringCommand(
  rawProject: StudioProject,
  command: StudioAuthoringCommand,
  options: ApplyStudioAuthoringOptions = {},
): StudioAuthoringResult {
  const before = structuredClone(rawProject);
  const next = command.kind === "restore"
    ? structuredClone(command.project)
    : structuredClone(before);
  const id = options.id ?? defaultId;

  if (command.kind === "scene.add") {
    const scene = command.scene == null ? defaultScene(next, id) : structuredClone(command.scene);
    if (next.scenes.some((candidate) => candidate.id === scene.id)) throw new StudioAuthoringError(`scene id already exists: ${scene.id}`);
    const after = command.afterSceneId == null ? next.scenes.length - 1 : next.scenes.findIndex((candidate) => candidate.id === command.afterSceneId);
    if (after < 0) throw new StudioAuthoringError(`unknown scene id: ${command.afterSceneId}`);
    next.scenes.splice(after + 1, 0, scene);
    for (const beatId of scene.narrativeBeatIds ?? []) {
      const beat = next.narrative.beats.find((candidate) => candidate.id === beatId);
      if (beat != null && !beat.sceneIds.includes(scene.id)) beat.sceneIds.push(scene.id);
    }
  } else if (command.kind === "scene.duplicate") {
    const sourceIndex = next.scenes.findIndex((candidate) => candidate.id === command.sceneId);
    if (sourceIndex < 0) throw new StudioAuthoringError(`unknown scene id: ${command.sceneId}`);
    const copy = duplicateScene(next, next.scenes[sourceIndex], id);
    next.scenes.splice(sourceIndex + 1, 0, copy);
    next.narrative.beats.forEach((beat) => {
      const at = beat.sceneIds.indexOf(command.sceneId);
      if (at >= 0) beat.sceneIds.splice(at + 1, 0, copy.id);
    });
  } else if (command.kind === "scene.remove") {
    if (next.scenes.length === 1) throw new StudioAuthoringError("a Studio project must keep at least one scene");
    const scene = sceneById(next, command.sceneId);
    if (next.review.annotations.some((annotation) => annotationReferencesScene(annotation, scene))) {
      throw new StudioAuthoringError(`scene ${scene.id} has review annotations; move or resolve their scope before removing it`);
    }
    next.scenes = next.scenes.filter((candidate) => candidate.id !== scene.id);
    next.narrative.beats.forEach((beat) => { beat.sceneIds = beat.sceneIds.filter((sceneId) => sceneId !== scene.id); });
    next.artifacts = next.artifacts.filter((artifact) => artifact.sceneIds?.includes(scene.id) !== true);
  } else if (command.kind === "scene.move") {
    const from = next.scenes.findIndex((candidate) => candidate.id === command.sceneId);
    if (from < 0) throw new StudioAuthoringError(`unknown scene id: ${command.sceneId}`);
    const to = Math.max(0, Math.min(next.scenes.length - 1, command.toIndex));
    const [scene] = next.scenes.splice(from, 1);
    next.scenes.splice(to, 0, scene);
    next.narrative.beats.forEach((beat) => {
      beat.sceneIds = next.scenes.filter((candidate) => beat.sceneIds.includes(candidate.id)).map((candidate) => candidate.id);
    });
  } else if (command.kind === "scene.update") {
    Object.assign(sceneById(next, command.sceneId), structuredClone(command.patch));
    next.narrative.beats.forEach((beat) => {
      beat.sceneIds = beat.sceneIds.filter((sceneId) => sceneId !== command.sceneId);
      if (command.patch.narrativeBeatIds?.includes(beat.id)) beat.sceneIds.push(command.sceneId);
      beat.sceneIds = next.scenes.filter((scene) => beat.sceneIds.includes(scene.id)).map((scene) => scene.id);
    });
  } else if (command.kind === "beat.add") {
    const beat = { id: uniqueId(next, "beat", id), title: command.title?.trim() || "New beat", sceneIds: [] as string[] };
    const after = command.afterBeatId == null ? next.narrative.beats.length - 1 : next.narrative.beats.findIndex((candidate) => candidate.id === command.afterBeatId);
    if (command.afterBeatId != null && after < 0) throw new StudioAuthoringError(`unknown narrative beat id: ${command.afterBeatId}`);
    next.narrative.beats.splice(after + 1, 0, beat);
  } else if (command.kind === "beat.update") {
    const beat = next.narrative.beats.find((candidate) => candidate.id === command.beatId);
    if (beat == null) throw new StudioAuthoringError(`unknown narrative beat id: ${command.beatId}`);
    if (command.title != null) beat.title = command.title;
    if (command.summary === null) delete beat.summary;
    else if (command.summary !== undefined) beat.summary = command.summary;
  } else if (command.kind === "beat.remove") {
    const index = next.narrative.beats.findIndex((candidate) => candidate.id === command.beatId);
    if (index < 0) throw new StudioAuthoringError(`unknown narrative beat id: ${command.beatId}`);
    next.narrative.beats.splice(index, 1);
    next.scenes.forEach((scene) => {
      if (scene.narrativeBeatIds == null) return;
      scene.narrativeBeatIds = scene.narrativeBeatIds.filter((beatId) => beatId !== command.beatId);
      if (scene.narrativeBeatIds.length === 0) delete scene.narrativeBeatIds;
    });
  }

  if (JSON.stringify(before) === JSON.stringify(next)) throw new StudioAuthoringError("the authoring command did not change the project");
  return { project: next, undo: { kind: "restore", project: before } };
}
