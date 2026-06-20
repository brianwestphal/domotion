# 68 — Live terminal capture (`domotion term -- <cmd …>`)

DM-1226. The **second front-end** onto the terminal-capture backend introduced in
DM-1225 (doc [67](./67-terminal-capture.md)). Where `--cast` converts a recorded
asciinema file, this **runs a command live** in a pseudo-terminal, captures its
output, and renders the same animated SVG. It is a thin capture shim — the
emulation → settle-point frames → terminal HTML → animated-SVG pipeline is
shared verbatim with the `--cast` path; only the source of the event stream is
new.

## Usage

```sh
# Run a command live and capture it to an SVG (everything after `--` is the command):
domotion term -o build.svg -- npm test
domotion term --theme dark --cursor bar -- git clone https://example.com/repo.git

# Interactive programs work — stdin is forwarded:
domotion term -o vim.svg -- vim notes.md
```

- Everything after the first `--` is the command + its args, run verbatim (no
  shell unless you invoke one: `domotion term -- sh -c "a && b"`).
- The session is echoed to your terminal live as it runs, exactly as if you'd
  run the command directly — capture is transparent.
- On the child's exit, the recorded session is rendered and written to the
  output SVG. Default output is `term.svg` (stdout already carried the live
  session, so unlike `--cast` it is not the default sink).
- `--cast <file>` and a live `-- <cmd>` are mutually exclusive.
- Every DM-1225 render option applies unchanged: `--theme` / `--theme-file` /
  `--bg` / `--fg`, `--cursor` / `--cursor-color`, `--mode`, `--font-size` /
  `--font-family`, `--cols` / `--rows`, and the timing knobs (`--settle-ms`,
  `--min-frame-ms`, `--max-frame-ms`, `--tail-ms`). See doc 67 for each.

## Behavior

| Aspect | Behavior |
|--------|----------|
| Sizing | `--cols` / `--rows` override; otherwise the current TTY size (`process.stdout.columns/rows`), falling back to 80×24 when not a TTY. |
| stdin | Forwarded raw to the child when stdin is a TTY, so interactive programs (vim, prompts, REPLs) behave normally. |
| Resize | `SIGWINCH` (a terminal resize) is forwarded to the pty so wrapping stays correct mid-session. |
| Exit | Capture stops on child exit; the child's exit code is surfaced in the progress log. |
| Output | Each pty data chunk is recorded as a `[elapsedSeconds, "o", data]` event — the exact shape `parseCast` produces — and re-emitted as an asciinema v2 cast string fed straight into `castToAnimatedSvg`. |

## The `node-pty` dependency

Pseudo-terminal allocation requires [`node-pty`](https://github.com/microsoft/node-pty)
(1.1.0), a **native** module (prebuilt binaries for darwin/win32; node-gyp build
elsewhere). To keep the common `--cast` path free of a native build:

- `node-pty` is an **`optionalDependency`**, not a hard one.
- It is loaded behind a **lazy `import()`** in `src/terminal/pty.ts` — only the
  live path touches it. `--cast` users who never run `-- <cmd>` never load it.
- A missing / unbuilt install fails with an **install hint** (`npm install
  node-pty`) rather than a stack trace.

## Code

- **`src/terminal/pty.ts`** — `recordPtySession(command, opts, ptyModule?)`
  spawns the pty, streams + records output, forwards stdin, and returns
  `{ cast, exitCode, cols, rows }`. `buildCastText()` assembles the asciinema v2
  string. The `ptyModule` parameter is injectable so tests exercise the shim
  with a fake pty (no native dep, deterministic) — see `pty.test.ts`.
- **`src/cli/term.ts`** — `runTerm` splits `argv` on the first `--`; a non-empty
  command selects the live path (otherwise `--cast` is required), then both
  paths converge on the shared `castToAnimatedSvg`.

## Caveats / roadmap

- **Timing is real wall-clock.** A slow command produces a long animation; trim
  it with the timing knobs or post-process (compose the cast frame in an
  `animate` config, see doc 67 "Composing").
- **TTY-only stdin forwarding.** When stdin isn't a TTY (piped/CI), interactive
  programs that expect a terminal may behave differently; prefer `--cast` for
  reproducible CI captures.
- **No input events recorded.** Only `"o"` (output) events are captured, matching
  what the renderer consumes; keystrokes aren't separately timed (a typed
  command appears at the settle-point where its echo lands).
- Color emoji / wide glyphs / fallback fonts follow the same platform calibration
  caveats as the rest of the renderer (currently macOS-calibrated).
