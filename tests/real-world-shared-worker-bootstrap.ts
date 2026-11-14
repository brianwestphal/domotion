import type { Browser } from "@playwright/test";
import { FlatCdp, cdpObject, type CdpObject } from "./real-world-cdp.js";
import type { WorkerFreezeCounters } from "./real-world-webgl-worker-lifecycle.js";

interface Lease {
  contextId: string;
  expressions: { patch: string; restore: string };
  counters: WorkerFreezeCounters;
  contextClosed(): boolean;
  closed: boolean;
}
interface Worker {
  targetId: string;
  contextId?: string;
  url?: string;
  sessionId: string;
  waiting: boolean;
  owners: Set<Lease>;
  frozenOwners: Set<Lease>;
  failedOwners: Set<Lease>;
  tail: Promise<void>;
}

/** DM-3C3NFV: what the bootstrap observed for one SharedWorker startup, so a
 * startup that never reports can be classified as a lost resume (attached
 * waiting, resume never acknowledged) or a lost error dispatch (resumed). */
export interface WorkerStartupEvent {
  at: number;
  targetId: string;
  url?: string;
  event:
    | "attached"
    | "duplicate-attach"
    | "resume-sent"
    | "resume-ok"
    | "resume-failed"
    | "detach-sent"
    | "detach-ok"
    | "detach-failed"
    | "detached";
  waiting?: boolean;
}

const succeeded = (value: unknown): boolean => {
  const response = cdpObject(value);
  return response?.exceptionDetails == null && cdpObject(response?.result)?.value === true;
};
const managed = new WeakMap<Browser, SharedWorkerBootstrap>();
export function registerSharedWorkerBootstrap(browser: Browser, owner: SharedWorkerBootstrap): () => void {
  managed.set(browser, owner);
  return () => {
    managed.delete(browser);
  };
}
export const sharedWorkerBootstrapFor = (browser: Browser): SharedWorkerBootstrap | undefined => managed.get(browser);

/** A single public flat-CDP client owns SharedWorker startup for frozen contexts.
 * Playwright's separate root client is filtered by the harness broker. */
