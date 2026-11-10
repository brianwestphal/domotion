import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openRealWorldBrowser } from "./real-world-browser.js";
import {
  collectWorkerStartupDiagnostic,
  type WorkerStartupDiagnostic,
} from "./real-world-worker-startup-diagnostics.js";
import { FlatCdp } from "./real-world-cdp.js";
import { sharedWorkerBootstrapFor } from "./real-world-shared-worker-bootstrap.js";

let server: Server;
let origin: string;
let mode: "healthy" | "throw" | "null" = "healthy";
let owner: Awaited<ReturnType<typeof openRealWorldBrowser>>;
const observations: Array<{
  label: string;
  processId: number;
  browserVersion: string;
  diagnostic: WorkerStartupDiagnostic;
}> = [];
function record(label: string, diagnostic: WorkerStartupDiagnostic): void {
  observations.push({ label, processId: owner.processId, browserVersion: owner.browser.version(), diagnostic });
}
const identity = () => ({ origin, scriptPath: "/worker.js", name: "probe" });
interface State {
  worker: SharedWorker;
  reports: number[][];
  error: string | null;
}
type Scope = typeof globalThis & { probe: State };

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-security-policy", "script-src 'self'; worker-src 'self'");
    response.setHeader("content-type", request.url === "/worker.js" ? "text/javascript" : "text/html");
    const draw = `const canvas=new OffscreenCanvas(1,1);${mode === "null" ? "canvas.getContext('2d');" : ""}const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);port.onmessage=()=>port.postMessage(Array.from(pixel));port.start();port.postMessage(Array.from(pixel));`;
    response.end(
      request.url === "/worker.js"
        ? `onconnect=({ports:[port]})=>{${mode === "throw" ? "throw new Error('controlled onconnect throw');" : draw}};`
        : "<!doctype html><body>synthetic startup diagnostics</body>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  mode = "healthy";
  owner = await openRealWorldBrowser(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await owner?.close();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const directory = join(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "worker-bootstrap", "diagnostics");
  await mkdir(directory, { recursive: true });
  const files = [
    "real-world-worker-startup-diagnostics.ts",
    "real-world-worker-startup-diagnostics.e2e.test.ts",
    "real-world-shared-worker-bootstrap.e2e.test.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        "tests/" + file,
        createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    join(directory, `native-${process.pid}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sourceCommit: process.env["GITHUB_SHA"] ?? null,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        sourceHashes,
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

async function page(): Promise<Page> {
  const context = await owner.browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  return page;
}
async function construct(page: Page): Promise<void> {
  await page.evaluate(() => {
    const worker = new SharedWorker("/worker.js", { type: "module", name: "probe" });
    const state: State = ((globalThis as Scope).probe = { worker, reports: [], error: null });
    worker.onerror = (event) => {
      state.error = event.type;
    };
    worker.port.onmessage = (event) => state.reports.push(event.data);
    worker.port.start();
  });
}
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (globalThis as Scope).probe.reports.length > 0, undefined, { timeout: 8000 });
}
async function silentFailure(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await construct(page);
  let original: Error | undefined;
  try {
    await ready(page);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    original = error;
  }
  expect(original?.name).toBe("TimeoutError");
  expect(
    await page.evaluate(() => ({
      reports: (globalThis as Scope).probe.reports,
      error: (globalThis as Scope).probe.error,
    })),
  ).toEqual({ reports: [], error: null });
  expect(errors).toEqual([]);
}
async function targetAttached(page: Page): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  try {
    const own = await session.send("Target.getTargetInfo");
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find(
      (target) =>
        target.type === "shared_worker" &&
        target.url === origin + "/worker.js" &&
        target.browserContextId === own.targetInfo.browserContextId,
    );
    expect(target).toBeDefined();
    return target!.attached;
  } finally {
    await session.detach();
  }
}
async function ping(page: Page): Promise<void> {
  const before = await page.evaluate(() => {
    const state = (globalThis as Scope).probe;
    const before = state.reports.length;
    state.worker.port.postMessage("ping");
    return before;
  });
  await page.waitForFunction((before) => (globalThis as Scope).probe.reports.length > before, before, {
    timeout: 8000,
  });
  expect(await page.evaluate(() => (globalThis as Scope).probe.reports.at(-1))).toEqual([255, 0, 0, 255]);
}

it("replays no false exception on a healthy native worker and detaches", async () => {
  const p = await page();
  await construct(p);
  await ready(p);
  expect(await targetAttached(p)).toBe(false);
  const result = await collectWorkerStartupDiagnostic(p, identity());
  record("healthy", result);
  expect(result).toMatchObject({
    status: "complete",
    exceptions: [],
    target: {
      attachedBeforeInspection: false,
      diagnosticAttachmentWaitingForDebugger: false,
      globalDebuggerPause: "unobserved",
    },
    cleanup: { child: "detached", page: "detached" },
  });
  expect(await targetAttached(p)).toBe(false);
  await ping(p);
});

it.each(["throw", "null"] as const)(
  "recovers silent native %s failure after the unchanged readiness deadline",
  async (failure) => {
    const foreign = await page();
    await construct(foreign);
    await ready(foreign);
    mode = failure;
    const p = await page();
    await silentFailure(p);
    const result = await collectWorkerStartupDiagnostic(p, identity());
    record(failure, result);
    expect(result).toMatchObject({
      status: "complete",
      exceptions: [
        {
          name: failure === "null" ? "TypeError" : "Error",
          detail:
            failure === "null"
              ? "TypeError: Cannot read properties of null (reading 'clearColor')"
              : "Error: controlled onconnect throw",
          path: "/worker.js",
        },
      ],
      cleanup: { child: "detached", page: "detached" },
    });
    expect(await targetAttached(p)).toBe(false);
    expect(await targetAttached(foreign)).toBe(false);
    await ping(foreign);
  },
);

it("bounds real protocol failures and releases an acknowledged or late worker attachment", async () => {
  const foreign = await page();
  await construct(foreign);
  await ready(foreign);
  mode = "throw";
  const p = await page();
  await silentFailure(p);
  for (const fault of ["attach", "enable", "detach", "late-attach"] as const) {
    let release: (() => void) | undefined;
    const session = await p.context().newCDPSession(p);
    const send = session.send.bind(session);
    vi.spyOn(session, "send").mockImplementation((async (method, params) => {
      if (fault === "attach" && method === "Target.attachToTarget") throw new Error("controlled attach rejection");
      if (
        fault === "enable" &&
        method === "Target.sendMessageToTarget" &&
        JSON.stringify(params).includes("Runtime.enable")
      )
        throw new Error("controlled enable rejection");
      if (fault === "detach" && method === "Target.detachFromTarget") throw new Error("controlled detach rejection");
      const reply = await send(method, params);
      if (fault === "late-attach" && method === "Target.attachToTarget")
        return new Promise((resolve) => {
          release = () => resolve(reply);
        });
      return reply;
    }) as CDPSession["send"]);
    const result = await collectWorkerStartupDiagnostic(p, identity(), {
      createSession: async () => session,
    });
    record(fault, result);
    release?.();
    if (fault === "detach")
      expect(result).toMatchObject({ status: "complete", cleanup: { child: "unavailable", page: "detached" } });
    else expect(result.status).toBe("unavailable");
    expect(await targetAttached(p)).toBe(false);
    expect(await targetAttached(foreign)).toBe(false);
    await ping(foreign);
  }
});

it("does not release another client's verified startup wait while inspecting failure evidence", async () => {
  const p = await page();
  const pageSession = await p.context().newCDPSession(p);
  const { targetInfo } = await pageSession.send("Target.getTargetInfo");
  await pageSession.detach();
  expect(targetInfo.browserContextId).toBeDefined();
  const bootstrap = sharedWorkerBootstrapFor(owner.browser);
  expect(bootstrap).toBeDefined();
  const patch = "true/*XWB controlled startup barrier*/";
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attached!: () => void;
  const attachment = new Promise<void>((resolve) => {
    attached = resolve;
  });
  const command = FlatCdp.prototype.command;
  vi.spyOn(FlatCdp.prototype, "command").mockImplementation(function (this: FlatCdp, method, params, sessionId) {
    if (method === "Runtime.evaluate" && params?.["expression"] === patch) {
      attached();
      return barrier.then(() => command.call(this, method, params, sessionId));
    }
    return command.call(this, method, params, sessionId);
  });
  const lease = await bootstrap!.acquire(
    targetInfo.browserContextId!,
    { patch, restore: "true" },
    { frozenWorkers: 0, failedWorkers: 0, failedWorkerRestorations: 0 },
    () => false,
  );
  try {
    await construct(p);
    await attachment;
    const result = await collectWorkerStartupDiagnostic(p, identity());
    record("retained-startup-wait", result);
    expect(result.status).toBe("complete");
    expect(result.target?.globalDebuggerPause).toBe("unobserved");
    expect(await pageState(p)).toEqual({ reports: [], error: null });
    release();
    await ready(p);
    await ping(p);
  } finally {
    release();
    await lease.dispose();
  }
});

async function pageState(page: Page) {
  return page.evaluate(() => ({
    reports: (globalThis as Scope).probe.reports,
    error: (globalThis as Scope).probe.error,
  }));
}
