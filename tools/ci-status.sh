#!/usr/bin/env bash
# One-line status for a GitHub Actions run — for polling a dispatched CI run
# without hand-writing a different `gh api` invocation every time.
#
#   tools/ci-status.sh                  # latest run on the current branch
#   tools/ci-status.sh 30587797109      # a specific run id
#   tools/ci-status.sh 30587797109 -v   # also list each job's status
#
# Prints, on one line:
#   <run-id> <status>/<conclusion> jobs <completed>/<total> [<failed> failed] elapsed <mm:ss> at <UTC>
#
# Exit status is about whether the QUERY worked, not whether CI passed:
#   0 = queried fine (run may be in progress, passing, or failing)
#   1 = the run is not queryable (bad id, no runs, gh/network failure)
# Polling loops should therefore branch on the printed status, not on `$?`.
#
# Note this deliberately shells out to `gh` rather than curl: `gh` carries the
# stored credentials. `gh` cannot verify TLS inside the sandbox (Go tools fail
# with `x509: OSStatus -26276` through the sandbox proxy), so this script needs
# to run unsandboxed like any other `gh` call.
set -uo pipefail

REPO="${CI_STATUS_REPO:-brianwestphal/domotion}"
RUN="${1:-}"
VERBOSE="${2:-}"

if [ -z "$RUN" ] || [ "$RUN" = "-v" ]; then
  [ "$RUN" = "-v" ] && VERBOSE="-v"
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  RUN=$(gh run list --repo "$REPO" ${branch:+--branch "$branch"} --limit 1 \
          --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  if [ -z "$RUN" ]; then
    echo "no runs found for branch '${branch:-?}' in $REPO" >&2
    exit 1
  fi
fi

run_json=$(gh api "repos/$REPO/actions/runs/$RUN" \
             --jq '[.status, (.conclusion // "-"), .created_at, .name] | @tsv' 2>&1)
if [ $? -ne 0 ] || [ -z "$run_json" ]; then
  echo "could not read run $RUN: $run_json" >&2
  exit 1
fi
IFS=$'\t' read -r status conclusion created name <<< "$run_json"

# --paginate: a sharded workflow can exceed the 30-job default page, and a
# truncated count reads as "fewer jobs finished" rather than as an error.
jobs_tsv=$(gh api "repos/$REPO/actions/runs/$RUN/jobs" --paginate \
             --jq '.jobs[] | [.status, (.conclusion // "-"), .name] | @tsv' 2>&1)
if [ $? -ne 0 ]; then
  echo "could not read jobs for $RUN: $jobs_tsv" >&2
  exit 1
fi

total=$(printf '%s\n' "$jobs_tsv" | grep -c . || true)
done_n=$(printf '%s\n' "$jobs_tsv" | grep -c '^completed' || true)
failed=$(printf '%s\n' "$jobs_tsv" | awk -F'\t' '$2=="failure"||$2=="timed_out"||$2=="cancelled"' | grep -c . || true)

# Elapsed since the run was created, as mm:ss.
start=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$created" +%s 2>/dev/null \
        || date -u -d "$created" +%s 2>/dev/null || echo "")
if [ -n "$start" ]; then
  el=$(( $(date -u +%s) - start ))
  elapsed=$(printf '%d:%02d' $((el / 60)) $((el % 60)))
else
  elapsed="?"
fi

printf '%s %s/%s jobs %s/%s' "$RUN" "$status" "$conclusion" "$done_n" "$total"
[ "${failed:-0}" -gt 0 ] && printf ' \033[31m%s failed\033[0m' "$failed"
printf ' elapsed %s at %s  (%s)\n' "$elapsed" "$(date -u +%H:%M:%SZ)" "$name"

if [ "$VERBOSE" = "-v" ]; then
  printf '%s\n' "$jobs_tsv" | awk -F'\t' '{printf "  %-10s %-10s %s\n", $1, $2, $3}'
fi
