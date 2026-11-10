export const CLEANUP_PROGRESS_MAX_BYTES = 2 * 1024 * 1024;
export const CLEANUP_PROGRESS_RESERVE_BYTES = 2048;
export const CLEANUP_PROGRESS_MAX_COMMANDS = 4096;
export const CLEANUP_GIT_OPERATIONS = new Set([
  "init",
  "config",
  "add",
  "commit",
  "worktree",
  "rev-parse",
  "merge",
  "cherry-pick",
  "switch",
  "remote",
  "push",
  "status",
  "ls-files",
  "merge-base",
  "ls-remote",
  "for-each-ref",
  "stash",
  "update-index",
  "update-ref",
  "show",
  "diff",
  "cat-file",
  "check-ref-format",
  "rev-list",
  "symbolic-ref",
]);
const phases = new Set(["start", "returned", "threw", "fixture", "seed-cleanup", "gate"]);
const steps = new Set([
  "start",
  "returned",
  "threw",
  "copy-start",
  "copy-returned",
  "copy-threw",
  "cleanup-start",
  "cleanup-returned",
  "cleanup-threw",
]);
const gates = new Set(["build", "typecheck", "lint", "test"]);
const milliseconds = (value) => Math.round(value * 100) / 100;

/**
 * Test-only synchronous trace. A cap never changes native execution or retries.
 * @param {{enabled: boolean, write: (line: string) => void, now?: () => number, maxBytes?: number}} options
 */
export function createCleanupTestProgress({
  enabled,
  write,
  now = () => performance.now(),
  maxBytes = CLEANUP_PROGRESS_MAX_BYTES,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > CLEANUP_PROGRESS_MAX_BYTES)
    throw new Error("Invalid cleanup trace budget");
  const started = enabled ? now() : 0;
  let bytes = 0,
    records = 0,
    omittedRecords = 0,
    byteBudgetExhausted = false,
    nativeCommandLimitReached = false,
    writeFailed = false,
    capReported = false;
  const terminal = new Set();
  const snapshot = () => ({
    maxBytes,
    bytes,
    records,
    omittedRecords,
    truncated: omittedRecords > 0 || writeFailed,
    byteBudgetExhausted,
    nativeCommandLimitReached,
    writeFailed,
  });
  const summary = () => {
    const { bytes, records, ...rest } = snapshot();
    return { ...rest, bytesBeforeRecord: bytes, recordsBeforeRecord: records };
  };
  const elapsed = () => milliseconds(Math.max(0, now() - started));
  const output = (value, reserved = false) => {
    if (!enabled || writeFailed) return false;
    const line = `[cleanup-test] ${JSON.stringify(value)}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > maxBytes - (reserved ? 0 : CLEANUP_PROGRESS_RESERVE_BYTES)) return false;
    try {
      write(line);
      bytes += size;
      records++;
      return true;
    } catch {
      writeFailed = true;
      return false;
    }
  };
  const omitted = (reason) => {
    omittedRecords++;
    if (!capReported && !writeFailed) {
      capReported = true;
      output({ phase: "trace-truncated", reason, elapsedMs: elapsed(), trace: summary() }, true);
    }
    return false;
  };
  /** @param {Record<string, unknown>} value */
  const emit = (value) => {
    if (!enabled || writeFailed) return false;
    const phase = value.phase;
    if (phase === "complete" || phase === "process-exit") {
      if (terminal.has(phase)) return false;
      terminal.add(phase);
      const final = { phase };
      if (phase === "complete" && Number.isSafeInteger(value.nativeCommands))
        final.nativeCommands = value.nativeCommands;
      if (phase === "process-exit" && Number.isSafeInteger(value.status)) final.status = value.status;
      return output({ ...final, elapsedMs: elapsed(), trace: summary() }, true);
    }
    // After the byte cap, normal events do no encoding, clock read or write.
    if (byteBudgetExhausted) {
      omittedRecords++;
      return false;
    }
    if (!phases.has(phase)) return omitted("invalid-phase");
    if (typeof value.nativeCommand === "number" && value.nativeCommand > CLEANUP_PROGRESS_MAX_COMMANDS) {
      nativeCommandLimitReached = true;
      return omitted("native-command-limit");
    }
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "phase") safe[key] = phase;
      else if (key === "operation" && (CLEANUP_GIT_OPERATIONS.has(item) || item === "node" || item === "other"))
        safe[key] = item;
      else if (key === "case" && typeof item === "string") safe[key] = item.slice(0, 192);
      else if (key === "step" && steps.has(item)) safe[key] = item;
      else if (key === "command" && gates.has(item)) safe[key] = item;
      else if (["nativeCommand", "nativeCommands", "childPid"].includes(key) && Number.isSafeInteger(item) && item >= 0)
        safe[key] = item;
      else if (key === "durationMs" && typeof item === "number" && Number.isFinite(item) && item >= 0)
        safe[key] = milliseconds(item);
      else if (
        key === "status" &&
        (item === null || Number.isSafeInteger(item) || item === "gate_running" || item === "gate_passed")
      )
        safe[key] = item;
      else if (key === "signal" && (item === null || (typeof item === "string" && /^SIG[A-Z0-9]{1,16}$/.test(item))))
        safe[key] = item;
      else if (key === "error" && typeof item === "string" && /^[A-Z0-9_]{1,64}$/.test(item)) safe[key] = item;
    }
    if (output({ ...safe, elapsedMs: elapsed() })) return true;
    if (!writeFailed) byteBudgetExhausted = true;
    return omitted("byte-budget");
  };
  if (enabled)
    output({
      phase: "process-start",
      schema: "domotion-cleanup-test-progress-v2",
      pid: process.pid,
      parentPid: process.ppid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
    });
  return { emit, snapshot };
}
