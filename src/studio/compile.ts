import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "@playwright/test";
import {
  composeCompositeConfig,
  type CompositeConfig,
  type CompositeLayerConfig,
} from "../cli/composite.js";
import {
  composeStoryboardConfig,
  validateStoryboardConfig,
  type StoryboardScene,
} from "../cli/storyboard.js";
import { loadStudioProject, validateStudioProject } from "./project.js";
import type { StudioComposition, StudioProject } from "./project-schema.js";
import { applyStudioTreatments, resolveStudioTreatmentPlan } from "./treatments.js";

export interface CompileStudioProjectOptions {
  projectDir?: string;
  log?: (message: string) => void;
}

export class StudioProjectCompileError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`studio project compile: ${path}: ${message}`);
    this.name = "StudioProjectCompileError";
    this.path = path;
  }
}

interface MaterializeContext {
  browser: Browser;
  projectDir: string;
  workDir: string;
  log: (message: string) => void;
  nextFile: number;
}

function writeIntermediateSvg(ctx: MaterializeContext, svg: string): string {
  const path = join(ctx.workDir, `composition-${String(ctx.nextFile++).padStart(4, "0")}.svg`);
  writeFileSync(path, svg, "utf8");
  return path;
}

async function materializeComposition(
  composition: StudioComposition,
  path: string,
  ctx: MaterializeContext,
): Promise<string> {
  const layers: CompositeLayerConfig[] = [];
  for (let index = 0; index < composition.layers.length; index++) {
    const layer = composition.layers[index];
    if (layer.kind === "source") {
      layers.push(layer.source);
      continue;
    }
    const nestedSvg = await materializeComposition(
      layer.composition,
      `${path}.layers[${index}].composition`,
      ctx,
    );
    layers.push({
      svg: writeIntermediateSvg(ctx, nestedSvg),
      ...(layer.placement ?? {}),
    });
  }

  const config: CompositeConfig = {
    width: composition.width,
    height: composition.height,
    ...(composition.background != null ? { background: composition.background } : {}),
    ...(composition.duration != null ? { duration: composition.duration } : {}),
    layers,
  };
  ctx.log(`Materializing ${path} through the existing composite compositor…`);
  return composeCompositeConfig(ctx.browser, config, ctx.projectDir, ctx.log);
}

function assertStaticCompilerInputs(project: StudioProject): void {
  project.scenes.forEach((scene, sceneIndex) => {
    const trackIndex = scene.tracks?.findIndex((track) => track.events.length > 0) ?? -1;
    if (trackIndex >= 0) {
      throw new StudioProjectCompileError(
        `$.scenes[${sceneIndex}].tracks[${trackIndex}]`,
        "the static compiler does not execute semantic interaction events; compile an already-generated scene recipe or use the interactive Studio compiler",
      );
    }
    if ((scene.scriptHooks?.length ?? 0) > 0) {
      throw new StudioProjectCompileError(
        `$.scenes[${sceneIndex}].scriptHooks`,
        "the static compiler never executes script hooks; lower the hook to a generated scene before compiling",
      );
    }
  });
}

/** Internal bridge for compilers that have already materialized active scenes. */
export interface StudioSceneRecipeOverride {
  sceneId: string;
  recipe: StoryboardScene;
}

/**
 * Compile Studio's static subset by lowering recursive compositions through the
 * current composite compositor, then sequencing every scene through the current
 * storyboard compositor. No SVG becomes project state and no script is run.
 */
export async function compileStudioProject(
  browser: Browser,
  raw: unknown,
  options: CompileStudioProjectOptions = {},
): Promise<string> {
  const project = validateStudioProject(raw);
  assertStaticCompilerInputs(project);
  return compileValidatedStudioProject(browser, project, [], options);
}

/** Compose a validated project while replacing selected scenes with generated recipes. */
export async function compileStudioProjectWithSceneOverrides(
  browser: Browser,
  raw: unknown,
  overrides: readonly StudioSceneRecipeOverride[],
  options: CompileStudioProjectOptions = {},
): Promise<string> {
  const project = validateStudioProject(raw);
  const bySceneId = new Map(overrides.map((override) => [override.sceneId, override.recipe]));
  for (const override of overrides) {
    if (!project.scenes.some((scene) => scene.id === override.sceneId)) {
      throw new StudioProjectCompileError("$.scenes", `generated recipe references unknown scene id "${override.sceneId}"`);
    }
  }
  project.scenes.forEach((scene, sceneIndex) => {
    const active = (scene.tracks ?? []).some((track) => track.events.length > 0) || (scene.scriptHooks?.length ?? 0) > 0;
    if (active && !bySceneId.has(scene.id)) {
      throw new StudioProjectCompileError(`$.scenes[${sceneIndex}]`, `active scene "${scene.id}" has no generated recipe override`);
    }
  });
  return compileValidatedStudioProject(browser, project, overrides, options);
}

