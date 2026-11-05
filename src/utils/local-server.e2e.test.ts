import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSafely } from "../test-support/close-browser-safely.js";
import { createStudioProjectFile, openStudioProjectFile } from "../studio/app-projects.js";
import { startStudioServer, type StudioServerHandle } from "../studio/server.js";
import { startScrubberServer, type ScrubberServerHandle } from "../scrubber/server.js";
import { startReviewServer, type ReviewServer } from "../review/server.js";

/**
 * The local Studio, Scrubber and svg-review servers all bind to 127.0.0.1, which a web page in the
 * user's browser can still reach. This drives real Chromium from a second, unrelated origin (a
 * plain server on another loopback port) against the real servers and requires every cross-site
 * write to be refused without a side effect, while the servers' own UIs keep working. Without the
 * shared guard in `startLocalServer`, the `text/plain` "simple request" below needs no CORS
 * preflight and overwrites the Studio project / writes a scrubber ticket.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10"/></svg>`;

describe("local servers refuse cross-site requests", () => {
  let available = true;
  let root = "";
  let ticketDir = "";
  let browser: Browser | null = null;
  let studio: StudioServerHandle | null = null;
  let scrubber: ScrubberServerHandle | null = null;
  let review: ReviewServer | null = null;
  let attacker: Server | null = null;
  let attackerUrl = "";
  let projectPath = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-local-guard-"));
    ticketDir = mkdtempSync(join(tmpdir(), "domotion-local-guard-tickets-"));
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      available = false;
      return;
    }
    projectPath = createStudioProjectFile(root, "guarded.studio.json", { title: "Original title" }).relativePath;
    studio = await startStudioServer({ workspaceRoot: root, initialProjectPath: projectPath });
    scrubber = await startScrubberServer({ review: true, ticketDir, launchBrowser: async () => browser! });
    const png = join(root, "img.png");
    const svg = join(root, "actual.svg");
    writeFileSync(png, PNG_1X1);
    writeFileSync(svg, SVG);
    review = await startReviewServer({ expectedPng: png, actualPng: png, actualSvg: svg, diffPng: png });
    attacker = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>elsewhere</title>");
    });
    await new Promise<void>((resolve) => attacker!.listen(0, "127.0.0.1", resolve));
    const address = attacker.address();
    attackerUrl = `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}/`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (attacker == null ? resolve() : attacker.close(() => resolve())));
    await review?.close();
    await studio?.close();
    if (scrubber != null) await closeSafely(() => scrubber!.close(), browser, 6_000);
    else await browser?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(ticketDir, { recursive: true, force: true });
  }, 20_000);

  async function crossSitePage(): Promise<Page> {
    const page = await browser!.newPage();
    await page.goto(attackerUrl);
    return page;
  }

  /** Fire the requests a hostile page can make; resolve to what each fetch saw ("opaque" or "blocked"). */
  async function attack(page: Page, target: string, body: unknown): Promise<string[]> {
    return page.evaluate(
      async ({ target, body }) => {
        const outcomes: string[] = [];
        const attempts: RequestInit[] = [
          // A CORS "simple request": no preflight, so only the server can refuse it.
          { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) },
          // A form-style post, likewise preflight-free.
          { method: "POST", mode: "no-cors", body: new URLSearchParams({ payload: JSON.stringify(body) }) },
          // A JSON post: the browser must preflight it, and the guard refuses the preflight.
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        ];
        for (const init of attempts) {
          try {
            const response = await fetch(target, init);
            outcomes.push(response.type);
          } catch {
            outcomes.push("blocked");
          }
        }
        return outcomes;
      },
      { target, body },
    );
  }

  function rawGet(url: string, host: string): Promise<number> {
    const { port, pathname } = new URL(url);
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: pathname, headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
  }

  it("a cross-site page cannot save over a Studio project", async () => {
    if (!available) return;
    const before = openStudioProjectFile(root, projectPath).project;
    const tampered = structuredClone(before);
    tampered.narrative.title = "Tampered";
    const page = await crossSitePage();
    try {
      const outcomes = await attack(page, new URL("/api/save", studio!.url).toString(), {
        path: projectPath,
        expectedHeadRevisionId: before.review.headRevisionId,
        project: tampered,
      });
      expect(outcomes).toEqual(["opaque", "opaque", "blocked"]);
    } finally {
      await page.close();
    }
    expect(openStudioProjectFile(root, projectPath).project).toEqual(before);
  });

  it("a cross-site page cannot write a scrubber review ticket", async () => {
    if (!available) return;
    const page = await crossSitePage();
    try {
      const outcomes = await attack(page, new URL("/ticket", scrubber!.url).toString(), {
        title: "Injected",
        frameTimeMs: 0,
        rangeStartMs: 0,
        rangeEndMs: 0,
      });
      expect(outcomes).toEqual(["opaque", "opaque", "blocked"]);
    } finally {
      await page.close();
    }
    expect(readdirSync(ticketDir)).toEqual([]);
  });

  it("refuses a DNS-rebound Host on every server, including for reads", async () => {
    if (!available) return;
    for (const url of [studio!.url, scrubber!.url, review!.url]) {
      const { port } = new URL(url);
      expect(await rawGet(url, `rebound.example:${port}`)).toBe(403);
      expect(await rawGet(url, `127.0.0.1:${port}`)).toBe(200);
      expect(await rawGet(url, `localhost:${port}`)).toBe(200);
    }
  });

  it("the servers' own UIs still load and reach their APIs same-origin", async () => {
    if (!available) return;
    const page = await browser!.newPage();
    try {
      await page.goto(studio!.url, { waitUntil: "load" });
      const opened = await page.evaluate(async (path) => {
        const response = await fetch("/api/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        return { status: response.status, path: ((await response.json()) as { path: string }).path };
      }, projectPath);
      expect(opened).toEqual({ status: 200, path: projectPath });

      await page.goto(scrubber!.url, { waitUntil: "load" });
      const timing = await page.evaluate(async (svg) => {
        const response = await fetch("/timing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ svg }),
        });
        return response.status;
      }, SVG);
      expect(timing).toBe(200);

      const reviewShell = await page.goto(review!.url, { waitUntil: "load" });
      expect(reviewShell?.status()).toBe(200);
      expect(await page.locator("#issue-text").count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
