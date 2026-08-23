# Unicode shaping conformance corpus

DM-2344 extends the logical shaping program from the small HTML corpus to the
roughly 312,822 derived runs under `external/html-test/unicode` without turning
every local check into an hours-long sweep.

## Source boundary

The underlying comparison remains [doc 108](108-shaping-conformance-oracle.md):
Blink builds each run through `HarfBuzzShaper` and `ShapeResultRun` at Chromium
revision `7d859f271cbda744098ac69f44978d4edfa62be3`, using its pinned HarfBuzz.
The corpus runner does not invent a second shaping comparison or change the
existing position tolerance. It partitions and preserves the exact reports
that `tools/shaping-conformance.ts` already emits.

DM-2521 separates logical shaping from ink emission for standalone
default-ignorables. Reports retain the exact production-selected face, gid,
cluster and UTF-16/code-point source spans. Pinned HarfBuzz maps the scalar to
that face's zero-advance U+0020 glyph when it has one, or takes its source-owned
deletion branch when it does not. Final SVG paint continues to suppress the
empty outline. No selector allowlist or pixel tolerance participates.

## Deterministic profiles

`tools/shaping-unicode-corpus.ts` canonicalizes every complete run record and
uses its SHA-256 identity for ordering and modulo shard assignment. Therefore
source order, filesystem order, and retry order cannot move a run between
shards.

- `representative` selects the first 4,096 canonical identities. Pull requests
  run this gate on macOS, Linux, and Windows.
- `exhaustive` retains every run. Eight shards on each supported OS run weekly
  and on manual dispatch.

```sh
npm run fonts:shaping:runs -- --source external/html-test/unicode \
  --runs tests/output/shaping-unicode/full-runs.json
npm run fonts:shaping:unicode -- --mode representative --shard 0/1 \
  --runs tests/output/shaping-unicode/full-runs.json
```

## Resume and comparability

Each shard directory contains its exact input corpus, original conformance
report, `mismatch-reductions.json`, and `manifest.json`. The manifest hashes the
full corpus and selected identities and carries the doc-120 environment
fingerprint: browser/source revisions, host/architecture, font inventory,
locale, helper route, viewport/profile, and corpus/sample identities. A retry
skips a completed shard only when its digest is identical, preserving a prior
nonzero exit status rather than turning a mismatch into success.

Reports from different fingerprints are incomparable evidence, not a
regression delta.

## Divergence reduction

Raw mismatch rows remain intact. A second artifact groups them by logical
signature—verdict, family, Chrome/renderer glyph counts, and maximum delta—and
retains one example plus its frequency. This is for filing one focused ticket
per logical divergence family; it is not an allowlist and cannot make a shard
green. Every mismatch remains a failing exit until source-stage adjudication.

No visual or logical tolerance is widened by this workflow.
