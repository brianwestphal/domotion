# 157 — Generated pseudo fragment and baseline geometry audit

**Ticket:** DM-2383  
**Status:** investigation and design only; production is unchanged  
**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and the
Chromium-pinned Skia revision `62efacd37737505732dbe3d8daa62abd679626a1`

## Verdict

Domotion does not yet have a source-exact representation of in-flow
`::before` and `::after` content. The current code has two independent
geometry approximations:

1. `pseudo-content.ts` lays out an isolated real-element clone, but keeps only
   an aggregate width and reconstructs the text origin with
   `(lineHeight - fontSize) / 2` plus host-edge arithmetic.
2. `pseudo-inject.ts` then moves the captured pseudo beside the first or last
   ordinary host text segment and copies that segment's `y` and `height`.

Neither value exists in Blink's source model. Blink creates real anonymous
layout children for each generated text, counter, and image item. The inline
layout algorithm assigns those children to line fragments, resolves bidi into
visual order, applies margins/borders/padding and `vertical-align`, and moves
their physical fragments. Text paint consumes those final fragments and the
selected font's ascent. A single synthetic string, host anchor, or
font-size-based half-leading cannot reproduce that ownership.

The exact replacement is a protocol-derived **pseudo fragment record**. It
must preserve the generated content-item boundary, UTF-16 source span, visual
order, physical quad, line-relative baseline, writing mode, selected face,
and shaped advance for every text/image fragment. When Chromium does not
expose an unambiguous mapping, capture must warn and retain the isolated
Chromium-painted pseudo surface. It must not silently use the known-inexact
host-anchor heuristic for a new capture.

This investigation intentionally makes no production change. Follow-up work
is dependency ordered as DM-2466 → DM-2467 → DM-2468.

## Current Domotion behavior

### Capture probe

`src/capture/script/walker/pseudo-content.ts` copies the pseudo's complete
computed style to a temporary `span`, inserts it before or after the host's
children, and observes both its border rectangle and a `Range` text rectangle.
That is useful evidence that Chromium performed layout, but the text
rectangle's origin, height, and fragment structure are discarded. The
remaining text path:

- emits only one `textSegment` for the complete generated string;
- takes width from the probe's aggregate text rectangle;
- places in-flow text at the host content edge;
- places text vertically at host top plus
  `(lineHeight - fontSize) / 2`;
- applies separate analytic containing-block arithmetic to positioned
  generated text; and
- represents a generated `url()` through a different `pseudoImages` record.

The aggregate record cannot express multiple wrapped fragments, multiple bidi
runs, vertical columns, fragmentainer translations, or the ordered sequence
of text/image/text content items. The half-leading formula is also materially
different from Blink's: Blink splits the difference between the CSS line
height and the font metrics' actual height, not the CSS `font-size`.

### Post-capture injection

`src/capture/script/walker/pseudo-inject.ts` applies a second approximation
after ordinary host text has been captured:

- `::before` is moved before the first host-owned text segment;
- ordinary `::after` is moved after the last host-owned text segment;
- flex and no-host-text cases use separate special anchors;
- a bottom-gap threshold guesses that `::after` wrapped to another line; and
- the pseudo's `y` and `height` are replaced by the chosen host segment's
  values.

This makes the pseudo inherit the host run's baseline even when its font,
`vertical-align`, borders, padding, or atomic-inline metrics differ. It also
assumes logical order is physical order, which does not hold after bidi
reordering or in vertical writing.

### Structural limitation

`src/capture/script/index.ts` captures pseudo content before ordinary text and
injects it afterward. `src/capture/types.ts` provides aggregate
`textSegments`, `pseudoImages`, and `pseudoBoxes`, but no identity joining a
pseudo, generated content item, line fragment, and baseline. The architecture
therefore cannot preserve Blink's fragment tree even though Chromium can
expose the required facts.

