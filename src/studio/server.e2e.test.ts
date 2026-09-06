import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSafely } from "../test-support/close-browser-safely.js";
import { createStudioProjectFile, openStudioProjectFile, saveStudioProjectFile } from "./app-projects.js";
import { startStudioServer, type StudioGenerationInput, type StudioGenerationResult, type StudioServerHandle } from "./server.js";
import { htmlWrapper, seekTo, screenshot } from "../cli/svg-to-video-core.js";
import { studioContentRevisionId } from "./authoring.js";

const PREVIEW_TIME = "2026-09-06T04:00:00.000Z";

function animatedPreview(color: string, durationMs: number, distance: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60"><style>:root{--scene-dur:${durationMs / 1000}s}@keyframes move{from{transform:translateX(0)}to{transform:translateX(${distance}px)}}.subject{animation:move ${durationMs / 1000}s linear infinite}</style><rect width="100" height="60" fill="#101522"/><rect class="subject" x="5" y="20" width="20" height="20" fill="${color}"/></svg>`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Domotion Studio application shell (DM-2687)", () => {
  let available = true;
  let root = "";
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let server: StudioServerHandle | null = null;
  const generationInputs: StudioGenerationInput[] = [];
  let generationCount = 0;

  const generate = async (input: StudioGenerationInput): Promise<StudioGenerationResult> => {
    generationInputs.push(structuredClone(input));
    const next = structuredClone(input.project);
    const selectedSceneId = input.selection.kind === "scene" ? input.selection.sceneId : undefined;
    const selectedScenes = selectedSceneId == null ? next.scenes : next.scenes.filter((scene) => scene.id === selectedSceneId);
    const durationMs = selectedScenes.reduce((total, scene) => total + (scene.render.kind === "storyboard" ? scene.render.recipe.duration ?? 1600 : scene.render.duration ?? scene.render.composition.duration ?? 1600), 0);
    const svg = animatedPreview(input.selection.kind === "story" ? "#7690ff" : "#f0a64a", durationMs, 48);
    const token = `${input.selection.kind === "story" ? "story" : input.selection.sceneId}-${++generationCount}`;
    const workspacePath = `generated/${token}.svg`;
    mkdirSync(join(input.workspaceRoot, "generated"), { recursive: true });
    writeFileSync(join(input.workspaceRoot, workspacePath), svg);
    next.artifacts.push({
      id: `artifact-${token}`,
      kind: "svg",
      path: workspacePath,
      generatedAt: new Date(Date.parse(PREVIEW_TIME) + generationCount * 1000).toISOString(),
      generator: { name: "studio-e2e-ai" },
      sourceRevisionId: studioContentRevisionId(next),
      ...(input.selection.kind === "scene" ? { sceneIds: [input.selection.sceneId] } : {}),
      sha256: digest(svg),
      metadata: { durationMs },
    });
    return {
      status: "completed",
      project: next,
      ai: {
        healing: { status: "accepted", summary: "Inspected live DOM/CSS evidence; no repair was required." },
        review: { status: "accepted", summary: "Reviewed the rendered segment across the required visual dimensions." },
      },
    };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-browser-"));
    try {
      browser = await chromium.launch({ headless: true });
      server = await startStudioServer({ workspaceRoot: root, generate });
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      page = await context.newPage();
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    await context?.close().catch(() => {});
    if (server != null && browser != null) await closeSafely(() => server!.close(), browser, 6_000);
    else {
      await server?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }, 15_000);

  it("creates, edits, saves, and reopens a project through the real browser UI", async () => {
    if (!available || page == null || server == null) return;
    const testPage = page;
    const clientErrors: string[] = [];
    testPage.on("pageerror", (error) => clientErrors.push(error.message));
    await testPage.goto(server.url, { waitUntil: "load" });

    await testPage.getByRole("heading", { name: "Create or open a Studio project" }).waitFor();
    await testPage.getByLabel("Project file").fill("glassbox.studio.json");
    await testPage.getByLabel("New project title").fill("Glassbox Story");
    await testPage.getByRole("button", { name: "Create" }).click();

    await testPage.getByRole("heading", { name: "Glassbox Story" }).waitFor();
    await testPage.getByText("Template · title-card").waitFor();
    await testPage.getByText("Needs generation").waitFor();
    await testPage.locator('[data-field="narrative-title"]').fill("Glassbox Reveal");
    await testPage.getByLabel("Scene 1 title").fill("Show the review loop");
    await testPage.getByText("Unsaved changes").waitFor();

    const save = testPage.getByRole("button", { name: "Save" });
    expect(await save.isEnabled()).toBe(true);
    await save.click();
    await expect.poll(() => testPage.getByRole("status").textContent()).toContain("Saved glassbox.studio.json");
    await testPage.getByText("Saved", { exact: true }).waitFor();

    await testPage.locator('[data-field="narrative-title"]').fill("Unsaved temporary title");
    await testPage.getByText("Unsaved changes").waitFor();
    await testPage.getByRole("button", { name: "Reopen" }).click();
    await testPage.getByRole("heading", { name: "Glassbox Reveal" }).waitFor();
    expect(await testPage.locator('[data-field="narrative-title"]').inputValue()).toBe("Glassbox Reveal");
    expect(await testPage.getByLabel("Scene 1 title").inputValue()).toBe("Show the review loop");

    await testPage.getByRole("button", { name: "Add beat" }).click();
    const secondBeat = testPage.locator("[data-beat-id]").nth(1);
    await secondBeat.getByLabel(/Beat .* title/).fill("Payoff");
    await secondBeat.getByLabel(/Beat .* summary/).fill("Close on the generated result.");
    await testPage.getByRole("button", { name: "Add scene" }).click();
    const secondScene = testPage.locator("[data-scene-id]").nth(1);
    await secondScene.getByLabel("Scene 2 title").fill("Generated payoff");
    await secondScene.getByLabel("Scene 2 description").fill("Show the reviewed output.");
    await secondScene.getByLabel("Scene 2 generation instructions").fill("Inspect the live DOM and computed CSS before capture, then keep the cursor deliberate.");
    await secondScene.getByLabel("Scene 2 narrative beat").selectOption({ label: "Payoff" });
    await secondScene.getByLabel("Scene 2 source type").selectOption("svg");
    await testPage.locator("[data-scene-id]").nth(1).getByLabel("Scene 2 source", { exact: true }).fill("source/payoff.svg");
    await testPage.locator("[data-scene-id]").nth(1).getByLabel("Scene 2 source", { exact: true }).press("Tab");
    await secondScene.getByLabel("Scene 2 trim start").fill("200");
    await secondScene.getByLabel("Scene 2 trim start").press("Tab");
    await secondScene.getByLabel("Scene 2 trim end").fill("1200");
    await secondScene.getByLabel("Scene 2 trim end").press("Tab");
    await secondScene.getByLabel("Scene 2 fit").selectOption("cover");
    await secondScene.getByLabel("Scene 2 transition", { exact: true }).selectOption("push-left");
    await secondScene.getByLabel("Scene 2 cinematic preset").selectOption("browser-chrome");
    await secondScene.getByRole("button", { name: "Regenerate scene" }).click();
    await expect.poll(() => testPage.getByRole("status").textContent()).toContain("Generated glassbox.studio.json");
    await testPage.frameLocator("[data-scrubber-frame]").locator(".svg-host svg").waitFor();
    expect(generationInputs.at(-1)).toMatchObject({
      selection: { kind: "scene" },
      aiPolicy: { healing: "required", review: "required" },
      project: { scenes: [{}, { title: "Generated payoff", generationInstructions: expect.stringContaining("computed CSS") }] },
    });
    await testPage.getByRole("button", { name: "Reopen", exact: true }).click();
    await testPage.getByLabel("Scene 2 title").waitFor();
    expect(await testPage.getByLabel("Scene 2 source", { exact: true }).inputValue()).toBe("source/payoff.svg");
    expect(await testPage.getByLabel("Scene 2 duration").inputValue()).toBe("1000");
    expect(await testPage.getByLabel("Scene 2 fit").inputValue()).toBe("cover");
    expect(await testPage.getByLabel("Scene 2 cinematic preset").inputValue()).toBe("browser-chrome");

    await testPage.getByLabel("New review note").fill("Pause on the highlighted control.");
    await testPage.getByLabel("Annotation scope").selectOption("scene-opening");
    await testPage.getByLabel("Annotation start time").fill("420");
    await testPage.getByLabel("Annotation end time").fill("780");
    await testPage.getByLabel("Annotation region x").fill("24");
    await testPage.getByLabel("Annotation region y").fill("36");
    await testPage.getByLabel("Annotation region width").fill("180");
    await testPage.getByLabel("Annotation region height").fill("72");
    await testPage.getByRole("button", { name: "Add annotation" }).click();
    await expect.poll(() => testPage.getByRole("status").textContent()).toContain("Added annotation");
    const annotation = testPage.locator("[data-annotation-id]").first();
    await annotation.getByText("Scene scene-opening · point 420ms · 420–780ms · 1 region").waitFor();
    await annotation.locator("textarea").fill("Pause longer on the highlighted control.");
    await annotation.getByRole("button", { name: "Save note" }).click();
    await expect.poll(() => testPage.getByRole("status").textContent()).toContain("Updated annotation");
    await annotation.locator("textarea").fill("Resolve this edited draft without losing it.");
    await annotation.getByRole("button", { name: "Resolve", exact: true }).click();
    await annotation.getByRole("button", { name: "Reopen note", exact: true }).waitFor();
    await annotation.getByRole("button", { name: "Reopen note", exact: true }).click();
    await annotation.getByRole("button", { name: "Resolve", exact: true }).waitFor();
    await annotation.getByRole("button", { name: "Resolve", exact: true }).click();
    await annotation.getByText("resolved", { exact: true }).waitFor();
    await testPage.getByRole("button", { name: "Reopen", exact: true }).click();
    await annotation.getByText("resolved", { exact: true }).waitFor();
    expect(await annotation.locator("textarea").inputValue()).toBe("Resolve this edited draft without losing it.");

    const persisted = openStudioProjectFile(root, "glassbox.studio.json").project;
    expect(persisted.narrative.title).toBe("Glassbox Reveal");
    expect(persisted.scenes).toHaveLength(2);
    expect(persisted.scenes[0].title).toBe("Show the review loop");
    expect(persisted.scenes[1]).toMatchObject({
      title: "Generated payoff",
      generationInstructions: expect.stringContaining("computed CSS"),
      render: { kind: "storyboard", recipe: { svg: "source/payoff.svg", trimStart: 200, trimEnd: 1200, duration: 1000, fit: "cover", transition: { type: "push-left" } } },
      treatments: [{ kind: "browser-chrome", theme: "dark" }],
    });
    expect(persisted.artifacts.some((artifact) => artifact.sceneIds?.includes(persisted.scenes[1].id))).toBe(true);
    expect(persisted.review.revisions.some((revision) => revision.kind === "content")).toBe(true);
    expect(persisted.review.annotations).toHaveLength(1);
    expect(persisted.review.annotations[0]).toMatchObject({
      status: "resolved",
      body: "Resolve this edited draft without losing it.",
      author: { kind: "human", name: "Reviewer" },
      target: {
        scope: { kind: "scene", sceneId: "scene-opening" },
        time: { pointMs: 420, range: { startMs: 420, endMs: 780 } },
        regions: [{ x: 24, y: 36, width: 180, height: 72, coordinateSpace: "scene" }],
      },
    });
    expect(persisted.review.annotations[0].resolvedRevisionId).toBe(persisted.review.annotations[0].statusRevisionId);
    expect(clientErrors).toEqual([]);
  }, 60_000);

  it("forces browser-route authors to human and rejects stale or generic review overwrites", async () => {
    if (!available || server == null) return;
    const before = openStudioProjectFile(root, "glassbox.studio.json").project;
    const createdResponse = await fetch(new URL("/api/annotation", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "glassbox.studio.json",
        expectedHeadRevisionId: before.review.headRevisionId,
        command: { kind: "create", body: "Spoof attempt", author: { kind: "ai", name: "Browser caller" } },
      }),
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as { project: typeof before };
    expect(created.project.review.annotations.at(-1)?.author).toEqual({ kind: "human", name: "Browser caller" });

    const staleSave = await fetch(new URL("/api/save", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "glassbox.studio.json", expectedHeadRevisionId: before.review.headRevisionId, project: before }),
    });
    expect(staleSave.status).toBe(409);

    const tampered = structuredClone(created.project);
    tampered.review.annotations[0].body = "Changed outside the annotation API";
    const genericReviewSave = await fetch(new URL("/api/save", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "glassbox.studio.json", expectedHeadRevisionId: created.project.review.headRevisionId, project: tampered }),
    });
    expect(genericReviewSave.status).toBe(400);
    await expect(genericReviewSave.json()).resolves.toMatchObject({ error: expect.stringContaining("/api/annotation") });
  });

  it("switches scene/story previews, preserves scrub context after regeneration, and matches exported pixels", async () => {
    if (!available || page == null || server == null || context == null) return;
    const generatedDir = join(root, "generated");
    mkdirSync(generatedDir, { recursive: true });
    const opening = animatedPreview("#ff3355", 2000, 60);
    const detail = animatedPreview("#33cc88", 1200, 40);
    const story = animatedPreview("#6699ff", 3200, 70);
    writeFileSync(join(generatedDir, "opening.svg"), opening);
    writeFileSync(join(generatedDir, "detail.svg"), detail);
    writeFileSync(join(generatedDir, "story.svg"), story);
    const created = createStudioProjectFile(root, "previews.studio.json", { title: "Preview story", createdAt: PREVIEW_TIME });
    const authored = structuredClone(created.project);
    authored.scenes.push({
      id: "scene-detail",
      title: "Detail",
      narrativeBeatIds: ["beat-opening"],
      render: { kind: "storyboard", recipe: { template: "title-card", params: { title: "Detail" }, duration: 1200 } },
    });
    authored.narrative.beats[0].sceneIds.push("scene-detail");
    const revision = authored.review.headRevisionId;
    authored.artifacts.push(
      { id: "artifact-opening", kind: "svg", path: "generated/opening.svg", generatedAt: PREVIEW_TIME, generator: { name: "test" }, sourceRevisionId: revision, sceneIds: ["scene-opening"], sha256: digest(opening), metadata: { durationMs: 2000 } },
      { id: "artifact-detail", kind: "svg", path: "generated/detail.svg", generatedAt: PREVIEW_TIME, generator: { name: "test" }, sourceRevisionId: revision, sceneIds: ["scene-detail"], sha256: digest(detail), metadata: { durationMs: 1200 } },
      { id: "artifact-story", kind: "svg", path: "generated/story.svg", generatedAt: PREVIEW_TIME, generator: { name: "test" }, sourceRevisionId: revision, sha256: digest(story), metadata: { durationMs: 3200 } },
    );
    saveStudioProjectFile(root, "previews.studio.json", authored, PREVIEW_TIME);

    const testPage = page;
    await testPage.goto(server.url, { waitUntil: "load" });
    await testPage.getByLabel("Project file").fill("previews.studio.json");
    await testPage.getByRole("button", { name: "Open", exact: true }).click();
    await testPage.getByRole("heading", { name: "Preview story" }).waitFor();
    await testPage.getByRole("button", { name: "Scene 1", exact: true }).click();
    const scrubber = testPage.frameLocator("[data-scrubber-frame]");
    await scrubber.locator(".svg-host svg").waitFor();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("/ 0:02.00");

    await scrubber.locator("[data-action=scrub]").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "500";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await scrubber.locator("[data-action=inn]").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "0.25";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await scrubber.locator("[data-action=outn]").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "1.50";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await scrubber.locator("[data-action=zoompreset]").selectOption("1.5");
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:01.00 / 0:02.00");
    await testPage.waitForTimeout(150);

    await testPage.getByRole("button", { name: "Scene 2", exact: true }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("/ 0:01.20");
    await scrubber.getByRole("button", { name: "Next frame" }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:00.03");
    await testPage.waitForTimeout(150);

    await testPage.getByRole("button", { name: "Scene 1", exact: true }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:01.00 / 0:02.00");
    expect(await scrubber.locator("[data-action=inn]").inputValue()).toBe("0.25");
    expect(await scrubber.locator("[data-action=outn]").inputValue()).toBe("1.50");
    expect(await scrubber.locator("[data-action=zoompreset]").inputValue()).toBe("1.5");

    const regenerated = animatedPreview("#ffaa22", 1200, 50);
    writeFileSync(join(generatedDir, "opening.svg"), regenerated);
    const latest = openStudioProjectFile(root, "previews.studio.json").project;
    const openingArtifact = latest.artifacts.find((artifact) => artifact.id === "artifact-opening")!;
    openingArtifact.generatedAt = "2026-09-06T04:05:00.000Z";
    openingArtifact.sha256 = digest(regenerated);
    openingArtifact.metadata = { durationMs: 1200 };
    saveStudioProjectFile(root, "previews.studio.json", latest, "2026-09-06T04:05:00.000Z");
    await testPage.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:01.00 / 0:01.20");
    expect(await scrubber.locator("[data-action=outn]").inputValue()).toBe("1.20");

    await testPage.getByRole("button", { name: "Whole story", exact: true }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("/ 0:03.20");
    const beforePlay = await scrubber.locator(".time").textContent();
    await scrubber.getByRole("button", { name: "Play" }).click();
    await testPage.waitForTimeout(180);
    await scrubber.getByRole("button", { name: "Pause" }).click();
    expect(await scrubber.locator(".time").textContent()).not.toBe(beforePlay);

    await testPage.getByRole("button", { name: "Scene 1", exact: true }).click();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("/ 0:01.20");
    await scrubber.locator("[data-action=zoompreset]").selectOption("1");
    await scrubber.getByRole("button", { name: "center" }).click();
    await scrubber.locator("[data-action=scrub]").evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "500";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:00.60");
    const embeddedSubjectX = await scrubber.locator(".subject").evaluate((element) => {
      const subjectElement = element as SVGGraphicsElement;
      const subject = subjectElement.getBoundingClientRect();
      const svg = subjectElement.ownerSVGElement!.getBoundingClientRect();
      return subject.x - svg.x;
    });
    await scrubber.locator(".svg-host").evaluate((host) => {
      const element = host as HTMLElement;
      element.style.position = "absolute";
      element.style.inset = "0 auto auto 0";
      element.style.width = "100px";
      element.style.height = "60px";
      element.style.display = "block";
      element.style.transform = "none";
    });
    const embeddedPng = await scrubber.locator(".svg-host svg").screenshot({ omitBackground: true });
    const exportPage = await context.newPage();
    try {
      await exportPage.setViewportSize({ width: 100, height: 60 });
      await exportPage.setContent(htmlWrapper(regenerated, "transparent"), { waitUntil: "load" });
      await seekTo(exportPage, 600);
      const exportedSubjectX = await exportPage.locator(".subject").evaluate((element) => {
        const subjectElement = element as SVGGraphicsElement;
        const subject = subjectElement.getBoundingClientRect();
        const svg = subjectElement.ownerSVGElement!.getBoundingClientRect();
        return subject.x - svg.x;
      });
      const exportedPng = await screenshot(exportPage, true);
      const sharp = (await import("sharp")).default;
      const [embeddedPixels, exportedPixels] = await Promise.all([
        sharp(embeddedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(exportedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      ]);
      expect(embeddedPixels.info).toMatchObject({ width: 100, height: 60, channels: 4 });
      expect(exportedPixels.info).toMatchObject({ width: 100, height: 60, channels: 4 });
      let changedChannels = 0;
      let maxDelta = 0;
      for (let index = 0; index < embeddedPixels.data.length; index++) {
        const delta = Math.abs(embeddedPixels.data[index] - exportedPixels.data[index]);
        if (delta > 0) changedChannels++;
        maxDelta = Math.max(maxDelta, delta);
      }
      expect(embeddedSubjectX).toBeCloseTo(exportedSubjectX, 4);
      expect(changedChannels).toBeLessThan(100);
      expect(maxDelta).toBeLessThanOrEqual(32);
    } finally {
      await exportPage.close();
    }
  }, 60_000);
});
