import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/cli/capture.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { createHarHttpGetter, loadHarArchive } from "../src/capture/har-fetcher.js";
import { launchChromium } from "../src/index.js";
import { createTextEngineSession } from "../src/render/text-engine.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Webfont discovery downloads font bytes and cross-origin stylesheet text
// Node-side. Its default getter, Playwright's APIRequestContext, is not
// intercepted by routeFromHAR, so during a HAR replay discovery used to hit the
// live network while Chrome painted the archived bytes. Every URL below is on a
// `.invalid` host (RFC 6761: never resolves), so only the archive can answer.

const FONT = readFileSync(path.resolve("packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf"));
const PAGE = "https://site.har-fixture.invalid/";
const SHEET = "https://cdn.har-fixture.invalid/fonts.css";
const SHEET_FONT = "https://cdn.har-fixture.invalid/sheet-face.ttf?dpl=abc";
const INLINE_FONT = "https://site.har-fixture.invalid/inline-face.ttf";

const html = `<!doctype html><html><head>
<link rel="stylesheet" href="${SHEET}">
<style>@font-face { font-family: InlineFace; src: url(${INLINE_FONT}) format("truetype"); }
body { margin: 0; font: 40px InlineFace, serif; }</style></head>
<body><p>Rag get</p><p style="font-family: SheetFace">Rag get</p></body></html>`;
const sheet = `@font-face { font-family: SheetFace; src: url(sheet-face.ttf?dpl=abc) format("truetype"); }`;

const tmp = mkdtempSync(path.join(tmpdir(), "har-webfonts-"));
const harPath = path.join(tmp, "site.har");
writeFileSync(path.join(tmp, "sheet-sidecar.css"), sheet);
writeFileSync(
  harPath,
  JSON.stringify({
    log: {
      version: "1.2",
      entries: [
        {
          request: { url: PAGE, method: "GET", headers: [] },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "text/html" }],
            content: { mimeType: "text/html", text: html },
          },
        },
        {
          request: { url: SHEET, method: "GET", headers: [] },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "text/css" }],
            content: { mimeType: "text/css", _file: "sheet-sidecar.css" },
          },
        },
        ...[SHEET_FONT, INLINE_FONT].map((url) => ({
          request: { url, method: "GET", headers: [] },
          response: {
            status: 200,
            headers: [
              { name: "content-type", value: "font/ttf" },
              { name: "access-control-allow-origin", value: "*" },
            ],
            content: { mimeType: "font/ttf", text: FONT.toString("base64"), encoding: "base64" },
          },
        })),
      ],
    },
  }),
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium({ headless: true });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  rmSync(tmp, { recursive: true, force: true });
});

async function replay<T>(fn: (page: import("@playwright/test").Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ viewport: { width: 600, height: 200 } });
  try {
    await context.routeFromHAR(harPath, { url: "**/*", notFound: "abort" });
    const page = await context.newPage();
    await page.goto(PAGE, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return await fn(page);
  } finally {
    await context.close();
  }
}

describe("webfont discovery during a HAR replay", () => {
  it("Chrome paints both archived faces (fixture sanity)", async () => {
    const loaded = await replay((page) =>
      page.evaluate(() => Array.from(document.fonts, (f) => `${f.family}:${f.status}`).sort()),
    );
    expect(loaded).toEqual(["InlineFace:loaded", "SheetFace:loaded"]);
  });

  it("the default request API bypasses the HAR route (control)", async () => {
    const report = await replay((page) => discoverAndRegisterWebfonts(page, [], createTextEngineSession()));
    expect(report.filter((r) => r.ok)).toEqual([]);
  });

  it("registers the archived faces when discovery fetches through the HAR getter", async () => {
    const httpGet = createHarHttpGetter(loadHarArchive(harPath), { notFound: "abort" });
    const report = await replay((page) =>
      discoverAndRegisterWebfonts(page, [], createTextEngineSession(), { httpGet }),
    );
    const ok = report.filter((r) => r.ok && r.source === "font-face").map((r) => `${r.family} ${r.url}`);
    expect(ok.sort()).toEqual([`InlineFace ${INLINE_FONT}`, `SheetFace ${SHEET_FONT}`]);
  });
});

describe("domotion capture <file>.har", () => {
  it("renders archived webfonts offline under strict replay", async () => {
    const out = path.join(tmp, "out.svg");
    const fallbackOut = path.join(tmp, "fallback.svg");
    await runCapture(["--quiet", "--width", "600", "--height", "200", "--text-mode", "paths", "-o", out, harPath], "");
    await runCapture(
      [
        "--quiet",
        "--width",
        "600",
        "--height",
        "200",
        "--text-mode",
        "paths",
        "--har-fallback",
        "-o",
        fallbackOut,
        harPath,
      ],
      "",
    );
    const svg = readFileSync(out, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    // The fixture serif's "R" outline (font units, as paths mode emits it). It
    // is absent when discovery's fetches miss the archive, because the text
    // then falls back to the system serif.
    expect(svg).toContain('d="M55 46H130V652H55V698H381');
    expect(readFileSync(fallbackOut, "utf8")).toBe(svg);
  }, 120_000);
});
