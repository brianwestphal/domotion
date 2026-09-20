---
id: "requirements/fragmented-collapsed-table-ownership"
title: "Fragmented collapsed-table ownership"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2557","DM-2558","DM-2560","DM-48MFKS"]
code: [".github/workflows/fragmented-collapsed-table-release.yml","src/capture/collapsed-border-fragment-cdp.e2e.test.ts","src/capture/collapsed-border-fragment-cdp.ts","src/capture/collapsed-border-fragment-record.ts","src/capture/script/walker/borders-backgrounds.ts","tests/border-collapse-conflict.e2e.test.ts","tools/collapsed-border-fragmentation-oracle.ts","tools/fragmented-collapsed-table-release-gate.ts"]
aliases: ["docs/225-fragmented-collapsed-table-ownership.md","doc-225"]
---

# Fragmented collapsed-table ownership

Domotion authenticates collapsed-border ownership for ordinary screen-layout
fragments before vector paint. This contract covers multicolumn and other
screen fragmentation, including continued rows and repeated table sections.
It does not define or promise paged-media or print capture.

## Production boundary

- `src/capture/collapsed-border-fragment-cdp.ts` owns the private live-node
  registry, animation freeze, transform-neutral same-epoch CSSOM/CDP
  collection, intrinsic source-cell occurrence witnesses, reversible scrolling,
  exact restoration check, and fail-closed warning.
- `src/capture/collapsed-border-fragment-record.ts` owns LayoutUnit
  canonicalization, ordered channel authentication, record construction, and
  hostile-record validation. It contains no pixel comparison or fitted
  tolerance.
- `src/capture/script/walker/borders-backgrounds.ts` accepts only an
  authenticated record matching the live table's rows, columns, fragments,
  writing mode, and direction. It passes exact section slices to the existing
  logical edge/joint algorithm, emits physical rects tagged by fragment index,
  and serializes the consumed provenance on the table.
- Missing, ambiguous, stale, or unauthenticated alias records serialize an
  unavailable reason, suppress cell and structural collapsed borders, and
  return an empty table vector list. There is no CSSOM heuristic fallback.

## Headless logical corpus

`tools/collapsed-border-fragmentation-oracle.ts` launches Chromium headlessly,
captures no pixels, and emits schema-3 fingerprinted JSON. The retained corpus
covers whole-row and continued-row breaks, horizontal and vertical writing
modes, repeated headers and footers, oversized and non-avoiding negatives,
multiple groups, monolithic overflow, captions, empty states, spans, fractional
tracks, and exact source restoration.

The corpus requires all 21 source-logical discriminators and all 15 destructive
controls to pass with verdict
`screen-section-fragment-record-authenticated`. The controls collapse
fragments, erase continuation, alter edge ownership, corrupt repeated-section
identity, fill span interiors, change writing axes, and substitute stale
physical or source identities.

Run the logical checks with:

```sh
npm run borders:collapsed-fragmentation-audit -- --json /tmp/collapsed-border-fragmentation.json
npx vitest run tests/collapsed-border-fragmentation-oracle.test.ts
```

Focused production coverage is explicit-headless:
`src/capture/collapsed-border-fragment-cdp.e2e.test.ts` proves authenticated
consumption and exact source restoration through a transformed ancestor, then
proves aliased prototypes become independently witnessed occurrences.
`tests/border-collapse-conflict.e2e.test.ts` keeps horizontal and vertical,
whole and continued-row, span and joint, empty-fragment, and repeated-section
behavior live.

## Three-platform release gate

`.github/workflows/fragmented-collapsed-table-release.yml` runs separate
macOS, Linux, and Windows legs. Each platform must retain all 21 exact logical
discriminators and all 15 destructive controls, then independently pass the
reviewed native border-phase envelope across DPR 1/2/4 and zoom
0.8/1/1.25.

`tools/fragmented-collapsed-table-release-gate.ts` requires all six reports
and refuses promotion if any platform, mutation, logical verdict, native
scenario, or artifact-set identity is absent. Exact terminal ink cannot excuse
an incomplete screen-fragment record.

Authenticated paged capture and its patched-Chromium transport were removed by
DM-48MFKS. They are intentionally outside this screen-fragment contract.
