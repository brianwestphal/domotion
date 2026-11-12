import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { resolveVisualOutputRoot } from "./output-directory.mjs";
import { primeOffscreenCanvases } from "./real-world-webgl-preflight.js";
import { WEBGL_FIXTURE_LAUNCH_ARGS } from "../src/test-support/webgl-fixture-launch.js";

let browser: Browser;
let browserIdentity: { product: string; revision: string };
beforeAll(async () => {
  browser = await chromium.launch({ args: [...WEBGL_FIXTURE_LAUNCH_ARGS] });
  const session = await browser.newBrowserCDPSession();
  try {
    const version = await session.send("Browser.getVersion");
    browserIdentity = { product: version.product, revision: version.revision };
  } finally {
    await session.detach();
  }
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

it("primes a browser-owned rotated iframe plane instead of skipping its transformed AABB", async () => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  try {
    const content = `<body style="margin:0"><canvas width=12 height=12 style="position:absolute;left:55px;top:25px"></canvas><script>const c=document.querySelector('canvas');const g=c.getContext('2d');g.fillStyle='red';g.fillRect(0,0,12,12)</script>`;
    await page.setContent(
      `<body style="margin:0;height:2000px"><iframe style="position:absolute;left:200px;top:1000px;width:80.5px;height:80px;padding:5px;border:3px solid;transform:rotate(35deg);transform-origin:0 0" srcdoc="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body>`,
    );
    await page.frameLocator("iframe").locator("canvas").waitFor();
    const before = await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])));
    expect(await primeOffscreenCanvases(page)).toEqual({ primed: 1, failed: 0, skipped: 0 });
    expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])))).toEqual(before);
  } finally {
    await page.close();
  }
});

const escapeAttribute = (html: string) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const paintedCanvas = (left = 55, top = 25, size = 12) =>
  `<!doctype html><body style="margin:0"><canvas width=${size} height=${size} style="position:absolute;left:${left}px;top:${top}px"></canvas><script>const c=document.querySelector('canvas');const g=c.getContext('2d');g.fillStyle='red';g.fillRect(0,0,c.width,c.height);window.__originalRaf=requestAnimationFrame;window.ticks=0;function tick(){window.ticks++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;

interface Capture {
  clip: { x: number; y: number; width: number; height: number; scale: number };
  png: Buffer;
}
function observeCaptures(page: Page, blockGeometry = false) {
  const captures: Capture[] = [];
  const sessions: CDPSession[] = [];
  const original = page.context().newCDPSession.bind(page.context());
  const spy = vi.spyOn(page.context(), "newCDPSession").mockImplementation(async (target) => {
    const session = await original(target);
    sessions.push(session);
    const send = session.send.bind(session) as (method: string, params?: unknown) => Promise<unknown>;
    vi.spyOn(session, "send").mockImplementation((async (method: string, params?: unknown) => {
      if (blockGeometry && method === "DOM.getBoxModel") return await new Promise<never>(() => undefined);
      const response = await send(method, params);
      if (
        method === "Page.captureScreenshot" &&
        response != null &&
        typeof response === "object" &&
        "data" in response &&
        typeof response.data === "string"
      ) {
        captures.push({ clip: (params as { clip: Capture["clip"] }).clip, png: Buffer.from(response.data, "base64") });
      }
      return response;
    }) as CDPSession["send"]);
    return session;
  });
  return { captures, sessions, restore: () => spy.mockRestore() };
}

async function installFixture(
  page: Page,
  transform: string,
  {
    nested = false,
    cross = false,
    parentPerspective = false,
    partlyVisibleHost = false,
  }: { nested?: boolean; cross?: boolean; parentPerspective?: boolean; partlyVisibleHost?: boolean } = {},
) {
  const leaf = paintedCanvas();
  const leafUrl = "https://leaf.third.test/canvas";
  const middle = nested
    ? `<!doctype html><body style="margin:0"><iframe id=inner style="position:absolute;left:10px;top:15px;width:80.5px;height:80px;padding:2px;border:4px solid;transform:perspective(180px) rotateY(25deg);transform-origin:0 0" ${cross ? `src="${leafUrl}"` : `srcdoc="${escapeAttribute(leaf)}"`}></iframe><script>window.__originalRaf=requestAnimationFrame</script>`
    : leaf;
  const middleUrl = "https://middle.separate.test/content";
  await page.route("https://leaf.third.test/**", (route) => route.fulfill({ contentType: "text/html", body: leaf }));
  await page.route("https://middle.separate.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: middle }),
  );
  const root = `<!doctype html><body style="margin:0;width:600px;height:2200px"><div style="position:absolute;left:${partlyVisibleHost ? 50 : 200}px;top:${partlyVisibleHost ? 80 : 1000}px;${parentPerspective ? "perspective:180px;" : ""}"><iframe id=outer style="width:${nested ? 140 : 80.5}px;height:${nested ? 140 : 80}px;padding:5px;border:3px solid;transform:${transform};transform-origin:0 0" ${cross ? `src="${middleUrl}"` : `srcdoc="${escapeAttribute(middle)}"`}></iframe></div><script>window.__originalRaf=requestAnimationFrame;window.ticks=0;function tick(){window.ticks++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;
  await page.route("https://main.geometry.test/**", (route) => route.fulfill({ contentType: "text/html", body: root }));
  await page.goto("https://main.geometry.test/");
  const canvas = nested
    ? page.frameLocator("#outer").frameLocator("#inner").locator("canvas")
    : page.frameLocator("#outer").locator("canvas");
  await canvas.waitFor();
  await expect.poll(() => page.evaluate(() => (window as unknown as { ticks: number }).ticks)).toBeGreaterThan(1);
  if (partlyVisibleHost)
    await expect
      .poll(() =>
        canvas.evaluate((element) => (element.ownerDocument.defaultView as unknown as { ticks: number }).ticks),
      )
      .toBeGreaterThan(1);
  return canvas;
}

