import { createHash } from "node:crypto";
import type { Browser } from "@playwright/test";
import { z } from "zod";
import {
  compileStudioInteractiveProject,
  StudioInteractiveSceneError,
  type CompileStudioInteractiveProjectOptions,
  type CompileStudioInteractiveProjectResult,
  type StudioHealingPageInspection,
} from "./interactive-compile.js";
import { StudioProjectCompileError } from "./compile.js";
import type { StudioInteractionEvidence } from "./interaction-observer.js";
import { validateStudioProject } from "./project.js";
import type { StudioProject } from "./project-schema.js";

export type StudioAutomationPhase = "heal" | "review";
export type StudioJson = null | boolean | number | string | StudioJson[] | { [key: string]: StudioJson };

export interface StudioAutomationEvidence {
  summary: string;
  data?: StudioJson;
}

export interface StudioAutomationChange {
  path: string;
  before?: StudioJson;
  after?: StudioJson;
}

export interface StudioReplayFailure {
  name: string;
  message: string;
  sceneId?: string;
  eventId?: string;
  completedEventIds: readonly string[];
  completedEvidence: readonly StudioInteractionEvidence[];
  failedEvidence?: StudioInteractionEvidence;
  inspection?: StudioHealingPageInspection;
  causes: readonly { name: string; message: string; path?: string; eventId?: string }[];
}

export interface StudioClarificationAnswer {
  phase: StudioAutomationPhase;
  question: string;
  answer: string;
}

export interface StudioHealRequest {
  project: StudioProject;
  failure: StudioReplayFailure;
  clarification?: StudioClarificationAnswer;
}

export interface StudioReviewRequest {
  project: StudioProject;
  candidate: CompileStudioInteractiveProjectResult;
  clarification?: StudioClarificationAnswer;
}

export interface StudioAiEditDecision {
  kind: "edit";
  project: unknown;
  summary: string;
  evidence: StudioAutomationEvidence;
}

export interface StudioAiClarificationDecision {
  kind: "clarify";
  question: string;
  reason: string;
  evidence: StudioAutomationEvidence;
}

export interface StudioAiUnrecoverableDecision {
  kind: "unrecoverable";
  reason: string;
  evidence: StudioAutomationEvidence;
}

export type StudioAiHealingDecision = StudioAiEditDecision | StudioAiClarificationDecision | StudioAiUnrecoverableDecision;

export interface StudioAiAcceptDecision {
  kind: "accept";
  summary: string;
  evidence: StudioAutomationEvidence;
}

export type StudioAiReviewDecision = StudioAiAcceptDecision | StudioAiEditDecision | StudioAiClarificationDecision;

export interface StudioHealingClarificationCheckpoint {
  version: 1;
  id: string;
  phase: StudioAutomationPhase;
  question: string;
  reason: string;
  evidence: StudioAutomationEvidence;
  project: StudioProject;
  projectDigest: string;
}

export type StudioHealingLoopResult =
  | {
    status: "human-review";
    project: StudioProject;
    candidate: CompileStudioInteractiveProjectResult;
    aiReview: StudioAiAcceptDecision;
    clarification?: StudioClarificationAnswer;
  }
  | {
    status: "clarification";
    project: StudioProject;
    checkpoint: StudioHealingClarificationCheckpoint;
  }
  | {
    status: "unrecoverable";
    project: StudioProject;
    phase: StudioAutomationPhase;
    reason: string;
    evidence: StudioAutomationEvidence;
  };

export interface RunStudioHealingLoopOptions extends CompileStudioInteractiveProjectOptions {
  heal: (request: StudioHealRequest) => StudioAiHealingDecision | Promise<StudioAiHealingDecision>;
  review: (request: StudioReviewRequest) => StudioAiReviewDecision | Promise<StudioAiReviewDecision>;
  aiName?: string;
  revisionTimestamp?: () => string;
  signal?: AbortSignal;
}

export class StudioHealingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioHealingError";
  }
}

