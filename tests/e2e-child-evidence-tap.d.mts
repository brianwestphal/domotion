import type { ChildProcess } from "node:child_process";

export const CHILD_EVIDENCE_FLAG: "DOMOTION_E2E_CHILD_EVIDENCE";
export const SCREENSHOT_CAPTURE_FAILURE: RegExp;

export function evidenceDirectory(env?: NodeJS.ProcessEnv): string;

export interface ChildBrowserRecord {
  pid: number | undefined;
  executable: string;
  startedAt: string;
  exitedAt?: string;
  exit?: string;
  ring: {
    push(line: string): void;
    append(chunk: string): void;
    flush(): void;
    snapshot(): { lines: string[]; dropped: number; pending: string };
  };
}

export interface SpawnHost {
  spawn: (...args: never[]) => ChildProcess;
}

export function tapPlaywrightBrowsers(
  spawnHost: SpawnHost,
  clock?: () => Date,
  isLauncherCall?: () => boolean,
): () => ChildBrowserRecord[];

export function writeChildEvidence(input: {
  name: string;
  file: string | undefined;
  message: string;
  records: readonly ChildBrowserRecord[];
  directory: string;
  lane: string | undefined;
  pid: number;
  clock?: () => Date;
}): string;

export interface ChildProcessLike {
  pid: number;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: { write: (...args: never[]) => boolean };
  stderr: { write: (...args: never[]) => boolean };
  once(event: "exit", listener: (code: number) => void): unknown;
}

export function installChildBrowserEvidence(
  proc?: ChildProcessLike,
  spawnHost?: SpawnHost,
  clock?: () => Date,
): { matched: () => string | undefined; flush: () => string | undefined };
