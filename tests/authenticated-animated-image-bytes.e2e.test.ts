import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnimatedImageByteCollectorError,
  AuthenticatedAnimatedImageByteCollector,
} from "../src/capture/authenticated-animated-image-bytes.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

describe("authenticated animated-image byte collector (DM-2585)", () => {
  let server: Server;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect.gif") {
        response.writeHead(302, { location: "/pixel.gif" }); response.end(); return;
      }
      if (request.url?.startsWith("/pixel.gif")) {
        response.writeHead(200, { "content-type": "image/gif", "content-length": GIF.byteLength });
        response.end(GIF); return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><body></body>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("test server address unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => error == null ? resolve() : reject(error)));
  });

  async function pageWith(html: string) {
    const page = await browser.newPage();
    const collector = await AuthenticatedAnimatedImageByteCollector.install(page);
    await page.goto(`${origin}/`);
    await page.setContent(html, { waitUntil: "load" });
    return { page, collector };
  }

  it("authenticates one same-origin HTTP image through the completed Network response", async () => {
    const { page, collector } = await pageWith(`<img id="target" src="${origin}/pixel.gif">`);
    const [result] = await collector.collect([{ selector: "#target", frameIndex: 3 }]);
    expect(result.record).toMatchObject({
      ownerKind: "html-image", ownerSlot: "html-current", requestedFrameIndex: 3,
      transport: "network-get-response-body", mimeType: "image/gif", byteLength: GIF.byteLength,
    });
    expect(Buffer.from(result.copyBytes())).toEqual(GIF);
    const copy = result.copyBytes(); copy.fill(0);
    expect(Buffer.from(result.copyBytes())).toEqual(GIF);
    await collector.dispose(); await page.close();
  });

  it("keeps picture selection and input-image ownership distinct", async () => {
    const { page, collector } = await pageWith(`
      <picture><source srcset="${origin}/pixel.gif?picture"><img id="picture" src="bad.gif"></picture>
      <input id="submit" type="image" src="${origin}/pixel.gif?input">`);
    const results = await collector.collect([
      { selector: "#picture", frameIndex: 1 }, { selector: "#submit", frameIndex: 2 },
    ]);
    expect(results.map((result) => result.record.ownerKind)).toEqual(["html-image", "input-image"]);
    expect(results.map((result) => result.record.ownerSlot)).toEqual(["html-current", "input-src"]);
    await collector.dispose(); await page.close();
  });

  it("authenticates a public SVG href owner through a unique ledger join", async () => {
    const { page, collector } = await pageWith(`
      <svg><image id="target" href="${origin}/pixel.gif?svg"></image></svg>`);
    const [result] = await collector.collect([{ selector: "#target", frameIndex: 1 }]);
    expect(result.record).toMatchObject({
      ownerKind: "svg-image", ownerSlot: "svg-href", cssProperty: null,
      cssIndex: null, selectedUrl: `${origin}/pixel.gif?svg`,
    });
    await collector.dispose(); await page.close();
  });

  it("authenticates one explicit ordinary CSS URL layer", async () => {
    const { page, collector } = await pageWith(`
      <div id="target" style="background-image: url('${origin}/pixel.gif?zero'), url('${origin}/pixel.gif?one')"></div>`);
    const [result] = await collector.collect([{
      selector: "#target", frameIndex: 2,
      cssSlot: { property: "background-image", index: 1 },
    }]);
    expect(result.record).toMatchObject({
      ownerKind: "css-image", ownerSlot: "css-property",
      cssProperty: "background-image", cssIndex: 1,
      selectedUrl: `${origin}/pixel.gif?one`,
    });
    await collector.dispose(); await page.close();
  });

  it("rejects CSS image-set because public CSSOM does not expose its selected resource identity", async () => {
    const { page, collector } = await pageWith(`
      <div id="target" style="background-image: image-set(url('${origin}/pixel.gif?one') 1x, url('${origin}/pixel.gif?two') 2x)"></div>`);
    const error = await collector.collect([{
      selector: "#target", frameIndex: 0,
      cssSlot: { property: "background-image", index: 0 },
    }]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnimatedImageByteCollectorError);
    expect((error as AnimatedImageByteCollectorError).code).toBe("unsupported-owner");
    await collector.dispose(); await page.close();
  });

  it("uses the separate data transport without a Network body join", async () => {
    const data = `data:image/gif;base64,${GIF.toString("base64")}`;
    const { page, collector } = await pageWith(`<img id="target" src="${data}">`);
    const [result] = await collector.collect([{ selector: "#target", frameIndex: 0 }]);
    expect(result.record).toMatchObject({ transport: "data-url", requestId: null, byteLength: GIF.byteLength });
    await collector.dispose(); await page.close();
  });

  it("authenticates a settled same-origin redirect", async () => {
    const { page, collector } = await pageWith(`<img id="target" src="${origin}/redirect.gif">`);
    const [result] = await collector.collect([{ selector: "#target", frameIndex: 0 }]);
    expect(result.record.redirectHops).toHaveLength(1);
    expect(result.record.responseUrl).toBe(`${origin}/pixel.gif`);
    await collector.dispose(); await page.close();
  });

  it("double-reads a same-partition blob in its owning realm", async () => {
    const { page, collector } = await pageWith(`<img id="target">`);
    await page.evaluate((encoded) => {
      const binary = atob(encoded); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      (document.querySelector("#target") as HTMLImageElement).src = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    }, GIF.toString("base64"));
    await page.locator("#target").evaluate((image: HTMLImageElement) => image.decode());
    const [result] = await collector.collect([{ selector: "#target", frameIndex: 0 }]);
    expect(result.record).toMatchObject({ transport: "blob-read", byteLength: GIF.byteLength });
    await collector.dispose(); await page.close();
  });

  it("fails closed without leaking protocol or body details", async () => {
    const { page, collector } = await pageWith(`<img class="target" src="${origin}/pixel.gif"><img class="target" src="${origin}/pixel.gif">`);
    const error = await collector.collect([{ selector: ".target", frameIndex: 0 }]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnimatedImageByteCollectorError);
    expect((error as Error).message).toBe("ambiguous-owner");
    expect((error as Error).message).not.toContain(origin);
    await collector.dispose(); await page.close();
  });
});
