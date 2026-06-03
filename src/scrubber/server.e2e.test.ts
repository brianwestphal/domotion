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

  it("/trim window-slices the period-spanning animation to the window", async () => {
    if (!chromiumAvailable) return;
    const r = await (await post("/trim", { svg: SVG, startMs: 500, endMs: 1500, periodMs: 2000 })).json() as
      { svg: string; slicedCss: number; shiftedCss: number };
    expect(r.slicedCss).toBe(1); // `m` (2s ≈ period, infinite) is period-spanning → sliced
    expect(r.svg).toContain("@keyframes m"); // kept (sliced in place)
    expect(r.svg).toMatch(/animation:\s*m 1s/); // duration → the 1s window
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

  it("/export-range-video rejects an empty range", async () => {
    if (!chromiumAvailable) return;
    const r = await post("/export-range-video", { svg: SVG, startMs: 500, endMs: 500, width: 100, height: 60 });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/empty range/);
  });

  it("/export-range-video renders the window to an MP4 (DM-1042)", async () => {
    if (!chromiumAvailable) return;
    // Needs ffmpeg; skip the body (not the assertion) when it isn't installed so
    // a CI box without ffmpeg stays green rather than failing.
    let hasFfmpeg = true;
    try { (await import("node:child_process")).execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]); }
    catch { hasFfmpeg = false; }
    if (!hasFfmpeg) return;
    const r = await post("/export-range-video", { svg: SVG, startMs: 0, endMs: 1000, width: 100, height: 60 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
    // ISO-BMFF: bytes 4..8 are the "ftyp" box type.
    expect(buf.slice(4, 8).toString("ascii")).toBe("ftyp");
  }, 60_000);

  // DM-1049: the loaded SVG must be centered in the stage (both axes) at Fit and
  // after Center — regression guard for the "vertically aligns to the top" bug
  // (a content-sized flex host top-pinned when taller than the stage).
  it("centers the loaded SVG in the stage, at Fit and after Center (DM-1049)", async () => {
    if (!chromiumAvailable) return;
    // A WIDE SVG so Fit leaves vertical slack — that's where the vertical-center
    // bug showed. Preload it via the bootstrap so the page has it on first paint.
    const wide = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" width="800" height="200"><rect width="800" height="200" fill="#2c8"/></svg>`;
    // A dedicated browser so the scoped server's close() (which closes the
    // browser it was handed) doesn't tear down the shared one used by the
    // sibling tests / afterAll.
    const b2 = await chromium.launch();
    const s2 = await startScrubberServer({ launchBrowser: async () => b2, initialSvg: wide, initialName: "wide.svg" });
    const ctx = await b2.newContext({ viewport: { width: 900, height: 600 } });
    const page = await ctx.newPage();
    try {
      await page.goto(s2.url, { waitUntil: "load" });
      await page.waitForSelector(".svg-host svg", { timeout: 10_000 });
      await page.waitForTimeout(400); // let Fit + ResizeObserver settle
      const centered = async () => page.evaluate(() => {
        const st = document.querySelector(".stage")!.getBoundingClientRect();
        const sv = document.querySelector(".svg-host svg")!.getBoundingClientRect();
        return {
          dy: Math.abs((sv.y + sv.height / 2) - (st.y + st.height / 2)),
          dx: Math.abs((sv.x + sv.width / 2) - (st.x + st.width / 2)),
          fitsH: sv.height <= st.height + 2,
        };
      });
      const fit = await centered();
      expect(fit.dy).toBeLessThan(3); // vertically centered (the reported bug)
      expect(fit.dx).toBeLessThan(3); // horizontally centered
      expect(fit.fitsH).toBe(true);   // Fit accounts for the footer (stage excludes it)
      // Pan away, then Center → centered again on both axes.
      await page.locator(".stage").hover();
      await page.mouse.wheel(80, 120);
      await page.locator("button[data-action=center]").click();
      await page.waitForTimeout(80);
      const after = await centered();
      expect(after.dy).toBeLessThan(3);
      expect(after.dx).toBeLessThan(3);
    } finally {
      await ctx.close();
      await s2.close();
    }
  }, 60_000);
});
