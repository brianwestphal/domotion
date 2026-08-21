# 160 — Chromium roll differential audit

Every Chromium/Skia/HarfBuzz/ICU roll compares two independently collected stage-evidence manifests and representative visual digests on comparable environments:

```sh
npm run stage:evidence:compare-roll -- --old old.json --new new.json --review review.json --out roll-diff.json
```

Only roll identity fields are ignored. Host, architecture, flags, fonts, locale, helper, viewport, corpus, and cache isolation must match. Canonical structured payloads are hashed per parity area; visual digest changes are reported separately.

A changed stage blocks acceptance until its review cites upstream source and classifies the delta as `upstream-drift`, `domotion-regression`, or `no-semantic-change`. Semantic changes also require named updated oracle rows. Thus a new visual baseline cannot hide a logical regression: visuals support the decision only after the first changed stage is identified.
