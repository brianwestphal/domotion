# 22 — `mask-image: element(#id)` paint references

## Context

CSS `mask-image: element(#some-id)` references the *painted output* of another DOM element as the mask source. Unlike `url("#fragment")` (doc 21), the target need not be a `<mask>` — it can be any visible DOM node (`<div>`, `<canvas>`, `<img>`, an `<svg>` icon, etc.). Chromium rasterises the target's paint and uses that bitmap as the mask.

Common patterns:
- A spinning `<div>` with a CSS gradient as a "scanlines" mask source.
- A `<canvas>` whose JS-driven contents drive a dynamic mask.
- An icon `<svg>` reused as both decoration and mask source for a partner element.

## Today's behaviour

CAPTURE_SCRIPT does not resolve `element(#id)` — `cs.maskImage` returns the literal string `element(#some-id)`, which `buildMaskDef()` doesn't match. Per DM-470's narrow-warning policy, we now warn `non-trivial mask source` for these cases.

## Proposed approach

This is fundamentally a rasterisation problem: we need a bitmap of how Chromium painted the referenced element. Domotion already has `rasterizeReplacedElements()` (see doc 17) that screenshots specific DOM elements via `page.screenshot({ clip: rect })`. The mask path can reuse it:

1. **Capture-time pass**:
   - When CAPTURE_SCRIPT sees `mask-image: element(#id)`, record the referenced id and the element's bounding rect.
   - Add the referenced element to a queue of "elements to rasterise as mask sources".
2. **Post-capture pass**, after the main DOM walk completes:
   - For each queued (target-id, rect): `page.screenshot({ clip: rect, omitBackground: true })` → PNG buffer.
   - Encode as `data:image/png;base64,…`.
   - Attach to the captured tree as `el.maskRasters: { id: string; dataUrl: string; width: number; height: number }[]`.
3. **Renderer**:
   - For each `mask-image: element(#id)` the renderer encounters, look up the corresponding `maskRasters` entry.
   - Emit as `<image href="…" width="…" height="…" />` inside `<mask>`, at the mask's CSS-positioned offset (mask-position / mask-size apply as usual).

## Open design questions

- **Mask-mode for rasterised paint.** Chromium's default `mask-mode: match-source` for `element()` is luminance (the painted RGB drives the alpha). Confirm this empirically against an `element()` fixture before defaulting to `mask-type="luminance"` on the SVG `<mask>`.
- **Animated source elements.** If the referenced element is itself animated (CSS animation, JS-driven canvas), the rasterised snapshot is one frame — domotion has no way to capture an animated mask source. Document this as a known limitation; warn at capture time when the source has a non-empty `getAnimations()` list.
- **DPR / scale.** The rasterised PNG should be captured at the page's actual DPR so it's not blurry when the receiving element is HiDPI. Match the existing replaced-element raster's DPR strategy (doc 17).

## Cost notes

Each `element()` mask costs one extra `page.screenshot` call (~50–200 ms each on real-world fixtures). For pages that use `element()` heavily, capture time may double. Implementation should:
- Dedupe by referenced id (one raster per unique target, regardless of how many consumers reference it).
- Skip rasterisation when the target has `display: none` / `visibility: hidden` (the painted output is empty anyway).

## What's deferred

- `<canvas>` referenced via `element()` *while* JS is animating it. The rasterised snapshot is whatever was painted at capture time; for most marketing demos this is acceptable.
- `element()` references that recursively reference other `element()`-masked elements. Resolve in topological order; if a cycle is detected, emit no mask and warn.

## Test fixture

`tests/features.ts` gains a `mask-element-ref` fixture:
- A hidden `<div id="src">` with a CSS radial gradient.
- A consumer `<div>` with `mask-image: element(#src)`.
- Asserts the consumer renders with the gradient cutout applied.

`src/mask.test.ts` gains a unit for the `element()` resolver — it should pass through to the maskRasters lookup.

## Open questions for the user

- **Should `element()` support be opt-in?** The capture-time cost is non-trivial. A flag like `--mask-element-refs` keeps default capture time low; users opt in when they have a fixture that needs it.
- **What about cross-document `element()`?** Spec allows it via SVG `<svg><defs><mask>… reference a foreign element</defs></svg>` chains. Recommendation: out of scope; same-document only.

## Follow-ups to file when this lands

- A real-world fixture exhibiting `element()` to validate the capture path. None of our current fixtures uses it; we'd need to either find one or contrive one.
- Performance regression budget: capture time should not regress on the existing real-world suite (which doesn't use `element()`). Add a bench step to `npm run demos:test`.
