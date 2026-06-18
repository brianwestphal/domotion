# Distributed visual-regression testing on GitHub Actions (DM-1216)

The `html-test` (295 fixtures) and `html-test-unicode` (818 fixtures) visual suites run locally as a *deliberately throttled background job* (`tests/worker-pool.ts`: `min(8, cores/4)` workers at macOS BACKGROUND QoS), so a full unicode sweep takes ~1h. The suites are embarrassingly parallel and the fixture repo (`github.com/brianwestphal/html-test`) is **public**, so GitHub-hosted runners are free here. `.github/workflows/visual-tests.yml` fans the suite out across many runners; a single dispatch turns ~1h into a few minutes, off your machine.

## When to use it

- **Only when a run needs more than ~50 fixtures.** For a handful of fixtures, run locally (`npm run demos:test:html -- --only <name>`, or with the throttle off: `DOMOTION_NO_NICE=1 DOMOTION_TEST_WORKERS=<cores> npm run demos:test:unicode`).
- **Default to macOS** — it is the calibration target. Use **Linux** only to debug a Linux-specific issue and **Windows** only to debug a Windows-specific issue (see caveats below).

## One-command path

```sh
node tools/run-ci-visual-tests.mjs --suite unicode            # macOS, all 818, auto-sharded
node tools/run-ci-visual-tests.mjs --suite html --os linux    # Linux debugging
node tools/run-ci-visual-tests.mjs --suite unicode --only 10  # just the 1xxx blocks
```

It dispatches the workflow on your **pushed** branch (it refuses if `origin/<branch>` ≠ your `HEAD` — CI runs the pushed ref, not your working tree), waits for the run, downloads the per-shard artifacts, merges them, and prints the pass/fail summary + the local path to the failing-fixture diff crops. Flags: `--suite unicode|html`, `--os macos|linux|windows|all`, `--shards auto|<N>`, `--only <filter>`, `--ref <branch>`, `--no-review`.

### Reviewing the CI diffs locally (same tool)

By default the helper also **consolidates the failing fixtures' `expected`/`actual`/`diff` PNGs (+ the generated `.svg`)** from every shard into one dir laid out the way the review UI expects, and prints:

```sh
REVIEW_OUTPUT_DIR=<tmp>/review npm run demos:review      # browse all CI failures in the usual review UI
svg-review --expected <tmp>/review/.../<name>-expected.png --actual <tmp>/review/.../<name>-actual.png   # one fixture
```

`REVIEW_OUTPUT_DIR` points `tests/review-server.tsx` at the consolidated CI output instead of your local `tests/output/` (so it never clobbers a local run). For `--os all` it consolidates the macOS results (the primary); the raw per-OS shard artifacts are left under `<tmp>/results-<os>-shard*/` for `svg-review`. Pass `--no-review` to skip the consolidation. Only failing fixtures carry images (the workflow prunes passing ones to keep artifacts small).

## What the workflow does

`workflow_dispatch` inputs: `os` (default `macos`), `suite` (`unicode`|`html`), `shards` (`auto` = per-OS caps), `only`.

- A `setup` job computes a per-OS shard matrix. `auto` → **macOS 5 / Linux 16 / Windows 5** (the practical public-repo concurrency ceilings — extra shards just queue).
- Per-OS test jobs shard the fixtures by **stride** (`HTML_TEST_SHARD=i/N`, `tests/shard.ts`): macOS on `macos-latest`, **Linux inside the pinned Playwright container** (`mcr.microsoft.com/playwright:v<locked>-noble`, for the calibrated FreeType/Liberation fonts — mirrors `test-linux.yml`), Windows on `windows-latest`. Each shard clones the fixtures, runs with the throttle off (`DOMOTION_NO_NICE=1`), prunes passing PNGs (`scripts/prune-passing-artifacts.mjs`), and uploads `results.json` + failing diffs as `results-<os>-shard<i>`.
- An `aggregate` job downloads every shard, merges (`scripts/merge-shard-results.mjs`) into one `results-<os>.json`, and writes a Markdown Step Summary (per-OS pass/fail + the failing-fixture table).

Manual `gh` equivalent (if you skip the helper):

```sh
gh workflow run visual-tests.yml --ref <branch> -f os=macos -f suite=unicode -f shards=auto
gh run watch <id>
gh run download <id> --pattern 'results-*' --dir /tmp/vt
node scripts/merge-shard-results.mjs --input /tmp/vt
```

## Caveats (results are platform-relative)

- **macOS runner ≠ your local Mac — the numbers do NOT transfer (measured).** `macos-latest` is currently `macos-15-arm64` (Apple Silicon). A full unicode sweep there returned **742/818 vs 766/818 locally** (commit-matched) — ~24 extra failures, almost all in the COMMON text blocks (basic-latin, latin-1, cyrillic, greek, IPA, punctuation, math, arrows). They fail by a *small* margin that is consistently ~5–7× the local diff (basic-latin: CI 0.18% / worst-tile 2.4% vs local 0.027% / 0.07%): that runner rasterizes text differently enough that Domotion's locally-calibrated output crosses the pass threshold on otherwise-clean blocks (the same Chrome-paints-hinted-vs-Domotion-fills-unhinted gap that Linux/Windows have a coverage floor for — macOS has none, because locally the gap is negligible). **So treat CI-macOS as RELATIVE (did this change make things worse than the previous CI run on the same image?), not as a check against the local baseline.** The calibration is host-specific; matching the local pass count would need a CI-image-specific baseline (or a macos coverage floor calibrated to `macos-15-arm64`).
- **Linux is expected to differ** from macOS by design (separate fallback calibration + the runner's Linux text-hinting/coverage floor — see `test-linux.yml`). Use it to catch tofu/missing-font regressions, not to match macOS pixels.
- **windows-latest is Windows Server**, whose default font set is narrower than desktop Windows 11 (`windows-fidelity.yml`) — limited fidelity, debugging only.

## Local sharding

The shard slice is plain env, so you can reproduce a shard locally:

```sh
HTML_TEST_SHARD=2/5 npm run demos:test:unicode      # the 2nd of 5 stride shards
```