async function compileValidatedStudioProject(
  browser: Browser,
  project: StudioProject,
  overrides: readonly StudioSceneRecipeOverride[],
  options: CompileStudioProjectOptions,
): Promise<string> {
  const projectDir = options.projectDir ?? process.cwd();
  const log = options.log ?? (() => {});
  const workDir = mkdtempSync(join(tmpdir(), "domotion-studio-compile-"));
  const ctx: MaterializeContext = { browser, projectDir, workDir, log, nextFile: 0 };
  const bySceneId = new Map(overrides.map((override) => [override.sceneId, override.recipe]));

  try {
    const scenes: StoryboardScene[] = [];
    for (let index = 0; index < project.scenes.length; index++) {
      const scene = project.scenes[index];
      const generated = bySceneId.get(scene.id);
      let recipe: StoryboardScene;
      if (generated != null) {
        recipe = generated;
      } else if (scene.render.kind === "storyboard") {
        recipe = scene.render.recipe;
      } else {
        const svg = await materializeComposition(
          scene.render.composition,
          `$.scenes[${index}].render.composition`,
          ctx,
        );
        const svgPath = writeIntermediateSvg(ctx, svg);
        recipe = {
          svg: svgPath,
          duration: scene.render.duration ?? scene.render.composition.duration,
          ...(scene.render.trimStart != null ? { trimStart: scene.render.trimStart } : {}),
          ...(scene.render.trimEnd != null ? { trimEnd: scene.render.trimEnd } : {}),
          ...(scene.render.fit != null ? { fit: scene.render.fit } : {}),
          ...(scene.render.transition != null ? { transition: scene.render.transition } : {}),
          ...(scene.render.overlays != null ? { overlays: scene.render.overlays } : {}),
        };
      }

      if ((scene.treatments?.length ?? 0) > 0) {
        const plan = resolveStudioTreatmentPlan(scene.treatments, project.brand);
        const visual = scene.treatments!.filter((treatment) => treatment.kind !== "scene-transition");
        if (visual.length > 0) {
          log(`Rendering ${scene.id} before applying ${visual.length} cinematic treatment(s)…`);
          const isolated = await composeStoryboardConfig(browser, {
            width: project.canvas.width,
            height: project.canvas.height,
            ...(project.canvas.background != null ? { background: project.canvas.background } : {}),
            scenes: [{ ...recipe, transition: { type: "cut", duration: 0 } }],
          }, projectDir, log);
          const treated = applyStudioTreatments(isolated, visual, {
            width: project.canvas.width,
            height: project.canvas.height,
            brand: project.brand,
            assetDir: projectDir,
          });
          recipe = {
            svg: writeIntermediateSvg(ctx, treated.svg),
            ...(recipe.duration != null ? { duration: recipe.duration } : {}),
            fit: "contain",
            ...(plan.transition != null || recipe.transition != null ? { transition: plan.transition ?? recipe.transition } : {}),
          };
        } else if (plan.transition != null) {
          recipe = { ...recipe, transition: plan.transition };
        }
      }
      scenes.push(recipe);
    }

    const storyboard = validateStoryboardConfig({
      width: project.canvas.width,
      height: project.canvas.height,
      ...(project.canvas.background != null ? { background: project.canvas.background } : {}),
      ...(project.canvas.title != null ? { title: project.canvas.title } : {}),
      ...(project.canvas.desc != null ? { desc: project.canvas.desc } : {}),
      ...(project.playback?.cursor != null ? { cursor: project.playback.cursor } : {}),
      scenes,
    });
    log(`Compiling Studio project "${project.id}" through the existing storyboard compositor…`);
    return await composeStoryboardConfig(browser, storyboard, projectDir, log);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function compileStudioProjectFile(
  browser: Browser,
  projectPath: string,
  options: Omit<CompileStudioProjectOptions, "projectDir"> = {},
): Promise<string> {
  return compileStudioProject(browser, loadStudioProject(projectPath), {
    ...options,
    projectDir: dirname(projectPath),
  });
}
