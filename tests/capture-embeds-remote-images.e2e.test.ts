import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { launchChromium, captureElementTree, elementTreeToSvgInner, embedRemoteImages } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1506: `domotion capture` must embed remote images so the output SVG is
// self-contained (the CLI now runs embedRemoteImages() by default; --no-embed-
// images opts out). The render pass is synchronous and can't fetch, so an
// <img src=http://…> stays a REMOTE <image href> until the async
// embedRemoteImages() pre-pass rewrites it to a data URI. This guards that
// mechanism end-to-end against a loopback HTTP server (skips where the browser
// can't launch, like the other browser-driven e2e tests).

const W = 200, H = 160;

async function setup(): Promise<{ server: Server; base: string; browser: Awaited<ReturnType<typeof launchChromium>> } | null> {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 220, g: 40, b: 90 } } }).png().toBuffer();
  const html =
    `<!doctype html><html><head><style>body{margin:0;background:#fff}` +
    `img{position:absolute;left:20px;top:20px;width:120px;height:100px}</style></head>` +
    `<body><img src="/pic.png"></body></html>`;
  const started = await new Promise<{ server: Server; base: string } | null>((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/pic.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(png); }
      else { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") { server.close(); resolve(null); return; }
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
  if (started == null) return null;
  try {
    return { ...started, browser: await launchChromium() };
  } catch {
    started.server.close();
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
  env?.server.close();
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("capture embeds remote images (DM-1506)", () => {
  it("rewrites a remote <img> to a self-contained data URI after embedRemoteImages()", async () => {
    const { base, browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      // Before embedding: the <image> still points at the remote URL — NOT
      // self-contained (this is what the bare CLI used to emit).
      const before = elementTreeToSvgInner(tree, W, H);
      expect(before).toMatch(/<image[^>]+href="http:\/\/127\.0\.0\.1/);
      expect(before).not.toMatch(/<image[^>]+href="data:/);

      // After embedRemoteImages() — what `domotion capture` now runs by default —
      // the image is a self-contained data URI and no remote ref remains.
      await embedRemoteImages(tree);
      const after = elementTreeToSvgInner(tree, W, H);
      expect(after).toMatch(/<image[^>]+href="data:image\//);
      expect(after).not.toMatch(/href="http:\/\/127\.0\.0\.1/);
    } finally {
      await page.close();
    }
  }, 60_000);
});
