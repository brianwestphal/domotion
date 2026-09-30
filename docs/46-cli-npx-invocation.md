---
id: "requirements/cli-npx-invocation"
title: "Domotion: CLI invocation as an npm bin (npx -p domotion-svg domotion)"
kind: "contract"
status: "current"
owners: ["product-tooling"]
platforms: []
tickets: ["DM-1362", "DM-262", "DM-877", "DM-878", "DM-T239R3", "DM-VESM0M"]
code:
  [
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    "scripts/check-pack-contents.mjs",
    "scripts/pack-install-smoke.mjs",
    "scripts/prepare-git-install.mjs",
    "assets/git-install-postinstall.mjs",
    "src/capture/index.ts",
    "src/cli/index.ts",
    "src/cli/common.ts",
    "src/templates/lazy-renderer.ts",
  ]
aliases: ["docs/46-cli-npx-invocation.md", "doc-46"]
---

# Domotion: CLI invocation as an npm bin (`npx -p domotion-svg domotion`)

Requirements for running Domotion's command-line interface without a local
clone, from the published package or a Git commit. Origin: DM-877.

## Problem

Domotion ships as the npm package `domotion-svg` and exposes a CLI. A consumer
who has not cloned the repo should be able to run the tool in one line:

```bash
npx -p domotion-svg domotion capture https://example.com -o demo.svg
```

For that to work the package must (a) declare an executable bin, (b) ship the
compiled entry point in the published tarball, (c) carry a shebang so the OS
runs it under Node, and (d) report accurate metadata (`--version`). This doc is
the contract for that invocation surface.

## Invocation forms

The package declares **six** bins (`domotion`, `svg-to-video`, `svg-to-image`,
`svg-review`, `svg-scrubber`, `domotion-studio`), none of which is named `domotion-svg`.
npx only auto-runs a package's bin when the package declares exactly one, or one
whose name matches the requested command — neither holds here — so the bin to
run must be named explicitly:

| Form                                                             | Notes                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx -p domotion-svg domotion <cmd> …`                           | **Canonical zero-install form.** `-p` installs the package, `domotion` selects the bin. Swap `domotion` for `svg-to-video` / `svg-review` / `svg-to-image` / `svg-scrubber` / `domotion-studio` to run the other bins.                                        |
| `npx -p github:brianwestphal/domotion#<commit> domotion <cmd> …` | **Git-source form.** Pin a commit for reproducibility; npm builds the checked-out source before installing it. All six bins can be named after `-p`.                                                                                                          |
| `npx domotion-svg <cmd> …`                                       | **Does NOT work** — with six bins and none matching the package name, npx can't pick one and errors `could not determine executable to run`. (It resolved while the package shipped a single `domotion` bin; adding more bins broke the bare form — DM-1362.) |
| `domotion <cmd> …`                                               | After a global (`npm i -g domotion-svg`) or local (`node_modules/.bin/domotion`) install. The install links all six bins by name.                                                                                                                             |
| `npx tsx src/cli/index.ts <cmd> …`                               | Local dev from a clone (the `npm run capture` script).                                                                                                                                                                                                        |

Subcommands and their flags are documented by `domotion --help`; they are out
of scope here. This doc covers only that the bin resolves, executes, and
reports correct top-level metadata.

## CLI phase and error contract

Each bin and `domotion` verb parses its arguments before running work. Its
parser validates flags, config shape, and other invocation inputs without
launching Chromium or a local server. The shared `runBin` harness reports a
parse failure with exit code 2 and a failure during execution with exit code 1.
Help exits successfully without starting work. The template renderer used by
animate, composite, and storyboard loads only when a template source is used.

## Package contract

- **`bin`** — `package.json` maps `"domotion": "dist/cli/index.js"` plus five
  more bins (`svg-to-video`, `svg-to-image`, `svg-review`, `svg-scrubber`,
  `domotion-studio`). Because there are multiple bins and none matches the
  package name `domotion-svg`, the bin must be named explicitly
  (`npx -p domotion-svg domotion …`); the bare `npx domotion-svg …` no longer
  auto-resolves (DM-1362).
- **Shebang** — `src/cli/index.ts` (and therefore the compiled
  `dist/cli/index.js`) begins with `#!/usr/bin/env node`. npm sets the
  executable bit on bin targets at pack/install time, so the committed file
  mode is irrelevant to consumers.
- **Clean build before pack or publish** — `dist/` is gitignored. `npm run
build` removes it before compiling, then checks that every emitted `.js` and
  `.d.ts` maps exactly to one current, publishable source module. The npm
  `prepack` lifecycle runs that clean build for local `npm pack` and for
  `npm publish`, in addition to the explicit release-CI build. Compiled tests,
  test-support modules, deleted-source leftovers, and missing declaration/JS
  pairs therefore fail before a tarball is accepted. The `files` allowlist
  includes `dist`, so the compiled entry point ships. **`package.json` is
  always included in an npm tarball regardless of `files`**, which the version
  read below relies on.
