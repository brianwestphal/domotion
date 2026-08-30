---
id: "requirements/source-owned-text-failure-boundary"
title: "Source-owned text failure boundary"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2399","DM-2511"]
code: ["src/render/form-controls.ts","src/render/text-to-path.test.ts","src/render/text.ts"]
aliases: ["docs/152-source-owned-text-failure-boundary.md","doc-152"]
---

# Source-owned text failure boundary

Status: **Shipped (DM-2399)**

`renderTextAsPath` has a non-null terminal. Once capture has selected and shaped
a run, an outline failure must not be converted back to authored SVG `<text>`:
that would ask the consumer browser to select a face and shape the text a second
time. The source browser's successful vector glyphs and capture-owned raster
glyphs remain in place; any unresolved source span ends at a labeled,
non-painting boundary with no `font-family` and no visible `<text>`.

## Source boundary

The rule follows the pinned engines rather than an output fixture:

- Blink shapes a concrete fallback queue and appends the chosen run through
  `ExtractShapeResults`; after system and last-resort candidates, the terminal
  `.notdef` pass returns the first candidate. See Chromium
  `7d859f271cbda744098ac69f44978d4edfa62be3`,
  `font_fallback_iterator.cc:120-164` and
  `shaping/harfbuzz_shaper.cc:965-1036,1117-1127`.
- HarfBuzz proves default ignorables paint no glyph: it zeros their advances
  and offsets, then replaces them with an invisible glyph or deletes them. See
  HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`,
  `src/hb-ot-shape.cc:778-846`.
- Skia distinguishes a missing vector path from missing metrics or pixels.
  `neverRequestPath` installs a null path while preserving the glyph advance;
  on macOS a color face sets that flag and still gets its advance from
  `CTFontGetAdvancesForGlyphs`. See Skia
  `62efacd37737505732dbe3d8daa62abd679626a1`,
  `src/core/SkScalerContext.cpp:255-294` and
  `src/ports/SkScalerContext_mac_ct.cpp:297-311`.

Those are three distinct ownership outcomes: source/helper vector outline,
capture raster pixels with retained shaped advance, or source-proven empty ink.
An empty outline that proves none of them is degraded; consumer family
selection is not a fourth engine outcome.

## Failure classification and routing

`resolveGlyphCommands` returns commands plus one of these dispositions:

| Evidence | Disposition | Paint owner |
| --- | --- | --- |
| fontkit returned commands | `source-outline` | source vector |
| same selected file/gid returned helper commands | `helper-outline` | source helper vector |
| source span is whitespace/default-ignorable | `legitimately-inkless` | source, intentionally no ink |
| capture selected a raster representation | `capture-raster` | captured image overlay |
| absent glyph or gid 0 without an outline | `missing-glyph` | documented degraded span |
| no trustworthy source cluster | `unclassified-empty-glyph` | documented degraded span |
| helper disabled, source file unavailable, helper file unopenable, or helper glyph absent | exact `helper-*` / `source-unavailable` reason | documented degraded span |

Classification reads the source text's UTF-16 span before falling back to
`Glyph.codePoints`. fontkit memoizes glyph objects by gid, so the latter can
describe a different scalar—especially shared `.notdef`, spaces, and astral
text. Diagnostics therefore preserve UTF-16 `[start,end)` spans and do not split
surrogate pairs.

Embedded-font declines are likewise explicit: primary unresolved, empty shaped
runs, layout failure, outline unavailable, PUA exhaustion, all raster-owned,
all inkless, or no emittable glyph. Every decline records an emitter transition
and enters paths mode. Paths mode then returns either:

- complete source outlines;
- successful outlines plus `data-domotion-text-owner="source-partial"` and the
  exact degraded spans;
- an all-raster/all-inkless labeled boundary beside caller-composed overlays; or
- `data-domotion-text-owner="source-boundary"` with the exact terminal reason.

The boundary is an accessible `<g role="img" aria-label="…"><title>…</title></g>`.
It deliberately paints nothing and contains neither authored text nor a family
request. This is a documented degraded-helper boundary, not silent success.

## Audited consumers

The non-null contract removes failure-dependent raw `<text>` routing from:

- single-line, segmented, multi-line, input, and textarea rendering in
  `src/render/text.ts`;
- file-input labels in `src/render/form-controls.ts`;
- vertical text and caret repaint call sites;
- typing-overlay line and mistake glyphs; and
- the element-level text-render exception catch.

Raw SVG text that remains belongs to a different source contract: captured
emphasis marks, synthetic UA/device chrome, list markers, and embedded-font PUA
streams. The last category uses a generated `dmfN` face and one pre-shaped PUA
codepoint per selected glyph; it does not expose authored text or family
selection to the consumer.

## Activation controls

`src/render/text-to-path.test.ts` pins every empty-outline classification row,
source-outline/helper-outline ownership, all-inkless and all-raster terminals,
mixed emoji/text, a missing authored family, private-use/icon `.notdef`
semantics, helper-file/glyph failures, and source-span serialization with an
astral scalar. A cross-platform captured fixture forces the embedded PUA
allocator past U+F8FF and proves the exact `pua-exhausted → paths` transition
without emitting authored `<text>`. The fixture is a retained webfont buffer,
so the control exercises the same platform-independent embedded coordinator on
macOS, Linux, and Windows rather than fitting a host font.

Production provenance now records decline reasons and degraded spans. Future
emitters must extend this classification table and add an independent
activation row; they must not restore a raw-family terminal.

DM-2511 extends the same transition stream to capture-owned terminals that
return before either text emitter. A materialized `transformSubtreeRaster`,
whole `TextSegment.rasterDataUri`, or legacy text `elementRaster` records
`kind: "capture-raster"` with its exact ownership reason. It is valid for that
terminal to have zero selected runs because selection already happened in
Chromium; it is not valid for the transition stream itself to be empty. The
MathML oracle proves the pre-terminal face/source/glyph record separately by
passing a raster-metadata-free clone through the same production renderer, then
requires exactly one final owner on the unchanged captured node.
