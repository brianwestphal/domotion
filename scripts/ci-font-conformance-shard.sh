#!/usr/bin/env bash
# One font-conformance shard, on any of the three platforms.
#
# Shared by all three sweep jobs in .github/workflows/font-conformance.yml so
# the flags, the exit-code discipline and the recorded environment cannot drift
# between them — a Windows shard that quietly swept a different slice than the
# macOS one would produce two baselines that look comparable and are not.
#
# Inputs (env): SHARD TOTAL RANGE SAMPLE_BYTE MAX_STACKS NO_PUA STRICT_ALIAS OUT_DIR STACKS
#
# STACKS selects the stack corpus. Unset = the platform's own harvested corpus
# (the tool's default), which is what the canonical baseline slice sweeps. The
# synthetic sweep passes the rule-derived corpus here instead
# (font-conformance-synthetic.yml); it deliberately shares this script so the
# flags, exit-code discipline and recorded environment cannot drift between the
# two sweeps.
#
# Alongside the report it records the two things the answers depend on and the
# aggregate cannot measure for itself (it runs on a different runner):
#   runner-image.txt     which image produced these numbers
#   font-inventory.json  which fonts were installed on it
# A rotation of either invalidates the baseline, and the comparator says so
# instead of reading the move as a regression.
set -uo pipefail

OUT_DIR="${OUT_DIR:-tests/output/font-conformance}"
mkdir -p "$OUT_DIR"

# Built as an array, never as a single string: an unquoted string expansion does
# not word-split in every shell this runs under, and a quoted one becomes one
# argument containing spaces. Both silently disarm the flags.
args=(--stack-shard "${SHARD}/${TOTAL}")
# DM-1887: the second axis. Omitted entirely when CP_TOTAL is 1 or unset, so the
# report's `meta.shard` stays null and a stack-only run is byte-identical to what
# this script produced before — the merge keys its codepoint accounting off that
# field, and an unnecessary `--shard 1/1` would make a 1-D run look 2-D.
if [ -n "${CP_TOTAL:-}" ] && [ "${CP_TOTAL}" != "1" ]; then
  args+=(--shard "${CP_SHARD}/${CP_TOTAL}")
fi
[ -n "${STACKS:-}" ] && args+=(--stacks "$STACKS")
[ -n "${STACK_FILTER:-}" ] && args+=(--stack-filter "$STACK_FILTER")
[ -n "${RANGE:-}" ] && args+=(--range "$RANGE")
case "${SAMPLE_BYTE:-}" in
  ""|all|ALL) ;;
  *) args+=(--sample-byte "$SAMPLE_BYTE") ;;
esac
# `all` (and `0`) mean "no cap", i.e. the whole corpus.
#
# The obvious way to say that from the workflow — leave the input empty — does
# NOT work: GitHub substitutes an input's DEFAULT for an empty-string
# workflow_dispatch value, so a dispatch meant to sweep 434 stacks arrives here
# as the canonical six and reports a perfectly plausible number for a slice
# nobody asked for. An explicit sentinel is the only form that survives the
# round-trip.
case "${MAX_STACKS:-}" in
  ""|all|ALL|0) ;;
  *) args+=(--max-stacks "$MAX_STACKS") ;;
esac
[ "${NO_PUA:-false}" = "true" ] && args+=(--no-pua)
[ "${STRICT_ALIAS:-false}" = "true" ] && args+=(--strict-alias)

node scripts/record-runner-image.mjs "$OUT_DIR/runner-image.txt"
node tools/font-inventory.mjs "$OUT_DIR/font-inventory.json"

# Exit 1 means "mismatches found" and must NOT cancel the sibling shards — the
# aggregate re-derives the verdict from the merged reports. Anything else means
# the shard DIED (a full sweep can exhaust the heap partway through). A dead
# shard writes no report.json, and a merge over the survivors alone would read
# as a smaller mismatch total. On macOS only, a diagnosed donor flip may have
# interrupted a measured batch. Discard that entire process/browser/renderer
# attempt and start a fresh sweep. A partial attempt never supplies a report.
max_attempts=1
case "${RUNNER_OS:-$(uname -s)}" in
  macOS|Darwin) max_attempts=3 ;;
esac
for ((attempt=1; attempt<=max_attempts; attempt++)); do
  attempt_out="$OUT_DIR"
  if [ "$max_attempts" -gt 1 ]; then
    attempt_out="$OUT_DIR/attempt-$attempt"
    mkdir -p "$attempt_out"
  fi
  attempt_args=("${args[@]}" --out "$attempt_out")
  echo "font-conformance shard ${SHARD}/${TOTAL} attempt ${attempt}/${max_attempts}: npx tsx tools/font-conformance.ts ${attempt_args[*]}"
  set +e
  npx tsx tools/font-conformance.ts "${attempt_args[@]}"
  code=$?
  set -e

  if [ "$code" -eq 0 ] || [ "$code" -eq 1 ]; then
    if [ ! -f "$attempt_out/report.json" ]; then
      echo "::error::conformance shard ${SHARD} exited $code without report.json"
      exit 2
    fi
    if [ "$max_attempts" -gt 1 ]; then
      mv "$attempt_out/report.json" "$OUT_DIR/report.json"
      mv "$attempt_out/summary.txt" "$OUT_DIR/summary.txt"
      printf '{"attempts":%d,"maxAttempts":%d,"accepted":true}\n' "$attempt" "$max_attempts" > "$OUT_DIR/oracle-attempts.json"
    fi
    echo "shard exited $code (0 = full agreement, 1 = mismatches found)"
    exit 0
  fi

  if [ "$max_attempts" -gt 1 ] && [ "$code" -eq 2 ] && [ -f "$attempt_out/oracle-drift.json" ] && [ "$attempt" -lt "$max_attempts" ]; then
    echo "::warning::macOS oracle drift aborted attempt $attempt; discarding its partial sweep and restarting in a fresh process"
    continue
  fi
  if [ "$max_attempts" -gt 1 ]; then
    printf '{"attempts":%d,"maxAttempts":%d,"accepted":false}\n' "$attempt" "$max_attempts" > "$OUT_DIR/oracle-attempts.json"
  fi
  echo "::error::conformance shard ${SHARD} died with exit $code (not a mismatch exit) — its report is missing, so the aggregate would under-count"
  exit "$code"
done
