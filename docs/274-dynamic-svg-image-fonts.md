---
id: "requirements/dynamic-svg-image-fonts"
title: "Dynamic font values in isolated SVG images"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2K0K01", "DM-53WRGR", "DM-NZQE02", "DM-10TEGA", "DM-AZY7MZ", "DM-3P65HE", "DM-0R35WP"]
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
    "src/capture/image-svg-font-witness.ts",
    "tests/image-svg-font-witness.e2e.test.ts",
    "tests/image-svg-font-conditions.e2e.test.ts",
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
`font-display:auto/block/swap`; a single valid `data:` source in those modes is
admitted on that proof alone. `optional/fallback` can retain a fallback after
bytes load, so detached validation alone cannot authorize them.

### Painted used-face witness

Faces whose use is decided inside the image document need a browser witness
(`src/capture/image-svg-font-witness.ts`, DM-3P65HE): `font-display: fallback`,
a `src` list with more than one entry, and the `size-adjust`,
`ascent-override`, `descent-override` and `line-gap-override` descriptors. On
a scratch page of the capture context, the witness renders in `<img>` boxes of
the captured content size and object-fit:

- the candidate: the image source as captured;
- a loaded reference: every face reduced to Domotion's selected source, with
  `font-display: block`;
- an absent reference: every `@font-face` removed;
- for each multi-source face, the candidate without its selected entry.

The faces are admitted only when the candidate's element screenshot is
byte-identical to the loaded reference, differs from the absent reference, and
every removal variant differs from the candidate. A face that changes no paint
(no text and no face-dependent geometry) leaves the references identical, so it
is not admitted. A witness that cannot render, such as a zero-sized box, admits
nothing.

Source selection follows `CSSFontFace::Load` / `GetFontData`
(`core/css/css_font_face.cc:155-200, 247-271`, Chromium `7d859f27`): sources
are tried in order and a source that fails to load is popped. The CSSOM `src`
value already omits entries whose `format()` / `tech()` the parser rejects
(`CSSFontFaceSrcValue::IsSupportedFormat`, `css_font_face_src_value.cc:85-99`,
adds only the legacy `.eot` URL check). Capture validates each `data:` entry
with a detached `FontFace` and selects the first that loads. Non-`data:`
URL entries are not modeled and keep the image raster.

A `local()` entry is resolved against the host's system fonts inside an SVG
image too: `LocalFontFaceSource::IsLocalFontAvailable`
(`local_font_face_source.cc:43-49`) asks the process-wide `FontCache` for a
platform unique-name match (CoreText, fontconfig or DirectWrite). Capture asks
the same `FontCache` with a detached `local()` `FontFace` (DM-0R35WP). A
name the host lacks is skipped to the next entry, as `CSSFontFace::Load` pops
it. A name the host has would paint that host face, whose bytes the
image-owned context does not carry, so the image stays raster. The witness
checks both outcomes: a skipped name must still paint the selected data
source, and a present one paints neither reference.

### Conditional face groups

An `@font-face` inside `@media` and `@supports` groups is decided in the
image's own environment (DM-0R35WP). `@media` uses `evaluateMediaQueryList`
with the image viewport (the concrete object size, so capture decides it only
for `object-fit: fill`, where that is the content box) and the embedder-supplied
environment (`ImageMediaEnv`). `@supports` uses the page's recorded answers
(`imageSvgSupports`), which capture now decides before the fonts. A face in a
false group is never created, so capture skips it without validating its
sources. Every admitted image with a group passes the witness, whose loaded
reference removes inactive faces and moves active ones out of their groups;
a wrong decision cannot be repeated by the browser in the reference. Capture
records each active face's condition chain and the viewport it was decided
for. The renderer re-decides each chain with the evaluators that freeze the
emitted sheet's groups and keeps raster when the answer differs, is undecided,
or the placement's image viewport differs from the recorded one. `@layer`,
`@scope` and `@container` parents remain raster: the parser accepts
`@font-face` in a `@container` rule list (`ConsumeContainerRule`,
`css_parser_impl.cc:2208-2240`), but which faces such groups contribute is
not modeled.

`font-display: optional` stays raster. `RemoteFontFaceSource::ComputePeriod`
(`remote_font_face_source.cc:113-136`) enters the failure period once rendering
has begun unless the font finished from the memory cache, finished before
rendering began, or no paint was requested while it was pending. An SVG
document begins rendering when its document element is inserted
(`Document::ChildrenChanged`, `document.cc:1265-1274`; only HTML documents have
render-blocking resources, `document.cc:9034-9037`), before a `<style>` child
can start a fetch. The memory-cache and pending-paint conditions are not
ordered by the source, so the outcome is not deterministic. Chromium 147 on
macOS painted the fallback in every witness run.

Metric descriptors follow `CSSFontFace::GetFontData`. `size-adjust` makes every
primary metric the face's metric at `ComputedSize * size_adjust`
(`FontDescription::SizeAdjustedFontDescription`, `font_description.cc:292-306`).
A complete ascent/descent/line-gap override set replaces `LineSpacing`
(`MetricsOverriddenFontData`; `font_metrics.cc:54-148`). A partial override set
leaves `lh` unresolved, and so does a Linux descent that rounds down, where
FreeType may borrow a pixel from the ascent. A variable face with
`size-adjust` stays unresolved, because optical sizing keeps the specified
size.

Active non-default `@font-face` feature and variation settings withhold
image-owned metric evidence (DM-QQV70M). Chromium merges these descriptors
into the face request, and a variation axis can change an advance used by
`ch`. Font-dependent transforms retain the source image. Static transforms
can still be lowered with the original stylesheet. Captures made before the
descriptor check need recapture when the source may contain non-default settings.

Native metrics retain platform-specific authority. macOS queries the owned
buffer with resolved axes and requires `nameMatchedInFile`, rejecting a helper
that falls back to an installed PostScript name. Live CoreText CSS-size metrics
can supply variable `normal` line spacing; older helpers leave that value
unresolved. Static exact-table fallbacks remain available on all three
platforms. Missing native ex/cap evidence, unsupported bitmap/VDMX cases and
unknown variable line metrics remain unresolved rather than borrowing a face.

Layered, scoped and container face groups, media/title-selected or foreign/inert style sets,
host-available `local()` and non-`data:` source candidates, `font-display: optional`,
angled oblique capability groups and variable slnt-axis faces
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
