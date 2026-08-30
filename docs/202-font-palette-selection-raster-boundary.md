---
id: "requirements/font-palette-selection-raster-boundary"
title: "Font-palette selection and native paint gate"
kind: "contract"
status: "current"
owners: ["text-fonts","images-media"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2350","DM-2403","DM-2507","DM-2509","DM-2510","DM-2534"]
code: [".github/workflows/font-palette-ownership-audit.yml","src/capture/emoji.ts","src/capture/script/font-palette.ts","tests/fixtures/font-palette/COLR-palettes-test-font.ttf","tests/fixtures/font-palette/COLRv1-static-test-glyphs.ttf","tools/font-palette-dynamic-gate.ts","tools/font-palette-ownership-audit.ts","tools/font-palette-paint-gate.ts"]
aliases: ["docs/202-font-palette-selection-raster-boundary.md","doc-202"]
---

# Font-palette selection and native paint gate

DM-2350 traces the complete
`font-palette` ownership chain, replaces a platform-font visual with a pinned
COLR/CPAL webfont discriminator, and records a reproducible Domotion cache
identity defect; DM-2509 closes that defect. DM-2534 extends the same exact
ownership record through `palette-mix()`, animation time, adopted document
sheets, and Blink's current shadow-tree rule scope. No pixel tolerance is
introduced or changed.

## Verdict

Palette selection is a distinct paint identity within an already selected
face and glyph. Chromium owns the color-glyph paint and Domotion correctly
keeps that glyph on its browser-raster boundary. Capture now records the
computed token and its family-matched `@font-palette-values` rule (base palette
and ordered overrides). The selected-glyph pass adds face key, glyph IDs, and
representation to that record and to `src/capture/emoji.ts`'s PNG cache key.
Two copies of the same COLR glyph using different palettes therefore retain two
distinct Chromium-owned rasters.

The production verdict is `source-exact` for both DOM orders. DM-2510 promotes
that selection proof to a strict COLRv0/COLRv1 native paint gate on macOS,
Linux, and Windows. DM-2534 keeps the verdict `source-exact` for recursive
mixes, two frozen animation times, document/shadow scope, and forward/reverse
cache order at DPR 1 and 2.

## Pinned fixture and anti-vacuity

`tests/fixtures/font-palette/COLR-palettes-test-font.ttf` is the WPT
`COLR-palettes-test-font.ttf` from Chromium revision
`7d859f271cbda744098ac69f44978d4edfa62be3`. The repository copy is pinned by
both Git blob `0f28caf21e6fde2660c251471f528e4ed21b82a3` and SHA-256
`39002caac7857a2553ab2f9c832755b91a9c5976a6a303a927837d76a333f607`.
It is an Ahem-derived COLR v0 / CPAL v1 face. Glyph `A` is gid 35 and uses
palette entries 3 and 7, so source table colors are an exact logical oracle.

The older `20-deep-font-palette` page uses installed system fonts. On macOS,
changing its computed palette token left Apple Color Emoji screenshots
byte-identical. That page is useful as a broad visual but is not evidence that
palette selection happened. The bundled webfont removes installed-font and
palette-support ambiguity.

## Blink ownership

Source is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `style_builder_converter.cc:777-852` recursively converts `normal`, `light`, `dark`, a
  custom identifier, or `palette-mix()` to `FontPalette`. `font_palette.h` and
  `font_palette.cc` define its equality and hash, and `font_cache_key.h` keeps
  palette identity in the face cache key.
- `css_font_selector.cc:50-74,166-190` resolves a custom name against the
  requested family. `style_engine.cc:3577-3586,3628-3642` owns the registered
  rules, while `style_rule_font_palette_values.cc:43-140` resolves the base
  palette and ordered overrides.
- Computed style serializes the requested token, not the resolved CPAL
  selection. A trustworthy observation therefore combines the computed token,
  matching CSSOM rule/family, selected custom face and glyph, source CPAL
  tables, and painted colors.
- `palette_interpolation.cc:40-99` selects the first matching light/dark CPAL
  palette, falls an invalid base index back to palette 0, and ignores invalid
  override indices. `open_type_cpal_lookup.cc:26-77` reads the CPAL flags and
  colors. `palette_interpolation.cc:101-123` owns recursive `palette-mix()`;
  DM-2534 audits that state separately below.
- Palette application occurs when an `@font-face` or `local()` source creates
  `FontCustomPlatformData`; `font_custom_platform_data.cc:246-288` clones the
  typeface with `SkFontArguments::Palette`. Direct platform-font creation does
  not provide the same controlled fixture boundary.

## Skia and output ownership

Chromium pins Skia at
`62efacd37737505732dbe3d8daa62abd679626a1`.
`include/core/SkFontArguments.h:34-54,87-94` carries the palette index and
overrides. The FreeType backend selects the CPAL palette and applies valid
overrides in `SkFontHost_FreeType.cpp:347-432`; DirectWrite does the equivalent
in `SkTypeface_win_dw.cpp:112-193`; Fontations resolves and owns the cloned
palette in `SkTypeface_fontations.cpp:117-236`.

Those paths paint an already selected color gid. They do not turn a COLR glyph
into a Domotion-owned SVG outline. The correct output remains one tight
Chromium PNG embedded at the selected-glyph boundary. DM-2403/DM-2507 own the
preceding face/gid/representation decision; DM-2350 owns only which palette is
used within that selected color glyph.

## Oracle matrix

`tools/font-palette-ownership-audit.ts` runs eleven source-derived cases at DPR
1 and 2:

| transition | required result |
| --- | --- |
| `normal` | CPAL palette 0 |
| `light` / `dark` | first CPAL palette carrying the exact theme flag |
| named base 2 / base 3 | exact red+magenta / green+cyan layer colors |
| two-entry override | only the declared source entries change |
| duplicate override | the later declaration wins |
| invalid base | palette 0 |
| invalid override entry | valid entries apply; invalid entry is ignored |
| rule-family mismatch / missing rule | collapse to the normal palette |

Every row requires the pinned fixture digest/table structure, one painted
custom face, one glyph, the expected CSSOM rule identity, and the exact set of
opaque source colors. There is no percentage comparison or anti-aliasing
envelope. Mutation tests separately reject a wrong computed token, source gid,
custom-face flag, glyph count, source colors, inert expected color, CSSOM rule,
and CSSOM family.

The production discriminator captures the same gid twice with base 2 and base
3, followed by the reversed DOM order. Native screenshots differ in both
orders. Domotion now contains two PNG uses and two unique PNGs, each byte-equal
to its corresponding native screenshot regardless of which palette appears
first. The captured tree retains the resolved palette and selected
face/gid/`colr` record, and capture emits no warning.

The local DPR-1/2 report has 22/22 native rows exact and both production orders
at `source-exact`. The three-OS workflow records browser,
runner, fixture, and executable fingerprints and uploads lossless source and
captured PNG/SVG artifacts on every outcome.

## Strict COLRv0/COLRv1 paint promotion

`tools/font-palette-paint-gate.ts` retains every COLRv0 row above and adds the
pinned Chromium COLRv1 static test face
`tests/fixtures/font-palette/COLRv1-static-test-glyphs.ttf`. The copy is from
the same Chromium revision, Git blob
`a03de3f8db044859d2392c3a92e8a1f2d909bf35`, and SHA-256
`5cc3f86c7db4c4a1a00866cd0690c810acd9e9552c79d5395a53d592722d6d94`.
The gate parses the source COLR table rather than trusting a screenshot label:
U+F0100 is gid 8 and owns `PaintGlyph -> PaintLinearGradient`, whose two exact
stops are offset 0/1 and CPAL entries 0/4.

At DPR 1 and 2, normal, base-palette 1, and a two-entry override must each
produce a distinct custom-face native raster. Every fully opaque interior
sample must remain inside the two source endpoint channels; any source-constant
channel must remain exact, and every source-varying channel must vary. A
family-mismatched rule and a missing rule must collapse byte-for-byte to the
normal raster. These are logical channel and activation assertions, not a
whole-image percentage or adjustable anti-aliasing envelope. COLRv0 continues
to require its exact two source colors and exact capture/native PNG identity.

The local macOS run is `source-exact`: COLRv0 remains exact, and all 10 COLRv1
rows pass. `.github/workflows/font-palette-ownership-audit.yml` runs the same
immutable DPR-1/2 gate independently on macOS, Linux, and Windows and uploads
the report plus lossless artifacts on every outcome. Chromium's source split
is therefore explicit: static COLRv1 exercises Fontations on all three
platforms, while COLRv0 retains the Windows DirectWrite branch and Fontations
elsewhere.

## Recursive mix, animation, and shadow scope (DM-2534)

The dynamic extension is source-first rather than screenshot-fitted:

- `css_color_mix_value.cc:14-53` clamps each supplied percentage, fills a
  missing complement, normalizes the two weights, and retains a sub-100% sum
  as an alpha multiplier. `style_builder_converter.cc:777-852` recursively
  preserves both endpoint palettes, interpolation color space, and hue method.
- `font_palette.cc:14-43,90-107` includes the recursive endpoint trees,
  non-normalized percentages, normalized progress, alpha multiplier, color
  space, and hue method in equality and hashing.
- `interpolable_font_palette.cc:51-82` clamps animation progress to `[0,1]`,
  keeps exact endpoints at 0 and 1, and represents interior animation states
  as Oklab palette mixes with an implicit (null) hue method, distinct in
  `FontPalette` identity from an authored default-shorter method. Capture reads
  that computed state at the frozen frame; it does not estimate time from
  pixels.
- `css_font_selector.cc:50-108,166-190` resolves custom endpoints against the
  selected family. `palette_interpolation.cc:12-123` recursively mixes the
  resulting CPAL records, and `font_custom_platform_data.cc:246-288` supplies
  the fully interpolated colors to Skia as palette-zero overrides.
- `style_engine.cc:3159-3167` deliberately ignores
  `@font-palette-values` declared inside a shadow tree today. Document rules
  still apply to shadow descendants; the last matching document rule wins,
  and document `adoptedStyleSheets` participate. Capture mirrors that precise
  limitation and records the descendant identities on an open custom-element
  raster host. It does not invent support for a shadow-local rule.

`src/capture/script/font-palette.ts` now emits a recursive paint identity with
the requested token, rule/family/base/ordered overrides, both mix endpoints,
weights, normalized progress, alpha multiplier, interpolation space, and hue
method. Raw calc-produced endpoint weights remain distinct from their separately
clamped paint progress. `src/capture/emoji.ts` canonicalizes missing custom
endpoints to normal, collapses recursively equal endpoint trees, and resolves
base indices and invalid overrides at every leaf before serializing the
complete selected face/gid/representation cache key. Open custom-element hosts
retain the document-owned or ignored shadow-descendant state that can change
their Chromium-owned raster.

`tools/font-palette-dynamic-gate.ts` adds six COLRv0 cases at each DPR:
sRGB 30% mix, Oklab animation at 30% and 50%, a document rule used inside a
shadow tree, an ignored shadow-local rule, and a last-wins adopted document
rule. The COLRv0 rows require exact source-derived opaque colors. Three COLRv1
rows per DPR require active normal/base/mixed gradients whose fully opaque
channels stay within their exact source endpoints. Four production controls
(forward and reverse order at DPR 1 and 2) require six native/captured PNG
hashes to match one-for-one, all recursive identities to be present, the
selected representation to remain `colr`, and capture to remain warning-free.

The local combined report is `source-exact`: 12/12 dynamic COLRv0 rows, 6/6
dynamic COLRv1 rows, and 4/4 production order controls pass. The same dynamic
gate is part of `.github/workflows/font-palette-ownership-audit.yml` on macOS,
Linux, and Windows. Browser launches are explicit headless launches. There is
no image-score target, adjustable threshold, or cross-run pixel fitting.

## Maintenance rule

Future changes must retain the static and dynamic source records, both DOM
orders, both DPRs, and the three native runner operating systems. Do not
vectorize COLR paint or widen a raster threshold.