Existing coverage does not close this gap. The generated leg in
`tools/replaced-geometry-oracle.ts` and
`tests/generated-pseudo-layout-probe.e2e.test.ts` checks aggregate positioned
box bounds. The flex-after and before-marker tests protect existing special
cases with loose host-edge assertions. None proves a generated text
fragment's physical origin, baseline, visual order, or fragmentainer.

## Upstream ownership

The source boundary is split across Blink layout, HarfBuzz shaping, and Skia
paint:

| Decision | Source owner | Consequence for capture |
| --- | --- | --- |
| Pseudo existence and computed style | Blink `core/dom/pseudo_element.cc` | `::before`/`::after` are internal elements with resolved styles, not text decorations on the host. |
| Generated content children | Blink `core/style/content_data.cc` and `pseudo_element.cc` | Each text/counter/image content item becomes a separate anonymous layout child. Preserve content-item identity and order. |
| Inline/atomic class | Blink `core/layout/layout_object.cc` | The computed `display` can produce inline, atomic inline, block, flex, grid, table, or list-item layout. Do not force every pseudo into an inline string. |
| Line construction and bidi | Blink `core/layout/inline/logical_line_builder.cc` and `inline_layout_algorithm.cc` | Fragments are assigned to lines, then reordered visually and relatively positioned. Capture visual fragments after this stage. |
| Font strut and used-font metrics | Blink `core/layout/inline/inline_box_state.cc` and `line_utils.cc` | Leading comes from actual font metrics; `line-height: normal` can union used-font metrics from shaped results. |
| `vertical-align` | Blink `core/layout/inline/inline_box_state.cc` | `baseline`, `middle`, `sub`, `super`, `text-top`, `text-bottom`, `top`, `bottom`, lengths, and percentages move actual logical fragments using different parents/metrics. |
| Border/padding/margin edges | Blink `core/layout/inline/inline_box_state.cc` | Inline positions and line metrics include edge ownership and fragment decoration. A text-range union is not an inline box. |
| Text origin and writing transform | Blink `core/paint/text_fragment_painter.cc` | Paint takes the physical fragment, selected font ascent, and writing-mode rotation. Baseline is a fragment-relative paint fact. |
| Glyphs, clusters, advances, offsets | HarfBuzz `src/hb-shape.cc` | Shape each captured fragment through the selected face using the normal Domotion text route. |
| Device-space glyph paint | Skia `src/core/SkGlyph.cpp`, `SkFont.cpp`, and `SkCanvas.cpp` | Baseline snap/subpixel paint remains a downstream paint concern; it cannot repair a wrong Blink fragment origin. |

Relevant source observations at the pinned revisions are:

- `pseudo_element.cc` creates the pseudo layout object from computed display
  and then creates one layout child per `ContentData` item. A
  `display:contents` pseudo still receives an unobservable inline layout box.
- `content_data.cc` creates an anonymous `LayoutTextFragment` for generated
  text and an anonymous `LayoutImage` for generated images, both with the
  pseudo style.
- `logical_line_builder.cc` starts from a dominant baseline, places text at
  each inline box state's `text_top`, and performs bidi reordering before
  final fragment emission.
- `inline_box_state.cc` derives the strut from primary font metrics, unions
  used-font metrics when required, moves fragments for every
  `vertical-align` class, and accounts for logical margin/border/padding.
- `text_fragment_painter.cc` consumes the final `FragmentItem`, applies the
  writing transform, and sets the text origin from the physical fragment plus
  the selected font data's ascent.
- HarfBuzz executes the cached shape plan for the text run. Skia receives the
  shaped blob afterward and applies its own device-space positioning rules.

This ordering is the reason a clone-derived width plus a host-derived origin
is not an admissible substitute.

## Fresh Chromium evidence

A focused CDP probe ran on macOS with Playwright Chromium
`147.0.7727.15`. It queried `DOM.getDocument` with pseudo piercing,
`DOM.getBoxModel`, `DOM.getContentQuads`, and
`DOMSnapshot.captureSnapshot`. The temporary evidence image was inspected
locally and was not added to the repository.

