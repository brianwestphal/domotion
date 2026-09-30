import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { resolveInsideWorkspace } from "./workspace-path.js";
import { studioPageSelectorFor } from "./page-script/selector.js";
import { installStudioRecorderInPage, type BrowserRecorderOptions } from "./page-script/recorder.js";
import { compileStudioSemanticTracks } from "./interactions.js";
import { validateStudioProject } from "./project.js";
import {
  studioIdSchema,
  studioSceneSchema,
  studioSemanticTargetSchema,
  type StudioProject,
  type StudioScene,
} from "./project-schema.js";

export const STUDIO_INTERACTION_RECORDING_FORMAT = "domotion-studio-interaction-recording" as const;
export const STUDIO_INTERACTION_RECORDING_VERSION = 1 as const;
export const STUDIO_REDACTED_VALUE = "[REDACTED]" as const;

const nonEmpty = z.string().trim().min(1);
const pointSchema = z.strictObject({ x: z.number(), y: z.number() });
const rectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const studioRecordedTargetSchema = z.strictObject({
  tag: nonEmpty,
  selector: nonEmpty,
  semantic: studioSemanticTargetSchema.optional(),
  text: z.string(),
  rect: rectSchema,
  styles: z.record(z.string(), z.string()),
  state: z.strictObject({
    checked: z.boolean().optional(),
    disabled: z.boolean().optional(),
    expanded: z.string().nullable().optional(),
  }),
  sensitive: z.boolean(),
});

const eventBase = {
  sequence: z.number().int().nonnegative(),
  atMs: z.number().nonnegative(),
  url: nonEmpty,
};

export const studioRecordedEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventBase,
    kind: z.literal("pointer"),
    phase: z.enum(["move", "down", "up", "click"]),
    point: pointSchema,
    button: z.number().int(),
    buttons: z.number().int().nonnegative(),
    target: studioRecordedTargetSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("keyboard"),
    phase: z.enum(["down", "up"]),
    key: z.string(),
    code: z.string(),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])),
    target: studioRecordedTargetSchema.optional(),
    redacted: z.boolean(),
  }),
  z
    .strictObject({
      ...eventBase,
      kind: z.literal("input"),
      value: z.string(),
      inputType: z.string().optional(),
      target: studioRecordedTargetSchema,
      redacted: z.boolean(),
    })
    .superRefine((event, ctx) => {
      if (event.target.sensitive && (!event.redacted || event.value !== STUDIO_REDACTED_VALUE)) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "sensitive input must be redacted before it enters a recording",
        });
      }
    }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("scroll"),
    position: pointSchema,
    target: studioRecordedTargetSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("navigation"),
    navigationKind: z.enum(["initial", "push-state", "replace-state", "pop-state", "hash-change", "page-show"]),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("dom-feedback"),
    mutationCount: z.number().int().positive(),
    mutations: z
      .array(
        z.strictObject({
          kind: z.enum(["attributes", "characterData", "childList"]),
          attribute: z.string().optional(),
          targetSelector: z.string(),
          addedNodes: z.number().int().nonnegative(),
          removedNodes: z.number().int().nonnegative(),
        }),
      )
      .min(1),
    snapshots: z.array(studioRecordedTargetSchema),
  }),
]);

export const studioInteractionRecordingSchema = z
  .strictObject({
    format: z.literal(STUDIO_INTERACTION_RECORDING_FORMAT),
    version: z.literal(STUDIO_INTERACTION_RECORDING_VERSION),
    id: studioIdSchema,
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
    viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
    sourceUrls: z.array(nonEmpty).min(1),
    redactions: z.number().int().nonnegative(),
    events: z.array(studioRecordedEventSchema),
  })
  .superRefine((recording, ctx) => {
    let previousSequence = -1;
    let previousTime = -1;
    let observedRedactions = 0;
    recording.events.forEach((event, index) => {
      if (event.sequence <= previousSequence)
        ctx.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "must increase monotonically" });
      if (event.atMs < previousTime)
        ctx.addIssue({ code: "custom", path: ["events", index, "atMs"], message: "must not move backwards" });
      previousSequence = event.sequence;
      previousTime = event.atMs;
      if ((event.kind === "input" || event.kind === "keyboard") && event.redacted) observedRedactions++;
    });
    if (recording.redactions !== observedRedactions) {
      ctx.addIssue({
        code: "custom",
        path: ["redactions"],
        message: `must equal the ${observedRedactions} redacted recorded events`,
      });
    }
  });

