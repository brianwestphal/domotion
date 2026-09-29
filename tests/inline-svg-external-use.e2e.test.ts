import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * `<use href="sprite.svg#icon">` names an element in ANOTHER file. The capture script is synchronous, so
 * a prepass fetches each same-origin document first and the script inlines the target from it, exactly as
 * it does for a same-document `#id`. What cannot be inlined faithfully (a document that needs its own
 * stylesheet, a fragment resource such as a gradient, a nested <use>, a fetch that fails) is refused with
 * a warning and the host <svg> is handed to Chromium's raster, so the icon still appears as painted.
 */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg">
  <symbol id="check" viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/></symbol>
  <g id="dot"><circle cx="8" cy="8" r="6" fill="rgb(200,30,60)"/></g>
</svg>`;
const FILES: Record<string, string> = {
  "/sprite.svg": SPRITE,
  "/styled.svg": `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><symbol id="s" viewBox="0 0 10 10"><rect class="a" width="10" height="10"/></symbol></svg>`,
  "/gradient.svg": `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><symbol id="s" viewBox="0 0 10 10"><rect fill="url(#g)" width="10" height="10"/></symbol></svg>`,
  "/nested.svg": `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="inner" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><symbol id="s" viewBox="0 0 10 10"><use href="#inner"/></symbol></svg>`,
  "/malformed.svg": `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="s"></svg>`,
};

let server: Server;
let origin = "";
let other: Server;
let otherOrigin = "";
const requests: string[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      resolve({
        server: s,
        origin: `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`,
      });
    });
  });
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
const describeBrowser = env ? describe : describe.skip;

beforeAll(async () => {
  const a = await listen((request, response) => {
    const url = request.url ?? "/";
    // Chromium loads a <use> target itself (`sec-fetch-dest: image`); the prepass uses fetch() (`empty`).
    if (request.headers["sec-fetch-dest"] === "empty") requests.push(url);
    const body = FILES[url];
    if (body == null) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "image/svg+xml");
    response.end(body);
  });
  server = a.server;
  origin = a.origin;
  const b = await listen((_request, response) => {
    response.setHeader("content-type", "image/svg+xml");
    response.setHeader("access-control-allow-origin", "*");
    response.end(SPRITE);
  });
  other = b.server;
  otherOrigin = b.origin;
});
afterAll(async () => {
  await closeBrowserSafely(env?.browser, 15_000);
  await Promise.all([server, other].map((s) => new Promise<void>((resolve) => s?.close(() => resolve()))));
}, 30_000);

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

async function capture(html: string, viewport = { width: 200, height: 100 }) {
  const context = await env!.browser.newContext({ viewport });
  const page = await context.newPage();
  await page.route(`${origin}/page.html`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/page.html`);
  await page.waitForLoadState("networkidle");
  const requestsBeforeCapture = requests.length;
  const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, ...viewport }, {});
  const captureRequests = requests.slice(requestsBeforeCapture);
  const svgs = walk(captured.tree).filter((node) => node.tag === "svg");
  const screenshot = await page.screenshot();
  await context.close();
  return { captured, svgs, screenshot, viewport, captureRequests };
}

const svgWarnings = (captured: Awaited<ReturnType<typeof capture>>["captured"]) =>
  captured.warnings.filter((warning) => warning.feature === "inline-svg").map((warning) => warning.detail);