| Case | Chromium observation | Heuristic falsified |
| --- | --- | --- |
| `::before`, Georgia 20/38, `vertical-align: super`, 2 px border, asymmetric padding/margin | Border quad `(41,25)–(182.203125,53)`; text row `(46,28,131.203125,22)` | Host top plus `(38-20)/2` does not yield the painted text fragment, and the fragment has independent box edges. |
| Wrapped `::after`, 13 px normal, `vertical-align: middle` | Text row `(78.6875,112.671875,88.921875,15)` with three text boxes | An aggregate width and bottom-gap threshold cannot preserve the three actual fragments or middle alignment. |
| RTL `::before` containing `LTR xyz אבג` | Visual boxes are `start=7,length=5,x=83.5625` followed by `start=0,length=7,x=116.515625` | Logical string order and host-edge insertion are not visual order. |
| `vertical-rl ::after` containing `縦書き pseudo tail` | Ordered quads occupy two columns: `(74,321.625)–(94,375.625)` and `(42,235.328125)–(62,322.40625)` | One horizontal `(x,y,width)` segment cannot represent vertical columns or their physical order. |
| Long multicolumn `::before` | Eight ordered fragments translate across physical x positions `36`, `153`, and `270`; snapshot text rows repeat fragmentainer-local x `36` | Snapshot text boxes alone are not physical coordinates. They must be joined with ordered content quads. |
| `content: "A " url(12×8) " B"` | One pseudo node has ordered rows for aggregate box, text A `(36,506.171875,14.234375,17)`, image `(50.234375,512.171875,12,8)`, and text B `(62.234375,506.171875,15.125,17)` | Generated content is not one string and one separate, independently anchored image. Text offsets restart per anonymous text child. |

CDP exposes pseudo nodes with `pseudoType` and the originating host relation.
Within the snapshot, `textBoxes.start` and `length` are UTF-16 offsets into
each anonymous text layout row, not offsets into one concatenated pseudo
string. A decoder must retain a `contentItemIndex`; otherwise repeated text or
the mixed-content offset reset is ambiguous.

`DOMSnapshot` alone is insufficient for fragmentation. In the multicolumn
case its text rectangles were fragmentainer-local, whereas
`DOM.getContentQuads` carried the physical column translations. The oracle
and capture decoder must join the ordered snapshot fragments to the ordered
quads and reject a cardinality or residual mismatch.

## Exact capture design

### Record

The record should make upstream identity explicit rather than overloading an
ordinary host text segment:

```ts
interface CapturedPseudoFragmentSet {
  hostCaptureId: string
  pseudo: 'before' | 'after'
  computedStyle: CapturedPseudoStyle
  contentItems: CapturedPseudoContentItem[]
  boxFragments: CapturedPseudoBoxFragment[]
  fragments: CapturedPseudoFragment[]
}

interface CapturedPseudoTextFragment {
  kind: 'text'
  contentItemIndex: number
  sourceStartUtf16: number
  sourceEndUtf16: number
  text: string
  visualOrder: number
  physicalQuad: [Point, Point, Point, Point]
  physicalRect: Rect
  baseline: CapturedFragmentBaseline
  inlineStart: number
  shapedAdvance: number
  writingMode: string
  direction: 'ltr' | 'rtl'
  font: CapturedFontAssignment
}

interface CapturedPseudoImageFragment {
  kind: 'image'
  contentItemIndex: number
  visualOrder: number
  resolvedUrl: string
  physicalQuad: [Point, Point, Point, Point]
  physicalRect: Rect
}
```

`CapturedPseudoBoxFragment` must additionally identify which logical
border/padding edges are painted on that fragment. This is needed for
`box-decoration-break`, wrapping, bidi splits, and fragmentation. Empty
decorative pseudo boxes remain valid box fragments even when they contain no
text row.