export type StudioRecordedTarget = z.infer<typeof studioRecordedTargetSchema>;
export type StudioRecordedEvent = z.infer<typeof studioRecordedEventSchema>;
export type StudioInteractionRecording = z.infer<typeof studioInteractionRecordingSchema>;

interface BrowserRawEvent {
  atEpochMs: number;
  url: string;
  kind: StudioRecordedEvent["kind"];
  [key: string]: unknown;
}

export interface RecordStudioInteractionsOptions {
  id?: string;
  startedAt?: string;
  redactSelectors?: readonly string[];
  pointerMoveIntervalMs?: number;
  settleMs?: number;
}

/** Record one real browser flow. Sensitive values are replaced inside the page, before crossing the binding. */
export async function recordStudioInteractions(
  page: Page,
  perform: (page: Page) => void | Promise<void>,
  options: RecordStudioInteractionsOptions = {},
): Promise<StudioInteractionRecording> {
  const id = options.id ?? `recording-${randomUUID()}`;
  const bindingName = `__domotionStudioRecord_${randomUUID().replaceAll("-", "")}`;
  const recorderKey = `${bindingName}State`;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const startedEpochMs = Date.parse(startedAt);
  const rawEvents: BrowserRawEvent[] = [];
  let active = true;
  await page.exposeBinding(bindingName, (_source, value: BrowserRawEvent) => {
    if (active) rawEvents.push(structuredClone(value));
  });
  const installOptions: BrowserRecorderOptions = {
    bindingName,
    recorderKey,
    redactSelectors: [...(options.redactSelectors ?? [])],
    pointerMoveIntervalMs: options.pointerMoveIntervalMs ?? 80,
  };
  const cdp = await page.context().newCDPSession(page);
  const source = `(${installStudioRecorderInPage.toString()})(${JSON.stringify(installOptions)}, ${studioPageSelectorFor.toString()})`;
  const { identifier: initScriptId } = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source })) as {
    identifier: string;
  };
  await page.evaluate(source);
  let failure: unknown;
  try {
    await perform(page);
    await page.waitForTimeout(options.settleMs ?? 100);
  } catch (error) {
    failure = error;
  } finally {
    await page
      .evaluate(
        ({ key }) => {
          const value = (globalThis as unknown as Record<string, unknown>)[key] as { stop?: () => void } | undefined;
          value?.stop?.();
        },
        { key: recorderKey },
      )
      .catch(() => {});
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initScriptId }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  await page.waitForTimeout(10).catch(() => {});
  active = false;
  if (failure != null) throw failure;

  const ordered = rawEvents
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.atEpochMs - b.event.atEpochMs || a.order - b.order);
  const events = ordered.map(({ event }, sequence) => {
    const { atEpochMs, ...rest } = event;
    return studioRecordedEventSchema.parse({ ...rest, sequence, atMs: Math.max(0, atEpochMs - startedEpochMs) });
  });
  const sourceUrls = [...new Set([sanitizeRecordedUrl(page.url()), ...events.map((event) => String(event.url))])];
  const redactions = events.filter(
    (event) => (event.kind === "input" || event.kind === "keyboard") && event.redacted === true,
  ).length;
  return studioInteractionRecordingSchema.parse({
    format: STUDIO_INTERACTION_RECORDING_FORMAT,
    version: STUDIO_INTERACTION_RECORDING_VERSION,
    id,
    startedAt,
    durationMs: events.at(-1)?.atMs ?? 0,
    viewport: page.viewportSize(),
    sourceUrls,
    redactions,
    events,
  });
}

function sanitizeRecordedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|key|session|code)/i.test(key))
        url.searchParams.set(key, STUDIO_REDACTED_VALUE);
    }
    if (/(?:token|secret|password|passwd)=/i.test(url.hash)) url.hash = "#redacted";
    return url.href;
  } catch {
    return raw;
  }
}

const automationEvidenceSchema = z.strictObject({ summary: nonEmpty, data: z.json().optional() });
const healDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("candidate"),
    scene: studioSceneSchema,
    summary: nonEmpty,
    evidence: automationEvidenceSchema,
  }),
  z.strictObject({
    kind: z.literal("clarify"),
    question: nonEmpty,
    reason: nonEmpty,
    evidence: automationEvidenceSchema,
  }),
]);
const reviewDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accept"), summary: nonEmpty, evidence: automationEvidenceSchema }),
  z.strictObject({
    kind: z.literal("edit"),
    scene: studioSceneSchema,
    summary: nonEmpty,
    evidence: automationEvidenceSchema,
  }),
  z.strictObject({
    kind: z.literal("clarify"),
    question: nonEmpty,
    reason: nonEmpty,
    evidence: automationEvidenceSchema,
  }),
]);

export type StudioRecordingHealDecision = z.infer<typeof healDecisionSchema>;
export type StudioRecordingReviewDecision = z.infer<typeof reviewDecisionSchema>;
export interface StudioRecordingAiRequest {
  project: StudioProject;
  recording: StudioInteractionRecording;
  aiPolicy: { healing: "required"; review: "required" };
}
export interface StudioRecordingReviewRequest extends StudioRecordingAiRequest {
  candidate: StudioScene;
}
export interface StudioRecordingAiAdapter {
  heal: (request: StudioRecordingAiRequest) => StudioRecordingHealDecision | Promise<StudioRecordingHealDecision>;
  review: (
    request: StudioRecordingReviewRequest,
  ) => StudioRecordingReviewDecision | Promise<StudioRecordingReviewDecision>;
}
export interface ImportStudioInteractionRecordingOptions {
  ai: StudioRecordingAiAdapter;
  evidencePath?: string;
  now?: string;
  generatorVersion?: string;
}
export type StudioRecordingImportResult =
  | {
      status: "clarification";
      project: StudioProject;
      question: string;
      reason: string;
      phase: "healing" | "review";
    }
  | {
      status: "imported";
      project: StudioProject;
      scene: StudioScene;
      evidencePath: string;
      evidenceText: string;
      ai: { healing: { summary: string }; review: { summary: string } };
    };

export class StudioRecordingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioRecordingError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateImportedScene(raw: unknown, project: StudioProject, phase: string): StudioScene {
  const parsed = studioSceneSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioRecordingError(`AI ${phase} scene is invalid at $.${issue.path.join(".")}: ${issue.message}`);
  }
  const scene = parsed.data;
  if (project.scenes.some((candidate) => candidate.id === scene.id))
    throw new StudioRecordingError(`AI ${phase} scene reused existing scene id "${scene.id}"`);
  if ((scene.tracks?.flatMap((track) => track.events).length ?? 0) === 0)
    throw new StudioRecordingError(`AI ${phase} scene must contain inferred semantic interaction events`);
  compileStudioSemanticTracks(scene.tracks ?? [], { path: "$.scene.tracks" });
  return scene;
}

