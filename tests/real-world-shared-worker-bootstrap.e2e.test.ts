import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordBrowserFontEnvironment } from "../src/capture/image-font-hinting.js";
import { captureElementTree } from "../src/capture/index.js";
import { openRealWorldBrowser } from "./real-world-browser.js";
import { freezeWebGlOutput } from "./real-world-webgl-freeze.js";
import { cdpBounded, FlatCdp } from "./real-world-cdp.js";
import { sharedWorkerBootstrapFor } from "./real-world-shared-worker-bootstrap.js";
import { collectWorkerStartupDiagnostic } from "./real-world-worker-startup-diagnostics.js";
import type { WorkerFreezeCounters } from "./real-world-webgl-worker-lifecycle.js";
import { WEBGL_FIXTURE_LAUNCH_ARGS } from "../src/test-support/webgl-fixture-launch.js";

let server: Server;
let origin: string;
let owner: Awaited<ReturnType<typeof openRealWorldBrowser>>;
const leases = new Set<{ dispose(): Promise<void> }>();
let requests: Array<{ path: string; contentType: string; bodySha256: string; finished: boolean }> = [];
let startupEvidence: string[] = [];
interface StartupControlFacts {
  patchHook?: { installed: boolean; invocations: number };
  resumeRejection?: { installed: boolean; executed: boolean };
  bootstrapDisconnect?: { installed: boolean; executed: boolean };
}
let startupControls: StartupControlFacts = {};
let startupAcquisitions: Array<{ context: ReturnType<Page["context"]>; counters: WorkerFreezeCounters }> = [];
const pageErrors = new WeakMap<Page, string[]>();
interface Report {
  nativeInImport: boolean;
  nativeAtStart: boolean;
  nativeNow: boolean;
  pixel: number[];
  imported: string;
  origin: string;
  url: string;
  hardened: boolean;
  descendant?: Report;
  retained?: boolean;
  childError?: string;
}
interface Probe {
  reports: Report[];
  worker: SharedWorker | Worker;
  port: MessagePort | Worker;
  error?: string;
  errorEventType?: string;
  createdAt: number;
  errorAfterMs?: number;
  firstReportAfterMs?: number;
}
// DM-98KN22: after the unchanged 8000ms readiness timeout, keep observing for
// this long so a failure record can tell a late startup outcome from a lost one.
const LATE_OBSERVATION_MS = 10_000;
interface LateObservation {
  windowMs: number;
  outcome: "error" | "report" | "none";
}
type Scope = typeof globalThis & { dm34: Record<string, Probe> };
const patch = `(()=>{globalThis.__dm34OriginalClear??=Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype,'clear');Object.defineProperty(WebGL2RenderingContext.prototype,'clear',{value:function(){},writable:true,configurable:true});return true})()`;
const restore = `(()=>{if(globalThis.__dm34OriginalClear)Object.defineProperty(WebGL2RenderingContext.prototype,'clear',globalThis.__dm34OriginalClear);delete globalThis.__dm34OriginalClear;return true})()`;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-security-policy", "script-src 'self'; worker-src 'self'");
    const contentType = request.url?.endsWith(".js") ? "text/javascript" : "text/html";
    response.setHeader("content-type", contentType);
    const workerScript = `import{cachedClear,nativeInImport,imported}from'./relative.js';const nativeAtStart=WebGL2RenderingContext.prototype.clear.toString().includes('[native code]');function makeReport(){const gl=new OffscreenCanvas(1,1).getContext('webgl2',{preserveDrawingBuffer:true});gl.clearColor(1,0,0,1);cachedClear.call(gl,gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return {nativeInImport,nativeAtStart,nativeNow:gl.clear.toString().includes('[native code]'),pixel:Array.from(pixel),imported,origin:location.origin,url:location.pathname,hardened:Object.isFrozen(WebGL2RenderingContext.prototype),retained:globalThis.__domotionRealWorldWebGlFrozen?.failed===true};}function listen(p){p.onmessage=({data})=>{if(data.close){close();return;}if(data.spawnChild){try{const child=new Worker('/dedicated.js',{type:'module'});child.onmessage=e=>p.postMessage({...makeReport(),descendant:e.data});child.onerror=e=>p.postMessage({...makeReport(),childError:e.message});}catch(e){p.postMessage({...makeReport(),childError:String(e)});}return;}if(data.harden)Object.freeze(WebGL2RenderingContext.prototype);p.postMessage(makeReport());};p.start?.();p.postMessage(makeReport());}if('onconnect'in globalThis)onconnect=({ports:[p]})=>listen(p);else listen(globalThis);`;
    const body =
      request.url === "/relative.js"
        ? `export const cachedClear=WebGL2RenderingContext.prototype.clear;export const nativeInImport=cachedClear.toString().includes('[native code]');export const imported='relative-ok';`
        : request.url === "/worker.js" || request.url === "/dedicated.js"
          ? workerScript
          : "<!doctype html><body>worker fixture</body>";
    const fact = {
      path: (request.url ?? "").split("?")[0].slice(0, 128),
      contentType,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      finished: false,
    };
    if (requests.length < 64) requests.push(fact);
    response.once("finish", () => {
      fact.finished = true;
    });
    // DM-98KN22: the delayed invalid module lands after the 8000ms readiness
    // timeout but inside the late-observation window.
    if (request.url === "/late-missing-worker.js") setTimeout(() => response.end(body), 9000);
    else response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Worker fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  requests = [];
  startupEvidence = [];
  startupControls = {};
  startupAcquisitions = [];
  let recorded = false;
  owner = await openRealWorldBrowser(
    (browser, env) => {
      recordBrowserFontEnvironment(browser, env);
      recorded = true;
      expect(env["DOMOTION_BROKER_PROBE"]).toBe("yes");
    },
    {
      env: { ...process.env, DOMOTION_BROKER_PROBE: "yes" },
      args: [...WEBGL_FIXTURE_LAUNCH_ARGS],
      diagnosticCase: `real-world-shared-worker-bootstrap.e2e.test.ts > ${expect.getState().currentTestName ?? ""}`,
    },
  );
  expect(recorded).toBe(true);
});
afterEach(async () => {
  await Promise.allSettled([...leases].map((lease) => lease.dispose()));
  leases.clear();
  vi.restoreAllMocks();
  await owner?.close();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function page(): Promise<Page> {
  const context = await owner.browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error" && errors.length < 20) errors.push(message.text().slice(0, 512));
  });
  await page.goto(origin);
  return page;
}
async function acquire(page: Page, beforePatch?: () => Promise<void>) {
  if (beforePatch != null) {
    const observation = { installed: true, invocations: 0 };
    startupControls.patchHook = observation;
    const original = FlatCdp.prototype.command;
    vi.spyOn(FlatCdp.prototype, "command").mockImplementation(function (this: FlatCdp, method, params, sessionId) {
      if (method === "Runtime.evaluate" && params?.["expression"] === patch) {
        observation.invocations++;
        return beforePatch().then(() => original.call(this, method, params, sessionId));
      }
      return original.call(this, method, params, sessionId);
    });
  }
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  if (targetInfo.browserContextId == null) throw new Error("Capture context has no protocol identity");
  const bootstrap = sharedWorkerBootstrapFor(owner.browser);
  if (bootstrap == null) throw new Error("Missing managed startup owner");
  const counters = { frozenWorkers: 0, failedWorkers: 0, failedWorkerRestorations: 0 };
  let closed = false;
  page.context().once("close", () => {
    closed = true;
  });
  const lease = await bootstrap.acquire(targetInfo.browserContextId, { patch, restore }, counters, () => closed);
  startupAcquisitions.push({ context: page.context(), counters });
  leases.add(lease);
  return { lease, counters };
}
async function saveStartupFailure(
  page: Page,
  name: string,
  kind: string,
  phase: "error" | "timeout",
  scriptPath: string,
  lateObservation?: LateObservation,
): Promise<void> {
  // Capture actual hook/counter state before awaiting any failure diagnostics.
  const observedAt = new Date().toISOString();
  const controlFacts = structuredClone(startupControls);
  const bootstrapCounters = startupAcquisitions
    .filter((entry) => entry.context === page.context())
    .slice(0, 8)
    .map((entry) => ({ ...entry.counters }));
  const state = await cdpBounded(
    page.evaluate((name) => {
      const probe = (globalThis as Scope).dm34[name];
      return {
        reports: probe?.reports.length ?? 0,
        error: probe?.error ?? null,
        errorEventType: probe?.errorEventType ?? null,
        errorAfterMs: probe?.errorAfterMs ?? null,
        firstReportAfterMs: probe?.firstReportAfterMs ?? null,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      };
    }, name),
    500,
    "Worker startup diagnostic",
  ).catch(() => ({ unavailable: true }));
  const workerDiagnostic =
    kind === "shared"
      ? await collectWorkerStartupDiagnostic(page, { origin, name, scriptPath })
      : { status: "not_shared_worker" };
  const file = join(
    process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output",
    "worker-bootstrap",
    `startup-${process.pid}-${Date.now()}-${name.replace(/[^a-z0-9-]/gi, "_")}.json`,
  );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        schemaVersion: 2,
        observedAt,
        generatedAt: new Date().toISOString(),
        sourceCommit: process.env["GITHUB_SHA"] ?? null,
        platform: process.platform,
        arch: process.arch,
        browserVersion: owner.browser.version(),
        processId: owner.processId,
        name,
        kind,
        phase,
        state,
        lateObservation: lateObservation ?? null,
        controlFacts,
        bootstrapCounters,
        workerDiagnostic,
        requests,
        consoleErrors: pageErrors.get(page) ?? [],
      },
      null,
      2,
    ),
  );
  startupEvidence.push(file);
}
async function retainStartupFailure(
  page: Page,
  name: string,
  kind: string,
  phase: "error" | "timeout",
  scriptPath: string,
  lateObservation?: LateObservation,
): Promise<void> {
  try {
    await saveStartupFailure(page, name, kind, phase, scriptPath, lateObservation);
  } catch {
    console.warn("Worker startup failed; diagnostic evidence could not be written.");
  }
}
async function start(
  page: Page,
  name = "worker",
  kind: "shared" | "dedicated" = "shared",
  script?: string,
): Promise<Report> {
  await page.evaluate(
    ({ name, kind, script }) => {
      const scope = globalThis as Scope;
      scope.dm34 ??= {};
      const worker =
        kind === "shared"
          ? new SharedWorker(script ?? "/worker.js", { type: "module", name })
          : new Worker(script ?? "/dedicated.js", { type: "module" });
      const port = worker instanceof SharedWorker ? worker.port : worker;
      const probe: Probe = { worker, port, reports: [], createdAt: performance.now() };
      scope.dm34[name] = probe;
      worker.onerror = (event) => {
        probe.errorAfterMs ??= Math.round(performance.now() - probe.createdAt);
        // Chrome147 shared_worker_client.cc:48–89 dispatches plain Event for
        // fetch/parse failures; only runtime failures carry ErrorEvent.message.
        probe.errorEventType = event instanceof ErrorEvent ? "ErrorEvent" : "Event";
        probe.error = `${event.type} (${probe.errorEventType})${event.message ? `: ${event.message.slice(0, 512)}` : ""}`;
      };
      port.onmessageerror = () => {
        probe.error = "messageerror";
      };
      port.onmessage = ({ data }: MessageEvent<Report>) => {
        probe.firstReportAfterMs ??= Math.round(performance.now() - probe.createdAt);
        probe.reports.push(data);
      };
      if (port instanceof MessagePort) port.start();
    },
    { name, kind, script },
  );
  const settled = (timeout: number) =>
    page.waitForFunction(
      (name) => {
        const probe = (globalThis as Scope).dm34[name]!;
        return probe.reports.length > 0 || probe.error != null;
      },
      name,
      { timeout },
    );
  try {
    await settled(8000);
  } catch (error) {
    // Diagnostic only: the assertion still fails on the original timeout.
    const lateOutcome: LateObservation["outcome"] = await settled(LATE_OBSERVATION_MS)
      .then(() =>
        page.evaluate(
          (name): LateObservation["outcome"] => ((globalThis as Scope).dm34[name]!.error != null ? "error" : "report"),
          name,
        ),
      )
      .catch(() => "none");
    await retainStartupFailure(
      page,
      name,
      kind,
      "timeout",
      script ?? (kind === "shared" ? "/worker.js" : "/dedicated.js"),
      { windowMs: LATE_OBSERVATION_MS, outcome: lateOutcome },
    );
    throw error;
  }
  const error = await page.evaluate((name) => (globalThis as Scope).dm34[name]!.error, name);
  if (error != null) {
    await retainStartupFailure(
      page,
      name,
      kind,
      "error",
      script ?? (kind === "shared" ? "/worker.js" : "/dedicated.js"),
    );
    throw new Error(`Worker startup failed: ${error}`);
  }
  return (await latest(page, name))!;
}
const latest = (page: Page, name = "worker"): Promise<Report | undefined> =>
  page.evaluate((name) => (globalThis as Scope).dm34[name]!.reports.at(-1), name);
