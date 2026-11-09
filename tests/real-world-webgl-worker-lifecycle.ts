import type { CDPSession, Page } from "@playwright/test";
import { detachQuietly } from "../src/capture/cdp-lifecycle.js";

interface TargetInfo {
  targetId: string;
  type: string;
  browserContextId?: string;
}
interface Attachment {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger: boolean;
}
interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
interface WorkerRecord {
  primarySessionId: string;
  sessionId: string;
  targetId: string;
}
interface WorkerCommandSession {
  send(method: "Target.sendMessageToTarget", params: { sessionId: string; message: string }): Promise<unknown>;
}
export interface WorkerFreezeCounters {
  frozenWorkers: number;
  failedWorkers: number;
  failedWorkerRestorations: number;
}

const COMMAND_TIMEOUT_MS = 3_000;
const FILTER_WORKERS = [{ type: "worker" }, { exclude: true }];
const FILTER_SHARED = [{ type: "shared_worker" }, { exclude: true }];
const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** Public non-flat CDP sessions carry commands for flat auto-attached targets. */
export class WorkerCommandTransport {
  private nextId = 0;
  private readonly pending = new Map<string, PendingCommand>();
  readonly receive = (event: { sessionId: string; message: string }): void => {
    let payload: Record<string, unknown> | null;
    try {
      payload = record(JSON.parse(event.message));
    } catch {
      return;
    }
    if (payload == null || typeof payload.id !== "number") return;
    const key = `${event.sessionId}:${payload.id}`;
    const pending = this.pending.get(key);
    if (pending == null) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (payload.error != null)
      pending.reject(new Error(String(record(payload.error)?.message ?? "worker protocol command failed")));
    else pending.resolve(payload.result);
  };
  constructor(
    private readonly session: WorkerCommandSession,
    private readonly timeoutMs = COMMAND_TIMEOUT_MS,
  ) {}
  command(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`worker ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      void this.session
        .send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((error) => {
          const pending = this.pending.get(key);
          if (pending == null) return;
          this.pending.delete(key);
          clearTimeout(timer);
          reject(error);
        });
    });
  }
  cancel(sessionId?: string): void {
    for (const [key, pending] of this.pending) {
      if (sessionId != null && !key.startsWith(`${sessionId}:`)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(new Error("worker debugger session closed"));
    }
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("worker target command timed out")), COMMAND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function acquireSession(promise: Promise<CDPSession>): Promise<CDPSession> {
  let abandoned = false;
  void promise
    .then((session) => {
      if (abandoned) return detachQuietly(session);
    })
    .catch(() => undefined);
  try {
    return await bounded(promise);
  } catch (error) {
    abandoned = true;
    throw error;
  }
}

/** SharedWorkers belong to the isolated capture context, not page.workers(). */
export async function freezeWorkerLifecycle(
  page: Page,
  expressions: { patch: string; restore: string },
  counters: WorkerFreezeCounters,
): Promise<{ dispose(): Promise<void> }> {
  const browser = page.context().browser();
  if (browser == null) {
    counters.failedWorkers++;
    return { dispose: async () => undefined };
  }
  let related: CDPSession | undefined,
    shared: CDPSession | undefined,
    transportSession: CDPSession | undefined,
    pageSession: CDPSession | undefined;
  let closing = false;
  let contextClosed = false;
  const onContextClosed = (): void => {
    contextClosed = true;
  };
  page.context().once("close", onContextClosed);
  const workers = new Map<string, WorkerRecord>();
  const existingShared = new Set<string>();
  const tasks = new Set<Promise<void>>();
  let wire: WorkerCommandTransport | undefined;
  let disposePromise: Promise<void> | undefined;
  const detachTarget = async (session: CDPSession, sessionId: string): Promise<void> => {
    await bounded(session.send("Target.detachFromTarget", { sessionId })).catch(() => undefined);
  };
  const track = (task: Promise<void>): void => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
  };
  const attached = async (
    source: CDPSession,
    event: Attachment,
    contextId: string | undefined,
    unsafeStartup = false,
  ): Promise<void> => {
    // Discovery and command clients are separate, so a restarted target with
    // the same host id receives a fresh patch and cannot be mistaken for our
    // own secondary attachment.
    const ours = event.targetInfo.browserContextId === contextId;
    let secondary: string | undefined;
    let resumed = false;
    let abandoned = false;
    try {
      const attach = transportSession!.send("Target.attachToTarget", {
        targetId: event.targetInfo.targetId,
        flatten: false,
      });
      void attach
        .then((result) => {
          if (abandoned) return detachTarget(transportSession!, result.sessionId);
        })
        .catch(() => undefined);
      secondary = (await bounded(attach)).sessionId;
      // Unrelated contexts are resumed before any patch or related-target work.
      if (!ours || closing) {
        await wire!.command(secondary, "Runtime.runIfWaitingForDebugger");
        resumed = true;
        return;
      }
      workers.set(event.targetInfo.targetId, {
        primarySessionId: event.sessionId,
        sessionId: secondary,
        targetId: event.targetInfo.targetId,
      });
      if (event.targetInfo.type === "shared_worker") {
        // Include any dedicated descendants a SharedWorker creates later.
        await bounded(
          related!.send("Target.autoAttachRelated", {
            targetId: event.targetInfo.targetId,
            waitForDebuggerOnStart: true,
            filter: FILTER_WORKERS,
          }),
        );
      }
      if (!closing) {
        const response = record(
          await wire!.command(secondary, "Runtime.evaluate", { expression: expressions.patch, returnByValue: true }),
        );
        if (response?.exceptionDetails != null || record(response?.result)?.value !== true)
          throw new Error("worker WebGL patch failed");
        // Playwright independently resumes SharedWorker targets it does not
        // manage. Their modules may cache native calls before this patch.
        // Do not count that best-effort patch as a strict startup freeze.
        if (unsafeStartup) counters.failedWorkers++;
        else counters.frozenWorkers++;
      }
    } catch {
      abandoned = secondary == null;
      if (ours && !closing) counters.failedWorkers++;
    } finally {
      if (secondary != null && !resumed) {
        try {
          await wire!.command(secondary, "Runtime.runIfWaitingForDebugger");
          resumed = true;
        } catch {
          /* Detaching both clients below releases a stalled debugger wait. */
        }
      }
      if (!resumed || !ours || closing) {
        if (secondary != null) {
          wire?.cancel(secondary);
          await detachTarget(transportSession!, secondary);
        }
        await detachTarget(source, event.sessionId);
      }
    }
  };
  let onRelated: ((event: Attachment) => void) | undefined;
  let onShared: ((event: Attachment) => void) | undefined;
  let onDetached: ((event: { sessionId: string }) => void) | undefined;
  const onPrimaryDetached = ({ sessionId }: { sessionId: string }): void => {
    if (closing) return;
    for (const [targetId, worker] of workers) {
      if (worker.primarySessionId !== sessionId) continue;
      workers.delete(targetId);
      wire?.cancel(worker.sessionId);
      // SharedWorkerDevToolsManager reuses terminated hosts and pauses a
      // restart if any client remains attached. Release our secondary when
      // discovery detaches, rather than holding a dead host until disposal.
      if (transportSession != null) track(detachTarget(transportSession, worker.sessionId));
    }
  };
  const dispose = (): Promise<void> =>
    (disposePromise ??= (async () => {
      closing = true;
      if (related != null)
        await bounded(
          related.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }),
        ).catch(() => undefined);
      if (shared != null)
        await bounded(
          shared.send("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          }),
        ).catch(() => undefined);
      // Each task has bounded attach/evaluate/resume work, and may run in parallel.
      await Promise.allSettled([...tasks]);
      if (wire != null)
        await Promise.allSettled(
          [...workers.values()].map(async ({ sessionId, targetId }) => {
            try {
              const response = record(
                await wire!.command(sessionId, "Runtime.evaluate", {
                  expression: expressions.restore,
                  returnByValue: true,
                }),
              );
              if (
                !contextClosed &&
                workers.has(targetId) &&
                (response?.["exceptionDetails"] != null || record(response?.["result"])?.["value"] !== true)
              )
                counters.failedWorkerRestorations++;
            } catch {
              // A terminated target needs no restoration. A still-owned live
              // target with an exception/timeout has unverified cleanup.
              if (!contextClosed && workers.has(targetId)) counters.failedWorkerRestorations++;
            } finally {
              await wire!.command(sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
            }
          }),
        );
      if (onRelated != null) related?.off("Target.attachedToTarget", onRelated);
      if (onShared != null) shared?.off("Target.attachedToTarget", onShared);
      shared?.off("Target.detachedFromTarget", onPrimaryDetached);
      related?.off("Target.detachedFromTarget", onPrimaryDetached);
      if (wire != null) transportSession?.off("Target.receivedMessageFromTarget", wire.receive);
      if (onDetached != null) transportSession?.off("Target.detachedFromTarget", onDetached);
      wire?.cancel();
      page.context().off("close", onContextClosed);
      workers.clear();
      existingShared.clear();
      await Promise.all(
        [pageSession, related, shared, transportSession].map((session) =>
          bounded(detachQuietly(session)).catch(() => undefined),
        ),
      );
    })());
  try {
    pageSession = await acquireSession(page.context().newCDPSession(page));
    const { targetInfo } = await bounded(pageSession.send("Target.getTargetInfo"));
    related = await acquireSession(browser.newBrowserCDPSession());
    shared = await acquireSession(browser.newBrowserCDPSession());
    transportSession = await acquireSession(browser.newBrowserCDPSession());
    wire = new WorkerCommandTransport(transportSession);
    transportSession.on("Target.receivedMessageFromTarget", wire.receive);
    onDetached = ({ sessionId }) => {
      wire?.cancel(sessionId);
      for (const [targetId, worker] of workers) {
        if (worker.sessionId === sessionId) workers.delete(targetId);
      }
    };
    transportSession.on("Target.detachedFromTarget", onDetached);
    onRelated = (event) => {
      if (event.targetInfo.type === "worker") track(attached(related!, event, targetInfo.browserContextId));
    };
    onShared = (event) => {
      if (event.targetInfo.type === "shared_worker") {
        const existed = existingShared.delete(event.targetInfo.targetId);
        track(attached(shared!, event, targetInfo.browserContextId, !existed));
      }
    };
    related.on("Target.attachedToTarget", onRelated);
    shared.on("Target.attachedToTarget", onShared);
    shared.on("Target.detachedFromTarget", onPrimaryDetached);
    related.on("Target.detachedFromTarget", onPrimaryDetached);
    const { targetInfos } = await bounded(shared.send("Target.getTargets"));
    for (const target of targetInfos) {
      if (target.type === "shared_worker" && target.browserContextId === targetInfo.browserContextId)
        existingShared.add(target.targetId);
    }
    await bounded(
      related.send("Target.autoAttachRelated", {
        targetId: targetInfo.targetId,
        waitForDebuggerOnStart: true,
        filter: FILTER_WORKERS,
      }),
    );
    await bounded(
      shared.send("Target.setAutoAttach", {
        autoAttach: true,
        // Public Playwright cannot address this flat session's own startup
        // throttle. Do not introduce a wait that a restarted SharedWorker may
        // never release. Strict startup is tracked by DM-34WC46.
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: FILTER_SHARED,
      }),
    );
    await Promise.allSettled([...tasks]);
    await bounded(detachQuietly(pageSession)).catch(() => undefined);
    pageSession = undefined;
  } catch {
    counters.failedWorkers++;
    await dispose();
  }
  return { dispose };
}