const evidenceSchema = z.strictObject({ summary: z.string().trim().min(1), data: z.json().optional() });
const editDecisionSchema = z.strictObject({
  kind: z.literal("edit"),
  project: z.unknown(),
  summary: z.string().trim().min(1),
  evidence: evidenceSchema,
});
const clarificationDecisionSchema = z.strictObject({
  kind: z.literal("clarify"),
  question: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  evidence: evidenceSchema,
});
const healDecisionSchema = z.discriminatedUnion("kind", [
  editDecisionSchema,
  clarificationDecisionSchema,
  z.strictObject({ kind: z.literal("unrecoverable"), reason: z.string().trim().min(1), evidence: evidenceSchema }),
]);
const reviewDecisionSchema = z.discriminatedUnion("kind", [
  editDecisionSchema,
  clarificationDecisionSchema,
  z.strictObject({ kind: z.literal("accept"), summary: z.string().trim().min(1), evidence: evidenceSchema }),
]);

function validateAiDecision<T>(schema: z.ZodType<T>, raw: unknown, phase: StudioAutomationPhase): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  throw new StudioHealingError(`AI ${phase} decision is invalid at ${path}: ${issue.message}`);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorChain(error: unknown): Array<{ name: string; message: string; path?: string; eventId?: string }> {
  const result: Array<{ name: string; message: string; path?: string; eventId?: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const path = "path" in current && typeof current.path === "string" ? current.path : undefined;
      const eventId = "eventId" in current && typeof current.eventId === "string" ? current.eventId : undefined;
      result.push({ name: current.name, message: current.message, ...(path == null ? {} : { path }), ...(eventId == null ? {} : { eventId }) });
      current = current.cause;
    } else {
      result.push({ name: "Error", message: String(current) });
      break;
    }
  }
  return result;
}

function replayFailure(error: unknown): StudioReplayFailure {
  const causes = errorChain(error);
  const top = causes[0] ?? { name: "Error", message: String(error) };
  if (error instanceof StudioInteractiveSceneError) {
    return {
      name: top.name,
      message: top.message,
      sceneId: error.sceneId,
      ...(error.eventId == null ? {} : { eventId: error.eventId }),
      completedEventIds: error.completedEventIds,
      completedEvidence: structuredClone(error.completedEvidence),
      ...(error.failedEvidence == null ? {} : { failedEvidence: structuredClone(error.failedEvidence) }),
      inspection: error.inspection,
      causes,
    };
  }
  return { name: top.name, message: top.message, completedEventIds: [], completedEvidence: [], causes };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pathKey(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function asJson(value: unknown): StudioJson {
  return JSON.parse(JSON.stringify(value)) as StudioJson;
}

function diffJson(before: unknown, after: unknown, path = "$", changes: StudioAutomationChange[] = []): StudioAutomationChange[] {
  if (sameJson(before, after)) return changes;
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((value, index) => diffJson(value, after[index], pathKey(path, index), changes));
    return changes;
  }
  if (before != null && after != null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(key in a)) changes.push({ path: pathKey(path, key), after: asJson(b[key]) });
      else if (!(key in b)) changes.push({ path: pathKey(path, key), before: asJson(a[key]) });
      else diffJson(a[key], b[key], pathKey(path, key), changes);
    }
    return changes;
  }
  changes.push({ path, ...(before === undefined ? {} : { before: asJson(before) }), ...(after === undefined ? {} : { after: asJson(after) }) });
  return changes;
}

function withoutGeneratedState(project: StudioProject): StudioProject {
  const copy = { ...project, review: { ...project.review, revisions: [], annotations: [] }, artifacts: [] };
  delete copy.updatedAt;
  return copy;
}

function stableIds(project: StudioProject): Set<string> {
  const ids = new Set<string>([project.id]);
  project.narrative.beats.forEach((beat) => ids.add(`beat:${beat.id}`));
  project.scriptHooks?.forEach((hook) => ids.add(`hook:${hook.id}`));
  const layers = (items: readonly import("./project-schema.js").StudioLayer[]): void => items.forEach((layer) => {
    ids.add(`layer:${layer.id}`);
    if (layer.kind === "composition") layers(layer.composition.layers);
  });
  project.scenes.forEach((scene) => {
    ids.add(`scene:${scene.id}`);
    scene.tracks?.forEach((track) => {
      ids.add(`track:${track.id}`);
      track.events.forEach((event) => ids.add(`event:${event.id}`));
    });
    if (scene.render.kind === "composition") layers(scene.render.composition.layers);
  });
  return ids;
}

