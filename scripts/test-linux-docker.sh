#!/usr/bin/env bash
# Run domotion's test suite inside the same Linux container image CI uses, so
# local runs reproduce Linux-only failures faithfully — without pushing a tag.
#
# WHY THIS EXISTS
#   CI (`.github/workflows/release.yml`, the `test` job) runs on
#   `ubuntu-latest` with `npm ci && npm test`. Domotion's font-fallback chain
#   is calibrated against the HOST platform's system fonts, so any test that
#   renders text exercises a different code path on Linux than on macOS: there
#   is no `/System/Library/Fonts/...`, so glyph-path rendering can't load the
#   host font and falls back to a `<text>` element. That divergence is exactly
#   the class of failure that only surfaces in CI (e.g. a substring-count
#   assertion that holds for the macOS glyph-path output but not the Linux
#   `<text>` fallback). This script lets you reproduce it on a Mac.
#
#   The Microsoft Playwright image is pinned to the @playwright/test version
#   resolved from the lockfile/install — Microsoft ships one image per
#   Playwright release carrying the same Chromium binaries `npx playwright
#   install` would fetch, so the browser-driven demo suites (`demos:test*`)
#   match CI's browser too.
#
# USAGE
#   npm run test:linux-docker                                  # full vitest suite (== CI `npm test`)
#   npm run test:linux-docker -- src/scroll/composer.test.ts   # one test file
#   npm run test:linux-docker -- -t "hoisting"                 # by test-name pattern
#   CMD="npm run typecheck" npm run test:linux-docker          # any other command in the container
#   CMD="bash" npm run test:linux-docker                       # interactive shell in the container
#
# REQUIREMENTS
#   Docker (Docker Desktop on macOS) running. The first run pulls the image
#   (~2 GB); later runs are cached.
#
# SAFETY
#   The repo is mounted read-write so generated artifacts (the built capture
#   script, tests/output/) land back in your tree — but `node_modules` is
#   isolated in a named Docker volume so the container's Linux `npm ci` never
#   clobbers your host's macOS `node_modules` through the mount.

set -euo pipefail
cd "$(dirname "$0")/.."

# Pin the image to the INSTALLED Playwright version (what `npm ci` resolves in
# CI), not the package.json semver range — so local and CI never drift. Fall
# back to the lockfile, then to the stripped package.json range.
PW_VERSION=$(
  node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null \
  || node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version" 2>/dev/null \
  || node -p "require('./package.json').devDependencies['@playwright/test'].replace(/^[^0-9]*/, '')"
)
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

# Default to the exact command the failing CI `test` job runs. Forward any
# extra args to vitest (the file / -t patterns above). An explicit CMD env var
# overrides entirely (typecheck, demos, an interactive shell, etc.).
if [ -n "${CMD:-}" ]; then
  RUN_CMD="$CMD"
elif [ "$#" -gt 0 ]; then
  RUN_CMD="npm run build:capture-script && npx vitest run $*"
else
  RUN_CMD="npm test"
fi

echo ">>> Image:   ${IMAGE}"
echo ">>> Command: ${RUN_CMD}"
echo

docker pull "${IMAGE}"

# Only allocate a TTY when stdout is one — so this still works when invoked
# non-interactively (CI-of-CI, automation) without "the input device is not a
# TTY" errors. A scalar (not an array) so it stays safe under `set -u` on
# macOS's bash 3.2, where expanding an empty array errors; `-it` is a single
# token, so the deliberately-unquoted expansion below splits correctly.
TTY_FLAG=""
[ -t 1 ] && TTY_FLAG="-it"

# --ipc=host  : Chromium needs more than the default 64 MB of shared memory or
#               pages crash (per Playwright's Docker docs).
# --init      : clean signal handling (Ctrl-C terminates the run).
# node_modules: a named volume shadows the host's macOS node_modules so the
#               container's Linux install is fully isolated (see SAFETY above).
# npm cache   : a named volume keeps repeated `npm ci` fast via --prefer-offline.
# HOME=/tmp + CI=true: writable caches + CI-mode npm/playwright defaults.
# shellcheck disable=SC2086  # $TTY_FLAG is intentionally word-split: empty or `-it`.
docker run --rm $TTY_FLAG \
  --ipc=host \
  --init \
  -v "$(pwd):/work" \
  -v domotion-linux-node-modules:/work/node_modules \
  -v domotion-linux-npm-cache:/tmp/.npm \
  -w /work \
  -e HOME=/tmp \
  -e CI=true \
  -e npm_config_cache=/tmp/.npm \
  "${IMAGE}" \
  bash -lc "npm ci --no-audit --no-fund --prefer-offline && ${RUN_CMD}"