/** Run required AI healing and review, then append a normal editable Studio scene and redacted evidence artifact. */
export async function importStudioInteractionRecording(
  rawProject: unknown,
  rawRecording: unknown,
  options: ImportStudioInteractionRecordingOptions,
): Promise<StudioRecordingImportResult> {
  const project = validateStudioProject(rawProject);
  const recording = studioInteractionRecordingSchema.parse(rawRecording);
  const request: StudioRecordingAiRequest = {
    project: structuredClone(project),
    recording: structuredClone(recording),
    aiPolicy: { healing: "required", review: "required" },
  };
  const healed = healDecisionSchema.parse(await options.ai.heal(request));
  if (healed.kind === "clarify")
    return { status: "clarification", project, question: healed.question, reason: healed.reason, phase: "healing" };
  let scene = validateImportedScene(healed.scene, project, "healing");
  const reviewed = reviewDecisionSchema.parse(
    await options.ai.review({ ...request, candidate: structuredClone(scene) }),
  );
  if (reviewed.kind === "clarify")
    return { status: "clarification", project, question: reviewed.question, reason: reviewed.reason, phase: "review" };
  if (reviewed.kind === "edit") scene = validateImportedScene(reviewed.scene, project, "review");

  const now = options.now ?? new Date().toISOString();
  const evidenceText = `${JSON.stringify(recording, null, 2)}\n`;
  const token = digest(`${project.review.headRevisionId}:${recording.id}:${JSON.stringify(scene)}`).slice(0, 16);
  const revisionId = `revision-recording-${token}`;
  const artifactId = `artifact-recording-${token}`;
  const evidencePath = options.evidencePath ?? `.domotion-studio/recordings/${recording.id}.json`;
  const next = structuredClone(project);
  next.scenes.push(scene);
  for (const beatId of scene.narrativeBeatIds ?? []) {
    const beat = next.narrative.beats.find((candidate) => candidate.id === beatId);
    if (beat != null && !beat.sceneIds.includes(scene.id)) beat.sceneIds.push(scene.id);
  }
  next.review.revisions.push({
    id: revisionId,
    parentId: project.review.headRevisionId,
    createdAt: now,
    author: { kind: "ai", name: "Studio recording import" },
    kind: "content",
    summary: reviewed.summary,
    metadata: {
      operation: "studio.recording.import",
      recordingId: recording.id,
      healingSummary: healed.summary,
      healingEvidence: healed.evidence,
      reviewEvidence: reviewed.evidence,
    },
  });
  next.review.headRevisionId = revisionId;
  next.artifacts.push({
    id: artifactId,
    kind: "capture-evidence",
    path: evidencePath,
    generatedAt: now,
    generator: {
      name: "domotion-studio-recorder",
      ...(options.generatorVersion == null ? {} : { version: options.generatorVersion }),
    },
    sourceRevisionId: revisionId,
    sceneIds: [scene.id],
    sha256: digest(evidenceText),
    metadata: {
      format: recording.format,
      version: recording.version,
      eventCount: recording.events.length,
      redactions: recording.redactions,
      sourceUrls: recording.sourceUrls,
    },
  });
  next.updatedAt = now;
  return {
    status: "imported",
    project: validateStudioProject(next),
    scene,
    evidencePath,
    evidenceText,
    ai: { healing: { summary: healed.summary }, review: { summary: reviewed.summary } },
  };
}

/** Atomically persist the already-redacted evidence returned by the importer inside a Studio workspace. */
export function persistStudioRecordingEvidence(
  workspaceRoot: string,
  result: Extract<StudioRecordingImportResult, { status: "imported" }>,
): string {
  const root = resolve(workspaceRoot);
  const destination = resolveInsideWorkspace(root, result.evidencePath, {
    extension: ".json",
    extensionMessage: "recording evidence files must use a .json extension",
    escapeMessage: (resolvedRoot) => `recording evidence path must stay inside the Studio workspace: ${resolvedRoot}`,
    followSymlinks: true,
    makeError: (message) => new StudioRecordingError(message),
  });
  const local = relative(root, destination);
  if (existsSync(destination)) {
    if (readFileSync(destination, "utf8") === result.evidenceText) return destination;
    throw new StudioRecordingError(`recording evidence already exists with different content: ${local}`);
  }
  mkdirSync(resolve(destination, ".."), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, result.evidenceText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}
