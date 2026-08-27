import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthenticatedAnimatedImageByteCollector } from "../src/capture/authenticated-animated-image-bytes.js";
import { freezeAuthenticatedAnimatedImageFrames } from "../src/capture/animated-image-static-frame.js";
import { ANIMATED_IMAGE_FIXTURES } from "../tools/animated-image-frame-selection-audit.js";
import { DemoRecorder } from "../src/capture/index.js";

describe("strict animated-image static frame capture (DM-2579)", () => {
  let server: Server; let browser: Browser; let origin: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      if (request.url === "/capture") {
        const fixture = ANIMATED_IMAGE_FIXTURES[0];
        response.end(`<!doctype html><img id="target" src="data:${fixture.mimeType};base64,${fixture.base64}">`);
      } else response.end("<!doctype html><body></body>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address == null || typeof address === "string") throw new Error();
    origin = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it.each(ANIMATED_IMAGE_FIXTURES)("freezes authenticated nonzero $format frame as PNG", async (fixture) => {
    const page = await browser.newPage(); const collector = await AuthenticatedAnimatedImageByteCollector.install(page);
    await page.goto(origin); const data = `data:${fixture.mimeType};base64,${fixture.base64}`;
    await page.setContent(`<img id="target" src="${data}">`);
    const bytes = await collector.collect([{ selector: "#target", frameIndex: 1 }]);
    const [record] = await freezeAuthenticatedAnimatedImageFrames(page, bytes);
    expect(record.requestedFrameIndex).toBe(1); expect(record.track.animated).toBe(true);
    expect(record.observation.complete).toBe(true); expect(record.pngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await page.locator("#target").getAttribute("src")).toBe(record.pngDataUrl);
    await collector.dispose(); await page.close();
  });

  it("fails closed for an out-of-range requested frame", async () => {
    const fixture = ANIMATED_IMAGE_FIXTURES[0]; const page = await browser.newPage();
    const collector = await AuthenticatedAnimatedImageByteCollector.install(page); await page.goto(origin);
    await page.setContent(`<img id="target" src="data:${fixture.mimeType};base64,${fixture.base64}">`);
    const bytes = await collector.collect([{ selector: "#target", frameIndex: 99 }]);
    await expect(freezeAuthenticatedAnimatedImageFrames(page, bytes)).rejects.toThrow("frame-index-out-of-range");
    await collector.dispose(); await page.close();
  });

  it.each(["svg-href", "background-image", "border-image-source", "mask-image", "list-style-image"] as const)(
    "substitutes only the authenticated %s owner slot", async (slot) => {
    const fixture = ANIMATED_IMAGE_FIXTURES[0]; const page = await browser.newPage();
    const collector = await AuthenticatedAnimatedImageByteCollector.install(page); await page.goto(origin);
    const data = `data:${fixture.mimeType};base64,${fixture.base64}`;
    const cssValue = slot === "background-image" || slot === "mask-image"
      ? `url('${data}'),linear-gradient(red,blue)` : `url('${data}')`;
    await page.setContent(slot === "svg-href"
      ? `<svg><image id="target" href="${data}" width="2" height="2"/></svg>`
      : `<div id="target" style="${slot}:${cssValue}"></div>`);
    const request = slot === "svg-href"
      ? { selector: "#target", frameIndex: 1, slot }
      : { selector: "#target", frameIndex: 1, slot, index: 0 };
    const bytes = await collector.collect([request]);
    const [record] = await freezeAuthenticatedAnimatedImageFrames(page, bytes);
    const value = await page.locator("#target").evaluate((owner, selectedSlot) => selectedSlot === "svg-href"
      ? (owner as SVGImageElement).href.baseVal
      : (owner as HTMLElement).style.getPropertyValue(selectedSlot), slot);
    expect(value).toContain(record.pngDataUrl);
    if (slot === "background-image" || slot === "mask-image") expect(value).toContain("linear-gradient");
    await collector.dispose(); await page.close();
  });

  it("emits only the authenticated frozen PNG through the production capture path", async () => {
    const recorder = new DemoRecorder(origin, {
      width: 100, height: 100, selfContained: true, embedRemoteImagesResize: true,
      animatedImageFrames: [{ selector: "#target", frameIndex: 1 }],
    });
    await recorder.init({ width: 100, height: 100, selfContained: true, embedRemoteImagesResize: true,
      animatedImageFrames: [{ selector: "#target", frameIndex: 1 }] });
    try {
      const svg = await recorder.captureUrl("/capture", 0);
      expect(svg).toContain("data:image/png");
      expect(svg).not.toContain("data:image/gif");
      expect(recorder.getAnimatedImageStaticFrameRecords()[0]?.requestedFrameIndex).toBe(1);
      expect(recorder.getFrozenAnimatedImageResizeRecords()[0]).toMatchObject({
        requestedFrameIndex: 1, output: { resized: false },
      });
    } finally { await recorder.close(); }
  });
});
