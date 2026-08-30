---
id: "requirements/portable-exact-shaping-controls"
title: "Portable exact-shaping applicability controls"
kind: "contract"
status: "current"
owners: ["text-fonts","layout","product-tooling"]
platforms: ["linux"]
tickets: ["DM-2500"]
code: ["tests/fixtures/variable-axis/variable-axis.html","tools/exact-shaping-control-fixtures.ts","tools/exact-shaping-oracle.ts"]
aliases: ["docs/199-portable-exact-shaping-controls.md","doc-199"]
---

# Portable exact-shaping applicability controls

DM-2500 closes an activation hole in the native Linux arm64 shaping gate. The
first retained run, `32611751700`, reached `tools/exact-shaping-oracle.ts` and
shaped 686 face/sample pairs, but its static Noble font inventory produced
`axes: 0` and `ptem: 0`. That result did not show a shaping disagreement; it
showed that the gate had no applicable face for two required inputs, so its
schema-v2 verdict was correctly withheld.

Host fonts remain the production comparison corpus. They are not treated as a
portable test corpus, because supported runner images are not required to
install a variable face or a modern AAT tracking face. The arm64 workflow now
passes two repository-owned fixtures explicitly to the exact gate:

- the 27,524-byte Open Sans variable subset already embedded in
  `tests/fixtures/variable-axis/variable-axis.html`, decoded SHA-256
  `c8886233e48f9757d48028f9517bcbe97603e685c31a49eb3a596461621f4a5a`,
  with `fvar`/`gvar`, `wght` 300–800, and `wdth` 75–100; and
- HarfBuzz's `test/shape/data/in-house/fonts/TRAK.ttf` at revision
  `4de187dd0a915d13c976fa8bd474c084229f3aab`, Git blob
  `3be9c0085421079272ddfbffc352862bbf0d0e9b`, decoded SHA-256
  `cf3fdeb89ad8e723633fa7f364d0c0097448236884a8299a41a106904c50b7be`,
  carrying the `STAT` + `trak` tables. The checked-in form is base64 and is
  registered directly with HarfBuzz; neither fixture is installed as a
  platform font or added to the host `records`/`pairs` corpus.

## Source contract and destructive rows

Pinned Blink reads the resolved SkTypeface variation position and calls
`hb_font_set_variations` in
`third_party/blink/renderer/platform/fonts/shaping/harfbuzz_face.cc:570-583`.
It also passes the specified CSS size to `hb_font_set_ptem` at `:631-648`.
Pinned HarfBuzz enables tracking only when both `trak` and `STAT` exist
(`src/hb-ot-shape.cc:216-221`) and applies the resulting tracking at `:288-291`.

`tools/exact-shaping-control-fixtures.ts` therefore runs three omission-shaped
rows rather than arbitrary perturbations:

| Required input | Truthful baseline | Destructive mutation | Expected advances |
| --- | --- | --- | --- |
| `wght` | Open Sans `wght=800, wdth=100` | omit axes (defaults) | complete 15-glyph stream changes |
| `wdth` | Open Sans `wght=400, wdth=75` | omit axes (defaults) | complete 15-glyph stream changes |
| `ptem` | upstream `TRAK.ttf`, `ptem=9` | unset `ptem` | `1060,1060,1060` → `1000,1000,1000` |

A row passes only when both complete logical streams match their pinned
expected arrays and SHA-256 digests and `changedFields` is exactly
`["xAdvance"]`. Glyph IDs/count/order, clusters and source spans, y advances,
x/y offsets, and flags must remain byte-exact. This catches the actual omission
bugs (`hb_font_set_variations` or `hb_font_set_ptem` not called) without relying
on a potentially clamped `+1` coordinate or accepting an unrelated glyph-stream
change.

## Schema-v3 evidence and failure policy

`shaping.json` keeps the legacy aggregate `controlHits` and `missedControls`
consumed by the unified oracle, and adds `hostControlHits`,
`applicableControlHits`, and full `controlRows`. Every row records required
tables, decoded and pinned digests, upstream repository/revision/path/blob and
license, baseline/destructive inputs, expected and actual logical arrays and
digests, exact changed fields, and explicit applicability/movement states.

Missing, corrupt, wrong-digest, or wrong-table fixtures are written as
`inapplicableControls`; valid but inert rows become `nonMovingControls`; any
extra logical mutation becomes `unexpectedControls`. Their union is
`failedControls`, which withholds the verdict even if a host face happened to
move the same aggregate control. Fixture validation never throws before the JSON
artifact can be written. Rasterization remains `out-of-scope`; no pixel
tolerance or native-raster threshold changed.

On the local pinned environment the representative gate reports schema 3,
`exact-logical-agreement`, 687 host face/sample pairs, host hits `axes: 21` and
`ptem: 46`, portable hits `axes: 2` and `ptem: 1`, and no missed,
inapplicable, non-moving, unexpected, or failed controls. The native arm64
workflow also exports the authenticated Chromium/HarfBuzz/Skia/ICU source
revisions required by the parity fingerprint. A fresh retained native artifact
after integration is still required; local evidence does not substitute for
that runner result.

```sh
npx vitest run tests/exact-shaping-control-fixtures.test.ts \
  tests/linux-arm64-release-parity-workflow.test.ts
npm run fonts:shaping:exact -- --json tests/output/shaping-exact.json
```
