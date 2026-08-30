---
id: "requirements/ci-visual-tests"
title: "Distributed visual-regression testing on GitHub Actions (DM-1216)"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-1216","DM-1217","DM-1660","DM-1661","DM-1665","DM-1790","DM-1844"]
code: [".github/workflows/fast-visual-tests.yml",".github/workflows/visual-tests.yml","scripts/ci-baseline-aggregate.mjs","scripts/ci-run-fast-visuals.mjs","scripts/diff-against-baseline.mjs","scripts/diff-font-conformance-baseline.mjs","scripts/merge-shard-results.mjs","scripts/prune-passing-artifacts.mjs","scripts/run-env.mjs","scripts/write-baseline.mjs","src/review/side-digest.ts","tests/baselines/README.md","tests/html-test-suite.tsx","tests/output/","tests/runner.tsx","tests/shard-completeness.test.ts","tests/shard.ts","tests/visual-tests-workflow.test.ts","tests/worker-pool.ts","tools/ab-compare-results.mjs","tools/run-ci-visual-tests.mjs"]
aliases: ["docs/66-ci-visual-tests.md","doc-66"]
---

# Distributed visual-regression testing on GitHub Actions (DM-1216)

The `html-test` (~277 fixtures) and `html-test-unicode` (~819 fixtures) visual suites run locally as a *deliberately throttled background job* (`tests/worker-pool.ts`: `min(8, cores/4)` workers at macOS BACKGROUND QoS), so a full unicode sweep takes ~1h. The suites are embarrassingly parallel and the fixture repo (`github.com/brianwestphal/html-test`) is **public**, so GitHub-hosted runners are free here. `.github/workflows/visual-tests.yml` fans the suite out across many runners; a single dispatch turns ~1h into a few minutes, off your machine.

## When to use it

- **Only when a run needs more than ~50 fixtures.** For a handful of fixtures, run locally (`npm run demos:test:html -- --only <name>`, or with the throttle off: `DOMOTION_NO_NICE=1 DOMOTION_TEST_WORKERS=<cores> npm run demos:test:unicode`).
- **Default to macOS** — it is always the primary testing and calibration target. Linux and Windows are equally supported; select either for platform-specific validation, or `--os all` when a cross-platform change warrants it.

## Fast integration suites on all platforms

The broad HTML and Unicode corpora remain in `visual-tests.yml`, where they can
be sharded. The unsharded integration suites have their own manual workflow,
`.github/workflows/fast-visual-tests.yml`. It runs features, showcase,
snapshot isolation, animate examples, and cached real-world captures on macOS,
the pinned Linux Playwright image, and Windows. Each platform builds the native
font helper and records `runner-image.txt` plus `run-env.json` before rendering.

`scripts/ci-run-fast-visuals.mjs` deliberately continues after an individual
suite fails, writes `fast-visual-completeness.json`, and only then returns a
failure. Actions therefore uploads every suite's expected/actual/diff PNGs and
other output instead of losing the later evidence to the first red command.
Dispatch it from Actions as **Fast visual tests (all platforms)**, selecting one
platform for focused work or `all` for a release/parity pass.

Feature, showcase, and real-world scalar results are compared with committed
per-platform baselines when present. Set `update_baseline` to write reviewable
candidate baseline JSON files into each platform artifact. Snapshot isolation
is an exact pixel-content assertion, and animate examples use their committed
SVG goldens plus cross-platform structural assertions, so those two suites
already carry stronger purpose-built baselines instead of a scalar diff file.

## One-command path

```sh
node tools/run-ci-visual-tests.mjs --suite unicode            # macOS, all 818, auto-sharded
node tools/run-ci-visual-tests.mjs --suite html --os linux    # Linux debugging
node tools/run-ci-visual-tests.mjs --suite unicode --only 10  # just the 1xxx blocks
node tools/run-ci-visual-tests.mjs --suite unicode --only 2070,2C60  # two specific blocks
node tools/run-ci-visual-tests.mjs --suite unicode --update-baseline  # (re)write the committed CI baseline
```

`--only` takes one or more fixture-name **prefixes**, comma-separated; the union is run. It matches the flattened
name, so `--only niche-foo` and `--only niche/foo` are equivalent. A filter that matches nothing now **exits 2**
rather than reporting an empty success — the previous behaviour let a mistyped or comma-separated filter produce
five "successful" shards with no work and a confusing `no results.json found under shard-artifacts` failure in
the aggregate step several minutes later.

