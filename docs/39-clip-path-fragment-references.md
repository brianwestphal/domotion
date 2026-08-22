# 39 — `clip-path: url("#fragment")` reference ownership

## Context

CSS allows authors to point `clip-path` at a `<clipPath>` element defined inline in the same document (or in an external SVG file) by ID fragment:

```css
.element {
  clip-path: url("#hex");                   /* same-document inline clipPath */
  clip-path: url("./shapes.svg#hex");       /* external SVG file fragment */
}
```

```html
<svg width="0" height="0" style="position: absolute;">
  <clipPath id="hex" clipPathUnits="objectBoundingBox">
    <polygon points="0.25 0, 0.75 0, 1 0.5, 0.75 1, 0.25 1, 0 0.5"/>
  </clipPath>
</svg>
<div style="clip-path: url(#hex);">hex-clipped content</div>
```

Chromium resolves these by locating the `<clipPath>` resource and using its
contents as the clip source. The URL is the complete `clip-path` operation.
A geometry box may accompany a basic shape or stand alone, but cannot accompany
a URL reference. Every `url(#id) <geometry-box>` and
`<geometry-box> url(#id)` form is invalid for HTML and SVG consumers and
computes to `none`.

Docs 14 (per-corner border-radius) and 23 (sprite icons) cover the shape-function clip-path cases (`inset()`, `circle()`, `ellipse()`, `polygon()`, `path()`) that already round-trip. This doc covers what to do for fragment URLs that point at SVG `<clipPath>` definitions.

## Pinned Blink decisions

