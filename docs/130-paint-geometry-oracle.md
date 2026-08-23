# 130 — Gradient, mask, clip, and resizer geometry oracle

`npm run paint:geometry-oracle` is the first decision-level gate for CSS paint
geometry that previously had only visual-regression coverage. It compares a
source-transcribed rule leg against the definitions emitted by Domotion's real
gradient, mask, basic-clip, and platform-resizer builders. It does not rasterize
either side.

The 110-row corpus is again fully exact after DM-2494. Its URL-mask `round`
and `space` rows now keep Blink's two rectangles distinct: tile size and phase
come from `mask-origin`, while the SVG pattern cell and final destination come
from `mask-clip`. Both rows include a destructive collapsed-area mutation and
retain the existing `0.00011` logical tolerance unchanged.

`npm run paint:geometry-browser-oracle` is the independent live-browser leg.
At 4× device scale it paints deliberately binary discriminators for the
non-square magic-corner decision, an HTML content-box clip, mask-repeat
phase, a conic hard-quadrant sweep, and SVG fill/stroke/view reference boxes.
It also proves Blink's exclusive URL-clip grammar, the HTML border-box URL
origin (including a transparent `objectBoundingBox` host whose offset child
would give native SVG the wrong bbox), and the SVG-child forced fill-box URL
boundary.
The conic probe samples away from
antialiased boundaries and distinguishes center, start-angle, and sweep order.
Other sample points are chosen where the retired direct-corner gradient rule
predicts the opposite color, or immediately across a source-predicted box/tile
boundary. The report records the Chromium source revision, installed Chromium
and Playwright versions, platform, architecture, and device scale so a browser
upgrade is visible as evidence drift rather than silently accepted.

## Current exact surface

The generated corpus covers all four linear-gradient corner directions over
landscape, portrait, and irregular non-square boxes; circle and ellipse radial
ending shapes for closest/farthest side/corner behavior; positive, negative,
and out-of-range radial domains for repeating and non-repeating gradients;
monotonic stop fixup, unspecified-stop distribution,
double-position stops, and Blink's nine-stop color-hint expansion; basic
`inset()`, `circle()`, `ellipse()`, and `polygon()` clip shapes; HTML border,
padding, content/fill, margin, and half-border reference boxes; rounded
padding/content insets and margin-corner correction; rounded overflow-clip-margin
coverage correction, all three reference boxes, ref-box-only zero values,
negative content-box outsets, exact axis/scroll/contain/replaced activation, and
a margin mutation control; exclusive bare-URL clip syntax with every URL-plus-
box ordering as a negative, HTML URL border-box/user-space and explicit
object-bounding-box maps, and SVG URL forced-fill ownership; SVG content/padding/fill
mapping to the object bounding box, border/margin/stroke mapping to the stroke
bounding box, and view-box mapping to the local SVG viewport; mask size, position,
per-axis repeat, `round`/`space` adjustment for generated and URL images, and
cyclic layer lists, including distinct origin-positioning and clip-painting
rectangles for URL `round`/`space` with an orthogonal no-repeat axis; bottom-up
mixed-layer composition using each upper layer's
Porter-Duff operator; all four mask-composite operators; fragment mask and
clip-path user-space positioning; explicit gradient interpolation-space routing;
conic center/from-angle/stop-domain and repeating-negative-domain decisions;
physical tile sizing under CSS effective zoom; the Chromium-raster ownership
boundary; and a linear-gradient alpha mask. Gradient coordinates
compare at the emitter's four-decimal serialization boundary. Basic clip
coordinates compare after the renderer's documented one-decimal SVG
serialization.

The resizer rows transcribe `LayoutBox::CanResize`,
`PaintLayerScrollableArea::CornerRect`, and
`ScrollableAreaPainter::DrawPlatformResizerImage` from Chromium revision
`7d859f27`. They cover the `visible`/`clip` negative overflow values,
`auto`/`hidden` positive axes, replaced-layout exclusion, iframe exception,
no/one/both-scrollbar thickness selection, horizontal-RTL logical-left
placement, asymmetric borders, fractional border-box snapping, and both dark
and light platform paths. The focused browser suite independently checks the
active platform's measured theme thickness, authored custom-pseudo dimension
override, custom paint ownership, scrollbar/no-scrollbar frame branch,
textarea/div/iframe cases, CSS zoom, and DPR 1/2 pixel geometry.
Custom resizer paint reuses the renderer's Blink-derived normal/inset box-shadow
stages over the captured fixed CornerRect: shadow lengths scale once by effective
zoom, first-listed layers remain topmost, and the complete pseudo paint is clipped
to that corner. Platform resizers and ordinary pseudo boxes do not enter this arm.

The overflow-clip-margin rows transcribe
`AdjustRoundedClipForOverflowClipMargin`,
`LayoutObject::ShouldApplyOverflowClipMargin`, and the stable coverage-factor
branch of `FloatRoundedRect::OutsetWithCornerCorrection` from Chromium revision
`7d859f27`. The direct renderer suite additionally asserts the emitted child
clip path, while the browser-bound suite verifies Chromium's negative-length
rejection, ref-box-only computed serialization, effective-zoom scaling at DPR
1 and 2, and the replaced-element/non-scroll-container activation split.

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