async function report(page: Page, message: Record<string, unknown> = {}, name = "worker"): Promise<Report> {
  const count = await page.evaluate((name) => (globalThis as Scope).dm34[name]!.reports.length, name);
  await page.evaluate(({ name, message }) => (globalThis as Scope).dm34[name]!.port.postMessage(message), {
    name,
    message,
  });
  await page.waitForFunction(({ name, count }) => (globalThis as Scope).dm34[name]!.reports.length > count, {
    name,
    count,
  });
  return (await latest(page, name))!;
}

describe("owned SharedWorker startup through public CDP (DM-34WC46)", () => {
  it("reports native generic module-load errors instead of waiting for readiness", async () => {
    const p = await page();
    const freeze = await freezeWebGlOutput(p);
    leases.add(freeze);
    // The fixture returns HTML under a JavaScript MIME type at this path.
    // Blink dispatches a plain Event for the resulting module parse failure.
    await expect(start(p, "invalid-module", "shared", "/missing-worker.js")).rejects.toThrow("Worker startup failed");
    const file = startupEvidence.at(-1);
    expect(file).toBeDefined();
    const evidence = JSON.parse(await readFile(file!, "utf8")) as {
      phase: string;
      state: { errorEventType: string; reports: number };
      requests: Array<{ path: string; contentType: string; finished: boolean }>;
    };
    expect(evidence.phase).toBe("error");
    expect(evidence.state).toMatchObject({ errorEventType: "Event", reports: 0 });
    expect(evidence.requests).toContainEqual(
      expect.objectContaining({ path: "/missing-worker.js", contentType: "text/javascript", finished: true }),
    );
  });
  it.each([false, true])("persists observed resume-hook execution with bootstrap acquired=%s", async (acquired) => {
    const observation = { installed: true, executed: false };
    startupControls.resumeRejection = observation;
    const original = FlatCdp.prototype.command;
    vi.spyOn(FlatCdp.prototype, "command").mockImplementation(function (this: FlatCdp, method, params, sessionId) {
      if (method === "Runtime.runIfWaitingForDebugger" && !observation.executed) {
        observation.executed = true;
        return Promise.reject(new Error("controlled resume rejection"));
      }
      return original.call(this, method, params, sessionId);
    });
    const p = await page();
    if (acquired) await acquire(p);
    await expect(start(p, "invalid-module", "shared", "/missing-worker.js")).rejects.toThrow("Worker startup failed");
    const evidence = JSON.parse(await readFile(startupEvidence.at(-1)!, "utf8")) as {
      schemaVersion: number;
      controlFacts: StartupControlFacts;
      bootstrapCounters: WorkerFreezeCounters[];
      workerDiagnostic: { cleanup: { page: string } };
    };
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.controlFacts.resumeRejection).toEqual({ installed: true, executed: acquired });
    expect(evidence.bootstrapCounters).toEqual(
      acquired ? [{ frozenWorkers: 0, failedWorkers: 1, failedWorkerRestorations: 0 }] : [],
    );
    expect(evidence.workerDiagnostic.cleanup.page).toBe("detached");
  });
  it("preserves the original startup error when diagnostic session creation fails", async () => {
    const p = await page();
    vi.spyOn(p.context(), "newCDPSession").mockRejectedValue(new Error("controlled diagnostic creation rejection"));
    await expect(start(p, "invalid-module", "shared", "/missing-worker.js")).rejects.toThrow(
      "Worker startup failed: error (Event)",
    );
    const evidence = JSON.parse(await readFile(startupEvidence.at(-1)!, "utf8")) as {
      workerDiagnostic: { status: string; failureStage: string };
    };
    expect(evidence.workerDiagnostic).toMatchObject({ status: "unavailable", failureStage: "create_page_session" });
  });
  it("records a startup outcome that arrives after the readiness timeout", async () => {
    const p = await page();
    await expect(start(p, "late-module", "shared", "/late-missing-worker.js")).rejects.toThrow(
      "page.waitForFunction: Timeout 8000ms",
    );
    const evidence = JSON.parse(await readFile(startupEvidence.at(-1)!, "utf8")) as {
      phase: string;
      state: { error: string | null; errorAfterMs: number | null };
      lateObservation: { windowMs: number; outcome: string };
    };
    expect(evidence.phase).toBe("timeout");
    expect(evidence.lateObservation).toEqual({ windowMs: 10_000, outcome: "error" });
    expect(evidence.state.error).toBe("error (Event)");
    expect(evidence.state.errorAfterMs).toBeGreaterThanOrEqual(8000);
  });
  it("preserves the original startup error when diagnostic artifact I/O fails", async () => {
    const p = await page();
    const directory = await mkdtemp(join(tmpdir(), "dm-startup-io-"));
    const blocker = join(directory, "file");
    await writeFile(blocker, "controlled non-directory");
    const previous = process.env["DOMOTION_OUTPUT_DIR"];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env["DOMOTION_OUTPUT_DIR"] = blocker;
    try {
      await expect(start(p, "invalid-module", "shared", "/missing-worker.js")).rejects.toThrow(
        "Worker startup failed: error (Event)",
      );
      expect(warning).toHaveBeenCalledWith("Worker startup failed; diagnostic evidence could not be written.");
    } finally {
      if (previous === undefined) delete process.env["DOMOTION_OUTPUT_DIR"];
      else process.env["DOMOTION_OUTPUT_DIR"] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("preserves default headless-shell and patches before delayed imports/cached native clear", async () => {
    const p = await page();
    let debuggingPipeRetained = false;
    const session = await owner.browser.newBrowserCDPSession();
    try {
      const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
      expect(args[0]?.replaceAll("\\", "/").split("/").at(-1)).toMatch(
        /^(?:chrome[-_]headless[-_]shell|headless_shell)(?:\.exe)?$/,
      );
      expect(args.includes("--remote-debugging-port=0")).toBe(true);
      debuggingPipeRetained = args.includes("--remote-debugging-pipe");
      expect(debuggingPipeRetained).toBe(true);
    } finally {
      await session.detach();
    }
    const { lease, counters } = await acquire(p, () => new Promise((resolve) => setTimeout(resolve, 100)));
    const observedStartup = await start(p);
    expect(observedStartup).toMatchObject({
      nativeInImport: false,
      nativeAtStart: false,
      nativeNow: false,
      pixel: [0, 0, 0, 0],
      imported: "relative-ok",
      origin,
      url: "/worker.js",
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        path: "/worker.js",
        bodySha256: "42a15bbf4470defc1494c8d62eebf6550a176453b3c5a444ef40cc5b295045e3",
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        path: "/relative.js",
        bodySha256: "18fb0922269b23d5bad275642ec3e7dda7086046641414415bff17106c57cc26",
      }),
    );
    expect(counters).toEqual({ frozenWorkers: 1, failedWorkers: 0, failedWorkerRestorations: 0 });
    const evidencePath = process.env["DOMOTION_WORKER_BOOTSTRAP_EVIDENCE"];
    if (evidencePath != null) {
      const session = await owner.browser.newBrowserCDPSession();
      try {
        const browser = await session.send("Browser.getVersion");
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(
          evidencePath,
          JSON.stringify(
            {
              schemaVersion: 1,
              profile: "worker-bootstrap-only",
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              sourceCommit: process.env["GITHUB_SHA"],
              browser: {
                product: browser.product,
                revision: browser.revision,
                protocolVersion: browser.protocolVersion,
              },
              launch: { provenance: "public-launchServer-scout", scoutLaunches: 1, debuggingPipeRetained },
              startup: {
                nativeInImport: observedStartup.nativeInImport,
                nativeAtStart: observedStartup.nativeAtStart,
                nativeNow: observedStartup.nativeNow,
                pixel: observedStartup.pixel,
              },
            },
            null,
            2,
          ),
        );
      } finally {
        await session.detach();
      }
    }
    await lease.dispose();
    expect((await report(p)).nativeNow).toBe(true);
    expect(counters.failedWorkerRestorations).toBe(0);
  });
  it("resumes unrelated contexts without patching or retaining their startup clients", async () => {
    const owned = await page(),
      other = await page();
    const { counters } = await acquire(owned);
    expect(await start(other, "foreign")).toMatchObject({
      nativeInImport: true,
      nativeAtStart: true,
      nativeNow: true,
      pixel: [255, 0, 0, 255],
    });
    expect(await start(owned)).toMatchObject({ nativeInImport: false, nativeAtStart: false, pixel: [0, 0, 0, 0] });
    expect(counters).toEqual({ frozenWorkers: 1, failedWorkers: 0, failedWorkerRestorations: 0 });
  });
  it("releases terminated hosts so same-name restart is patched before imports", async () => {
    const p = await page();
    const { counters } = await acquire(p);
    await start(p);
    const observer = await owner.browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await observer.send("Target.getTargets");
      const worker = targetInfos.find(
        (target) => target.type === "shared_worker" && target.url === `${origin}/worker.js`,
      );
      expect(worker).toBeDefined();
      await p.evaluate(() => (globalThis as Scope).dm34["worker"]!.port.postMessage({ close: true }));
      await expect
        .poll(async () =>
          (await observer.send("Target.getTargets")).targetInfos.some(
            (target) => target.targetId === worker!.targetId && target.attached,
          ),
        )
        .toBe(false);
      expect(await start(p)).toMatchObject({ nativeInImport: false, nativeAtStart: false, pixel: [0, 0, 0, 0] });
      expect(counters.frozenWorkers).toBe(2);
      expect(counters.failedWorkers).toBe(0);
    } finally {
      await observer.detach();
    }
  });
  it("resumes/detaches after failed setup instead of stranding startup", async () => {
    const p = await page();
    const { counters } = await acquire(p, async () => {
      throw new Error("controlled setup failure");
    });
    expect(await start(p)).toMatchObject({
      nativeInImport: true,
      nativeAtStart: true,
      nativeNow: true,
      pixel: [255, 0, 0, 255],
    });
    expect(counters.frozenWorkers).toBe(0);
    expect(counters.failedWorkers).toBe(1);
  });
  it("restores and detaches after a rejected resume so cached native progress remains honest", async () => {
    let injected = false;
    const observation = { installed: true, executed: false };
    startupControls.resumeRejection = observation;
    const original = FlatCdp.prototype.command;
    vi.spyOn(FlatCdp.prototype, "command").mockImplementation(function (this: FlatCdp, method, params, sessionId) {
      if (method === "Runtime.runIfWaitingForDebugger" && !injected) {
        injected = true;
        observation.executed = true;
        return Promise.reject(new Error("controlled resume rejection"));
      }
      return original.call(this, method, params, sessionId);
    });
    const p = await page();
    const { counters } = await acquire(p);
    expect(await start(p)).toMatchObject({
      nativeInImport: true,
      nativeAtStart: true,
      nativeNow: true,
      pixel: [255, 0, 0, 255],
    });
    expect(injected).toBe(true);
    expect(counters).toEqual({ frozenWorkers: 0, failedWorkers: 1, failedWorkerRestorations: 0 });
  });
  it("reports a lost startup client and lets Chromium release its pause", async () => {
    let injected = false;
    const observation = { installed: true, executed: false };
    startupControls.bootstrapDisconnect = observation;
    const original = FlatCdp.prototype.command;
    vi.spyOn(FlatCdp.prototype, "command").mockImplementation(function (this: FlatCdp, method, params, sessionId) {
      if (!injected && method === "Runtime.evaluate" && params?.["expression"] === patch) {
        injected = true;
        observation.executed = true;
        return this.close().then(() => {
          throw new Error("controlled bootstrap disconnect");
        });
      }
      return original.call(this, method, params, sessionId);
    });
    const p = await page();
    const { counters } = await acquire(p);
    expect(await start(p)).toMatchObject({
      nativeInImport: true,
      nativeAtStart: true,
      nativeNow: true,
      pixel: [255, 0, 0, 255],
    });
    expect(injected).toBe(true);
    expect(counters.frozenWorkers).toBe(0);
    expect(counters.failedWorkers).toBe(1);
    await expect(acquire(p)).rejects.toThrow("bootstrap connection unavailable");
  });

  it("reports failed restoration while preserving the original descriptor in the live worker", async () => {
    const p = await page();
    const { lease, counters } = await acquire(p);
    await start(p);
    expect((await report(p, { harden: true })).hardened).toBe(true);
    await lease.dispose();
    expect(counters.failedWorkerRestorations).toBe(1);
    expect((await report(p)).nativeNow).toBe(false);
  });
  it("preserves the connected Browser environment record for actual image capture", async () => {
    const p = await page();
    const svg =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>',
      );
    await p.setContent(`<body style="background:white"><img width="20" height="20" src="${svg}"></body>`);
    await p.setViewportSize({ width: 100, height: 100 });
    const tree = await captureElementTree(p, "body", { x: 0, y: 0, width: 100, height: 100 });
    const stack = [...tree];
    let found = false;
    while (stack.length > 0) {
      const element = stack.pop()!;
      stack.push(...element.children);
      if (element.imageSrc == null) continue;
      found = true;
      if (process.platform === "linux")
        expect(element.imageDocumentFontRendering).toMatchObject({
          source: "shared-fontconfig-v1",
          singleProcess: false,
          deviceScaleFactor: 1,
        });
      else expect(element.imageDocumentFontRendering).toBeUndefined();
    }
    expect(found).toBe(true);
  });

  it("uses production freeze ownership and retains a same-context second owner", async () => {
    const first = await page();
    const second = await first.context().newPage();
    await second.goto(origin);
    const a = await freezeWebGlOutput(first),
      b = await freezeWebGlOutput(second);
    leases.add(a);
    leases.add(b);
    expect(await start(first)).toMatchObject({ nativeInImport: false, nativeAtStart: false, pixel: [0, 0, 0, 0] });
    expect(a.failedWorkers + b.failedWorkers).toBe(0);
    expect(a.frozenWorkers + b.frozenWorkers).toBe(2);
    await a.dispose();
    expect((await report(first)).nativeNow).toBe(false);
    await b.dispose();
    expect((await report(first)).nativeNow).toBe(true);
    expect(a.failedWorkerRestorations + b.failedWorkerRestorations).toBe(0);
  });
  it("preserves nested dedicated worker interception alongside managed SharedWorkers", async () => {
    const p = await page();
    const freeze = await freezeWebGlOutput(p);
    leases.add(freeze);
    await start(p);
    expect(await start(p, "dedicated", "dedicated")).toMatchObject({ nativeInImport: false, nativeAtStart: false });
    await p.evaluate(() => (globalThis as Scope).dm34["dedicated"]!.port.postMessage({ spawnChild: true }));
    await expect
      .poll(async () => {
        const last = await latest(p, "dedicated");
        if (last?.childError != null) throw new Error(last.childError);
        return last?.descendant;
      })
      .toMatchObject({
        nativeInImport: false,
        nativeAtStart: false,
        nativeNow: false,
        pixel: [0, 0, 0, 0],
        imported: "relative-ok",
        url: "/dedicated.js",
      });
    expect(freeze.failedWorkers).toBe(0);
    expect(freeze.frozenWorkers).toBe(3);
  });
  it("retains production restoration evidence when a managed worker hardens its prototype", async () => {
    const p = await page();
    const freeze = await freezeWebGlOutput(p);
    leases.add(freeze);
    await start(p);
    expect((await report(p, { harden: true })).hardened).toBe(true);
    await freeze.dispose();
    expect(freeze.failedWorkerRestorations).toBe(1);
    expect(await report(p)).toMatchObject({ nativeNow: false, retained: true });
  });
  it("cleans production ownership after context close during initialization", async () => {
    const p = await page();
    const pending = freezeWebGlOutput(p);
    await p.context().close();
    const freeze = await pending;
    leases.add(freeze);
    await freeze.dispose();
    const other = await page();
    expect(await start(other, "after-close")).toMatchObject({
      nativeInImport: true,
      nativeAtStart: true,
      nativeNow: true,
      pixel: [255, 0, 0, 255],
    });
  });

  it("closes the exact owned process and unregisters signal listeners idempotently", async () => {
    const counts = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
    await owner.close();
    await owner.close();
    expect(sharedWorkerBootstrapFor(owner.browser)).toBeUndefined();
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal))).toEqual(
      counts.map((count) => count - 1),
    );
    expect(() => process.kill(owner.processId, 0)).toThrow();
  });
});
