# 130 — Gradient, mask, and clip geometry oracle

`npm run paint:geometry-oracle` is the first decision-level gate for CSS paint
geometry that previously had only visual-regression coverage. It compares a
source-transcribed rule leg against the definitions emitted by Domotion's real
gradient, mask, and basic-clip builders. It does not rasterize either side.

`npm run paint:geometry-browser-oracle` is the independent live-browser leg.
At 4× device scale it paints deliberately binary discriminators for the
non-square magic-corner decision, an HTML content-box clip, and mask-repeat
phase. Sample points are chosen where the retired direct-corner gradient rule
predicts the opposite color, or immediately across a source-predicted box/tile
boundary. The report records the Chromium source revision, installed Chromium
and Playwright versions, platform, architecture, and device scale so a browser
upgrade is visible as evidence drift rather than silently accepted.

## Current exact surface

The generated corpus covers all four linear-gradient corner directions over
landscape, portrait, and irregular non-square boxes; circle and ellipse radial
ending shapes for closest/farthest side/corner behavior; a positive-domain
repeating radial period; monotonic stop fixup, unspecified-stop distribution,
double-position stops, and Blink's nine-stop color-hint expansion; basic
`inset()`, `circle()`, `ellipse()`, and `polygon()` clip shapes; HTML border,
padding, content/fill, margin, and half-border reference boxes; rounded
padding/content insets and margin-corner correction; mask size, position, and
gradient tiling; all four mask-composite operators; fragment mask and clip-path
user-space positioning; and a linear-gradient alpha mask. Gradient coordinates
compare at the emitter's four-decimal serialization boundary. Basic clip
coordinates compare after the renderer's documented one-decimal SVG
serialization.

The linear corner rule is transcribed from Chromium revision `7d859f27`,
`core/css/css_gradient_value.cc:1282-1337,1410-1430`. For `to top right`, Blink
computes the bearing as `90° − atan2(width,height)`, then projects the line
through the box center so its perpendicular 50% line reaches the two “magic
corners.” It does not point the gradient vector directly at the requested
corner. On a 300×100 box, the correct line is `(120,140)→(180,-40)`; the former
direct-corner approximation emitted `(0,100)→(300,0)`.

The gate includes a mutation control: that retired direct-corner construction
must differ by more than one CSS pixel on the 300×100 discriminator. If it does
not move, the corpus has stopped proving the branch it claims to test.

Color-hint rows transcribe `ReplaceColorHintsWithColorStops`
(`css_gradient_value.cc:266-399`) rather than treating SVG's limitation as
permission to choose a different approximation. Chromium also emits nine
piecewise-linear stops; matching their positions and weights is exact renderer
logic for legacy sRGB colors.

## Boundaries and next expansion

This gate does not yet claim exhaustive paint parity. Exact oracle rows still
need to be added for non-default gradient interpolation color spaces and
premultiplied-alpha color math, negative/out-of-range radial stop domains,
`round`/`space` mask tiling and mixed per-layer composite lists, SVG-specific
geometry boxes, and conic raster tiles. Those domains remain covered by unit
and visual fixtures but do not gain an exact logical verdict from this oracle
until their structured rows land.

The live-browser leg validates that the pinned source transcription still
describes the currently installed Chromium; it does not replace the structured
Domotion comparison. The broader pixel suites remain the final integration
stage. A pixel residual cannot override a failure here, and a passing row here
does not classify a later Skia-versus-SVG rasterization difference.
