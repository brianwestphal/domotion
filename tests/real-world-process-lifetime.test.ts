import { expect, it } from "vitest";
import {
  maySignalOriginalProcess,
  observeLinuxProcess,
  originalProcessExited,
  parseLinuxProcessStat,
} from "./real-world-process-lifetime.js";

const stat = (state = "S", start = "18446744073709551615", name = "chrome (headless) shell") => {
  const fields = Array<string>(24).fill("0");
  fields[0] = state;
  fields[19] = start;
  return `42 (${name}) ${fields.join(" ")}\n`;
};

it("parses after the final comm parenthesis and preserves field22 beyond JS integer precision", () => {
  expect(parseLinuxProcessStat(42, stat())).toEqual({
    pid: 42,
    state: "S",
    startTime: "18446744073709551615",
    status: "live",
  });
  expect(maySignalOriginalProcess(parseLinuxProcessStat(42, stat()), "18446744073709551615")).toBe(true);
});

it.each(["Z", "X"])("recognizes terminal %s without treating its allocated PID as live", (state) => {
  const observation = parseLinuxProcessStat(42, stat(state));
  expect(originalProcessExited(observation)).toBe(true);
  expect(maySignalOriginalProcess(observation, observation.startTime)).toBe(false);
});

it.each(["R", "S", "D", "T", "t", "I"])("keeps nonterminal %s failing the exit assertion", (state) => {
  expect(originalProcessExited(parseLinuxProcessStat(42, stat(state)))).toBe(false);
});

it("detects PID reuse by opaque start-time identity and never permits cleanup to signal it", async () => {
  const observation = await observeLinuxProcess(42, "100", async () => stat("S", "101"));
  expect(observation).toMatchObject({ status: "reused", startTime: "101" });
  expect(originalProcessExited(observation)).toBe(true);
  expect(maySignalOriginalProcess(observation, "100")).toBe(false);
});

it.each(["ENOENT", "ESRCH"])("treats an observed %s as gone", async (code) => {
  const observation = await observeLinuxProcess(42, "100", async () => {
    throw Object.assign(new Error("gone"), { code });
  });
  expect(observation).toEqual({ pid: 42, status: "gone" });
  expect(originalProcessExited(observation)).toBe(true);
});

it.each(["EACCES", "EPERM", "EIO"])("fails closed on %s and forbids cleanup signaling", async (code) => {
  const observation = await observeLinuxProcess(42, "100", async () => {
    throw Object.assign(new Error("unreadable"), { code });
  });
  expect(observation).toMatchObject({ status: "unknown", reason: "read-error", code });
  expect(originalProcessExited(observation)).toBe(false);
  expect(maySignalOriginalProcess(observation, "100")).toBe(false);
});

it.each(["", "42 (chrome) S 1 2", stat().replace("42 (", "43 ("), stat("?"), stat("S", "not-a-time")])(
  "fails closed on malformed stat %j",
  (raw) => {
    const observation = parseLinuxProcessStat(42, raw);
    expect(observation).toMatchObject({ status: "unknown", reason: "malformed-stat" });
    expect(originalProcessExited(observation)).toBe(false);
    expect(maySignalOriginalProcess(observation, "100")).toBe(false);
  },
);

it("does not permit signaling without a captured original start-time identity", () => {
  expect(maySignalOriginalProcess(parseLinuxProcessStat(42, stat()))).toBe(false);
});

it("bounds a pending read and retains an unknown failure instead of claiming exit", async () => {
  const observation = await observeLinuxProcess(42, "100", () => new Promise(() => {}), 10);
  expect(observation).toMatchObject({ status: "unknown", code: "ETIMEDOUT" });
  expect(originalProcessExited(observation)).toBe(false);
  expect(maySignalOriginalProcess(observation, "100")).toBe(false);
});

it.each([0, -1, 1.5, NaN])("rejects invalid PID %s before probing or permitting signals", async (pid) => {
  let read = false;
  const observation = await observeLinuxProcess(pid, "100", async () => {
    read = true;
    return stat();
  });
  expect(read).toBe(false);
  expect(observation.status).toBe("unknown");
  expect(originalProcessExited(observation)).toBe(false);
});
