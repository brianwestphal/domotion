import type { CDPSession, Page } from "@playwright/test";
import { cdpBounded, cdpObject } from "./real-world-cdp.js";
import { WorkerCommandTransport } from "./real-world-webgl-worker-lifecycle.js";

const BODY_TIMEOUT_MS = 1500;
const CLEANUP_STEP_MS = 250;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_EXCEPTION_BYTES = 64 * 1024;
const MAX_EXCEPTIONS = 8;
const SCRIPT_PATHS = new Set(["/worker.js", "/missing-worker.js"]);
const EXCEPTION_NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
]);
const SAFE_DETAIL =
  /^(?:Error: controlled (?:onconnect|top-level) throw|TypeError: (?:Illegal invocation|Cannot read properties of (?:null|undefined) \(reading '(?:clearColor|clear|COLOR_BUFFER_BIT|readPixels|RGBA|UNSIGNED_BYTE)'\)))$/;

export interface SyntheticWorkerIdentity {
  origin: string;
  scriptPath: string;
  name: string;
}
export interface StoredWorkerException {
  name: string;
  detail: string;
  path?: string;
  line?: number;
  column?: number;
}
export interface WorkerStartupDiagnostic {
  schemaVersion: 1;
  status: "complete" | "not_fixture" | "no_target" | "ambiguous_target" | "unavailable";
  failureStage?: string;
  identity?: { browserContextId: string; pageTargetId?: string; workerTargetId?: string };
  target?: {
    attachedBeforeInspection: boolean;
    diagnosticAttachmentWaitingForDebugger: boolean | null;
    globalDebuggerPause: "unobserved";
  };
  exceptions: StoredWorkerException[];
  droppedExceptions: number;
  cleanup: {
    child: "not_attached" | "detached" | "unavailable" | "pending_late_cleanup";
    page: "not_created" | "detached" | "unavailable" | "pending_late_cleanup";
  };
}
interface Options {
  createSession?: () => Promise<CDPSession>;
  timeoutMs?: number;
}

function fixtureUrl(page: Page, identity: SyntheticWorkerIdentity): string | undefined {
  try {
    const origin = new URL(identity.origin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !origin.port ||
      origin.origin !== identity.origin ||
      !SCRIPT_PATHS.has(identity.scriptPath) ||
      !/^[a-z0-9-]{1,64}$/i.test(identity.name) ||
      new URL(page.url()).origin !== identity.origin
    )
      return;
    return identity.origin + identity.scriptPath;
  } catch {
    return;
  }
}

function exception(value: unknown, identity: SyntheticWorkerIdentity): StoredWorkerException {
  const details = cdpObject(value);
  const thrown = cdpObject(details?.exception);
  const name =
    typeof thrown?.className === "string" && EXCEPTION_NAMES.has(thrown.className) ? thrown.className : "other";
  const firstLine = typeof thrown?.description === "string" ? thrown.description.split("\n", 1)[0]! : "";
  const detail = firstLine.length <= 256 && SAFE_DETAIL.test(firstLine) ? firstLine : "[redacted]";
  const path = [identity.scriptPath, "/relative.js"].find((path) => details?.url === identity.origin + path);
  const position = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
  return {
    name,
    detail,
    ...(path == null ? {} : { path, line: position(details?.lineNumber), column: position(details?.columnNumber) }),
  };
}

/** Failure-only, synthetic fixture diagnostics (DM-XWB4FA). This function never
 * resumes or evaluates a worker and never changes auto-attach/Debugger settings.
 * Chromium6b5a1b80 TargetHandler owns this page session's non-flat children;
 * closing it also releases a late or unacknowledged child attachment. */
