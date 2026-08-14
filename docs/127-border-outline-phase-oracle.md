# Border and outline device-pixel phase oracle

DM-2184 adds `npm run borders:phase-oracle`, a focused paint oracle for the
localized residuals in `18-border-styles` and `18-outline`.

The oracle lays out 128 isolated primitives: border and outline, solid/dashed/
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

The checked-in baseline gate is 0.56 CSS px per edge and 0.48 alpha RMSE,
immediately above the initial measured maxima (0.551 and 0.471). A proposed
paint change should reduce those maxima, tighten the limits, and also run the
two fixture tests; widening either limit requires an explicit review. Useful
options:

```sh
npm run borders:phase-oracle -- --json /tmp/border-phase.json
npm run borders:phase-oracle -- --keep /tmp/border-phase-artifacts
```

`--keep` writes the native HTML PNG, emitted SVG, and img-rendered SVG PNG.
These are diagnostics only and are never renderer fallbacks. Rounded corners,
non-uniform sides, collapsed borders, writing modes, zoom, and other device
scale factors remain outside this deliberately narrow corpus.
