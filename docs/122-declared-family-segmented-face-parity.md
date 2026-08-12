# 122 — Declared-family and segmented-face fallback parity

Status: **shipped** (DM-2090). Chromium references are pinned to `7d859f27`.

This is the source map for the two front stages of Blink's fallback iterator.
The implementation lives in `font-resolution.ts` (family parsing, lookup, face
selection, registries) and `cluster-fallback.ts` (iterator and requeue loop).

## Declared families (`kFontGroupFonts`)

| Blink branch | Pinned source | Domotion transcription |
| --- | --- | --- |
| Ordered family access; loading/unavailable skip | `font_fallback_list.cc`, `FontDataAt`; `font_fallback_iterator.cc`, `Next` | `splitFontFamilyNames` → `resolveFontKey` / `resolveFontKeyChain`; unavailable entries are omitted before `familyCycle` |
| Generic substitution | `font_selector.cc`, `FamilyNameFromSettings`; `generic_font_family_settings.cc` | generic keyword bit plus session/script settings in `matchFamilyNameToKey` |
| Quoted generic semantics | `font_selector.cc:25-32`; `font_family.cc`, `InferredTypeFor` | quoted/case-variant spellings remain literal families |
| Platform aliases and case | `font_cache.cc`, platform creation; pinned Skia `SkFontConfigInterface_direct.cpp` | native family-style matchers; Linux `skiaFamilyMatchAcceptable`; dynamic concrete-face registration |
| `local()` full/unique-name lookup and source fallback | `css_font_face_source.cc`; `font_face.cc` | browser probe plus ordered `localFontAliasRegistry`; unresolved sources walk on |
| Literal first family reused later | platform fallback's `FontDescription::Family()` call sites | raw computed `fontFamily` is threaded as `declaredFamily`, separate from the resolved key |
| First candidate / terminal donor | `font_fallback_iterator.cc`, `UniqueOrNext` and `kFirstCandidateForNotdefGlyph` | first materialized candidate is retained and re-returned after exhaustion |

Family matching follows each platform's case behavior. Generic
*classification* is case-sensitive: computed keywords serialize in canonical
lowercase, while quoted and case-variant names are literal. `system-ui` also has
Blink's exact-name platform intercept.

## Segmented faces (`kSegmentedFace`)

Blink first uses `FontFaceCache` and `FontSelectionAlgorithm` to select one
exact `FontSelectionCapabilities` group (stretch, slope, then weight). Only
declarations in that group form the `CSSSegmentedFontFace`. `GetFontData`
appends valid faces in reverse declaration order; the iterator filters them via
`RangeSetContributesForHint`, starts needed loads, skips loading/invalid data,
and returns each loaded contributing range. Entire-range physical faces are
deduplicated; subsetted faces are not, because HarfBuzz depends on the clamp.

Domotion mirrors that construction:

- `webfontVariantsInDeclarationOrder` selects one weight/style/stretch
  capability group, then materializes only that group's declarations in reverse
  source order. Variable axes are instanced at the requested, descriptor-clamped
  location.
- `cluster-fallback.ts` retains a cursor per segmented family, filters against
  the current hint list, and clamps HarfBuzz coverage to `unicode-range`.
  Overlapping partitions remain distinct even when their bytes are identical.
- A miss resumes the next segment and then the next declared family. Clusters
  straddling ranges are shaped and requeued by missing-cluster verdicts.
- The one-shot variation-selector reset clears segment cursors and
  first-candidate bookkeeping at the iterator reset point.

Primary sources: `font_face_cache.cc` (`CapabilitiesSet` and selection query),
`css_segmented_font_face.cc` (`GetFontData`, reverse walk, valid/loading
checks), `segmented_font_data.cc` (first covering face), and
`font_fallback_iterator.cc` (`NeedsHintList`, range contribution,
`UniqueOrNext`, and transitions).

## Discriminating coverage

- Family order, missing first families, quoted generics, case variants and
  aliases: `quoted-generic-family.test.ts`, `family-pin-parity.test.ts`, and
  platform declared-family tests.
- `local()` source ordering and unavailable sources: capture font-discovery and
  local-alias tests.
- Overlapping ranges, identical resources, reverse declaration order, and
  weight/style/stretch/variable groups: `webfont-declaration-order.test.ts`
  plus descriptor and synthesis suites.
- Range misses, combining clusters, partial conjuncts, variation sequences and
  terminal boundaries: `cluster-fallback.test.ts` and the same-machine
  `cluster-conformance` matrix, run on macOS, Linux, and Windows.

## Visible exclusions

Domotion registers OpenType/TrueType, WOFF, and WOFF2 sources that decompress to
a font fontkit can parse. EOT, SVG fonts, incremental-transfer `tech()`, paint
features unsupported by the downstream renderer, and failed/unparseable
responses are not parity claims. Discovery tries the next declared usable URL
and records a failed `WebfontRegisterReport` row with the HTTP, decompression,
or parse error when none works. The family then behaves as unavailable and the
walk continues. Pending network-load timing is not reproduced after capture:
capture waits for `document.fonts.ready` and transcribes the settled result.
