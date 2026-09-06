import { z } from "zod";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import type {
  StudioLayer,
  StudioProject,
  StudioReviewAuthor,
  StudioScene,
} from "./project-schema.js";

export const STUDIO_TIMELINE_KINDS = [
  "scene", "semantic-action", "cursor", "overlay", "transition",
  "treatment", "annotation", "animation",
] as const;

export type StudioTimelineKind = typeof STUDIO_TIMELINE_KINDS[number];

export interface StudioTimelineItem {
  id: string;
  kind: StudioTimelineKind;
  rowId: string;
  label: string;
  startMs: number;
  endMs: number;
  sceneId?: string;
  trackId?: string;
  eventId?: string;
  layerId?: string;
  annotationId?: string;
  /** Moving a scene would reorder the story, so scene blocks resize only. */
  movable: boolean;
  resizable: boolean;
}

export interface StudioTimelineRow {
  id: string;
  kind: StudioTimelineKind;
  label: string;
  items: StudioTimelineItem[];
}

export interface StudioTimeline {
  durationMs: number;
  rows: StudioTimelineRow[];
  items: StudioTimelineItem[];
}

export const studioTimelineTimingChangeSchema = z.strictObject({
  itemId: z.string().trim().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
}).refine((change) => change.endMs >= change.startMs, {
  path: ["endMs"],
  message: "end must not be before start",
});

/** Deliberately small: both Studio UI gestures and AI tools submit exact timing overrides. */
export const studioTimelineCommandSchema = z.strictObject({
  kind: z.literal("set-timing"),
  changes: z.array(studioTimelineTimingChangeSchema).min(1),
});

export type StudioTimelineCommand = z.infer<typeof studioTimelineCommandSchema>;

export interface ApplyStudioTimelineOptions {
  expectedHeadRevisionId?: string;
  author?: StudioReviewAuthor;
  now?: string;
  revisionId?: string;
}

export interface StudioTimelineResult {
  project: StudioProject;
  inverse: StudioTimelineCommand;
  revisionId: string;
}

export class StudioTimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioTimelineError";
  }
}

type ScenePresentation = Pick<
  Extract<StudioScene["render"], { kind: "storyboard" }>["recipe"],
  "duration" | "transition" | "overlays"
>;

function scenePresentation(scene: StudioScene): ScenePresentation {
  return scene.render.kind === "storyboard" ? scene.render.recipe : scene.render;
}

export function studioSceneDurationMs(scene: StudioScene): number {
  return scene.render.kind === "composition"
    ? scene.render.duration ?? scene.render.composition.duration ?? 1000
    : scene.render.recipe.duration ?? 1000;
}

function windows(project: StudioProject): Array<{ scene: StudioScene; index: number; startMs: number; holdEndMs: number; endMs: number }> {
  let startMs = 0;
  return project.scenes.map((scene, index) => {
    const duration = studioSceneDurationMs(scene);
    const transition = scenePresentation(scene).transition;
    const endMs = startMs + frameAdvanceMs({ duration, transition });
    const result = { scene, index, startMs, holdEndMs: startMs + duration, endMs };
    startMs = endMs;
    return result;
  });
}

function row(rows: Map<string, StudioTimelineRow>, id: string, kind: StudioTimelineKind, label: string): StudioTimelineRow {
  let value = rows.get(id);
  if (value == null) {
    value = { id, kind, label, items: [] };
    rows.set(id, value);
  }
  return value;
}

function add(rows: Map<string, StudioTimelineRow>, rowId: string, kind: StudioTimelineKind, rowLabel: string, item: Omit<StudioTimelineItem, "rowId" | "kind">): void {
  row(rows, rowId, kind, rowLabel).items.push({ ...item, rowId, kind });
}

function overlayLabel(value: { kind: string }, index: number): string {
  return `${value.kind} overlay ${index + 1}`;
}

