#!/usr/bin/env bash
# Authenticate every cross-run shard source before the cohort selector reads it.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_SHA:?}"
: "${WORKFLOW_PATH:?}"
: "${ARTIFACT_PATTERN:?}"

root=cohort-candidates
current="$root/run-$GITHUB_RUN_ID"
mkdir -p "$current"
printf '{"runId":%s,"headSha":"%s","workflowPath":"%s"}\n' \
  "$GITHUB_RUN_ID" "$GITHUB_SHA" "$WORKFLOW_PATH" > "$current/provenance.json"

ids="${COHORT_RUN_IDS:-}"
if [[ -z "$ids" ]]; then exit 0; fi
if [[ ! "$ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "::error::cohort_run_ids must be comma-separated numeric GitHub run IDs" >&2
  exit 2
fi

IFS=',' read -ra runs <<< "$ids"
for run in "${runs[@]}"; do
  [[ "$run" == "$GITHUB_RUN_ID" ]] && continue
  metadata=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq '[.head_sha,.path,.status] | @tsv')
  IFS=$'\t' read -r sha path status <<< "$metadata"
  if [[ "$sha" != "$GITHUB_SHA" || "$path" != "$WORKFLOW_PATH" || "$status" != completed ]]; then
    echo "::error::run $run is not a completed $WORKFLOW_PATH run at $GITHUB_SHA" >&2
    exit 2
  fi
  dest="$root/run-$run"
  mkdir -p "$dest"
  gh run download "$run" --pattern "$ARTIFACT_PATTERN" --dir "$dest"
  printf '{"runId":%s,"headSha":"%s","workflowPath":"%s"}\n' \
    "$run" "$sha" "$path" > "$dest/provenance.json"
done
