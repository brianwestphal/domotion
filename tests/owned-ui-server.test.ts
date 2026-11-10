import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { startOwnedUiServer, OwnedUiServerError, type OwnedUiServer } from "./owned-ui-server.js";
import { reviewServerPort } from "./review-server-options.js";

const active = new Set<OwnedUiServer>();
const observations: Array<Record<string, unknown>> = [];
const evidenceDir = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "owned-ui-server");
function record(value: Record<string, unknown>) {
  observations.push(value);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, "observations.json"),
    JSON.stringify({ node: process.version, platform: process.platform, observations }, null, 2),
  );
}
async function ownedServer(...args: Parameters<typeof startOwnedUiServer>) {
  try {
    const handle = await startOwnedUiServer(...args);
    active.add(handle);
    return handle;
  } catch (error) {
    if (error instanceof OwnedUiServerError) record({ failure: error.reason, diagnostics: error.diagnostics });
    throw error;
  }
}
afterEach(async () => {
  const handles = [...active];
  active.clear();
  const results = await Promise.allSettled(
    handles.map(async (handle) => {
      const wasStopped = handle.diagnostics().stopRequested;
      try {
        await handle.close();
      } catch (error) {
        if (!wasStopped || !handle.diagnostics().closed) throw error;
      }
      record({ closed: handle.diagnostics() });
    }),
  );
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Owned control cleanup failed");
});
const root = mkdtempSync(join(tmpdir(), "domotion-owned-ui-"));
const script = join(root, "control.mjs");
writeFileSync(
  script,
  `import {createServer} from 'node:http';
import{existsSync}from'node:fs';
const mode=process.argv[2],trigger=process.argv[3];
if(mode==='exit'){console.error('controlled early exit');process.exit(17)}
if(mode==='timeout'){console.log('waiting without readiness');setInterval(()=>{},1000)}
else{
 const server=createServer((_q,r)=>r.end('control'));
 process.on('SIGTERM',()=>{if(mode==='bad-stop')process.exit(24);if(mode!=='ignore-stop'&&mode!=='disconnect-ignore')server.close(()=>process.exit(0))});
 server.listen(0,'127.0.0.1',()=>{
 if(mode==='overflow'){process.stdout.write('stdout-prefix\\n'+'A'.repeat(100000)+'\\nstdout-tail\\n');process.stderr.write('stderr-prefix\\n'+'B'.repeat(100000)+'\\nstderr-tail\\n')}
 const announce=()=>{if(mode==='overflow')process.stdout.write('stdout-tail\\n');process.stdout.write('http://127.0.0.1:');setTimeout(()=>process.stdout.write(server.address().port+'/\\n'),20)};
 if(mode==='overflow'){process.stdout.write(' '.repeat(100000)+'http://127.0.0.1:1/');setTimeout(()=>{process.stdout.write('\\n');announce()},20)}else announce();
 });
 if(trigger){const poll=setInterval(()=>{if(existsSync(trigger)){clearInterval(poll);if(mode==='disconnect'||mode==='disconnect-ignore')process.disconnect();else process.exit(23)}},20);poll.unref()}
}`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "features-results.json"),
    JSON.stringify({ suite: "features", results: [{ name, pass: true, diffPct: 0 }] }),
  );
  return dir;
}
async function review(dir: string, args = ["--port", "0"]) {
  return ownedServer("tests/review-server.tsx", args, { env: { REVIEW_NO_OPEN: "1", REVIEW_OUTPUT_DIR: dir } });
}
it("preserves the human default and admits OS-assigned port zero", () => {
  expect(reviewServerPort([])).toBe(4175);
  expect(reviewServerPort(["--port", "0"])).toBe(0);
  expect(reviewServerPort(["--port", "12345"])).toBe(12345);
}, 75_000);
it("isolates two simultaneous actual review fixtures and awaits both closed ports", async () => {
  const handles: OwnedUiServer[] = [];
  try {
    const results = await Promise.allSettled([
      review(fixture("first-owned-fixture")),
      review(fixture("second-owned-fixture")),
    ]);
    for (const result of results) if (result.status === "fulfilled") handles.push(result.value);
    const failures = results.filter((r) => r.status === "rejected");
    record({
      concurrent: results.map((result) =>
        result.status === "fulfilled"
          ? { url: result.value.url, diagnostics: result.value.diagnostics() }
          : { error: result.reason instanceof OwnedUiServerError ? result.reason.diagnostics : String(result.reason) },
      ),
    });
    if (failures.length > 0) throw failures[0]!.reason;
    expect(handles).toHaveLength(2);
    expect(handles[0]!.diagnostics().pid).not.toBe(handles[1]!.diagnostics().pid);
    expect(handles[0]!.url).not.toBe(handles[1]!.url);
    for (const [index, handle] of handles.entries()) {
      const response = await fetch(new URL("/?source=local-macos", handle.url));
      expect(response.ok).toBe(true);
      const html = await response.text();
      const payload = /<script[^>]*id="manifest-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(payload).toBeDefined();
      const data: unknown = JSON.parse(payload!);
      expect(handle.url).toBe(new URL(handle.url).origin);
      const invalid = await fetch(`${handle.url}/api/file-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(invalid.status).toBe(400);
      expect(data).toMatchObject({ tests: [{ name: index === 0 ? "first-owned-fixture" : "second-owned-fixture" }] });
      const snapshot = await handle.close();
      expect(snapshot.closed).toBe(true);
      expect(snapshot.exitCode).toBe(0);
      expect(snapshot.shutdownAcknowledged).toBe(true);
      expect(snapshot.escalated).toBe(false);
      await expect(fetch(handle.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    }
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}, 75_000);
it("retains actual bind failure without stopping the unrelated owner of the occupied port", async () => {
  const guardian = createServer((_req, res) => res.end("guardian alive"));
  await new Promise<void>((done) => guardian.listen(0, "127.0.0.1", done));
  const address = guardian.address();
  if (address == null || typeof address === "string") throw new Error("missing guardian port");
  try {
    await expect(review(fixture("occupied-fixture"), ["--port", String(address.port)])).rejects.toMatchObject({
      reason: "exited-before-ready",
      diagnostics: { closed: true, exitCode: 1, stderr: { text: expect.stringContaining("EADDRINUSE") } },
    });
    expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe("guardian alive");
  } finally {
    await new Promise<void>((done, reject) => guardian.close((error) => (error ? reject(error) : done())));
  }
}, 75_000);
it("retains bounded prefix/tail output, split-line readiness and idempotent observed close", async () => {
  const handle = await ownedServer(script, ["overflow"]);
  try {
    expect(new URL(handle.url).port).not.toBe("0");
    expect(await (await fetch(handle.url)).text()).toBe("control");
    const d = await handle.close();
    for (const log of [d.stdout, d.stderr]) {
      expect(log.totalBytes).toBeGreaterThan(32768);
      expect(log.retainedBytes).toBeLessThanOrEqual(32768);
      expect(log.truncated).toBe(true);
    }
    expect(d.stdout.text).toContain("stdout-prefix");
    expect(d.stdout.text).toContain("stdout-tail");
    expect(d.stderr.text).toContain("stderr-prefix");
    expect(d.stderr.text).toContain("stderr-tail");
    const a = await handle.close(),
      b = await handle.close();
    expect(a).toEqual(b);
    expect(a.closed).toBe(true);
  } finally {
    await handle.close();
  }
}, 75_000);
it("reports spawn error only after observed cleanup", async () => {
  await expect(
    ownedServer(script, [], { nodeExecutable: join(root, "missing-node-executable") }),
  ).rejects.toMatchObject({
    reason: "spawn-error",
    diagnostics: { closed: true, spawnError: expect.stringContaining("ENOENT") },
  });
}, 75_000);
it("retains early stderr/exit code and the original timeout reason after cleanup", async () => {
  await expect(ownedServer(script, ["exit"])).rejects.toMatchObject({
    reason: "exited-before-ready",
    diagnostics: { closed: true, exitCode: 17, stderr: { text: expect.stringContaining("controlled early exit") } },
  });
  await expect(ownedServer(script, ["timeout"], { startupTimeoutMs: 200 })).rejects.toMatchObject({
    reason: "startup-timeout",
    diagnostics: { closed: true, stopRequested: true },
  });
}, 75_000);
it("reports forced cleanup as failure while still awaiting the owned process close", async () => {
  const handle = await ownedServer(script, ["ignore-stop"], { shutdownGraceMs: 100, shutdownForceMs: 1000 });
  await expect(handle.close()).rejects.toMatchObject({
    reason: "graceful-cleanup-failed",
    diagnostics: { closed: true, escalated: true },
  });
  await expect(fetch(handle.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
});
it("reports a failing requested shutdown after observing close and released socket", async () => {
  const handle = await ownedServer(script, ["bad-stop"]);
  await expect(handle.close()).rejects.toMatchObject({
    reason: "shutdown-exit-failed",
    diagnostics: { closed: true, exitCode: 24, shutdownAcknowledged: true },
  });
  await expect(fetch(handle.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
});
it("bounds owner-disconnect cleanup even when the application shutdown handler hangs", async () => {
  const trigger = join(root, "disconnect-ignore.trigger");
  const handle = await ownedServer(script, ["disconnect-ignore", trigger]);
  writeFileSync(trigger, "stop");
  await expect.poll(() => handle.diagnostics().closed, { timeout: 10_000 }).toBe(true);
  await expect(handle.close()).rejects.toMatchObject({
    reason: "exited-before-cleanup",
    diagnostics: { closed: true, exitCode: 1 },
  });
  await expect(fetch(handle.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}, 75_000);
it.each(["exit-late", "disconnect"])(
  "observes %s lifetime loss and releases its owned socket",
  async (mode) => {
    const trigger = join(root, `${mode}.trigger`);
    const handle = await ownedServer(script, [mode, trigger]);
    writeFileSync(trigger, "stop");
    await expect.poll(() => handle.diagnostics().closed, { timeout: 6000 }).toBe(true);
    await expect(handle.close()).rejects.toMatchObject({
      reason: "exited-before-cleanup",
      diagnostics: { closed: true },
    });
    await expect(fetch(handle.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  },
  75_000,
);
