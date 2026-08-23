# Font-palette selection and raster-boundary investigation

DM-2350 is an investigation, not a production change. It traces the complete
`font-palette` ownership chain, replaces a platform-font visual with a pinned
COLR/CPAL webfont discriminator, and records a reproducible Domotion cache
identity defect. No pixel tolerance is introduced or changed.

## Verdict

Palette selection is a distinct paint identity within an already selected
face and glyph. Chromium owns the color-glyph paint and Domotion correctly
keeps that glyph on its browser-raster boundary. Domotion does not currently
capture the computed/resolved palette identity, however, and
`src/capture/emoji.ts` keys its raster screenshot cache without palette, face,
gid, or selected representation. Two copies of the same COLR glyph using two
different palettes consequently reuse the first screenshot.

The investigation verdict is therefore
`confirmed-palette-identity-gap`. It is a successful source diagnosis, not an
exact production-paint verdict.

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

- `style_builder_converter.cc:829-852` converts `normal`, `light`, `dark`, a
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
  that animated/mixed state is deliberately outside this first audit.
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

The production discriminator then captures the same gid twice with base 2 and
base 3, followed by the reversed DOM order. Native screenshots differ in both
orders. Current Domotion output contains two PNG uses but only one unique PNG;
reversing the order changes which PNG is duplicated. The captured tree has no
`fontPalette` fact, the selected representation remains `colr`, and capture
emits no warning. This order-sensitive first-raster signature isolates the
cache key and rules out source-table, face-selection, gid-selection, and
raster-activation explanations.

The local DPR-1/2 report has 22/22 native rows exact and both production orders
at `confirmed-palette-identity-gap`. The three-OS workflow records browser,
runner, fixture, and executable fingerprints and uploads lossless source and
captured PNG/SVG artifacts on every outcome.

## Required follow-ups

1. **DM-2509** captures a durable palette record: computed token plus resolved
   rule family, base palette, ordered valid overrides, and selected
   face/gid/representation. Include that record in color-glyph raster cache
   identity and retain the A/B plus reverse-order mutation as the regression.
2. **DM-2510**, after that production fix, promotes this investigation to a
   strict macOS/Linux/Windows paint gate. Add a deterministic COLRv1 row to
   cover the all-platform Fontations backend while retaining COLRv0 for the
   Windows DirectWrite split.
3. Keep `palette-mix()`, palette animation, and Blink's documented shadow-tree
   palette-rule scoping limitation as later, separately adjudicated work.

The follow-up must not vectorize COLR paint or widen a raster threshold.