function applyAiEdit(
  current: StudioProject,
  decision: StudioAiEditDecision,
  phase: StudioAutomationPhase,
  trigger: StudioJson,
  allowMaterialChange: boolean,
  options: RunStudioHealingLoopOptions,
): StudioProject {
  const proposed = validateStudioProject(decision.project, `AI ${phase} proposal`);
  if (proposed.id !== current.id || proposed.format !== current.format || proposed.version !== current.version || proposed.createdAt !== current.createdAt) {
    throw new StudioHealingError(`AI ${phase} proposal changed immutable project identity`);
  }
  if (!allowMaterialChange) {
    const proposedIds = stableIds(proposed);
    const removedIds = [...stableIds(current)].filter((id) => !proposedIds.has(id));
    if (removedIds.length > 0) throw new StudioHealingError(`AI ${phase} proposal removed or renamed stable identities without clarification: ${removedIds.join(", ")}`);
    if (!sameJson(proposed.scriptHooks, current.scriptHooks)) throw new StudioHealingError(`AI ${phase} proposal changed the script-hook trust boundary without clarification`);
    if (!sameJson(proposed.exportTargets, current.exportTargets)) throw new StudioHealingError(`AI ${phase} proposal changed export destinations without clarification`);
  }
  const content = validateStudioProject({ ...proposed, review: current.review, artifacts: current.artifacts }, `AI ${phase} proposal`);
  const changes = diffJson(withoutGeneratedState(current), withoutGeneratedState(content));
  if (changes.length === 0) throw new StudioHealingError(`AI ${phase} proposal made no authored change`);
  const createdAt = options.revisionTimestamp?.() ?? new Date().toISOString();
  const parentId = current.review.headRevisionId;
  const id = `revision-ai-${hash({ parentId, phase, summary: decision.summary, changes }).slice(0, 16)}`;
  return validateStudioProject({
    ...content,
    updatedAt: createdAt,
    review: {
      ...current.review,
      headRevisionId: id,
      revisions: [...current.review.revisions, {
        id,
        parentId,
        createdAt,
        author: { kind: "ai", name: options.aiName ?? "Studio AI" },
        kind: "content",
        summary: decision.summary,
        metadata: { automation: { phase, evidence: decision.evidence, trigger, triggerDigest: hash(trigger), changes } },
      }],
    },
  }, `AI ${phase} revision`);
}

function checkpoint(
  project: StudioProject,
  phase: StudioAutomationPhase,
  decision: StudioAiClarificationDecision,
): StudioHealingLoopResult {
  const value: StudioHealingClarificationCheckpoint = {
    version: 1,
    id: "",
    phase,
    question: decision.question,
    reason: decision.reason,
    evidence: decision.evidence,
    project,
    projectDigest: hash(project),
  };
  value.id = `clarification-${hash({ ...value, id: undefined }).slice(0, 16)}`;
  return { status: "clarification", project, checkpoint: value };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new StudioHealingError("Studio healing was aborted", { cause: signal.reason });
}

function assertAiBoundaries(options: RunStudioHealingLoopOptions): void {
  if (typeof options.heal !== "function" || typeof options.review !== "function") {
    throw new StudioHealingError("Studio healing requires explicit AI heal and review callbacks");
  }
}

function actionableReplayFailure(error: unknown): boolean {
  if (error instanceof StudioProjectCompileError) return true;
  if (!(error instanceof StudioInteractiveSceneError) || error.eventId == null) return false;
  return !errorChain(error).some((item) => /browser has been closed|target (page|context|browser).*closed|page crashed|session closed/i.test(item.message));
}

