import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/**
 * DM-948: end-to-end test for the `svg-review` CLI. Spawns the built bin
 * against an existing demos:test fixture, drives the UI via Playwright to
 * draw a region + caption + press Enter, and asserts the generated GitHub-
 * issue Markdown contains the expected section headers + a row for the
 * drawn region. A regression net so a future UI refactor that breaks
 * (e.g.) the region-overlay → Markdown-builder wiring fails noisily here
 * instead of silently shipping.
 *
 * The fixture (`bg-conic-checkerboard-{expected.png,.svg}`) is produced
 * by `npm run demos:test`. The test skips cleanly when the fixture isn't
 * present so vitest stays green in a fresh checkout.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI = resolve(REPO_ROOT, "dist/cli/review.js");
const EXPECTED = resolve(REPO_ROOT, "tests/output/bg-conic-checkerboard-expected.png");
const ACTUAL = resolve(REPO_ROOT, "tests/output/bg-conic-checkerboard.svg");

const fixtureReady = existsSync(CLI) && existsSync(EXPECTED) && existsSync(ACTUAL);
const describeE2E = fixtureReady ? describe : describe.skip;

function waitForUrl(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/svg-review:\s+(http:\/\/[^\s]+)/);
      if (m != null) {
        child.stdout.off("data", onData);
        clearTimeout(timer);
        resolveFn(m[1]!);
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      rejectFn(new Error(`svg-review never printed a URL within ${timeoutMs}ms; stdout so far:\n${buf}`));
    }, timeoutMs);
    child.stdout.on("data", onData);
  });
}

describeE2E("svg-review CLI end-to-end (DM-948)", () => {
  let child: ChildProcessWithoutNullStreams | null = null;
  afterEach(() => {
    if (child != null && !child.killed) child.kill("SIGTERM");
    child = null;
  });

  it("opens the UI, lets the user draw a captioned region, and the issue text reflects it", async () => {
    // Spawn the built CLI against the existing fixture. --port 0 lets the
    // OS pick a free port; we read the assigned URL from the CLI's stdout
    // so multiple parallel test runs don't fight over a fixed port.
    child = spawn("node", [CLI, "--expected", EXPECTED, "--actual", ACTUAL, "--no-open", "--port", "0"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr.on("data", (c) => stderrChunks.push(c.toString()));
    const url = await waitForUrl(child).catch((e) => {
      throw new Error(`${e.message}\nstderr:\n${stderrChunks.join("")}`);
    });

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(url, { waitUntil: "networkidle" });

      // The shell HTML loads three figures + the issue panel. Wait for
      // the actual.png img to lay out so its rect has a non-zero size
      // — that's what `enableRegionOverlays` needs to map pointer
      // coordinates back to source-PNG pixel space.
      const actualImg = page.locator('figure[data-role="actual"] img');
      await actualImg.waitFor({ state: "visible" });
      const box = await actualImg.boundingBox();
      if (box == null) throw new Error("actual img has no bounding box");

      // Drag a region inside the actual figure. The pointerdown-move-up
      // sequence on the SVG overlay triggers `enableRegionOverlays`'s
      // "draw a new rectangle" path. Coordinates are within the image
      // so the resulting rect maps to a real source-PNG sub-rect.
      const startX = box.x + box.width * 0.3;
      const startY = box.y + box.height * 0.3;
      const endX = box.x + box.width * 0.55;
      const endY = box.y + box.height * 0.55;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      // The polling tick re-renders the region list when the overlay
      // state changes; wait for the caption input to appear.
      const captionInput = page.locator(".region-list input[type='text']");
      await captionInput.waitFor({ state: "visible", timeout: 5_000 });
      await captionInput.fill("border-radius too tight on this corner");
      // Press Enter — the client focuses the issue textarea so the
      // user can immediately copy. The textarea content is what we
      // assert on.
      await captionInput.press("Enter");

      const issueText = await page.locator("#issue-text").inputValue();

      // Section headers + structure + the user's caption should all be present.
      expect(issueText).toContain("### Domotion render fidelity issue");
      expect(issueText).toContain("**Fixture**: `bg-conic-checkerboard.svg`");
      expect(issueText).toContain("**Expected** (Chromium): `expected.png` (attached)");
      expect(issueText).toContain("**Actual** (Domotion): `actual.svg` (attached)");
      expect(issueText).toContain("| # | Region (x, y, w, h) | What's wrong |");
      expect(issueText).toContain("border-radius too tight on this corner");
      expect(issueText).toContain("### How to reproduce");
      // The pre-filled new-issue link should mirror the fixture name.
      const fileHref = await page.locator("#file-link").getAttribute("href");
      expect(fileHref).toContain("github.com/brianwestphal/domotion/issues/new");
      expect(fileHref).toContain("bg-conic-checkerboard.svg");

      await browser.close();
    } catch (e) {
      await browser.close().catch(() => {/* noop */});
      throw e;
    }
  }, 60_000);

  it("serves all four endpoints (HTML shell, client.js, expected.png, diff.png)", async () => {
    child = spawn("node", [CLI, "--expected", EXPECTED, "--actual", ACTUAL, "--no-open", "--port", "0"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await waitForUrl(child);
    // node:http fetch is fine; we're just probing content-types + non-empty bodies.
    const probe = async (path: string): Promise<{ status: number; contentType: string; bytes: number }> => {
      const res = await fetch(url.replace(/\/$/, "") + path);
      const buf = await res.arrayBuffer();
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: buf.byteLength };
    };
    const shell = await probe("/");
    expect(shell.status).toBe(200);
    expect(shell.contentType).toMatch(/^text\/html/);
    expect(shell.bytes).toBeGreaterThan(500);

    const client = await probe("/client.js");
    expect(client.status).toBe(200);
    expect(client.contentType).toMatch(/javascript/);
    expect(client.bytes).toBeGreaterThan(1000);

    const expectedPng = await probe("/expected.png");
    expect(expectedPng.status).toBe(200);
    expect(expectedPng.contentType).toBe("image/png");
    expect(expectedPng.bytes).toBe(readFileSync(EXPECTED).byteLength);

    const diff = await probe("/diff.png");
    expect(diff.status).toBe(200);
    expect(diff.contentType).toBe("image/png");
  }, 30_000);
});
