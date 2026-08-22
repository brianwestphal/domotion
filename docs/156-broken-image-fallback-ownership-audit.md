# 156 — Chromium broken-image fallback ownership audit

Status: capture foundation and hybrid rendering shipped in DM-2463/DM-2464.
The independent macOS/Linux/Windows paint gate remains DM-2465.

## Question and evidence boundary

This audit answers which parts of a failed HTML `<img>` should remain native
SVG and which part Chromium already owns as pixels. It covers fallback
activation, intrinsic/layout behavior, alternative text, font/baseline,
border/padding, clipping, direction, writing mode, zoom, DPR, color scheme,
platform variance, and accessibility.

The source authority is Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` (2026-06-27), HarfBuzz
`4de187dd0a915d13c976fa8bd474c084229f3aab` (2026-07-31), and Skia at
Chromium's pinned revision `62efacd37737505732dbe3d8daa62abd679626a1`.
Fresh browser measurements below used Playwright Chromium 147.0.7727.15 on
macOS at DPR 1 and 2. The source decision precedes the measurements; the probe
only verifies that the installed browser still exposes the expected boundary.

## Shipped boundary and remaining gate

Older serialized trees may still carry the compatibility fields:

- `imageBroken = el.complete && el.naturalWidth === 0`; and
- `imageAlt = el.alt || ""`.

The former `paintBrokenImage()` consumed those fields to paint an unconditional
fixed gray mountain and raw SVG `<text>`. DM-2464 removes that helper. A legacy
broken record without the authoritative live facts now fails closed instead of
silently reviving the source-inexact geometry or baseline.

DM-2463 no longer treats those fields as capture authority. Every live
`<img>` now receives `brokenImageFallback`: a Node/CDP post-pass pierces the
UA shadow tree while private live-node correlation exists and records the
disposition, physical host/container/icon boxes, used styles/clip, alt/title
presence and resolution, code-point-safe hidden-Text ranges, font metrics and
platform fonts, DPR resource selection, and independent AX state. Missing
required facts warn and request a classified terminal surface.

DM-2464 consumes that record through `src/render/broken-image-fallback.ts`.
Author paint stays in the ordinary box pipeline; captured UA border and clip
become vectors; hidden alternative-text segments use the normal shaped text
renderer; and `src/capture/broken-image-icon-raster.ts` supplies only the
isolated `#alttext-image` compositor pixels with PNG/decoded-RGBA fingerprints.
The DPR-1/2 browser test pins 16×16/32×32 icon crops, 24×24/48×48 zoomed crops,
vertical orientation, title/empty/missing states, successful-image and hidden-
icon negatives, and one independent AX node. DM-2465 still owns the stricter
direct icon-content comparison and macOS/Linux/Windows reports.

## Blink's decision procedure

### 1. A failed host stops being an ordinary `LayoutImage`

`HTMLImageElement::ResetLayoutDisposition()` chooses primary content while the
resource is potentially available and otherwise calls
`EnsureCollapsedOrFallbackContent()`
(`html_image_element.cc:1054-1092`). A resource error whose
`ShouldCollapseInitiator()` is true chooses the collapsed disposition; other
failures choose fallback content. In fallback content,
`CreateLayoutObject()` creates a block-flow/list-item layout object rather than
`LayoutImage` (`html_image_element.cc:517-538`). This is why object-fit and
`ImagePainter`'s ordinary missing-image outline are not the governing paint
model for a normal broken `<img>` fallback.

For contrast, `ImagePainter::PaintReplaced()` uses its light-gray stroked
content rect only when a `LayoutImage` has no image at all, and suppresses even
that for a content box no larger than 2 px on either axis
(`image_painter.cc:118-197`). The failed host has already left that layout
class. Its nested `#alttext-image` instead receives a loaded broken-image
resource and follows ordinary bitmap image paint.

The disposition transition creates a UA shadow tree
(`html_image_element.cc:1131-1179`):

```text
#alttext-container (span)
├── #alttext-image (img, width=16, height=16, align=left, margin=0)
└── #alttext (span)
    └── Text(resolved alternative text)
```

The construction is explicit in
`html_image_fallback_helper.cc:216-242`. `HTMLImageElement::AltText()` uses the
`alt` attribute when it is present and otherwise the `title` attribute
(`html_image_element.cc:434-443`). Reading the DOM `el.alt` property cannot
recover that distinction because both a missing and an empty `alt` property
read as an empty string.

### 2. Replaced versus inline fallback is a source-defined state machine

`TreatImageAsReplaced()`
(`html_image_fallback_helper.cc:50-62`) returns true when:

1. both width and height are non-auto, or an explicit aspect ratio combines
   with either dimension; and
