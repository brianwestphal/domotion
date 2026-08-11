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

## Feature suite — baseline-relative CI gate (DM-1405)

The `features-<os>.json` baselines gate the **feature visual-regression suite**
(`tests/features.ts`) on the Linux + Windows CI workflows. Those platforms can't
hit per-pixel parity (the documented hinting floor) and carry a few pre-existing
residuals (e.g. `background-clip-text-nested-child-wraps` — DM-1420 — on both,
`mathml-mi-greek-italic` on Linux), so the absolute `npm run demos:test` pass/fail
can't be a required check without permanently blocking PRs.

Instead the CI `regression` job runs `demos:test` **advisory** (`|| true`), then
gates with `scripts/diff-against-baseline.mjs --strict` against the committed
`features-<os>.json` — failing only on a **regression** (a fixture that passed in
the baseline now fails) or a new failing fixture, never on the recorded residuals.
This makes the gate safe to mark as a required status check (the workflows also
dropped their `paths:` filter so the required check always reports). Refresh a
baseline from a known-good run:

```sh
# Linux: inside the Playwright container (writes tests/output/features-results.json)
npm run demos:test || true
node scripts/seed-feature-baseline.mjs --os linux --image playwright-noble
# Windows: from a real Windows run (Parallels VM, or the windows-fidelity
# artifact which now uploads features-results.json)
node scripts/seed-feature-baseline.mjs --os windows --image windows-latest
```

Commit the refreshed `features-<os>.json` after reviewing the newly-passing /
newly-failing diff the seed script prints. (macOS isn't gated this way — it stays
the strict local `regionCount === 0` check.)

## Font-conformance baselines — one per platform, and not comparable across them

`font-conformance-<os>.json` records the [font-resolution conformance
oracle](../../docs/107-font-conformance-oracle.md)'s measurement on one platform.
These are a different shape from the visual-suite baselines above, and for a
reason worth stating plainly: **a conformance number from one platform says
nothing about another.** Per-codepoint fallback is not one procedure with three
font sets behind it — Blink runs different code on each (macOS asks CoreText with
the run's own font as the base, Linux asks fontconfig keyed on locale with no
base font, Windows consults a hardcoded per-script table before falling through
to DirectWrite). macOS reaching agreement on a codepoint is not evidence about
Linux or Windows.

The gate is therefore **regression-relative, never absolute**: a stack whose
mismatch count rose, a stack that newly disagrees, or a new disagreeing route
fails the run; the absolute count is reported and tracked, not enforced. An
absolute-zero gate on platforms that have never been measured would fail
identically on every run and grade nothing.

`font-conformance-<os>.json` — `{ meta, summary, byStack, byPair, chromeFaces }`:

- `meta.image` — as above, the runner image.
- `meta.fontInventory` — `{ digest, count, source }` from `tools/font-inventory.mjs`.
  The answers ARE a function of the installed fonts, so an inventory change
  invalidates the baseline; the comparator refuses to judge across one rather
  than reading the move as a regression.
- `meta.unicode` / `meta.icu` — the host's ICU decides which codepoints exist at
  all, so it decides the denominator.
- `meta.corpus` — which per-platform stack corpus was swept
  (`tools/font-conformance-stacks.<platform>.json`) and when it was extracted.
  Also not portable: an element declaring no `font-family` computes to Chrome's
  per-platform default-font preference, so the corpus's largest stack is `Times`
  on macOS and `"Times New Roman"` on Linux.
- `meta.slice` — codepoint count, stack count, PUA inclusion, `lang`. A mismatch
  count without its slice means nothing.
- `summary` / `byStack` / `byPair` — the merged counters, per-stack mismatch
  counts, and per-route counts the comparator diffs.
- `chromeFaces` — the sorted set of faces Chrome named during the sweep: the
  operative font inventory, as observed rather than as installed.

Seed or refresh one from a reviewed run:

```sh
gh workflow run font-conformance.yml -f os=linux -f update_baseline=true
# then download the `font-conformance-linux-merged` artifact and commit its
# tests/baselines/font-conformance-linux.json
```

Locally, from a merged sweep:

```sh
node scripts/merge-font-conformance-shards.mjs --shards <dir> --os macos --expected 6 --out merged.json
node scripts/diff-font-conformance-baseline.mjs --results merged.json \
  --baseline tests/baselines/font-conformance-macos.json --update-baseline
```

