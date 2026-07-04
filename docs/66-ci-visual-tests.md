# Distributed visual-regression testing on GitHub Actions (DM-1216)

The `html-test` (~277 fixtures) and `html-test-unicode` (~819 fixtures) visual suites run locally as a *deliberately throttled background job* (`tests/worker-pool.ts`: `min(8, cores/4)` workers at macOS BACKGROUND QoS), so a full unicode sweep takes ~1h. The suites are embarrassingly parallel and the fixture repo (`github.com/brianwestphal/html-test`) is **public**, so GitHub-hosted runners are free here. `.github/workflows/visual-tests.yml` fans the suite out across many runners; a single dispatch turns ~1h into a few minutes, off your machine.

## When to use it

- **Only when a run needs more than ~50 fixtures.** For a handful of fixtures, run locally (`npm run demos:test:html -- --only <name>`, or with the throttle off: `DOMOTION_NO_NICE=1 DOMOTION_TEST_WORKERS=<cores> npm run demos:test:unicode`).
- **Default to macOS** — it is the calibration target. Use **Linux** only to debug a Linux-specific issue and **Windows** only to debug a Windows-specific issue (see caveats below).

## One-command path

```sh
node tools/run-ci-visual-tests.mjs --suite unicode            # macOS, all 818, auto-sharded
node tools/run-ci-visual-tests.mjs --suite html --os linux    # Linux debugging
node tools/run-ci-visual-tests.mjs --suite unicode --only 10  # just the 1xxx blocks
node tools/run-ci-visual-tests.mjs --suite unicode --update-baseline  # (re)write the committed CI baseline
```

It dispatches the workflow on your **pushed** branch (it refuses if `origin/<branch>` ≠ your `HEAD` — CI runs the pushed ref, not your working tree), waits for the run, downloads the per-shard artifacts, merges them, **diffs the run against the committed CI baseline** (`tests/baselines/<suite>-<os>.json` — see "Two baselines" below), and prints the pass/fail summary + the baseline diff + the local path to the failing-fixture diff crops. Flags: `--suite unicode|html`, `--os macos|linux|windows|all`, `--shards auto|<N>`, `--only <filter>`, `--ref <branch>`, `--update-baseline`, `--no-review`.

### Reviewing the CI diffs locally — four-source toggle (DM-1660)

By default the helper is **metadata-only + lazy (DM-1661)**: it downloads just the tiny pre-merged `results-<os>.json` and stages `results.json` + a `.ci-source.json` (the run pointer) into a per-platform review SOURCE folder — `tests/output/review/ci-<os>/<suiteDir>/`. **No images are downloaded up front** (the full `--os all` + keep-passing image set is ~7–8 GB; the per-block unicode `.svg`s alone are ~2.4 MB each). It prints:

```sh
npm run demos:review     # then toggle the header "Source" selector
```

The review UI's **Source** selector switches between four self-contained result sets:

- **Local · macOS** — your local `tests/output/` (what `npm run demos:test:*` writes; full images on disk).
- **CI · macOS / CI · Linux / CI · Windows** — `tests/output/review/ci-<os>/`, metadata-only until viewed.

Switching reloads with `?source=<id>`; the server re-renders the fixture list from that source's `results.json` (instant — diff%/verdict/regions per fixture). **Async loading feedback (DM-1665):** selecting a CI source never blocks the page — it renders immediately, and if the metadata isn't cached the client shows a full-screen loading overlay while it POSTs `/api/refresh-source` (which pulls the latest run's slim metadata), then reloads. A **↻ Refresh** button next to the Source selector re-pulls the latest run (busts the 60 s resolution cache). **Images load lazily:** when you open a fixture whose PNGs aren't cached yet, the `<figure>` shows a loading placeholder while the server `gh run download`s just that fixture's shard artifact (the merge step stamps each result's `shard`), extracts its PNGs into the source folder, and serves them — so you only ever pull the shards you actually look at (a failed fetch shows "image unavailable" rather than a broken image). This lets you compare the **same fixture across platforms** (e.g. a macOS-vs-Linux glyph-fallback difference) without a multi-GB pre-download. `--os all` stages all three CI folders in one pass. Pass `--no-review` to skip staging.

- **`--eager`** restores the old behavior: download every shard's images upfront and stage them (no lazy fetch needed, but GBs).
- **`keep_passing`** (default **true** on `visual-tests.yml`) keeps PASSING fixtures in the artifacts too, so you can review them; set it `false` to prune passing and shrink artifacts.
- **`include_svg`** (default **false**) — the generated `.svg`s are ~85% of the artifact weight and the review UI only shows PNGs, so they're dropped before upload; set it `true` to keep them (e.g. for `svg-review`'s "view svg").
- `REVIEW_OUTPUT_DIR` still overrides the **Local · macOS** root for back-compat.

