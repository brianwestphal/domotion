# 21 — `mask-image: url("#fragment")` inline-SVG mask references

## Context

CSS allows authors to point `mask-image` at a `<mask>` element defined inline in the same document (or in an external SVG file) by ID fragment:

```css
.element {
  mask-image: url("#my-mask");          /* same-document inline mask */
  mask-image: url("./shapes.svg#blob"); /* external SVG file fragment */
}
```

Chromium resolves these by walking the DOM (or fetching the .svg file), locating the `<mask>` element with the given `id`, and using its content as the mask source.

Doc 20 covers the gradient + raster `url()` cases that already round-trip cleanly. This doc covers what to do for fragment URLs that point at SVG `<mask>` definitions.

## Today's behaviour

`buildMaskDef()` in `src/dom-to-svg.ts:5802` treats every `url(...)` as a raster image: it emits `<image href="…">` inside the SVG `<mask>` element. For `url("./shapes.svg#blob")` and `url("#blob")` that's wrong — there is no raster at that URL, only a vector mask definition.

Per DM-470's narrow-warning policy, we now warn `non-trivial mask source` when the URL is a fragment reference rather than dropping it silently.

## Proposed approach

### 1. Same-document fragment (`url("#mask-id")`)

At capture time, when CAPTURE_SCRIPT sees `mask-image: url("#mask-id")`:

1. Resolve the fragment: `document.getElementById(id)`.
2. If the element exists and is `<mask>`, serialise its `outerHTML`.
3. Emit it as part of the captured tree (new field `el.maskDefs?: { id: string; outerHTML: string }[]`).
4. The renderer copies `outerHTML` verbatim into the SVG output `<defs>` (rewriting the id to a domotion-prefixed one to avoid collisions across multiple captured frames) and points the element's `mask` attribute at the new id.

### 2. External-file fragment (`url("./shapes.svg#mask-id")`)

The .svg file is not part of the captured DOM, so capture must fetch it:

1. Resolve the URL relative to `document.baseURI`.
2. `await fetch(absoluteUrl).then(r => r.text())`.
3. Parse with `new DOMParser().parseFromString(svgText, "image/svg+xml")`, then `getElementById(fragment)`.
4. Same emit/rewrite path as case 1.

Cache the parsed file across multiple elements that point at different fragments of the same .svg (common: a single `icons.svg` file with dozens of `<mask>` and `<symbol>` defs).

## Open design questions

- **Should we serialise the *entire* `<mask>` subtree** (including any `<filter>` / `<clipPath>` / nested mask refs the mask itself depends on)? Naive `outerHTML` won't follow refs from inside the mask. Recommendation: do a transitive walk inside the mask, collecting every fragment URL it references, and copy each into our `<defs>`.
- **Cross-document id rewriting** is necessary — the captured page has its own id namespace, and our SVG output uses prefixed ids (`mkN`, `clip-N`, etc.). Strategy: walk the serialised mask's attributes, find every `url(#…)`, mint a new prefixed id for each referenced fragment, and substitute.
- **Resource loading failures** (404 on the external .svg, CSP-blocked fetch, missing fragment id) should fall back gracefully — emit no mask and warn at capture time.

## What's deferred

- `mask-image: element(#id)` referencing a non-`<mask>` painted element (canvas/iframe/regular div) — covered by DM-477.
- `<mask>` definitions that depend on `<feImage>` or other filter primitives that domotion doesn't support — those will warn through the existing filter-emission path.
- Animated masks (mask defs with their own `<animate>` / `<animateTransform>` children) — out of scope; capture is a static snapshot.

## Test fixture

`tests/features.ts` should gain a `mask-fragment-url` fixture:
- An inline `<mask id="m1">` with a `<rect>` cutout.
- An element using `mask-image: url("#m1")`.
- A second element using `mask-image: url("./asset.svg#m2")` from `tests/fixtures/`.

`src/mask.test.ts` gains unit coverage for the fragment-resolver (id rewriting, transitive ref collection, fetch-error fallback).

## Open questions for the user

- **Is fetching external .svg files at capture time acceptable, or should we restrict scope to same-document fragment refs only?** External fetch adds latency and CSP risk; same-document covers the more common case.
- **Should the captured-mask payload live on the parent capture tree (top-level `defs` array) or on the referencing element?** Top-level dedupes when many elements reference the same mask; per-element is simpler but bloats the payload.

## Follow-ups to file when this lands

- Renderer-side fixture for cross-frame mask reuse in animated SVGs (one captured `<mask>` def shared across multiple frames in `frame-merge.ts`).
- Investigation ticket if any real-world fixture (Apple, Resend, Stripe, …) ends up needing this path — none currently flag it, but the DM-470 sign-off filed this preemptively.
