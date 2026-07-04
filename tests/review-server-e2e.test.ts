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

// DM-1667: the lazy image fetch used execFileSync, which blocked the event loop
// for the whole (65 MB) download and defeated the in-flight dedup. This proves
// the async fix: concurrent same-shard requests collapse to ONE `gh` download,
// and the server keeps serving other requests during it.
describe("review-server lazy fetch: dedup + non-blocking (DM-1667)", () => {
  let proc: ChildProcess;
  let tmp: string;
  let counter: string;
  const PORT2 = 4397;
  const B2 = `http://localhost:${PORT2}`;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "review-dedup-"));
    const ciBase = join(tmp, "review");
    const dir = join(ciBase, "ci-macos", "html-test-unicode");
    mkdirSync(dir, { recursive: true });
    // Seed metadata: 3 fixtures, all on shard 1, + the run pointer.
    writeFileSync(join(dir, "results.json"), JSON.stringify(
      ["fxA", "fxB", "fxC"].map((name) => ({ name, pass: false, diffPct: 1, shard: 1 }))));
    writeFileSync(join(dir, ".ci-source.json"), JSON.stringify({ runId: "123", os: "macos", suite: "unicode" }));
    mkdirSync(join(tmp, "local"), { recursive: true });
    counter = join(tmp, "gh-calls.log");
    // Fake gh: `run download` sleeps 1.5s (a "slow" download), logs the call, and
    // writes the shard's PNGs into --dir; `run list` returns a matching run.
    const ghDir = join(tmp, "bin");
    mkdirSync(ghDir);
    const gh = join(ghDir, "gh");
    writeFileSync(gh, [
      "#!/usr/bin/env bash",
      `if [ "$2" = "list" ]; then echo '[{"databaseId":123,"displayTitle":"Visual tests · unicode · os=all"}]'; exit 0; fi`,
      'd=""; p=""; while [ $# -gt 0 ]; do case "$1" in --dir) d="$2"; shift 2;; --pattern) p="$2"; shift 2;; *) shift;; esac; done',
      `echo "$p" >> "${counter}"`,
      "sleep 1.5",
      'mkdir -p "$d/$p"',
      'for f in fxA fxB fxC; do for k in expected actual diff; do printf PNG > "$d/$p/$f-$k.png"; done; done',
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(gh, 0o755);

    proc = spawn("npx", ["tsx", SERVER, "--port", String(PORT2)], {
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, REVIEW_CI_BASE: ciBase, REVIEW_OUTPUT_DIR: join(tmp, "local"), REVIEW_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${B2}/`); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 45_000);

  afterAll(() => {
    proc?.kill("SIGKILL");
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("collapses 9 concurrent same-shard image requests into ONE gh download, and stays responsive", async () => {
    // 3 fixtures × 3 kinds = 9 concurrent /img requests, ALL in shard 1.
    const imgReqs = ["fxA", "fxB", "fxC"].flatMap((f) =>
      ["expected", "actual", "diff"].map((k) => fetch(`${B2}/img/ci-macos/html-test-unicode/${f}-${k}.png`)));
    // While those download (1.5s), a plain page request must return quickly —
    // proof the event loop isn't blocked by the download.
    const t0 = Date.now();
    const page = await fetch(`${B2}/?source=local-macos`);
    const pageMs = Date.now() - t0;
    const imgs = await Promise.all(imgReqs);

    expect(page.status).toBe(200);
    expect(pageMs).toBeLessThan(800);                        // server stayed responsive
    expect(imgs.every((r) => r.status === 200)).toBe(true);  // all 9 images served
    const { readFileSync } = await import("node:fs");
    const downloads = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
    expect(downloads).toBe(1);                               // deduped: one download, not nine
  }, 20_000);
});
