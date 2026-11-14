// DM-1665: the demos review server (tests/review-server.tsx) fetches CI results
// from GitHub on demand (~13s for metadata, longer for image shards). The bug this
// guards: selecting a CI source must NOT block the page render on that gh fetch —
// the page renders immediately with `sourceFetchNeeded`, and the client fetches
// behind a loading overlay via /api/refresh-source. This test spawns the server
// with a deliberately SLOW, failing `gh` on PATH and asserts the `/` route stays
// fast (would be ≥5s if someone re-introduced the blocking fetch).
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startOwnedUiServer, type OwnedUiServer } from "./owned-ui-server.js";

const SERVER = resolve(fileURLToPath(import.meta.url), "..", "review-server.tsx");
const FAKE_GH = resolve(fileURLToPath(import.meta.url), "..", "review-server-fake-gh.mjs");
// DM-W4BR21: OS-assigned ports and the owned Node service, not fixed ports and
// a detached npx→tsx chain killed by process group.
let PORT = 0;
let BASE = "";
const LINUX_CJK_FIXTURE = "4E00-9FFF-cjk-unified-ideographs.30";

function linuxCjkResult(diffPct = 0.595): Record<string, unknown> {
  return {
    name: LINUX_CJK_FIXTURE,
    pass: false,
    skipped: false,
    diffPct,
    textRunEvidence: {
      schemaVersion: 1,
      fixture: LINUX_CJK_FIXTURE,
      sourceAuthority: {
        chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
        harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
        skia: "62efacd3",
      },
      transitions: [],
      runs: [
        {
          fixture: LINUX_CJK_FIXTURE,
          row: 0,
          emitter: "embedded-font",
          sourceText: "U+6C94",
          sourceSpan: [0, 6],
          sourceCodepointSpan: [0, 6],
          emittedText: "U+6C94",
          mechanism: "system-resolver",
          request: { fontFamily: "monospace", fontWeight: 400, fontStretch: 100, fontSizePx: 12, direction: "ltr" },
          selected: {
            fontKey: "sysfb:WenQuanYiZenHeiMono",
            postscriptName: "WenQuanYiZenHeiMono",
            instantiatedPostscriptName: null,
            sourcePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            faceIndex: 1,
            variationAxes: null,
            shapesWithHarfbuzz: true,
          },
          glyphs: [
            {
              id: 44634,
              cluster: 0,
              sourceSpan: [0, 1],
              sourceCodepointSpan: [0, 1],
              xAdvance: 512,
              yAdvance: 0,
              xOffset: 0,
              yOffset: 0,
              sourceOutline: { sha256: "outline", commandCount: 17 },
            },
          ],
          emittedIdentity: "embedded-font:mono:44634",
          finalRepresentation: "embedded-font",
        },
      ],
    },
    embeddedFontBuilds: [
      {
        instanceKey: "mono#1",
        cssFamily: "dmf0",
        sourcePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        faceIndex: 1,
        variationAxes: null,
        selectedBuilder: "hb-subset",
        hintedSourceDisqualifiedReasons: [],
        retainedTableTags: ["glyf", "cvt "],
        retainedHintTableTags: ["cvt "],
        finalRepresentation: { kind: "embedded-sfnt", mime: "font/ttf", byteLength: 100, sha256: "hinted" },
        affectedGlyphCount: 1,
        affectedGlyphOccurrenceCount: 1,
        affectedRunCount: 1,
      },
    ],
  };
}

/** Put a `gh` on PATH that records its pid and `exec`s the owned Node fake, so
 * each server child is the recorded fake itself. Recording in the shim, before
 * Node starts, leaves no window in which a just-spawned fake is unrecorded.
 * Unix shim: the fixtures stay POSIX-only. */
