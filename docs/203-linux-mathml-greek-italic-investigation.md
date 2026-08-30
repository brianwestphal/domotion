---
id: "requirements/linux-mathml-greek-italic-investigation"
title: "Linux MathML Greek-italic residual investigation"
kind: "investigation"
status: "current"
owners: ["text-fonts","platform-release"]
platforms: ["linux"]
tickets: ["DM-2512"]
code: []
aliases: ["docs/203-linux-mathml-greek-italic-investigation.md","doc-203"]
---

# Linux MathML Greek-italic residual investigation

Status: **Logical oracle repaired; Linux raster supplement ratified**

The historical `mathml-mi-greek-italic` Linux failure is no longer an active
feature-gate failure on the pinned Playwright noble image. A focused
helper-enabled run on 2026-08-23 reported `diffPct 0.2705746`, 548 changed
pixels, **zero significant regions**, and `coveragePct 0`; the fixture passed.
This does not justify changing a pixel threshold. The generated SVG paints the
six `<mi>` tokens as capture-owned raster images and paints the five operators
as source paths, so the remaining changed pixels are terminal mask differences,
not evidence for changing MathML substitution, font fallback, shaping, or
placement.

## Source reconstruction

At Chromium `7d859f271c`, `core/css/mathml.css:82-85` assigns
`text-transform: math-auto` to `<mi>`. `ComputedStyle::ApplyTextTransform`
dispatches that value to `ApplyMathAutoTransform`, which changes only a
one-code-unit token through `unicode::ItalicMathVariant`
(`core/style/computed_style.cc:1943-1974`). The actual Latin/Greek mapping,
including the U+210E exception, is in
`platform/wtf/text/math_transform.cc:42-116`. Domotion's captured scalars for
the fixture follow that same mapping (`α → U+1D6FC`, `β → U+1D6FD`,
`π → U+1D70B`, and the Latin/script tokens to their mathematical-italic
scalars). There is no MathML-specific HarfBuzz rewrite after this point:
HarfBuzz `4de187dd0` shapes the already-transformed buffer with the selected
font and returns glyph ids, clusters, advances, and offsets.

Chromium pins Skia `62efacd3`. In that revision,
`SkTypeface_FreeType::onFilterRec` disables hinting for non-axis-aligned text
but retains requested hinting for ordinary horizontal text; the scaler maps
the remaining hinting level to `FT_LOAD_TARGET_LIGHT`,
`FT_LOAD_TARGET_NORMAL`, or LCD flags
(`src/ports/SkFontHost_FreeType.cpp:817-845,948-995`). Skia's vector-path path
clears render/color/bitmap flags and decomposes the loaded outline
(`src/ports/SkFontHost_FreeType_common.cpp:1988-2011`). Consequently native
Skia masks and consumer-rasterized SVG outlines may differ even when source
face, gid, advance, offset, and geometry agree. This is the same terminal
boundary documented by the authenticated paths/native-raster matrix; it is not
a license to accept a logical mismatch.

## Current renderer and repaired logical proof

The older diagnosis in docs 42 and 45 assumed the mathematical-italic glyphs
reached the SVG path terminal from upright FreeSans. The current production
failure-boundary contract does not ask the consumer to select and shape an
authored family when a selected outline cannot be emitted. It retains the
capture-owned raster overlay and emits a non-painting, accessible source
boundary. The focused Linux SVG contains six `<image>` overlays for the six
`<mi>` tokens and no visible authored `<text>`; this explains why the formerly
significant FreeSans outline/native-mask residual is now below the feature
suite's region classifier.

The repaired logical oracle consumes DM-2512's token-only pre-terminal
projection instead of demanding paths provenance from a capture-owned raster
terminal. Production provenance now records that early owner as
`capture-raster` (`transform-subtree-raster`, `text-segment-raster`, or the
legacy `element-raster`) so a zero paths-run result cannot pass vacuously. The
oracle then removes only that terminal metadata from a clone and re-enters the
same production paths renderer to join CDP PostScript face/cut to exact selected
source bytes, face index, gid, cluster and source spans, advances/offsets, and
outline identity. Helper-enabled and helper-disabled arms prove availability
changes from true to false while preserving those physical facts and the
captured terminal; the Linux system resolver may retain the same FreeSans
route because Fontconfig exposes the identical source without the helper.

Doc 210 also defines an isolated Linux supplement for the exact
Noble FreeSans package, mathematical-Greek gids/outlines/subsets, captured
baselines, native/paths PNGs, and an active no-hint control; see doc 210. Its
independent `ubuntu-24.04` proposal and validation collections in workflow run
`32628749740` agreed on every authenticated logical fact and artifact hash, used
different boot identities, and kept every validation residual within the
proposal maximum. The reviewed supplemental envelope classifies only this
terminal FreeType mask boundary as `ratified-rasterization-only`; no feature or
scalar threshold changed.
