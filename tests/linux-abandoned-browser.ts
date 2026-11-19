import { readdir, readFile } from "node:fs/promises";

/**
 * Linux-only evidence and cleanup for a Chromium whose Playwright close was
 * abandoned at a teardown deadline. `chromium.launch()` exposes no process
 * handle, so the browser is identified as the new direct child of this Node
 * process (Playwright's in-process launcher spawns it with `detached: true`,
 * making it its own process-group leader).
 *
 * Why it exists: on the GitHub x64 runner a `--single-process` headless shell
 * routinely ignores `browser.close()` for the whole 4 s deadline, and the
 * still-running browser coincided with a slow next launch in the same test
 * (newPage 250-1000 ms instead of ~30 ms) and, twice, a capture that never
 * finished in 10 s. Killing the abandoned group isolates later arms and the
 * report records what the stuck process was doing first.
 */

export interface LinuxProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  threads: number;
  /** /proc stat field 22: opaque identity token. */
  startTime: string;
}

/** Linux /proc/<pid>/stat: comm is parenthesized and may contain spaces or
 * parentheses, so fields are split only after the LAST ')'. */
export function parseLinuxProcStat(stat: string): LinuxProcStat | undefined {
  const open = stat.indexOf(" (");
  const close = stat.lastIndexOf(")");
  if (open <= 0 || close < open) return undefined;
  const pid = Number(stat.slice(0, open));
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // After the comm: [0]=state [1]=ppid ... [11]=utime [12]=stime ... [17]=num_threads [19]=starttime
  const [state, ppid, utime, stime, threads, startTime] = [0, 1, 11, 12, 17, 19].map((i) => fields[i]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[A-Za-z]$/.test(state ?? "")) return undefined;
  if (![ppid, utime, stime, threads, startTime].every((value) => /^\d+$/.test(value ?? ""))) return undefined;
  return {
    pid,
    comm: stat.slice(open + 2, close),
    state: state!,
    ppid: Number(ppid),
    cpuTicks: Number(utime) + Number(stime),
    threads: Number(threads),
    startTime: startTime!,
  };
}

export interface LinuxProcReader {
  list(): Promise<string[]>;
  stat(path: string): Promise<string>;
}

const procReader: LinuxProcReader = {
  list: () => readdir("/proc"),
  stat: (path) => readFile(path, "utf8"),
};

async function readStat(path: string, reader: LinuxProcReader): Promise<LinuxProcStat | undefined> {
  try {
    return parseLinuxProcStat(await reader.stat(path));
  } catch {
    return undefined;
  }
}

/** Direct, non-terminal children of `parentPid`. */
export async function linuxChildProcesses(
  parentPid: number = process.pid,
  reader: LinuxProcReader = procReader,
): Promise<LinuxProcStat[]> {
  const entries = (await reader.list()).filter((name) => /^\d+$/.test(name));
  const stats = await Promise.all(entries.map((pid) => readStat(`/proc/${pid}/stat`, reader)));
  return stats.filter(
    (stat): stat is LinuxProcStat =>
      stat != null && stat.ppid === parentPid && stat.state !== "Z" && stat.state !== "X",
  );
}

/** Run `launch` and return the one new direct child it spawned, if exactly one appeared. */
export async function launchWithLinuxChild<T>(
  launch: () => Promise<T>,
  reader: LinuxProcReader = procReader,
): Promise<{ value: T; child?: LinuxProcStat }> {
  const before = new Set((await linuxChildProcesses(process.pid, reader)).map((child) => child.pid));
  const value = await launch();
  const added = (await linuxChildProcesses(process.pid, reader)).filter((child) => !before.has(child.pid));
  return added.length === 1 ? { value, child: added[0] } : { value };
}

export interface AbandonedBrowserReport {
  pid: number;
  status: "gone" | "reused" | "terminal" | "live";
  state?: string;
  threads?: number;
  /** CPU ticks the process consumed during the sample window; a spinning
   * shutdown shows tens of ticks per 250 ms, a blocked one ~0. */
  cpuTicksInSample?: number;
  sampleMs?: number;
  /** Per-thread scheduler states (R running, S sleeping, D uninterruptible...). */
  threadStates?: Record<string, number>;
  signaled: boolean;
}

export interface SettleOptions {
  sampleMs?: number;
  reader?: LinuxProcReader & { tasks(pid: number): Promise<string[]> };
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Describe the original browser process (if it still lives) and SIGKILL its group. */
export async function settleAbandonedLinuxBrowser(
  child: LinuxProcStat,
  {
    sampleMs = 250,
    reader = { ...procReader, tasks: (pid) => readdir(`/proc/${pid}/task`) },
    kill = (pid, signal) => process.kill(pid, signal),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: SettleOptions = {},
): Promise<AbandonedBrowserReport> {
  const observe = async (): Promise<LinuxProcStat | "gone" | "reused"> => {
    const stat = await readStat(`/proc/${child.pid}/stat`, reader);
    if (stat == null) return "gone";
    return stat.startTime === child.startTime ? stat : "reused";
  };
  const first = await observe();
  if (typeof first === "string") return { pid: child.pid, status: first, signaled: false };
  if (first.state === "Z" || first.state === "X")
    return { pid: child.pid, status: "terminal", state: first.state, signaled: false };
  await sleep(sampleMs);
  const second = await observe();
  if (typeof second === "string") return { pid: child.pid, status: second, signaled: false };
  const threadStates: Record<string, number> = {};
  const tasks = await reader.tasks(child.pid).catch(() => [] as string[]);
  for (const tid of tasks) {
    const task = await readStat(`/proc/${child.pid}/task/${tid}/stat`, reader);
    if (task != null) threadStates[task.state] = (threadStates[task.state] ?? 0) + 1;
  }
  let signaled = false;
  // The identity was re-read just above; Playwright made the pid a group leader.
  for (const target of [-child.pid, child.pid]) {
    try {
      kill(target, "SIGKILL");
      signaled = true;
      break;
    } catch {
      // ESRCH on the group falls through to the single pid.
    }
  }
  return {
    pid: child.pid,
    status: "live",
    state: second.state,
    threads: second.threads,
    cpuTicksInSample: second.cpuTicks - first.cpuTicks,
    sampleMs,
    threadStates,
    signaled,
  };
}
