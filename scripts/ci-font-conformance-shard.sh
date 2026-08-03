#!/usr/bin/env bash
# One font-conformance shard, on any of the three platforms.
#
# Shared by all three sweep jobs in .github/workflows/font-conformance.yml so
# the flags, the exit-code discipline and the recorded environment cannot drift
# between them — a Windows shard that quietly swept a different slice than the
# macOS one would produce two baselines that look comparable and are not.
#
# Inputs (env): SHARD TOTAL RANGE MAX_STACKS NO_PUA STRICT_ALIAS OUT_DIR STACKS
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
args=(--stack-shard "${SHARD}/${TOTAL}" --out "$OUT_DIR")
# DM-1887: the second axis. Omitted entirely when CP_TOTAL is 1 or unset, so the
# report's `meta.shard` stays null and a stack-only run is byte-identical to what
# this script produced before — the merge keys its codepoint accounting off that
# field, and an unnecessary `--shard 1/1` would make a 1-D run look 2-D.
if [ -n "${CP_TOTAL:-}" ] && [ "${CP_TOTAL}" != "1" ]; then
  args+=(--shard "${CP_SHARD}/${CP_TOTAL}")
fi
[ -n "${STACKS:-}" ] && args+=(--stacks "$STACKS")
[ -n "${RANGE:-}" ] && args+=(--range "$RANGE")
[ -n "${MAX_STACKS:-}" ] && args+=(--max-stacks "$MAX_STACKS")
[ "${NO_PUA:-false}" = "true" ] && args+=(--no-pua)
[ "${STRICT_ALIAS:-false}" = "true" ] && args+=(--strict-alias)

echo "font-conformance shard ${SHARD}/${TOTAL}: npx tsx tools/font-conformance.ts ${args[*]}"

node scripts/record-runner-image.mjs "$OUT_DIR/runner-image.txt"
node tools/font-inventory.mjs "$OUT_DIR/font-inventory.json"

set +e
npx tsx tools/font-conformance.ts "${args[@]}"
code=$?
set -e

# Exit 1 means "mismatches found" and must NOT cancel the sibling shards — the
# aggregate re-derives the verdict from the merged reports. Anything else means
# the shard DIED (a full sweep can exhaust the heap partway through). A dead
# shard writes no report.json, and a merge over the survivors alone would read
# as a smaller mismatch total — so a blanket `|| true` here can turn a red run
# green by losing data. Allow only the two exit codes the tool defines.
if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
  echo "::error::conformance shard ${SHARD} died with exit $code (not a mismatch exit) — its report is missing, so the aggregate would under-count"
  exit "$code"
fi
echo "shard exited $code (0 = full agreement, 1 = mismatches found)"
exit 0
