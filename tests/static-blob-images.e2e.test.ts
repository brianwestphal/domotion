import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, captureElementTreeSelfContained, DemoRecorder } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";
import type { CapturedElement } from "../src/capture/types.js";
import { getLastCaptureWarnings } from "../src/capture/warnings.js";

let browser: Browser;
const viewport = { x: 0, y: 0, width: 720, height: 720 };

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

function imageIn(tree: CapturedElement[]): CapturedElement {
  let image: CapturedElement | undefined;
  forEachElement(tree, (element) => {
    if (element.tag === "img") image = element;
  });
  expect(image).toBeDefined();
  return image!;
}

async function createBlob(page: Page, bytes: Buffer, mime: string): Promise<string> {
  return page.evaluate(
    ({ base64, mime }) =>
      URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mime })),
    { base64: bytes.toString("base64"), mime },
  );
}

async function selectBlob(page: Page, bytes: Buffer, mime: string, responsive = false): Promise<string> {
  const source = await createBlob(page, bytes, mime);
  await page.locator("img").evaluate(
    async (element: HTMLImageElement, { source, responsive }) => {
      if (responsive) {
        element.srcset = `${source} 396w`;
        element.sizes = "390px";
      } else {
        element.src = source;
      }
      await element.decode();
    },
    { source, responsive },
  );
  return source;
}

const pixels = async (page: Page) =>
  sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer();
const redPng = () =>
  sharp({ create: { width: 396, height: 581, channels: 3, background: "red" } })
    .png()
    .toBuffer();
const showSvg = (page: Page, svg: string) => page.setContent(`<body style="margin:0;background:white">${svg}</body>`);
const basicPage = '<!doctype html><body style="margin:0;background:white"><img style="display:block"></body>';

describe("static blob images in self-contained capture (DM-ZRPWFP)", () => {
  it("embeds the selected responsive PNG and preserves its 223,470-pixel witness in a fresh consumer", async () => {
    const sourcePage = await browser.newPage({ viewport });
    const consumer = await browser.newPage({ viewport });
    try {
      await sourcePage.setContent(
        '<!doctype html><body style="margin:0;background:white"><img style="display:block;width:700px;height:700px;object-fit:none;margin:.296875px 0 0 .5px;object-position:0% 0%"></body>',
      );
      const bytes = await redPng();
      const source = await selectBlob(sourcePage, bytes, "image/png", true);
      const sourceDom = await sourcePage.content();
      const native = await pixels(sourcePage);
      const plain = await captureElementTree(sourcePage, "body", viewport);
      expect(imageIn(plain).imageSrc).toBe(source);
      await showSvg(consumer, elementTreeToSvg(plain, viewport.width, viewport.height));
      const unembedded = await pixels(consumer);
      let missing = 0;
      for (let offset = 0; offset < native.length; offset += 4) {
        if (native.readUInt32LE(offset) !== unembedded.readUInt32LE(offset)) missing++;
      }
      expect(missing).toBe(223470);

      // Main-world fetch can be application-owned. The browser read uses the
      // document's native fetch without replacing or invoking the author hook.
      await sourcePage.evaluate(() => {
        window.fetch = () => Promise.reject(new Error("author fetch hook"));
      });
      const captured = await captureElementTreeSelfContained(sourcePage, "body", viewport);
      expect(imageIn(captured).imageSrc).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
      expect(imageIn(captured).staticBlobSourceNodeIndex).toBeUndefined();
      expect(await sourcePage.content()).toBe(sourceDom);
      expect((await pixels(sourcePage)).equals(native)).toBe(true);
      await sourcePage.close();
      const svg = elementTreeToSvg(structuredClone(captured), viewport.width, viewport.height);
      expect(svg).not.toContain("blob:");
      await showSvg(consumer, svg);
      expect((await pixels(consumer)).equals(native)).toBe(true);
    } finally {
      await consumer.close();
      await sourcePage.close();
    }
  }, 60_000);

  it.each(["jpeg", "gif", "webp"] as const)(
    "retains exact selected static %s bytes",
    async (format) => {
      const page = await browser.newPage({ viewport });
      try {
        const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "blue" } })
          .toFormat(format)
          .toBuffer();
        const mime = `image/${format}`;
        await page.setContent(basicPage);
        await selectBlob(page, bytes, mime);
        const native = await pixels(page);
        const tree = await captureElementTreeSelfContained(page, "body", viewport);
        expect(imageIn(tree).imageSrc).toBe(`data:${mime};base64,${bytes.toString("base64")}`);
        await showSvg(page, elementTreeToSvg(tree, viewport.width, viewport.height));
        expect((await pixels(page)).equals(native)).toBe(true);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it.each(["CSP", "revoked", "SVG", "animated GIF", "source changed"] as const)(
    "retains the selected URL on %s refusal",
    async (arm) => {
      const page = await browser.newPage({ viewport });
      try {
        if (arm === "CSP") {
          await page.route("https://blob-control.invalid/", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: basicPage,
              headers: { "content-security-policy": "connect-src 'none'; img-src blob:" },
            }),
          );
          await page.goto("https://blob-control.invalid/");
        } else {
          await page.setContent(basicPage);
        }
        const bytes =
          arm === "SVG"
            ? Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
              )
            : arm === "animated GIF"
              ? await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
                  raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
                })
                  .gif({ delay: [50, 50], loop: 0 })
                  .toBuffer()
              : await redPng();
        const mime = arm === "SVG" ? "image/svg+xml" : arm === "animated GIF" ? "image/gif" : "image/png";
        const source = await selectBlob(page, bytes, mime);
        if (arm === "revoked") await page.evaluate((url) => URL.revokeObjectURL(url), source);
        let changed = false;
        if (arm === "source changed") {
          const context = page.context();
          const create = context.newCDPSession.bind(context);
          const replacement = await createBlob(page, bytes, "image/png");
          context.newCDPSession = async (target) => {
            const session = await create(target);
            const send = session.send.bind(session);
            session.send = (async (method: string, params?: { functionDeclaration?: string }) => {
              if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("const stillSelected")) {
                changed = true;
                await page.locator("img").evaluate(async (image: HTMLImageElement, next) => {
                  image.src = next;
                  await image.decode();
                }, replacement);
              }
              return Reflect.apply(send, session, [method, params]);
            }) as CDPSession["send"];
            return session;
          };
        }
        const tree = await captureElementTreeSelfContained(page, "body", viewport);
        if (arm === "source changed") expect(changed).toBe(true);
        expect(imageIn(tree).imageSrc).toBe(source);
        expect(imageIn(tree).staticBlobSourceNodeIndex).toBeUndefined();
        expect(getLastCaptureWarnings()).toContainEqual(
          expect.objectContaining({ feature: "static-blob-image", status: "unavailable" }),
        );
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("uses the same owned-byte route in the recorder's self-contained capture", async () => {
    const options = { width: 96, height: 96, selfContained: true };
    const recorder = new DemoRecorder("http://blob-control.invalid", options);
    try {
      await recorder.init(options);
      const page = recorder.getPage();
      await page.setContent(basicPage);
      const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "green" } })
        .png()
        .toBuffer();
      const source = await selectBlob(page, bytes, "image/png");
      const svg = await recorder.captureCurrent();
      expect(svg).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
      expect(svg).not.toContain(source);
    } finally {
      await recorder.close();
    }
  }, 60_000);
});