### `font-conformance-synthetic-<os>[-byte-XX].json` — same instrument, different corpus

The same shape, from `.github/workflows/font-conformance-synthetic.yml`, sweeping
the **rule-derived** stack corpus instead of the harvested one (doc 107, *"The
synthetic stack corpus"*). Separate files rather than a shared one because the
two slices ask different questions — 2,106 CSS-generic stacks spanning the whole
weight ladder and every stretch keyword, against 434 harvested stacks that are
74% weight-400 — and a mismatch count means nothing without its slice. The
comparator would refuse to compare them anyway (`meta.slice.stacks` and
`meta.corpus.generatedAt` both differ); the separate path makes that explicit
rather than relying on the refusal.

Routine runs use a rotating Unicode-wide low-byte bucket. For example, `byte-00`
contains every eligible assigned codepoint ending in hex `00`, not the contiguous
Latin-1 page. Buckets `00` through `FF` are disjoint and together equal the full
universe. Each gets its own baseline because their mismatch totals are different
questions; the unsuffixed file remains the explicit exhaustive baseline.

One difference worth knowing when reading `meta.corpus`: the synthetic corpus's
`generatedAt` is a **digest of the rule's output** (`synthetic:v1:<hex>`), not a
timestamp. It is regenerated in every CI job, and a wall-clock stamp would
invalidate the baseline on every run for no reason. Regenerating is comparable;
changing the rule is not, which is the discrimination the field is for.

The exhaustive synthetic baselines are seeded. A newly selected low-byte bucket
must be seeded once; until then the comparator reports the run and says there is
nothing to compare. Review and commit that artifact before using the bucket as a gate.

```sh
gh workflow run font-conformance-synthetic.yml -f os=macos -f sample_byte=00 -f update_baseline=true
```

## Files

`<suite>-<os>.json` — `{ meta, fixtures }`:

- `meta`: `suite`, `os`, `image`, `commit`, `capturedAt`, `env`, and roll-up `counts`.
  `image` identifies the runner image so an image rotation shows up as a mismatch
  (recorded by `scripts/record-runner-image.mjs`, DM-1426). On the host runners
  it's the GitHub `ImageOS` + arch (`macos15-arm64`, `win22-x64`); the Linux job
  runs inside the pinned `mcr.microsoft.com/playwright:v<ver>-noble` container
  where `ImageOS` is unset, so it's the Playwright version + Ubuntu codename + arch
  (`playwright-v1.59.1-noble-x64`) — which rotates when the container tag bumps.
- `meta.env` — the finer-grained environment fingerprint `image` is too coarse to
  provide: `{ image, imageVersion, osRelease, platform, arch, node, fontInventory }`
  from `scripts/run-env.mjs`. See the caveat at the end of "Checking a run against
  the baseline" for why `image` alone was not enough. `null` on baselines captured before it
  existed, which the comparator reports as "cannot confirm comparable" rather than
  as agreement.
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

**`meta.image` only catches a MAJOR rotation, and that is not the only kind that
matters.** It derives from `ImageOS`, which reads `macOS26` both before and after
a point-release image bump — yet `macos-latest` moving from image `20260720.0258`
(macOS 26.4) to `20260728.0273` (macOS 26.5.2) changed which face Chrome picks for
U+2090–U+2093, swinging one fixture's metric 4x with no code change. That got
attributed to five successive unrelated commits before it was traced.

So the visual-sweep baselines also carry **`meta.env`** (`scripts/run-env.mjs`):
`imageVersion` (GitHub's image build id), `osRelease` (`os.release()`), and a
digest of the installed font set — the same shape of guard
`font-conformance-<os>.json` already had via `meta.fontInventory`.
`scripts/diff-against-baseline.mjs` leads its report with an environment-drift
banner when they differ, and a baseline written before `meta.env` existed reports
"predates environment recording" rather than a false all-clear. A run whose own
shards disagreed (a rotation mid-sweep) is flagged by
`scripts/merge-shard-results.mjs` and leaves the conflicting field `null`, so a
blended run cannot be captured as a clean baseline. See doc 66, "The environment
moves underneath you".