async function runLoop(
  browser: Browser,
  initial: StudioProject,
  options: RunStudioHealingLoopOptions,
  clarification?: StudioClarificationAnswer,
): Promise<StudioHealingLoopResult> {
  let project = initial;
  let pendingClarification = clarification;
  for (;;) {
    assertNotAborted(options.signal);
    let candidate: CompileStudioInteractiveProjectResult;
    try {
      candidate = await compileStudioInteractiveProject(browser, project, options);
    } catch (error) {
      if (!actionableReplayFailure(error)) throw error;
      const failure = replayFailure(error);
      const usedClarification = pendingClarification?.phase === "heal" ? pendingClarification : undefined;
      const decision = validateAiDecision(healDecisionSchema, await options.heal({
        project: structuredClone(project),
        failure: structuredClone(failure),
        ...(usedClarification == null ? {} : { clarification: usedClarification }),
      }), "heal");
      pendingClarification = undefined;
      if (decision.kind === "clarify") return checkpoint(project, "heal", decision);
      if (decision.kind === "unrecoverable") {
        return { status: "unrecoverable", project, phase: "heal", reason: decision.reason, evidence: decision.evidence };
      }
      project = applyAiEdit(project, decision, "heal", asJson({ failure, clarification: usedClarification ?? null }), usedClarification != null, options);
      continue;
    }

    const reviewedProject = validateStudioProject(structuredClone(candidate.project));
    const usedClarification = pendingClarification?.phase === "review" ? pendingClarification : undefined;
    const decision = validateAiDecision(reviewDecisionSchema, await options.review({
      project: structuredClone(reviewedProject),
      candidate: structuredClone(candidate),
      ...(usedClarification == null ? {} : { clarification: usedClarification }),
    }), "review");
    pendingClarification = undefined;
    if (decision.kind === "accept") {
      return { status: "human-review", project: candidate.project, candidate, aiReview: decision, ...(usedClarification == null ? {} : { clarification: usedClarification }) };
    }
    if (decision.kind === "clarify") return checkpoint(candidate.project, "review", decision);
    const reviewTrigger = asJson({
      sourceRevisionId: reviewedProject.review.headRevisionId,
      artifacts: reviewedProject.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, sha256: artifact.sha256 ?? null })),
      segments: candidate.segments.map((segment) => ({ sceneId: segment.sceneId, artifactId: segment.artifactId, sha256: segment.sha256, evidenceSha256: segment.evidenceSha256 })),
    });
    project = applyAiEdit(reviewedProject, decision, "review", asJson({ candidate: reviewTrigger, clarification: usedClarification ?? null }), usedClarification != null, options);
  }
}

/** Replay, AI-heal, regenerate, and require AI acceptance before human handoff. */
export async function runStudioHealingLoop(
  browser: Browser,
  raw: unknown,
  options: RunStudioHealingLoopOptions,
): Promise<StudioHealingLoopResult> {
  assertAiBoundaries(options);
  return runLoop(browser, validateStudioProject(raw), options);
}

/** Resume a clarification checkpoint without mutating or replacing its project state. */
export async function resumeStudioHealingLoop(
  browser: Browser,
  checkpointValue: StudioHealingClarificationCheckpoint,
  answer: string,
  options: RunStudioHealingLoopOptions,
): Promise<StudioHealingLoopResult> {
  assertAiBoundaries(options);
  if (checkpointValue.version !== 1 || answer.trim() === "") throw new StudioHealingError("a non-empty answer is required to resume Studio healing");
  const project = validateStudioProject(checkpointValue.project, "Studio healing checkpoint");
  const projectDigest = hash(project);
  const expectedId = `clarification-${hash({ ...checkpointValue, id: undefined, project, projectDigest }).slice(0, 16)}`;
  if (checkpointValue.projectDigest !== projectDigest || checkpointValue.id !== expectedId) {
    throw new StudioHealingError("Studio healing checkpoint was modified after it was created");
  }
  return runLoop(browser, project, options, { phase: checkpointValue.phase, question: checkpointValue.question, answer });
}
