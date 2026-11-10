import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const sprite =
  '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="s" viewBox="0 0 32 32"><rect width="32" height="32" fill="blue"/></symbol></svg>';
let browser: Browser;
let origin: string;
let foreign: string;
const servers: Server[] = [];
const requests: Array<{ foreign: boolean; path: string; destination: string }> = [];
const evidence: Array<Record<string, unknown>> = [];
const directory = join(
  process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
  "external-svg-frozen",
  "redirects",
);

async function serve(isForeign: boolean): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push({
      foreign: isForeign,
      path: url.pathname,
      destination: String(request.headers["sec-fetch-dest"] ?? ""),
    });
    if (url.pathname !== "/denied.svg") response.setHeader("access-control-allow-origin", "*");
    const redirects: Record<string, string> = {
      "/same.svg": `${origin}/same-second.svg`,
      "/same-second.svg": `${origin}/sprite.svg`,
      "/foreign.svg": `${foreign}/sprite.svg`,
      "/foreign-denied.svg": `${foreign}/denied.svg`,
      "/out-back.svg": `${foreign}/back.svg`,
      "/back.svg": `${origin}/sprite.svg`,
    };
    if (redirects[url.pathname]) {
      response.writeHead(302, { location: redirects[url.pathname] }).end();
    } else if (url.pathname.endsWith(".svg")) {
      response.setHeader("content-type", "image/svg+xml");
      response.end(sprite);
    } else {
      response.setHeader("content-type", "text/html");
      const route = url.searchParams.get("route") ?? "same";
      response.end(
        `<!doctype html><body style="margin:0;background:white"><svg width="32" height="32"><use href="/${route}.svg#s"/></svg>`,
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("redirect fixture failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  origin = await serve(false);
  foreign = await serve(true);
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser, 15_000);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("native external SVG use redirect admission (DM-N8EYNT)", () => {
  it.each([
    { route: "same", admitted: true },
    { route: "foreign", admitted: false },
    { route: "foreign-denied", admitted: false },
    { route: "out-back", admitted: false },
  ])(
    "matches native paint for $route, including frozen capture",
    async ({ route, admitted }) => {
      const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/?route=${route}`);
        const before = await page.screenshot();
        const source = await sharp(before).removeAlpha().raw().toBuffer();
        const sourcePixel = [...source.subarray((16 * 64 + 16) * 3, (16 * 64 + 16) * 3 + 3)];
        expect(sourcePixel).toEqual(admitted ? [0, 0, 255] : [255, 255, 255]);
        await freezeRealWorldDom(page);
        const start = requests.length;
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 64, height: 64 }, {});
        const svg = elementTreeToSvg(captured.tree, 64, 64, {});
        const output = await context.newPage();
        await output.setContent(`<body style="margin:0">${svg}`);
        const after = await output.screenshot();
        const actual = await sharp(after).removeAlpha().raw().toBuffer();
        const capturedPixel = [...actual.subarray((16 * 64 + 16) * 3, (16 * 64 + 16) * 3 + 3)];
        evidence.push({
          route,
          admitted,
          generatedAt: new Date().toISOString(),
          sourceCommit: process.env["GITHUB_SHA"] ?? null,
          platform: process.platform,
          browser: browser.version(),
          sourcePixel,
          capturedPixel,
          byteIdenticalPixels: source.equals(actual),
          vector: svg.includes("domotion-external-use"),
          captureRequests: requests.slice(start),
          warnings: captured.warnings,
        });
        await Promise.all([
          writeFile(join(directory, `${route}-source.png`), before),
          writeFile(join(directory, `${route}-captured.png`), after),
          writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2)),
        ]);
        expect(actual.equals(source)).toBe(true);
        expect(svg.includes("domotion-external-use")).toBe(admitted);
        if (!admitted) {
          expect(captured.warnings.some((warning) => warning.feature === "inline-svg")).toBe(true);
          expect(requests.slice(start).filter((request) => request.foreign)).toEqual([]);
        }
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
