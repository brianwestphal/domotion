import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { buildMagicMove, generateAnimatedSvg, type AnimationFrame } from "../animation/index.js";
import { captureElementTreeSelfContained, createCapturedTreeEnvelope, discoverAndRegisterWebfonts } from "../capture/index.js";
import type { CapturedElement } from "../capture/types.js";
import { openAnimateCaptureSession } from "../cli/animate-capture-session.js";
import { applyReadyWaits, loadInputIntoPage } from "../cli/common.js";
import type { StoryboardScene } from "../cli/storyboard.js";
import { elementTreeToSvgInner, getEmbeddedFontFaceCss } from "../render/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import {
  compileStudioProjectWithSceneOverrides,
  StudioProjectCompileError,
  type CompileStudioProjectOptions,
  type StudioSceneRecipeOverride,
} from "./compile.js";
import {
  inspectStudioCursorTargets,
  planStudioCursorChoreography,
  type PlanStudioCursorChoreographyOptions,
  type StudioCursorChoreography,
  type StudioCursorTargetEvidence,
} from "./cursor-choreography.js";
import { observeStudioSemanticStep, type StudioInteractionEvidence } from "./interaction-observer.js";
import {
  compileStudioSemanticTracks,
  runStudioSemanticStep,
  type RunStudioSemanticStepOptions,
  type StudioSemanticPlan,
} from "./interactions.js";
import { validateStudioProject } from "./project.js";
import type { StudioArtifact, StudioProject, StudioScene } from "./project-schema.js";

const DEFAULT_STATE_TAIL_MS = 400;
const DEFAULT_SEGMENT_MIN_MS = 800;

export interface StudioSceneHookContext {
  page: Page;
  project: StudioProject;
  scene: StudioScene;
  sceneIndex: number;
  hookId: string;
  phase: "beforeCapture" | "afterCapture" | "beforeCompile" | "afterCompile";
  path: string;
}

export interface CompileStudioInteractiveProjectOptions extends CompileStudioProjectOptions {
  /** Persistent destination for replaceable scene SVG and evidence artifacts. */
  artifactDir: string;
  /** Explicit application-owned TypeScript hook boundary; modules are never auto-imported. */
  runHook?: RunStudioSemanticStepOptions["runHook"];
  runSceneHook?: (context: StudioSceneHookContext) => void | Promise<void>;
  cursor?: PlanStudioCursorChoreographyOptions;
  generatedAt?: () => string;
  generatorVersion?: string;
}

export interface StudioInteractiveSegment {
  sceneId: string;
  artifactId: string;
  evidenceArtifactId: string;
  path: string;
  evidencePath: string;
  durationMs: number;
  sha256: string;
  evidenceSha256: string;
  evidence: readonly StudioInteractionEvidence[];
  cursor: StudioCursorChoreography;
}

export interface CompileStudioInteractiveProjectResult {
  svg: string;
  project: StudioProject;
  segments: readonly StudioInteractiveSegment[];
}

interface CapturedState {
  tree: CapturedElement[];
  svgContent: string;
  cullCss: string;
  background?: string;
}

