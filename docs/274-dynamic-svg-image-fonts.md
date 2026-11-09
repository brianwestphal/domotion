---
id: "requirements/dynamic-svg-image-fonts"
title: "Dynamic font values in isolated SVG images"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2K0K01", "DM-53WRGR"]
code:
  [
    "src/render/svg-image-font-shorthand.ts",
    "src/render/svg-image-css-variables.ts",
    "src/render/svg-image-style-names.ts",
    "src/render/svg-image-root-font.ts",
    "src/render/svg-image-root-stylesheet.ts",
    "src/render/svg-image-root-transform.ts",
    "src/render/svg-inline.ts",
    "tests/img-svg-dynamic-font-names.e2e.test.ts",
    "tests/img-svg-root-sheet-font.e2e.test.ts",
  ]
aliases: ["docs/274-dynamic-svg-image-fonts.md"]
---

# Dynamic font values in isolated SVG images

An SVG loaded through an image has its own document, font-face names and root
font cascade. Inlining must preserve those boundaries. This contract extends
the [native SVG image inlining](96-native-svg-image-inlining.md) and
[images/media handbook](handbook/images-media-and-embedding.md) contracts.

## Exact vector resolution

The parentless image root resolves font-size percentages, `em` and `rem`
against the image document's initial medium size. Its root transform can use
sizes calculated with nested `calc()`, `min()`, `max()` and three-argument
`clamp()` over the already supported absolute and initial-font-relative units.
Dimensional arithmetic must remain valid; nonfinite values, mismatched
dimensions and unsupported units are unresolved. Blink evaluates font-size
math against the parent size in `StyleBuilderConverterBase::ConvertFontSize`
and `ComputeFontSize` (`style_builder_converter.cc:910–970`, Chromium
`7d859f27`).

Unregistered custom properties use the same decidable root selector, layer,
importance and source-order cascade as root font declarations. Names remain
case-sensitive; escaped identifiers remain unresolved. Substitution supports nested values, missing-value fallbacks,
empty values and CSS cycle invalidation, including dependencies in unused
fallback branches. It preserves token boundaries and does not substitute in
strings or comments. Expansion has bounded depth, substitutions and size.

The shared shorthand parser finds font size, optional line height and family
without splitting balanced functions or quoted family names. It supports
ordinary style/weight/stretch keywords, numeric weights, `small-caps` and
oblique degree angles. Metric-dependent transforms retain their existing
conservative checks for unsupported font traits; recognizing a shorthand does
not claim exact metrics for every trait.

## Font-face isolation

Every locally declared font-face family and parsed font shorthand reference
gets the image prefix. Nested size math cannot hide a family reference.
For font variables, expansion is exact when each referenced unregistered
property has one definition in that same declaration block and no competing
definition elsewhere in the image. This also covers nested local aliases and
fallbacks. Only the consuming font declaration changes: original custom
property values, unrelated strings and URLs are preserved.

Unresolved or competing font variables and unparsed font shorthands that
could refer to an image-local face select the image raster fallback. They must
never leave an unprefixed local-family reference in the output document.

## Conservative boundaries

System font values remain platform-dependent. Registered custom properties,
undecidable selectors/conditions and CSS-wide variable rollback are not
guessed. If unavailable dynamic root font data prevents a transform from resolving,
the image retains its raster path. A static transform independent of that font
can still be lowered. General unsupported non-font transform fallback is a
separate existing issue tracked by DM-KGD5KC.

Unit tests cover parsing, dimensional math, cascade, variable cycles and
failure paths. Chromium E2Es compare image-document and inlined geometry, and
two different embedded fonts declaring the same family must remain distinct
and match each source image's pixels.
