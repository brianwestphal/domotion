/**
 * Live PTY capture front-end for `domotion term -- <cmd …>` (DM-1226).
 *
 * The second front-end onto the DM-1225 terminal backend. Where `parseCast`
 * reads a recorded asciinema v2 `.cast`, this runs a command live in a
 * `node-pty` pseudo-terminal and accumulates the SAME `[time, "o", data]` output
 * event shape — then re-emits it as an asciinema v2 cast string so the rest of
 * the pipeline (`parseCast` → `buildFrames` → `castToAnimatedSvg`) is reused
 * verbatim. This file is the ONLY new code; rendering is unchanged.
 *
 * `node-pty` is a native (node-gyp / prebuilt) dependency, so it's an
 * `optionalDependencies` entry loaded behind a lazy `import()` — `--cast` users
 * never pay the native build, and a missing/broken install fails with an install
 * hint instead of a stack trace.
 *
 * One sharp edge we self-heal: on macOS/Linux, node-pty forks the child through a
 * small `spawn-helper` executable that ships inside its `prebuilds/<platform>-<arch>/`
 * dir. node-pty's own install scripts never `chmod +x` that prebuilt helper — they
 * rely on the npm tarball preserving the bit — so depending on how the package was
 * extracted the helper can land as `-rw-r--r--`. When that happens `pty.fork`'s
 * `posix_spawnp` on the helper fails with the opaque "posix_spawnp failed." and live
 * capture is dead-on-arrival (DM-1227). `ensureSpawnHelperExecutable()` restores the
 * bit before the first spawn so a stripped install heals itself.
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minimal shape of the bits of `node-pty` we use (avoids a type dep). */
interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: {
    name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv;
  }): PtyProcess;
}

export interface PtyCaptureOptions {
  /** Terminal columns. Default: the current TTY width, else 80. */
  cols?: number;
  /** Terminal rows. Default: the current TTY height, else 24. */
  rows?: number;
  /** Working directory for the child. Default: `process.cwd()`. */
  cwd?: string;
  /** Extra env vars merged onto `process.env`. */
  env?: Record<string, string>;
  /** Echo the child's output to this stream live so the user sees the session
   *  as it runs (default: `process.stdout`). Set null to suppress. */
  echo?: NodeJS.WritableStream | null;
  /** Forward this input stream to the child (interactive programs). Default:
   *  `process.stdin` when it's a TTY; set null to skip stdin forwarding. */
  input?: NodeJS.ReadStream | null;
  /** Optional progress log (stderr). */
  log?: (msg: string) => void;
}

export interface PtyCaptureResult {
  /** asciinema v2 cast text — feed straight into `castToAnimatedSvg`. */
  cast: string;
  /** The child's exit code. */
  exitCode: number;
  /** Columns / rows the session ran at. */
  cols: number;
  rows: number;
}

/**
 * Restore the executable bit on node-pty's prebuilt `spawn-helper` if it was lost
 * during install (see the file header). No-op on Windows (no helper) and when the
 * bit is already set. Best-effort: any failure (read-only install, missing file)
 * is swallowed — the subsequent spawn surfaces the real error with the install hint.
 */
export function ensureSpawnHelperExecutable(
  // Injectable for tests; defaults to resolving the installed node-pty package.
  resolvePackageDir: () => string | null = resolveNodePtyDir,
): void {
  if (process.platform === "win32") return;
  const pkgDir = resolvePackageDir();
  if (pkgDir == null) return;
  const candidates = [
    join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(pkgDir, "build", "Release", "spawn-helper"),
  ];
  for (const helper of candidates) {
    try {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      // Any of the execute bits (owner/group/other) missing → restore rwxr-xr-x.
      if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
    } catch {
      /* read-only or racing install — let the spawn report the real failure */
    }
  }
}