2. the document is in quirks mode or the `alt` attribute value is empty
   (including a missing attribute).

In quirks mode, one specified dimension is first mirrored to the other
(`html_image_fallback_helper.cc:254-264`). Otherwise a standards-mode broken
image with non-empty alternative text is non-replaced: the host's width,
height, and aspect ratio are reset and ordinary inline fallback contents size
the box (`html_image_fallback_helper.cc:274-280`).

The resulting states are:

| Inputs after failure | Layout/paint result |
| --- | --- |
| Error requests collapse | Collapsed; no fallback subtree paint. |
| Non-empty `alt`, or missing `alt` with non-empty `title`, standards mode, not otherwise replaced | Non-replaced phrasing fallback. The 16 px icon floats inline-start and ordinary text follows it. Author width/height do not constrain the fallback. |
| Non-empty `src`, empty `alt`, no replaced dimensions | Empty inline fallback; icon is `display:none`, no text paints. |
| Missing/empty `src` and missing/empty `alt`, no replaced dimensions | Empty inline fallback; icon is `display:none`, no text paints. |
| Missing `alt`, non-empty `src`, no replaced dimensions | Non-replaced icon-only fallback. |
| Replaced dimensions/aspect ratio with missing or empty `alt` in standards mode | A fixed flow-root container with `overflow:hidden`, `pointer-events:none`, and the host width/height/max constraints. |
| Replaced fallback smaller than 18 px on either fixed axis | The icon is hidden and the UA border/padding are omitted. |
| Replaced fallback at least 18 px on both fixed axes | The container gets a solid silver border of `int(effectiveZoom)` layout units and padding of `effectiveZoom`, with `border-box` sizing. The 16 px icon paints inside and is clipped by the flow-root. |
| Quirks mode with intrinsic dimensions | The replaced branch applies even with non-empty alt text; a sole dimension is mirrored before the test. |

`ImageRepresentsNothing()` and `ImageSmallerThanAltImage()` are the exact
empty-state and 18 px predicates (`html_image_fallback_helper.cc:21-48`). The
container's replaced style, border, padding, and baseline rules are at lines
73-149. The icon is `display:inline` when inlinified or otherwise a flow-root
floated left for LTR and right for RTL; hidden states use `display:none`
(`html_image_fallback_helper.cc:151-211`).

### 3. The icon is already a raster resource

The fallback child calls `LayoutImageResource::UseBrokenImage()`
(`layout_image_resource.cc:193-198`). `BrokenImage()` chooses one of two
bundled resources solely from document DPR: the default resource below DPR 2,
and the 200% resource at DPR 2 or above
(`layout_image_resource.cc:172-185`). The GRIT manifest maps
`IDR_BROKENIMAGE` to `blink/broken_image.png` and packages 100% and 200%
variants (`third_party/blink/public/blink_image_resources.grd:4-14`). There is
no platform-theme or dark-scheme variant in that manifest.

At the pinned revision the source files are:

| Resource | Encoded size | SHA-256 |
| --- | ---: | --- |
| `default_100_percent/blink/broken_image.png` | 14×16 RGBA | `efcb5c77b9b97421b60982637d0a3d1e352b0275f294be3c62173743b3f0d8ee` |
| `default_200_percent/blink/broken_image.png` | 28×32 RGBA | `072fb1710ffa7096a8ef3842ac168b1e774d8879054eedad39bc947306389c2d` |

The 14×16 source contains a shaded page, folded corner, blue fill, and green
mountain—not a gray stroked SVG rectangle. The UA child still has a 16×16 CSS
box. `ImagePainter` pixel-snaps its destination and hands the decoded image to
`GraphicsContext::DrawImage` (`image_painter.cc:213-255,295-301`). Skia's
pinned `SkCanvas::drawImageRect()` validates source/destination rectangles and
hands the image and sampling options to the device
(`src/core/SkCanvas.cpp:2271-2368,2398-2412`). The bitmap bytes and their
device-pixel sampling therefore form a real raster boundary.

### 4. Alternative text is ordinary shaped text

The alternative text is a real `Text` child, not a special icon-painter label.
It inherits the host's font, color, direction, writing mode, line height, and
text behavior. Normal inline collection constructs a `HarfBuzzShaper` and
shapes the selected `Font` (`inline_node.cc:149-179,298-320,1716-1725`).
HarfBuzz builds a cached plan from face, buffer properties, features, and
variation coordinates, then executes that plan (`hb-shape.cc:127-169`). Blink
paints the resulting shape at the fragment text origin through
`GraphicsContext::DrawText` (`text_painter.cc:373-404`).

