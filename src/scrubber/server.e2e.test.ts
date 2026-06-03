import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { startScrubberServer, type ScrubberServerHandle } from "./server.js";

/**
 * DM-1040: end-to-end coverage for the `animated-svg-scrubber` server — the
 * three Chromium-backed endpoints (`/timing`, `/trim`, `/export-frame`) plus the
 * static shell/client. Drives the server in-process (injected `launchBrowser`)
 * so it runs wherever Playwright's Chromium is available; the whole block skips
 * cleanly otherwise so a browserless CI stays green.
 */

let chromiumAvailable = true;
try { /* probe lazily in beforeAll */ } catch { chromiumAvailable = false; }

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60">
<style>@keyframes m{0%{transform:translateX(0)}100%{transform:translateX(60px)}}
.b{animation:m 2s linear infinite}</style>
<rect class="b" width="20" height="20" y="20" fill="#ee2233"/></svg>`;

describe("animated-svg-scrubber server (DM-1040)", () => {
  let browser: Browser | null = null;
  let srv: ScrubberServerHandle | null = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch();
    } catch {
      chromiumAvailable = false;
      return;
    }
    srv = await startScrubberServer({ launchBrowser: async () => browser! });
  }, 60_000);

  afterAll(async () => {
    if (srv) await srv.close();
    // `srv.close()` closes the browser it was handed; nothing else to do.
  });

  const post = (path: string, body: unknown) =>
    fetch(srv!.url.replace(/\/$/, "") + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  it("serves the HTML shell and the client bundle", async () => {
    if (!chromiumAvailable) return;
    const shell = await fetch(srv!.url);
    expect(shell.headers.get("content-type")).toContain("text/html");
    const html = await shell.text();
    expect(html).toContain('id="app"');
    expect(html).toContain("/client.js");
    const js = await fetch(srv!.url.replace(/\/$/, "") + "/client.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await js.text()).length).toBeGreaterThan(1000);
  });

  it("/timing derives the single-loop duration + intrinsic size", async () => {
    if (!chromiumAvailable) return;
    const t = await (await post("/timing", { svg: SVG })).json() as { durationMs: number | null; width: number; height: number };
    expect(t.durationMs).toBe(2000); // 2s loop
    expect(t.width).toBe(100);
    expect(t.height).toBe(60);
  });

  it("/trim re-bases the timeline to the in-point (CSS delay shift + keyframes intact)", async () => {
    if (!chromiumAvailable) return;
    const r = await (await post("/trim", { svg: SVG, startMs: 500, endMs: 1500, periodMs: 2000 })).json() as
      { svg: string; shiftedCss: number; shiftedSmil: number };
    expect(r.shiftedCss).toBe(1);
    expect(r.svg).toContain("@keyframes m"); // keyframes left intact
    expect(r.svg).toMatch(/animation-delay:-0\.5s/); // re-based to the 0.5s in-point
    expect(r.svg).toContain("animation-fill-mode:both");
  });

  it("/export-frame returns a PNG of the seeked frame", async () => {
    if (!chromiumAvailable) return;
    const r = await post("/export-frame", { svg: SVG, timeMs: 1000, width: 100, height: 60 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.slice(1, 4).toString("ascii")).toBe("PNG"); // PNG signature
  });

  it("two different seek times produce different frames (the seek actually moves)", async () => {
    if (!chromiumAvailable) return;
    const a = Buffer.from(await (await post("/export-frame", { svg: SVG, timeMs: 0, width: 100, height: 60 })).arrayBuffer());
    const b = Buffer.from(await (await post("/export-frame", { svg: SVG, timeMs: 1000, width: 100, height: 60 })).arrayBuffer());
    expect(a.equals(b)).toBe(false); // the rect has translated, so the PNGs differ
  });
});
