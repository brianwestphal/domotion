---
id: "requirements/clip-path-fragment-references"
title: '39 — clip-path: url("#fragment") reference ownership'
kind: "reference"
status: "current"
owners: ["paint-effects", "layout", "product-tooling"]
platforms: []
tickets:
  [
    "DM-2338",
    "DM-2362",
    "DM-493",
    "DM-826",
    "DM-828",
    "DM-829",
    "DM-HK7GEB",
    "DM-302BYE",
    "DM-M6VWFD",
    "DM-CKS6JY",
    "DM-JDJ0DP",
    "DM-ST8D8V",
    "DM-N933MV",
    "DM-F19PYG",
    "DM-HSABGR",
    "DM-C6YH8W",
    "DM-FMYC9Q",
    "DM-CN257K",
    "DM-VA1P9H",
    "DM-0A8SGG",
    "DM-K48QDG",
    "DM-3N15PB",
  ]
code:
  [
    "src/capture/index.ts",
    "src/capture/external-css-svg.ts",
    "src/capture/blink-url-fragment.ts",
    "src/capture/external-svg-transport.ts",
    "src/capture/external-css-svg-raster.ts",
    "src/capture/external-css-svg-screenshot.ts",
    "src/capture/external-css-svg-shadow-guard.ts",
    "tests/external-css-svg-shadow.e2e.test.ts",
    "tests/external-css-svg.e2e.test.ts",
    "src/render/clip-path.test.ts",
    "src/render/svg-inline.test.ts",
    "tests/clip-path-url-reference-box.e2e.test.ts",
    "tests/external-svg-refs.e2e.test.ts",
    "tests/features.ts",
    "tests/iframe-inner-defs.e2e.test.ts",
    "tools/paint-geometry-browser-oracle.ts",
    "tools/paint-geometry-oracle.ts",
  ]
aliases: ["docs/39-clip-path-fragment-references.md", "doc-39"]
---

# 39 — `clip-path: url("#fragment")` reference ownership

## Context

CSS allows authors to point `clip-path` at a `<clipPath>` element defined inline in the same document (or in an external SVG file) by ID fragment:

```css
.element {
  clip-path: url("#hex"); /* same-document inline clipPath */
  clip-path: url("./shapes.svg#hex"); /* external SVG file fragment */
}
```

