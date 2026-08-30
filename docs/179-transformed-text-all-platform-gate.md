---
id: "requirements/transformed-text-all-platform-gate"
title: "Transformed-text all-platform parity gate"
kind: "contract"
status: "current"
owners: ["text-fonts","layout","platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2471"]
code: [".github/workflows/text-transform-parity.yml","tools/text-transform-geometry-audit.ts"]
aliases: ["docs/179-transformed-text-all-platform-gate.md","doc-179"]
---

# Transformed-text all-platform parity gate

DM-2471 turns the transformed-text discriminator from doc 159 into a hard,
two-leg release gate for the source-owned capture and renderer model in docs
159 and 177. The gate runs the same corpus and fixed thresholds on macOS,
Linux, and Windows; it never substitutes a platform screenshot baseline or a
platform-specific tolerance envelope.

## Two independent legs

`tools/text-transform-geometry-audit.ts` first retains each real Chromium text
node through CDP and reads its oriented content quads in three states: live,
with every transform/perspective owner neutralized while CSS zoom remains
active, and restored. It independently solves the signed affine matrix and
compares all ordered physical fragments with production capture:

- live and restored quads must agree within `1/64` CSS px;
- serialized live and neutral quads must agree with the direct protocol facts
  within `1/64` CSS px;
- the captured and independently solved matrices must agree within `1/256`;
- every held-out corner must be within `0.05` CSS px;
- physical fragment indexes must be complete and unique, and shaped origins
  and advances must remain paired.

Projective text is the positive raster control: its fourth corner must reject
the affine plane and production must retain exactly one outer Chromium surface.
The planar `matrix3d()` negative must retain the affine vector route.

The second leg independently screenshots the restored Chromium source and the
complete generated SVG. Transparent source/output frames are compared in
device pixels. Every row requires all four ink edges within four device pixels,
bidirectional ink-mask disagreement at most 8% under only a one-device-pixel
neighborhood, and premultiplied color error at most 10%. Those constants are
identical on every OS and DPR; antialiasing cannot select a wider envelope.

## Corpus and mutations

The 25-case corpus is crossed with DPR 1 and 2. It includes identity and
translation negatives; the equal-diagonal scale/rotate collision; anisotropic
scale; rotate plus scale; both skews and both reflections; nested asymmetric
origins; content-box/border-box reference boxes; wrapped fragments; mixed
faces/sizes; decorations, shadows and stroke; a bitmap color-glyph overlay;
horizontal, RTL and vertical writing; zoom; a same-origin iframe; affine and
projective matrix3d controls; and focused extracts tied by SHA-256 to
`21-deep-anisotropic-scale.html` and `21-deep-transform-origin.html` from HTML
evidence run `32366215930`.

Eight mandatory mutations must visibly move the measured answer:

1. collapse the equal-diagonal scale/rotate collision to a scalar;
2. drop rotation/skew off-diagonals;
3. discard reflection sign;
4. collapse content-box and border-box origin translation;
5. union wrapped physical fragments;
6. fold CSS zoom into the paint matrix;
7. apply the matrix twice; and
8. force the projective positive down the vector route.

The report records the pinned Chromium, HarfBuzz and Skia revisions, Playwright
and Chromium versions, user agent, OS release/architecture, Node version,
viewport/DPR set, requested font families, selected face facts, thresholds, and
the two integration-fixture hashes. Missing rows, warnings on affine rows,
scalar vocabulary, a missing bitmap overlay, an incorrect raster owner, a pixel
failure, or a dormant mutation makes the command non-zero.

## CI ownership

`.github/workflows/text-transform-parity.yml` runs the static corpus/tolerance
test and complete 25 × DPR-1/2 gate on native macOS, Linux, and Windows runners.
Each runner uploads its own fingerprinted JSON artifact even on failure. The
matrix is the cross-platform proof: a macOS result is never copied to another
platform, which is essential because Chromium's font selection and rasterizer
are platform-owned.

The gate protects the retained baseline provenance behaviorally through final
ink placement. Capture still describes that value as the normal shaped-segment
baseline when present, otherwise captured ascent plus physical origin; there is
no claim that CDP exposes a separate private `LayoutText` baseline field.
Generated-pseudo direct-record consumption remains the separate source-owned
pseudo path documented in docs 157, 175, 176, and 178.
