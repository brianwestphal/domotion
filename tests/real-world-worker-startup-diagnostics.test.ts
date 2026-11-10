import type { CDPSession, Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWorkerStartupDiagnostic } from "./real-world-worker-startup-diagnostics.js";
import { cdpObject, type CdpObject } from "./real-world-cdp.js";

const origin = "http://127.0.0.1:12345";
const identity = { origin, scriptPath: "/worker.js", name: "worker" };
const target = {
  targetId: "worker-target",
  type: "shared_worker",
  url: origin + "/worker.js",
  title: "worker",
  browserContextId: "ours",
  attached: false,
};
const never = () => new Promise<never>(() => undefined);
const runtimeException = (
  description = "TypeError: Cannot read properties of null (reading 'clearColor')",
  url = origin + "/worker.js",
) => ({
  method: "Runtime.exceptionThrown",
  params: {
    exceptionDetails: {
      text: "Uncaught",
      url,
      lineNumber: 0,
      columnNumber: 20,
      exception: { className: "TypeError", description, objectId: "private-object-id" },
    },
  },
});

class FakeSession {
  listeners = new Map<string, Set<(event: CdpObject) => void>>();
  commands: Array<{ method: string; params?: CdpObject }> = [];
  targets = [target];
  own = { type: "page", browserContextId: "ours", url: origin + "/" };
  attachInfo = target;
  attachmentEvent = true;
  waiting = false;
  overrides = new Map<string, () => Promise<unknown>>();
  runtime: () => void = () => undefined;
  rootClosed = false;
  send = async (method: string, params?: CdpObject): Promise<unknown> => {
    this.commands.push({ method, params });
    if (this.overrides.has(method)) return this.overrides.get(method)!();
    if (method === "Target.getTargetInfo") return { targetInfo: this.own };
    if (method === "Target.getTargets") return { targetInfos: this.targets };
    if (method === "Target.attachToTarget") {
      if (this.attachmentEvent)
        this.emit("Target.attachedToTarget", {
          sessionId: "child",
          targetInfo: this.attachInfo,
          waitingForDebugger: this.waiting,
        });
      return { sessionId: "child" };
    }
    if (method === "Target.sendMessageToTarget") {
      const message = cdpObject(JSON.parse(String(params?.message)));
      this.runtime();
      this.message({ id: message?.id, result: {} });
      return {};
    }
    if (method === "Target.detachFromTarget") return {};
    throw new Error("Unexpected diagnostic command");
  };
  detach = vi.fn(async () => {
    this.rootClosed = true;
  });
  on(event: string, listener: (event: CdpObject) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: string, listener: (event: CdpObject) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, payload: CdpObject): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  message(message: unknown, sessionId = "child"): void {
    this.emit("Target.receivedMessageFromTarget", { sessionId, message: JSON.stringify(message) });
  }
  // Public CDP test double; no private Playwright API is accessed in production.
  session(): CDPSession {
    return this as unknown as CDPSession;
  }
  page(): Page {
    return {
      url: () => origin + "/",
      context: () => ({ newCDPSession: async () => this.session() }),
    } as unknown as Page;
  }
  assertClean(): void {
    expect([...this.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
}

afterEach(() => vi.useRealTimers());
describe("failure-only synthetic worker replay (DM-XWB4FA)", () => {
  it("authenticates context, URL and name before replaying native exceptions", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.targets = [
      { ...target, targetId: "foreign", browserContextId: "foreign" },
      { ...target, targetId: "other-name", title: "other" },
      { ...target, targetId: "dedicated", type: "worker" },
      target,
    ];
    fake.runtime = () => {
      fake.message(runtimeException());
      fake.message(runtimeException("secret environment=leak"), "foreign-session");
    };
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result).toMatchObject({
      status: "complete",
      target: {
        attachedBeforeInspection: false,
        diagnosticAttachmentWaitingForDebugger: false,
        globalDebuggerPause: "unobserved",
      },
      exceptions: [
        {
          name: "TypeError",
          detail: "TypeError: Cannot read properties of null (reading 'clearColor')",
          path: "/worker.js",
          line: 0,
          column: 20,
        },
      ],
      cleanup: { child: "detached", page: "detached" },
    });
    expect(fake.commands.filter((command) => command.method === "Target.attachToTarget")).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "worker-target", flatten: false } },
    ]);
    const nested = fake.commands
      .filter((command) => command.method === "Target.sendMessageToTarget")
      .map((command) => cdpObject(JSON.parse(String(command.params?.message)))?.method);
    expect(nested).toEqual(["Runtime.enable"]);
    expect(JSON.stringify(result)).not.toMatch(/secret|objectId|private-object|foreign-session|http:/);
    fake.assertClean();
  });

  it("keeps attachment-local waiting distinct from unobserved global pause", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.waiting = true;
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result.target).toMatchObject({
      diagnosticAttachmentWaitingForDebugger: true,
      globalDebuggerPause: "unobserved",
    });
    expect(JSON.stringify(fake.commands)).not.toMatch(/runIfWaiting|Debugger\.enable|Runtime\.evaluate|setAutoAttach/);
    fake.assertClean();
  });

  it.each(["context", "url", "name", "type"])("ignores unmatched %s identities without attachment", async (field) => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.targets = [
      {
        ...target,
        ...(field === "context"
          ? { browserContextId: "foreign" }
          : field === "url"
            ? { url: origin + "/other.js" }
            : field === "name"
              ? { title: "foreign" }
              : { type: "worker" }),
      },
    ];
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result.status).toBe("no_target");
    expect(fake.commands.some((command) => command.method === "Target.attachToTarget")).toBe(false);
    expect(fake.rootClosed).toBe(true);
    fake.assertClean();
  });

  it("declines ambiguous targets and incomplete page identity", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.targets.push({ ...target, targetId: "duplicate" });
    expect((await collectWorkerStartupDiagnostic(fake.page(), identity)).status).toBe("ambiguous_target");
    fake.assertClean();
    const wrongPage = new FakeSession();
    wrongPage.own.type = "worker";
    expect(await collectWorkerStartupDiagnostic(wrongPage.page(), identity)).toMatchObject({
      status: "unavailable",
      failureStage: "page_identity",
      cleanup: { page: "detached" },
    });
    wrongPage.assertClean();
  });

  it.each(["mismatch", "missing"])("does not enable Runtime with %s attachment proof", async (kind) => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    if (kind === "missing") fake.attachmentEvent = false;
    else fake.attachInfo = { ...target, browserContextId: "foreign" };
    expect(await collectWorkerStartupDiagnostic(fake.page(), identity)).toMatchObject({
      status: "unavailable",
      failureStage: "attachment_identity",
      cleanup: { child: "detached", page: "detached" },
    });
    expect(fake.commands.some((command) => command.method === "Target.sendMessageToTarget")).toBe(false);
    fake.assertClean();
  });

  it("redacts unknown details/locations and bounds oversized or excessive events", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.runtime = () => {
      fake.emit("Target.receivedMessageFromTarget", { sessionId: "child", message: "invalid json" });
      fake.message(
        runtimeException("Authorization: Bearer PRIVATE_SECRET", "https://user:pass@external.invalid/?token=SECRET"),
      );
      fake.message(runtimeException("x".repeat(40 * 1024)));
      for (let i = 0; i < 20; i++) fake.message(runtimeException());
    };
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result.status).toBe("complete");
    expect(result.exceptions).toHaveLength(8);
    expect(result.droppedExceptions).toBe(14);
    expect(result.exceptions[0]).toEqual({ name: "TypeError", detail: "[redacted]" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|Authorization|external|user:pass|objectId/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    fake.assertClean();
  });

  it.each(["Target.getTargetInfo", "Target.getTargets", "Target.attachToTarget", "Target.sendMessageToTarget"])(
    "contains %s rejection and closes its page session",
    async (method) => {
      vi.useFakeTimers();
      const fake = new FakeSession();
      fake.overrides.set(method, async () => {
        throw new Error("sensitive environment=SECRET");
      });
      const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
      expect(result.status).toBe("unavailable");
      expect(result.cleanup.page).toBe("detached");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      fake.assertClean();
    },
  );

  it("contains nested Runtime rejection without exposing protocol text", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.overrides.set("Target.sendMessageToTarget", async () => {
      const call = fake.commands.at(-1)!;
      const request = cdpObject(JSON.parse(String(call.params?.message)));
      fake.message({ id: request?.id, error: { message: "secret token=PRIVATE" } });
      return {};
    });
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result).toMatchObject({
      status: "unavailable",
      failureStage: "enable_runtime",
      cleanup: { child: "detached", page: "detached" },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|PRIVATE/);
    fake.assertClean();
  });
  it("caps aggregate exception bytes before the retained exception count is reached", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.runtime = () => {
      for (let i = 0; i < 3; i++)
        fake.message(runtimeException("TypeError: Illegal invocation\n" + "x".repeat(30 * 1024)));
    };
    const result = await collectWorkerStartupDiagnostic(fake.page(), identity);
    expect(result.status).toBe("complete");
    expect(result.exceptions).toHaveLength(2);
    expect(result.droppedExceptions).toBe(1);
    fake.message(runtimeException());
    expect(result.exceptions).toHaveLength(2);
    fake.assertClean();
  });
  it("contains session-creation rejection without exposing protocol text", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    const report = await collectWorkerStartupDiagnostic(fake.page(), identity, {
      createSession: async () => {
        throw new Error("environment=SECRET");
      },
    });
    expect(report).toMatchObject({
      status: "unavailable",
      failureStage: "create_page_session",
      cleanup: { page: "not_created" },
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(fake.detach).not.toHaveBeenCalled();
    fake.assertClean();
  });

  it.each(["Target.getTargetInfo", "Target.getTargets", "Target.attachToTarget", "Target.sendMessageToTarget"])(
    "bounds missing %s replies without pending timers",
    async (method) => {
      vi.useFakeTimers();
      const fake = new FakeSession();
      fake.overrides.set(method, never);
      const result = collectWorkerStartupDiagnostic(fake.page(), identity, { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(21);
      expect(await result).toMatchObject({ status: "unavailable", cleanup: { page: "detached" } });
      fake.assertClean();
    },
  );

  it("closes a session whose creation completes after the diagnostic deadline", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    let release!: (session: CDPSession) => void;
    const result = collectWorkerStartupDiagnostic(fake.page(), identity, {
      timeoutMs: 20,
      createSession: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(21);
    expect(await result).toMatchObject({
      failureStage: "create_page_session",
      cleanup: { page: "pending_late_cleanup" },
    });
    release(fake.session());
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.detach).toHaveBeenCalledOnce();
    fake.assertClean();
  });

  it("attempts child detach for a late attach reply after closing its owning page session", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    let release!: (reply: unknown) => void;
    fake.overrides.set(
      "Target.attachToTarget",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = collectWorkerStartupDiagnostic(fake.page(), identity, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect((await result).cleanup.page).toBe("detached");
    release({ sessionId: "late-child" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.commands.at(-1)).toEqual({ method: "Target.detachFromTarget", params: { sessionId: "late-child" } });
    fake.assertClean();
  });

  it.each(["reject", "hang"])("bounds %s child cleanup and still closes its page session", async (kind) => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.overrides.set(
      "Target.detachFromTarget",
      kind === "hang"
        ? never
        : async () => {
            throw new Error("closed");
          },
    );
    const result = collectWorkerStartupDiagnostic(fake.page(), identity);
    await vi.advanceTimersByTimeAsync(251);
    expect(await result).toMatchObject({ status: "complete", cleanup: { child: "unavailable", page: "detached" } });
    fake.assertClean();
  });

  it("bounds page cleanup and declines invalid budgets/fixture URLs before opening sessions", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.detach.mockImplementation(never);
    const result = collectWorkerStartupDiagnostic(fake.page(), identity);
    await vi.advanceTimersByTimeAsync(251);
    expect((await result).cleanup.page).toBe("unavailable");
    fake.assertClean();
    for (const input of [
      { ...identity, origin: "https://external.invalid" },
      { ...identity, scriptPath: "/real-world.js" },
      { ...identity, name: "bad/name" },
    ])
      expect((await collectWorkerStartupDiagnostic(fake.page(), input)).status).toBe("not_fixture");
    expect((await collectWorkerStartupDiagnostic(fake.page(), identity, { timeoutMs: 1501 })).failureStage).toBe(
      "invalid_budget",
    );
  });
});