function collectAnimations(
  rows: Map<string, StudioTimelineRow>,
  scene: StudioScene,
  layers: readonly StudioLayer[],
  sceneStartMs: number,
  path: number[] = [],
): void {
  layers.forEach((layer, layerIndex) => {
    const nextPath = [...path, layerIndex];
    if (layer.kind === "composition") {
      collectAnimations(rows, scene, layer.composition.layers, sceneStartMs, nextPath);
      return;
    }
    const layerStart = layer.source.start ?? 0;
    (layer.source.animations ?? []).forEach((animation, animationIndex) => {
      const startMs = sceneStartMs + layerStart + (animation.start ?? 0);
      const durationMs = animation.duration ?? 500;
      add(rows, `animation:${scene.id}`, "animation", `Animations · ${scene.title ?? scene.id}`, {
        id: `animation:${scene.id}:${nextPath.join(".")}:${animationIndex}`,
        label: `${layer.name ?? layer.id} · ${animation.property}`,
        startMs,
        endMs: startMs + durationMs,
        sceneId: scene.id,
        layerId: layer.id,
        movable: true,
        resizable: true,
      });
    });
  });
}

/** Project every authored timing primitive onto the compositor's absolute clock. */
export function buildStudioTimeline(rawProject: StudioProject): StudioTimeline {
  const project = rawProject;
  const rows = new Map<string, StudioTimelineRow>();
  for (const kind of STUDIO_TIMELINE_KINDS) row(rows, kind, kind, kind.replace("-", " "));
  const sceneWindows = windows(project);

  sceneWindows.forEach(({ scene, index, startMs, holdEndMs, endMs }) => {
    add(rows, "scene", "scene", "Scenes", {
      id: `scene:${scene.id}`, label: scene.title ?? `Scene ${index + 1}`,
      startMs, endMs: holdEndMs, sceneId: scene.id, movable: false, resizable: true,
    });
    (scene.tracks ?? []).forEach((track) => track.events.forEach((event) => {
      const eventStart = startMs + event.atMs;
      add(rows, `semantic:${scene.id}:${track.id}`, "semantic-action", track.name ?? `Actions · ${scene.title ?? scene.id}`, {
        id: `semantic:${scene.id}:${track.id}:${event.id}`,
        label: event.kind,
        startMs: eventStart,
        endMs: eventStart + (event.durationMs ?? 1),
        sceneId: scene.id,
        trackId: track.id,
        eventId: event.id,
        movable: true,
        resizable: true,
      });
    }));
    (scenePresentation(scene).overlays ?? []).forEach((overlay, overlayIndex) => {
      const overlayStart = startMs + (overlay.delay ?? 0);
      add(rows, `overlay:${scene.id}`, "overlay", `Overlays · ${scene.title ?? scene.id}`, {
        id: `overlay:${scene.id}:${overlayIndex}`,
        label: overlayLabel(overlay, overlayIndex),
        startMs: overlayStart,
        endMs: startMs + (overlay.endAt ?? studioSceneDurationMs(scene)),
        sceneId: scene.id,
        movable: true,
        resizable: true,
      });
    });
    add(rows, "transition", "transition", "Transitions", {
      id: `transition:${scene.id}`,
      label: `${scenePresentation(scene).transition?.type ?? "crossfade"} after ${scene.title ?? scene.id}`,
      startMs: holdEndMs,
      endMs,
      sceneId: scene.id,
      movable: false,
      resizable: true,
    });
    (scene.treatments ?? []).forEach((treatment, treatmentIndex) => {
      if (!("timing" in treatment)) return;
      const treatmentStart = startMs + (treatment.timing?.startMs ?? 0);
      const durationMs = treatment.timing?.durationMs ?? 500;
      add(rows, `treatment:${scene.id}`, "treatment", `Treatments · ${scene.title ?? scene.id}`, {
        id: `treatment:${scene.id}:${treatmentIndex}`,
        label: treatment.kind,
        startMs: treatmentStart,
        endMs: treatmentStart + durationMs,
        sceneId: scene.id,
        movable: true,
        resizable: true,
      });
    });
    if (scene.render.kind === "composition") collectAnimations(rows, scene, scene.render.composition.layers, startMs);
  });

  project.playback?.cursor?.events.forEach((event, index) => {
    const sceneWindow = sceneWindows[event.frame];
    if (sceneWindow == null) return;
    const startMs = sceneWindow.startMs + event.at;
    add(rows, "cursor", "cursor", "Cursor", {
      id: `cursor:${index}`,
      label: event.type,
      startMs,
      endMs: startMs + (event.duration ?? 1),
      sceneId: sceneWindow.scene.id,
      movable: true,
      resizable: true,
    });
  });

  project.review.annotations.forEach((annotation) => {
    const time = annotation.target?.time ?? (annotation.target?.atMs == null ? undefined : {
      pointMs: annotation.target.atMs,
      ...(annotation.target.endMs == null ? {} : { range: { startMs: annotation.target.atMs, endMs: annotation.target.endMs } }),
    });
    if (time == null) return;
    const sceneId = annotation.target?.scope?.kind === "scene" ? annotation.target.scope.sceneId : annotation.target?.sceneId;
    const sceneStart = sceneId == null ? 0 : sceneWindows.find((entry) => entry.scene.id === sceneId)?.startMs ?? 0;
    const localStart = time.range?.startMs ?? time.pointMs ?? 0;
    const localEnd = time.range?.endMs ?? time.pointMs ?? localStart;
    add(rows, "annotation", "annotation", "Annotations", {
      id: `annotation:${annotation.id}`,
      label: annotation.body,
      startMs: sceneStart + localStart,
      endMs: sceneStart + localEnd,
      ...(sceneId == null ? {} : { sceneId }),
      annotationId: annotation.id,
      movable: true,
      resizable: true,
    });
  });

  const projectedRows = [...rows.values()].filter((candidate) => candidate.items.length > 0);
  const items = projectedRows.flatMap((candidate) => candidate.items);
  return {
    durationMs: sceneWindows.at(-1)?.endMs ?? 0,
    rows: projectedRows,
    items,
  };
}