**`--ref <branch>` is not enough on its own**: the dispatcher resolves the ref from the CURRENT branch and refuses
unless `origin/<branch>` equals local `HEAD`. To sweep another commit, check it out in a worktree
(`git worktree add /tmp/wt <branch>`) and run the dispatcher from there.

It dispatches the workflow on your **pushed** branch (it refuses if `origin/<branch>` ≠ your `HEAD` — CI runs the pushed ref, not your working tree), waits for the run, downloads the per-shard artifacts, merges them, **diffs the run against the committed CI baseline** (`tests/baselines/<suite>-<os>.json` — see "Two baselines" below), and prints the pass/fail summary + the baseline diff + the local path to the failing-fixture diff crops. A failing matrix job may make `gh run watch --exit-status` return before the workflow's `if: always()` aggregate has finished; the helper therefore polls the run until GitHub reports the whole workflow `completed` (bounded at 90 minutes) before beginning the short artifact-finalization retry. This prevents runner-capacity queues from being mistaken for missing artifacts. Flags: `--suite unicode|html`, `--os macos|linux|windows|all`, `--shards auto|<N>`, `--only <prefix[,prefix…]>`, `--ref <branch>`, `--update-baseline`, `--no-review`.

### Reviewing the CI diffs locally — four-source toggle (DM-1660)

By default the helper is **metadata-only + lazy (DM-1661)**: it downloads just the tiny pre-merged `results-<os>.json` and stages `results.json` + a `.ci-source.json` (the run pointer) into a per-platform review SOURCE folder — `tests/output/review/ci-<os>/<suiteDir>/`. **No images are downloaded up front** (the full `--os all` + keep-passing image set is ~7–8 GB; the per-block unicode `.svg`s alone are ~2.4 MB each). It prints:

```sh
npm run demos:review     # then toggle the header "Source" selector
```

The review UI's **Source** selector switches between four self-contained result sets:

- **Local · macOS** — your local `tests/output/` (what `npm run demos:test:*` writes; full images on disk).
- **CI · macOS / CI · Linux / CI · Windows** — `tests/output/review/ci-<os>/`, metadata-only until viewed.

Switching reloads with `?source=<id>`; the server re-renders the fixture list from that source's `results.json` (instant — diff%/verdict/regions per fixture). **Async loading feedback (DM-1665):** selecting a CI source never blocks the page — it renders immediately, and if the metadata isn't cached the client shows a full-screen loading overlay while it POSTs `/api/refresh-source` (which pulls the latest run's slim metadata), then reloads. A **↻ Refresh** button next to the Source selector re-pulls the latest run (busts the 60 s resolution cache). **Images load lazily:** when you open a fixture whose PNGs aren't cached yet, the `<figure>` shows a loading placeholder while the server `gh run download`s just that fixture's shard artifact (the merge step stamps each result's `shard`), extracts its PNGs into the source folder, and serves them — so you only ever pull the shards you actually look at (a failed fetch shows "image unavailable" rather than a broken image). This lets you compare the **same fixture across platforms** (e.g. a macOS-vs-Linux glyph-fallback difference) without a multi-GB pre-download. `--os all` stages all three CI folders in one pass. Pass `--no-review` to skip staging.

### The `domotion-ci-images` transport (preferred, automatic)

Actions artifacts are **zip-only** — there is no per-file HTTP access, so the lazy shard fetch above still pays a whole-shard download (hundreds of MB, minutes) for the first image of each shard, and a cold OS can take 20–50 min to browse. Full sweeps therefore also **push their images to a disposable public repo**: the aggregate job's "Push images to domotion-ci-images" step stages each OS's expected/actual/diff PNGs + the slim `results.json` + a provenance `meta.json` (runId / commit / suite / os / pushedAt) and **force-pushes a single-commit orphan branch per `<suite>-<os>`** (`html-macos`, `unicode-linux`, …) to `github.com/brianwestphal/domotion-ci-images` (auth: the `CI_IMAGES_DEPLOY_KEY` Actions secret, a write deploy key; the step skips gracefully when the secret is absent, and partial `--only` dispatches never push).

