import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_LIMIT = 32 * 1024;
class BoundedLog {
  private prefix = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  append(chunk: Buffer): void {
    this.total += chunk.length;
    const take = Math.min(LOG_LIMIT / 2 - this.prefix.length, chunk.length);
    if (take > 0) this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, take)]);
    this.tail = Buffer.concat([this.tail, chunk.subarray(take)]).subarray(-LOG_LIMIT / 2);
  }
  snapshot() {
    const retainedBytes = this.prefix.length + this.tail.length;
    const truncated = this.total > retainedBytes;
    return {
      totalBytes: this.total,
      retainedBytes,
      truncated,
      text:
        this.prefix.toString("utf8") + (truncated ? "\n[owned output truncated]\n" : "") + this.tail.toString("utf8"),
    };
  }
}
export interface OwnedUiServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  shutdownForceMs?: number;
  nodeExecutable?: string;
}
export type OwnedUiServerDiagnostics = ReturnType<typeof diagnosticShape>;
function diagnosticShape() {
  return {
    pid: undefined as number | undefined,
    node: "",
    closed: false,
    exitCode: null as number | null,
    signal: null as NodeJS.Signals | null,
    stopRequested: false,
    shutdownAcknowledged: false,
    escalated: false,
    spawnError: "",
    controlError: "",
    cleanupError: "",
    command: [] as string[],
    stdout: new BoundedLog().snapshot(),
    stderr: new BoundedLog().snapshot(),
  };
}
export interface OwnedUiServer {
  url: string;
  diagnostics(): OwnedUiServerDiagnostics;
  close(): Promise<OwnedUiServerDiagnostics>;
}
export class OwnedUiServerError extends Error {
  constructor(
    readonly reason: string,
    readonly diagnostics: OwnedUiServerDiagnostics,
  ) {
    super(`Owned UI server ${reason}: ${JSON.stringify(diagnostics)}`);
    this.name = "OwnedUiServerError";
  }
}

/** Own the actual Node service, not an npx wrapper; retain bounded failure evidence. */
export async function startOwnedUiServer(
  script: string,
  args: string[],
  options: OwnedUiServerOptions = {},
): Promise<OwnedUiServer> {
  const startupMs = options.startupTimeoutMs ?? 60_000;
  const graceMs = options.shutdownGraceMs ?? 6_000;
  const forceMs = options.shutdownForceMs ?? 2_000;
  if (![startupMs, graceMs, forceMs].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Owned server deadlines must be positive");
  const command = [
    options.nodeExecutable ?? process.execPath,
    "--import",
    "tsx",
    "--import",
    new URL("./owned-ui-server-bootstrap.mjs", import.meta.url).href,
    script,
    ...args,
  ];
  const proc = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd ?? resolve(fileURLToPath(new URL("..", import.meta.url))),
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const state = diagnosticShape();
  state.pid = proc.pid;
  state.command = command;
  const stdout = new BoundedLog(),
    stderr = new BoundedLog();
  const diagnostics = () => ({ ...state, stdout: stdout.snapshot(), stderr: stderr.snapshot() });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((done) => {
    resolveClosed = done;
  });
  let resolveReady!: (url: string) => void, rejectReady!: (error: Error) => void;
  let settled = false,
    authenticated = false,
    candidate: string | undefined;
  const ready = new Promise<string>((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  const finish = (reason?: string) => {
    if (settled) return;
    if (reason == null && (!authenticated || candidate == null)) return;
    settled = true;
    clearTimeout(timer);
    if (reason != null) rejectReady(new Error(reason));
    else resolveReady(candidate!);
  };
  const timer = setTimeout(() => finish("startup-timeout"), startupMs);
  const carry = { stdout: "", stderr: "" };
  const oversized = { stdout: false, stderr: false };
  const scan = (which: "stdout" | "stderr", chunk: Buffer) => {
    (which === "stdout" ? stdout : stderr).append(chunk);
    const text = carry[which] + chunk.toString("utf8");
    let start = 0;
    let discard = oversized[which];
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      const line = text.slice(start, end);
      start = end + 1;
      const skip = discard || line.length > 4096;
      discard = false;
      if (settled || skip) continue;
      const match =
        /^\s*(?:svg-scrubber running at )?(https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)(?:\/[^\s]*)?)\s*$/.exec(line);
      if (match == null) continue;
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        finish("invalid-ready-port");
        continue;
      }
      candidate = new URL(match[1]!).origin;
      finish();
    }
    const remainder = text.slice(start);
    oversized[which] = discard || remainder.length > 4096;
    carry[which] = remainder.slice(-4096);
  };
  proc.stdout!.on("data", (chunk: Buffer) => scan("stdout", chunk));
  proc.stderr!.on("data", (chunk: Buffer) => scan("stderr", chunk));
  proc.on("message", (message: unknown) => {
    if (
      message == null ||
      typeof message !== "object" ||
      !("pid" in message) ||
      message.pid !== proc.pid ||
      !("type" in message)
    )
      return;
    if (message.type === "domotion-owned-ui-ready-v1") {
      authenticated = true;
      state.node = "node" in message && typeof message.node === "string" ? message.node : "";
      finish();
    } else if (message.type === "domotion-owned-ui-stopping-v1") state.shutdownAcknowledged = true;
  });
  proc.on("error", (error) => {
    state.spawnError = error.message.slice(0, 4096);
    finish("spawn-error");
  });
  proc.once("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });
  proc.once("close", (code, signal) => {
    state.closed = true;
    state.exitCode = code;
    state.signal = signal;
    finish("exited-before-ready");
    resolveClosed();
  });
  const waitClosed = async (ms: number) => {
    if (state.closed) return true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<false>((done) => {
          deadline = setTimeout(() => done(false), ms);
        }),
      ]);
    } finally {
      if (deadline != null) clearTimeout(deadline);
    }
  };
  let closing: Promise<OwnedUiServerDiagnostics> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const unexpected = state.closed;
      state.stopRequested = true;
      if (!state.closed) {
        if (proc.connected)
          proc.send({ type: "domotion-owned-ui-stop-v1" }, (error) => {
            if (error) state.controlError = error.message.slice(0, 1024);
          });
        else {
          state.controlError = "owned IPC channel unavailable";
          proc.kill("SIGTERM");
        }
        if (!(await waitClosed(graceMs))) {
          state.escalated = true;
          proc.kill("SIGKILL");
          if (!(await waitClosed(forceMs))) throw new OwnedUiServerError("cleanup-not-closed", diagnostics());
        }
      }
      if (unexpected) throw new OwnedUiServerError("exited-before-cleanup", diagnostics());
      if (state.escalated || state.controlError !== "")
        throw new OwnedUiServerError("graceful-cleanup-failed", diagnostics());
      if (state.exitCode !== 0 || state.signal !== null)
        throw new OwnedUiServerError("shutdown-exit-failed", diagnostics());
      return diagnostics();
    })());
  try {
    return { url: await ready, diagnostics, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      state.cleanupError = cleanup instanceof OwnedUiServerError ? cleanup.reason : "cleanup-failed";
    }
    throw new OwnedUiServerError(error instanceof Error ? error.message : "startup-failed", diagnostics());
  }
}