The baseline record must be line-relative and writing-mode aware. For a
horizontal text fragment, Blink's paint origin can be reconstructed from the
physical fragment top plus the selected primary font ascent. Vertical and
sideways modes require the same source-transcribed logical-to-physical
transform used by `TextFragmentPainter`; a universal `top + ascent` formula
would introduce a new heuristic.

### Capture sequence

1. Assign an internal, collision-resistant capture id to every eligible host
   before requesting protocol data. Keep it only for the duration of capture.
2. Ask CDP for the pierced document and map its `before`/`after` pseudo nodes
   back to that host id and pseudo type.
3. Take one `DOMSnapshot.captureSnapshot` for the frame so all line and text
   records share a layout epoch. Do not take one snapshot per pseudo.
4. Fetch ordered content quads for each pseudo and decode its anonymous child
   rows. Preserve generated content-item boundaries, including counter text
   and `url()` images.
5. Pair line-local snapshot rows with physical quads. Check count, ordering,
   dimensions, and edge residuals. Account for computed logical
   margin/border/padding and `box-decoration-break` edge ownership instead of
   unioning all text rects.
6. Derive the paint baseline with a source-transcribed writing-mode helper and
   the captured selected face metrics. Preserve the protocol fact and the
   metric inputs so the oracle can detect a wrong face or wrong transform.
7. Shape each text fragment using its selected face, UTF-16 source span,
   direction, script, language, variations, features, spacing, and visual
   order through the existing HarfBuzz-backed text pipeline. Validate shaped
   advance against the captured fragment advance; do not scale outlines to
   make a mismatch disappear.
8. Remove all internal host ids before serializing or returning the page to
   user code.

Capture must be frame-aware for same-origin iframes and must use each frame's
coordinate transform when normalizing quads. Shadow-tree/generated-node
protocol changes should be classified explicitly. A protocol-unavailable,
ambiguous, or nonrepresentable pseudo receives a scoped Chromium-painted
surface plus a structured warning naming the failed invariant. Legacy
captured documents can retain the old aggregate interpretation for backward
compatibility; new captures must not silently select it.

### Rendering sequence

The renderer should merge pseudo fragments with ordinary child paint in the
captured visual order. Text fragments use the ordinary selected-face and
HarfBuzz route, including color-glyph and platform terminal-raster boundaries.
Generated images use the existing image pipeline at their captured physical
quads. Box fragments use their captured logical-edge ownership. New-format
records bypass `injectPseudoSegments` entirely.

The renderer may preserve semantic grouping (`data-pseudo`, host id, and
content item) in a wrapper, but that wrapper must not recompute layout. It must
not concatenate content items, infer a wrap from vertical distance, clamp to a
host edge, or copy a host text baseline.

## Required oracle and controls

DM-2466 owns the decoder and a live-Chromium structural oracle. Every row must
compare independent Chromium protocol facts to the serialized record; it must
not derive expected values from the same Domotion helper. The matrix must
include:

- `::before` and `::after`, plus `content: none` and an empty decorative box;
- one, two, and at least three wrapped visual lines;
- host text first, element-child first, child only, and empty host;
- same font and mixed family/size/weight/style, including fallback glyphs;
- all `vertical-align` classes: baseline, middle, sub, super, text-top,
  text-bottom, top, bottom, length, and percentage;
- line-height smaller than, equal to, and larger than the used font height;
- asymmetric logical margin, border, and padding with
  `box-decoration-break: slice` and `clone`;
- inline, inline-block/atomic, flex/grid child, positioned, floated, and
  replaced/generated-image content;
- LTR, RTL, mixed bidi, isolates/overrides, neutral punctuation, and wrapping
  across a bidi boundary;
- horizontal-tb, vertical-rl, vertical-lr, and sideways writing;
- multicolumn and paged/fragmented content;
- text, counters, quotes, image-only, and text/image/text content sequences;
- transforms, relative offsets, zoom, DPR 1/2, fractional origins, scrolling,
  and same-origin iframe coordinates; and