async function saveCaptureEvidence(kind: string, capture: Capture, result: unknown) {
  const { data, info } = await sharp(capture.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let offset = 0; offset < data.length; offset += info.channels)
    if (data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 255) red++;
  const outputRoot =
    process.platform === "linux" && !process.env["DOMOTION_OUTPUT_DIR"]?.trim()
      ? resolve("tests/output-linux")
      : resolveVisualOutputRoot();
  const directory = join(outputRoot, "webgl-projective-preflight");
  const sourceCommit = process.env["GITHUB_SHA"] ?? process.env["DOMOTION_PREFLIGHT_SOURCE_COMMIT"] ?? null;
  if (sourceCommit != null && !/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new Error("preflight evidence requires a full source commit");
  const sourceFiles = Object.fromEntries(
    [
      "real-world-webgl-preflight.ts",
      "real-world-webgl-frame-geometry.ts",
      "real-world-webgl-geometry.ts",
      "real-world-webgl-projective-preflight.e2e.test.ts",
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(`./${file}`, import.meta.url)))
        .digest("hex"),
    ]),
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${kind}.png`), capture.png);
  writeFileSync(
    join(directory, `${kind}.json`),
    JSON.stringify(
      {
        kind,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        sourceCommit,
        sourceFiles,
        browser: browserIdentity,
        launchProfile: kind === "nested-oopif" ? "explicit-site-per-process" : "default-headless-shell",
        clip: capture.clip,
        exactRedPixels: red,
        result,
      },
      null,
      2,
    ),
  );
  expect(red, "the actual bounded preflight screenshot must contain authenticated source paint").toBeGreaterThan(0);
  expect(capture.clip.width).toBeLessThanOrEqual(512);
  expect(capture.clip.height).toBeLessThanOrEqual(512);
}

it.each([
  { kind: "rotation", transform: "rotate(35deg)" },
  { kind: "skew", transform: "skew(30deg,15deg)" },
  { kind: "reflection", transform: "scaleX(-1)" },
  { kind: "direct-perspective", transform: "perspective(180px) rotateY(35deg)" },
  { kind: "parent-perspective", transform: "rotateY(35deg)", parentPerspective: true },
  // DM-PCT7GR tracks fully hidden cross-origin activation; these hosts stay partly visible while canvases are wholly offscreen.
  { kind: "cross-origin-rotation", transform: "rotate(35deg)", cross: true, partlyVisibleHost: true },
  { kind: "nested-projective", transform: "rotate(25deg)", nested: true, cross: true, partlyVisibleHost: true },
])("captures real source paint through $kind with unchanged scroll and live rAF", async (fixture) => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page);
  try {
    await installFixture(page, fixture.transform, fixture);
    for (const frame of page.frames())
      await frame.evaluate(() => {
        (globalThis as unknown as Record<string, unknown>).__domotionPreflightGeometry_author = { retained: true };
      });
    const scrolls = await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])));
    const ticks = await page.evaluate(() => (window as unknown as { ticks: number }).ticks);
    const failures: unknown[] = [];
    const result = await primeOffscreenCanvases(page, (failure) => failures.push(failure));
    expect(result, failures.map(String).join("\n")).toEqual({ primed: 1, failed: 0, skipped: 0 });
    expect(observed.captures).toHaveLength(1);
    expect(observed.captures[0].clip.y).toBeGreaterThanOrEqual(140);
    await saveCaptureEvidence(fixture.kind, observed.captures[0], result);
    expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])))).toEqual(scrolls);
    await expect.poll(() => page.evaluate(() => (window as unknown as { ticks: number }).ticks)).toBeGreaterThan(ticks);
    for (const frame of page.frames()) {
      expect(
        await frame.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionPreflightGeometry_")),
        ),
      ).toEqual(["__domotionPreflightGeometry_author"]);
      expect(
        await frame.evaluate(
          () =>
            requestAnimationFrame ===
            (window as unknown as { __originalRaf: typeof requestAnimationFrame }).__originalRaf,
        ),
      ).toBe(true);
    }
  } finally {
    observed.restore();
    await page.close();
  }
});

it("composes measured OOPIF local roots without using rounded innerWidth as a scale", async () => {
  const isolated = await chromium.launch({ args: ["--site-per-process", ...WEBGL_FIXTURE_LAUNCH_ARGS] });
  const page = await isolated.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page);
  try {
    await installFixture(page, "rotate(25deg)", { cross: true, nested: true, partlyVisibleHost: true });
    const leaf = page.frames().find((frame) => frame.url().includes("leaf.third.test"))!;
    const native = await page.context().newCDPSession(leaf);
    await native.detach();
    const result = await primeOffscreenCanvases(page);
    expect(result).toEqual({ primed: 1, failed: 0, skipped: 0 });
    expect(observed.captures).toHaveLength(1);
    expect(observed.captures[0].clip.y).toBeGreaterThanOrEqual(140);
    await saveCaptureEvidence("nested-oopif", observed.captures[0], result);
  } finally {
    observed.restore();
    await page.close();
    await closeBrowserSafely(isolated);
  }
});

it.each([
  { kind: "behind-camera", transform: "perspective(120px) translateZ(240px)" },
  { kind: "camera-plane-crossing", transform: "perspective(40px) rotateY(80deg)", origin: "100% 50%" },
  { kind: "singular", transform: "scaleX(0)" },
])("refuses $kind instead of authenticating a misleading finite quad", async (fixture) => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page);
  try {
    await installFixture(page, fixture.transform);
    if ("origin" in fixture)
      await page
        .locator("#outer")
        .evaluate((element, origin) => ((element as HTMLElement).style.transformOrigin = origin), fixture.origin!);
    expect(await primeOffscreenCanvases(page)).toEqual({ primed: 0, failed: 0, skipped: 1 });
    expect(observed.captures).toHaveLength(0);
  } finally {
    observed.restore();
    await page.close();
  }
});

it("does not spend a screenshot on a nested plane outside a rotated ancestor clip despite overlapping AABBs", async () => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page);
  try {
    const inner = `<!doctype html><body style="margin:0"><iframe style="position:absolute;left:110px;top:40px;width:20px;height:20px;border:0" srcdoc="${escapeAttribute(paintedCanvas(0, 0, 12))}"></iframe>`;
    await page.setContent(
      `<!doctype html><body style="margin:0;width:600px;height:2200px"><iframe style="position:absolute;left:200px;top:1000px;width:100px;height:100px;border:0;transform:rotate(45deg);transform-origin:0 0" srcdoc="${escapeAttribute(inner)}"></iframe>`,
    );
    await page.frameLocator("iframe").frameLocator("iframe").locator("canvas").waitFor();
    expect(await primeOffscreenCanvases(page)).toEqual({ primed: 0, failed: 0, skipped: 1 });
    expect(observed.captures).toHaveLength(0);
  } finally {
    observed.restore();
    await page.close();
  }
});

it("retains a real partially visible source plane through an authenticated rotated overflow clip", async () => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page);
  try {
    const content = paintedCanvas(40, 30, 40);
    await page.setContent(
      `<!doctype html><body style="margin:0;width:600px;height:2200px"><div style="position:absolute;left:200px;top:1000px;width:100px;height:100px;overflow:hidden;transform:rotate(25deg);transform-origin:0 0"><iframe style="position:absolute;left:50px;top:50px;width:80.5px;height:80px;border:0" srcdoc="${escapeAttribute(content)}"></iframe></div>`,
    );
    await page.frameLocator("iframe").locator("canvas").waitFor();
    const result = await primeOffscreenCanvases(page);
    expect(result).toEqual({ primed: 1, failed: 0, skipped: 0 });
    expect(observed.captures).toHaveLength(1);
    await saveCaptureEvidence("partial-overflow", observed.captures[0], result);
    expect(observed.captures[0].clip.width).toBeLessThan(40);
  } finally {
    observed.restore();
    await page.close();
  }
});

it("keeps identical child URLs bound to distinct execution contexts and source planes", async () => {
  const page = await browser.newPage({ viewport: { width: 400, height: 140 } });
  const observed = observeCaptures(page);
  try {
    await page.route("https://leaf.third.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: paintedCanvas() }),
    );
    await page.setContent(
      `<!doctype html><body style="margin:0;width:800px;height:2200px">${[50, 250].map((left) => `<iframe style="position:absolute;left:${left}px;top:100px;width:80.5px;height:80px;border:0;transform:rotate(35deg);transform-origin:0 0" src="https://leaf.third.test/same"></iframe>`).join("")}</body>`,
    );
    for (const frame of page.frames().filter((frame) => frame !== page.mainFrame()))
      await frame.locator("canvas").waitFor();
    expect(await primeOffscreenCanvases(page)).toEqual({ primed: 2, failed: 0, skipped: 0 });
    expect(observed.captures).toHaveLength(2);
    expect(observed.captures[1].clip.x - observed.captures[0].clip.x).toBe(200);
    for (const [index, capture] of observed.captures.entries())
      await saveCaptureEvidence(`identical-url-${index}`, capture, { primed: 2 });
  } finally {
    observed.restore();
    await page.close();
  }
});

it("bounds stalled geometry discovery at three seconds and releases its own registries/sessions", async () => {
  const page = await browser.newPage({ viewport: { width: 200, height: 140 } });
  const observed = observeCaptures(page, true);
  try {
    await installFixture(page, "rotate(25deg)");
    const started = performance.now();
    const result = await primeOffscreenCanvases(page);
    expect(result).toEqual({ primed: 0, failed: 1, skipped: 0 });
    expect(performance.now() - started).toBeLessThan(3500);
    expect(observed.captures).toHaveLength(0);
    for (const frame of page.frames())
      await expect
        .poll(() =>
          frame.evaluate(() =>
            Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionPreflightGeometry_")),
          ),
        )
        .toEqual([]);
    for (const session of observed.sessions)
      await expect(session.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(/closed|detached/i);
  } finally {
    observed.restore();
    await page.close();
  }
});
