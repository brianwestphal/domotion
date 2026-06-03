import { afterEach, describe, expect, it } from "vitest";
import { startScrubberServer, type ScrubberServerHandle } from "./server.js";

/**
 * DM-1065: boundary validation for the scrubber server's POST endpoints. These
 * run WITHOUT a real browser — validation happens before any Chromium work, so
 * we hand the server a `launchBrowser` that throws if it's ever reached. An
 * invalid body must be rejected (400) before the browser is touched; a
 * well-shaped body must pass validation and only THEN reach (and trip) the stub.
 * No Chromium ⇒ fast + immune to the e2e teardown flake (DM-1074).
 */

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10"/></svg>`;

describe("scrubber server: request-body validation (DM-1065)", () => {
  let srv: ScrubberServerHandle | null = null;
  let launched = false;

  const start = async (): Promise<ScrubberServerHandle> => {
    srv = await startScrubberServer({
      launchBrowser: async () => { launched = true; throw new Error("STUB: browser should not be launched for an invalid request"); },
    });
    return srv;
  };

  afterEach(async () => {
    if (srv) await srv.close(); // browser was never launched ⇒ closes only the http server
    srv = null;
    launched = false;
  });

  const post = (path: string, body: string) =>
    fetch(srv!.url.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("rejects malformed JSON with 400 (not 500) and never launches the browser", async () => {
    await start();
    const r = await post("/timing", "{ not json");
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid JSON/i);
    expect(launched).toBe(false);
  });

  it("rejects a missing/empty svg on every endpoint", async () => {
    await start();
    for (const [path, body] of [
      ["/timing", "{}"],
      ["/trim", JSON.stringify({ startMs: 0, endMs: 100, periodMs: 200 })],
      ["/export-frame", JSON.stringify({ timeMs: 0, width: 10, height: 10 })],
      ["/export-range-video", JSON.stringify({ startMs: 0, endMs: 100, width: 10, height: 10 })],
    ] as const) {
      const r = await post(path, body);
      expect(r.status, `${path} with no svg`).toBe(400);
    }
    expect(launched).toBe(false);
  });

  it("rejects non-finite / out-of-range numbers", async () => {
    await start();
    const cases: Array<[string, unknown]> = [
      ["/export-frame", { svg: VALID_SVG, timeMs: 0, width: -5, height: 10 }],          // negative dim
      ["/export-frame", { svg: VALID_SVG, timeMs: 0, width: 1e9, height: 10 }],          // absurd dim
      ["/export-frame", { svg: VALID_SVG, timeMs: -1, width: 10, height: 10 }],          // negative time
      ["/export-frame", { svg: VALID_SVG, timeMs: 0, width: "10", height: 10 }],         // wrong type
      ["/trim", { svg: VALID_SVG, startMs: 0, endMs: 100, periodMs: 0 }],                // periodMs must be > 0
      ["/trim", { svg: VALID_SVG, startMs: 0, endMs: 100, periodMs: Number.NaN }],       // NaN
    ];
    for (const [path, body] of cases) {
      const r = await post(path, JSON.stringify(body));
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(launched).toBe(false);
  });

  it("lets a well-shaped body PASS validation (only then does it reach the browser)", async () => {
    await start();
    // The stub throws once the browser is reached → a 500 whose message proves
    // validation passed and the request progressed past the boundary.
    const r = await post("/timing", JSON.stringify({ svg: VALID_SVG }));
    expect(r.status).toBe(500);
    expect((await r.json() as { error: string }).error).toMatch(/STUB/);
    expect(launched).toBe(true);
  });
});