## What the workflow does

`workflow_dispatch` inputs: `os` (default `macos`), `suite` (`unicode`|`html`), `shards` (`auto` = per-OS caps), `only`.

- A `setup` job computes a per-OS shard matrix. `auto` → **macOS 5 / Linux 16 / Windows 5** (the practical public-repo concurrency ceilings — extra shards just queue).
- Per-OS test jobs shard the fixtures by **stride** (`HTML_TEST_SHARD=i/N`, `tests/shard.ts`): macOS on `macos-latest`, **Linux inside the pinned Playwright container** (`mcr.microsoft.com/playwright:v<locked>-noble`, for the calibrated FreeType/Liberation fonts — mirrors `test-linux.yml`), Windows on `windows-latest`. Each shard clones the fixtures, runs with the throttle off (`DOMOTION_NO_NICE=1`), prunes passing PNGs (`scripts/prune-passing-artifacts.mjs`), and uploads `results.json` + failing diffs as `results-<os>-shard<i>`.
- An `aggregate` job downloads every shard, merges (`scripts/merge-shard-results.mjs`) into one `results-<os>.json`, writes a Markdown Step Summary (per-OS pass/fail + the failing-fixture table), then **diffs the merged run against the committed CI baseline** (`scripts/ci-baseline-aggregate.mjs` → `scripts/diff-against-baseline.mjs`) and appends a **Baseline diff** section (regressions / newly-passing / new / dropped). With the `update_baseline` dispatch input set, it also writes `baseline-<suite>-<os>.json` into the `visual-tests-merged` artifact for you to review + commit.

Manual `gh` equivalent (if you skip the helper):

```sh
gh workflow run visual-tests.yml --ref <branch> -f os=macos -f suite=unicode -f shards=auto
gh run watch <id>
gh run download <id> --pattern 'results-*' --dir /tmp/vt
node scripts/merge-shard-results.mjs --input /tmp/vt
```

## Two baselines: local Mac vs CI image (DM-1217)

**The macOS runner is not your local Mac, and its pass/fail COUNT does not transfer (measured).** `macos-latest` is currently `macos-15-arm64` (Apple Silicon). A full unicode sweep there returned **742/818 vs 766/818 locally** (commit-matched) — ~24 extra failures, almost all in the COMMON text blocks (basic-latin, latin-1, cyrillic, greek, IPA, punctuation, math, arrows). They fail by a *small* margin that is consistently ~5–7× the local diff (basic-latin: CI 0.18% / worst-tile 2.4% vs local 0.027% / 0.07%): that runner rasterizes text differently enough that Domotion's locally-calibrated output crosses the pass threshold on otherwise-clean blocks (the same Chrome-paints-hinted-vs-Domotion-fills-unhinted gap that Linux/Windows carry a coverage floor for — macOS has none, because locally the gap is negligible).

So we keep **two baselines** rather than pretend one count is authoritative:

- **Local Mac** — the implicit baseline the `demos:test` / `demos:test:unicode` suites already enforce (each fixture diffed against the host's live Chromium screenshot). The calibration target; nothing extra is stored.
- **CI image** — a *committed* per-fixture snapshot under `tests/baselines/<suite>-<os>.json`. A CI run is judged **relative to its own baseline** ("did this change regress anything vs the last known-good run on the same image?"), which *does* transfer — not against the local count. See `tests/baselines/README.md`.

Establish / refresh a baseline from a reviewed known-good run: `node tools/run-ci-visual-tests.mjs --suite <suite> --update-baseline` (writes `tests/baselines/<suite>-<os>.json` for you to commit). The aggregate job's **Baseline diff** Step-Summary section, and `--strict` on `scripts/diff-against-baseline.mjs`, gate on regressions/new-failures vs that baseline. When the runner image rotates (`macos-15` → a future `macos-N`), the `meta.image` mismatch signals it's time to refresh.

## Other-platform caveats

- **Linux is expected to differ** from macOS by design (separate fallback calibration + the runner's Linux text-hinting/coverage floor — see `test-linux.yml`). Use it to catch tofu/missing-font regressions, not to match macOS pixels. It carries its own `tests/baselines/<suite>-linux.json` once established.
- **windows-latest is Windows Server**, whose default font set is narrower than desktop Windows 11 (`windows-fidelity.yml`) — limited fidelity, debugging only.

## Local sharding

The shard slice is plain env, so you can reproduce a shard locally:

```sh
HTML_TEST_SHARD=2/5 npm run demos:test:unicode      # the 2nd of 5 stride shards
```
