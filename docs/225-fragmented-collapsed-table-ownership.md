# Fragmented collapsed-table border ownership investigation

**Ticket:** DM-2526
**Status:** Investigation complete; production ownership remains intentionally open
**Source pin:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`

## Verdict

The sampled screen-multicol cases currently produce the source-expected border
shapes, but the capture protocol cannot authenticate how those shapes were
owned by Blink. The earliest gap is before vector paint: Blink paints from
physical table-section fragments carrying global row indices, exact
fragment-local row offsets, break-token continuation state, and explicit
repeated-section occurrences. Domotion reconstructs those facts from CSSOM
rectangles and serializes only final border rectangles.

That distinction is material. A final rectangle record can look correct while
being correlated to the wrong physical table fragment, the wrong global row,
or a synthetic header/footer occurrence. It cannot expose a stale break-token
decision or prove Blink's adjacent-section paint deduplication. Therefore this
investigation records `currentProtocolExact: false`; it does not promote the
existing fragmented route on the strength of sampled visual agreement.

Paged media is a separate proven gap. In the headless logical print control,
`Page.printToPDF` produced seven page objects while ordinary screen CSSOM
exposed one table rectangle and one header rectangle. A screen
`getClientRects()` capture cannot infer the print fragment tree.

No production renderer, pixel threshold, phase envelope, or tolerance changed.
The investigation read no screenshot or PDF pixels.

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

`src/capture/script/walker/borders-backgrounds.ts` reconstructs the fragmented
paint input from public rectangles:

1. Table, row, cell, and section rectangles are assigned to the table fragment
   with the greatest overlap.
2. Row rectangle order is treated as continued-row state.
3. A header/footer is considered repeated when its rectangle count equals the
   table fragment count while all rectangles map back to one physical table
   fragment.
4. That source rectangle is synthetically translated to every table fragment.
5. The resulting logical borders are immediately flattened to
   `collapsedBorderRects` containing only `x`, `y`, `width`, `height`, `axis`,
   `style`, and `color`.

The flattened record has no versioned provenance, table-fragment identity,
section identity or paint slot, global row, exact section row offsets,
start/end break-token state, or repeated-section role/occurrence. The source
code proves those fields are upstream paint inputs, not optional diagnostics.
The rectangle-alias rule also cannot authenticate Blink's repetition
eligibility or distinguish an omitted, duplicated, stale, or reordered
occurrence.

## Headless logical corpus

`tools/collapsed-border-fragmentation-oracle.ts` launches Chromium with
`headless: true`, captures no pixels, and emits a fingerprinted JSON report.
The final macOS investigation run used Chrome `147.0.7727.15`, Playwright
`1.59.1`, Node `v22.23.2`, and passed all eleven source-logical
discriminators:

| Family | Observed logical facts |
| --- | --- |
| Whole-row multicol breaks | Three table fragments and four source-required 2 px half-edge witnesses from 4 px borders; no duplicate captured rectangle. |
| Pinned horizontal WPT shape | Four table fragments, two caption fragments, four section fragments, and three continued-row pieces. All four continuation seams omit a black row-axis edge; the adjacent-section boundary has exactly one shared edge. |
| Pinned vertical-lr/RTL shape | Four table fragments and three continued-row pieces. Every row-axis border is physically x-thin, and all four physical-x continuation seams omit the edge. |
| Pinned vertical-rl/LTR shape | The same physical-x ownership holds with the reversed block direction; all four continuation seams omit the edge. |
| Repeated header and footer | Six table fragments. CSSOM reports six coordinate-alias rectangles but one unique rectangle for each section; capture currently synthesizes one red header and one green footer edge into each of the six physical table fragments. |
| Oversized repeat negative | Four table fragments but only one header rectangle and one captured header edge, matching Blink's one-quarter fragmentainer limit. |
| Continued `colspan` | Three table fragments and three span pieces, with zero captured edges through the two-column span interior. |
| Screen versus print | Screen CSSOM reports one table and one header rectangle; the print PDF contains seven page objects. `pixelsRead` is permanently `false`. |
| Protocol provenance | Every sampled final border rectangle lacks physical fragment, section, global row, break-token, and repeat-occurrence identity. |

The corpus activates nine destructive controls: collapsing four table fragments
to one, erasing the three-piece continuation, removing four half-edge
witnesses, duplicating the shared-section edge, dropping one repeated header,
dropping one repeated footer, filling the span interior, horizontalizing both
vertical cases, and replacing seven print pages with the one screen rectangle.
Every mutation moves its asserted logical result.

Run it with:

```sh
npm run borders:collapsed-fragmentation-audit -- --json /tmp/collapsed-border-fragmentation.json
npx vitest run tests/collapsed-border-fragmentation-oracle.test.ts
```

The existing non-investigation browser baseline remains independently green:
`tests/border-collapse-conflict.e2e.test.ts` passes all ten cases headlessly.
That protects current behavior but does not add missing source provenance.

## Bounded follow-up sequence

1. **DM-2557 — Authenticate collapsed-border physical section fragments before
   vector paint.** Introduce the versioned, source-pinned screen record and
   fail closed when the private-equivalent Blink inputs cannot be correlated.
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
