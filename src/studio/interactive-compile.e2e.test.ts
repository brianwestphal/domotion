import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { compileStudioInteractiveProject, finalCursorPoint } from "./interactive-compile.js";
import { loadStudioProject } from "./project.js";

const fixturePath = resolve("tests/fixtures/studio/interactive-story.project.json");
const fixtureDir = resolve("tests/fixtures/studio");
const generatedAt = () => "2026-09-06T04:00:00.000Z";

describe("Studio interactive segment compilation (DM-2685)", () => {
  let browser: Browser | null = null;

  afterAll(async () => browser?.close(), 15_000);

  it("captures a live multi-action scene, embeds it with a pre-rendered scene, and recaptures only generated artifacts", async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      return;
    }
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-studio-interactive-e2e-"));
    try {
      const authored = loadStudioProject(fixturePath);
      const authoredScenes = structuredClone(authored.scenes);
      const authoredAnnotations = structuredClone(authored.review.annotations);
      const unrelated = structuredClone(authored.artifacts.find((artifact) => artifact.id === "artifact-unrelated"));
      const scenePhases: string[] = [];
      const runSceneHook = async ({ page, phase }: { page: import("@playwright/test").Page; phase: string }) => {
        scenePhases.push(phase);
        if (phase === "beforeCapture") {
          await page.locator("main").evaluate((element) => element.setAttribute("data-scene-hook", "ready"));
        }
      };
      const runHook = async ({
        page,
        input,
      }: {
        page: import("@playwright/test").Page;
        input?: Record<string, unknown>;
      }) => {
        await page.locator("#panel").evaluate((element, text) => {
          element.textContent = String(text);
        }, input?.text);
      };
      const first = await compileStudioInteractiveProject(browser, authored, {
        projectDir: fixtureDir,
        artifactDir,
        generatedAt,
        generatorVersion: "test",
        runSceneHook,
        runHook,
      });

      expect(first.segments).toHaveLength(1);
      expect(first.segments[0].sceneId).toBe("scene-live");
      expect(first.segments[0].evidence.map((item) => item.eventId)).toEqual([
        "event-open",
        "event-type",
        "event-expand",
        "event-hook",
        "event-scroll",
      ]);
      expect(first.segments[0].evidence.every((item) => item.meaningful)).toBe(true);
      expect(first.segments[0].cursor.interactions).toHaveLength(4);
      expect(scenePhases).toEqual(["beforeCapture", "afterCapture", "beforeCompile", "afterCompile"]);
      const firstSegmentSvg = readFileSync(first.segments[0].path, "utf8");
      expect(firstSegmentSvg).toContain('class="cursor-overlay"');
      expect(firstSegmentSvg).toContain("Details hooked");
      const ids = [...firstSegmentSvg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size, "live segment ids must be document-unique").toBe(ids.length);
      const idSet = new Set(ids);
      const localReferences = [...firstSegmentSvg.matchAll(/(?:href="|url\(#)([^"\)]+)["\)]/g)].map((match) =>
        match[1].replace(/^#/, ""),
      );
      for (const reference of localReferences)
        expect(idSet, `missing local SVG reference ${reference}`).toContain(reference);
      expect(first.svg).toContain("interactive-followup-marker");
      expect(first.svg).toContain("Details hooked");
      expect(first.svg).toContain("sb0_cursor-overlay");

      expect(first.project.scenes).toEqual(authoredScenes);
      expect(first.project.review.annotations).toEqual(authoredAnnotations);
      expect(first.project.artifacts.find((artifact) => artifact.id === "artifact-unrelated")).toEqual(unrelated);
      expect(first.project.artifacts.filter((artifact) => artifact.sceneIds?.includes("scene-live"))).toHaveLength(2);
      expect(first.project.artifacts.find((artifact) => artifact.id === "artifact-scene-live-segment")).toMatchObject({
        sourceRevisionId: "revision-1",
        derivedFromArtifactIds: ["artifact-scene-live-evidence"],
        sha256: first.segments[0].sha256,
      });
      const persistedEvidence = JSON.parse(readFileSync(first.segments[0].evidencePath, "utf8")) as {
        sourceRevisionId: string;
        observations: unknown[];
      };
      expect(persistedEvidence.sourceRevisionId).toBe("revision-1");
      expect(persistedEvidence.observations).toHaveLength(5);

      scenePhases.length = 0;
      const second = await compileStudioInteractiveProject(browser, first.project, {
        projectDir: fixtureDir,
        artifactDir,
        generatedAt,
        generatorVersion: "test",
        runSceneHook,
        runHook,
      });
      expect(second.segments[0].sha256).toBe(first.segments[0].sha256);
      expect(scenePhases).toEqual(["beforeCapture", "afterCapture", "beforeCompile", "afterCompile"]);
      expect(second.project.artifacts.map((artifact) => artifact.id).sort()).toEqual(
        first.project.artifacts.map((artifact) => artifact.id).sort(),
      );
      expect(readdirSync(artifactDir).filter((name) => name.endsWith(".svg"))).toHaveLength(1);

      const stableSegment = readFileSync(second.segments[0].path, "utf8");
      const broken = structuredClone(authored);
      const target = broken.scenes[0].tracks![0].events[0];
      if ("target" in target && target.target != null) target.target = { role: "button", name: "Missing action" };
      await expect(
        compileStudioInteractiveProject(browser, broken, {
          projectDir: fixtureDir,
          artifactDir,
          generatedAt,
          runSceneHook,
          runHook,
        }),
      ).rejects.toThrow(/Missing action.*matched no element/);
      expect(readFileSync(second.segments[0].path, "utf8")).toBe(stableSegment);
      expect(readdirSync(artifactDir).some((name) => name.startsWith(".studio-stage-"))).toBe(false);
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("continues the cursor from one consecutive live scene into the next, unless a start is supplied or a static scene intervenes", async () => {
    try {
      browser ??= await chromium.launch({ headless: true });
    } catch {
      return;
    }
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-studio-chain-e2e-"));
    try {
      const base = loadStudioProject(fixturePath);
      const live = base.scenes.find((scene) => scene.id === "scene-live")!;
      const finish = base.scenes.find((scene) => scene.id === "scene-finish")!;
      const second = structuredClone(live);
      second.id = "scene-live-b";
      second.title = "Second live";
      second.narrativeBeatIds = ["beat-live-b"];
      second.scriptHooks = [];
      second.tracks = [
        {
          id: "track-live-b",
          kind: "semantic-interactions",
          events: [
            { id: "event-open-b", atMs: 0, kind: "click", target: { role: "button", name: "Open details" } },
            { id: "event-expand-b", atMs: 800, kind: "click", target: { role: "button", name: "Expand details" } },
          ],
        },
      ];
      const project = (scenes: typeof base.scenes): typeof base => {
        const next = structuredClone(base);
        next.scenes = scenes;
        next.narrative.beats = scenes.map((scene) => ({
          id: scene.narrativeBeatIds?.[0] ?? `beat-${scene.id}`,
          title: scene.title ?? scene.id,
          sceneIds: [scene.id],
        }));
        // Annotations and artifacts of the full fixture point at scenes a subset omits.
        next.review.annotations = [];
        next.artifacts = [];
        return next;
      };
      const noopHook = async (): Promise<void> => {};
      const hooks = { runSceneHook: noopHook, runHook: async () => undefined };
      const compile = (scenes: typeof base.scenes, extra: Record<string, unknown> = {}) =>
        compileStudioInteractiveProject(browser!, project(scenes), {
          projectDir: fixtureDir,
          artifactDir,
          generatedAt,
          generatorVersion: "test",
          ...hooks,
          ...extra,
        });
      const startOf = (cursor: { overlay: { events: Array<{ type: string; x?: number; y?: number }> } }) => {
        const show = cursor.overlay.events[0];
        expect(show.type).toBe("show");
        return { x: show.x, y: show.y };
      };

      const chained = await compile([structuredClone(live), structuredClone(second)]);
      expect(chained.segments).toHaveLength(2);
      const rest = finalCursorPoint(chained.segments[0].cursor)!;
      expect(rest).toBeDefined();
      expect(startOf(chained.segments[1].cursor)).toEqual({ x: rest.x, y: rest.y });

      // The same second scene planned alone starts from the default lead-in point instead.
      const alone = await compile([structuredClone(second)]);
      expect(startOf(alone.segments[0].cursor)).not.toEqual({ x: rest.x, y: rest.y });

      // A pre-rendered scene between the two is a different picture: continuity ends there.
      const interrupted = await compile([structuredClone(live), structuredClone(finish), structuredClone(second)]);
      expect(startOf(interrupted.segments[1].cursor)).toEqual(startOf(alone.segments[0].cursor));

      // An explicit start is art direction and wins for every scene.
      const explicit = await compile([structuredClone(live), structuredClone(second)], {
        cursor: { start: { x: 20, y: 30 } },
      });
      expect(startOf(explicit.segments[0].cursor)).toEqual({ x: 20, y: 30 });
      expect(startOf(explicit.segments[1].cursor)).toEqual({ x: 20, y: 30 });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 240_000);
});
