import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileStudioInteractiveProject } from "./interactive-compile.js";
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
      const runHook = async ({ page, input }: { page: import("@playwright/test").Page; input?: Record<string, unknown> }) => {
        await page.locator("#panel").evaluate((element, text) => { element.textContent = String(text); }, input?.text);
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
        "event-open", "event-type", "event-expand", "event-hook", "event-scroll",
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
      const localReferences = [...firstSegmentSvg.matchAll(/(?:href="|url\(#)([^"\)]+)["\)]/g)].map((match) => match[1].replace(/^#/, ""));
      for (const reference of localReferences) expect(idSet, `missing local SVG reference ${reference}`).toContain(reference);
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
      const persistedEvidence = JSON.parse(readFileSync(first.segments[0].evidencePath, "utf8")) as { sourceRevisionId: string; observations: unknown[] };
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
      expect(second.project.artifacts.map((artifact) => artifact.id).sort()).toEqual(first.project.artifacts.map((artifact) => artifact.id).sort());
      expect(readdirSync(artifactDir).filter((name) => name.endsWith(".svg"))).toHaveLength(1);

      const stableSegment = readFileSync(second.segments[0].path, "utf8");
      const broken = structuredClone(authored);
      const target = broken.scenes[0].tracks![0].events[0];
      if ("target" in target && target.target != null) target.target = { role: "button", name: "Missing action" };
      await expect(compileStudioInteractiveProject(browser, broken, {
        projectDir: fixtureDir,
        artifactDir,
        generatedAt,
        runSceneHook,
        runHook,
      })).rejects.toThrow(/Missing action.*matched no element/);
      expect(readFileSync(second.segments[0].path, "utf8")).toBe(stableSegment);
      expect(readdirSync(artifactDir).some((name) => name.startsWith(".studio-stage-"))).toBe(false);
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 120_000);
});
