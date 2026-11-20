import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveFont } from "@domotion/text-engine/testing";
import { attachWebfontTracker, discoverAndRegisterWebfonts, launchChromium } from "../src/capture/index.js";
import { clearWebfonts } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Faces built with the FontFace API have no @font-face rule. Discovery used to
// register their fetched bytes under the file's internal family name with an
// OS/2 weight, so `font-family: <authored name>` never matched them. The
// CSS.fontsUpdated event reports the authored family and descriptors
// (fonts-updated-faces.ts); these tests compare the result with the face
// Chrome itself paints (CSS.getPlatformFontsForNode).

const FIXTURES = new URL("../packages/text-engine/assets/fonts/fixture/", import.meta.url);
const mono = readFileSync(new URL("DomotionFixtureMono-Regular.ttf", FIXTURES));
const serif = readFileSync(new URL("DomotionFixtureSerif-Regular.ttf", FIXTURES));

// Two API faces of one family that differ only in weight, plus a face that is
// loaded but never added and one that is added and then deleted. Blink matches
// neither of the last two, but both still emit CSS.fontsUpdated.
const PAGE = `<!doctype html>
<p id="bold" style="font:700 20px 'Api Fam'">Rag</p>
<p id="regular" style="font:400 20px 'Api Fam'">Rag</p>
<p id="ghost" style="font:400 20px 'Ghost Fam', 'Api Fam'">Rag</p>
<script>
const faces = [
  new FontFace("Api Fam", "url(/mono.ttf)", { weight: "600 800" }),
  new FontFace("Api Fam", "url(/serif.ttf)", { weight: "400" }),
];
for (const face of faces) document.fonts.add(face);
const unadded = new FontFace("Ghost Fam", "url(/mono.ttf?unadded)");
const deleted = new FontFace("Ghost Fam", "url(/mono.ttf?deleted)", { style: "italic" });
document.fonts.add(deleted);
window.apiFacesReady = Promise.all([
  ...faces.map((face) => face.load()),
  unadded.load(),
  deleted.load().then(() => document.fonts.delete(deleted)),
]);
</script>`;

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launchChromium({ headless: true });
  server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/\?.*$/, "");
    if (path === "/mono.ttf" || path === "/serif.ttf") {
      res.writeHead(200, { "content-type": "font/ttf" });
      res.end(path === "/mono.ttf" ? mono : serif);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  clearWebfonts();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  await new Promise((done) => server.close(done));
});

async function loadPage(): Promise<{ page: Page; tracker: ReturnType<typeof attachWebfontTracker> }> {
  const page = await browser.newPage();
  const tracker = attachWebfontTracker(page);
  await tracker.ready;
  await page.goto(`${origin}/`);
  await page.evaluate(async () => {
    await (window as unknown as { apiFacesReady: Promise<unknown> }).apiFacesReady;
    await document.fonts.ready;
  });
  return { page, tracker };
}

async function chromeFace(page: Page, selector: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts).toHaveLength(1);
    expect(fonts[0].isCustomFont).toBe(true);
    return fonts[0].postScriptName;
  } finally {
    await cdp.detach();
  }
}

describe("webfont discovery from CSS.fontsUpdated", () => {
  it("registers FontFace-API faces under the authored family and descriptors Chrome matches", async () => {
    const { page, tracker } = await loadPage();
    try {
      const report = await discoverAndRegisterWebfonts(page, tracker.urls, undefined, {
        fontsUpdatedFaces: tracker.fontFaces,
      });
      // The unadded and deleted Ghost Fam faces did emit events…
      expect(tracker.fontFaces.map((face) => face.fontFamily)).toEqual(
        expect.arrayContaining(["Api Fam", "Ghost Fam"]),
      );
      // …but only the two faces Blink can match are registered from them.
      expect(
        report
          .filter((row) => row.source === "fonts-updated")
          .map((row) => [row.family, row.url.replace(origin, ""), row.ok])
          .sort(),
      ).toEqual([
        ["Api Fam", "/mono.ttf", true],
        ["Api Fam", "/serif.ttf", true],
      ]);
      // The covered URLs no longer go through the OS/2 inference.
      expect(report.filter((row) => row.source === "resource").map((row) => row.url.replace(origin, ""))).toEqual(
        expect.not.arrayContaining(["/mono.ttf", "/serif.ttf"]),
      );

      const chromeBold = await chromeFace(page, "#bold");
      const chromeRegular = await chromeFace(page, "#regular");
      expect(chromeBold).toBe("JetBrainsMono-Regular");
      expect(chromeRegular).not.toBe(chromeBold);
      expect(resolveFont("'Api Fam'", 700, 20)?.postscriptName).toBe(chromeBold);
      expect(resolveFont("'Api Fam'", 400, 20)?.postscriptName).toBe(chromeRegular);
      // Ghost Fam is not in document.fonts, so Chrome falls through to Api Fam.
      expect(await chromeFace(page, "#ghost")).toBe(chromeRegular);
      expect(resolveFont("'Ghost Fam', 'Api Fam'", 400, 20)?.postscriptName).toBe(chromeRegular);
    } finally {
      tracker.detach();
      await page.close();
    }
  });

  it("negative control: without the events, the faces keep the internal-name inference", async () => {
    const { page, tracker } = await loadPage();
    try {
      const report = await discoverAndRegisterWebfonts(page, tracker.urls);
      expect(report.some((row) => row.source === "fonts-updated")).toBe(false);
      expect(report.filter((row) => row.source === "resource" && row.ok).map((row) => row.family)).toEqual(
        expect.arrayContaining(["JetBrains Mono", "IBM Plex Serif"]),
      );
      // The authored family is unknown, so the bold run cannot reach Chrome's face.
      expect(resolveFont("'Api Fam'", 700, 20)?.postscriptName).not.toBe(await chromeFace(page, "#bold"));
    } finally {
      tracker.detach();
      await page.close();
    }
  });
});
