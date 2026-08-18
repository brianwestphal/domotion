# 130 — Gradient, mask, and clip geometry oracle

`npm run paint:geometry-oracle` is the first decision-level gate for CSS paint
geometry that previously had only visual-regression coverage. It compares a
source-transcribed rule leg against the definitions emitted by Domotion's real
gradient, mask, and basic-clip builders. It does not rasterize either side.

## Current exact surface

The generated corpus covers all four linear-gradient corner directions over
landscape, portrait, and irregular non-square boxes; basic `inset()`,
`circle()`, `ellipse()`, and `polygon()` clip shapes; and a linear-gradient
alpha mask. Gradient coordinates compare at the emitter's four-decimal
serialization boundary. Basic clip coordinates compare after the renderer's
documented one-decimal SVG serialization.

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

## Boundaries and next expansion

This first gate does not yet claim exhaustive paint parity. Exact oracle rows
still need to be added for radial ending shapes and repeating periods, stop
fixup/interpolation, geometry-box reference selection, rounded inset paths,
mask sizing/position/repeat/composite, URL/fragment masks, and conic raster
tiles. Those domains remain covered by unit and visual fixtures but do not gain
an exact logical verdict from this oracle until their structured rows land.

The pixel suites remain the final integration stage. A pixel residual cannot
override a failure here, and a passing row here does not classify a later
Skia-versus-SVG rasterization difference.