function splitId(id: string, expected: StudioTimelineKind): string[] {
  const parts = id.split(":");
  const prefix = expected === "semantic-action" ? "semantic" : expected;
  if (parts[0] !== prefix) throw new StudioTimelineError(`timeline item identity changed: ${id}`);
  return parts.slice(1);
}

function requireDuration(change: z.infer<typeof studioTimelineTimingChangeSchema>, kind: StudioTimelineKind, allowZero = false): number {
  const duration = change.endMs - change.startMs;
  if (duration < 0 || (!allowZero && duration === 0)) throw new StudioTimelineError(`${kind} timing requires a ${allowZero ? "non-negative" : "positive"} duration`);
  return duration;
}

function sourceLayerAt(layers: StudioLayer[], indices: readonly number[]): Extract<StudioLayer, { kind: "source" }> {
  let current = layers;
  let layer: StudioLayer | undefined;
  indices.forEach((index, depth) => {
    layer = current[index];
    if (layer == null) throw new StudioTimelineError("animation layer no longer exists");
    if (depth < indices.length - 1) {
      if (layer.kind !== "composition") throw new StudioTimelineError("animation layer path is no longer a composition");
      current = layer.composition.layers;
    }
  });
  if (layer?.kind !== "source") throw new StudioTimelineError("animation source layer no longer exists");
  return layer;
}

function setSceneDuration(scene: StudioScene, duration: number): void {
  if (!(duration > 0)) throw new StudioTimelineError("scene timing requires a positive duration");
  if (scene.render.kind === "storyboard") scene.render.recipe.duration = duration;
  else scene.render.duration = duration;
}

function setSceneTransition(scene: StudioScene, duration: number): void {
  const presentation = scenePresentation(scene);
  const previous = presentation.transition;
  const transition = previous == null ? { type: "crossfade" as const, duration } : { ...previous, duration };
  if (scene.render.kind === "storyboard") scene.render.recipe.transition = transition;
  else scene.render.transition = transition;
}