- **Git-source build** — npm clones Git dependencies and runs their `prepare`
  script before packing them. `prepare-git-install.mjs` builds when any package
  entry point is missing; this happens in a clean Git checkout because `dist/`
  is ignored. A local install after a build can reuse its artifacts. `prepack`
  still performs a clean build for release tarballs. Git-source installs fetch
  dev dependencies and run the generators and TypeScript compiler on the
  consumer's machine, so they take longer than registry installs. npm's Git
  install path drops the private bundled workspace even though `npm pack` of
  the same Git ref retains it. During npm's temporary Git staging, `prepare`
  places a built copy under `assets/git-install/`. The package's `postinstall`
  step places it in `node_modules/@domotion/text-engine`. Registry installs run
  the same short hook, which does nothing when no Git payload is present. The
  root declares the workspace's runtime dependencies so npm installs them
  even when it drops the bundle. A normal local install keeps npm's workspace
  link, and the published tarball does not carry the extra Git payload.
- **No host-local helper artifacts in the tarball** — the bundled
  `@domotion/text-engine` workspace ships `tools/` for the helper _sources_, but
  built glyph helpers and the acquired ICU companion (`domotion-icu`,
  `icudtl.dat`) are gitignored per helper directory, and npm-packlist honors a
  directory's `.gitignore`, so they stay out of the tarball even on a machine
  that has them. `npm run check:pack-contents`
  (`scripts/check-pack-contents.mjs`) enforces it: any gitignored file in the
  `npm pack --dry-run` listing outside `dist/` and
  `packages/text-engine/dist/` fails. It runs as `prepublishOnly` and in the
  `ci.yml` build and `release.yml` dry-run jobs, which first seed placeholder
  helper files so a fresh checkout still exercises the exclusion.
- **Version reporting** — `domotion --version` and the `--help` banner read the
  version from `package.json` at runtime via
  `createRequire(import.meta.url)("../../package.json")`, resolved relative to
  `dist/cli/index.js` (→ package root) and equally relative to
  `src/cli/index.ts` under `tsx`. **Do not reintroduce a hardcoded version
  literal** — it silently drifts from `package.json` (it had drifted to
  `0.1.0` while the package was at `0.5.0`).

## Runtime prerequisites

`npx -p domotion-svg domotion` downloads and runs the package, but the tool
itself needs:

- **Node.js 22+** — the runtime the package targets. `package.json` currently
  has no `engines` field, so npm does not enforce this floor at install time;
  the CLI and test infrastructure are validated on Node 22+.
- **A Playwright Chromium browser binary** — a separate download from the
  `@playwright/test` dependency. The CLI does **not** require the user to
  pre-install it: `launchChromium()` (`src/capture/index.ts`) catches the
  missing-browser launch error, runs `npx playwright install chromium`
  (stdio inherited so progress is visible), and retries — falling back to a
  clear "run it manually" message if the auto-install fails. First-run
  `capture` / `animate` therefore works from a cold machine, at the cost of a
  one-time browser download.

## Caveats

- **A Git URL still needs an explicit bin.** `npx github:brianwestphal/domotion`
  cannot select among six bins; use `npx -p github:brianwestphal/domotion#<commit>
domotion …`. The Git checkout's build requires the package's development
  dependencies and may fetch native helper inputs. The Playwright Chromium
  browser remains a separate first-run download.
- **Tarball weight affects first-run latency.** `npx` downloads the whole
  tarball before the first run, so the published package's `files` allowlist is
  kept tight: `dist`, `assets`, `schemas`, `llms.txt`, `README.md`, `LICENSE`,
  `FEATURES.md` — not `src/`, and not the compiled
  test files: the published build uses `tsconfig.build.json`, which excludes
  `**/*.test.ts(x)` from `dist/` (DM-878). Tests are still type-checked by
  `npm run typecheck` (base `tsconfig.json`) and run from source by vitest. The
  v0.29.0 clean dry-run contains 667 entries, about 3.4 MB packed / 12.4 MB
  unpacked, with no compiled tests, test-support modules, or deleted-source
  artifacts.

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
version. `npm run smoke:pack-install` (`scripts/pack-install-smoke.mjs`)
automates and extends it: after `npm run build` it packs the tarball, installs
the `.tgz` into an empty project with a clean npm cache, imports `domotion-svg`
and each curated subpath (`/capture`, `/scroll`, `/render`, `/animation`, `/tree-ops`, `/templates`, `/studio`,
`/post-processing`) and checks every subpath binding is the root's own, resolves every dependency of the bundled
`@domotion/text-engine` workspace from inside the installed copy (e.g.
`unicode-properties`, which is not a root dependency), checks the installed
CLI's `--version`, and renders a small text fixture through the installed
`domotion capture` with the consumer's own Playwright Chromium. Because the
workspace is private, dropping it from `bundledDependencies` makes the install
fail with a registry 404, so the bundled-dependency publish path is proven
before every release: the smoke runs in `release.yml`'s `npm-dry-run`
preflight (a prerequisite of the publish jobs) and in `ci.yml`'s `build` job,
on Linux. Per-platform install smoke on macOS/Windows runners is not yet
wired.

`npm run smoke:git-install` uses the same consumer assertions but installs a
local Git URL pinned to the checkout's commit. Its CI matrix runs on Linux,
macOS, and Windows; it exercises `prepare` from a clean Git source, all six
bin links, the public imports, and a browser capture.
