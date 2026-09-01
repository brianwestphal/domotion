import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { chromium } from "@playwright/test";
import {
  assembleCaptureDebugBundle,
  captureElementTreeWithDebug,
  elementTreeToSvg,
} from "../src/index.js";

let server: Server;
let baseUrl = "";
const tempRoot = mkdtempSync(join(tmpdir(), "domotion-debug-api-"));

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><style>
      html,body{margin:0;width:160px;height:90px;overflow:hidden;background:#f7f3e8}
      #target{box-sizing:border-box;width:160px;height:90px;padding:18px;color:#172554;font:700 20px sans-serif}
    </style><div id="target">programmatic debug</div><script>
      document.querySelector("#target").animate(
        [{ backgroundColor: "rgb(255, 0, 0)" }, { backgroundColor: "rgb(0, 0, 255)" }],
        { duration: 1000, fill: "both" },
      );
    </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("debug fixture server did not bind TCP");
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("programmatic debug capture API (DM-2635)", () => {
  it("returns in-memory evidence while the caller owns HAR lifecycle and storage", async () => {
    const browser = await chromium.launch({ headless: true });
    const harPath = join(tempRoot, "caller-owned.har");
    try {
      const context = await browser.newContext({
        viewport: { width: 160, height: 90 },
        deviceScaleFactor: 1,
        recordHar: { path: harPath, mode: "minimal" },
      });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "load" });

      const result = await captureElementTreeWithDebug(
        page,
        "#target",
        { x: 0, y: 0, width: 160, height: 90 },
        { animationTimeMs: 750 },
      );
      const actualSvg = elementTreeToSvg(result.tree, 160, 90);

      // Playwright flushes HAR only when the caller closes its context. The
      // capture API deliberately neither owns nor closes that context.
      await context.close();
      const har = readFileSync(harPath);
      const bundle = assembleCaptureDebugBundle(result.debug, actualSvg, { captureHar: har });

      const png = await sharp(bundle.expectedPng).metadata();
      expect({ width: png.width, height: png.height, format: png.format }).toEqual({
        width: 160,
        height: 90,
        format: "png",
      });
      const rawPng = await sharp(bundle.expectedPng).removeAlpha().raw().toBuffer();
      expect(rawPng[2], "the debug screenshot must observe the sought 750ms animation frame").toBeGreaterThan(rawPng[0]!);
      expect(JSON.parse(bundle.capturedTreeJson)).toEqual(result.tree);
      expect(bundle.capturedTreeJson).toContain("programmatic debug");
      expect(bundle.actualSvg).toMatch(/^<svg[^>]+width="160"[^>]+height="90"/);
      const parsedHar = JSON.parse(new TextDecoder().decode(bundle.captureHar)) as {
        log: { entries: Array<{ request: { url: string } }> };
      };
      expect(parsedHar.log.entries.some((entry) => entry.request.url === baseUrl)).toBe(true);

      // No CLI directory convention is imposed; only the caller's chosen HAR
      // path exists because every other artifact stayed in memory.
      expect(readdirSync(tempRoot)).toEqual(["caller-owned.har"]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