function applyOne(project: StudioProject, before: StudioTimelineItem, change: z.infer<typeof studioTimelineTimingChangeSchema>, revisionId: string, now: string): void {
  const scene = before.sceneId == null ? undefined : project.scenes.find((candidate) => candidate.id === before.sceneId);
  const sceneStart = scene == null ? 0 : windows(project).find((entry) => entry.scene.id === scene.id)?.startMs ?? 0;
  if (scene != null && before.kind !== "scene" && before.kind !== "transition" && change.startMs < sceneStart) {
    throw new StudioTimelineError(`${before.kind} timing cannot move before its scene`);
  }
  if (before.kind === "scene") {
    if (change.startMs !== before.startMs) throw new StudioTimelineError("scene blocks cannot move; reorder scenes in the storyboard editor");
    setSceneDuration(scene!, requireDuration(change, before.kind));
  } else if (before.kind === "transition") {
    if (change.startMs !== before.startMs) throw new StudioTimelineError("transition blocks cannot move; resize their duration");
    setSceneTransition(scene!, requireDuration(change, before.kind, true));
  } else if (before.kind === "semantic-action") {
    const [, trackId, eventId] = splitId(before.id, before.kind);
    const event = scene?.tracks?.find((track) => track.id === trackId)?.events.find((candidate) => candidate.id === eventId);
    if (event == null) throw new StudioTimelineError(`semantic action no longer exists: ${before.id}`);
    event.atMs = change.startMs - sceneStart;
    const duration = requireDuration(change, before.kind);
    event.durationMs = duration === 1 && before.endMs - before.startMs === 1 && event.durationMs == null ? undefined : duration;
  } else if (before.kind === "cursor") {
    const [indexText] = splitId(before.id, before.kind);
    const event = project.playback?.cursor?.events[Number(indexText)];
    if (event == null || scene == null) throw new StudioTimelineError(`cursor event no longer exists: ${before.id}`);
    event.frame = project.scenes.findIndex((candidate) => candidate.id === scene.id);
    event.at = change.startMs - sceneStart;
    const duration = requireDuration(change, before.kind);
    event.duration = duration === 1 && before.endMs - before.startMs === 1 && event.duration == null ? undefined : duration;
  } else if (before.kind === "overlay") {
    const [, indexText] = splitId(before.id, before.kind);
    const overlay = scene == null ? undefined : scenePresentation(scene).overlays?.[Number(indexText)];
    if (overlay == null) throw new StudioTimelineError(`overlay no longer exists: ${before.id}`);
    requireDuration(change, before.kind);
    overlay.delay = change.startMs - sceneStart;
    overlay.endAt = change.endMs - sceneStart;
  } else if (before.kind === "treatment") {
    const [, indexText] = splitId(before.id, before.kind);
    const treatment = scene?.treatments?.[Number(indexText)];
    if (treatment == null || !("timing" in treatment)) throw new StudioTimelineError(`timed treatment no longer exists: ${before.id}`);
    const previous = treatment.timing;
    treatment.timing = {
      startMs: change.startMs - sceneStart,
      durationMs: requireDuration(change, before.kind),
      easing: previous?.easing ?? "cubic-bezier(0.22,1,0.36,1)",
    };
  } else if (before.kind === "annotation") {
    const [annotationId] = splitId(before.id, before.kind);
    const annotation = project.review.annotations.find((candidate) => candidate.id === annotationId);
    if (annotation?.target == null) throw new StudioTimelineError(`timed annotation no longer exists: ${before.id}`);
    const startMs = change.startMs - sceneStart;
    const endMs = change.endMs - sceneStart;
    annotation.target.time = endMs === startMs ? { pointMs: startMs } : { pointMs: startMs, range: { startMs, endMs } };
    delete annotation.target.atMs;
    delete annotation.target.endMs;
    annotation.updatedAt = now;
    annotation.updatedRevisionId = revisionId;
  } else if (before.kind === "animation") {
    const parts = splitId(before.id, before.kind);
    const animationIndex = Number(parts.at(-1));
    const indices = parts.slice(1, -1).join(":").split(".").map(Number);
    const layer = sourceLayerAt((scene?.render.kind === "composition" ? scene.render.composition.layers : []), indices);
    const animation = layer.source.animations?.[animationIndex];
    if (animation == null) throw new StudioTimelineError(`animation no longer exists: ${before.id}`);
    if (change.startMs < sceneStart + (layer.source.start ?? 0)) throw new StudioTimelineError("animation timing cannot move before its layer starts");
    animation.start = change.startMs - sceneStart - (layer.source.start ?? 0);
    animation.duration = requireDuration(change, before.kind);
  }
}

