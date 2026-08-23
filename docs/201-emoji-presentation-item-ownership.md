# Emoji presentation shaping-item ownership

DM-2502 investigates the sole significant HTML residual in native Linux arm64
run `32611751700`. It does not change production rendering or any pixel
tolerance. The source and logical discriminator agree on one root cause:
Domotion omits Blink's `SymbolsIterator` fallback-priority boundary when it
creates shaping items.

## Artifact verdict

The retained `02-text-emoji` evidence has one significant region at
`(336,150,33×24)`, area 146, maximum severity 100. Chromium paints the red
emoji-presentation exclamation U+2757; the generated SVG paints a small black
FreeSans outline. The artifact supplies three independent ownership facts:

- Chromium reports `NotoColorEmoji: 7`, exactly the seven emoji-presentation
  characters in the fixture.
- The generated FreeSans subset contains both U+2717 (gid 4757) and U+2757
  (gid 4821), and the SVG emits both from that subset.
- The remaining six emoji are healthy full-line rasters. Their agreement
  exonerates the CBDT screenshot/emission path and localizes the first wrong
  decision before raster ownership is computed.

## Chromium's source-owned split

Source is pinned to Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`.

`symbols_iterator.cc:17-30,34-76` runs the pinned emoji-presentation scanner,
coalesces adjacent equal source states, and returns `kText`, `kEmojiEmoji`,
`kEmojiTextWithVS`, or `kEmojiEmojiWithVS`. `run_segmenter.cc:18-23,48-69`
takes the next minimum limit across `ScriptRunIterator` and `SymbolsIterator`;
the selected priority travels on `RunSegmenterRange` in
`run_segmenter.h:30-39`. Then
`harfbuzz_shaper.cc:965-985` constructs a fresh `FontFallbackIterator` for each
range. CSS `font-variant-emoji` is applied after that source split
(`harfbuzz_shaper.cc:184-198,982-985`), so it may change a range's effective
priority but cannot erase the source boundary or merge two iterators.

For the exact 52-code-unit fixture line, Blink's item ownership is:

| UTF-16 range | source | priority |
| --- | --- | --- |
| `[0,43)` | `Status: done ✓ and flagged ✗ with emphasis ` | text |
| `[43,44)` | `❗` | emoji |
| `[44,52)` | ` nearby.` | text |

Declared faces still precede the priority face inside each iterator. A blanket
"Emoji_Presentation means Noto" rule would therefore be wrong: a declared
FreeSans face that covers U+2757 owns it under normal presentation, while
`font-variant-emoji: emoji` rejects the contradictory outline and proceeds to
the color face.

## Domotion's missing boundary

`script-segmentation.ts:309-318` documents that Blink's item is script ×
orientation × fallback priority, but `ShapingSegment` carries only script and
direction. `segmentForShaping()` at `:422-469` splits only on bidi-level or
script-set changes, so it returns one `[0,52)` Latin/LTR item for this line.
`cluster-fallback.ts:559-595` then allocates one iterator for the whole line and
`:634-668` derives priority later from the first currently queued hint.

Liberation Sans covers the prose and requeues U+2713, U+2717, and U+2757.
The shared text iterator asks U+2713 first, then U+2717; the latter selects
FreeSans, which also covers bare U+2757. The emoji-priority stage is never
entered. Once FreeSans is selected, `selectedGlyphRasterSpans()` correctly sees
an outline, prunes the raster candidate, and embeds the black vector. The
downstream behavior is faithful to the wrong upstream face.

## Strict native arm64 discriminator

`tools/emoji-presentation-ownership-audit.ts` records the source partition,
current item partition, selected face, route mechanism, physical color-table
evidence, and selected glyph representation. The workflow
`.github/workflows/emoji-presentation-ownership-audit.yml` authenticates the
published arm64 glyph and ICU helpers in the pinned Playwright Noble image
before running it.

The exact helper digests used by the retained run and the reproduction are:

| input | SHA-256 |
| --- | --- |
| arm64 glyph helper | `68546de5c29a60efbe1bdb86e61d14d9ba10f00020c5b50583f5bc336718c250` |
| arm64 ICU helper | `dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf` |
| ICU 78.2 data | `9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe` |

The exact native result is order-sensitive, which a raster-floor explanation
cannot produce:

| case | selected U+2757 face | representation | priority asks |
| --- | --- | --- | ---: |
| retained fixture order | FreeSans | outline | 0 |
| `✗ ❗` | FreeSans | outline | 0 |
| `❗ ✗` | Noto Color Emoji | CBDT bitmap | 1 |
| `✗ ❗️` | Noto Color Emoji | CBDT bitmap | 0 (VS mismatch requeue) |
| `✗ ❗︎` | FreeSans | outline | 0 |
| bare U+2757 with `font-variant-emoji:text` | FreeSans | outline | 0 |
| declared FreeSans, normal | FreeSans | outline | 0 |
| declared FreeSans, CSS emoji | Noto Color Emoji | CBDT bitmap | 1 |

The pinned ICU helper returns binary properties `0x98` for U+2757, including
both `Emoji` and `Emoji_Presentation`; classification and helper transport are
not the defect. The audit verdict is
`confirmed-missing-symbols-item-boundary`. It contains no raster tolerance.

## Downstream source boundary

HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab` only resolves a glyph inside the
face supplied to it (`hb-font.cc:1111-1137`, `hb-ot-font.cc:338-348`, and
`hb-ot-cmap-table.hh:2184-2224`). Chromium-pinned Skia
`62efacd37737505732dbe3d8daa62abd679626a1` loads and rasterizes the already
selected FreeType gid (`SkFontHost_FreeType.cpp:1066-1100,1218-1343,1398-1463`)
and performs BGRA-to-ARGB conversion in `_common.cpp:320-330`; neither stage
chooses a fallback face. Those source boundaries and the six healthy raster
rows rule out a native raster floor.

## Follow-up work

- **DM-2507** ports source-priority itemization into production. It must
  intersect SymbolsIterator ranges with bidi/script ranges before iterator
  allocation, retain source boundaries after CSS overrides, and remove
  first-hint ownership. The order pair, VS15/VS16, CSS text, and declared-family
  rows above are mandatory controls.
- **DM-2508**, blocked by DM-2507, flips this known-gap discriminator into a
  resolved regression gate, reruns `02-text-emoji`, and incorporates the exact
  report into the Linux arm64 release aggregate.

Neither follow-up may widen a logical or raster threshold.
