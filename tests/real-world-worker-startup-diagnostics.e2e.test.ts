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
import { cdpBounded, FlatCdp } from "./real-world-cdp.js";
import { sharedWorkerBootstrapFor } from "./real-world-shared-worker-bootstrap.js";
import {
  FIXTURE_COOKIE,
  StartupFixtureJournal,
  startupFixtureScript,
  fixtureError,
  rethrowWithFixtureEvidence,
  closeFixtureOwner,
  type FixtureMode,
  type FixtureContext,
} from "./real-world-worker-fixture-evidence.js";
import { WEBGL_FIXTURE_LAUNCH_ARGS } from "../src/test-support/webgl-fixture-launch.js";

let server: Server;
let origin: string;
let mode: FixtureMode = "healthy";
const journal = new StartupFixtureJournal();
const pageRows = new WeakMap<Page, FixtureContext>();
const failureFiles: string[] = [];
let sourceHashes: Record<string, string> = {};
let persistenceSequence = 0;
let activePages: Page[] = [];
let droppedObservations = 0;
let owner: Awaited<ReturnType<typeof openRealWorldBrowser>>;
const observations: Array<{
  label: string;
  processId: number;
  browserVersion: string;
  diagnostic: WorkerStartupDiagnostic;
  contextId?: number;
}> = [];
function record(label: string, diagnostic: WorkerStartupDiagnostic, page?: Page): void {
  if (observations.length >= 128) {
    droppedObservations++;
    return;
  }
  observations.push({
    label,
    processId: owner.processId,
    browserVersion: owner.browser.version(),
    diagnostic,
    contextId: page == null ? undefined : pageRows.get(page)?.id,
  });
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
    const servedMode = mode;
    const body =
      request.url === "/worker.js"
        ? startupFixtureScript(servedMode)
        : "<!doctype html><body>synthetic startup diagnostics</body>";
    const fact = request.url === "/worker.js" ? journal.response(request.headers.cookie, servedMode, body) : undefined;
    if (fact != null) {
      response.once("finish", () => {
        fact.serverFinished = true;
      });
      response.once("close", () => {
        fact.connectionClosed = true;
      });
    }
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  const files = [
    "real-world-worker-startup-diagnostics.ts",
    "real-world-worker-startup-diagnostics.e2e.test.ts",
    "real-world-shared-worker-bootstrap.e2e.test.ts",
    "real-world-worker-fixture-evidence.ts",
  ];
  sourceHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        "tests/" + file,
        createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
});
beforeEach(async () => {
  mode = "healthy";
  activePages = [];
  owner = await openRealWorldBrowser(() => undefined, {
    args: [...WEBGL_FIXTURE_LAUNCH_ARGS],
    diagnosticCase: `real-world-worker-startup-diagnostics.e2e.test.ts > ${expect.getState().currentTestName ?? ""}`,
  });
});
afterEach(async (test) => {
  vi.restoreAllMocks();
  if (test.task.result?.state === "fail") {
    const primary = test.task.result.errors?.[0];
    for (const page of activePages) {
      const row = pageRows.get(page);
      if (row != null && row.construction !== "not_started" && row.failure == null)
        await retainFailure(page, "test", primary).catch(() => undefined);
    }
  }
  if (owner != null)
    await closeFixtureOwner(
      () => owner.close(),
      test.task.result?.state === "fail",
      (confirmed) => journal.closed(owner.processId, confirmed),
    );
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await writeEvidence(`native-${process.pid}.json`);
});
function evidenceDirectory(): string {
  return join(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "worker-bootstrap", "diagnostics");
}
async function writeEvidence(name: string): Promise<void> {
  const directory = evidenceDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, name),
    JSON.stringify(
      {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        sourceCommit: process.env["GITHUB_SHA"] ?? null,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        sourceHashes,
        observations,
        droppedObservations,
        ...journal.snapshot(),
        failureFiles,
      },
      null,
      2,
    ) + "\n",
  );
}
async function retainFailure(page: Page, stage: "construct" | "ready" | "test", original: unknown): Promise<never> {
  const row = pageRows.get(page);
  const failure = {
    stage,
    error: fixtureError(original),
    observedAt: new Date().toISOString(),
    capture: "pending" as const,
    persistence: "pending" as const,
  };
  if (row != null) row.failure = failure;
  return rethrowWithFixtureEvidence(
    original,
    failure,
    async () => {
      const statePromise = cdpBounded(
        page.evaluate(() => {
          const probe = (globalThis as Scope).probe;
          return {
            hasProbe: probe != null,
            reports: (probe?.reports ?? [])
              .slice(0, 8)
              .filter(
                (value) =>
                  Array.isArray(value) &&
                  value.length === 4 &&
                  value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
              ),
            error: probe?.error === "error" ? "error" : null,
          };
        }),
        500,
        "Fixture page failure state",
      ).catch(() => ({ unavailable: true }));
      const diagnostic = await collectWorkerStartupDiagnostic(page, identity());
      const state = await statePromise;
      record(`${row?.label ?? "unattributed"}:${stage}:failure`, diagnostic, page);
      return { state, diagnostic, nativeFunctionState: "unobserved" };
    },
    async () => {
      const name = `failure-${process.pid}-${row?.id ?? "unattributed"}-${++persistenceSequence}.json`;
      failureFiles.push(name);
      await writeEvidence(name);
    },
  );
}