function installFakeGh(tmp: string): { binDir: string; pids: string } {
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\necho $$ >> "$FAKE_GH_PIDS"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_GH)} "$@"\n`,
  );
  chmodSync(gh, 0o755);
  return { binDir, pids: join(tmp, "gh-pids.log") };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Every fake `gh` the server started must be gone shortly after the server
 * closed, on passing and failing paths alike. */
async function expectFakeGhReleased(pids: string, timeoutMs = 3_000): Promise<void> {
  const started = existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : [];
  const deadline = Date.now() + timeoutMs;
  let running = started.filter(alive);
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    running = running.filter(alive);
  }
  expect(running, `fake gh processes still running after server close (of ${started.length})`).toEqual([]);
}

async function startReviewServer(env: NodeJS.ProcessEnv, binDir: string, startupTimeoutMs: number) {
  const server = await startOwnedUiServer(SERVER, ["--port", "0"], {
    env: { ...env, PATH: `${binDir}${delimiter}${process.env.PATH}`, REVIEW_NO_OPEN: "1" },
    startupTimeoutMs,
  });
  return { server, base: server.url, port: Number(new URL(server.url).port) };
}

describe("review-server async loading (DM-1665)", () => {
  let server: OwnedUiServer | undefined;
  let tmp: string;
  let pids = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "review-e2e-"));
    // ci-macos present-but-empty → source selectable, 0 fixtures → sourceFetchNeeded.
    const ciBase = join(tmp, "review");
    mkdirSync(join(ciBase, "ci-macos", "html-test-unicode"), { recursive: true });
    const localOut = join(tmp, "local");
    mkdirSync(localOut, { recursive: true });
    const realWorldOut = join(localOut, "real-world");
    mkdirSync(realWorldOut);
    writeFileSync(
      join(realWorldOut, "results.json"),
      JSON.stringify({
        suite: "real-world",
        results: [{ name: "output-root-fixture", pass: true, coveragePct: 0, regionCount: 0 }],
      }),
    );
    writeFileSync(
      join(realWorldOut, "output-root-fixture-actual.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const unicodeOut = join(localOut, "html-test-unicode");
    mkdirSync(unicodeOut, { recursive: true });
    writeFileSync(join(unicodeOut, "results.json"), JSON.stringify([linuxCjkResult()]));
    writeFileSync(
      join(unicodeOut, "stage-evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-08-31T00:00:00Z",
        sourceRevision: "abc",
        platform: "linux",
        environmentFingerprint: { image: "noble" },
        reports: [
          { area: "text.font-selection", oracle: "font-selection", status: "failed", passedRows: 0, totalRows: 686 },
          { area: "text.shaping", oracle: "shaping", status: "failed", passedRows: 0, totalRows: 686 },
        ],
        rules: [
          {
            suites: ["html-test-unicode"],
            transitionIds: ["text.selection", "text.shape"],
            areas: ["text.font-selection", "text.shaping"],
          },
        ],
      }),
    );
    // Fake `gh`: sleeps 5s then fails. If `/` blocked on it, the request would be ≥5s.
    const fake = installFakeGh(tmp);
    pids = fake.pids;
    ({
      server,
      base: BASE,
      port: PORT,
    } = await startReviewServer(
      {
        FAKE_GH_MODE: "slow-fail",
        FAKE_GH_PIDS: pids,
        REVIEW_CI_BASE: ciBase,
        DOMOTION_OUTPUT_DIR: localOut,
        REVIEW_OUTPUT_DIR: "",
      },
      fake.binDir,
      35_000,
    ));
  }, 45_000);

  afterAll(async () => {
    try {
      await server?.close();
      if (pids !== "") await expectFakeGhReleased(pids);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders a CI source immediately — never blocks the page on the (5s) gh fetch", async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/?source=ci-macos`);
    const ms = Date.now() - t0;
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(3000); // the regression: a blocking fetch would make this ≥5s
    expect(html).toContain('"sourceFetchNeeded":true'); // client will fetch behind the overlay
    expect(html).toContain('id="refresh-source"'); // the ↻ button is present
  });

  it("the local (non-CI) source also renders promptly and never needs a fetch", async () => {
    const res = await fetch(`${BASE}/?source=local-macos`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('"sourceFetchNeeded":false');
  });

  it("reads real-world metadata and image bytes from the suite output override", async () => {
    const response = await fetch(`${BASE}/?source=local-macos`);
    expect(await response.text()).toContain('"name":"output-root-fixture"');
    const image = await fetch(`${BASE}/img/local-macos/real-world/output-root-fixture-actual.png`);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(
      readFileSync(join(tmp, "local/real-world/output-root-fixture-actual.png")),
    );
  });

  it("reports malformed results instead of silently showing an empty or stale source", async () => {
    const path = join(tmp, "local", "html-test-unicode", "results.json");
    const original = readFileSync(path);
    try {
      writeFileSync(path, "{malformed");
      const res = await fetch(`${BASE}/?source=local-macos`);
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(500);
      expect(body.error).toMatch(/Unexpected token|JSON/);
    } finally {
      writeFileSync(path, original);
    }
  });

  it("reports malformed CI source metadata instead of treating it as absent", async () => {
    const path = join(tmp, "review", "ci-macos", "html-test-unicode", ".ci-source.json");
    writeFileSync(path, "{malformed");
    try {
      const res = await fetch(`${BASE}/img/ci-macos/html-test-unicode/nope-expected.png`);
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(500);
      expect(body.error).toMatch(/Malformed CI source metadata/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("integrates exact Linux face-index-1 evidence under the 1% floor ahead of global failures", async () => {
    const res = await fetch(`${BASE}/?source=local-macos`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`"name":"${LINUX_CJK_FIXTURE}"`);
    expect(html).toContain('"scope":"fixture"');
    expect(html).toContain(
      '"area":"text.fixture-logical","oracle":"linux-unicode-fixture-provenance+mutation-matrix","status":"passed"',
    );
    expect(html).toContain('"supersededReports":[{"area":"text.font-selection"');
  });

  it("exposes /api/refresh-source and degrades gracefully when gh fails", async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/refresh-source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "ci-macos" }),
    });
    const ms = Date.now() - t0;
    const j = (await res.json()) as { ok: boolean; fixtures?: number };
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true); // gh failure is caught, not thrown
    expect(j.fixtures).toBe(0); // no run resolved → empty, no crash
    expect(ms).toBeGreaterThan(3500); // it DID invoke the slow gh (unlike `/`)
    // The fake recorded itself, so the afterAll release check is not vacuous.
    expect(readFileSync(pids, "utf8").trim()).not.toBe("");
  }, 25_000);

  // The harness's POST routes file Hot Sheet tickets and run `gh`; it must bind loopback only
  // and refuse cross-site / DNS-rebound requests with the shared `checkLocalRequest` guard.
  it("refuses a foreign Host, a cross-origin POST and a text/plain POST before routing", async () => {
    const raw = (method: string, path: string, headers: Record<string, string>, body = "") =>
      new Promise<{ status: number; body: string }>((resolveRequest, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolveRequest({ status: res.statusCode ?? 0, body: text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    const json = JSON.stringify({ source: "local", suite: "features", name: "x", comment: "", regions: [] });

    const rebound = await raw("GET", "/", { host: `evil.example:${PORT}` });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain("refused request for host");

    const crossOrigin = await raw(
      "POST",
      "/api/file-ticket",
      { host: `127.0.0.1:${PORT}`, origin: "https://evil.example", "content-type": "application/json" },
      json,
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).toContain("refused cross-origin request");

    const simple = await raw(
      "POST",
      "/api/file-ticket",
      { host: `127.0.0.1:${PORT}`, "content-type": "text/plain" },
      json,
    );
    expect(simple.status).toBe(415);

    // Same-origin control: the page's own Origin and JSON body reach the route (400 = route-level validation).
    const sameOrigin = await raw(
      "POST",
      "/api/file-ticket",
      { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, "content-type": "application/json" },
      json,
    );
    expect(sameOrigin.status).toBe(400);
  });

  it("listens on loopback only", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface != null && iface.family === "IPv4" && !iface.internal);
    if (lan == null) return; // no non-loopback IPv4 interface to probe on this host
    await expect(fetch(`http://${lan.address}:${PORT}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });

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
  let server: OwnedUiServer | undefined;
  let tmp: string;
  let counter: string;
  let release = "";
  let pids = "";
  let B2 = "";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "review-dedup-"));
    const ciBase = join(tmp, "review");
    const dir = join(ciBase, "ci-macos", "html-test-unicode");
    mkdirSync(dir, { recursive: true });
    // Seed metadata: 3 fixtures, all on shard 1, + the run pointer.
    writeFileSync(
      join(dir, "results.json"),
      JSON.stringify(["fxA", "fxB", "fxC"].map((name) => ({ name, pass: false, diffPct: 1, shard: 1 }))),
    );
    writeFileSync(join(dir, ".ci-source.json"), JSON.stringify({ runId: "123", os: "macos", suite: "unicode" }));
    mkdirSync(join(tmp, "local"), { recursive: true });
    counter = join(tmp, "gh-calls.log");
    release = join(tmp, "gh-release");
    // Fake gh: `run download` logs the call, then holds the "download" open
    // until the test creates the release file, then writes the shard's PNGs
    // into --dir; `run list` returns a matching run. Holding it on a file
    // instead of a fixed sleep makes "the server answers during a download"
    // a fact of the test rather than a race against machine load.
    const fake = installFakeGh(tmp);
    pids = fake.pids;
    ({ server, base: B2 } = await startReviewServer(
      {
        FAKE_GH_MODE: "held-download",
        FAKE_GH_PIDS: pids,
        FAKE_GH_COUNTER: counter,
        FAKE_GH_RELEASE: release,
        REVIEW_CI_BASE: ciBase,
        REVIEW_OUTPUT_DIR: join(tmp, "local"),
      },
      fake.binDir,
      90_000,
    ));
  }, 120_000);

  afterAll(async () => {
    try {
      // Release any download still held by a failed assertion before closing,
      // so the server's in-flight request and its fake gh both finish.
      if (release !== "" && existsSync(tmp)) writeFileSync(release, "");
      await server?.close();
      if (pids !== "") await expectFakeGhReleased(pids);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("collapses 9 concurrent same-shard image requests into ONE gh download, and stays responsive", async () => {
    // 3 fixtures × 3 kinds = 9 concurrent /img requests, ALL in shard 1.
    const urls = ["fxA", "fxB", "fxC"].flatMap((f) =>
      ["expected", "actual", "diff"].map((k) => `${B2}/img/ci-macos/html-test-unicode/${f}-${k}.png`),
    );
    const firstResponses = urls.map((url) => fetch(url));
    // Wait until the (held) download has actually started.
    while (!existsSync(counter)) await new Promise((r) => setTimeout(r, 25));
    // While it is held open, a plain page request must still be answered:
    // proof the event loop isn't blocked by the download.
    const page = await fetch(`${B2}/?source=local-macos`);
    expect(page.status).toBe(200);
    expect(existsSync(release)).toBe(false); // answered DURING the download
    // With the download still held, an image request outlasts the fast path.
    const held = await firstResponses[0];
    expect(held.status).toBe(503);
    expect(held.headers.get("retry-after")).not.toBeNull();
    writeFileSync(release, "");
    // A request outlasting the server's short fast path gets 503 + Retry-After
    // (the download continues in the background), and the client retries.
    // Follow that contract until every image is served rather than racing a
    // wall-clock budget: how many first responses beat the fast path depends
    // on machine load, not on the server's correctness.
    const served = await Promise.all(
      firstResponses.map(async (first, index) => {
        let res = await first;
        while (res.status === 503) {
          expect(res.headers.get("retry-after")).not.toBeNull();
          await res.arrayBuffer();
          await new Promise((r) => setTimeout(r, 100));
          res = await fetch(urls[index]);
        }
        return res.status;
      }),
    );
    expect(served.every((status) => status === 200)).toBe(true); // all 9 images served
    const downloads = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
    expect(downloads).toBe(1); // deduped: one download, not nine
    expect(readFileSync(pids, "utf8").trim()).not.toBe("");
  }, 60_000);
});