Consequently, the text's face, glyphs, advance, bidi order, vertical
orientation, and baseline belong to the normal text pipeline. Rasterizing the
whole fallback would be faithful at one scale but would unnecessarily discard
Domotion's crisp/path-based text contract. Computing a baseline from the icon
height is equally wrong. Existing selected-glyph raster boundaries still apply
inside that text (for example, a color emoji); the broken-image mechanism does
not turn the otherwise-representable text run into a whole-surface raster.

## Fresh browser evidence

### UA-shadow geometry

CDP `DOM.getDocument({pierce:true})`, `DOM.getBoxModel`, and
`CSS.getComputedStyleForNode` exposed the UA-shadow descendants in Chromium
147. Selected DPR-1 rows were:

| Case | Host rect | Container facts | Icon/text facts |
| --- | --- | --- | --- |
| Auto-size `alt="Auto alternative"` | 141.078×21 | inline, no border/padding | icon 16×16 at inline-start; text rect 127×20 |
| CSS 160×44 plus non-empty alt | 178.109×21 | inline, no border/padding | author dimensions were cleared; icon + full text sized the host |
| CSS 160×44, missing alt | 160×44 | flow-root, hidden overflow, 1 px silver border + 1 px padding | icon starts at host + (2,2) |
| Auto-size `alt=""` | 0×0 | inline | icon `display:none`, no text |
| 17×17, empty alt | 17×17 | flow-root, no border/padding | icon `display:none` |
| 18×18, empty alt | 18×18 | flow-root, 1 px border + 1 px padding | 16×16 icon starts at +2,+2 and its far 2 px are clipped |
| Missing alt, `title="Title fallback"` | 115.375×21 | inline | title becomes visible fallback text; current capture loses it |
| RTL Arabic alt | 78.672×21 | inline | text occupies physical left; icon floats right at x=82.672 |
| `writing-mode:vertical-rl`, 72×180 | 72×180 | vertical inline content | icon is at physical top-right; text rect is 20×90 below it |
| `zoom:1.5` | 123.063×31 | inline | the nominal 16 px child paints in a 24×24 physical rect; text is 99.063×30 |
| Author 3 px border and asymmetric padding | 169.094×39 | inline fallback inside the author box | icon x is host + 3 px border + 13 px left padding, not host + 1 |

The fixed current helper fails each discriminator without a pixel comparison.

### Exact hidden-text facts are capturable

`DOM.resolveNode` successfully resolved the closed-UA-shadow text Node.
`Runtime.callFunctionOn` could create DOM Ranges for it and run the existing
canvas metric procedure. For `A😀ב alternative` in
`italic 700 20px/28px Georgia, serif`, Chromium reported:

- `fontBoundingBoxAscent=18`, `fontBoundingBoxDescent=4`;
- text Range top `y=23`, height `22`;
- the two UTF-16 units of U+1F600 shared the same x/width rect; and
- subsequent ranges retained their fractional advances.

This proves a source-owned vector capture is available. The implementation
must iterate code points/grapheme clusters while preserving UTF-16 indices;
blindly emitting one advance per code unit would double-count astral glyphs.

### DPR and color scheme

Independent icon crops from the live browser produced:

| DPR | Scheme | Crop pixels | RGB SHA-256 |
| ---: | --- | ---: | --- |
| 1 | light | 16×16 | `70f7946a75877ea608eed61421960e143568e89f59f0d800eb43b705038be378` |
| 1 | dark | 16×16 | `70f7946a75877ea608eed61421960e143568e89f59f0d800eb43b705038be378` |
| 2 | light | 32×32 | `114c8029ca6a8c4d258c4cad635d857193a6051bdad005212925e699f91468a7` |
| 2 | dark | 32×32 | `114c8029ca6a8c4d258c4cad635d857193a6051bdad005212925e699f91468a7` |

Ordinary light/dark color-scheme selection does not change the icon; DPR does.
Forced auto-dark processing remains a separate image-paint effect and should
be tested only when that browser mode is explicitly enabled.

### Accessibility is independent of visible pixels

Playwright accessibility snapshots reported:

| Markup | Snapshot |
| --- | --- |
| Broken image with `alt="Alternative name"` | `img "Alternative name"` |
| Missing alt with `title="Title name"` | `img "Title name"` |
| `alt=""` (auto or sized) | ignored/empty snapshot |
| Missing alt and title | unnamed `img` |

The visible text and the SVG accessible name should share a resolved source
string, but one cannot stand in for the other. A decorative empty-alt image
must remain ignored even when explicit dimensions make its fallback container
visible.

### All-platform evidence

Chromium carries separate macOS, Linux, and Windows expected PNGs for both
`rendering-broken-images.html` and
`rendering-broken-images-empty-alt.html`. Those source fixtures cross both/one/no
dimensions, non-empty/missing/empty alt, and missing/empty/valueless/broken src.
The pinned 800×600 expected images have distinct raw-RGBA fingerprints:

| Fixture | macOS | Linux | Windows |
| --- | --- | --- | --- |
| broken images | `8c6af157b3607241dfe446979c64c43276f4f06215e329a45a5321ca9cc2f8a7` | `5052e9a3f8ed49fbc550a06b3d168edff58b002427e97e76c45547d3ced7d07f` | `66fb48a4510f051b90b3f34bf00621f8680dbc219f06ef4646720cef170f165c` |
| empty alt | `92ba6bf676d4ba57049b551abc88c321d3ff2e2f1a09c8948e845228ea5fcb12` | `1093301940a05eae600495652ff95a02f7522ceed9d36f1d8d54f025b303025c` | `422ab8f39f767f9d5018560b7912eb60dd6d1c505a455c12e86e8c93f2f51316` |

These are hashes of decoded RGBA bytes, not PNG file bytes, so metadata alone
cannot explain the platform differences.

The icon's GRIT resource is shared, so these complete-surface differences are
not permission to invent platform icon geometry. They demonstrate that the
alternative text face/metrics and final rasterization remain platform-owned.
macOS, Linux, and Windows must each produce native browser evidence rather than
sharing a macOS baseline.

## Required ownership boundary

| State/paint | Owner | Required Domotion representation |
| --- | --- | --- |
| Load/error/collapse/fallback disposition | Live Chromium DOM/layout | Structured capture fact from the actual UA-shadow state; no `complete && naturalWidth===0` inference as the sole authority. |
| Author host background, border, padding, outline, shadow, transform, stacking | Existing DOM capture/render | Native SVG vectors. |
| UA container geometry, silver border, effective-zoom padding, overflow clip | Blink fallback layout, observed through CDP | Captured physical facts emitted as SVG vectors/clip. Do not recreate layout from the host rect. |
| Broken-image icon | Chromium GRIT bitmap selected by DPR and Skia image paint | Minimal raster `<image>` at the captured icon rect, preserving the live browser's DPR pixels. Never approximate it as vector geometry. |
| Alternative text | Ordinary Blink inline/HarfBuzz text | The normal Domotion shaped vector-text path using captured hidden-node ranges, font/style, baseline metrics, direction, and writing mode. |
| Accessibility name/ignored state | HTML/AX semantics | SVG semantic metadata independent from visible text paint. Empty alt stays decorative; title fallback and unnamed image remain distinguishable. |
| Exact-fact acquisition failure | Capture boundary | Explicit warning and classified terminal raster fallback. Never silently reinstate the fixed mountain/baseline heuristic. |

This is a **hybrid**, not a whole-element raster boundary. Only the source
bitmap icon is intrinsically raster. A terminal snapshot is acceptable as a
failure mode because it preserves the captured frame; it must be observable
and separately gated because it sacrifices scalable text.

## Implementation sequence and proof

The work is split so capture facts cannot be fixture-fit inside the renderer:

1. **DM-2463 — capture fallback state and UA-shadow geometry (shipped).**
   `src/capture/broken-image-fallback.ts` adds the CDP post-pass, explicit
   state record, resolved alternative text, shaped text/font facts,
   accessibility facts, and fail-closed warning. Focused unit and live-browser
   tests cover standards/quirks, sizing/source states, DPR 1/2, threshold,
   direction/writing mode, zoom, title/empty/missing alt, and pipeline cleanup.
2. **DM-2464 — render the hybrid fallback (shipped).** The gray mountain and
   raw `<text>` are gone. Captured container/clip geometry and shaped text stay
   vector, while a reversible transparent-isolation pass stamps only the exact
   live DPR icon crop. Unit activation tests and a DPR-1/2 browser render/AX
   matrix cover LTR/RTL/vertical, title/empty/missing alt, 17/18 px, zoom,
   author paint, clipping, successful images, and hidden icons.
3. **DM-2465 — gate geometry and raster ownership on every platform.** Extend
   the replaced-geometry and raster-boundary oracles, then add focused visual
   fixtures and macOS/Linux/Windows reports.

The independent controls must include successful and still-loading images;
collapsed failures; src missing/empty/valueless/broken; alt
missing/empty/text/title; zero, one, both, aspect-ratio, 17 px, and 18 px
dimensions; standards/quirks; author borders/padding/background; long clipped
text; mixed fallback and astral characters; LTR/RTL; horizontal/vertical
writing; zoom; DPR 1/2; light/dark scheme; and load → error → success plus alt
mutations. The raster boundary gate must assert that the icon activates an
image payload while the alternative text still reaches the ordinary text
emitter.