interface RenderGroup {
  atMs: number;
  stateIndex: number;
  evidenceIndexes: number[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactStem(sceneId: string): string {
  const safe = sceneId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "scene";
  return `${safe}-${hash(sceneId).slice(0, 10)}`;
}

function artifactId(sceneId: string, suffix: "segment" | "evidence"): string {
  const full = `artifact-${sceneId}-${suffix}`;
  if (full.length <= 128) return full;
  return `artifact-${sceneId.slice(0, 88)}-${hash(sceneId).slice(0, 12)}-${suffix}`;
}

function projectPath(projectDir: string, path: string): string {
  const value = relative(projectDir, path).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

function activeScene(scene: StudioScene): boolean {
  return (scene.tracks ?? []).some((track) => track.events.length > 0) || (scene.scriptHooks?.length ?? 0) > 0;
}

async function captureState(
  page: Page,
  selector: string,
  width: number,
  height: number,
  prefix: string,
): Promise<CapturedState> {
  const tree = await captureElementTreeSelfContained(page, selector, { x: 0, y: 0, width, height });
  const cull = cullElementsOutsideViewBox(tree, width, height, undefined, 0, 1);
  return {
    tree,
    svgContent: elementTreeToSvgInner(tree, width, height, prefix, true, 2, false),
    cullCss: cull.css,
    background: tree[0]?.styles?.rootBgComputed,
  };
}

function transitionFor(evidence: readonly StudioInteractionEvidence[], durationCap: number): NonNullable<AnimationFrame["transition"]> {
  if (!evidence.some((item) => item.meaningful) || durationCap <= 0) return { type: "cut", duration: 0 };
  const geometry = evidence.some((item) =>
    item.summary.addedNodes > 0
    || item.summary.removedNodes > 0
    || item.changes.some((change) => change.geometryChanged || change.scrollChanged),
  );
  const duration = Math.min(geometry ? 240 : 160, durationCap);
  return duration <= 0 ? { type: "cut", duration: 0 } : { type: geometry ? "magic-move" : "crossfade", duration };
}

function magicMove(
  before: CapturedState,
  after: CapturedState,
  width: number,
  height: number,
  prefix: string,
): NonNullable<AnimationFrame["magicMove"]> | null {
  const envelope = createCapturedTreeEnvelope(after.tree);
  return buildMagicMove(before.tree, after.tree, (roots, idPrefix) => elementTreeToSvgInner({
    ...envelope,
    tree: roots.map((root) => {
      if (root.sessionGenericFamilies == null) return root;
      const copy = { ...root };
      delete copy.sessionGenericFamilies;
      return copy;
    }),
  }, width, height, idPrefix, true, 2, false), prefix);
}

function scheduledGroups(
  plan: StudioSemanticPlan,
  cursor: StudioCursorChoreography,
): RenderGroup[] {
  const cursorTimes = new Map(cursor.interactions.map((item) => [item.eventId, item.presentedAtMs]));
  const groups: RenderGroup[] = [];
  let prior = 0;
  plan.steps.forEach((step, index) => {
    const preferred = cursorTimes.get(step.event.id) ?? step.event.atMs + cursor.timeOffsetMs;
    const atMs = Math.max(prior, preferred);
    prior = atMs;
    const last = groups[groups.length - 1];
    if (last?.atMs === atMs) {
      last.stateIndex = index + 1;
      last.evidenceIndexes.push(index);
    } else {
      groups.push({ atMs, stateIndex: index + 1, evidenceIndexes: [index] });
    }
  });
  return groups;
}

function buildFrames(
  states: readonly CapturedState[],
  groups: readonly RenderGroup[],
  evidence: readonly StudioInteractionEvidence[],
  width: number,
  height: number,
  desiredDurationMs: number,
): { frames: AnimationFrame[]; durationMs: number } {
  const frames: AnimationFrame[] = [];
  let currentStateIndex = 0;
  let currentStart = 0;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const nextGroupAt = groups[index + 1]?.atMs ?? Number.POSITIVE_INFINITY;
    const transition = transitionFor(group.evidenceIndexes.map((item) => evidence[item]), nextGroupAt - group.atMs);
    const frame: AnimationFrame = {
      svgContent: states[currentStateIndex].svgContent,
      cullCss: states[currentStateIndex].cullCss,
      duration: Math.max(0, group.atMs - currentStart),
      transition,
    };
    if (transition.type === "magic-move") {
      frame.magicMove = magicMove(states[currentStateIndex], states[group.stateIndex], width, height, `studio-mm${index}-`);
    }
    frames.push(frame);
    currentStateIndex = group.stateIndex;
    currentStart = group.atMs + (transition.type === "cut" ? 0 : transition.duration);
  }
  const durationMs = Math.max(desiredDurationMs, currentStart + DEFAULT_STATE_TAIL_MS, DEFAULT_SEGMENT_MIN_MS);
  frames.push({
    svgContent: states[currentStateIndex].svgContent,
    cullCss: states[currentStateIndex].cullCss,
    duration: Math.max(1, durationMs - currentStart),
    transition: { type: "cut", duration: 0 },
  });
  return { frames, durationMs };
}

async function runScenePhase(
  project: StudioProject,
  scene: StudioScene,
  sceneIndex: number,
  page: Page,
  phase: StudioSceneHookContext["phase"],
  handler: CompileStudioInteractiveProjectOptions["runSceneHook"],
): Promise<void> {
  for (let index = 0; index < (scene.scriptHooks?.length ?? 0); index++) {
    const hook = scene.scriptHooks![index];
    if (hook.phase !== phase) continue;
    const path = `$.scenes[${sceneIndex}].scriptHooks[${index}]`;
    if (handler == null) throw new StudioProjectCompileError(path, `scene hook "${hook.hookId}" requires an explicit runSceneHook handler`);
    await handler({ page, project, scene, sceneIndex, hookId: hook.hookId, phase, path });
  }
}

async function compileLiveSegment(
  browser: Browser,
  project: StudioProject,
  scene: StudioScene,
  sceneIndex: number,
  options: CompileStudioInteractiveProjectOptions,
): Promise<{ svg: string; durationMs: number; evidence: StudioInteractionEvidence[]; cursor: StudioCursorChoreography }> {
  if (scene.render.kind !== "storyboard" || scene.render.recipe.capture == null) {
    throw new StudioProjectCompileError(`$.scenes[${sceneIndex}].render`, `active scene "${scene.id}" must use a live URL/file capture source; pre-rendered SVG scenes remain reusable when they have no active tracks or hooks`);
  }
  const cap = scene.render.recipe.capture;
  const projectDir = options.projectDir ?? process.cwd();
  const input = cap.url ?? resolve(projectDir, cap.file!);
  const plan = compileStudioSemanticTracks(scene.tracks ?? [], { path: `$.scenes[${sceneIndex}].tracks` });
  const session = await openAnimateCaptureSession(browser, {
    width: project.canvas.width,
    height: project.canvas.height,
    mobile: cap.mobile === true,
    ...(cap.colorScheme != null ? { colorScheme: cap.colorScheme } : {}),
  });
  try {
    const { page, tracker } = session;
    await loadInputIntoPage(page, input);
    await applyReadyWaits(page, { wait: cap.wait ?? 200, waitFor: cap.waitFor, fontsReady: true });
    await discoverAndRegisterWebfonts(page, tracker.urls);
    await runScenePhase(project, scene, sceneIndex, page, "beforeCapture", options.runSceneHook);

    const selector = cap.selector ?? "body";
    const states: CapturedState[] = [await captureState(page, selector, project.canvas.width, project.canvas.height, `studio-${scene.id}-s0-`)];
    const evidence: StudioInteractionEvidence[] = [];
    const cursorTargets: StudioCursorTargetEvidence[] = [];
    for (const step of plan.steps) {
      if (step.event.kind !== "waitForState" && step.event.kind !== "scriptHook") {
        cursorTargets.push(...await inspectStudioCursorTargets(page, { steps: [step], durationMs: step.event.atMs + (step.event.durationMs ?? 0) }));
      }
      const observed = await observeStudioSemanticStep(page, step, () => runStudioSemanticStep(page, step, {
        log: options.log,
        runHook: options.runHook,
      }));
      evidence.push(observed);
      await discoverAndRegisterWebfonts(page, tracker.urls);
      states.push(await captureState(page, selector, project.canvas.width, project.canvas.height, `studio-${scene.id}-s${states.length}-`));
    }
    await runScenePhase(project, scene, sceneIndex, page, "afterCapture", options.runSceneHook);
    const cursor = planStudioCursorChoreography(cursorTargets, { seed: scene.id, ...(options.cursor ?? {}) });
    const groups = scheduledGroups(plan, cursor);
    const authoredDuration = scene.render.recipe.duration ?? 0;
    const { frames, durationMs } = buildFrames(
      states,
      groups,
      evidence,
      project.canvas.width,
      project.canvas.height,
      Math.max(authoredDuration, plan.durationMs + cursor.timeOffsetMs, cursor.durationMs + DEFAULT_STATE_TAIL_MS),
    );
    await runScenePhase(project, scene, sceneIndex, page, "beforeCompile", options.runSceneHook);
    const svg = generateAnimatedSvg({
      width: project.canvas.width,
      height: project.canvas.height,
      frames,
      fontFaceCss: getEmbeddedFontFaceCss(),
      cursorOverlay: cursor.overlay,
      background: states[0].background,
      title: scene.title,
      desc: scene.description,
    });
    await runScenePhase(project, scene, sceneIndex, page, "afterCompile", options.runSceneHook);
    options.log?.(`Generated interactive Studio segment "${scene.id}": ${states.length} captured states, ${durationMs}ms`);
    return { svg, durationMs, evidence, cursor };
  } finally {
    await session.close();
  }
}

function replaceArtifacts(project: StudioProject, replacements: readonly StudioArtifact[]): StudioProject {
  const ids = new Set(replacements.map((artifact) => artifact.id));
  return validateStudioProject({ ...project, artifacts: [...project.artifacts.filter((artifact) => !ids.has(artifact.id)), ...replacements] });
}

/** Compile active live scenes to reusable artifacts, then compose the ordinary Studio storyboard. */
export async function compileStudioInteractiveProject(
  browser: Browser,
  raw: unknown,
  options: CompileStudioInteractiveProjectOptions,
): Promise<CompileStudioInteractiveProjectResult> {
  const project = validateStudioProject(raw);
  const projectDir = options.projectDir ?? process.cwd();
  const artifactDir = resolve(projectDir, options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const stageDir = mkdtempSync(join(artifactDir, ".studio-stage-"));
  const segments: StudioInteractiveSegment[] = [];
  const overrides: StudioSceneRecipeOverride[] = [];
  const artifacts: StudioArtifact[] = [];
  const publications: Array<{ staged: string; final: string }> = [];

  try {
    const generatedAt = options.generatedAt?.() ?? new Date().toISOString();
    for (let sceneIndex = 0; sceneIndex < project.scenes.length; sceneIndex++) {
      const scene = project.scenes[sceneIndex];
      if (!activeScene(scene)) continue;
      const compiled = await compileLiveSegment(browser, project, scene, sceneIndex, options);
      const stem = artifactStem(scene.id);
      const stagedSvg = join(stageDir, `${stem}.segment.svg`);
      const stagedEvidence = join(stageDir, `${stem}.evidence.json`);
      const finalSvg = join(artifactDir, `${stem}.segment.svg`);
      const finalEvidence = join(artifactDir, `${stem}.evidence.json`);
      const evidenceText = `${JSON.stringify({
        version: 1,
        sceneId: scene.id,
        sourceRevisionId: project.review.headRevisionId,
        observations: compiled.evidence,
        cursor: compiled.cursor,
      }, null, 2)}\n`;
      writeFileSync(stagedSvg, compiled.svg, "utf8");
      writeFileSync(stagedEvidence, evidenceText, "utf8");
      publications.push({ staged: stagedSvg, final: finalSvg }, { staged: stagedEvidence, final: finalEvidence });

      const segmentArtifactId = artifactId(scene.id, "segment");
      const evidenceArtifactId = artifactId(scene.id, "evidence");
      const svgSha256 = hash(compiled.svg);
      const evidenceSha256 = hash(evidenceText);
      const generator = { name: "domotion-studio-interactive", ...(options.generatorVersion == null ? {} : { version: options.generatorVersion }) };
      artifacts.push({
        id: evidenceArtifactId,
        kind: "capture-evidence",
        path: projectPath(projectDir, finalEvidence),
        generatedAt,
        generator,
        sourceRevisionId: project.review.headRevisionId,
        sceneIds: [scene.id],
        sha256: evidenceSha256,
        metadata: { durationMs: compiled.durationMs, eventIds: compiled.evidence.map((item) => item.eventId) },
      }, {
        id: segmentArtifactId,
        kind: "svg",
        path: projectPath(projectDir, finalSvg),
        generatedAt,
        generator,
        sourceRevisionId: project.review.headRevisionId,
        sceneIds: [scene.id],
        derivedFromArtifactIds: [evidenceArtifactId],
        sha256: svgSha256,
        metadata: { durationMs: compiled.durationMs },
      });
      segments.push({
        sceneId: scene.id,
        artifactId: segmentArtifactId,
        evidenceArtifactId,
        path: finalSvg,
        evidencePath: finalEvidence,
        durationMs: compiled.durationMs,
        sha256: svgSha256,
        evidenceSha256,
        evidence: compiled.evidence,
        cursor: compiled.cursor,
      });

      const recipe = scene.render.kind === "storyboard" ? scene.render.recipe : undefined;
      const override: StoryboardScene = {
        svg: stagedSvg,
        period: compiled.durationMs,
        duration: compiled.durationMs,
        ...(recipe?.fit != null ? { fit: recipe.fit } : {}),
        ...(recipe?.transition != null ? { transition: recipe.transition } : {}),
        ...(recipe?.overlays != null ? { overlays: recipe.overlays } : {}),
      };
      overrides.push({ sceneId: scene.id, recipe: override });
    }

    const updatedProject = replaceArtifacts(project, artifacts);
    const svg = await compileStudioProjectWithSceneOverrides(browser, project, overrides, { projectDir, log: options.log });
    for (const publication of publications) renameSync(publication.staged, publication.final);
    return { svg, project: updatedProject, segments };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
