#!/usr/bin/env bash
# DM-1216: run one shard of a visual-regression suite in CI (invoked by
# .github/workflows/visual-tests.yml via `shell: bash`, which is available on
# macOS / Linux / Windows runners alike). Maps the suite name to the right
# HTML_TEST_DIR / HTML_TEST_OUTPUT_DIR and runs the harness; HTML_TEST_SHARD and
# DOMOTION_NO_NICE come from the workflow env. An optional ONLY env adds --only.
#
# Usage: bash scripts/ci-run-shard.sh <unicode|html>
#
# Exit code propagates from the harness (non-zero when any fixture fails), so the
# job status reflects clean vs dirty; the workflow's prune + upload steps run
# under `if: always()` so artifacts upload either way.
set -euo pipefail

SUITE="${1:-unicode}"

ONLY_ARGS=()
if [ -n "${ONLY:-}" ]; then ONLY_ARGS=(--only "$ONLY"); fi

npm run build:capture-script

case "$SUITE" in
  unicode)
    export HTML_TEST_DIR="${HTML_TEST_DIR:-external/html-test/unicode}"
    export HTML_TEST_OUTPUT_DIR="${HTML_TEST_OUTPUT_DIR:-tests/output/html-test-unicode}"
    ;;
  html)
    export HTML_TEST_DIR="${HTML_TEST_DIR:-external/html-test}"
    export HTML_TEST_OUTPUT_DIR="${HTML_TEST_OUTPUT_DIR:-tests/output/html-test}"
    ;;
  *)
    echo "ci-run-shard: unknown suite '$SUITE' (expected unicode|html)" >&2
    exit 2
    ;;
esac

echo "ci-run-shard: suite=$SUITE shard=${HTML_TEST_SHARD:-(none)} dir=$HTML_TEST_DIR -> $HTML_TEST_OUTPUT_DIR"
# `${arr[@]+...}` guard so an empty ONLY_ARGS doesn't trip `set -u` on bash 3.2
# (macOS ships 3.2; the empty-array expansion errors there without the guard).
npx tsx tests/html-test-suite.tsx "${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}"