```html
<svg width="0" height="0" style="position: absolute;">
  <clipPath id="hex" clipPathUnits="objectBoundingBox">
    <polygon points="0.25 0, 0.75 0, 1 0.5, 0.75 1, 0.25 1, 0 0.5" />
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

1. Resolve the fragment through the consumer's originating `getRootNode()`
   TreeScope; a shadow-root miss does not fall through to the owner document.
2. If the element exists and is `<clipPath>`, serialize its `outerHTML`, scope,
   and resolved `clipPathUnits`.
3. Emit it as a top-level `ClipPathFragmentDef` and carry the same scope plus
   EffectiveZoom on its consumer.

At render time:

1. For each clipped element whose `clipPath` style is `url(#id)`, look the def
   up by `(TreeScope,id)` from the top-level collection.
2. Rewrite ids inside the def's `outerHTML` into that output definition's own
   namespace so both top-level and descendant ids remain collision-free.
3. Emit the rewritten `<clipPath>` into the output `<defs>` once per relevant
   reference-space key: `(scope, source-id, border rect)` for HTML
   `objectBoundingBox`, or `(scope, source-id, user-space origin, zoom)`
   otherwise.
4. Apply via `clipPathUrlId` on the masked element's wrapper `<g>`.

### 2. `clipPathUnits` semantics

The captured `<clipPath>`'s `clipPathUnits` is recorded at capture time (`ClipPathFragmentDef.clipPathUnits`, defaulting to `userSpaceOnUse` per the SVG spec) and drives how the def is emitted:

- `clipPathUnits="objectBoundingBox"`: the polygon / path coordinates are 0..1 fractions of the masked element's reference box. Blink passes an HTML consumer's **border box** explicitly to `CalculateClipTransform`; the generated SVG wrapper's natural bbox is not authoritative (a transparent host with one offset child proves the difference). Domotion therefore converts the normalized clip to `userSpaceOnUse` with one `translate(borderX,borderY) scale(borderWidth,borderHeight)` map per distinct consumer box. Native inline-SVG clones keep `objectBoundingBox`; Blink forces the SVG child's fill box.
- `clipPathUnits="userSpaceOnUse"` (the SVG default): the coordinates are in
  the user coordinate system at the reference site. For an HTML consumer,
  Blink supplies its border-box origin and EffectiveZoom. Domotion therefore
  emits a per-`(scope,id,x,y,zoom)` copy with
  `transform="translate(x,y) scale(zoom)"` on the `<clipPath>`. No scale is
  added for objectBoundingBox because the captured border dimensions already
  own that physical size. See DM-828 and DM-2338/[doc 208](208-iframe-fragment-reference-ownership.md).

### 3. External-file fragment (`url("./shapes.svg#clip-id")`)

**Implemented in DM-829; frozen-page ownership repaired in DM-HK7GEB.**
`primeExternalCssSvgReferences()` in `src/capture/external-css-svg.ts` runs at
the existing main-document prepass boundary. It reads external `clip-path` and
`mask-image` fragments with the document-authenticated isolated renderer
transport used by external SVG `<use>`. Native fetch retains cookies, CSP,
CORS and Playwright HAR routing; each request, including its body, has a
5-second Node-owned bound. It never resumes author fetch or timers. The
original default-document token is checked again after transport binding so
navigation cannot reuse a stale CSS snapshot in a new document.

Fragment identity follows Blink, not the computed spelling
(`src/capture/blink-url-fragment.ts`, Chromium pin `7d859f27`). Computed
`url("…")` tokens are read as CSS strings, so a fragment may contain `)` or
`'`, which the URL parser leaves unencoded. The canonical URL fragment is then
decoded with a port of `DecodeUrlEscapeSequences(kUtf8OrIsomorphic)`
(`url/url_util.cc:833-891`): a `%` without two hex digits stays literal, and
any invalid UTF-8 reverts the whole ID to its isomorphic (byte per code point)
reading. External `clip-path` decodes once (`svg_resource.cc:347-349`).
External `mask-image` decodes twice, because `CSSImageValue::EnsureSVGResource`
hands the already-normalized fragment (`css_image_value.cc:152-157`, `:189-194`)
to `ExternalSVGResourceImageContent::ResolveTarget`, which decodes it again
(`svg_resource.cc:391-394`). So `#%2541` names `%41` in a clip but `A` in a mask.
Native-vs-captured pixel controls in `tests/external-css-svg.e2e.test.ts` cover
spaces, Unicode, whole-sequence isomorphic reversion and that opposite pair.

The prepass imports the matching `<clipPath>` or `<mask>` into an owned hidden
SVG and temporarily points the source property at its local definition. The
existing same-document capture and rendering paths remain responsible for
geometry. Definitions survive all capture raster passes. Outer capture cleanup
restores the exact original style attribute when still owned; after an author
edit it restores only properties whose value and priority remain owned.
Unconfirmed restoration or foreign adoption of a definition retains the
journal/definition and reports a cleanup error, allowing a safe retry.
The adoption check resolves document-local URL identity and percent-decodes
generated ASCII fragment IDs; an encoded reference is still a live dependency.
Native clip and mask controls verify that refused cleanup preserves those
pixels and that a later retry succeeds after the foreign owner is removed.

Caveats: external fragments are validated over HTTP(S), not `file://`.
An unreadable, malformed, denied or stalled resource selects the authenticated
native whole-owner path below, or explicitly refuses an unsupported owner.
A missing or wrong-type
fragment in a successfully read document retains the existing walker outcome;
mixed unresolved mask layers refuse rather than partially rewriting paint.
One resource read is shared across consumers in the capture. The same Page
retains stable private definition names between captures; existing IDs and
local CSS references are excluded from allocation.

The native-owner fallback isolates author-shadow documents through an
authenticated per-scope authority (DM-JDJ0DP; it replaced the conservative
author-shadow refusal of DM-CKS6JY). A public-CDP session with five-second
setup/arm/read phases and one-second query/cleanup bounds retains the actual
owner object, original default execution context and document backend identity.
Before isolation it registers the main document's open and closed author roots,
resolved by backend node from the full pierced tree into that context, so the
isolation can reach closed trees. Isolation then walks the flat tree (slot
assignment read from each root's own slots, since `assignedSlot` hides closed
slots), checks every scope's elements, transitions and animations, and adopts
one owned constructed copy of the hide/show rules into every author root, because
a document sheet never matches inside a shadow tree. Arming re-verifies that the
tree contains the owner exactly once and exactly the registered author roots;
public topology/context events then invalidate the proof during the screenshot,
including roots inserted and removed before the final query. The same
owner/document/root set is verified again before PNG adoption. Restore removes
each owned adopted sheet by identity and reports a changed author list.

DM-ST8D8V discovers HTML resource owners inside open and closed main-document
author roots. A shadow-scoped owner keeps Chromium's native resource paint,
since a document-scoped cloned definition cannot resolve in that root. The
walker follows the host and slot children leading to the actual owner. For a
native owner hosting an author root, isolation retains its composed children,
including assigned slot nodes. Local SVG dependencies resolve in each
consumer's own tree scope. The composed children, source identity and observed
slot assignments must stay stable until PNG adoption. DM-96KECE measures direct
shadow text and assigned slot text at their original native Ranges and associates
the text runs with the same flat parent in the capture and CDP fragment probes.
Assigned text can remain separate from either native owner. For a mask, the
document font-face set must be empty to preserve source paint when isolation
ends. Direct text beside a clip also retains its source geometry and paint.

The guard refuses author roots inside embedded documents, an owner outside the
flat tree, direct ancestor text over a native mask, and any author cascade
(for example an inner-scope `!important`, which wins over the outer hide per
`cascade_priority.h:29-38`, Chromium 7d859f27) that leaves foreign paint visible.
Browser-owned UA shadow trees are excluded. Pinned `InspectorDOMAgent::getDocument`
builds the pierced shadow roots even when empty; `DidPushShadowRoot` emits events
for fully requested hosts. Unavailable coverage explicitly refuses and owned
isolation is restored. The selected-root-only shadow fact used by inset-root
admission does not authenticate foreign paint isolation. Native open/closed
slotted and separate-host controls had proved unrelated blue paint could enter
the pre-guard selected-owner PNG; the per-scope authority now reproduces the flat
document's PNG byte for byte in those shapes (doc 278).

Chromium can paint an SVG resource even when CSP `connect-src` denies a new
fetch. DM-302BYE preserves that paint through `externalCssSvgRaster`: a private
document journal correlates the exact selected HTML element with an atomic
Chromium-painted PNG. It reads no cached resource body and makes no replacement
network request. Public `Page.getResourceContent` does not establish selected
resource authority: pinned
[`InspectorPageAgent`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/inspector/inspector_page_agent.cc#L174)
invokes a resource-content loader and has document-fetcher/global-memory-cache/URL fallbacks. Native
cacheable and no-store SVG-mask/clip controls did not expose their painted SVG
through that API.

Native isolation excludes the owner, its descendants and ancestor path from
the hide selector entirely. It preserves native visibility and hidden children;
hiding and re-showing that path can make an external mask transparent. Ancestor
background, border, outline, shadow and pseudo paint are suppressed separately.
Foreign branches are verified hidden. The crop comes from actual PNG alpha,
including an explicitly transparent result; a successful screenshot alone is
never proof that source mask paint survived. Clip/mask positive controls must
retain the source red/white discriminator and exact full decoded pixels.

The native path has 5-second Node bounds, a 32-owner/16-Mpixel viewport budget,
document/selection checks before and after readback, and CAS cleanup. A failed
cleanup releases its still-owned hide sheet but retains uncertain markers and
the journal for safe retry. Native descendants and generated pseudo paint stay
under the same atomic owner; culling and stacking predicates must not hoist or
repaint them. An absent native surface is a renderer error, not an unclipped
vector fallback.

The initial native boundary is static HTML owners in the main document. It
refuses root body/html owners, animated/transitioning owners, backdrop blending,
and ancestors with filtered, blended, `clip-path`/`mask` or inexact overflow
clipped paint, 3D or individual-property transforms, zoom, propagated decoration
or image list markers. Potential isolation transitions, exposed root scrollbars
and inherited paint changes also refuse; owner computed paint must remain
unchanged through isolation/readback. These legitimate unsupported cases are
tracked by DM-K48QDG.

Exact ancestor overflow clips are supported (DM-K48QDG). Blink paints an
overflow clip with the pixel-snapped clip rect (`UpdateOverflowClip` passes
`ToSnappedClipRect(clip_rect)`, i.e. `ToPixelSnappedRect`, as the paint clip;
`paint_property_tree_builder.cc:2536-2538`, `:3085-3099`, pin `7d859f27`), so
the stamp is hard-clipped on whole pixels, and the renderer re-applies the
captured padding-box clip. Applying both is exact only when they are the same
whole pixels, so an ancestor clip is admitted when `overflow-x`/`overflow-y` are
both `hidden` or `clip` (no `auto`/`scroll` scrollbars, no one-axis clip),
`overflow-clip-margin` is 0, all border radii are 0, the padding box is
device-pixel aligned, and no ancestor is transformed; `contain: paint` follows
the same rule. Root overflow propagated to the viewport is not an element clip.
Native clip/mask controls are pixel-identical; with the alignment rule removed a
fractional clip is not. Ancestor `filter`, `backdrop-filter`, `mix-blend-mode`,
`clip-path` and `mask` remain refused: they composite the whole ancestor
subtree, and neutralizing `filter` changes the containing block of fixed and
absolute descendants.

Static 2D ancestor `transform`s are supported (DM-VA1P9H). The walk freezes them
and the renderer re-applies each as a `<g transform>`; the stamp is a viewport-
space crop that the renderer places through the inverse of the CTM open at the
owner's emission point (`viewportRasterMarkup`), so the transform is applied
once. The raster is marked `viewportSpace` so culling does not read its
rectangle as the owner's local box. Native clip/mask controls under
`rotate(8deg)` and `translate(6px, 4px) scale(1.25)` match source within
resampling of the antialiased stamp edge; without the inverse they are off by
full channel range.

Direct ancestor text, `::first-line`/`::first-letter` and text list markers are
supported for clip-path owners (DM-VA1P9H). When the ancestor path paints text,
isolation also makes `color`, `-webkit-text-fill-color`,
`-webkit-text-stroke-color`, `text-emphasis-color` and `text-shadow`
transparent/none on the ancestors and their first-line, first-letter and marker
pseudos, pins the owner to its own computed values (colors equal to `color` as
`currentcolor`, which inherits as a keyword), and verifies the ancestor text
channels after isolation and after readback; the owner-subtree fingerprint
catches any inherited change. A **mask** owner under ancestor text refuses: the
owner pin is a newly matched declaration on the owner, and a CSP-blocked
external mask whose owner gains one (by rule or inline style) stops painting
natively, so the stamp would come back transparent. An inherited-only change on
an ancestor kept the mask, as did re-attaching the plain fixture owner into
opacity wrappers (DM-3GE1EK measurement).

Ancestor `opacity` is supported (DM-N933MV). The renderer already emits each
captured ancestor's opacity group around the owner's `<image>`, so the stamp
must carry the owner's paint without it: isolation sets every ancestor to
`opacity:1` alongside its other suppressed paint channels and verifies the
computed value is `1` after isolation and after readback. Opacity is not
inherited, so the owner fingerprint is unaffected; an opacity transition on an
ancestor refuses like the other isolation channels. Native clip/mask controls
with nested `.5`/`.6` ancestors match source within 2 channel levels (PNG
quantization);
without neutralization the same controls are off by 54 levels.

Same-document definitions outside the owner (DM-F19PYG) keep their native
paint. The owner subtree's `clip-path`, `mask-image`, `filter`, `fill`,
`stroke` and marker URLs, and `href`/`xlink:href` on SVG `use`, gradient,
`pattern`, `feImage`, `textPath` and `mpath` elements, are resolved with Blink's
local-reference rule (a `#`-prefixed or same-document URL, decoded with
`kUtf8OrIsomorphic`; `css_url_data.cc:231-234`, `svg_uri_reference.cc:89-111`).
The transitive closure of each target's subtree is followed with a visited set,
so shared and cyclic definitions terminate. Every target must be, or sit
inside, content Blink never paints directly — `<defs>`, `<symbol>` or a
resource container, all `LayoutSVGHiddenContainer`
(`layout_svg_hidden_container.h:29-52`). Those elements are excluded from the
hide rule and pinned to their own computed `visibility`, since they would
otherwise inherit `hidden` from a hidden foreign `<svg>`; their full computed
style must be unchanged after isolation and after readback, their subtree may
not gain children, and foreign siblings in the same SVG stay verified hidden.
A directly painted target (for example a rendered `<rect>` reached through a
mask's `<use>`), an HTML target, or one containing the owner still refuses.
A readable auxiliary response is not proof of the resource Chromium selected
for native paint: a no-store resource that varies by request destination was
captured with the auxiliary bytes (DM-HSABGR). Byte identity is not observable
through public CDP, so the prepass verifies paint instead (DM-CN257K). Two
frames before the swap mark unstable pixels and one frame after it compares
the stable ones. A changed pixel inside a swapped target's subtree rect
(grown by 16 CSS px for shadows and outlines) sends that owner back to its
native paint as a `rasterOwners` entry, restoring its owned properties and any
swapped descendants. A change no target covers implicates every verifiable
target. The prepass uses viewport shots when eligible owners fit the viewport.

DM-0A8SGG uses Playwright's full-page comparison when a static readable
owner's subtree extends beyond the live viewport. The comparison translates
client rectangles by document scroll before converting them to device pixels.
Full-page comparison is bounded to 16,777,216 device pixels per frame and a
five-second geometry-and-screenshot deadline. DM-A35W0E tracks oversized
documents that need a narrower comparison. Chromium can dispatch a
source-page `resize` event for each full-page shot. The prepass takes up to
three comparison shots without deliberately scrolling the source. When native
fallback needs a capture rectangle beyond the live viewport, it takes a
separate full-page shot clipped to the part of the requested rectangle inside
the document and places the stamp relative to the original capture rectangle.
That clipped shot uses the same device-pixel and screenshot limits.

An empty isolated stamp after a full-page mismatch and readback cannot
authenticate the source paint. Capture refuses that case and restores the
source. The native-mask isolation follow-up DM-EQ1A6N tracks a fixture whose
paint disappears while the isolation sheet is active. Animated subtrees and
paintless candidates keep the vector path. DM-6N01HR tracks verification at a
frozen animation frame.

Native controls cover ordinary viewport clip and mask with a
destination-varying no-store resource, a wholly off-viewport clip, a partially
off-viewport clip with both scroll axes moved and a capture clipped by both
document edges, a cacheable off-viewport mask, and the empty-stamp refusal.
They compare source and rendered pixels and check restoration after capture.
the refusal is not support parity. SVG-use redirect admission remains the
separate DM-N8EYNT caller policy. Native controls cover frozen clip/mask pixels,
generated layers, overlap, scrolled viewports, real missing resources, exact rollback,
cookies, HAR replay, CSP paint, bounded stalled-body abort, partial setter
failure and foreign cleanup ownership in `tests/external-css-svg.e2e.test.ts`.
The transport's pinned Chromium origin-copy and document-CSP source contract,
and its distinction from the installed Chromium revision, are documented in
[doc 24](24-inline-svg-icon-references.md).

Restoring the swap must not reload the source's resource (DM-3N15PB).
Re-parsing an author's `clip-path` declaration creates a new `CSSURIValue` and
`ExternalSVGResource`. Its `Load()` fetches again (`svg_resource.cc:241-286`),
and `ResourceFetcher` always reloads a no-store SVG document
(`DetermineRevalidationPolicyInternal`, Chromium 7d859f27). Native
measurements showed two consequences (the first is pinned as a negative control
in `tests/external-css-svg.e2e.test.ts`):

- Restoring by `setProperty`, `setAttribute("style")` or Typed OM issued a
  second native request, and the source repainted with the new bytes.
- A keep-alive element made it worse, because it loads a copy of its own.

So a normal (not `!important`) inline `clip-path` on an HTML element is
overridden from an owned `!important` rule in an adopted constructed sheet,
which selects the element through a private per-prepass attribute. The author's
declaration is never touched, and removing the rule (on cleanup, or on a
paint-verification revert to native ownership) applies the original
declaration and its already loaded resource again.

Other targets keep the inline swap:

- An author `!important` sheet rule that outranks the owned rule is detected by
  the unchanged computed value and falls back to the inline swap.
- A clip-path from a stylesheet already restores without a re-parse.
- `mask-image` is reused within the document even when no-store
  (`kReuseNoStoreImageOnSameSrcReassignment`). Re-applying a shadowed external
  mask declaration instead left the native mask painting nothing.

An inline `!important` `clip-path` still reloads on restore; it cannot be
outranked from a sheet.

Caveats: this only works over **http(s)** — Chrome doesn't resolve external clip-path refs over `file://`, and a sibling-file `fetch()` is blocked there (so the feature is validated via a loopback-HTTP test, `tests/external-svg-refs.e2e.test.ts`, not the `file://` feature runner). Any failure (fetch error / non-2xx / non-http origin / missing or non-`<clipPath>` fragment) leaves the ref intact, so the walk emits its existing warning and the element paints unclipped — the pre-DM-829 baseline. A parsed file is fetched once and shared across consumers (icon-set pattern).

## Implementation notes

- **Serialisation scope**: capture serializes the `<clipPath>` element's `outerHTML` verbatim. Descendants (nested `<polygon>` / `<path>` / `<use>`) ride along as part of that string. References from inside the clipPath subtree to outside defs (`url(#filter)` etc.) are not chased today — that's defensible because real `<clipPath>` content is overwhelmingly self-contained geometry. File a follow-up if a fixture surfaces a clipPath with transitive defs.
- **Id rewriting**: reuse the existing `rewriteFragmentMaskDef()` machinery — it discovers every `id="…"` in the subtree, gives each output definition its own descendant namespace, and rewrites `id`, `href`/`xlink:href`, and `url(#…)` references consistently. The helper is element-name-agnostic.
- **Scoped identity**: capture definitions, consumer records, renderer lookups,
  and output caches use `(TreeScope,id)`. An outer document and iframe can
  both define `#hex` without first-wins aliasing.
- **Per-element placement**: HTML `objectBoundingBox` clipPaths get a scoped
  per-border-rect materialized map so an offset/overflowing descendant cannot
  redefine the reference box. `userSpaceOnUse` output is keyed by scoped id,
  border origin, and effective zoom.
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
- External `.svg` fragment refs resolve over HTTP(S) through the owned prepass;
  unavailable bytes can use native CSS paint (DM-302BYE). Unsupported native
  ancestry/compositing remains DM-N933MV; SVG-use redirects are DM-N8EYNT.
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
    <polygon points="0.25 0, 0.75 0, 1 0.5, 0.75 1, 0.25 1, 0 0.5" />
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
- `tests/iframe-inner-defs.e2e.test.ts`: duplicate outer/iframe ids,
  definition-local descendant namespaces, object/user units, asymmetric HTML
  borders, zoom, and exact DPR-1/2 source/render probes.

## Resolved design questions

- **`objectBoundingBox` vs explicit mapping**: explicit for HTML, native for SVG. Blink supplies the HTML border box even when the element has no painted box of its own, so `positionObjectBoundingBoxClipPathDef` materializes that map. A cloned inline-SVG reference remains native so its URL operation resolves against Blink's forced fill/object box.
- **Shared rewrite helper or per-feature copy**: shared. `rewriteFragmentMaskDef` is already element-name-agnostic at the implementation level.
- **Top-level vs per-element payload**: top-level (`tree[0].clipPathDefs`).
  Captured source defs are deduped by `(TreeScope,id)`; renderer copies are
  deduped by the scoped consumer reference-space key.

## Follow-ups

- ~~`userSpaceOnUse` clipPaths — per-element coordinate translation~~ — done (DM-828).
- ~~External `.svg` file fragment refs~~ — done (DM-829).
- Investigation: cross-def chains (clipPath → filter, clipPath → mask) when/if surfaced by a real-world fixture.

`clip-path: url(#id) <geometry-box>` must not be filed again as an
implementation gap unless Chromium's parser changes. A Chromium roll must first
move the strict live grammar control.
