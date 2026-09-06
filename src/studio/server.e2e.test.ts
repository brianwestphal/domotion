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
    const clientErrors: string[] = [];
    page.on("pageerror", (error) => clientErrors.push(error.message));
    await page.goto(server.url, { waitUntil: "load" });

    await page.getByRole("heading", { name: "Create or open a Studio project" }).waitFor();
    await page.getByLabel("Project file").fill("glassbox.studio.json");
    await page.getByLabel("New project title").fill("Glassbox Story");
    await page.getByRole("button", { name: "Create" }).click();

    await page.getByRole("heading", { name: "Glassbox Story" }).waitFor();
    await page.getByText("Template · title-card").waitFor();
    await page.getByText("Needs generation").waitFor();
    await page.locator('[data-field="narrative-title"]').fill("Glassbox Reveal");
    await page.getByLabel("Scene 1 title").fill("Show the review loop");
    await page.getByText("Unsaved changes").waitFor();

    const save = page.getByRole("button", { name: "Save" });
    expect(await save.isEnabled()).toBe(true);
    await save.click();
    await expect.poll(() => page.getByRole("status").textContent()).toContain("Saved glassbox.studio.json");
    await page.getByText("Saved", { exact: true }).waitFor();

    await page.locator('[data-field="narrative-title"]').fill("Unsaved temporary title");
    await page.getByText("Unsaved changes").waitFor();
    await page.getByRole("button", { name: "Reopen" }).click();
    await page.getByRole("heading", { name: "Glassbox Reveal" }).waitFor();
    expect(await page.locator('[data-field="narrative-title"]').inputValue()).toBe("Glassbox Reveal");
    expect(await page.getByLabel("Scene 1 title").inputValue()).toBe("Show the review loop");

    const persisted = openStudioProjectFile(root, "glassbox.studio.json").project;
    expect(persisted.narrative.title).toBe("Glassbox Reveal");
    expect(persisted.scenes[0].title).toBe("Show the review loop");
    expect(clientErrors).toEqual([]);
  }, 60_000);
});
