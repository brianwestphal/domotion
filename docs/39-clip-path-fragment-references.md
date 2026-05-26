# 39 — `clip-path: url("#fragment")` inline-SVG clipPath references

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

Chromium resolves these by walking the DOM (or fetching the .svg file), locating the `<clipPath>` element with the given `id`, and using its contents as the clip source.

Docs 14 (per-corner border-radius) and 23 (sprite icons) cover the shape-function clip-path cases (`inset()`, `circle()`, `ellipse()`, `polygon()`, `path()`) that already round-trip. This doc covers what to do for fragment URLs that point at SVG `<clipPath>` definitions.

## Today's behavior

`translateClipPath()` in `src/render/element-tree-to-svg.ts` recognises `inset` / `circle` / `ellipse` / `polygon` / `path` shape functions and returns "" for everything else — including `url(#id)`. When `translateClipPath` returns "", the renderer skips emitting a `<clipPath>` def and the element paints unclipped (the overflow-clip path takes over when an `overflow` is set, but that's a different clip).

The `23-deep-clip-path-shapes` html-test fixture's final panel uses `clip-path: url(#hex)` against an inline `objectBoundingBox` clipPath; it currently paints as a full unclipped rectangle instead of the expected hexagon. See DM-818 for the precedent in this fixture (per-corner inset round + geometry-box) and DM-826 for this gap.

## Proposed approach

### 1. Same-document fragment (`url("#clip-id")`)

Mirrors the `mask-image: url("#id")` infrastructure introduced for inline `<mask>` defs (doc 21, DM-493). The two paths share the same id-rewriting helper.

At capture time, when CAPTURE_SCRIPT sees `clip-path: url("#clip-id")`:

1. Resolve the fragment: `document.getElementById(id)`.
2. If the element exists and is `<clipPath>`, serialise its `outerHTML`.
3. Emit it as part of the captured tree (new top-level field `tree[0].clipPathDefs?: ClipPathFragmentDef[]`).

At render time:

1. For each masked element whose `clipPath` style is `url(#id)`, look the def up by id from the top-level collection.
2. Rewrite ids inside the def's `outerHTML` to a domotion-prefixed namespace so multiple captured frames sharing the same source id never collide in the output.
3. Emit the rewritten `<clipPath>` into the output `<defs>` once per (frame, source-id) tuple (deduped).
4. Apply via `clipPathUrlId` on the masked element's wrapper `<g>`.

### 2. `clipPathUnits` semantics

The captured `<clipPath>`'s `clipPathUnits` is recorded at capture time (`ClipPathFragmentDef.clipPathUnits`, defaulting to `userSpaceOnUse` per the SVG spec) and drives how the def is emitted:

- `clipPathUnits="objectBoundingBox"`: the polygon / path coordinates are 0..1 fractions of the masked element's bounding box. SVG renderers compute the bbox of the `<g>` the `clip-path` is applied to and auto-scale the clipPath into it. Since the renderer already emits the element's painted content as children of a single `<g>`, the natural bbox lines up with the captured element rect and Chromium's painted output. Emitted **verbatim**, one shared def per source id.
- `clipPathUnits="userSpaceOnUse"` (the SVG default): the coordinates are in the user coordinate system at the reference site. **Empirically (DM-828), for an HTML element that origin is the element's border-box top-left — element-local, NOT the source-page origin** (an earlier note here mis-stated it as page-absolute). Domotion draws the element's content at absolute (x, y) with no positioning transform, so each consumer gets a **per-(fragId, x, y) copy** of the clipPath with `transform="translate(x, y)"` added — `positionFragmentClipPathDef()`, the clipPath analogue of `positionFragmentMaskDef()`. (`<clipPath>` can't wrap children in a `<g>` — not a permitted child in SVG 1.1 — but it accepts a `transform` attribute, which Chrome honors.) **Implemented in DM-828.**

### 3. External-file fragment (`url("./shapes.svg#clip-id")`)

**Implemented in DM-829.** The `.svg` file isn't part of the captured DOM, so the sync walk can't reach it. An async pre-pass — `inlineExternalClipPaths()` in `src/capture/index.ts`, run before the capture walk (alongside the `rasterize*` passes) — does the resolution in-page: for each element whose computed `clip-path` is an external `url("<path>#id")` (a non-empty path before the `#`), it fetches the file same-origin, `DOMParser`-extracts the `<clipPath id>`, inlines a copy into a hidden in-document `<svg>` under a fresh local id, and rewrites the element's inline `clip-path` to `url(#localId)` (preserving any `<geometry-box>` keyword). The walk then sees a normal same-document fragment, and §1/§2 (incl. DM-828 userSpaceOnUse translation) render it **unchanged**.

Caveats: this only works over **http(s)** — Chrome doesn't resolve external clip-path refs over `file://`, and a sibling-file `fetch()` is blocked there (so the feature is validated via a loopback-HTTP test, `tests/external-clippath.test.ts`, not the `file://` feature runner). Any failure (fetch error / non-2xx / non-http origin / missing or non-`<clipPath>` fragment) leaves the ref intact, so the walk emits its existing warning and the element paints unclipped — the pre-DM-829 baseline. A parsed file is fetched once and shared across consumers (icon-set pattern).

## Implementation notes

- **Serialisation scope**: capture serialises the `<clipPath>` element's `outerHTML` verbatim. Descendants (nested `<polygon>` / `<path>` / `<use>`) ride along as part of that string. References from inside the clipPath subtree to outside defs (`url(#filter)` etc.) are not chased today — that's defensible because real `<clipPath>` content is overwhelmingly self-contained geometry. File a follow-up if a fixture surfaces a clipPath with transitive defs.
- **Id rewriting**: reuse the existing `rewriteFragmentMaskDef()` machinery — it discovers every `id="…"` in the subtree, mints prefixed aliases (the outer element gets `${idPrefix}cpfragN`; descendants get `${idPrefix}fragid-${original}`), and rewrites `id`, `href`/`xlink:href`, and `url(#…)` references consistently. The helper is element-name-agnostic (it does not care whether the root tag is `<mask>` or `<clipPath>`), so a single shared `rewriteFragmentDef()` covers both paths. Refactor only as needed for clarity; otherwise keep the existing function and rename the file-level docstring + tests.
- **Per-element placement**: for `objectBoundingBox` clipPaths, no per-element repositioning is required — SVG handles the auto-scaling natively, so the renderer emits ONE clipPath def per (frame, source-id) tuple and references it from every masked element. For `userSpaceOnUse` (DM-828) the renderer mints a per-`(fragId, elX, elY)` copy translated to the element's origin (`positionFragmentClipPathDef`), deduping identical positions — the same per-consumer-copy precedent as `resolveFragmentMaskRef`.
- **Resource loading failures** (missing fragment id, target is not a `<clipPath>`) fall back gracefully — capture emits a per-element warning and the renderer skips the clip (so the element paints unclipped; same outcome as the pre-DM-826 baseline).
- **Interaction with the `<geometry-box>` keyword** (DM-818): `clip-path: url(#id) padding-box` is grammatically valid (CSS Masking 1 §3.1). The renderer's existing geo-box stripping at `src/render/element-tree-to-svg.ts:543` already handles this — the residual shape value after stripping is just `url(#id)`. For `objectBoundingBox` clipPaths there's nothing to do (the geo-box doesn't affect a bbox-relative clipPath); for `userSpaceOnUse` clipPaths (DM-828) the translate uses the border-box origin (the default) — a non-default box keyword's origin offset is a small deferred follow-up.

## What's deferred

- ~~`clipPathUnits="userSpaceOnUse"`~~ — **done in DM-828** (per-element translated copy via `positionFragmentClipPathDef`; fixture `clip-path-userspaceonuse-fragment` in `tests/features.ts`).
- ~~External `.svg` file fragment refs (`url("./shapes.svg#id")`)~~ — **done in DM-829** (`inlineExternalClipPaths` pre-pass; resolves over http(s), inlines as a same-document def).
- **Non-default `<geometry-box>` origin offset for `userSpaceOnUse`** — `clip-path: url(#id) padding-box` shifts the user-space origin to the padding box (inside the border); DM-828 translates by the border-box origin (the default, the common case). Folding the box-keyword offset into the translate is a small follow-up if a fixture surfaces it.
- `<clipPath>` defs that reference other `<clipPath>` / `<mask>` / `<filter>` defs transitively — the rewriter passes those refs through unchanged today. Investigation ticket if a fixture surfaces a real cross-def chain.
- Animated clipPaths (`<animate>` children inside the clipPath) — out of scope; capture is a static snapshot.

## Test fixture

`external/html-test/23-deep-clip-path-shapes.html` already has the canonical case at the bottom of the page:

```html
<svg width="0" height="0" style="position: absolute;">
  <clipPath id="hex" clipPathUnits="objectBoundingBox">
    <polygon points="0.25 0, 0.75 0, 1 0.5, 0.75 1, 0.25 1, 0 0.5"/>
  </clipPath>
</svg>
<div class="img" style="clip-path: url(#hex);">hex via SVG</div>
```

Pre-DM-826 baseline: `minor · 1 region · 0.34%`. The 1 residual region is the unclipped hex panel. Post-fix, this drops below the `minor` verdict.

A unit test exercising id-rewriting on a synthetic clipPath outerHTML lives alongside the existing `rewriteFragmentMaskDef` tests in `src/mask.test.ts` (or a new `clip-path.test.ts` if the shared helper is renamed during refactor).

## Resolved design questions

- **`objectBoundingBox` vs explicit translation**: pass-through. SVG's native `objectBoundingBox` auto-scales the clipPath into the bbox of the `<g>` the clip-path is applied to; the captured-element wrapper `<g>` is the right reference frame, no per-element math required.
- **Shared rewrite helper or per-feature copy**: shared. `rewriteFragmentMaskDef` is already element-name-agnostic at the implementation level.
- **Top-level vs per-element payload**: top-level (`tree[0].clipPathDefs`). Captured fragment defs are deduped at capture time by source id; the renderer emits each def once per output SVG and references it from every consumer.

## Follow-ups to file when this lands

- ~~`userSpaceOnUse` clipPaths — per-element coordinate translation~~ — done (DM-828).
- ~~External `.svg` file fragment refs~~ — done (DM-829).
- Investigation: cross-def chains (clipPath → filter, clipPath → mask) when/if surfaced by a real-world fixture.
