import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSafely } from "../test-support/close-browser-safely.js";
import { openStudioProjectFile } from "./app-projects.js";
import { startStudioServer, type StudioServerHandle } from "./server.js";

describe("Domotion Studio application shell (DM-2687)", () => {
  let available = true;
  let root = "";
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let server: StudioServerHandle | null = null;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-browser-"));
    try {
      browser = await chromium.launch({ headless: true });
      server = await startStudioServer({ workspaceRoot: root });
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
    expect(persisted.scenes[0].title).toBe("Show the review loop");
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
});
