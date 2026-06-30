import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startScrubberServer, type ScrubberServerHandle } from "../src/scrubber/server.js";
import { closeSafely } from "../src/test-support/close-browser-safely.js";

/**
 * DM-1449: `svg-scrubber --review` can attach the current frame as a sibling PNG
 * next to the `.ticket`. This exercises the real Chromium render path in the
 * `/ticket` endpoint (no UI — POSTs directly).
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80">
<rect width="120" height="80" fill="#0b1220"/><circle cx="60" cy="40" r="24" fill="#22d3ee"/></svg>`;

const env = await (async () => {
  try { return { browser: await chromium.launch() }; } catch { return null; }
})();
const dir = mkdtempSync(join(tmpdir(), "scrubber-frame-attach-"));
let srv: ScrubberServerHandle | null = null;

afterAll(async () => {
  if (srv) await closeSafely(() => srv!.close(), env?.browser ?? null, 6_000);
  else await (env?.browser?.close().catch(() => {}) ?? Promise.resolve());
  rmSync(dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("svg-scrubber review frame attachment (DM-1449)", () => {
  it("renders the current frame to a sibling PNG and references it in the .ticket", async () => {
    srv = await startScrubberServer({
      review: true, ticketDir: dir,
      launchBrowser: async () => (env as { browser: Browser }).browser,
    });
    const res = await fetch(srv.url.replace(/\/$/, "") + "/ticket", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Circle looks off", svgName: "blip", frameTimeMs: 0, rangeStartMs: 0, rangeEndMs: 0,
        regions: [{ x: 36, y: 16, w: 48, h: 48 }],
        attachFrame: true, svg: SVG,
      }),
    });
    expect(res.status).toBe(200);
    const { path, framePng } = await res.json() as { path: string; framePng: string | null };

    // The sibling PNG was written next to the ticket, with the same slug+stamp.
    expect(framePng).not.toBeNull();
    expect(framePng!.endsWith(".png")).toBe(true);
    const pngs = readdirSync(dir).filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBe(1);
    const png = readFileSync(framePng!);
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n"); // PNG magic

    // The ticket JSON references the PNG + the region, and the slugs match.
    const ticket = JSON.parse(readFileSync(path, "utf-8"));
    expect(ticket.framePng).toBe(framePng);
    expect(ticket.regions).toEqual([{ x: 36, y: 16, w: 48, h: 48 }]);
    expect(path.replace(/\.ticket$/, "")).toBe(framePng!.replace(/\.png$/, ""));
  }, 60_000);
});
