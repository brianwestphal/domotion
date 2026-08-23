# Border and outline device-pixel phase oracle

DM-2184 adds `npm run borders:phase-oracle`, a focused paint oracle for the
localized residuals in `18-border-styles` and `18-outline`.

The oracle lays out 128 isolated primitives in a compact four-column grid:
border and outline, solid/dashed/
dotted/double, widths 1/2/3/5px, and quarter-CSS-pixel x/y phases. Chromium
first paints the HTML. Domotion then captures the same document, emits SVG,
and Chromium paints that SVG through an `<img>`. This exercises the delivered
image path; parsing emitted coordinates cannot reveal SVG rasterizer phase.

For the middle of each top edge, the tool records every device-pixel alpha
value at the requested device scale factor. It derives coverage-weighted outer/inner edges
and centerlines, reports profile RMSE, and fits three shared models to the HTML
measurements: no snap, CSS outer-edge rounding, and device-center rounding.
The best model is evidence for a shared renderer rule, not permission to
special-case a fixture or primitive.

The producer's broad 0.56 CSS-px / 0.48 alpha-RMSE limits remain diagnostic
compatibility defaults. DM-2355 reviewed the complete native matrix and moved
the source-exact subset to the much narrower, scenario-specific envelopes in
doc 191. Widening one of those ratified ceilings requires new pinned-source and
native-artifact review. Useful options:

```sh
npm run borders:phase-oracle -- --json /tmp/border-phase.json
npm run borders:phase-oracle -- --keep /tmp/border-phase-artifacts
npm run borders:phase-oracle -- --dsf 1,2,4 --zoom 0.8,1,1.25 --report-only --json /tmp/border-phase-matrix.json
npm run borders:phase-ratify -- --report /tmp/border-phase-matrix.json --run-env /tmp/run-env.json --artifact-dir /tmp/border-phase-artifacts
```

`--keep` writes a scenario directory containing the native HTML PNG, emitted
SVG, and img-rendered SVG PNG. These are diagnostics only and are never renderer
fallbacks. Each scenario reports snap-model fits under `geometry` separately
from HTML-versus-SVG alpha differences under `paintResiduals`; a paint-profile
threshold therefore cannot disguise a changed logical snap decision.

`.github/workflows/border-phase-oracle.yml` runs the 3 × 3 DSF/zoom matrix on
macOS, Linux, and Windows and uploads the JSON plus visual evidence. The report
fingerprints OS, architecture, Node, Chromium, the corpus/source pins, and each
artifact. The separate strict adjudicator applies the reviewed envelope to all
128 rows per scenario. The uniform `border.double` branch now rounds one outer
reference rectangle before deriving both stripe boxes; an unsnapped-reference
mutation is rejected across every width and quarter-pixel phase. This logical
fix moved the local double rows to exact zero without widening a paint
threshold.

The first expanded run found and closed a shared effective-zoom boundary
(DM-2323). Blink stores border widths and outline width/offset in zoomed integer
paint units, but CSSOM serializes those values divided by `EffectiveZoom`.
Domotion already captured physical DOMRects, so consuming the CSSOM lengths
unchanged mixed coordinate spaces. Capture now reconstructs the paint lengths
once from the memoized ancestor effective zoom. On the local DSF 1/2 × zoom
0.8/1.25 discriminator this changed 309 threshold failures to 9 and made the
inferred HTML/SVG snap rule agree in all four scenarios. Later outline snap
work closed the logical dotted-outline discrepancy. DM-2355's repeated native
review found the remaining DSF=1 dotted-outline coverage profile byte-stable
across runners. The later uniform-double snap correction left those maxima and
their ceilings unchanged; doc 191 records the exact geometry, ceilings, and
evidence fingerprints.

Collapsed table borders have a separate exact logical gate. The capture-side
model mirrors Chromium's `TableBorders`: one logical edge grid, source merges
in cell/row/section/column/column-group/table order, span-interior
`kDoNotFill`, and exact-tie retention. It then mirrors
`TablePainter::ComputeEdgeJoints`, converts through horizontal or vertical table
writing direction (including RTL inline flow), and applies
`ToPixelSnappedRect` semantics before recording table-owned physical edge
rectangles. Unit tests grade each decision stage, the browser test checks the
captured table contract, and `border-collapse-edge-graph` is the visual
integration discriminator. Table fragmentation remains tracked separately;
collapsed-table rows can be added to this scale/platform report once that
fragment model exists.