Source revision: Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`.

- `core/css/properties/longhands/longhands_custom.cc:2335-2366`,
  `ClipPath::ParseSingleValue`: `ConsumeUrl` returns immediately. Geometry-box
  parsing exists only in the separate basic-shape/standalone-box branch.
- `longhands_custom.cc:2369-2396`: computed style serializes a reference
  operation as the URL alone.
- `core/css/resolver/style_builder_converter.cc:363-398` and
  `core/style/reference_clip_path_operation.h`: a URL becomes
  `ReferenceClipPathOperation`, which carries no geometry-box field.
- `core/paint/clip_path_clipper.cc:364-400`: the default URL reference box is
  the HTML border box; for an SVG child Blink explicitly changes it to
  `fill-box`.
- `core/layout/svg/layout_svg_resource_clipper.cc:230-247`:
  `objectBoundingBox` maps normalized clip coordinates through the object
  bounding box; `userSpaceOnUse` stays in the consumer's user space.

There is no HarfBuzz or Skia decision at this geometry stage. Blink resolves
the operation and reference space before the resulting clip reaches graphics
painting.

## Capture and rendering

### 1. Same-document fragment (`url("#clip-id")`)

Mirrors the `mask-image: url("#id")` infrastructure introduced for inline `<mask>` defs (doc 21, DM-493). The two paths share the same id-rewriting helper.

At capture time, when CAPTURE_SCRIPT sees `clip-path: url("#clip-id")`:

1. Resolve the fragment: `document.getElementById(id)`.
2. If the element exists and is `<clipPath>`, serialise its `outerHTML`.
3. Emit it as part of the captured tree (new top-level field `tree[0].clipPathDefs?: ClipPathFragmentDef[]`).

At render time:

1. For each clipped element whose `clipPath` style is `url(#id)`, look the def up by id from the top-level collection.
2. Rewrite ids inside the def's `outerHTML` to a domotion-prefixed namespace so multiple captured frames sharing the same source id never collide in the output.
3. Emit the rewritten `<clipPath>` into the output `<defs>` once per relevant
   reference-space key: `(frame, source-id, border rect)` for HTML
   `objectBoundingBox`, or `(frame, source-id, user-space origin)` otherwise.
4. Apply via `clipPathUrlId` on the masked element's wrapper `<g>`.

### 2. `clipPathUnits` semantics

The captured `<clipPath>`'s `clipPathUnits` is recorded at capture time (`ClipPathFragmentDef.clipPathUnits`, defaulting to `userSpaceOnUse` per the SVG spec) and drives how the def is emitted:

- `clipPathUnits="objectBoundingBox"`: the polygon / path coordinates are 0..1 fractions of the masked element's reference box. Blink passes an HTML consumer's **border box** explicitly to `CalculateClipTransform`; the generated SVG wrapper's natural bbox is not authoritative (a transparent host with one offset child proves the difference). Domotion therefore converts the normalized clip to `userSpaceOnUse` with one `translate(borderX,borderY) scale(borderWidth,borderHeight)` map per distinct consumer box. Native inline-SVG clones keep `objectBoundingBox`; Blink forces the SVG child's fill box.
- `clipPathUnits="userSpaceOnUse"` (the SVG default): the coordinates are in the user coordinate system at the reference site. **Empirically (DM-828), for an HTML element that origin is the element's border-box top-left — element-local, NOT the source-page origin** (an earlier note here mis-stated it as page-absolute). Domotion draws the element's content at absolute (x, y) with no positioning transform, so each consumer gets a **per-(fragId, x, y) copy** of the clipPath with `transform="translate(x, y)"` added — `positionFragmentClipPathDef()`, the clipPath analogue of `positionFragmentMaskDef()`. (`<clipPath>` can't wrap children in a `<g>` — not a permitted child in SVG 1.1 — but it accepts a `transform` attribute, which Chrome honors.) **Implemented in DM-828.**

### 3. External-file fragment (`url("./shapes.svg#clip-id")`)

**Implemented in DM-829.** The `.svg` file isn't part of the captured DOM, so the sync walk can't reach it. An async pre-pass — `inlineExternalSvgRefs()` in `src/capture/index.ts`, run before the capture walk (alongside the `rasterize*` passes) — does the resolution in-page: for each element whose computed `clip-path` is an external `url("<path>#id")` (a non-empty path before the `#`), it fetches the file same-origin, `DOMParser`-extracts the `<clipPath id>`, inlines a copy into a hidden in-document `<svg>` under a fresh local id, and rewrites the element's inline `clip-path` to the exclusive `url(#localId)` form. There is no geometry-box token to preserve. The walk then sees a normal same-document fragment, and §1/§2 (incl. DM-828 userSpaceOnUse translation) render it **unchanged**.

Caveats: this only works over **http(s)** — Chrome doesn't resolve external clip-path refs over `file://`, and a sibling-file `fetch()` is blocked there (so the feature is validated via a loopback-HTTP test, `tests/external-svg-refs.e2e.test.ts`, not the `file://` feature runner). Any failure (fetch error / non-2xx / non-http origin / missing or non-`<clipPath>` fragment) leaves the ref intact, so the walk emits its existing warning and the element paints unclipped — the pre-DM-829 baseline. A parsed file is fetched once and shared across consumers (icon-set pattern).

## Implementation notes

- **Serialisation scope**: capture serialises the `<clipPath>` element's `outerHTML` verbatim. Descendants (nested `<polygon>` / `<path>` / `<use>`) ride along as part of that string. References from inside the clipPath subtree to outside defs (`url(#filter)` etc.) are not chased today — that's defensible because real `<clipPath>` content is overwhelmingly self-contained geometry. File a follow-up if a fixture surfaces a clipPath with transitive defs.
- **Id rewriting**: reuse the existing `rewriteFragmentMaskDef()` machinery — it discovers every `id="…"` in the subtree, mints prefixed aliases (the outer element gets `${idPrefix}cpfragN`; descendants get `${idPrefix}fragid-${original}`), and rewrites `id`, `href`/`xlink:href`, and `url(#…)` references consistently. The helper is element-name-agnostic (it does not care whether the root tag is `<mask>` or `<clipPath>`), so a single shared `rewriteFragmentDef()` covers both paths. Refactor only as needed for clarity; otherwise keep the existing function and rename the file-level docstring + tests.
- **Per-element placement**: HTML `objectBoundingBox` clipPaths get a per-`(fragId, border rect)` materialized map so an offset/overflowing descendant cannot redefine the reference box. For `userSpaceOnUse` (DM-828) the renderer mints a per-`(fragId, elX, elY)` copy translated to the element's border-box origin (`positionFragmentClipPathDef`), deduping identical positions — the same per-consumer-copy precedent as `resolveFragmentMaskRef`.
- **Resource loading failures** (missing fragment id, target is not a `<clipPath>`) fall back gracefully — capture emits a per-element warning and the renderer skips the clip (so the element paints unclipped; same outcome as the pre-DM-826 baseline).
- **URL grammar is exclusive** (DM-2362): `parseSameDocumentClipPathUrl`
  accepts only a bare same-document URL. Capture does not strip geometry boxes,
  the external pre-pass does not preserve them, and the renderer fails closed
  for synthetic/legacy URL-plus-box records. Blink rejected those declarations
  before any reference-box choice.
- **Cloned inline-SVG references** (DM-2362): computed `clip-path` baked into
  `outerHTML` serializes its quotes as `&quot;`. ID namespacing rewrites that
  encoded style reference as well as the presentation attribute; otherwise the
  stale style declaration wins the cascade and disables the clip. Native SVG
  then applies Blink's forced fill/object-bounding-box rule.

## Remaining boundaries

- ~~`clipPathUnits="userSpaceOnUse"`~~ — **done in DM-828** (per-element translated copy via `positionFragmentClipPathDef`; fixture `clip-path-userspaceonuse-fragment` in `tests/features.ts`).
- ~~External `.svg` file fragment refs (`url("./shapes.svg#id")`)~~ — **done in DM-829** (`inlineExternalSvgRefs` pre-pass; resolves over http(s), inlines as a same-document def).
- ~~Non-default `<geometry-box>` origins for URL references~~ — **closed by
  DM-2362's source audit**. Blink's parser rejects URL-plus-box syntax; it is a
  negative activation control, not a deferred geometry feature. Bare HTML URL
  refs use the border-box origin and SVG-child refs force fill-box.
- `<clipPath>` defs that reference other `<clipPath>` / `<mask>` / `<filter>` defs transitively — the rewriter passes those refs through unchanged today. Investigation ticket if a fixture surfaces a real cross-def chain.
- Animated clipPaths (`<animate>` children inside the clipPath) — out of scope; capture is a static snapshot.

## Evidence

`external/html-test/23-deep-clip-path-shapes.html` already has the canonical case at the bottom of the page:

```html
<svg width="0" height="0" style="position: absolute;">
  <clipPath id="hex" clipPathUnits="objectBoundingBox">
    <polygon points="0.25 0, 0.75 0, 1 0.5, 0.75 1, 0.25 1, 0 0.5"/>
  </clipPath>
</svg>
<div class="img" style="clip-path: url(#hex);">hex via SVG</div>
```

The original `clip-path-userspaceonuse-fragment` fixture remains the canonical
bare-URL visual. DM-2362 adds the source-decision and activation evidence:

- `src/render/clip-path.test.ts`: strict positive/negative URL grammar rows.
- `src/render/svg-inline.test.ts`: encoded computed-style reference
  namespacing mutation.
- `tools/paint-geometry-oracle.ts`: URL operation, HTML border-box, SVG forced
  fill-box, and stroke-box mutation records.
- `tools/paint-geometry-browser-oracle.ts`: live Chromium grammar and binary
  boundary probes at 4× device scale.
- `tests/clip-path-url-reference-box.e2e.test.ts`: capture→SVG comparisons at
  DPR 1/2, asymmetric HTML borders/padding, the SVG fill-versus-stroke
  boundary, invalid syntax, stale-tree rejection, and two nested same-origin
  frames.
- `tests/external-svg-refs.e2e.test.ts`: valid external URL reference and an
  external URL-plus-box negative over loopback HTTP.

## Resolved design questions

- **`objectBoundingBox` vs explicit mapping**: explicit for HTML, native for SVG. Blink supplies the HTML border box even when the element has no painted box of its own, so `positionObjectBoundingBoxClipPathDef` materializes that map. A cloned inline-SVG reference remains native so its URL operation resolves against Blink's forced fill/object box.
- **Shared rewrite helper or per-feature copy**: shared. `rewriteFragmentMaskDef` is already element-name-agnostic at the implementation level.
- **Top-level vs per-element payload**: top-level (`tree[0].clipPathDefs`). Captured source defs are deduped by id; renderer output copies are deduped by the consumer reference-space key so distinct HTML border boxes cannot share the wrong transform.

## Follow-ups

- ~~`userSpaceOnUse` clipPaths — per-element coordinate translation~~ — done (DM-828).
- ~~External `.svg` file fragment refs~~ — done (DM-829).
- Investigation: cross-def chains (clipPath → filter, clipPath → mask) when/if surfaced by a real-world fixture.

`clip-path: url(#id) <geometry-box>` must not be filed again as an
implementation gap unless Chromium's parser changes. A Chromium roll must first
move the strict live grammar control.