describeBrowser("external-file <use> references", () => {
  it("inlines a symbol from a sprite file with the host's currentColor, leaving no dangling <use>", async () => {
    const { svgs, captured } = await capture(
      `<body style="margin:8px;color:rgb(20,120,60)"><svg width="24" height="24"><use href="/sprite.svg#check"/></svg></body>`,
    );
    expect(svgs).toHaveLength(1);
    const content = svgs[0].svgContent ?? "";
    expect(content).not.toContain("<use");
    expect(content).toContain("M9 16.2");
    expect(content).toContain('fill="rgb(20, 120, 60)"'); // currentColor resolved against the host
    expect(content).not.toContain("#check");
    expect(svgWarnings(captured)).toEqual([]);
    expect(svgs[0].transformSubtreeRaster).toBeUndefined();
  });

  it("inlines a non-symbol target with the use's x/y", async () => {
    const { svgs } = await capture(
      `<body style="margin:8px"><svg width="40" height="24"><use href="/sprite.svg#dot" x="10" y="4"/></svg></body>`,
    );
    const content = svgs[0].svgContent ?? "";
    expect(content).not.toContain("<use");
    expect(content).toContain("<circle");
    expect(content).toContain("translate(10,4)");
    expect(content).not.toContain('id="dot"');
  });

  it("fetches each distinct document once, however many icons reference it", async () => {
    // Only the capture's own fetch() calls are counted; Chromium's image-destination loads of the same
    // documents are its painting and not under test.
    const { captureRequests } = await capture(
      `<body><svg width="16" height="16"><use href="/sprite.svg#check"/></svg><svg width="16" height="16"><use href="/sprite.svg#dot"/></svg><svg width="16" height="16"><use href="/sprite.svg#check"/></svg></body>`,
    );
    expect(captureRequests.filter((url) => url === "/sprite.svg")).toHaveLength(1);
  });

  it("matches Chromium's paint for an inlined external symbol", async () => {
    const { captured, screenshot, viewport } = await capture(
      `<body style="margin:0;background:#fff;color:rgb(20,120,60)"><svg width="48" height="48" style="display:block"><use href="/sprite.svg#check"/></svg></body>`,
      { width: 96, height: 96 },
    );
    const svg = elementTreeToSvg(captured.tree, viewport.width, viewport.height, {});
    expect(svg).not.toContain("<use");
    const context = await env!.browser.newContext({ viewport });
    const page = await context.newPage();
    await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    const rendered = await page.screenshot();
    await context.close();
    const [a, b] = await Promise.all([screenshot, rendered].map((png) => sharp(png).removeAlpha().raw().toBuffer()));
    let differing = 0;
    for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i + 1] - b[i + 1]) > 48) differing++;
    // The check mark is ~25% of the 48x48 box; anything close to that would mean the icon was lost.
    expect(differing).toBeLessThan(40);
  });

  it("warns, and leaves the vector alone, when the document loads but lacks the element", async () => {
    const { svgs, captured } = await capture(
      `<body><svg width="16" height="16"><use href="/sprite.svg#nope"/></svg></body>`,
    );
    expect(svgWarnings(captured).join("\n")).toContain("does not contain");
    expect(svgs[0].transformSubtreeRaster).toBeUndefined(); // Chromium paints nothing either
  });

  it.each([
    ["a 404", "/missing.svg#x", /HTTP 404/],
    ["malformed SVG", "/malformed.svg#s", /not well-formed/],
    ["a <style> element", "/styled.svg#s", /<style>/],
    ["a gradient reference", "/gradient.svg#s", /fragment resource/],
    ["a nested <use>", "/nested.svg#s", /nested <use>/],
    ["no fragment id", "/sprite.svg", /names no element id/],
  ])("hands the host <svg> to Chromium's raster, with a warning, for %s", async (_label, href, reason) => {
    const { svgs, captured } = await capture(`<body><svg width="16" height="16"><use href="${href}"/></svg></body>`);
    const warnings = svgWarnings(captured).join("\n");
    expect(warnings).toMatch(reason);
    expect(warnings).toContain("raster ownership");
    expect(svgs[0].transformSubtreeRaster).toBeDefined();
  });

  it("emits Chromium's own pixels for a refused sprite that Chromium does paint", async () => {
    const { captured, screenshot, viewport } = await capture(
      `<body style="margin:0;background:#fff"><svg width="40" height="40" style="display:block"><use href="/styled.svg#s" width="40" height="40"/></svg></body>`,
    );
    const svg = elementTreeToSvg(captured.tree, viewport.width, viewport.height, {});
    expect(svg).toContain("<image");
    expect(svg).not.toContain("<use");
    // Chromium painted the sprite's red square (its <style> applied); the raster carries it.
    const context = await env!.browser.newContext({ viewport });
    const page = await context.newPage();
    await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
    const rendered = await page.screenshot();
    await context.close();
    const probe = async (png: Buffer) => {
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (20 * info.width + 20) * 3;
      return [data[at], data[at + 1], data[at + 2]];
    };
    expect(await probe(screenshot)).toEqual([255, 0, 0]);
    expect(await probe(rendered)).toEqual([255, 0, 0]);
  });

  it("refuses a cross-origin document without requesting it (Chromium never paints one)", async () => {
    const { svgs, captured } = await capture(
      `<body><svg width="16" height="16"><use href="${otherOrigin}/sprite.svg#check"/></svg></body>`,
    );
    expect(svgWarnings(captured).join("\n")).toContain("not same-origin");
    expect(svgs[0].transformSubtreeRaster).toBeDefined();
  });

  it("still resolves same-document references, and makes no request for them", async () => {
    const { svgs, captured, captureRequests } = await capture(
      `<body><svg style="display:none"><symbol id="here" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></svg><svg width="16" height="16"><use href="#here"/></svg></body>`,
    );
    const consumer = svgs.find((svg) => (svg.svgContent ?? "").includes("<rect"));
    expect(consumer).toBeDefined();
    expect(consumer!.svgContent).not.toContain("<use");
    expect(captureRequests).toEqual([]);
    expect(svgWarnings(captured)).toEqual([]);
  });
});
