# Domotion: CLI invocation as an npm bin (`npx domotion-svg`)

Requirements for running Domotion's command-line interface without a local
clone — i.e. `npx domotion-svg …` against the published package. Origin:
DM-877.

## Problem

Domotion ships as the npm package `domotion-svg` and exposes a CLI. A consumer
who has not cloned the repo should be able to run the tool in one line:

```bash
npx domotion-svg capture https://example.com -o demo.svg
```

For that to work the package must (a) declare an executable bin, (b) ship the
compiled entry point in the published tarball, (c) carry a shebang so the OS
runs it under Node, and (d) report accurate metadata (`--version`). This doc is
the contract for that invocation surface.

## Invocation forms

All of these resolve to the single `domotion` bin:

| Form | Notes |
| --- | --- |
| `npx domotion-svg <cmd> …` | Package name ≠ bin name, but the package declares exactly one bin, so npx runs it. |
| `npx -p domotion-svg domotion <cmd> …` | Explicit bin name; equivalent. |
| `domotion <cmd> …` | After a global (`npm i -g domotion-svg`) or local (`node_modules/.bin/domotion`) install. |
| `npx tsx src/cli/index.ts <cmd> …` | Local dev from a clone (the `npm run capture` script). |

Subcommands and their flags are documented by `domotion --help`; they are out
of scope here. This doc covers only that the bin resolves, executes, and
reports correct top-level metadata.

## Package contract

- **`bin`** — `package.json` maps `"domotion": "dist/cli/index.js"`. Exactly
  one bin, so `npx domotion-svg` runs it without a name match.
- **Shebang** — `src/cli/index.ts` (and therefore the compiled
  `dist/cli/index.js`) begins with `#!/usr/bin/env node`. npm sets the
  executable bit on bin targets at pack/install time, so the committed file
  mode is irrelevant to consumers.
- **Build before publish** — `dist/` is gitignored; the published tarball is
  built by `npm run build` in the release CI (`.github/workflows/release.yml`)
  immediately before `npm publish`. The `files` allowlist includes `dist`, so
  the compiled entry point ships. **`package.json` is always included in an npm
  tarball regardless of `files`**, which the version read below relies on.
- **Version reporting** — `domotion --version` and the `--help` banner read the
  version from `package.json` at runtime via
  `createRequire(import.meta.url)("../../package.json")`, resolved relative to
  `dist/cli/index.js` (→ package root) and equally relative to
  `src/cli/index.ts` under `tsx`. **Do not reintroduce a hardcoded version
  literal** — it silently drifts from `package.json` (it had drifted to
  `0.1.0` while the package was at `0.5.0`).

## Runtime prerequisites

`npx domotion-svg` downloads and runs the package, but the tool itself needs:

- **Node.js 22+** — the engine the package targets.
- **A Playwright Chromium browser binary** — a separate download from the
  `@playwright/test` dependency. The CLI does **not** require the user to
  pre-install it: `launchChromium()` (`src/capture/index.ts`) catches the
  missing-browser launch error, runs `npx playwright install chromium`
  (stdio inherited so progress is visible), and retries — falling back to a
  clear "run it manually" message if the auto-install fails. First-run
  `capture` / `animate` therefore works from a cold machine, at the cost of a
  one-time browser download.

## Caveats / non-goals

- **Git-URL invocation is not supported.** `npx github:brianwestphal/domotion`
  would fetch the repo, where `dist/` is gitignored and there is no `prepare`
  script to build it on install — so the bin target would be missing. Only the
  **registry-published** form is a supported contract. Adding a `prepare`
  build step to support git installs is a deliberate open decision, not an
  oversight (it would run `tsc` + the capture-script bundler on every plain
  `npm install` in the repo). Tracked as a follow-up.
- **Tarball weight affects first-run latency.** `npx` downloads the whole
  tarball before the first run, so the published package ships only `dist/`
  (plus `README` / `LICENSE` / `FEATURES.md`) — not `src/`, and not the compiled
  test files: the published build uses `tsconfig.build.json`, which excludes
  `**/*.test.ts(x)` from `dist/` (DM-878). Tests are still type-checked by
  `npm run typecheck` (base `tsconfig.json`) and run from source by vitest. Net:
  ~136 files / 1.8 MB unpacked, down from ~361 / 5.3 MB.

## Verification

The npx path is verified by packing and installing the real tarball (what npx
does under the hood) rather than only running the local build:

```bash
TARBALL=$(npm pack | tail -1)
WORK=$(mktemp -d); (cd "$WORK" && npm init -y >/dev/null \
  && npm install "$OLDPWD/$TARBALL" >/dev/null \
  && ./node_modules/.bin/domotion --version)   # must print package.json's version
```

This asserts the bin shim is created, is executable, and reports the correct
version. A CI smoke test that does the same on each target platform is folded
into the cross-platform CI work (DM-262).
