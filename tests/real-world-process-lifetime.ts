import { readFile } from "node:fs/promises";

export interface LinuxProcessObservation {
  pid: number;
  status: "live" | "terminal" | "gone" | "reused" | "unknown";
  state?: string;
  /** /proc stat field 22 is an opaque identity token, not a JS number. */
  startTime?: string;
  reason?: "malformed-stat" | "read-error";
  code?: string;
}

/** Linux /proc ABI: pid, parenthesized comm, state, ... start_time (field 22).
 * comm can contain spaces and parentheses; never split the whole line.
 * https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories */
export function parseLinuxProcessStat(pid: number, stat: string): LinuxProcessObservation {
  const prefix = stat.match(/^([1-9]\d*)\s+\(/);
  const end = stat.lastIndexOf(")");
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    prefix?.[1] !== String(pid) ||
    end < (prefix?.[0].length ?? Infinity) ||
    !/^[A-Za-z]$/.test(fields[0] ?? "") ||
    !/^\d+$/.test(fields[19] ?? "")
  )
    return { pid, status: "unknown", reason: "malformed-stat" };
  const state = fields[0],
    startTime = fields[19];
  return { pid, state, startTime, status: state === "Z" || state === "X" ? "terminal" : "live" };
}

export async function observeLinuxProcess(
  pid: number,
  expectedStartTime?: string,
  readStat: (pid: number) => Promise<string> = (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  timeoutMs = 1_000,
): Promise<LinuxProcessObservation> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, status: "unknown", reason: "malformed-stat" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const stat = await Promise.race([
      readStat(pid),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("Process stat read timed out"), { code: "ETIMEDOUT" })),
          timeoutMs,
        );
      }),
    ]);
    const observation = parseLinuxProcessStat(pid, stat);
    if (expectedStartTime != null && observation.startTime != null && observation.startTime !== expectedStartTime)
      return { ...observation, status: "reused" };
    return observation;
  } catch (error) {
    const code =
      error != null && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return code === "ENOENT" || code === "ESRCH"
      ? { pid, status: "gone" }
      : { pid, status: "unknown", reason: "read-error", ...(code == null ? {} : { code }) };
  } finally {
    clearTimeout(timer);
  }
}

export const originalProcessExited = (observation: LinuxProcessObservation): boolean =>
  observation.status === "gone" || observation.status === "terminal" || observation.status === "reused";

/** Cleanup may signal only a currently live process with the original identity. */
export const maySignalOriginalProcess = (observation: LinuxProcessObservation, expectedStartTime?: string): boolean =>
  expectedStartTime != null && observation.status === "live" && observation.startTime === expectedStartTime;
