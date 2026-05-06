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

DM-493 implemented same-document fragment refs (`url("#id")`). External-file refs (`url("./shapes.svg#id")`) are deferred to DM-496 and currently emit a capture-time warning (`external-file SVG fragment refs are not yet emitted`).

For same-document refs, CAPTURE_SCRIPT resolves `document.getElementById(id)` to the inline `<mask>` element and serialises its `outerHTML` into a top-level `maskDefs` payload on the captured tree. The renderer copies the mask def into the output `<defs>` with id rewriting and per-element coordinate translation so the mask aligns with the element being masked. See `rewriteFragmentMaskDef` and `positionFragmentMaskDef` in `src/dom-to-svg.ts`.

Prior behaviour: `buildMaskDef()` treated every `url(...)` as a raster image and emitted `<image href="…">` inside the SVG `<mask>` — wrong for fragment refs because there is no raster at that URL. Per DM-470's narrow-warning policy, fragment refs were warned. DM-493's path now bypasses `buildMaskDef()` entirely for `url("#id")` cases and emits the resolved inline mask instead.

## Proposed approach

### 1. Same-document fragment (`url("#mask-id")`)

At capture time, when CAPTURE_SCRIPT sees `mask-image: url("#mask-id")`:

1. Resolve the fragment: `document.getElementById(id)`.
2. If the element exists and is `<mask>`, serialise its `outerHTML`.
3. Emit it as part of the captured tree (new field `el.maskDefs?: { id: string; outerHTML: string }[]`).
4. The renderer copies `outerHTML` verbatim into the SVG output `<defs>` (rewriting the id to a domotion-prefixed one to avoid collisions across multiple captured frames) and points the element's `mask` attribute at the new id.

### 2. External-file fragment (`url("./shapes.svg#mask-id")`)

Deferred to DM-496. The .svg file is not part of the captured DOM, so capture would have to fetch it:

1. Resolve the URL relative to `document.baseURI`.
2. `await fetch(absoluteUrl).then(r => r.text())`.
3. Parse with `new DOMParser().parseFromString(svgText, "image/svg+xml")`, then `getElementById(fragment)`.
4. Same emit/rewrite path as case 1.
5. Cache the parsed file across multiple elements that point at different fragments of the same .svg (common: a single `icons.svg` file with dozens of `<mask>` and `<symbol>` defs).

For now, capture warns and falls back to the legacy raster-mask emission path for external-file refs. No real-world fixture currently exercises this case.

## Implementation notes (DM-493)

- **Serialisation scope**: capture serialises the `<mask>` element's `outerHTML` verbatim. Descendants of the `<mask>` (nested gradients, clipPaths, paths, etc.) ride along as part of that string. References from *inside* the mask to *outside* defs (e.g. a `<filter>` defined elsewhere in the document) are NOT followed today — the rewriter leaves those `url(#…)` refs untouched and the renderer relies on the normal output-side `<defs>`. If a real-world fixture surfaces a mask that depends on an external filter or clipPath, file a follow-up to do a transitive collection.
- **Id rewriting**: `rewriteFragmentMaskDef()` discovers every `id="…"` defined inside the mask subtree, mints a domotion-prefixed alias for each (the outer mask gets `${idPrefix}mkfragN`; descendants get `${idPrefix}fragid-${original}`), and rewrites `id`, `url(#…)`, and `href`/`xlink:href` references consistently. Refs that point at ids not defined inside the mask subtree pass through unchanged.
- **Per-element placement**: CSS `mask-image: url("#id")` positions the mask source at the *masked element's* content-box origin; SVG `<mask maskUnits="userSpaceOnUse">` interprets coordinates absolutely against the root SVG. The renderer wraps the mask's children in `<g transform="translate(elX, elY)">` and rewrites the `<mask>` element's bounds to match the masked element (`positionFragmentMaskDef()`). Each masked element gets its own positioned copy in `<defs>`; identical (fragId, position, size) tuples are deduped.
- **Resource loading failures** (missing fragment id, target is not a `<mask>`) fall back gracefully — capture emits a per-element warning and the renderer falls through to the legacy `buildMaskDef()` path (which is already a no-op for unresolved fragment URLs).

## What's deferred

- `mask-image: element(#id)` referencing a non-`<mask>` painted element (canvas/iframe/regular div) — covered by DM-477.
- `<mask>` definitions that depend on `<feImage>` or other filter primitives that domotion doesn't support — those will warn through the existing filter-emission path.
- Animated masks (mask defs with their own `<animate>` / `<animateTransform>` children) — out of scope; capture is a static snapshot.

## Test fixture

`tests/features.ts` has a `mask-fragment-url` fixture (DM-493):
- An inline `<svg><defs><mask id="diag-mask" maskUnits="userSpaceOnUse" …></mask></defs></svg>` defined inside the captured DOM.
- Two elements using `mask-image: url(#diag-mask)` at different positions to exercise per-element repositioning + dedupe.

External-file fixture (`url("./asset.svg#m2")`) is deferred to DM-496.

`src/mask.test.ts` covers `rewriteFragmentMaskDef()` (outer-id rewriting, descendant-id rewriting, `href`/`url(#…)` substitution, refs-outside-subtree pass-through, dedupe stability) and `positionFragmentMaskDef()` (content translation, `maskUnits=userSpaceOnUse` forcing).

## Resolved design questions

- **External `.svg` fetch**: deferred to DM-496 (backlog). Same-document covers the realistic case and keeps capture-time overhead bounded; external fetch adds CORS/CSP risk and latency.
- **Top-level vs per-element payload**: top-level array (`tree[0].maskDefs`). Captured fragment defs are deduped at capture time by source id; the renderer mints per-element copies for coordinate translation and dedupes identical (fragId, position, size) tuples.

## Follow-ups to file when this lands

- DM-496: external `.svg` file fragment refs (backlog).
- Renderer-side fixture for cross-frame mask reuse in animated SVGs (one captured `<mask>` def shared across multiple frames in `frame-merge.ts`).
- Investigation ticket if any real-world fixture (Apple, Resend, Stripe, …) ends up needing the external-file path — none currently flag it, but the DM-470 sign-off filed this preemptively.
