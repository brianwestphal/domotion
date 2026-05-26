import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { launchChromium, captureElementTree, elementTreeToSvg, setRenderTextMode } from "../src/index.js";

// External-file SVG fragment refs: clip-path (DM-829) and mask-image (DM-496).
// Chrome only resolves these over http(s) (not file://), and the capture
// pre-pass (inlineExternalSvgRefs) fetches the .svg same-origin — so this is
// validated against a loopback HTTP server, not the file:// feature runner.
// Gated on a launchable browser (skips in a sandbox that blocks browser
// launch), like the other browser-driven tests.

const W = 280, H = 200;
// A box at page (40,40) 160x120, clipped by an external userSpaceOnUse triangle
// (also exercises DM-828 positioning via the external path). The clip keeps a
// downward triangle: apex at element-local (80,120), base across the top.
const SHAPES_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg"><clipPath id="tri" clipPathUnits="userSpaceOnUse">` +
  `<polygon points="0,0 160,0 80,120"/></clipPath></svg>`;
const INDEX_HTML =
  `<!doctype html><html><head><style>body{margin:0;background:#ffffff}` +
  `#box{position:absolute;left:40px;top:40px;width:160px;height:120px;` +
  `background:#d81b60;clip-path:url(./shapes.svg#tri)}</style></head>` +
  `<body><div id="box"></div></body></html>`;

// External mask: the known-good same-document mask geometry (DM-493's
// `mask-fragment-url` fixture) lifted into a separate file. White everywhere
// except a black polygon over the top-left, so that region is masked out
// (background shows) while the rest of the box paints. The box at element-local
// (140,100) → page (180,140) is outside the polygon (painted); (20,10) →
// page (60,50) is inside it (masked).
const MASK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg"><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="120">` +
  `<rect x="0" y="0" width="160" height="120" fill="white"/>` +
  `<polygon points="0,0 160,0 160,40 0,120" fill="black"/></mask></svg>`;
const MASK_HTML =
  `<!doctype html><html><head><style>body{margin:0;background:#ffffff}` +
  `#box{position:absolute;left:40px;top:40px;width:160px;height:120px;background:#16a34a;` +
  `mask-image:url(./maskdef.svg#m);-webkit-mask-image:url(./maskdef.svg#m)}</style></head>` +
  `<body><div id="box"></div></body></html>`;

// Determine gating at module-eval time (before vitest collects the describe),
// since whether the browser launches decides skip-vs-run. Start the loopback
// server + launch the browser up front; skip cleanly if either is unavailable
// (e.g. a sandbox that blocks browser launch or socket listen).
async function setup(): Promise<{ server: Server; base: string; browser: Awaited<ReturnType<typeof launchChromium>> } | null> {
  const started = await new Promise<{ server: Server; base: string } | null>((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/shapes.svg")) {
        res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(SHAPES_SVG);
      } else if (url.startsWith("/maskdef.svg")) {
        res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(MASK_SVG);
      } else if (url.startsWith("/mask.html")) {
        res.writeHead(200, { "content-type": "text/html" }); res.end(MASK_HTML);
      } else {
        res.writeHead(200, { "content-type": "text/html" }); res.end(INDEX_HTML);
      }
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
    const browser = await launchChromium();
    return { ...started, browser };
  } catch {
    started.server.close();
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  try { await env?.browser.close(); } catch { /* ignore */ }
  env?.server.close();
});

const describeBrowser = env ? describe : describe.skip;

describeBrowser("external-file clip-path fragment refs (DM-829)", () => {
  it("resolves url(\"./shapes.svg#id\"), inlines the clipPath, and clips in place", async () => {
    const { base, browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${base}/index.html`, { waitUntil: "load" });

      // Chrome's native paint (sanity: the external clip really applies over http
      // — guards the test from passing on a no-op). Triangle apex at page (120,160),
      // base across the top; so (120,50) is inside, bottom corners are clipped.
      const expected = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const px = async (buf: Buffer, x: number, y: number) => {
        const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
        const i = (y * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2]] as [number, number, number];
      };
      const pink = (p: [number, number, number]) => p[0] > 150 && p[1] < 100 && p[2] > 60 && p[2] < 150;
      expect(pink(await px(expected, 120, 52))).toBe(true);   // inside the triangle
      expect(pink(await px(expected, 45, 150))).toBe(false);  // bottom-left corner clipped

      // Capture → SVG. The pre-pass should have fetched + inlined the external
      // clipPath and rewritten the ref to same-document.
      setRenderTextMode("paths");
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);

      // The external triangle was inlined as a <clipPath> def and the box group
      // references it — i.e. the external ref was resolved, not dropped.
      expect(svg).toMatch(/<clipPath\b[^>]*>/i);
      expect(svg).toContain("clip-path=\"url(#");
      expect(svg).toMatch(/<polygon[^>]*points="0,0 160,0 80,120"/);

      // Render Domotion's SVG and confirm the clip lands in the same place.
      const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${svg}</svg>`;
      await page.setContent(`<!doctype html><body style="margin:0">${svgDoc}</body>`, { waitUntil: "load" });
      const actual = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      expect(pink(await px(actual, 120, 52))).toBe(true);   // inside → painted
      expect(pink(await px(actual, 45, 150))).toBe(false);  // clipped corner → bg
    } finally {
      await page.close();
    }
  }, 60_000);
});

describeBrowser("external-file mask-image fragment refs (DM-496)", () => {
  it("resolves url(\"./maskdef.svg#id\"), inlines the <mask>, and masks in place", async () => {
    const { base, browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${base}/mask.html`, { waitUntil: "load" });

      const px = async (buf: Buffer, x: number, y: number) => {
        const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
        const i = (y * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2]] as [number, number, number];
      };
      const green = (p: [number, number, number]) => p[1] > 120 && p[0] < 120 && p[2] < 120;

      // Chrome's native paint (sanity: the external mask really applies over http).
      const expected = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      expect(green(await px(expected, 180, 140))).toBe(true);   // outside the black polygon → painted
      expect(green(await px(expected, 60, 50))).toBe(false);    // inside it → masked (bg)

      setRenderTextMode("paths");
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);

      // The external <mask> was inlined as a same-document def and applied.
      expect(svg).toMatch(/<mask\b[^>]*>/i);
      expect(svg).toContain("mask=\"url(#");

      const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${svg}</svg>`;
      await page.setContent(`<!doctype html><body style="margin:0">${svgDoc}</body>`, { waitUntil: "load" });
      const actual = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      expect(green(await px(actual, 180, 140))).toBe(true);   // unmasked region → painted
      expect(green(await px(actual, 60, 50))).toBe(false);    // masked region → bg
    } finally {
      await page.close();
    }
  }, 60_000);
});
