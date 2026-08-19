# 132 — Compositing and paint-order transition oracle

`npm run paint:order-oracle` gates the classification and containment decisions
behind Domotion's stacking-context renderer. It combines generated structural
rows with a live-Chromium hit-test stack, so the verdict is about paint order
rather than screenshot similarity.

The 27-row corpus covers every stacking-context creator currently modeled:
positioned z-index, fixed/sticky positioning, opacity, live and capture-baked
transforms, preserve-3d, filter, blend mode, mask, clip path, isolation,
containment, overflow, will-change, and flex-item z-index. Negative, base,
float, positioned auto/zero, and positive Appendix-E buckets are checked
independently. Nested z-index escape is generated both through a non-context
wrapper and across opacity, filter, isolation, and mask atomic boundaries.

The independent browser leg uses `elementsFromPoint()` as Chromium's ordered
paint-stack observation: a deep z-index escapes a plain wrapper, but cannot
escape isolation or opacity contexts. A mutation control removes the opacity
transition and requires the classifier verdict to move.

Pixel suites remain responsible for raster integration, blend arithmetic, and
filter kernels. This oracle prevents those pixels from being “fixed” by
changing a logically correct paint order.