Radial stop domains transcribe `ClampNegativeOffsets`,
`NormalizeAndAddStops`, and `AdjustGradientRadiiForOffsetRange` from
`css_gradient_value.cc:490-633,809-824`. A repeating interval whose inner
radius is negative is shifted forward by an integral number of its own periods,
preserving phase while making both SVG radii non-negative. A non-repeating
interval interpolates its zero-radius boundary color, normalizes the stops, and
moves the outer radius to the last stop. Boundary interpolation follows the
declared sRGB or linear-light space rather than mixing serialized channels
unconditionally. The structured gate includes the former SVG-side clamp as a
mutation control, and the live-browser leg samples
black/white/black rings that only the shifted domain predicts. The composed
feature fixture covers wholly negative, zero-straddling, and non-repeating
domains and is pixel-clean.

Color-hint rows transcribe `ReplaceColorHintsWithColorStops`
(`css_gradient_value.cc:266-399`) rather than treating SVG's limitation as
permission to choose a different approximation. Chromium also emits nine
piecewise-linear stops; matching their positions and weights is exact renderer
logic for legacy sRGB colors.

Opaque `srgb` and `srgb-linear` gradients remain vector-native: their SVG
definitions carry `color-interpolation="sRGB"` or `linearRGB`. SVG cannot encode
Lab/OKLab/LCH/OKLCH/HSL/HWB interpolation, polar hue routes, or Blink's
premultiplied-alpha CSS-gradient math. Those layers are therefore rendered once
in an isolated transparent page in the capture's own Chromium context and
embedded as a tiled PNG. This is an explicit representation boundary, not a
sampled-stop approximation; a helper-absent/direct-tree render warns loudly and
falls back to best-effort SVG interpolation rather than making the application
fail or dropping the layer.

Conic gradients always cross that Chromium raster boundary because SVG has no
native conic paint server. Structured rows cover the logical inputs and cache
ownership; a live hard-quadrant discriminator validates the pinned Blink sweep
against the installed browser. A zoomed advanced-color fixture proves that px
tile terms cross from CSSOM to physical geometry once while percentage terms
remain box-relative.

SVG effect boxes transcribe `SVGResources::ReferenceBoxForEffects` and
`ClipPathClipper::CalcLocalReferenceBox`. SVG child `content-box`,
`padding-box`, and `fill-box` select `ObjectBoundingBox()`;
`border-box`, `margin-box`, and `stroke-box` select `StrokeBoundingBox()`;
`view-box` selects the resolved local SVG viewport at origin zero. URL clip
references deliberately force the fill box. On HTML, a URL is an exclusive
`ReferenceClipPathOperation`: URL-plus-geometry-box declarations are invalid,
bare user-space clips start at the border box, and normalized
`objectBoundingBox` content is explicitly mapped through that border rect. The
explicit map matters when a transparent host's only painted child is offset;
using the generated SVG group's natural bbox changes the clip. Domotion does not recreate stroke
joins, markers, or nested viewport bounds: it bakes stylesheet-owned clip/mask
declarations onto the cloned SVG child so the output browser executes the same
native SVG logic. Serialized computed-style URL references on cloned SVG are
namespaced even when their quotes are encoded as `&quot;`, preventing a stale
style declaration from overriding the rewritten presentation attribute. The
activation controls prove the former HTML/SVG reference substitutions are
observably different, while live and strict visual fixtures exercise the URL
grammar, HTML/SVG ownership, nested-frame/external routes, and all three basic-
shape box classes.

DM-2358 adds the generated native-SVG integration leg documented in
[doc 188](188-generated-svg-effect-combinations.md). Twenty-four deterministic
cases cover every one of the 953 pairs among 18 shape, gradient, clip, mask,
viewport, marker, stroke, transform, and interpolation axes. The final SVG is
pixel-identical to the source in the local DPR-1/2 run, while destructive
marker, non-scaling-stroke, and interpolation controls prove the newly
preserved computed-style transitions are active. The matrix delegates all
resource geometry to native SVG; it does not infer new bounds from pixels.

## Boundaries and next expansion

This gate does not claim exhaustive paint parity. The covered geometry-box
classes now have structured, mutation-control, live-browser, capture-contract,
and strict visual evidence, including complete pairwise coverage of the 18
enumerated SVG-effect axes. Higher-order combinations and future effect classes
remain explicit. New SVG effects should extend this matrix rather than infer
object or stroke bounds from screenshot pixels.

The live-browser leg validates that the pinned source transcription still
describes the currently installed Chromium; it does not replace the structured
Domotion comparison. The broader pixel suites remain the final integration
stage. A pixel residual cannot override a failure here, and a passing row here
does not classify a later Skia-versus-SVG rasterization difference.
