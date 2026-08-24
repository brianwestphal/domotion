# Fragmented collapsed-table physical ownership

**Tickets:** DM-2526, DM-2557
**Status:** Screen physical section-fragment record authenticated for non-repeated sections; repeated occurrences and paged media remain bounded follow-ups
**Source pin:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`

## Verdict

DM-2557 closes the earliest screen gap before vector paint. Capture now builds
a versioned private record from the same physical table, section, row, cell,
and caption nodes observed independently through ordered
`Element.getClientRects()` and CDP `DOM.getContentQuads`. Every CSS transform on
the candidate subtree and ancestor chain is neutralized for one settled layout
epoch; both channels must agree exactly after Blink LayoutUnit 1/64 CSS-pixel
canonicalization. The original style attributes and live protocol quads must
then restore exactly before the record is promoted.

The authenticated record retains physical table-fragment identity, section
source/table-child/paint slots, consecutive global row identity, exact logical
row and column offsets, content-before/after and continued-row state, caption
paint slots, writing direction, source revision, and collection provenance.
`borders-backgrounds.ts` validates and consumes that record once before
collapsed-border vector paint. Wrong-row, wrong-fragment, wrong-axis,
CSSOM/CDP-drift, incomplete-column, and restore mutations fail closed; the old
overlap/median/coordinate-translation reconstruction is not a fallback.

Chromium's repeated header/footer CSSOM rectangles alias each occurrence to the
prototype, so they cannot authenticate occurrence ownership. Those tables now
withhold collapsed-border vectors and emit a structured warning until DM-2558
adds explicit occurrences. This is an intentional fidelity improvement over
synthetic placement, not a visual regression accepted by tolerance.

Paged media is a separate proven gap. In the headless logical print control,
`Page.printToPDF` produced seven page objects while ordinary screen CSSOM
exposed one table rectangle and one header rectangle. A screen
`getClientRects()` capture cannot infer the print fragment tree.

No production renderer, pixel threshold, phase envelope, or tolerance changed.
The logical oracle reads no screenshot pixels; its print leg reads only PDF
page structure.

## Pinned Blink decision trace

| Decision | Pinned source | Required consequence |
| --- | --- | --- |
| Collapsed conflict graph | `core/layout/table/table_borders.cc:23-260` | Blink builds one global edge graph. Cells merge first, followed by row, section, column, column-group, and table contributions. Row/column spans leave their interior edges unfilled. |
| Section fragment rows | `core/layout/table/table_section_layout_algorithm.cc:47-164` | Each physical section fragment stores `actual_start_row_index` and exact fragment-local `row_offsets`, beginning from the incoming row break token. |
| Repetition eligibility and placement | `core/layout/table/table_layout_algorithm.cc:1002-1151,1271-1339,1452-1528,1701-1719` | Header/footer repetition requires a known fragmentainer block size, a section no larger than one quarter of it, applicable `break-inside: avoid`, no break inside the candidate, no late-start or nested-repeat ownership, and enabled layout side effects. Repeated headers reserve the block-start collapsed border; footers reserve end space and participate in last-table-box relayout. |
| Collapsed-border paint | `core/paint/table_painters.cc:35-328,490-727` | Paint iterates physical table fragments and child section fragments, consumes the section's global start row and row offsets, distinguishes whole-row from continued-row breaks, paints half an inline edge at whole-row fragmentainer boundaries, omits that edge at continued-row seams, carries block edges through continuation without joint adjustment, and suppresses the shared row of adjacent sections with `previous_painted_row_index`. Physical writing conversion precedes pixel snapping. |
| Repeated-section traversal | `core/paint/pre_paint_tree_walk.cc:1290-1312` | Repeated headers and footers receive physical fragment traversal; they are occurrences in the paint tree, not coordinate aliases to be expanded blindly. |
| CSSOM rectangles | `core/dom/element.cc:3419-3485`; `core/layout/layout_box.cc:1199-1216` | `getClientRects()` returns bounding boxes derived from `AbsoluteQuads()` over physical fragments. It does not serialize global table row identity, section paint slots, row break tokens, or repeat ownership. |

The source fixtures are the pinned Blink WPT horizontal-tb/LTR,
vertical-lr/RTL, and vertical-rl/LTR collapsed-border fragmentation cases under
`third_party/blink/web_tests/external/wpt/css/css-break/table/`. Their reference
pages explicitly omit the continuation edge on the physical top, left, or
right side appropriate to the writing mode. The corpus preserves their four
fragmentainers, 120 px caption, two `tbody` sections, and a 145 px continued
row.

## Current Domotion boundary

- `src/capture/collapsed-border-fragment-cdp.ts` owns the private live-node
  registry, animation freeze, transform-neutral same-epoch CSSOM/CDP
  collection, exact restoration check, and fail-closed warning.
- `src/capture/collapsed-border-fragment-record.ts` owns LayoutUnit
  canonicalization, ordered channel authentication, record construction, and
  hostile-record validation. It contains no pixel comparison or fitted
  tolerance.
- `src/capture/script/walker/borders-backgrounds.ts` accepts only an
  authenticated record matching the live table's rows, columns, fragments,
  writing mode, and direction. It passes exact section slices to the existing
  logical edge/joint algorithm, emits physical rects tagged by fragment index,
  and serializes the consumed provenance on the table.
- Missing, ambiguous, stale, or aliased records serialize an unavailable
  reason, suppress cell/structural collapsed borders, and return an empty table
  vector list. There is no CSSOM heuristic fallback.

The remaining screen boundary is repeated section occurrence ownership
(DM-2558). The independent print fragment transport remains DM-2559, followed
by DM-2560's all-platform logical and final-ink release legs.

## Headless logical corpus

`tools/collapsed-border-fragmentation-oracle.ts` launches Chromium with
`headless: true`, captures no pixels, and emits schema-2 fingerprinted JSON.
The DM-2557 run passed all fifteen source-logical discriminators and all eleven
destructive controls with verdict
`screen-section-fragment-record-authenticated`:

| Family | Observed logical facts |
| --- | --- |
| Whole-row multicol breaks | Three table fragments and four source-required 2 px half-edge witnesses from 4 px borders; no duplicate captured rectangle. |
| Pinned horizontal WPT shape | Four table fragments, two caption fragments, four section fragments, and three continued-row pieces. All four continuation seams omit a black row-axis edge; the adjacent-section boundary has exactly one shared edge. |
| Pinned vertical-lr/RTL shape | Four table fragments and three continued-row pieces. Every row-axis border is physically x-thin, and all four physical-x continuation seams omit the edge. |
| Pinned vertical-rl/LTR shape | The same physical-x ownership holds with the reversed block direction; all four continuation seams omit the edge. |
| Repeated header and footer | CSSOM aliases each occurrence to one prototype coordinate; the record is unavailable and vector paint is withheld rather than synthesized. |
| Oversized repeat negative | The non-repeated header remains independently authenticated, matching Blink's one-quarter fragmentainer limit. |
| Continued spans and fractional tracks | `colspan` interiors stay empty; fractional column offsets, `rowspan`, multiple `tbody` sources, and consecutive global row identity remain exact. |
| Captions and provenance | Caption/table-child paint slots, physical fragment ids, section ids, rows, continuations, writing state, neutral CSSOM/CDP binding, source revision, and exact restoration are present. |
| Screen versus print | Screen CSSOM reports one table and one header rectangle; the print PDF contains seven page objects. `pixelsRead` is permanently `false`. |

The controls collapse fragments, erase continuation, promote half edges,
double-paint a section edge, accept an aliased repeat, fill a span interior,
horizontalize vertical writing, substitute the wrong global row/physical
fragment/writing axis, and treat screen CSSOM as print fragments. Every
mutation moves its asserted logical result.

Run it with:

```sh
npm run borders:collapsed-fragmentation-audit -- --json /tmp/collapsed-border-fragmentation.json
npx vitest run tests/collapsed-border-fragmentation-oracle.test.ts
```

Focused production coverage is explicit-headless:
`src/capture/collapsed-border-fragment-cdp.e2e.test.ts` proves authenticated
consumption and exact source restoration through a transformed ancestor, then
proves aliased repeats fail closed. `tests/border-collapse-conflict.e2e.test.ts`
keeps horizontal/vertical, whole/continued-row, span/joint, empty-fragment, and
repeat-withholding behavior live.

## Bounded follow-up sequence

1. **DM-2557 — completed.** The versioned source-pinned screen record is
   authenticated and consumed before vector paint; ambiguity fails closed.
2. **DM-2558 — Replace repeated table header/footer alias heuristic with
   explicit occurrence ownership.** This is blocked by DM-2557 and must consume
   its physical section-fragment record rather than add a second model.
3. **DM-2559 — Define exact paged-media collapsed-table capture ownership.**
   This is independent of the screen multicol implementation. It must collect
   authenticated print fragments or reject the route explicitly; PDF/vector or
   native raster evidence remains downstream.
4. **DM-2560 — Gate fragmented collapsed-border records and final ink
   independently on all platforms.** This is blocked by DM-2557, DM-2558, and
   DM-2559. The logical Cartesian corpus must pass on macOS, Linux, and Windows
   before a separate native final-ink leg can support release.

The dependency order prevents a release gate from blessing today's
CSSOM-only reconstruction and keeps screen fragmentation, repeated-section
ownership, print ownership, and terminal raster evidence independently
falsifiable.
