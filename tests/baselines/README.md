# CI visual-test baselines (DM-1217)

Domotion's text output is calibrated against **the local Mac's** Chromium paint.
The macOS GitHub Actions runner (`macos-15-arm64`, Apple Silicon) rasterizes text
differently enough that the locally-clean common-text blocks (basic-latin,
cyrillic, greek, IPA, punctuation, math, arrows, …) cross the pass threshold by a
small margin (~5–7× the local diff). Measured: a full unicode sweep returned
**742/818 on CI vs 766/818 locally** on the same commit — the ~24 extra failures
are all that hinting/anti-aliasing gap, not real regressions.

So the pass/fail **count does not transfer between machines.** We keep **two
baselines** instead of pretending one number is authoritative:

- **Local Mac** — the implicit baseline the `demos:test` / `demos:test:unicode`
  suites already enforce: every fixture is diffed against the host's live
  Chromium screenshot. This is the calibration target; nothing extra is stored.
- **CI image** — a *committed* snapshot of the per-fixture pass/fail + diff
  metrics produced on the CI runner, stored here as `<suite>-<os>.json`
  (e.g. `unicode-macos.json`, `html-macos.json`).

A CI run is then judged **relative to its own committed baseline** — "did this
change regress anything vs the last known-good run on the same image?" — not
against the local count. That comparison *does* transfer.

## Files

`<suite>-<os>.json` — `{ meta, fixtures }`:

- `meta`: `suite`, `os`, `image` (e.g. `macos15-arm64`), `commit`, `capturedAt`,
  and roll-up `counts`.
- `fixtures`: `{ "<fixture-name>": { pass, skipped, diffPct, worstTilePct, regionCount } }`.

Only the fields the comparator needs are stored, keyed by fixture name, so the
file diffs cleanly when a baseline is refreshed.

## Establishing / refreshing a baseline

Run a sweep you have reviewed as known-good and write it back:

```sh
node tools/run-ci-visual-tests.mjs --suite unicode --update-baseline
node tools/run-ci-visual-tests.mjs --suite html    --update-baseline
```

This dispatches the sharded workflow, merges the result, **and** writes
`tests/baselines/<suite>-<os>.json` from the merged run for you to review and
commit. (We never commit from CI — the baseline is a reviewed, human-committed
artifact.) The manual `gh` path passes `-f update_baseline=true` and downloads
the `visual-tests-merged` artifact's `baseline-*.json`.

## Checking a run against the baseline

The aggregate job (and `run-ci-visual-tests.mjs` after a merge) runs
`scripts/diff-against-baseline.mjs` automatically and writes a **Baseline diff**
section into the Step Summary: regressions, newly-passing, new fixtures, dropped.
To check a merged result by hand:

```sh
node scripts/diff-against-baseline.mjs \
  --results /path/to/results-macos.json \
  --baseline tests/baselines/unicode-macos.json --strict
```

`--strict` exits non-zero only on **regressions or new failing fixtures** vs the
baseline (the gate that actually transfers); a first run on an image with no
committed baseline prints a notice and exits 0.

When the macOS runner image rotates (`macos-15` → a future `macos-N`), the
`meta.image` mismatch is your signal to refresh the baseline on the new image.
