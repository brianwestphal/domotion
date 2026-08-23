# Blink-owned vertical orientation and text-combine ownership

Status: implemented for DM-2525.

This contract replaces scalar-by-scalar and handwritten-range guesses with the decisions made by the pinned Blink/ICU source. It covers the logical orientation record and captured physical fragment placement. It does not compare final raster ink and does not introduce a visual tolerance.

## Source authority

The source checkout used for the transcription is Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`, whose ICU dependency is `d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738` (Unicode 17.0.0). The generated source image is `third_party/icu/source/data/unidata/ppucd.txt`, SHA-256 `bccc5a5ca1baea3de767e8266d59ffa13ff99595bea37ca82415851386f57dbd`.

The decisive source handoffs are:

- `platform/text/character.cc`: `Character::IsUprightInMixedVertical` returns false only for ICU `U_VO_ROTATED`; U, Tu, and Tr remain upright.
- `platform/text/character.h`: `Character::IsGraphemeExtended` is ICU `UCHAR_GRAPHEME_EXTEND`.
- `platform/fonts/orientation_iterator.cc`: the first scalar establishes an orientation, and a later scalar may change it only when it is not `Grapheme_Extend`. UTF-16 offsets and invalid-surrogate substitution come from `UTF16TextIterator`.
- `core/layout/layout_text_combine.h`: `LayoutTextCombine::IsSupportedMode` rejects a horizontal typographic writing mode.
- `platform/text/writing_mode.h`: `horizontal-tb`, `sideways-rl`, and `sideways-lr` are horizontal typographic modes. Only `vertical-rl` and `vertical-lr` can own text combine.

HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab` shapes the already-itemized run, but does not own either classification above. No HarfBuzz glyph or raster observation is used to infer these decisions.

## Production transcription

`tools/generate-vertical-orientation-ranges.mjs` reads the pinned `ppucd.txt` and generates two complete, digest-stamped tables in `src/capture/script/vertical-orientation.generated.ts`:

- 90 mixed-upright ranges, 331,699 members;
- 383 `Grapheme_Extend` ranges, 2,232 members.

`src/vertical-orientation.ts` is the single runtime owner. It decodes UTF-16 the same way as Blink, emits orientation runs at UTF-16 boundaries, expands those runs to the capture protocol's one-entry-per-code-unit arrays, and transcribes the supported text-combine writing modes.

Every live consumer uses this owner:

- ordinary text capture resolves a complete column run so marks and supplementary variation selectors inherit the base orientation;
- pierced broken-image alternative text uses the same whole-run route;
- generated-pseudo rendering no longer has its own shortened CJK range table and asks the common source classifier for each retained pseudo text unit;
- text combine activates only in `vertical-rl/lr`, while authored `all` in `sideways-*` remains an ordinary rotated run.

The live placement gate also found a separate ordering error in `sideways-lr`: logical characters advance bottom-to-top, so first/last logical records can produce a negative physical envelope. Capture now unions the authoritative Range rectangles for the column while retaining logical-order `yOffsets` for glyph placement.

Generated pseudos retain their already-captured whole-fragment box, baseline, and inline advance. DM-2525 changes the orientation decision inside that protocol; it does not substitute host boxes or infer a new pseudo baseline.

## Exact evidence

`tools/vertical-orientation-oracle.ts` independently parses and compares all 1,114,112 Unicode code-point slots in the pinned source image, then corroborates every generated transition with 1,866 authenticated ICU 78.2 companion probes. Those probes cover the first, middle, last, and adjacent scalar around every generated `Vertical_Orientation` and `Grapheme_Extend` range. The oracle then runs representative R/U/Tu/Tr, Latin, Han, Hangul, Arabic, supplementary-plane, combining-mark, variation-selector, explicit upright/sideways, and identical en/ja/ko/ar locale rows. The report carries the source image digest, Unicode version, source revisions, runner, architecture, Node version, and exact logical arrays.

`tests/vertical-orientation-capture.e2e.test.ts` independently reads each scalar's live `Range.getBoundingClientRect()` and compares it exactly with the production capture record. Eleven rows cover mixed/upright/sideways, vertical-rl/lr, sideways-rl/lr, vertical-only combine, locale/script interactions, combining ownership, supplementary scalars, and the bottom-to-top sideways-lr envelope.

The negative controls are mandatory and independently moving:

- the retired shortened table misclassifies `§`, left single quotation mark, and ace of spades;
- a per-scalar mutation misclassifies both `A` + U+20DD and Han + supplementary IVS ownership;
- a mutation that treats `sideways-*` as combine-capable activates the wrong layout owner;
- a Unicode 16 metadata mutation is rejected by the Unicode/source-image identity gate.

`.github/workflows/vertical-orientation-parity.yml` runs the generated-source check, authenticated ICU oracle, unit controls, and exact live placement test on macOS, Linux, and Windows. Each platform uploads its fingerprinted logical report. There is no screenshot comparison, pixel score, fitted constant, or tolerance path in the workflow.

## Updating the pin

A Chromium/ICU roll is intentional work:

1. update the pinned source revisions and acquire that exact ICU `ppucd.txt`;
2. regenerate both properties together;
3. review the member counts and packed digests;
4. run the native oracle and live capture corpus on all three platforms;
5. keep every negative mutation active.

Changing only a generated range, accepting a host `Intl` result, or weakening a visual gate is not an acceptable roll.
