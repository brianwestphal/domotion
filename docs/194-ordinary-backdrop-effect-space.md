# 194 — Ordinary backdrop Backdrop Root/effect-space ownership

**Status: source ownership shipped; final composite parity remains partial
(DM-2487).**

## Source contract

Chromium `7d859f271cbda744098ac69f44978d4edfa62be3` establishes a
backdrop target's nearest Backdrop Root in
`paint_property_tree_builder.cc`. The document, opacity, filter,
backdrop-filter, clip-path, mask, nonnormal blend, and matching `will-change`
states create roots. Ordinary stacking contexts, `isolation:isolate`,
transforms, overflow/scroll, fixed, and sticky positioning do not. In
`paint_layer.cc`, the target's regular filter is appended after the backdrop
operations. Pinned Skia `62efacd37737505732dbe3d8daa62abd679626a1`
uses the prior parent device as the backdrop input in `SkCanvas.cpp`.

The serialized contract now records that source decision, rather than asking
the renderer to infer it from a viewport-final PNG:

- the nearest root's kind, ancestor depth, selector, and source reason;
- every effect-bearing ancestor between the target and document root; and
- the subset of opacity/filter/clip/mask/rotate-skew paint already represented
  by an SVG wrapper and therefore neutralized for the Chromium crop.

The record is captured before the transform walker freezes rotate/skew. During
the screenshot pass, live ancestors are correlated by DOM-parent depth (no
author-visible attribute), neutralized reversibly, and kept as Blink roots via
the matching `will-change` property. Restoration is idempotent and occurs on
success and failure. Old serialized trees without the record retain their
previous crop and report `effect-space-unavailable`; exact materializations
remain silent.

`mix-blend-mode` remains a recorded root reason but is deliberately not
neutralized. A viewport screenshot cannot isolate the blend-root's transparent
local prior-device image, and changing the live blend to `normal` changed the
blend row from roughly 21% drift to 100%. Keeping the pre-existing crop is the
bounded, non-regressing fallback until the renderer can own an atomic root
surface.

## Unchanged-threshold browser result

`npm run paint:backdrop-source-audit -- --dpr 1,2` used the existing four-code
per-channel changed-pixel discriminator and 1% diagnostic classification. No
tolerance or mutation threshold changed.

| Row | Before DPR 1 / 2 | DM-2487 DPR 1 / 2 | Result |
| --- | ---: | ---: | --- |
| opacity root | 98.02% / 97.57% | 39.13% / 37.53% | improved; atomic root-group alpha remains |
| transformed non-root | 64.29% / 63.77% | 10.60% / 8.63% | improved; viewport-to-effect coordinate surface remains |
| mask root | 10.42% / 4.13% | 6.44% / 0.24% | DPR 2 exact; DPR 1 mask-edge ownership remains |
| filter root | 88.18% / 87.89% | 0.49% / 0.24% | exact under the existing classifier |
| blend root | 21.25% / 21.16% | 21.25% / 21.16% | deliberately non-regressed |
| target regular filter | 3.30% / 2.91% | 3.30% / 2.91% | target/group split remains |

Document-root, ordinary stacking/isolation, clip-path, fixed, nested,
overlapping, filter-root, and overflow-clip rows are exact at both DPRs.
Scroll and sticky are 1.20%/1.02% at DPR 1 and exact at DPR 2. The audit's
pseudo owner counter still reports `0/1` although the generated-pseudo pixel
row is exact; doc 193 owns that separate source record and gate.

The report therefore remains `investigation-complete`, not a native release
gate. Remaining ordinary-element ownership is explicit: opacity and blend need
an atomic transparent Backdrop Root surface; rotate/skew needs a source-owned
effect-space coordinate mapping; the target regular-filter chain needs one
shared target group; and the DPR-1 mask edge needs its root-local coverage.

## Validation

- capture bundle rebuild: successful;
- TypeScript: clean;
- effect-space, neutralization, isolation, and diagnostic units: 19/19;
- pinned Chromium audit: both DPR 1 and DPR 2 completed with no evidence
  blockers and unchanged thresholds.

Because the strict 17-family acceptance is not yet met, this change does not
add or promote a three-platform release workflow. The partial status and exact
residuals are retained in doc 187, parity metadata, and semantic coverage.