The review server prefers this transport when the branch exists: it resolves the branch tip to an **immutable commit sha** (`gh api .../git/refs/heads/<suite>-<os>`) and fetches metadata and **individual PNGs** from `raw.githubusercontent.com/<repo>/<sha>/<file>` — CDN-backed, ~0.2–0.7 s per cold image, sub-ms warm, no bulk downloads, and no force-push staleness (everything is sha-pinned; adopting a new sha wipes the previously cached PNGs so a fresh run never serves the old run's images). Sources without a pushed branch (e.g. an OS that hasn't had a full sweep since the step landed) fall back to the shard-artifact flow above. The repo is machine-managed and disposable: each branch holds exactly one commit (latest full run only), so history never accumulates — if it ever bloats, delete and recreate it.

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

## The runner must build the native glyph helper (DM-1844)

**A sweep without the native glyph helper measures a different renderer, not a noisier one** (though see the measured note below — this was NOT what caused the CI-only unicode failures). On macOS and Windows the per-codepoint fallback resolver asks the OS — CoreText / DirectWrite — through the helper binary in `tools/<platform>-glyph-extractor/`. That binary is a **build artifact and is gitignored**, so a fresh CI checkout has none. `isGlyphHelperAvailable()` then returns false and font selection silently drops to the **static** fallback chain, which picks different faces than the browser does.

This is not a small drift. Reproduced by disabling the helper on a Mac (`DOMOTION_DISABLE_HELPER=1`), `0400-04FF-cyrillic` goes from **clean · 0 regions** to **major · 142 regions**. The symptom is a sweep of "this is rendering a different font" failures that are **unreproducible locally**, because a developer's tree does have the binary.

`visual-tests.yml`'s macOS job now builds it (arm64 only — `build.sh` also builds x86_64 for the universal release binary, which the arm64 runners don't need) before the shard runs. `tests/visual-tests-workflow.test.ts` guards the wiring, since the failure mode is workflow drift rather than a code change. Both harnesses now print a loud warning and record `glyphHelper` in `run-conditions.json` when the resolver is off, so a non-comparable run says so instead of being read as a fidelity regression.

> **This is hardening, not a fix for the CI-vs-local gap — measured.** It is tempting to read the section below as a missing-helper symptom; a sweep says otherwise. Building the helper in-tree changed the macOS unicode sweep by **nothing at all**: 36 failures / 818 before and after, with `0400-04FF-cyrillic` at major · 20 regions both times, the build step green and the missing-helper warning never firing. CI evidently already obtained a helper through `resolveHelperPath`'s on-demand release-asset download. What the step buys is the removal of a silent network dependency and a reproducible in-tree binary — worth having, but the CI-vs-local difference documented below is still unexplained.

## Two baselines: local Mac vs CI image (DM-1217)

**The macOS runner is not your local Mac, and its pass/fail COUNT does not transfer (measured).** `macos-latest` is currently `macos-15-arm64` (Apple Silicon). A full unicode sweep there returned **742/818 vs 766/818 locally** (commit-matched) — ~24 extra failures, almost all in the COMMON text blocks (basic-latin, latin-1, cyrillic, greek, IPA, punctuation, math, arrows). They fail by a *small* margin that is consistently ~5–7× the local diff (basic-latin: CI 0.18% / worst-tile 2.4% vs local 0.027% / 0.07%): that runner rasterizes text differently enough that Domotion's locally-calibrated output crosses the pass threshold on otherwise-clean blocks (the same Chrome-paints-hinted-vs-Domotion-fills-unhinted gap that Linux/Windows carry a coverage floor for — macOS has none, because locally the gap is negligible).

So we keep **two baselines** rather than pretend one count is authoritative:

