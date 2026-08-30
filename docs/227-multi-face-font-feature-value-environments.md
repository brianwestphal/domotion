---
id: "requirements/multi-face-font-feature-value-environments"
title: "Authenticated multi-face font-feature-value environments"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: []
tickets: []
code: ["tests/font-feature-value-environment.test.ts","tests/shaping-font-feature-environment.test.ts","tests/shaping-font-feature-values.e2e.test.ts","tools/font-feature-value-environment.ts","tools/shaping-conformance.ts","tools/shaping-font-feature-values.ts"]
aliases: ["docs/227-multi-face-font-feature-value-environments.md","doc-227"]
---

# Authenticated multi-face font-feature-value environments

**Status:** shipped
**Owners:** `tools/font-feature-value-environment.ts`,
`tools/shaping-conformance.ts`, `tools/shaping-font-feature-values.ts`
**Evidence:** `tests/font-feature-value-environment.test.ts`,
`tests/shaping-font-feature-environment.test.ts`,
`tests/shaping-font-feature-values.e2e.test.ts`

## Exact boundary

Named `font-variant-alternates` are resolved only after Blink has selected a
face for the requested family and descriptors. A family name and an alias table
therefore do not identify the shaping question. The v2 environment retains:

- a document identity and effective family-scoped alias table;
- every candidate face, its weight/style/stretch descriptors and
  `unicode-range`;
- the browser-selected face id and source-order slot;
- source kind (`data`, `local`, `file`, or `remote`), load outcome, exact bytes,
  SHA-256, and collection face index.

The browser probe owns selection. The Node boundary authenticates the selected
record before re-emitting it or handing bytes to HarfBuzz. It rejects an absent
or duplicate face/source, an earlier successfully loaded source, failed loads,
missing bytes, digest drift, and invalid face indices. In particular, a remote
URL is not evidence of a font: remote bytes without their digest fail closed.
Local and file sources have the same requirement; a platform name or pathname
alone is not accepted as portable ownership.

Probe and registration cache keys cover the complete canonical environment,
including document identity. Two documents with byte-identical fonts but
different alias storage cannot share a probe batch. This closes the former
cross-document table-leak and cache-order ambiguity.

## Upstream ownership

Sources are pinned at Chromium `7d859f271c` (2026-06-27), HarfBuzz
`4de187dd0` (2026-07-31), and Skia `62efacd3` through Chromium's DEPS.

Blink resolves the effective aliases in
`third_party/blink/renderer/core/css/css_font_selector.cc`, then asks
`FontFaceCache::Get` for the descriptor-selected segmented face. Unicode-range
coverage is carried into `FontDataForRangeSet` and `HarfBuzzFace`; it is not a
post-shaping filter. Source fallback is ordered, so selecting a later source
while an earlier source is recorded as successfully loaded is contradictory
evidence. HarfBuzz receives the selected collection member plus the exact
feature tags/values (`hb-ot-shape.cc`); the retained logical record includes
glyph ids, clusters, source spans, advances, offsets and flags before raster.
Skia is downstream of this decision and supplies no alternate face-selection
rule to emulate here.

## Mutations and visual policy

The exact gates reverse selected-face identity, alias values, source order,
load status, byte digest, descriptors, document identity and cache population.
The WPT fancy-feature font proves `salt=1` changes the complete HarfBuzz record
and remains identical to the corresponding direct OpenType feature.

The existing Playwright integration launches bundled Chromium headlessly and
uses same-browser screenshots only as an anti-vacuity discriminator. No pixel
threshold, cross-renderer raster claim, or tolerance changed.

## Commands

```sh
npx vitest run tests/font-feature-value-environment.test.ts \
  tests/shaping-font-feature-environment.test.ts \
  tests/shaping-font-feature-values.test.ts
npx vitest run --config vitest.e2e.config.ts \
  tests/shaping-font-feature-values.e2e.test.ts
npm run typecheck
```
