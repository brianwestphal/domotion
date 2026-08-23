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

## Today's behavior

DM-493 implemented same-document fragment refs (`url("#id")`); DM-496 added external-file refs (`url("./shapes.svg#id")`) by inlining the fetched `<mask>` as a same-document def before the walk (see §2). A capture-time warning now only fires when that resolution fails (fetch error / non-http / missing fragment).

For local refs, CAPTURE_SCRIPT resolves the inline `<mask>` in the consumer's
originating TreeScope and serialises `(scope,id)`, `outerHTML`, SVG unit/region
facts, and computed `mask-type` into the root `maskDefs` payload. The renderer
copies the selected definition into output `<defs>` with collision-free id
rewriting and materializes its region/content map against the consumer's HTML
border box and effective zoom. See `rewriteFragmentMaskDef`,
`positionFragmentMaskDef`, and [doc 208](208-iframe-fragment-reference-ownership.md).

Prior behavior: `buildMaskDef()` treated every `url(...)` as a raster image and emitted `<image href="…">` inside the SVG `<mask>` — wrong for fragment refs because there is no raster at that URL. Per DM-470's narrow-warning policy, fragment refs were warned. DM-493's path now bypasses `buildMaskDef()` entirely for `url("#id")` cases and emits the resolved inline mask instead.

## Proposed approach

### 1. Same-document fragment (`url("#mask-id")`)

At capture time, when CAPTURE_SCRIPT sees `mask-image: url("#mask-id")`:

1. Resolve the fragment through the consumer's `getRootNode()` TreeScope; a
   shadow-root miss does not fall through to the owner document.
2. If the element exists and is `<mask>`, serialise its `outerHTML`, scope,
   units, source-resolved region, and computed channel.
3. Emit it as a `MaskFragmentDef` and put the same scope plus effective zoom on
   the consuming element.
4. The renderer selects by `(scope,id)`, rewrites the definition into a unique
   per-output namespace, materializes its region/content map, and points the
   element's `mask` attribute at the new id.

### 2. External-file fragment (`url("./shapes.svg#mask-id")`)

**Implemented in DM-496.** The `.svg` file isn't part of the captured DOM, so the synchronous capture walk can't reach it. An async pre-pass — `inlineExternalSvgRefs()` in `src/capture/index.ts`, shared with the clip-path analogue (DM-829) and run before the walk — resolves it in-page:

1. Scan each element's computed `mask-image` (and `-webkit-mask-image`) for an external `url("<path>#id")` (a non-empty path before the `#`; the same-document `url("#id")` form is skipped).
2. `fetch` the file same-origin, `DOMParser`-parse it, and `getElementById` the referenced `<mask>`.
3. Inline a copy of the `<mask>` into a hidden in-document `<svg>` under a fresh local id, and rewrite the element's `mask-image` to `url(#localId)` (overriding only the image longhand, so mask-mode/size/position/repeat survive).
4. The walk then sees a normal same-document fragment → case 1 (above) renders it unchanged.

A file is fetched once and shared across consumers (icon-set pattern). Only works over **http(s)** — Chrome doesn't resolve external mask refs over `file://`, and a sibling-file `fetch` is blocked there (so it's validated by a loopback-HTTP test, `tests/external-svg-refs.e2e.test.ts`, not the `file://` feature runner). Any failure (fetch error / non-2xx / non-http origin / missing or non-`<mask>` fragment) leaves the ref intact, so capture warns and the element paints unmasked — the pre-DM-496 baseline.

## Implementation notes (DM-493)

- **Serialisation scope**: capture serialises the `<mask>` element's `outerHTML` verbatim. Descendants of the `<mask>` (nested gradients, clipPaths, paths, etc.) ride along as part of that string. References from *inside* the mask to *outside* defs (e.g. a `<filter>` defined elsewhere in the document) are NOT followed today — the rewriter leaves those `url(#…)` refs untouched and the renderer relies on the normal output-side `<defs>`. If a real-world fixture surfaces a mask that depends on an external filter or clipPath, file a follow-up to do a transitive collection.
- **Id rewriting**: `rewriteFragmentMaskDef()` discovers every `id="…"` defined inside the mask subtree, mints a definition-local alias for each (the outer mask gets `${idPrefix}mkfragN`; descendants use that output id as their namespace), and rewrites `id`, `url(#…)`, and `href`/`xlink:href` references consistently. Refs that point at ids not defined inside the mask subtree pass through unchanged.
- **Scoped identity**: author ids are unique only inside an originating
  TreeScope. Capture definitions, consumer records, renderer lookup, and output
  cache all use `(scope,id)`, so outer/iframe/shadow definitions cannot
  first-win one another.
