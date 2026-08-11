# 114 — Angled linear wipe

**Status: shipped (DM-2041).** The linear `wipe` transition accepts an optional
`wipeAngle` number, measured in degrees clockwise from the existing left-to-right
direction. `0` is left-to-right, `90` is top-to-bottom, `180` is right-to-left,
and negative or multi-turn values are equivalent modulo 360.

The field is authored on the outgoing frame's transition because that transition
drives the successor's entrance:

```jsonc
{ "type": "wipe", "duration": 700, "wipeAngle": 35 }
```

Omitting `wipeAngle` (or using any multiple of 360) preserves the original
`inset(0 100% 0 0)` animation byte-for-byte. Other angles reveal the incoming
frame with a moving half-plane clipped to the viewport rectangle. The generator
clips the rectangle analytically at sixteen progress samples, resamples each
resulting polygon perimeter to eight vertices, and emits fixed-vertex
`clip-path: polygon()` keyframes. Fixed arity is required for smooth CSS shape
interpolation; it avoids masks, filters, SMIL, and engine-specific geometry.

The clip is fully closed at progress 0, exactly half of the viewport's projected
extent at progress 0.5, and the full rectangle at progress 1. Named/raw
cubic-bezier `easing` is baked into the polygon samples; sampled spring and
`linear(...)` easings stay linear, matching the clock-wipe policy for bounded
geometry. The same geometry is used by both the ordinary reveal path and the
mixed-family entrance/exit compositor.

Coverage asserts the default byte-identity guarantee, eight vertices at every
sample for an arbitrary angle, the expected half-height geometry for 90 degrees,
and Chromium's computed interpolated clip at the transition midpoint.