export async function collectWorkerStartupDiagnostic(
  page: Page,
  identity: SyntheticWorkerIdentity,
  options: Options = {},
): Promise<WorkerStartupDiagnostic> {
  const result: WorkerStartupDiagnostic = {
    schemaVersion: 1,
    status: "unavailable",
    exceptions: [],
    droppedExceptions: 0,
    cleanup: { child: "not_attached", page: "not_created" },
  };
  const url = fixtureUrl(page, identity);
  if (url == null) {
    result.status = "not_fixture";
    return result;
  }
  const timeout = options.timeoutMs ?? BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > BODY_TIMEOUT_MS) {
    result.failureStage = "invalid_budget";
    return result;
  }
  const deadline = Date.now() + timeout;
  let stage = "create_page_session";
  let finished = false;
  let creationSettled = false;
  let attachmentPending = false;
  let session: CDPSession | undefined;
  let childId: string | undefined;
  let wire: WorkerCommandTransport | undefined;
  let targetId: string | undefined;
  let contextId: string | undefined;
  let exceptionBytes = 0;
  const attachments = new Map<string, { authenticated: boolean; waiting: boolean }>();
  const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    stage = name;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Worker diagnostic deadline reached");
    return cdpBounded(Promise.resolve().then(operation), remaining, "Worker failure diagnostic");
  };
  const detachChild = async (source: CDPSession, id: string): Promise<void> => {
    await cdpBounded(
      source.send("Target.detachFromTarget", { sessionId: id }),
      CLEANUP_STEP_MS,
      "Worker diagnostic child cleanup",
    );
  };
  const detachPage = async (source: CDPSession): Promise<void> => {
    await cdpBounded(source.detach(), CLEANUP_STEP_MS, "Worker diagnostic page cleanup");
  };
  const attached = (event: {
    sessionId: string;
    targetInfo: { targetId: string; type: string; url: string; title: string; browserContextId?: string };
    waitingForDebugger: boolean;
  }): void => {
    if (event.targetInfo.targetId !== targetId || attachments.size >= 2) return;
    attachments.set(event.sessionId, {
      authenticated:
        event.targetInfo.type === "shared_worker" &&
        event.targetInfo.browserContextId === contextId &&
        event.targetInfo.url === url &&
        event.targetInfo.title === identity.name,
      waiting: event.waitingForDebugger,
    });
  };
  const received = (event: { sessionId: string; message: string }): void => {
    if (event.sessionId !== childId) return;
    if (Buffer.byteLength(event.message) > MAX_MESSAGE_BYTES) {
      result.droppedExceptions++;
      return;
    }
    wire?.receive(event);
    let message;
    try {
      message = cdpObject(JSON.parse(event.message));
    } catch {
      return;
    }
    if (message?.method !== "Runtime.exceptionThrown") return;
    exceptionBytes += Buffer.byteLength(event.message);
    if (exceptionBytes > MAX_EXCEPTION_BYTES || result.exceptions.length >= MAX_EXCEPTIONS) {
      result.droppedExceptions++;
      return;
    }
    result.exceptions.push(exception(cdpObject(message.params)?.exceptionDetails, identity));
  };
  try {
    const creation = Promise.resolve()
      .then(() => (options.createSession ?? (() => page.context().newCDPSession(page)))())
      .then(
        (created) => {
          creationSettled = true;
          if (finished) void detachPage(created).catch(() => undefined);
          return created;
        },
        (error: unknown) => {
          creationSettled = true;
          throw error;
        },
      );
    session = await step("create_page_session", () => creation);
    session.on("Target.attachedToTarget", attached);
    session.on("Target.receivedMessageFromTarget", received);
    wire = new WorkerCommandTransport(session, BODY_TIMEOUT_MS);
    const source = session;
    const own = await step("page_identity", () => source.send("Target.getTargetInfo"));
    contextId = own.targetInfo.browserContextId;
    if (own.targetInfo.type !== "page" || contextId == null || new URL(own.targetInfo.url).origin !== identity.origin) {
      stage = "page_identity";
      throw new Error("Fixture identity unavailable");
    }
    const safeId = (value: unknown): string | undefined =>
      typeof value === "string" && /^[a-z0-9-]{1,128}$/i.test(value) ? value : undefined;
    const safeContext = safeId(contextId);
    if (safeContext != null)
      result.identity = {
        browserContextId: safeContext,
        ...(safeId(own.targetInfo.targetId) == null ? {} : { pageTargetId: safeId(own.targetInfo.targetId) }),
      };
    const discovery = await step("discover_targets", () => source.send("Target.getTargets"));
    const matches = discovery.targetInfos.filter(
      (target) =>
        target.type === "shared_worker" &&
        target.browserContextId === contextId &&
        target.url === url &&
        target.title === identity.name,
    );
    if (matches.length !== 1) {
      result.status = matches.length ? "ambiguous_target" : "no_target";
      return result;
    }
    targetId = matches[0]!.targetId;
    if (result.identity != null && safeId(targetId) != null) result.identity.workerTargetId = safeId(targetId);
    result.target = {
      attachedBeforeInspection: matches[0]!.attached,
      diagnosticAttachmentWaitingForDebugger: null,
      globalDebuggerPause: "unobserved",
    };
    const attachment = () => {
      attachmentPending = true;
      return source.send("Target.attachToTarget", { targetId: targetId!, flatten: false }).then(
        (value) => {
          attachmentPending = false;
          if (finished) void detachChild(source, value.sessionId).catch(() => undefined);
          return value;
        },
        (error: unknown) => {
          attachmentPending = false;
          throw error;
        },
      );
    };
    childId = (await step("attach_worker", attachment)).sessionId;
    const proof = attachments.get(childId);
    if (!proof?.authenticated) {
      stage = "attachment_identity";
      throw new Error("Attachment identity unavailable");
    }
    result.target.diagnosticAttachmentWaitingForDebugger = proof.waiting;
    const workerId = childId;
    const transport = wire;
    await step("enable_runtime", () => transport.command(workerId, "Runtime.enable"));
    result.status = "complete";
  } catch {
    result.status = "unavailable";
    result.failureStage = stage;
  } finally {
    finished = true;
    wire?.cancel();
    if (session == null && !creationSettled) result.cleanup.page = "pending_late_cleanup";
    if (childId == null && attachmentPending) result.cleanup.child = "pending_late_cleanup";
    if (session != null) {
      session.off("Target.attachedToTarget", attached);
      session.off("Target.receivedMessageFromTarget", received);
      if (childId != null) {
        result.cleanup.child = "unavailable";
        await detachChild(session, childId).then(
          () => {
            result.cleanup.child = "detached";
          },
          () => undefined,
        );
      }
      result.cleanup.page = "unavailable";
      await detachPage(session).then(
        () => {
          result.cleanup.page = "detached";
        },
        () => undefined,
      );
    }
  }
  return result;
}