async function page(label: string): Promise<Page> {
  const context = await owner.browser.newContext();
  const binding = journal.register(label, mode, owner.processId, owner.browser.version());
  if (binding != null)
    await context.addCookies([
      { name: FIXTURE_COOKIE, value: binding.token, url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
  const page = await context.newPage();
  if (binding != null) pageRows.set(page, binding.row);
  activePages.push(page);
  await page.goto(origin);
  return page;
}
async function construct(page: Page): Promise<void> {
  const row = pageRows.get(page);
  if (row != null) {
    row.construction = "started";
    row.modeAtConstruction = mode;
  }
  try {
    await page.evaluate(() => {
      const worker = new SharedWorker("/worker.js", { type: "module", name: "probe" });
      const state: State = ((globalThis as Scope).probe = { worker, reports: [], error: null });
      worker.onerror = (event) => {
        state.error = event.type;
      };
      worker.port.onmessage = (event) => state.reports.push(event.data);
      worker.port.start();
    });
    if (row != null) row.construction = "complete";
  } catch (error) {
    if (row != null) row.construction = "failed";
    await retainFailure(page, "construct", error);
  }
}
async function ready(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => (globalThis as Scope).probe.reports.length > 0, undefined, { timeout: 8000 });
  } catch (error) {
    if (pageRows.get(page)?.expectedMode === "healthy") return retainFailure(page, "ready", error);
    throw error;
  }
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
  const p = await page("healthy");
  await construct(p);
  await ready(p);
  expect(await targetAttached(p)).toBe(false);
  const result = await collectWorkerStartupDiagnostic(p, identity());
  record("healthy", result, p);
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
  expect(pageRows.get(p)?.failure).toBeUndefined();
  expect(pageRows.get(p)?.responses).toMatchObject([
    { servedMode: "healthy", modeMatchesClaim: true, serverFinished: true },
  ]);
});

it.each(["throw", "null"] as const)(
  "recovers silent native %s failure after the unchanged readiness deadline",
  async (failure) => {
    const foreign = await page("foreign healthy prerequisite");
    await construct(foreign);
    await ready(foreign);
    mode = failure;
    const p = await page("failure target");
    await silentFailure(p);
    const result = await collectWorkerStartupDiagnostic(p, identity());
    record(failure, result, p);
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
  const foreign = await page("foreign healthy prerequisite");
  await construct(foreign);
  await ready(foreign);
  mode = "throw";
  const p = await page("failure target");
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
    record(fault, result, p);
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
  const p = await page("failure target");
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
    record("retained-startup-wait", result, p);
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

it("retains an early healthy prerequisite failure with actual served bytes and the original deadline", async () => {
  const foreign = await page("foreign healthy prerequisite");
  await construct(foreign);
  await ready(foreign);
  const p = await page("controlled healthy prerequisite");
  mode = "null";
  await construct(p);
  const row = pageRows.get(p)!;
  await expect.poll(() => row.responses[0]?.serverFinished, { timeout: 1500 }).toBe(true);
  mode = "healthy";
  let original: unknown;
  try {
    await ready(p);
  } catch (error) {
    original = error;
  }
  expect(original).toBeInstanceOf(Error);
  expect((original as Error).name).toBe("TimeoutError");
  expect(row).toMatchObject({
    expectedMode: "healthy",
    modeAtConstruction: "null",
    construction: "complete",
    responses: [
      {
        servedMode: "null",
        modeMatchesClaim: true,
        bytes: Buffer.byteLength(startupFixtureScript("null")),
        sha256: createHash("sha256").update(startupFixtureScript("null")).digest("hex"),
        serverFinished: true,
      },
    ],
    failure: {
      stage: "ready",
      error: { name: "TimeoutError", detail: "page.waitForFunction: Timeout 8000ms exceeded." },
      capture: "complete",
      persistence: "written",
      evidence: {
        nativeFunctionState: "unobserved",
        diagnostic: {
          status: "complete",
          identity: {
            browserContextId: expect.any(String),
            pageTargetId: expect.any(String),
            workerTargetId: expect.any(String),
          },
          exceptions: [
            { name: "TypeError", detail: "TypeError: Cannot read properties of null (reading 'clearColor')" },
          ],
          cleanup: { child: "detached", page: "detached" },
        },
      },
    },
  });
  expect(pageRows.get(foreign)?.responses[0]?.servedMode).toBe("healthy");
  expect(mode).toBe("healthy");
  const retained = await readFile(join(evidenceDirectory(), failureFiles.at(-1)!), "utf8");
  expect(JSON.parse(retained).contexts).toContainEqual(
    expect.objectContaining({
      id: row.id,
      processId: owner.processId,
      responseAssociation: "authenticated-context-cookie",
      failure: expect.objectContaining({ stage: "ready" }),
    }),
  );
  for (const cookie of await p.context().cookies()) expect(retained).not.toContain(cookie.value);
  expect(retained).not.toContain(FIXTURE_COOKIE);
  expect(await targetAttached(p)).toBe(false);
  expect(await targetAttached(foreign)).toBe(false);
  await ping(foreign);
  await p.context().close();
  expect(p.isClosed()).toBe(true);
});
