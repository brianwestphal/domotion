// DM-1665: the demos review server (tests/review-server.tsx) fetches CI results
// from GitHub on demand (~13s for metadata, longer for image shards). The bug this
// guards: selecting a CI source must NOT block the page render on that gh fetch —
// the page renders immediately with `sourceFetchNeeded`, and the client fetches
// behind a loading overlay via /api/refresh-source. This test spawns the server
// with a deliberately SLOW, failing `gh` on PATH and asserts the `/` route stays
// fast (would be ≥5s if someone re-introduced the blocking fetch).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = resolve(fileURLToPath(import.meta.url), "..", "review-server.tsx");
const PORT = 4396;
const BASE = `http://localhost:${PORT}`;

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("review server did not start in time");
}

describe("review-server async loading (DM-1665)", () => {
  let proc: ChildProcess;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "review-e2e-"));
    // ci-macos present-but-empty → source selectable, 0 fixtures → sourceFetchNeeded.
    const ciBase = join(tmp, "review");
    mkdirSync(join(ciBase, "ci-macos", "html-test-unicode"), { recursive: true });
    const localOut = join(tmp, "local");
    mkdirSync(localOut, { recursive: true });
    // Fake `gh`: sleeps 5s then fails. If `/` blocked on it, the request would be ≥5s.
    const ghDir = join(tmp, "bin");
    mkdirSync(ghDir);
    const gh = join(ghDir, "gh");
    writeFileSync(gh, "#!/usr/bin/env bash\nsleep 5\nexit 1\n");
    chmodSync(gh, 0o755);

    proc = spawn("npx", ["tsx", SERVER, "--port", String(PORT)], {
      env: {
        ...process.env,
        PATH: `${ghDir}:${process.env.PATH}`,
        REVIEW_CI_BASE: ciBase,
        REVIEW_OUTPUT_DIR: localOut,
        REVIEW_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(35_000);
  }, 45_000);

  afterAll(() => {
    proc?.kill("SIGKILL");
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("renders a CI source immediately — never blocks the page on the (5s) gh fetch", async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/?source=ci-macos`);
    const ms = Date.now() - t0;
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(3000); // the regression: a blocking fetch would make this ≥5s
    expect(html).toContain('"sourceFetchNeeded":true'); // client will fetch behind the overlay
    expect(html).toContain('id="refresh-source"');      // the ↻ button is present
  });

  it("the local (non-CI) source also renders promptly and never needs a fetch", async () => {
    const res = await fetch(`${BASE}/?source=local-macos`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('"sourceFetchNeeded":false');
  });

  it("exposes /api/refresh-source and degrades gracefully when gh fails", async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/refresh-source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "ci-macos" }),
    });
    const ms = Date.now() - t0;
    const j = await res.json() as { ok: boolean; fixtures?: number };
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);        // gh failure is caught, not thrown
    expect(j.fixtures).toBe(0);     // no run resolved → empty, no crash
    expect(ms).toBeGreaterThan(3500); // it DID invoke the slow gh (unlike `/`)
  }, 25_000);

  it("returns 404 (not a hang) for an uncached image with no run pointer", async () => {
    const res = await fetch(`${BASE}/img/ci-macos/html-test-unicode/nope-expected.png`);
    expect(res.status).toBe(404);
  });
});
