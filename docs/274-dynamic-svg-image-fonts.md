---
id: "requirements/dynamic-svg-image-fonts"
title: "Dynamic font values in isolated SVG images"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2K0K01", "DM-53WRGR", "DM-NZQE02", "DM-10TEGA", "DM-AZY7MZ"]
code:
  [
    "src/render/svg-image-font-shorthand.ts",
    "src/render/svg-image-font-family.ts",
    "tests/svg-image-font-tail.e2e.test.ts",
    "src/render/svg-image-css-variables.ts",
    "src/render/svg-image-style-names.ts",
    "src/render/svg-image-root-font.ts",
    "src/render/svg-image-root-stylesheet.ts",
    "src/render/svg-image-root-transform.ts",
    "src/render/svg-inline.ts",
    "src/render/svg-image-own-fonts.ts",
    "src/capture/image-svg-fonts.ts",
    "tests/image-svg-own-fonts.e2e.test.ts",
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

Family tails must consume the complete CSS family list before a shorthand can
contribute root metrics. Numeric tokens, a generic keyword followed by another
identifier, missing list entries and malformed strings remain raster. Quoted
numeric names and escaped identifiers remain valid. Real comments separate
tokens; comment-like string data and unrelated custom property strings survive.
Generic keywords remain generic when a quoted local face has the same name.
These rules follow `ConsumeFontFamily`, `ConsumeFamilyName` and
`ConcatenateFamilyName` (`css_parsing_utils.cc:6302–6388`, Chromium `7d859f27`),
plus the four optional-component limit in `ConsumeFont`
(`shorthands_custom.cc:3100–3157`). Family parsing bounds input size and token
count. Literal names with decoded outer whitespace remain raster until the
shared CSSOM family bridge preserves that distinction (DM-N80HJW).

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

## Image-owned font metrics

Root metric units may use image-local data fonts when capture records
`imageOwnFonts`: the exact source digest, Chromium-validated descriptors and
normalized font bytes with independent digests. Capture requires the original
image to be complete with a positive intrinsic width. The detached validation
face never enters `document.fonts`. XML style entities are decoded before CSS
parsing; the existing bounded data-import decoder owns CSS charset precedence.
WOFF2 is normalized to SFNT before variable instancing.

The text engine empties caller registrations, registers only these image faces,
and restores caller state even on failure. Blink selects a descriptor capability
group before checking its unicode ranges; the primary space, digit zero and CJK
water lookups may therefore choose different faces or CSS fallback families.
Capability keys are quantized to Blink's quarter units. Omitted descriptors
retain their auto provenance, distinct from explicit normal when instancing axes.
The renderer resolves the original family names before namespacing their paint
definitions and references. Two images declaring the same family share no face
registrations. Missing evidence, a changed source or changed bytes retain raster
ownership for image-owned metric expressions, including direct font faces.
Font references in XML attributes are decoded to their DOM value before CSS
parsing and safely escaped on output; entity-encoded quotes or ampersands cannot
leave an image family exposed to an embedding-page face (DM-10TEGA).

The load-completion boundary is source-backed at Chromium `7d859f27`:
`SVGImage::CheckLoaded` requires `Document::LoadEventFinished`,
`IsolatedSVGDocumentHost` installs and resolves style before signaling completion,
and font resources are load-blocking (`Resource::IsLoadEventBlockingResourceType`
and `ResourceFetcher::StartLoad`). Root font-unit conversion consults the primary
font during style conversion (`CSSToLengthConversionData::FontSizes`).
`RemoteFontFaceSource::UpdatePeriod` never enters the failure period for
`font-display:auto/block/swap`; those modes are admitted. `optional/fallback`
can retain a fallback after bytes load, so detached validation alone cannot
authorize them.

Native metrics retain platform-specific authority. macOS queries the owned
buffer with resolved axes and requires `nameMatchedInFile`, rejecting a helper
that falls back to an installed PostScript name. Live CoreText CSS-size metrics
can supply variable `normal` line spacing; older helpers leave that value
unresolved. Static exact-table fallbacks remain available on all three
platforms. Missing native ex/cap evidence, unsupported bitmap/VDMX cases and
unknown variable line metrics remain unresolved rather than borrowing a face.

Conditional or layered face groups, media/title-selected or foreign/inert style sets,
local or multiple source candidates, metric override
descriptors, angled oblique capability groups, variable slnt-axis faces and failure-period display modes
remain conservative (DM-WE2R1V). Existing unsupported root variation/stretch
properties retain their raster behavior. General text fallback's separate
descriptor-before-range defect is DM-7QQPJA; this change only corrects the
isolated primary-unit lookup.

## Conservative boundaries

System font values remain platform-dependent. Registered custom properties,
undecidable selectors/conditions and CSS-wide variable rollback are not
guessed. If unavailable dynamic root font data prevents a transform from resolving,
the image retains its raster path. A static transform independent of that font
can still be lowered. Unresolved non-font transforms and undecidable root
cascades also retain the source image fallback (DM-KGD5KC).

Unit tests cover parsing, dimensional math, cascade, variable cycles and
failure paths. Chromium E2Es compare image-document and inlined geometry, and
two different embedded fonts declaring the same family must remain distinct
and match each source image's pixels.