export class SharedWorkerBootstrap {
  private readonly leases = new Map<string, Set<Lease>>();
  private readonly workers = new Map<string, Worker>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly startupLog: WorkerStartupEvent[] = [];
  private enabled: Promise<void> | undefined;
  private closed = false;
  private failed = false;
  private readonly unsubscribe: Array<() => void>;
  constructor(
    private readonly connection: FlatCdp,
    private readonly reconnect: () => Promise<FlatCdp>,
  ) {
    this.unsubscribe = [
      connection.on("Target.attachedToTarget", (event) => this.attached(event)),
      connection.on("Target.detachedFromTarget", (event) => {
        if (typeof event.sessionId === "string") this.detached(event.sessionId);
      }),
      connection.on("Inspector.targetCrashed", (_event, sessionId) => {
        if (sessionId != null) this.detached(sessionId, true);
      }),
      connection.onClose(() => {
        if (this.closed || this.failed) return;
        this.failed = true;
        for (const leases of this.leases.values())
          for (const lease of leases) if (!lease.closed && !lease.contextClosed()) lease.counters.failedWorkers++;
        this.track(this.releaseLostStartupWaits([...this.workers.values()].filter((worker) => worker.waiting)));
      }),
    ];
  }
  private async releaseLostStartupWaits(workers: readonly Worker[]): Promise<void> {
    if (workers.length === 0) return;
    // A disconnect before renderer-ready can strand pause_on_start. Reconnect
    // only to target IDs whose auto-attach event proved our startup wait.
    // Foreign contexts get the same resume, never a prototype patch.
    let recovery: FlatCdp | undefined;
    try {
      recovery = await this.reconnect();
      await Promise.allSettled(
        workers.map(async (worker) => {
          let sessionId: string | undefined;
          try {
            const response = cdpObject(await recovery!.command("Target.getTargetInfo", { targetId: worker.targetId }));
            const info = cdpObject(response?.targetInfo);
            const contextId = typeof info?.browserContextId === "string" ? info.browserContextId : undefined;
            if (info?.type !== "shared_worker" || contextId !== worker.contextId || info.url !== worker.url) return;
            const attached = cdpObject(
              await recovery!.command("Target.attachToTarget", { targetId: worker.targetId, flatten: true }),
            );
            if (typeof attached?.sessionId !== "string") return;
            sessionId = attached.sessionId;
            await recovery!.command("Runtime.runIfWaitingForDebugger", {}, sessionId);
          } finally {
            if (sessionId != null)
              await recovery!.command("Target.detachFromTarget", { sessionId }).catch(() => undefined);
          }
        }),
      );
    } catch {
      /* Discovery is already marked unhealthy for every active lease. */
    } finally {
      await recovery?.close();
    }
  }
  private live(worker: Worker): boolean {
    return this.workers.get(worker.targetId) === worker;
  }
  private log(entry: Omit<WorkerStartupEvent, "at">): void {
    if (this.startupLog.length >= 256) this.startupLog.shift();
    this.startupLog.push({ at: Date.now(), ...entry });
  }
  /** Startup events for workers whose script URL ends with `path`. */
  startupEvents(path: string): WorkerStartupEvent[] {
    return this.startupLog.filter((entry) => entry.url?.split("?")[0].endsWith(path) === true).slice(-16);
  }
  private track(task: Promise<void>): Promise<void> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }
  private enqueue(worker: Worker, work: () => Promise<void>): Promise<void> {
    const task = worker.tail.then(work);
    worker.tail = task.catch(() => undefined);
    return this.track(task);
  }
  private attached(event: CdpObject): void {
    const info = cdpObject(event.targetInfo);
    if (info?.type !== "shared_worker" || typeof info.targetId !== "string" || typeof event.sessionId !== "string")
      return;
    const url = typeof info.url === "string" ? info.url : undefined;
    if (this.workers.has(info.targetId)) {
      this.log({ targetId: info.targetId, url, event: "duplicate-attach" });
      // A duplicate manual attachment does not own the original startup pause.
      // Runtime.runIfWaitingForDebugger here would release it prematurely.
      this.track(
        this.connection
          .command("Target.detachFromTarget", { sessionId: event.sessionId })
          .then(() => undefined)
          .catch(() => undefined),
      );
      return;
    }
    const worker: Worker = {
      targetId: info.targetId,
      contextId: typeof info.browserContextId === "string" ? info.browserContextId : undefined,
      url: typeof info.url === "string" ? info.url : undefined,
      sessionId: event.sessionId,
      waiting: event.waitingForDebugger === true,
      owners: new Set(),
      frozenOwners: new Set(),
      failedOwners: new Set(),
      tail: Promise.resolve(),
    };
    this.workers.set(worker.targetId, worker);
    this.log({ targetId: worker.targetId, url, event: "attached", waiting: worker.waiting });
    void this.enqueue(worker, async () => {
      try {
        const leases = worker.contextId == null ? [] : [...(this.leases.get(worker.contextId) ?? [])];
        for (const lease of leases) await this.patch(worker, lease);
      } finally {
        if (this.live(worker) && worker.waiting) {
          try {
            this.log({ targetId: worker.targetId, url: worker.url, event: "resume-sent" });
            await this.connection.command("Runtime.runIfWaitingForDebugger", {}, worker.sessionId);
            worker.waiting = false;
            this.log({ targetId: worker.targetId, url: worker.url, event: "resume-ok" });
          } catch {
            this.log({ targetId: worker.targetId, url: worker.url, event: "resume-failed" });
            // The last client detaching releases Chromium's startup pause.
            // Restore first so a failed resume cannot strand an owned no-op.
            for (const lease of worker.owners) {
              if (worker.frozenOwners.delete(lease)) lease.counters.frozenWorkers--;
              if (!this.failed && !lease.closed && !lease.contextClosed() && !worker.failedOwners.has(lease)) {
                lease.counters.failedWorkers++;
                worker.failedOwners.add(lease);
              }
              await this.restore(worker, lease);
            }
            worker.owners.clear();
            await this.detach(worker);
          }
        }
        if (worker.owners.size === 0) await this.detach(worker);
      }
    }).catch(() => undefined);
  }
  private detached(sessionId: string, detachClient = false): void {
    for (const worker of this.workers.values()) {
      if (worker.sessionId !== sessionId) continue;
      this.workers.delete(worker.targetId);
      this.log({ targetId: worker.targetId, url: worker.url, event: "detached", waiting: worker.waiting });
      this.connection.cancelSession(sessionId);
      // A terminated SharedWorker host can be reused. Keep no client attached
      // that would impose a startup pause on its next incarnation.
      if (detachClient)
        this.track(
          this.connection
            .command("Target.detachFromTarget", { sessionId })
            .then(() => undefined)
            .catch(() => undefined),
        );
      break;
    }
  }
  private async detach(worker: Worker): Promise<void> {
    if (!this.live(worker)) return;
    this.workers.delete(worker.targetId);
    this.connection.cancelSession(worker.sessionId);
    // Logged here because removing the worker above suppresses its later
    // `detached` entry, and a failed resume relies on this detach to release
    // Chromium's startup pause.
    this.log({ targetId: worker.targetId, url: worker.url, event: "detach-sent", waiting: worker.waiting });
    await this.connection.command("Target.detachFromTarget", { sessionId: worker.sessionId }).then(
      () => this.log({ targetId: worker.targetId, url: worker.url, event: "detach-ok" }),
      () => this.log({ targetId: worker.targetId, url: worker.url, event: "detach-failed" }),
    );
  }
  private async patch(worker: Worker, lease: Lease): Promise<void> {
    if (lease.closed || !this.live(worker) || worker.owners.has(lease)) return;
    try {
      if (lease.closed || this.failed || !this.live(worker)) return;
      worker.owners.add(lease); // Retain commands that may have partially applied.
      const response = await this.connection.command(
        "Runtime.evaluate",
        { expression: lease.expressions.patch, returnByValue: true },
        worker.sessionId,
      );
      if (!lease.closed && this.live(worker)) {
        if (succeeded(response)) {
          lease.counters.frozenWorkers++;
          worker.frozenOwners.add(lease);
        } else {
          lease.counters.failedWorkers++;
          worker.failedOwners.add(lease);
        }
      }
    } catch {
      if (!this.failed && !lease.closed && !lease.contextClosed() && this.live(worker)) {
        lease.counters.failedWorkers++;
        worker.failedOwners.add(lease);
      }
    }
  }
  private async restore(worker: Worker, lease: Lease): Promise<void> {
    try {
      if (!this.live(worker) || lease.contextClosed()) return;
      const result = await this.connection.command(
        "Runtime.evaluate",
        { expression: lease.expressions.restore, returnByValue: true },
        worker.sessionId,
      );
      if (!succeeded(result) && this.live(worker) && !lease.contextClosed()) lease.counters.failedWorkerRestorations++;
    } catch {
      if (this.live(worker) && !lease.contextClosed()) lease.counters.failedWorkerRestorations++;
    }
  }
  async acquire(
    contextId: string,
    expressions: Lease["expressions"],
    counters: WorkerFreezeCounters,
    contextClosed: () => boolean,
  ): Promise<{ dispose(): Promise<void> }> {
    if (this.closed || this.failed) throw new Error("SharedWorker bootstrap connection unavailable");
    const lease: Lease = { contextId, expressions, counters, contextClosed, closed: false };
    const leases = this.leases.get(contextId) ?? new Set();
    leases.add(lease);
    this.leases.set(contextId, leases);
    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> => (disposing ??= this.release(lease));
    try {
      this.enabled ??= this.connection
        .command("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "shared_worker" }, { exclude: true }],
        })
        .then(() => undefined);
      await this.enabled;
      const response = cdpObject(await this.connection.command("Target.getTargets"));
      if (!Array.isArray(response?.targetInfos)) throw new Error("SharedWorker target snapshot unavailable");
      const targets = response.targetInfos;
      for (const raw of targets) {
        const info = cdpObject(raw);
        if (info?.type !== "shared_worker" || info.browserContextId !== contextId || typeof info.targetId !== "string")
          continue;
        const worker = this.workers.get(info.targetId);
        if (worker != null) await this.enqueue(worker, () => this.patch(worker, lease));
        else await this.connection.command("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      }
      await Promise.allSettled([...this.tasks]);
      if (this.failed) throw new Error("SharedWorker bootstrap disconnected during acquisition");
      return { dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
  private async release(lease: Lease): Promise<void> {
    lease.closed = true;
    const leases = this.leases.get(lease.contextId);
    leases?.delete(lease);
    if (leases?.size === 0) this.leases.delete(lease.contextId);
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled(
      [...this.workers.values()]
        .filter((worker) => worker.owners.has(lease))
        .map((worker) =>
          this.enqueue(worker, async () => {
            try {
              await this.restore(worker, lease);
            } finally {
              worker.owners.delete(lease);
              worker.frozenOwners.delete(lease);
              worker.failedOwners.delete(lease);
              if (worker.owners.size === 0) await this.detach(worker);
            }
          }),
        ),
    );
    // Keep a single filtered observer for later frozen contexts. Without an
    // active lease, its handler only releases its own pause and detaches.
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.leases.values()].flatMap((leases) => [...leases].map((lease) => this.release(lease))),
    );
    if (this.enabled != null)
      await this.connection
        .command("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
        .catch(() => undefined);
    await Promise.allSettled([...this.tasks]);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}
