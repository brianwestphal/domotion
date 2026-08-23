# 160 — Chromium roll differential audit

Every Chromium/Skia/HarfBuzz/ICU roll compares two independently collected stage-evidence manifests and representative visual digests on comparable environments:

```sh
npm run stage:evidence:compare-roll -- --old old.json --new new.json --review review.json --out roll-diff.json
```

Only roll identity fields are ignored. Host, architecture, flags, fonts, locale, helper, viewport, corpus, and cache isolation must match. Canonical structured payloads are hashed per parity area; visual digest changes are reported separately.

A changed stage blocks acceptance until its review cites upstream source and classifies the delta as `upstream-drift`, `domotion-regression`, or `no-semantic-change`. Semantic changes also require named updated oracle rows. Thus a new visual baseline cannot hide a logical regression: visuals support the decision only after the first changed stage is identified.

The `icu-harfbuzz-source-drift` payload is stricter. It fingerprints the full
Chromium revision, Chromium's `README.chromium` HarfBuzz pin, the independently
vendored HarfBuzz and ICU revisions, bundled `icudtl.dat`, every helper binary,
and every generated Unicode classifier consumed by rendering. It records exact,
stable row IDs for ICU property answers and HarfBuzz glyph/cluster/advance/offset
decisions. A roll that changes one of those rows is withheld until the review
cites the governing upstream source and names the corresponding updated
property or shaping oracle row. Missing fingerprints and comparisons between
`representative` and `exhaustive` profiles are incomparable, never regressions.

Release candidates run both profiles independently: representative is the fast
per-roll gate; exhaustive traverses the complete scalar/property corpus and the
declared shaping corpus. Their results may corroborate each other, but are never
compared as if they sampled the same evidence.

`npm run stage:evidence:source-drift -- --mode …` builds that payload from the
checked-out source revisions and SHA-256 hashes of an explicitly supplied ICU
data file, platform helper binaries, and generated classifier files. Inputs are
explicit so a release job cannot silently fingerprint a developer-cache default.
