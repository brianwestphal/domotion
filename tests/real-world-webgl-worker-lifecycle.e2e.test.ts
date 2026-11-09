import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeWebGlOutput as startFreeze } from "./real-world-webgl-freeze.js";

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://worker.test").pathname;
    const body =
      path === "/relative.js"
        ? `export const imported='relative-module-ok';export const cachedClear=WebGL2RenderingContext.prototype.clear;export const nativeInImport=cachedClear.toString().includes('[native code]');`
        : path.endsWith(".js")
          ? WORKER_SCRIPT
          : "<!doctype html><body style='margin:0;background:white'></body>";
    response.writeHead(200, {
      "content-type": path.endsWith(".js") ? "text/javascript" : "text/html",
      "content-security-policy": "script-src 'self'; worker-src 'self'",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("HTTP worker fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const activeFreezes = new Set<Awaited<ReturnType<typeof startFreeze>>>();
async function freezeWebGlOutput(page: Page): ReturnType<typeof startFreeze> {
  const result = await startFreeze(page);
  activeFreezes.add(result);
  return result;
}
afterEach(async () => {
  await Promise.all([...activeFreezes].map((freeze) => freeze.dispose()));
  activeFreezes.clear();
});

const WORKER_SCRIPT = `import { imported, nativeInImport, cachedClear } from './relative.js';
const nativeAtStart=WebGL2RenderingContext.prototype.clear.toString().includes('[native code]');
function listen(port) {
  let color=[1,0,0],timer,useCached=false;
  port.onmessage=({data})=>{
    if(data.color) color=data.color;
    if(data.lock)Object.freeze(WebGL2RenderingContext.prototype);
    if(data.useCached)useCached=true;
    if(data.canvas){
      const gl=data.canvas.getContext('webgl2',{preserveDrawingBuffer:true});
      if(!gl){port.postMessage({error:'WebGL2 unavailable'});return;}
      let tick=0;
      timer=setInterval(()=>{
        gl.clearColor(...color,1);if(useCached)cachedClear.call(gl,gl.COLOR_BUFFER_BIT);else gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        port.postMessage({pixel:Array.from(pixel),tick:++tick,imported,nativeAtStart,nativeInImport,nativeNow:gl.clear.toString().includes('[native code]'),retained:globalThis.__domotionRealWorldWebGlFrozen?.failed===true,locked:Object.isFrozen(WebGL2RenderingContext.prototype)});
      },20);
    }
    if(data.stop)clearInterval(timer);
    if(data.close)globalThis.close();
  };
  port.start?.();
}
if('onconnect' in globalThis) onconnect=({ports})=>listen(ports[0]);
else listen(globalThis);`;

interface Report {
  pixel: number[];
  tick: number;
  imported: string;
  nativeAtStart: boolean;
  nativeInImport: boolean;
  nativeNow: boolean;
  retained?: boolean;
  locked?: boolean;
  error?: string;
}
interface Probe {
  events: Report[];
  error?: string;
  port: Worker | MessagePort;
  worker: Worker | SharedWorker;
}
type ProbeScope = typeof globalThis & { workerProbes: Record<string, Probe> };

async function routedContext(): Promise<BrowserContext> {
  const context = await browser.newContext();
  return context;
}
async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  return page;
}
async function startWorker(page: Page, kind: "worker" | "shared", name: string): Promise<void> {
  await page.evaluate(
    ({ kind, name }) => {
      const scope = globalThis as ProbeScope;
      scope.workerProbes ??= {};
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 40;
      document.body.append(canvas);
      const worker =
        kind === "worker"
          ? new Worker("/worker.js", { type: "module" })
          : new SharedWorker("/shared.js", { type: "module", name });
      const port = worker instanceof SharedWorker ? worker.port : worker;
      const state: Probe = { events: [], port, worker };
      scope.workerProbes[name] = state;
      worker.onerror = (event) => {
        state.error = event.message;
      };
      port.onmessage = ({ data }: MessageEvent<Report>) => {
        if (data.error) state.error = data.error;
        else {
          state.events.push(data);
          if (state.events.length > 50) state.events.shift();
        }
      };
      if (port instanceof MessagePort) port.start();
      const offscreen = canvas.transferControlToOffscreen();
      port.postMessage({ canvas: offscreen }, [offscreen]);
    },
    { kind, name },
  );
  await page.waitForFunction(
    (name) => {
      const state = (globalThis as ProbeScope).workerProbes[name];
      return state.events.length > 0 || state.error != null;
    },
    name,
    { timeout: 8000 },
  );
  expect(await page.evaluate((name) => (globalThis as ProbeScope).workerProbes[name].error, name)).toBeUndefined();
}
const latest = (page: Page, name: string): Promise<Report | undefined> =>
  page.evaluate((name) => (globalThis as ProbeScope).workerProbes[name].events.at(-1), name);

function delaySecondaryAttachment() {
  const original = browser.newBrowserCDPSession.bind(browser);
  const spy = vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
    const session = await original();
    const forward = session.send.bind(session) as (method: string, params?: unknown) => Promise<unknown>;
    // Exercise slow command attachment while Playwright resumes independently.
    // Dedicated startup stays paused; SharedWorker startup can escape.
    vi.spyOn(session, "send").mockImplementation((async (method: string, params?: unknown) => {
      if (method === "Target.attachToTarget") await new Promise((resolve) => setTimeout(resolve, 100));
      return forward(method, params);
    }) as CDPSession["send"]);
    return session;
  });
  return spy;
}