/** Apply explicit timing overrides atomically, append provenance, and return an exact inverse. */
export function applyStudioTimelineCommand(
  rawProject: StudioProject,
  rawCommand: StudioTimelineCommand,
  options: ApplyStudioTimelineOptions = {},
): StudioTimelineResult {
  const project = structuredClone(rawProject);
  const command = studioTimelineCommandSchema.parse(rawCommand);
  if (options.expectedHeadRevisionId != null && project.review.headRevisionId !== options.expectedHeadRevisionId) {
    throw new StudioTimelineError(`stale timeline change: expected review head ${options.expectedHeadRevisionId}, found ${project.review.headRevisionId}`);
  }
  const timeline = buildStudioTimeline(project);
  const byId = new Map(timeline.items.map((item) => [item.id, item]));
  const duplicate = new Set<string>();
  const revisionId = options.revisionId ?? `revision-timeline-${globalThis.crypto.randomUUID()}`;
  const now = options.now ?? new Date().toISOString();
  const inverse: StudioTimelineCommand = { kind: "set-timing", changes: [] };
  const ordered = command.changes.map((change) => {
    if (duplicate.has(change.itemId)) throw new StudioTimelineError(`duplicate timing override: ${change.itemId}`);
    duplicate.add(change.itemId);
    const item = byId.get(change.itemId);
    if (item == null) throw new StudioTimelineError(`unknown timeline item: ${change.itemId}`);
    inverse.changes.push({ itemId: item.id, startMs: item.startMs, endMs: item.endMs });
    return { change, item };
  });
  // Later scene starts depend on earlier scene/transition sizes. Descending absolute order
  // keeps each change's pre-command scene origin stable during a multiselect edit.
  ordered.sort((left, right) => right.item.startMs - left.item.startMs)
    .forEach(({ change, item }) => applyOne(project, item, change, revisionId, now));

  const reviewOnly = ordered.every(({ item }) => item.kind === "annotation");
  if (project.review.revisions.some((revision) => revision.id === revisionId)) throw new StudioTimelineError(`revision id already exists: ${revisionId}`);
  project.review.revisions.push({
    id: revisionId,
    parentId: project.review.headRevisionId,
    createdAt: now,
    author: options.author ?? { kind: "human" },
    kind: reviewOnly ? "review" : "content",
    summary: `Adjusted ${command.changes.length} timeline item${command.changes.length === 1 ? "" : "s"}.`,
    metadata: { operation: "studio.timeline.set-timing", itemIds: command.changes.map((change) => change.itemId) },
  });
  project.review.headRevisionId = revisionId;
  project.updatedAt = now;
  for (const scene of project.scenes) {
    for (const track of scene.tracks ?? []) {
      track.events.forEach((event, index) => {
        const previous = track.events[index - 1];
        if (event.atMs < 0 || (event.durationMs != null && !(event.durationMs > 0))) {
          throw new StudioTimelineError(`timeline edit made ${event.id} timing invalid`);
        }
        if (previous != null && (event.atMs < previous.atMs || (previous.durationMs != null && previous.atMs + previous.durationMs > event.atMs))) {
          throw new StudioTimelineError(`timeline edit makes ${event.id} overlap the previous action in ${track.id}`);
        }
      });
    }
  }
  return { project, inverse, revisionId };
}

export function moveStudioTimelineItems(timeline: StudioTimeline, itemIds: readonly string[], deltaMs: number, snapMs: number): StudioTimelineCommand {
  const byId = new Map(timeline.items.map((item) => [item.id, item]));
  const snap = (value: number): number => Math.max(0, Math.round(value / Math.max(1, snapMs)) * Math.max(1, snapMs));
  return {
    kind: "set-timing",
    changes: itemIds.map((itemId) => {
      const item = byId.get(itemId);
      if (item == null) throw new StudioTimelineError(`unknown timeline item: ${itemId}`);
      if (!item.movable) throw new StudioTimelineError(`${item.kind} blocks cannot move`);
      const startMs = snap(item.startMs + deltaMs);
      return { itemId, startMs, endMs: startMs + (item.endMs - item.startMs) };
    }),
  };
}

export function resizeStudioTimelineItems(timeline: StudioTimeline, itemIds: readonly string[], edge: "start" | "end", deltaMs: number, snapMs: number): StudioTimelineCommand {
  const byId = new Map(timeline.items.map((item) => [item.id, item]));
  const snap = (value: number): number => Math.max(0, Math.round(value / Math.max(1, snapMs)) * Math.max(1, snapMs));
  return {
    kind: "set-timing",
    changes: itemIds.map((itemId) => {
      const item = byId.get(itemId);
      if (item == null) throw new StudioTimelineError(`unknown timeline item: ${itemId}`);
      if (!item.resizable) throw new StudioTimelineError(`${item.kind} blocks cannot resize`);
      const zeroAllowed = item.kind === "annotation" || item.kind === "transition";
      const minimum = zeroAllowed ? 0 : 1;
      return edge === "start"
        ? { itemId, startMs: Math.min(snap(item.startMs + deltaMs), item.endMs - minimum), endMs: item.endMs }
        : { itemId, startMs: item.startMs, endMs: Math.max(snap(item.endMs + deltaMs), item.startMs + minimum) };
    }),
  };
}