/** Locate the installed node-pty package directory, or null if unresolvable. */
function resolveNodePtyDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // Resolve the package.json so we get the package root regardless of "main".
    return dirname(require.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

async function loadNodePty(): Promise<PtyModule> {
  try {
    const mod = (await import("node-pty")) as unknown as { default?: PtyModule } & PtyModule;
    ensureSpawnHelperExecutable();
    return (mod.default ?? mod) as PtyModule;
  } catch (e) {
    throw new Error(
      "Live terminal capture (`domotion term -- <cmd>`) needs the optional `node-pty` "
      + "dependency, which isn't installed or failed to build.\n"
      + "Install it with:  npm install node-pty\n"
      + `(underlying error: ${(e as Error).message})`,
    );
  }
}

/**
 * Run `command` in a pseudo-terminal, streaming its output live while recording
 * every chunk as a timestamped `"o"` event, and return an asciinema v2 cast once
 * the child exits. stdin is forwarded (raw) for interactive programs and SIGWINCH
 * keeps the pty sized to the controlling TTY.
 */
export async function recordPtySession(
  command: string[],
  opts: PtyCaptureOptions = {},
  /** Injectable for tests (defaults to the lazy node-pty import). */
  ptyModule?: PtyModule,
): Promise<PtyCaptureResult> {
  if (command.length === 0) throw new Error("term: no command given after `--` (usage: domotion term -- <cmd …>)");
  const pty = ptyModule ?? (await loadNodePty());
  const cols = opts.cols ?? (process.stdout.columns || 80);
  const rows = opts.rows ?? (process.stdout.rows || 24);
  const echo = opts.echo === undefined ? process.stdout : opts.echo;
  const input = opts.input === undefined ? (process.stdin.isTTY ? process.stdin : null) : opts.input;

  const [file, ...args] = command;
  const term = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  });

  const events: Array<[number, "o", string]> = [];
  const start = nowMs();
  term.onData((data) => {
    events.push([(nowMs() - start) / 1000, "o", data]);
    echo?.write(data);
  });

  // Forward stdin (raw) so the captured program is interactive; resize the pty
  // when the controlling terminal resizes.
  const stdin = input as (NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }) | null;
  const wasRaw = stdin?.isRaw ?? false;
  const onStdin = (d: Buffer): void => term.write(d.toString("utf8"));
  const onResize = (): void => {
    const c = process.stdout.columns || cols;
    const r = process.stdout.rows || rows;
    try { term.resize(c, r); } catch { /* pty may have exited */ }
  };
  if (stdin != null) {
    if (stdin.isTTY && stdin.setRawMode != null) stdin.setRawMode(true);
    stdin.on("data", onStdin);
    stdin.resume();
    process.stdout.on?.("resize", onResize);
  }

  const exitCode: number = await new Promise((resolve) => {
    term.onExit(({ exitCode }) => resolve(exitCode));
  });

  // Restore stdin.
  if (stdin != null) {
    stdin.off?.("data", onStdin);
    if (stdin.isTTY && stdin.setRawMode != null) stdin.setRawMode(wasRaw);
    stdin.pause?.();
    process.stdout.off?.("resize", onResize);
  }

  const durationS = (nowMs() - start) / 1000;
  opts.log?.(`term: captured ${events.length} output event(s), ${durationS.toFixed(1)}s, exit ${exitCode}`);
  return { cast: buildCastText(cols, rows, command, events), exitCode, cols, rows };
}

/** asciinema v2 cast string from captured events — identical to what `parseCast` consumes. */
export function buildCastText(
  cols: number,
  rows: number,
  command: string[],
  events: Array<[number, "o", string]>,
): string {
  const header = JSON.stringify({ version: 2, width: cols, height: rows, command: command.join(" ") });
  const lines = [header, ...events.map((e) => JSON.stringify(e))];
  return lines.join("\n") + "\n";
}

// Wall-clock helper (kept tiny so tests can stub event times deterministically).
function nowMs(): number {
  return Date.now();
}
