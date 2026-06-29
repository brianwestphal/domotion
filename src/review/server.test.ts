// DM-1433: the svg-review server must read its four snapshot assets once at
// startup and serve them from memory, so a file deleted/unreadable mid-session
// can't throw inside the request handler and crash the published `svg-review`
// process. Also: an unknown route returns 404, never an unhandled throw.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer, type ReviewServer } from "./server.js";

let srv: ReviewServer | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (srv) { await srv.close(); srv = null; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

function fixtureDir(): { expectedPng: string; actualPng: string; actualSvg: string; diffPng: string } {
  dir = mkdtempSync(join(tmpdir(), "review-srv-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
  const expectedPng = join(dir, "expected.png");
  const actualPng = join(dir, "actual.png");
  const actualSvg = join(dir, "actual.svg");
  const diffPng = join(dir, "diff.png");
  writeFileSync(expectedPng, png);
  writeFileSync(actualPng, png);
  writeFileSync(actualSvg, "<svg/>");
  writeFileSync(diffPng, png);
  return { expectedPng, actualPng, actualSvg, diffPng };
}

describe("startReviewServer", () => {
  it("keeps serving an asset after its source file is deleted mid-session", async () => {
    const f = fixtureDir();
    srv = await startReviewServer(f);

    const first = await fetch(new URL("/expected.png", srv.url));
    expect(first.status).toBe(200);

    // Delete the on-disk file mid-session; the cached buffer must still serve.
    rmSync(f.expectedPng, { force: true });

    const second = await fetch(new URL("/expected.png", srv.url));
    expect(second.status).toBe(200);
    expect((await second.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("returns 404 (not a crash) for an unknown route", async () => {
    srv = await startReviewServer(fixtureDir());
    const res = await fetch(new URL("/nope.png", srv.url));
    expect(res.status).toBe(404);
  });

  it("throws at startup if an asset is missing (fail fast, before listening)", async () => {
    const f = fixtureDir();
    rmSync(f.diffPng, { force: true });
    await expect(startReviewServer(f)).rejects.toThrow(/file not found/);
  });
});
