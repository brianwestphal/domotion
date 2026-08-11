# 117 — Parameterized built-in transitions

DM-2071 adds canonical family forms alongside the byte-compatible legacy names. Values are statically bounded by the shared schema and normalize into the same viewer-safe opacity, translate, scale, clip, and gradient-overlay plan.

## Forms and units

```json
{ "type": "push", "duration": 300, "push": { "angle": 35, "distance": 0.8 } }
{ "type": "reveal", "duration": 300, "reveal": { "shape": "clock", "origin": { "x": 0.4, "y": 0.6 }, "startAngle": 90, "direction": "counterclockwise" } }
{ "type": "zoom", "duration": 300, "zoom": { "fromScale": 1.25, "origin": { "x": 0.5, "y": 0.5 } } }
{ "type": "shine", "duration": 300, "shine": { "angle": 20, "bandWidth": 0.25, "color": "#fff", "opacity": 0.5 } }
```

- Angles are degrees clockwise from the positive x axis for push/linear reveal. Clock `startAngle` remains degrees clockwise from 12 o'clock.
- Push `distance` is a viewport fraction on each projected axis, bounded `(0, 2]`; `direction` is an alternative to `angle`.
- Origins are viewport-relative `{x,y}` coordinates, each clamped by validation to `[0,1]`.
- Radial `radius` is a farthest-corner coverage multiplier in `[1,2]`, so completion always covers the viewport.
- Zoom `fromScale` is `[0.01,4]` and always settles at `scale(1)`.
- Shine `bandWidth` is a viewport-width fraction `(0,2]`; opacity is `[0,1]`. Color is an SVG color string.

The nested parameter objects are strict and shape-discriminated: an origin on a linear reveal, reveal parameters on a push, or an out-of-range scale fails validation instead of being ignored.

## Compatibility and playback

Legacy names remain aliases with their original defaults and emitter paths: `push-left/right/up/down`, `scroll`, `wipe`, `iris`, `wipe-radial`, `wipe-clock`, and `zoom-in/out`. Omitting `shine` parameters preserves the original shine bytes. Parameterized forms use the unified compositor, keeping mixed entrance/exit primitives on one CSS timeline. They animate only opacity, transform, clip-path, and the existing gradient sweep; no filters, masks, JavaScript, or SMIL are introduced.

Unit tests cover schema rejection, normalization, identity rests, origins, and mixed families. The Chromium/WebKit test samples a 1440×900 push → clock reveal → zoom → shine sequence at transition quartiles and asserts continuous full-frame coverage.