- **Per-element placement**: Blink supplies the HTML consumer's border box.
  Object-bounding-box region/content values map through its origin and size;
  user-space values keep the defining SVG viewport's resolved coordinates and
  scale by the consumer's EffectiveZoom. The renderer emits an absolute
  user-space definition for each distinct scoped geometry/channel tuple.
- **Mask source semantics**: the referenced mask's computed `mask-type` owns
  `match-source`; an explicit CSS `mask-mode` overrides it. SVG fragment mask
  sources ignore the layer's ordinary origin/clip/size/position/repeat image
  geometry, as locked by the hostile-longhand discriminator in doc 208.
- **Resource loading failures** (missing fragment id, target is not a `<mask>`) fall back gracefully — capture emits a per-element warning and the renderer falls through to the legacy `buildMaskDef()` path (which is already a no-op for unresolved fragment URLs).

## What's deferred

- `mask-image: element(#id)` referencing a non-`<mask>` painted element (canvas/iframe/regular div) — covered by DM-477.
- `<mask>` definitions that depend on `<feImage>` or other filter primitives that domotion doesn't support — those will warn through the existing filter-emission path.
- Animated masks (mask defs with their own `<animate>` / `<animateTransform>` children) — out of scope; capture is a static snapshot.
- Multi-layer values containing one or more fragment URLs are tracked by
  DM-2520; this path still activates only for one complete `url(#id)` value.

## Test fixture

`tests/features.ts` has a `mask-fragment-url` fixture (DM-493):
- An inline `<svg><defs><mask id="diag-mask" maskUnits="userSpaceOnUse" …></mask></defs></svg>` defined inside the captured DOM.
- Two elements using `mask-image: url(#diag-mask)` at different positions to exercise per-element repositioning + dedupe.

External-file fixture (`url("./maskdef.svg#m")`): `tests/external-svg-refs.e2e.test.ts` (loopback-HTTP, DM-496).

`src/mask.test.ts` covers `rewriteFragmentMaskDef()` (outer-id rewriting, descendant-id rewriting, `href`/`url(#…)` substitution, refs-outside-subtree pass-through, dedupe stability) and `positionFragmentMaskDef()` (content translation, `maskUnits=userSpaceOnUse` forcing).

`tests/iframe-inner-defs.e2e.test.ts` is the strict DPR-1/2 ownership and
geometry discriminator for duplicate outer/iframe ids, object/user units,
zoom, asymmetric borders, alpha/luminance, ignored mask image geometry, and
per-output descendant namespaces. The `iframe-inner-clip-mask` feature row now
passes at 0.00% without a relaxed threshold.

## Resolved design questions

- **External `.svg` fetch**: implemented in DM-496 via the shared `inlineExternalSvgRefs` in-page pre-pass (same mechanism as the clip-path analogue, DM-829). In-page same-origin `fetch` keeps it simple + consistent across the two features; the CSP/CORS-robust alternative (Node-side `page.context().request.fetch`) was weighed and declined for that consistency, since Domotion captures the author's own pages (see docs/39 for the clip-path counterpart).
- **Top-level vs per-element payload**: top-level array (`tree[0].maskDefs`).
  Captured definitions are deduped by `(TreeScope, source id)`; renderer output
  copies are deduped by the scoped region/content/channel/zoom tuple.

## Follow-ups

- DM-2520: TreeScope-correct discovery and ordered composition for fragment
  URLs inside multi-layer `mask-image` values.
- Transitive source-scoped definition collection when a real mask depends on a
  sibling filter, gradient, mask, or clip outside its copied subtree.
