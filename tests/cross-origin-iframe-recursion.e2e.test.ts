import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { launchChromium, captureElementTreeWithWarnings, crossOriginFramesLaunchArgs } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

/**
 * DM-1442 — opt-in cross-origin `<iframe>` recursion via the
 * `--cross-origin-frames` allowlist. Two HTTP servers on different localhost
 * ports are two different origins; the outer page embeds the inner one in an
 * iframe. With Chromium launched with web security disabled, the inner
 * cross-origin document is readable, and the allowlist decides per-frame whether
 * it recurses into native SVG or stays the raster snapshot.
 */

const INNER_TEXT = "INNER_FRAME_TEXT_DM1442";

function startServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Depth-first: first captured node with the given tag. */
function findByTag(tree: CapturedElement[], tag: string): CapturedElement | null {
  for (const el of tree) {
    if (el.tag === tag) return el;
    const inner = el.children ? findByTag(el.children, tag) : null;
    if (inner != null) return inner;
  }
  return null;
}

/** Does any node in the subtree carry the marker text (in text or a segment)? */
function subtreeHasText(el: CapturedElement, needle: string): boolean {
  if ((el.text ?? "").includes(needle)) return true;
  if (el.textSegments?.some((s) => (s.text ?? "").includes(needle))) return true;
  return (el.children ?? []).some((c) => subtreeHasText(c, needle));
}

// Module-level setup (top-level await) so `env` is populated at COLLECTION time
// — `describe.skip` is chosen synchronously below, before the suite is built.
const innerSrv = await startServer(
  `<!doctype html><html><body style="margin:0;background:#0b1b34;color:#fff;font:18px sans-serif;"><div style="padding:14px;">${INNER_TEXT}</div></body></html>`,
);
const outerSrv = await startServer(
  `<!doctype html><html><body style="margin:0;"><div style="padding:20px;"><iframe src="http://127.0.0.1:${innerSrv.port}/" width="240" height="100" style="display:block;border:0;"></iframe></div></body></html>`,
);
const outerUrl = `http://127.0.0.1:${outerSrv.port}/`;

const env = await (async () => {
  try {
    return { browserSecOff: await launchChromium({ args: crossOriginFramesLaunchArgs("*") }) };
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browserSecOff);
  await closeServer(innerSrv.server);
  await closeServer(outerSrv.server);
}, 20_000);

const describeBrowser = env ? describe : describe.skip;

async function captureIframe(crossOriginFrames: string): Promise<CapturedElement> {
  const browser = env!.browserSecOff;
  const ctx = await browser.newContext({ viewport: { width: 280, height: 140 } });
  const page = await ctx.newPage();
  try {
    await page.goto(outerUrl, { waitUntil: "networkidle" });
    const { tree } = await captureElementTreeWithWarnings(
      page,
      "body",
      { x: 0, y: 0, width: 280, height: 140 },
      { crossOriginFrames },
    );
    const iframe = findByTag(tree, "iframe");
    expect(iframe, "captured tree should contain an <iframe> node").not.toBeNull();
    return iframe!;
  } finally {
    await ctx.close();
  }
}

describeBrowser("cross-origin iframe recursion (DM-1442)", () => {
  it("recurses a cross-origin frame whose host:port is on the allowlist", async () => {
    const iframe = await captureIframe(`127.0.0.1:${innerSrv.port}`);
    expect(iframe.replacedSnapshot, "matched frame should NOT be rastered").toBeUndefined();
    expect(subtreeHasText(iframe, INNER_TEXT), "inner text should be captured natively").toBe(true);
  });

  it("recurses all cross-origin frames under the wildcard", async () => {
    const iframe = await captureIframe("*");
    expect(iframe.replacedSnapshot).toBeUndefined();
    expect(subtreeHasText(iframe, INNER_TEXT)).toBe(true);
  });

  it("leaves a non-allowlisted cross-origin frame as a raster snapshot (blast-radius limit)", async () => {
    // Web security IS off (the frame is readable), but the host:port is NOT on
    // the allowlist — the allowlist gate must still keep it a raster.
    const iframe = await captureIframe(`127.0.0.1:${innerSrv.port + 1}`);
    expect(iframe.replacedSnapshot, "non-matched frame should be rastered").toBeDefined();
    expect(subtreeHasText(iframe, INNER_TEXT), "inner text should NOT be captured natively").toBe(false);
  });

  it("leaves cross-origin frames as raster when no allowlist is given (default)", async () => {
    const iframe = await captureIframe("");
    expect(iframe.replacedSnapshot).toBeDefined();
    expect(subtreeHasText(iframe, INNER_TEXT)).toBe(false);
  });
});

// A SECOND browser launched WITHOUT the flag proves the launch helper matters:
// cross-origin contentDocument is null under the SOP, so even `*` can't recurse.
describe("cross-origin recursion requires web security disabled (DM-1442)", () => {
  it("a frame stays raster when Chromium keeps web security on, even with *", async () => {
    let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
    try {
      browser = await launchChromium(); // no --disable-web-security
    } catch {
      return; // browser unavailable — skip
    }
    try {
      const ctx = await browser.newContext({ viewport: { width: 280, height: 140 } });
      const page = await ctx.newPage();
      await page.goto(outerUrl, { waitUntil: "networkidle" });
      const { tree } = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 280, height: 140 },
        { crossOriginFrames: "*" },
      );
      const iframe = findByTag(tree, "iframe");
      expect(iframe).not.toBeNull();
      expect(iframe!.replacedSnapshot, "unreadable cross-origin frame must raster").toBeDefined();
      expect(subtreeHasText(iframe!, INNER_TEXT)).toBe(false);
      await ctx.close();
    } finally {
      await closeBrowserSafely(browser);
    }
  }, 60_000);
});
