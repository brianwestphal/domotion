import { describe, expect, it } from "vitest";
import {
  launchWithLinuxChild,
  linuxChildProcesses,
  parseLinuxProcStat,
  settleAbandonedLinuxBrowser,
  type LinuxProcStat,
} from "./linux-abandoned-browser.js";

// Fields after comm: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
// utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
const stat = (
  pid: number,
  comm: string,
  state: string,
  ppid: number,
  cpu: [number, number],
  threads = 1,
  start = 777,
) =>
  `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 -1 4194560 10 0 0 0 ${cpu[0]} ${cpu[1]} 0 0 20 0 ${threads} 0 ${start} 1000 10`;

const reader = (table: Record<string, string>, tasks: Record<number, string[]> = {}) => ({
  list: async () => Object.keys(table).map((path) => path.split("/")[2]!),
  stat: async (path: string) => {
    const value = table[path];
    if (value == null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  },
  tasks: async (pid: number) => tasks[pid] ?? [],
});

describe("linux abandoned-browser helpers", () => {
  it("parses /proc stat with spaces and parentheses inside comm", () => {
    expect(parseLinuxProcStat(stat(42, "headless (shell) x", "S", 7, [5, 6], 12, 999))).toEqual({
      pid: 42,
      comm: "headless (shell) x",
      state: "S",
      ppid: 7,
      cpuTicks: 11,
      threads: 12,
      startTime: "999",
    });
  });

  it("rejects truncated or malformed stat lines", () => {
    expect(parseLinuxProcStat("42 (x) S 7")).toBeUndefined();
    expect(parseLinuxProcStat("x (y) S 7 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 5")).toBeUndefined();
    expect(parseLinuxProcStat("")).toBeUndefined();
  });

  it("lists only live direct children of the parent", async () => {
    const table = {
      "/proc/10/stat": stat(10, "headless_shell", "S", process.pid, [1, 1]),
      "/proc/11/stat": stat(11, "headless_shell", "Z", process.pid, [1, 1]),
      "/proc/12/stat": stat(12, "zygote", "S", 10, [1, 1]),
    };
    expect((await linuxChildProcesses(process.pid, reader(table))).map((child) => child.pid)).toEqual([10]);
  });

  it("identifies exactly one new child, and none when the launch adds several", async () => {
    const table: Record<string, string> = { "/proc/10/stat": stat(10, "old", "S", process.pid, [1, 1]) };
    const one = await launchWithLinuxChild(async () => {
      table["/proc/20/stat"] = stat(20, "headless_shell", "S", process.pid, [1, 1]);
      return "browser";
    }, reader(table));
    expect(one).toMatchObject({ value: "browser", child: { pid: 20 } });
    const two = await launchWithLinuxChild(async () => {
      table["/proc/30/stat"] = stat(30, "a", "S", process.pid, [1, 1]);
      table["/proc/31/stat"] = stat(31, "b", "S", process.pid, [1, 1]);
      return "ambiguous";
    }, reader(table));
    expect(two).toEqual({ value: "ambiguous" });
  });

  const child: LinuxProcStat = {
    pid: 50,
    comm: "headless_shell",
    state: "S",
    ppid: process.pid,
    cpuTicks: 0,
    threads: 1,
    startTime: "777",
  };
  const noSleep = async () => {};

  it("reports a cleanly closed browser as gone without signaling", async () => {
    const kills: number[] = [];
    const report = await settleAbandonedLinuxBrowser(child, {
      reader: reader({}),
      kill: (pid) => kills.push(pid),
      sleep: noSleep,
    });
    expect(report).toEqual({ pid: 50, status: "gone", signaled: false });
    expect(kills).toEqual([]);
  });

  it("never signals a reused pid or a terminal process", async () => {
    const kills: number[] = [];
    const options = { kill: (pid: number) => void kills.push(pid), sleep: noSleep };
    const reused = await settleAbandonedLinuxBrowser(child, {
      ...options,
      reader: reader({ "/proc/50/stat": stat(50, "other", "S", 1, [0, 0], 1, 888) }),
    });
    expect(reused.status).toBe("reused");
    const zombie = await settleAbandonedLinuxBrowser(child, {
      ...options,
      reader: reader({ "/proc/50/stat": stat(50, "headless_shell", "Z", process.pid, [0, 0]) }),
    });
    expect(zombie).toMatchObject({ status: "terminal", state: "Z", signaled: false });
    expect(kills).toEqual([]);
  });

  it("samples CPU and thread states of a live browser, then kills its process group", async () => {
    const table: Record<string, string> = {
      "/proc/50/stat": stat(50, "headless_shell", "R", process.pid, [100, 20], 3),
      "/proc/50/task/50/stat": stat(50, "headless_shell", "R", process.pid, [0, 0]),
      "/proc/50/task/51/stat": stat(51, "Chrome_IOThread", "S", process.pid, [0, 0]),
      "/proc/50/task/52/stat": stat(52, "ThreadPool", "S", process.pid, [0, 0]),
    };
    const kills: Array<[number, string]> = [];
    const report = await settleAbandonedLinuxBrowser(child, {
      reader: reader(table, { 50: ["50", "51", "52"] }),
      kill: (pid, signal) => void kills.push([pid, signal]),
      sleep: async () => {
        table["/proc/50/stat"] = stat(50, "headless_shell", "R", process.pid, [118, 22], 3);
      },
    });
    expect(report).toEqual({
      pid: 50,
      status: "live",
      state: "R",
      threads: 3,
      cpuTicksInSample: 20,
      sampleMs: 250,
      threadStates: { R: 1, S: 2 },
      signaled: true,
    });
    expect(kills).toEqual([[-50, "SIGKILL"]]);
  });

  it("falls back to the single pid when the group signal fails, and reports exit during the sample", async () => {
    const table: Record<string, string> = {
      "/proc/50/stat": stat(50, "headless_shell", "S", process.pid, [1, 1]),
    };
    const kills: number[] = [];
    const report = await settleAbandonedLinuxBrowser(child, {
      reader: reader(table),
      kill: (pid) => {
        kills.push(pid);
        if (pid < 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
      },
      sleep: noSleep,
    });
    expect(report.signaled).toBe(true);
    expect(kills).toEqual([-50, 50]);

    const exiting = await settleAbandonedLinuxBrowser(child, {
      reader: reader(table),
      kill: () => kills.push(0),
      sleep: async () => {
        delete table["/proc/50/stat"];
      },
    });
    expect(exiting).toEqual({ pid: 50, status: "gone", signaled: false });
    expect(kills).toEqual([-50, 50]);
  });
});
