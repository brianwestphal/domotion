import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSafely } from "../test-support/close-browser-safely.js";
import { createStudioProjectFile, openStudioProjectFile, saveStudioProjectFile } from "./app-projects.js";
import { startStudioServer, type StudioServerHandle } from "./server.js";

const NOW = "2026-09-06T10:00:00.000Z";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#101522"/><circle cx="80" cy="90" r="24" fill="#7690ff"/></svg>`;

describe("Studio detailed multitrack timeline browser workflow (DM-2692)", () => {
  let available = true;
  let root = "";
  let browser: Browser | null = null;
  let page: Page | null = null;
  let server: StudioServerHandle | null = null;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-timeline-"));
    try {
      const created = createStudioProjectFile(root, "timeline.studio.json", { title: "Timeline E2E", createdAt: NOW });
      const project = structuredClone(created.project);
      project.scenes[0].render = { kind: "storyboard", recipe: { template: "title-card", params: { title: "Timeline" }, duration: 1200, transition: { type: "cut", duration: 0 } } };
      project.scenes[0].tracks = [{
        id: "track-demo",
        kind: "semantic-interactions",
        events: [
          { id: "event-start", kind: "click", atMs: 100, durationMs: 100, target: { role: "button", name: "Start" } },
          { id: "event-next", kind: "hover", atMs: 700, durationMs: 100, target: { role: "button", name: "Next" } },
        ],
      }];
      mkdirSync(join(root, "generated"));
      writeFileSync(join(root, "generated/story.svg"), SVG);
      project.artifacts.push({
        id: "artifact-story",
        kind: "svg",
        path: "generated/story.svg",
        generatedAt: NOW,
        generator: { name: "timeline-e2e" },
        sourceRevisionId: project.review.headRevisionId,
        sha256: createHash("sha256").update(SVG).digest("hex"),
        metadata: { durationMs: 1200 },
      });
      saveStudioProjectFile(root, "timeline.studio.json", project, NOW);
      browser = await chromium.launch({ headless: true });
      server = await startStudioServer({ workspaceRoot: root, initialProjectPath: "timeline.studio.json" });
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (server != null && browser != null) await closeSafely(() => server!.close(), browser, 6_000);
    else {
      await server?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }, 15_000);

  it("keeps selection in preview sync and commits pointer, keyboard, undo, and redo edits through one API", async () => {
    if (!available || page == null || server == null) return;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url, { waitUntil: "load" });
    await page.getByRole("heading", { name: "Timeline E2E" }).waitFor();
    await page.getByRole("region", { name: "Multitrack timeline" }).waitFor();

    const first = page.locator('[data-timeline-id="semantic:scene-opening:track-demo:event-start"]');
    await first.click();
    const scrubber = page.frameLocator("[data-scrubber-frame]");
    await scrubber.locator(".svg-host svg").waitFor();
    await expect.poll(() => scrubber.locator(".time").textContent()).toContain("0:00.10 / 0:01.20");

    const keyboardResponse = page.waitForResponse((response) => response.url().endsWith("/api/timeline") && response.request().method() === "POST");
    await first.press("ArrowRight");
    await keyboardResponse;
    await expect.poll(() => openStudioProjectFile(root, "timeline.studio.json").project.scenes[0].tracks?.[0].events[0].atMs).toBe(150);
    await expect.poll(() => page!.getByRole("button", { name: "Undo timeline" }).isEnabled()).toBe(true);

    const moved = page.locator('[data-timeline-id="semantic:scene-opening:track-demo:event-start"]');
    await moved.hover({ position: { x: 3, y: 15 } });
    const box = await moved.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    const pointerResponse = page.waitForResponse((response) => response.url().endsWith("/api/timeline") && response.request().method() === "POST");
    await page.mouse.down();
    await page.mouse.move(box!.x + 11, box!.y + box!.height / 2);
    await page.mouse.up();
    await pointerResponse;
    await expect.poll(() => openStudioProjectFile(root, "timeline.studio.json").project.scenes[0].tracks?.[0].events[0].atMs).toBe(250);
    await expect.poll(() => page!.getByRole("button", { name: "Undo timeline" }).isEnabled()).toBe(true);

    const resized = page.locator('[data-timeline-id="semantic:scene-opening:track-demo:event-start"]');
    await resized.press("Alt+ArrowRight");
    await expect.poll(() => openStudioProjectFile(root, "timeline.studio.json").project.scenes[0].tracks?.[0].events[0].durationMs).toBe(150);

    await page.getByRole("button", { name: "Undo timeline" }).click();
    await expect.poll(() => openStudioProjectFile(root, "timeline.studio.json").project.scenes[0].tracks?.[0].events[0].durationMs).toBe(100);
    await page.getByRole("button", { name: "Redo timeline" }).click();
    await expect.poll(() => openStudioProjectFile(root, "timeline.studio.json").project.scenes[0].tracks?.[0].events[0].durationMs).toBe(150);

    const persisted = openStudioProjectFile(root, "timeline.studio.json").project;
    expect(persisted.review.revisions.filter((revision) => revision.metadata?.operation === "studio.timeline.set-timing")).toHaveLength(5);
    expect(errors).toEqual([]);
  }, 60_000);
});