describe("real-world worker WebGL lifecycle (DM-S9S3WG)", () => {
  it.each(["worker", "shared"] as const)("reports and retains failed %s restoration (DM-2XDPSR)", async (kind) => {
    const context = await routedContext();
    const page = await openPage(context);
    try {
      await startWorker(page, kind, "hardened");
      const freeze = await freezeWebGlOutput(page);
      await expect.poll(async () => (await latest(page, "hardened"))?.nativeNow).toBe(false);
      await page.evaluate(() => (globalThis as ProbeScope).workerProbes["hardened"]!.port.postMessage({ lock: true }));
      await expect.poll(async () => (await latest(page, "hardened"))?.locked).toBe(true);
      await freeze.dispose();
      expect(freeze.failedWorkerRestorations).toBe(1);
      expect(freeze.failedFrameRestorations).toBe(0);
      await expect.poll(async () => (await latest(page, "hardened"))?.retained).toBe(true);
      expect((await latest(page, "hardened"))?.nativeNow).toBe(false);
    } finally {
      await context.close();
    }
  });

  it.each(["exception", "reject"] as const)("reports %s during live worker restoration", async (mode) => {
    let restoring = false;
    let injected = false;
    const original = browser.newBrowserCDPSession.bind(browser);
    const spy = vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
      const session = await original();
      const forward = session.send.bind(session) as (method: string, params?: unknown) => Promise<unknown>;
      vi.spyOn(session, "send").mockImplementation(((method: string, params?: Record<string, unknown>) => {
        if (restoring && !injected && method === "Target.sendMessageToTarget" && typeof params?.message === "string") {
          const payload = JSON.parse(params.message) as { id: number; method: string };
          if (payload.method === "Runtime.evaluate") {
            injected = true;
            if (mode === "reject") return Promise.reject(new Error("controlled restoration rejection"));
            // Preserve a real protocol reply carrying Runtime exceptionDetails.
            return forward(method, {
              ...params,
              message: JSON.stringify({
                ...payload,
                params: {
                  expression: "(()=>{throw new Error('controlled restoration exception')})()",
                  returnByValue: true,
                },
              }),
            });
          }
        }
        return forward(method, params);
      }) as CDPSession["send"]);
      return session;
    });
    const context = await routedContext();
    const page = await openPage(context);
    try {
      await startWorker(page, "worker", "restore-error");
      const freeze = await freezeWebGlOutput(page);
      await expect.poll(async () => (await latest(page, "restore-error"))?.nativeNow).toBe(false);
      restoring = true;
      await freeze.dispose();
      expect(injected).toBe(true);
      expect(freeze.failedWorkerRestorations).toBe(1);
      expect(freeze.failedWorkers).toBe(0);
      expect((await latest(page, "restore-error"))?.nativeNow).toBe(false);
    } finally {
      await context.close();
      spy.mockRestore();
    }
  });

  it("reports and retains failed frame restoration (DM-2XDPSR)", async () => {
    const context = await routedContext();
    const page = await openPage(context);
    try {
      const freeze = await freezeWebGlOutput(page);
      await page.evaluate(() => Object.freeze(WebGL2RenderingContext.prototype));
      await freeze.dispose();
      expect(freeze.failedFrameRestorations).toBe(1);
      expect(freeze.failedWorkerRestorations).toBe(0);
      expect(
        await page.evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            __domotionRealWorldWebGlFrozen?: { failed: boolean; owners: string[]; entries: unknown[] };
          };
          const state = scope.__domotionRealWorldWebGlFrozen;
          return state?.failed === true && state.owners.length > 0 && state.entries.length > 0;
        }),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it.each(["worker"] as const)(
    "patches a late %s before module imports or first drawing, then restores it",
    async (kind) => {
      const spy = delaySecondaryAttachment();
      const context = await routedContext();
      const page = await openPage(context);
      try {
        const freeze = await freezeWebGlOutput(page);
        await startWorker(page, kind, "late");
        await expect
          .poll(() => latest(page, "late"))
          .toMatchObject({
            pixel: [0, 0, 0, 0],
            nativeAtStart: false,
            nativeInImport: false,
            nativeNow: false,
            imported: "relative-module-ok",
          });
        const before = (await latest(page, "late"))!.tick;
        await expect.poll(async () => (await latest(page, "late"))!.tick).toBeGreaterThan(before);
        expect(freeze.frozenWorkers).toBe(1);
        expect(freeze.failedWorkers).toBe(0);
        await freeze.dispose();
        expect(freeze.failedWorkerRestorations).toBe(0);
        expect(freeze.failedFrameRestorations).toBe(0);
        await expect.poll(async () => (await latest(page, "late"))!.pixel).toEqual([255, 0, 0, 255]);
        expect((await latest(page, "late"))!.nativeNow).toBe(true);
        expect(await page.evaluate(() => WebGL2RenderingContext.prototype.clear.toString())).toContain("[native code]");
        await startWorker(page, kind, "after-dispose");
        expect(await latest(page, "after-dispose")).toMatchObject({
          nativeAtStart: true,
          nativeInImport: true,
          pixel: [255, 0, 0, 255],
        });
      } finally {
        await context.close();
        spy.mockRestore();
      }
    },
  );

  it("reports late SharedWorker bootstrap escape rather than counting it fully frozen", async () => {
    const spy = delaySecondaryAttachment();
    const context = await routedContext();
    const page = await openPage(context);
    try {
      const freeze = await freezeWebGlOutput(page);
      await startWorker(page, "shared", "escape");
      await expect.poll(() => freeze.failedWorkers).toBe(1);
      await expect
        .poll(() => latest(page, "escape"))
        .toMatchObject({
          nativeAtStart: true,
          nativeInImport: true,
          nativeNow: false,
          pixel: [255, 0, 0, 255],
        });
      expect(freeze.frozenWorkers).toBe(0);
      await page.evaluate(() =>
        (globalThis as ProbeScope).workerProbes.escape.port.postMessage({ useCached: true, color: [0, 0, 1] }),
      );
      await expect.poll(async () => (await latest(page, "escape"))!.pixel).toEqual([0, 0, 255, 255]);
      await freeze.dispose();
      await expect.poll(async () => (await latest(page, "escape"))!.nativeNow).toBe(true);
    } finally {
      await context.close();
      spy.mockRestore();
    }
  });

  it("freezes an existing SharedWorker and leaves other contexts running", async () => {
    const context = await routedContext(),
      other = await routedContext();
    const page = await openPage(context),
      unrelated = await openPage(other);
    try {
      await startWorker(page, "shared", "existing");
      expect((await latest(page, "existing"))!.pixel).toEqual([255, 0, 0, 255]);
      const freeze = await freezeWebGlOutput(page);
      await page.evaluate(() =>
        (globalThis as ProbeScope).workerProbes.existing.port.postMessage({ color: [0, 0, 1] }),
      );
      await expect.poll(async () => (await latest(page, "existing"))!.nativeNow).toBe(false);
      expect((await latest(page, "existing"))!.pixel).toEqual([255, 0, 0, 255]);
      for (const kind of ["worker", "shared"] as const) {
        await startWorker(unrelated, kind, `other-${kind}`);
        expect(await latest(unrelated, `other-${kind}`)).toMatchObject({
          nativeAtStart: true,
          nativeInImport: true,
          nativeNow: true,
          pixel: [255, 0, 0, 255],
        });
      }
      expect(freeze.frozenWorkers).toBe(1);
      expect(freeze.failedWorkers).toBe(0);
      await freeze.dispose();
      await expect.poll(async () => (await latest(page, "existing"))!.pixel).toEqual([0, 0, 255, 255]);
    } finally {
      await Promise.all([context.close(), other.close()]);
    }
  });

  it("keeps a context-shared worker frozen until both page owners dispose", async () => {
    const context = await routedContext();
    const first = await openPage(context),
      second = await openPage(context);
    try {
      const a = await freezeWebGlOutput(first),
        b = await freezeWebGlOutput(second);
      await startWorker(first, "shared", "pair");
      await expect.poll(() => a.failedWorkers + b.failedWorkers).toBe(2);
      expect(a.frozenWorkers + b.frozenWorkers).toBe(0);
      await a.dispose();
      expect((await latest(first, "pair"))!.nativeNow).toBe(false);
      await b.dispose();
      await expect.poll(async () => (await latest(first, "pair"))!.nativeNow).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("patches a restarted SharedWorker without keeping a dead target session", async () => {
    const context = await routedContext();
    const page = await openPage(context);
    const observer = await browser.newBrowserCDPSession();
    try {
      const freeze = await freezeWebGlOutput(page);
      await startWorker(page, "shared", "restart");
      const { targetInfos } = await observer.send("Target.getTargets");
      const worker = targetInfos.find(
        (target) => target.type === "shared_worker" && target.url === `${origin}/shared.js`,
      );
      expect(worker).toBeDefined();
      await page.evaluate(() => (globalThis as ProbeScope).workerProbes.restart.port.postMessage({ close: true }));
      await expect
        .poll(async () => {
          const result = await observer.send("Target.getTargets");
          return result.targetInfos.some((target) => target.targetId === worker!.targetId && target.attached);
        })
        .toBe(false);
      await startWorker(page, "shared", "restart");
      await expect.poll(async () => (await latest(page, "restart"))!.nativeNow).toBe(false);
      await expect.poll(() => freeze.failedWorkers).toBe(2);
      expect(freeze.frozenWorkers).toBe(0);
      await freeze.dispose();
      await expect.poll(async () => (await latest(page, "restart"))!.nativeNow).toBe(true);
    } finally {
      await observer.detach();
      await context.close();
    }
  });

  it("detaches browser target sessions when the page closes", async () => {
    const sessions: CDPSession[] = [];
    const original = browser.newBrowserCDPSession.bind(browser);
    const spy = vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
      const session = await original();
      sessions.push(session);
      return session;
    });
    const context = await routedContext();
    const page = await openPage(context);
    try {
      const freeze = await freezeWebGlOutput(page);
      await startWorker(page, "shared", "close");
      await page.close();
      await freeze.dispose();
      expect(sessions).toHaveLength(3);
      for (const session of sessions) await expect(session.send("Target.getTargets")).rejects.toThrow();
      const next = await openPage(context);
      await startWorker(next, "shared", "next");
      expect(await latest(next, "next")).toMatchObject({ nativeAtStart: true, nativeInImport: true, nativeNow: true });
    } finally {
      spy.mockRestore();
      await context.close();
    }
  });

  it.each(["attach", "evaluate", "timeout"] as const)("resumes a worker after controlled %s failure", async (mode) => {
    let injected = false;
    const original = browser.newBrowserCDPSession.bind(browser);
    const spy = vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
      const session = await original();
      const forward = session.send.bind(session) as (method: string, params?: unknown) => Promise<unknown>;
      // Protocol test boundary: preserve every real call except one injected
      // attach/evaluate failure or a missing nested reply.
      vi.spyOn(session, "send").mockImplementation(((method: string, params?: Record<string, unknown>) => {
        if (!injected && mode === "attach" && method === "Target.attachToTarget") {
          injected = true;
          return Promise.reject(new Error("controlled attach failure"));
        }
        if (
          !injected &&
          mode !== "attach" &&
          method === "Target.sendMessageToTarget" &&
          typeof params?.message === "string"
        ) {
          const payload = JSON.parse(params.message) as { method: string };
          if (payload.method === "Runtime.evaluate") {
            injected = true;
            return mode === "timeout" ? Promise.resolve({}) : Promise.reject(new Error("controlled evaluate failure"));
          }
        }
        return forward(method, params);
      }) as CDPSession["send"]);
      return session;
    });
    const context = await routedContext();
    const page = await openPage(context);
    try {
      const freeze = await freezeWebGlOutput(page);
      const failed = startWorker(page, "worker", `failed-${mode}`);
      if (mode === "timeout") {
        await startWorker(page, "worker", "healthy-during-timeout");
        expect(await latest(page, "healthy-during-timeout")).toMatchObject({
          nativeAtStart: false,
          nativeInImport: false,
          nativeNow: false,
        });
        expect(freeze.frozenWorkers).toBe(1);
        expect(freeze.failedWorkers).toBe(0);
      }
      await failed;
      expect(injected).toBe(true);
      expect(await latest(page, `failed-${mode}`)).toMatchObject({
        nativeAtStart: true,
        nativeNow: true,
        pixel: [255, 0, 0, 255],
      });
      expect(freeze.failedWorkers).toBe(1);
      expect(freeze.frozenWorkers).toBe(mode === "timeout" ? 1 : 0);
      await freeze.dispose();
      expect(await page.evaluate(() => WebGL2RenderingContext.prototype.clear.toString())).toContain("[native code]");
    } finally {
      await context.close();
      spy.mockRestore();
    }
  });

  it("cleans up when its context closes during initial worker setup", async () => {
    const context = await routedContext();
    const page = await openPage(context);
    const pending = freezeWebGlOutput(page);
    await context.close();
    const freeze = await pending;
    await freeze.dispose();
    const unrelated = await routedContext();
    try {
      const next = await openPage(unrelated);
      await startWorker(next, "shared", "after-early-close");
      expect((await latest(next, "after-early-close"))!.nativeNow).toBe(true);
    } finally {
      await unrelated.close();
    }
  });
});
