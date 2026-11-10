import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarHttpGetter, loadHarArchive } from "../src/capture/har-fetcher.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { recordRealWorldHar } from "./real-world-har-cache.js";

let browser: Browser;
let server: Server;
let origin: string;
const marker = randomBytes(100_000).toString("hex");
const fontBytes = randomBytes(70_000);
beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader(
      "content-type",
      request.url === "/asset.js" ? "text/javascript" : request.url === "/font.woff2" ? "font/woff2" : "text/html",
    );
    response.end(
      request.url === "/asset.js"
        ? `window.marker='${marker}'`
        : request.url === "/font.woff2"
          ? fontBytes
          : '<script src="/asset.js"></script><body>recorded fixture</body>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("HAR fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("real-world JSON HAR recording and offline replay (DM-9K75QG)", () => {
  it.each(["embedded", "sidecar"] as const)("finalizes embedded recording and replays %s bytes", async (format) => {
    const dir = await mkdtemp(join(tmpdir(), "dm-har-browser-"));
    const path = join(dir, "page.har");
    const recording = await browser.newContext();
    const page = await recording.newPage();
    try {
      await recordRealWorldHar(recording, path, async () => {
        await page.goto(origin);
        expect(await page.evaluate(() => (globalThis as typeof globalThis & { marker: string }).marker)).toBe(marker);
        await page.evaluate(() => fetch("/font.woff2").then((response) => response.arrayBuffer()));
      });
      const initial = await readFile(path, "utf8");
      expect(initial).not.toContain('"_file"');
      if (format === "sidecar") {
        const json = JSON.parse(initial) as {
          log: { entries: Array<{ response: { content: { text?: string; encoding?: string; _file?: string } } }> };
        };
        for (const [index, entry] of json.log.entries.entries()) {
          const content = entry.response.content;
          const file = `${index}.body`;
          await writeFile(
            join(dir, file),
            Buffer.from(content.text ?? "", content.encoding === "base64" ? "base64" : "utf8"),
          );
          entry.response.content = { _file: file };
        }
        await writeFile(path, JSON.stringify(json));
      }
      const before = await readFile(path);
      const getter = createHarHttpGetter(loadHarArchive(path), { notFound: "abort" });
      expect(await (await getter(`${origin}/font.woff2`)).body()).toEqual(fontBytes);
      const replay = await browser.newContext({ offline: true });
      try {
        await replay.routeFromHAR(path, { notFound: "abort", update: false });
        const replayPage = await replay.newPage();
        await replayPage.goto(origin);
        expect(await replayPage.evaluate(() => (globalThis as typeof globalThis & { marker: string }).marker)).toBe(
          marker,
        );
        const replayBytes = await replayPage.evaluate(() =>
          fetch("/font.woff2")
            .then((response) => response.arrayBuffer())
            .then((bytes) => Array.from(new Uint8Array(bytes))),
        );
        expect(Buffer.from(replayBytes)).toEqual(fontBytes);
      } finally {
        await replay.close();
      }
      expect(await readFile(path)).toEqual(before);
    } finally {
      await recording.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
