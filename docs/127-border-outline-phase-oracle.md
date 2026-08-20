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
value at device scale factor 4. It derives coverage-weighted outer/inner edges
and centerlines, reports profile RMSE, and fits three shared models to the HTML
measurements: no snap, CSS outer-edge rounding, and device-center rounding.
The best model is evidence for a shared renderer rule, not permission to
special-case a fixture or primitive.

The calibrated default gate (`DSF=4`, `zoom=1`) is 0.56 CSS px per edge and 0.48 alpha RMSE,
immediately above the initial measured maxima (0.551 and 0.471). A proposed
paint change should reduce those maxima, tighten the limits, and also run the
two fixture tests; widening either limit requires an explicit review. Useful
options:

```sh
npm run borders:phase-oracle -- --json /tmp/border-phase.json
npm run borders:phase-oracle -- --keep /tmp/border-phase-artifacts
npm run borders:phase-oracle -- --dsf 1,2,4 --zoom 0.8,1,1.25 --report-only --json /tmp/border-phase-matrix.json
```

`--keep` writes a scenario directory containing the native HTML PNG, emitted
SVG, and img-rendered SVG PNG. These are diagnostics only and are never renderer
fallbacks. Each scenario reports snap-model fits under `geometry` separately
from HTML-versus-SVG alpha differences under `paintResiduals`; a paint-profile
threshold therefore cannot disguise a changed logical snap decision.

`.github/workflows/border-phase-oracle.yml` runs the 3 × 3 DSF/zoom matrix on
macOS, Linux, and Windows and uploads the JSON plus visual evidence. The report
fingerprints OS, architecture, Node, and Chromium. Expanded scenarios use
`--report-only` until reviewed native artifacts establish platform-specific
envelopes; the calibrated default remains blocking. This is intentional:
copying the macOS DSF=4 thresholds onto other rasterizers would turn expected
paint-profile variation into false logical failures.

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