- **Local Mac** — the implicit baseline the `demos:test` / `demos:test:unicode` suites already enforce (each fixture diffed against the host's live Chromium screenshot). The calibration target; nothing extra is stored.
- **CI image** — a *committed* per-fixture snapshot under `tests/baselines/<suite>-<os>.json`. A CI run is judged **relative to its own baseline** ("did this change regress anything vs the last known-good run on the same image?"), which *does* transfer — not against the local count. See `tests/baselines/README.md`.

Establish / refresh a baseline from a reviewed known-good run: `node tools/run-ci-visual-tests.mjs --suite <suite> --update-baseline` (writes `tests/baselines/<suite>-<os>.json` for you to commit). The aggregate job's **Baseline diff** Step-Summary section, and `--strict` on `scripts/diff-against-baseline.mjs`, gate on regressions/new-failures vs that baseline. When the runner image rotates (`macos-15` → a future `macos-N`), the `meta.image` mismatch signals it's time to refresh.

### A baseline "regression" can be the ORACLE moving, not the renderer

The baseline diff compares one number per fixture — the diff between Chrome's `expected.png` and Domotion's `actual.svg`. That number rises whenever *either side* moves, and the report cannot tell you which. On the CI runners it is sometimes Chrome.

The measured case: `2070-209F-superscripts-and-subscripts` reported a worst-tile jump 0.07% → 2.17% on one sweep. Re-running the **same commit** reproduced the baseline value, and a fresh full sweep on `main` reproduced it again. Comparing the two runs' artifacts directly showed Domotion's `actual.png` essentially unchanged while Chrome's `expected.png` differed by 607 px, confined to the four cells for U+2090–U+2093 — Chrome had painted those codepoints from a different face in one run than the other. Domotion was stable and correct in both.

**That case was later traced to its cause, and the "same runner image" it was originally recorded against was not true** — see "The environment moves underneath you" below. `meta.image` said the two runs matched because it derives from `ImageOS`, which does not change across an image rotation within the same major macOS.

Why those cells are exposed: the fixture's stack is `"SF Pro Text", "Arial Unicode MS", "Apple Symbols", "Apple Color Emoji", "Noto Sans", "Noto Serif", sans-serif`, and a bare macOS runner has neither SF Pro nor Noto installed. The declared list therefore thins to `Arial Unicode MS → Apple Symbols → Apple Color Emoji → sans-serif`, and U+2090–U+2093 are covered only by the last entry (`sans-serif` → Helvetica, which carries designed low subscript forms). A font-poor environment leaves almost no margin, so any wobble in the platform's answer shows up as a "regression".

The correct paint there is Helvetica: Blink exhausts the declared family list (`kFontGroupFonts`, which ends at the generic) before it ever consults the platform's per-character fallback (`kSystemFonts`) — see `third_party/blink/renderer/platform/fonts/font_fallback_iterator.h:72-80`, Chromium checkout `7d859f27`. Chrome's own `CSS.getPlatformFontsForNode` reports `Helvetica` for those cells, and the glyph outlines Domotion embeds match Helvetica's `U+2090`/`U+2091` bounding boxes exactly.

**So: before bisecting a single-fixture baseline regression, re-run the same ref.** Attribution by per-commit sweeps is wasted effort if the delta is not reproducible in the first place, and a `--only <fixture>` arm that "passes" proves nothing on its own — the fixture may be order-dependent (see the `--only` caveat in `CLAUDE.md`). The cheap discriminator is to compare the two runs' `*-expected.png` against **each other**: if Chrome's own paint moved, the renderer is not the story.

### The environment moves underneath you — and `meta.image` could not see it

The same fixture went on to look like a regression caused by five *more* unrelated changes, oscillating between exactly 0.0574 and 0.0138. Three of those five readings were wrong. The cause was not the renderer, not the oracle's own nondeterminism, and not the comparator:

```
run 30682135006:  shards 1-4 → runner image 20260728.0273 (macOS 26.5.2, kernel 25.5.0)
                  shard  5   → runner image 20260720.0258 (macOS 26.4,   kernel 25.4.0)
run 30682617339:  all shards → runner image 20260728.0273
```

`macos-latest` was mid-rollout. The shard carrying this fixture drew the older image in one run and the newer one in the other, and Chrome's per-codepoint fallback for U+2090–U+2093 differs between those macOS versions. Hash-comparing every PNG in that shard across the two runs: **162 of 163 fixtures byte-identical, and this one differing on both sides** (expected 688 px, actual 327 px, max channel delta 238 — full glyph contrast, not antialiasing).

Two things made this invisible for months:

- **`meta.image` is derived from `ImageOS`**, which reads `macOS26` on both images. The fields that actually moved — `ImageVersion` and `os.release()` — were not recorded at all. The documented "when the image rotates, `meta.image` signals it" contract only covers a *major* rotation.
- **A single run's shards can straddle the rotation**, so a merged `results-<os>.json` is not necessarily one measurement. Capturing such a run as a baseline bakes the mix in.

Both are now guarded. `scripts/run-env.mjs` records `ImageVersion`, `os.release()` and a digest of the installed font set per shard; `scripts/merge-shard-results.mjs` folds them, and when shards disagree it says so in the Step Summary, names the odd shard, and leaves the conflicting field `null` in `run-env-<os>.json` rather than adopting the majority value (`--strict-env` makes that a hard failure). `scripts/diff-against-baseline.mjs` compares this run's record against the baseline's `meta.env` and leads the report with an environment-drift banner *above* the counts, because it changes what those counts mean. A baseline written before this existed reports "predates environment recording" rather than a false all-clear.

This mirrors the guard the font-conformance oracle already had (`comparability()` in `scripts/diff-font-conformance-baseline.mjs`, doc 107), which refuses to judge across a change in runner image, font inventory, ICU version or slice. The visual sweep simply never had one.

### The browser is part of the environment too

The record above covers the machine. It did not, until 2026-08, cover **Chromium** — which for a visual sweep is the sharpest omission available, because Chromium is on *both* sides of the diff: it paints `expected.png` and it rasterizes our SVG into `actual.png`. A build change moves both, and not necessarily by the same amount.

Measured on one macOS host with the platform held constant: `font-variant-emoji: emoji` moves U+00A9 U+2122 U+203C U+263A to the colour emoji font in **147.0.7727.15** and leaves them on the run's primary in **148.0.7778.96**. A fixture containing any of those flips between the two builds while `image`, `imageVersion`, `osRelease` and the font digest all stay identical — the same shape as the image rotation above, one layer down.

`run-env.mjs` now records `chromium`, and three properties of how are load-bearing:

- **It launches the browser to read `browser.version()`**, rather than reading Playwright's `browsers.json` or `chromium.executablePath()`. Those report the revision Playwright *intends*, which is not a promise about the binary that runs — measured, a Windows VM launched a 148 build out of a directory named `chromium-1217` (the pinned 147 revision) and `executablePath()` reported that 1217 path. Recording the declared value would have written 147 for a run that used 148.
- **`mergeShardEnvs` folds it like every other field**, so a run whose shards launched different builds reports the conflict and leaves `chromium` null instead of presenting one shard's browser as the run's. A sharded sweep is exposed to this precisely because each shard resolves its own browser.
- **It WARNS rather than refuses.** The font oracles decline to judge across a browser change; this gate is regression-relative and its banner already sits above the counts, so a warning carries the same information without turning a legitimate browser bump into a red build that cannot be cleared until someone re-seeds. Deliberate, and the trade is: a browser change here is reported and the numbers still print.

Honest limit: `run-env.mjs` is a separate step from the sweep, so its launch records what the harness *would* resolve on this machine, not what one particular harness process did. Those differ only if the installed browser changes mid-job.

## A merge is only a measurement if every shard reached it

The aggregate downloads `results-*` and merges whatever it finds. That meant a run which **lost a shard produced a smaller corpus rather than an error** — and the loss is silent in the direction that matters, because the missing shard's failures are not there to be counted.

Observed: a 5-way macOS unicode run's shard 5 ran to completion (its log reaches `Post Run actions/checkout`) but produced no artifact. The aggregate merged the other four, **succeeded**, and the driver printed `✅ No regressions vs the CI baseline` over **655 of 818 fixtures**. The 163 lost ones were Tibetan, Kannada, Gurmukhi, Arabic Supplement, IPA Extensions — complex-script blocks, i.e. the ones a shaping change is most likely to disturb.

It also manufactured a false A/B. Diffing that run against a complete one reported "2 newly passing, 0 fixtures moved": both artifacts of comparing only the fixture names present in *both* runs. The two "newly passing" fixtures were not passing, they were **absent**.

The guard is in three places, deliberately not one:

- `merge-shard-results.mjs` takes `--expect <os>=<n>,…` (the matrix size, passed by the workflow from the setup job's per-OS totals). It writes `shard-completeness-<os>.json`, prints a red block naming the missing shards, and **exits non-zero unconditionally** — there is no opt-out flag, because this is not a fidelity opinion but the merge saying the file it just wrote does not describe the corpus. An OS reporting `0` was not dispatched and is skipped; an OS that was dispatched and produced *nothing* never enters the per-OS loop at all, so it is swept for separately (the quietest form of the same failure).
- The workflow adds `shard-completeness-*.json` to the `visual-tests-meta` artifact.
- `tools/run-ci-visual-tests.mjs` reads those files and **refuses to print a baseline verdict** for an incomplete run. This stays independent of the merge's exit code on purpose: it is the last thing between a partial run and a number a human will quote, and it should not depend on the producing job having failed loudly.

Absent `--expect` — a local run, or an unsharded one — the check is skipped and says so (`complete: null`) rather than guessing a matrix size, which would make it vacuously pass. Pinned in `tests/shard-completeness.test.ts`, including a replay of the real lost-shard run.

This is the same defect class already fixed once for the conformance workflow, where `|| true` on the shard step plus `continue` on a missing report let a run whose mismatch-bearing shards died report zero mismatches and go green. It was not fixed here at the same time.

**Practical rule:** a per-fixture difference between two sweeps is evidence about the code *only* if both were measured in the same environment. Check the Step Summary's environment line before attributing anything to a commit.

### Chrome itself is not run-to-run deterministic on the runner — and the digests alone could not see which side moved

After the environment guard landed, paired sweeps of one commit in a **byte-identical recorded environment** (same image build, same kernel, same font-inventory digest, 370 fonts) still disagreed on 3 of 818 unicode fixtures. The decisive artifact comparison: on `2150-218F-number-forms`, Chrome's `expected.png` differed between the two runs while Domotion's `actual.png` was **byte-identical** — no change on our side can produce that shape, so the wobble is (at least partly) Chrome's own output on the runner. That shape replicated on a second, independent run pair.

Pixel-clustering the differing expecteds localizes the flip to **specific grid cells**, and they share one profile: `2070-209F` flips exactly U+2090–U+2093, `2C60-2C7F` flips U+2C62 and U+2C65, `2150-218F` flips U+2184. Every flipping cell declares a stack whose leading families are **absent on the runner** (`"SF Pro Text","Arial Unicode MS",…` — no SF Pro, no Arial Unicode MS, no core Noto in the runner's 370-font inventory) and whose codepoint IS covered by the generic terminus (`sans-serif` → Helvetica). The two paint states are geometrically consistent with (a) the correct declared-list resolution — Helvetica's designed below-baseline subscript forms (~9 px at 32 px em) — versus (b) full-x-height forms above the baseline matching a per-character system-fallback face (Geneva's metrics fit the flipped `2070` cells to the pixel; Helvetica-covered codepoints should never reach system fallback per Blink's `FontFallbackIterator` order, `font_fallback_iterator.h:72-80`, checkout `7d859f27`). Cells whose codepoints Helvetica does NOT cover go to system fallback in *both* states and stay stable — which is why only this narrow cell profile flips. The open question is what makes the generic's resolution intermittently unavailable on the runner; the per-leaf `chromeFaces` record (below) names the face per cell on every future run pair, so the next occurrence answers it from artifacts alone.

Why CI sees it and a local machine cannot: the workflow **never restores the expected-cache**, so every CI run regenerates `expected.png` from Chrome and any wobble lands straight in the reference. Locally the cache persists, so the expected is frozen at whatever Chrome produced the day the entry was written — local repetition is structurally incapable of detecting oracle-side drift. (The cache key now folds in the host's font-inventory digest alongside the Playwright version, so a locally frozen expected at least cannot silently outlive the font state that produced it.)

The instrument problem this exposed: the per-side perceptual digests (`expectedDigest` / `actualDigest`, `src/review/side-digest.ts`) were **identical for the two distinct outputs** — the PNGs differed by ~2,900 bytes, below the 16×16 digest's sensitivity floor. Digest equality must therefore never be read as output equality. The harness now records, per fixture:

- **`expectedSha256` / `actualSha256`** — exact byte hashes. Equality is *proof* of "unchanged"; inequality alone proves nothing (CI raster is not bit-stable). Attribution uses the rule *a byte-identical side is exonerated*: the metric is a pure function of the two images, so if one input's bytes did not change, the movement came from the other side — even when it sits below the digest's floor. `attributeMovementWithBytes` (`src/review/side-digest.ts`), `scripts/diff-against-baseline.mjs` (labels like `**oracle** ✓ (actual byte-identical)`), and `tools/ab-compare-results.mjs` all apply it; `scripts/write-baseline.mjs` retains these fields (it previously dropped the digests the comparator reads, so every report printed "—").
- **`chromeFaces`** — the faces Chrome actually painted with (`CSS.getPlatformFontsForNode` per text-bearing leaf element, merged as a per-face glyph-count sum, sorted `PostScriptName:glyphCount`), so a face flip names itself in the artifact instead of costing a fresh CI run. Absent on cache hits. Granularity is load-bearing: the first version made ONE call on `<body>`, which (measured on a unicode grid fixture) returned only the heading + intro-paragraph faces and none of the grid cells — it read identical across a run pair whose cells visibly flipped face. A paired-run comparison that shows identical `chromeFaces` from a body-level record proves nothing about the grid.
- **`expectedFromCache`** — whether the expected side came from the cache. A repeatability claim about Chrome must check this first: a cache-hit "unchanged" is a statement about the cache.
- **`worker` / `workerSeq`** — which pool worker ran the fixture and where in that worker's sequence. Sorting by these reconstructs the exact per-worker execution order, so order-sensitivity (process-global font caches in the shared browser or in Node) can be checked across runs from the artifacts alone.

**Practical rule:** before attributing a single-fixture move, read its attribution label. `oracle ✓` means re-capture the baseline, not bisect. An "unattributed" label means the change is below the digest's resolution on both sides — it is *not* a statement that the images are identical.

## Other-platform caveats

- **Linux is expected to differ** from macOS by design (separate fallback calibration + the runner's Linux text-hinting/coverage floor — see `test-linux.yml`). Use it to catch tofu/missing-font regressions, not to match macOS pixels. It carries its own `tests/baselines/<suite>-linux.json` once established.
- **windows-latest is Windows Server**, whose default font set is narrower than desktop Windows 11 (`windows-fidelity.yml`) — limited fidelity, debugging only.

## These suites can't measure a capture-only Chromium flag

Both harnesses (`tests/runner.tsx`, `tests/html-test-suite.tsx`) drive **one** Chromium: the same browser page screenshots the expected paint AND rasterizes the candidate Domotion SVG for the pixel diff. So a `chromium.launch({ args: [...] })` flag applied to change *capture* also changes how the candidate SVG is rasterized — both sides move together, and any effect that should only hit the capture is masked.

This bit a `--font-render-hinting=none` experiment (the flag disables FreeType/DirectWrite glyph hinting):

- **Paths mode (feature suite) — measurable.** The candidate SVG is vector `<path>` geometry; hinting doesn't apply to paths, so only the expected capture changes (goes unhinted). Unhinted capture aligns better with Domotion's unhinted fontkit outlines → a real, if small, improvement (one fixture crossed to passing). This is exactly why `flipbook-parity.ts` uses the flag locally to align capture↔render.
- **Embedded mode (html / unicode sweeps) — NOT measurable.** The candidate SVG embeds a *hinted* subset font; the flagged browser rasterizes it **unhinted** too, so both sides go soft and agree — the sweep's per-fixture `diff%` even *drops*. That is a mirage: a real consumer opens the shipped SVG in an **unflagged** browser that renders the embedded font hinted, so the capture-vs-consumer mismatch the flag would introduce is invisible to a suite that rasterizes both sides in the same flagged browser. Do not read a sweep run under such a flag as evidence the flag is safe for the default (embedded) render mode.

To measure an asymmetric capture flag you need an asymmetric harness: capture the expected paint **with** the flag but rasterize the candidate SVG in a **separate, unflagged** browser (the consumer's condition).

**That mode now exists (DM-1790).** Set `DOMOTION_CAPTURE_FLAGS` to flag the capture browser only; the candidate SVG then rasterizes in a second, unflagged browser. Setting `DOMOTION_RASTER_FLAGS` to the same list reproduces the coupled behavior described above, deliberately. Neither set ⇒ one browser, exactly as before. Non-default runs print the configuration and record it beside their results, because the failure this guards against is a number measured under a flag nobody remembers setting. Full spec, including the expected-PNG cache-key trap and the Linux validation numbers: **`docs/105-asymmetric-harness-browsers.md`**.

## Local sharding

The shard slice is plain env, so you can reproduce a shard locally:

```sh
HTML_TEST_SHARD=2/5 npm run demos:test:unicode      # the 2nd of 5 stride shards
```
