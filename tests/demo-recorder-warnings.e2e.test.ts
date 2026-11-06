import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DemoRecorder } from "../src/capture/index.js";
import { getLastCaptureWarnings } from "../src/capture/warnings.js";

// Each DemoRecorder keeps its own capture + render warnings. Before this, the
// recorder captured through the process-global last-capture buffer and rendered
// outside any warning sink, so two recorders overlapping in one process
// attributed one recorder's render degradations to whichever capture finished
// last, and neither recorder could report its own warnings at all.

const PAGES: Record<string, string> = {
  // A failed URL background is a RENDER-side degradation (renderWarn
  // "url-background"); the canvas is a CAPTURE-side warning.
  "/degraded":
    '<body style="margin:0"><div style="width:40px;height:40px;background-image:url(/missing.png)"></div><canvas width="8" height="8"></canvas></body>',
  "/plain": '<body style="margin:0"><div style="width:40px;height:40px;background:#08f"></div></body>',
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = PAGES[request.url ?? ""];
    if (body == null) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("DemoRecorder warning scope", () => {
  it("keeps each recorder's render warnings with its own capture when two recorders interleave", async () => {
    const opts = { width: 120, height: 80 };
    const degraded = new DemoRecorder(origin, opts);
    const plain = new DemoRecorder(origin, opts);
    await Promise.all([degraded.init(opts), plain.init(opts)]);
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      // Overlapping: both captures are in flight at once.
      await Promise.all([degraded.captureUrl("/degraded", 50), plain.captureUrl("/plain", 50)]);
      const degradedFeatures = degraded.getLastCaptureWarnings().map((warning) => warning.feature);
      expect(degradedFeatures).toContain("url-background");
      expect(degradedFeatures).toContain("<canvas>");
      expect(plain.getLastCaptureWarnings()).toEqual([]);

      // Strict sequence: the plain recorder captures LAST, then the degraded
      // recorder renders again. The plain recorder's warnings stay empty and the
      // degraded recorder's render warnings do not leak into the process global.
      await plain.captureCurrent();
      const globalBefore = getLastCaptureWarnings();
      await degraded.captureCurrent();
      expect(plain.getLastCaptureWarnings()).toEqual([]);
      expect(degraded.getLastCaptureWarnings().map((warning) => warning.feature)).toContain("url-background");
      expect(getLastCaptureWarnings().filter((warning) => warning.feature === "url-background")).toEqual(
        globalBefore.filter((warning) => warning.feature === "url-background"),
      );

      // A later clean capture replaces, rather than accumulates, the recorder's warnings.
      await degraded.captureUrl("/plain", 50);
      expect(degraded.getLastCaptureWarnings()).toEqual([]);
    } finally {
      console.warn = originalWarn;
      await Promise.all([degraded.close(), plain.close()]);
    }
  }, 120_000);
});