- positive Chrome-protocol capture plus protocol-unavailable and deliberately
  ambiguous decoder fallbacks.

The mandatory mutations are designed to reject the current formulas:

1. Replace used font height with `font-size` in leading computation.
2. Replace every pseudo baseline with its first/last host text baseline.
3. Collapse all text boxes into their min/max union.
4. Sort fragments by UTF-16 source offset instead of captured visual order.
5. Omit fragmentainer-to-physical quad translation.
6. Concatenate content items so mixed-content offsets no longer restart.
7. Drop one logical border/padding edge or apply both edges to every fragment.
8. Apply horizontal `top + ascent` baseline reconstruction in vertical mode.
9. Convert UTF-16 offsets as codepoint indices, including an astral-text row.
10. Fall back silently to the legacy host anchor when protocol mapping fails.

Each mutation must fail at least one focused row. The control suite must also
show ordinary host text capture and `text-overflow` ellipses are unchanged.

DM-2468 owns the independent visual gate. It should compare Chromium and SVG
ink/box bounds at zoom 0.8/1/1.25/2 and DPR 1/2 on darwin, linux, and win32,
with a maximum four-device-pixel edge residual. It must use colored,
non-overlapping pseudo/host/image paint so a wrong owner cannot be hidden by a
whole-region similarity score. The gate needs the same super/border, wrapped
middle, RTL, vertical, multicolumn, and text/image/text adversarial rows above,
plus negative `content:none` and hidden/clipped controls.

## Follow-up tickets

- **DM-2466 — Build a Chromium pseudo-fragment geometry oracle and protocol
  decoder.** Establish the source-owned record and mutation-complete structural
  gate first.
- **DM-2467 — Capture source-owned before/after fragment and baseline
  records.** Blocked by DM-2466; add the protocol-backed capture path and
  fail-closed surface boundary.
- **DM-2468 — Render captured pseudo fragments and retire heuristic in-flow
  anchoring.** Blocked by DM-2467; consume the new record and add the
  all-platform independent visual gate.

DM-2382's generated-content cascade/counter work is related but separate: it
decides which content and style exist. These tickets decide where the resulting
layout fragments paint. Neither layer should infer the other's facts.

## Source references

- Chromium `third_party/blink/renderer/core/dom/pseudo_element.cc:344-438,
  525-683`, pseudo identity/style, layout attachment, and per-content-item
  generated-child creation.
- Chromium `third_party/blink/renderer/core/style/content_data.cc`, anonymous
  text/image layout object construction at lines 82-104.
- Chromium `third_party/blink/renderer/core/layout/layout_object.cc`,
  computed-display-to-layout-object selection.
- Chromium `third_party/blink/renderer/core/layout/inline/line_utils.cc:36-44`,
  actual font height and leading split.
- Chromium
  `third_party/blink/renderer/core/layout/inline/logical_line_builder.cc`, line
  baseline, fragment placement, and bidi reorder.
- Chromium
  `third_party/blink/renderer/core/layout/inline/inline_box_state.cc:109-163,
  843-1023, 1140-1437`, strut, used-font metrics, logical edges, relative
  positioning, and `vertical-align`.
- Chromium
  `third_party/blink/renderer/core/layout/inline/inline_layout_algorithm.cc`,
  line construction and final fragment positioning.
- Chromium
  `third_party/blink/renderer/core/paint/text_fragment_painter.cc:342-379,
  506-529` and `core/layout/inline/fragment_item.cc`, final physical fragment,
  writing transform, selected font, ascent, and text-paint inputs.
- HarfBuzz `src/hb-shape.cc:127-150`, cached shape-plan execution for each
  selected-face run.
- Chromium-pinned Skia `src/core/SkGlyph.cpp:696-734`,
  `src/core/SkFont.cpp:44,119-120`, and `src/core/SkCanvas.cpp:2580-2599`,
  downstream glyph positioning, baseline-snap state, and text-blob paint.
