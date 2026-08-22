# URL background image geometry audit

**Status:** DM-2477 capture seam implemented; tile, attachment, and fragment geometry remain partial

**Ticket:** DM-2370

**Implemented seam:** DM-2477 authoritative selected-image/natural-sizing capture

**Remaining follow-ups:** DM-2478, DM-2479, existing DM-2365, and gate DM-2480

Domotion turns each CSS `url()` background layer into one SVG
`<pattern><image>`. That is the right representation boundary, but the numbers
inside the pattern are not all Blink's numbers yet. DM-2477 now captures the
selected candidate and complete natural-sizing state before the synchronous
tree walk. The remaining renderer still projects that state to a width/height
pair and approximates repeat modes with a large pattern cell. Blink carries the
source-selected image plus snapped and unsnapped positioning areas through
`BackgroundImageGeometry`, then gives an explicit destination, phase, spacing,
and scale to Skia.

## Verdict

The source-derived contract has four stages:

1. **Capture the selected CSS image and its complete natural-sizing facts.**
   The facts are not just two positive integers. They include the selected
   `image-set()` candidate and resolution, independently present natural
   dimensions, natural aspect ratio, orientation, effective zoom, and a
   decoded/failure state. Unknown sizing must be explicit; it must not silently
   become the positioning-area dimensions.
2. **Resolve one Blink-equivalent tile geometry record per expanded layer.**
   The record owns unsnapped and snapped positioning/painting rectangles, tile
   size, destination, phase, repeat spacing, source subset/scale, origin and
   clip boxes, and attachment/fragment offsets. Shorter background longhand
   lists repeat cyclically; they do not fall back permanently to item zero.
3. **Keep ordinary URL images on the vector composition path.** A generated
   SVG can represent the resulting destination/clip/pattern matrix exactly.
   Bitmap sources remain bitmap `<image>` payloads and SVG sources may remain
   scalable image payloads, but the surrounding element does not need a
   Chromium screenshot merely because its background tiles.
4. **Treat Skia as the consumer, not the geometry oracle.** Blink has already
   chosen tile size, phase, spacing, subset, destination, and scale before
   Skia creates its image shader. Skia validates the subset/matrix and executes
   clamp/repeat sampling. Reconstructing geometry from a plausible SVG repeat
   cell after the fact is the wrong ownership direction.

The current `approximate center/cover` label is therefore too narrow. Simple
integer explicit-repeat, auto/auto, cover/percentage, integer origin/clip, and
clone-fragment rows are already exact in the focused probe. The unresolved
surface includes natural ratio on a single `auto` axis, calculated sizes and
phase, contain rounding, both `space` branches, round's orthogonal-auto rule,
fixed/local attachment, effective zoom, transformed pattern phase, cyclic
lists, and sliced fragments.

## Current information loss

### Capture (resolved by DM-2477)

Before DM-2477, `computeBackgroundIntrinsic` split the computed image list,
took the first URL inside `image-set()`, constructed a new `Image`, and read
`naturalWidth`/`naturalHeight` synchronously. Its `{w,h}` or `null` result lost:

- which candidate Blink selected for the current device scale and supported
  type;
- candidate resolution and density-corrected natural size;
- natural ratio when one or both natural dimensions are absent;
- image orientation and effective zoom;
- delayed decode versus permanent failure; and
- any independent dimension-presence state.

`src/capture/background-image-sizing.ts` now performs an async live-frame
prepass. It preserves one slot per computed image layer, transcribes pinned
Blink MIME filtering/stable density selection at the session DPR, awaits the
chosen resource, records independent natural dimensions/ratio, orientation,
effective zoom, candidate resolution/type, and load state, then removes its
temporary DOM markers after capture. Gradients remain `null` slots, so shorter
background longhands can later expand without re-indexing URL layers.

The synchronous walker serializes that record and derives `backgroundIntrinsic`
only as a compatibility projection. The renderer consumes the captured URL for
`image-set()` and no longer guesses the lowest-density candidate. Failed,
timed-out, unsupported, or unreadable resources warn and remain explicitly
unavailable. A readable SVG root supplies independently present absolute
`width`/`height` and its dimensions-or-`viewBox` ratio. A CORS-opaque resource
whose actual bitmap-versus-SVG response kind cannot be observed retains loaded
bytes but explicitly lacks representable dimension-presence facts; URL suffixes
and `type()` descriptors are not substituted for Blink's decoded-image kind.

### Tile sizing and phase

`src/render/image-pattern.ts:46-82` resolves size with `parseFloat`, direct
percent multiplication, and a two-number intrinsic record. In particular,
`auto <length>` retains the raw intrinsic width instead of deriving it from the
specified height and natural ratio; general calculated lengths are not
represented; `contain` and `cover` do not distinguish snapped from unsnapped
positioning areas; and effective zoom is not part of natural sizing.

The same file's position/repeat code (`84-240`) translates selected computed
syntax into one pattern origin and period. It does not model Blink's separate
destination rectangle, unsnapped subset, phase, and spacing. `no-repeat` is
simulated with a cell twice the area, single-tile `space` with another large
period, and `round` never recomputes an orthogonal `auto` dimension. These are
observable paint differences, not equivalent encodings.

### Layer, attachment, and fragment ownership

`paintBackgroundImageLayers` at
`src/render/element-tree-to-svg.ts:2106-2175` selects a missing per-layer value
as `layers[0]`; a four-layer image with two positions/sizes should use values
`0,1,0,1`. Its box reconstruction subtracts captured border and padding widths
from a viewport rectangle but does not retain Blink's snapped/unsnapped box
pair.

For `local`, lines `2155-2170` enlarge the width/height to the scroll extent but
do not subtract the actual scroll position or reproduce the overflow clip and
border-ended paint rectangle. For `fixed`, `buildImagePatternDef` uses capture
viewport `(0,0)` whenever the computed token is `fixed`; it does not apply
Blink's transformed-ancestor rule or map the viewport origin into local paint
space.

Finally, `paintInlineFragment` at
`src/render/element-tree-to-svg.ts:3628-3653` deliberately emits URL background
images only for `box-decoration-break: clone`. Slice continuation is already
tracked by DM-2365 and should reuse the exact geometry record rather than gain
a second approximation.

## Pinned source decision

This audit used Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and Skia
`62efacd37737505732dbe3d8daa62abd679626a1`, the revision named at
`external/chromium/DEPS:330`. The standalone Skia checkout was newer and was
not used as authority.

### Image-set selection and density

`css_image_set_value.cc:46-105` filters unsupported types, sorts and de-duplicates
computed resolutions, selects the first supported option whose resolution is
at least the session device-scale factor, and falls back to the largest option.
The cache is keyed by that factor (`107-122`), so a renderer-side hard-coded
DPR 1 choice is not equivalent.

`style_image_set.cc:34-38,71-112` retains the selected `best_fit_image_` and
delegates render/load/error, natural sizing, concrete size, and intrinsic-size
queries to it. `style_fetched_image.cc:80-89,131-138` also incorporates an
override image resolution or the resource DPR header. These are source-owned
inputs to `BackgroundImageGeometry`, not information recoverable from the
computed `image-set(...)` string by choosing its first or lowest-density URL.

### Natural sizing and tile size

`background_image_geometry.cc:406-424` calls
`StyleImage::GetNaturalSizingInfo(style.EffectiveZoom(),
style.ImageOrientation())`. It intentionally chooses the unsnapped positioning
area for an image with intrinsic dimensions and the snapped area for an image
without them.

For explicit, percentage, and calculated sizes, lines `426-444` use Blink
`Length` resolution. Lines `446-480` then resolve an `auto` dimension from the
natural aspect ratio, then the corresponding natural dimension, then 100%; two
auto dimensions go through `ImageSize` with effective zoom and orientation.

Contain/cover is a distinct branch at lines `485-515`. Both use the snapped
positioning area. Contain rounds the dependent dimension to an integer CSS
pixel to avoid edge bleed, while cover retains `LayoutUnit` precision and
clamps non-empty dependent axes to at least one unit.

### Position, destination, and repeat

Positions are resolved against **available space** (`positioning area - tile`)
at `background_image_geometry.cc:63-86`. Right/bottom edge origins are
converted before the fragment/background offset is subtracted.

No-repeat is not a large repeating pattern. Lines `101-177` move and shrink the
destination for positive offsets, or retain the destination and shift the
phase/source subset for negative offsets. Repeat retains unsnapped phase to
survive zoom and large coordinates (`179-193`). Space starts a full tile at the
paint-area edge (`195-207`).

`CalculateRepeatAndPosition` at lines `525-643` keeps snapped and unsnapped
available sizes simultaneously. `round` computes an integer tile count against
the snapped area and, when the other background-size axis is `auto`, recomputes
that axis from the new aspect ratio (`547-587`). `space` computes snapped
inter-tile spacing and falls back to the complete no-repeat path when fewer
than two tiles fit (`596-643`). Position uses pre-adjustment available space;
the resulting phase uses the adjusted tile.

`Calculate` at lines `654-756` selects normal versus fixed positioning areas,
applies origin/clip adjustments, calculates size and repeat, incorporates the
fragment offset, applies a fixed-destination phase adjustment, intersects the
painting rect, and only then re-snaps the final destination.

### Cyclic layer expansion

`fill_layer.cc:209-340` fills every unset position, attachment, clip, origin,
repeat, and size by walking the authored prefix as a pattern and resetting to
the first layer when the pattern ends. This is the authoritative `0,1,0,1`
behavior in the four-image/two-value control. The current `layers[index] ??
layers[0]` lookup produces `0,1,0,0` and cannot be retained.

### Attachment and fragmentation

`box_background_paint_context.cc:134-173` gives a fragmented box its stitched
size and offset. Slice stores the offset so later fragments continue through
one imaginary box; clone leaves the offset reset for every fragment.

Normal and fixed positioning areas are separate at
`box_background_paint_context.cc:300-389`. A non-root fixed background affected
by an applicable transform or `will-change` transform is treated as scroll
(`342-363`). A true fixed background uses the layout viewport excluding
scrollbars and maps its origin into current local paint space (`366-389`).

For local attachment, `box_model_object_painter.cc:35-53` and
`box_fragment_painter.cc:2321-2343` first clip to overflow, subtract the actual
pixel-snapped scroll offset, then expand the paint rectangle to the scroll
extent plus borders.

### Blink-to-Skia handoff

`box_painter_base.cc:796-889` selects the snapped destination but retains an
unsnapped subset size for intrinsic images. It hands phase, spacing, and scale
to `GraphicsContext::DrawImageTiled`. `platform/graphics/image.cc:245-330`
turns those facts into a local matrix and chooses clamp versus repeat per axis.

Pinned Skia's `src/shaders/SkImageShader.cpp:293-345` validates the image,
subset, sampling, tile modes, and local matrix. Its raster pipeline appends
`repeat_x`/`repeat_y` only for axes Blink selected as repeat (`549-578`). No
Skia branch reconstructs CSS background size, position, origin, attachment, or
fragment semantics.

## Fresh browser evidence

Run:

```sh
npm run background:url-geometry-audit -- --json /tmp/url-background-geometry-audit.json
```

The 2026-08-22 run used Playwright 1.59.1, Headless Chromium 147.0.7727.15,
macOS arm64, DPR 1, and a 240 by 170 viewport. Each row paints a decoded 32 by
20 SVG image with four solid color regions in live Chromium, runs the real
Domotion capture and renderer, reopens the generated SVG in the same Chromium,
and classifies only pixels near the eight known marker colors. Text, borders,
and the white canvas cannot satisfy that classifier.

An equivalent row requires at most 0.5% classified-label mismatch **and** at
most one device pixel of delta in every marker-color ink bound. A current-gap
row must have at least 4% classified-label mismatch or at least two device
pixels of bound movement. The bounds condition remains independent of area,
so a large canvas cannot dilute a translated edge. The probe exits zero only
when all positive controls stay tight and every expected current gap is still
discriminated. This is observational evidence, not a release gate; DM-2480 owns
promotion and makes any warning a failure after implementation.

| Row | Expected route | Label mismatch | Maximum color-bound delta |
| --- | --- | ---: | ---: |
| explicit 32×20 repeat | equivalent | 0.00% | 0 px |
| intrinsic auto/auto | equivalent | 0.00% | 0 px |
| auto width from 37 px height | current gap | 69.16% | 14 px |
| calculated two-axis size | current gap | 100.00% | missing marker |
| contain in fractional area | current gap | 4.41% | 2 px |
| cover + 37%/63% position | equivalent | 0.00% | 0 px |
| calculated position | current gap | 6.56% | 1 px |
| round + orthogonal auto | current gap | 22.18% | 2 px |
| space with multiple tiles | current gap | 4.17% | 1 px |
| space single-tile fallback | current gap | 22.22% | 6 px |
| content origin + padding clip | equivalent | 0.00% | 0 px |
| fixed viewport | current gap | 8.13% | 1 px |
| fixed under transformed ancestor | current gap | 85.75% | 29 px |
| local after x/y scroll | current gap | 93.94% | 11 px |
| zoom 1.25 + intrinsic auto | current gap | 78.15% | 5 px |
| affine transformed local space | current gap | 4.56% | 0 px |
| four images + two-value lists | current gap | 7.35% | 1 px |
| wrapped inline clone | equivalent | 0.00% | 0 px |
| wrapped inline slice | current gap | 100.00% | missing marker |
| multicol block clone | equivalent | 0.00% | 0 px |
| multicol block slice | current gap | 100.00% | missing marker |

The held-out controls matter. Explicit repeat proves the URL decode, capture,
pattern emission, re-embed, and color classifier are live. Auto/auto proves the
natural-dimension path can work when both dimensions are available. Cover
proves a percentage-position row can be exact rather than all percentages
being labeled unsupported. The independent origin/clip row proves those boxes
are not intrinsically unrepresentable. Clone versus slice proves fragment
activation, not missing inline paint in both variants. Fixed under transform
moves much farther than ordinary fixed, proving the transformed-ancestor rule
is separately discriminated.

## Exact representation design

### Capture record (DM-2477, implemented)

For each CSS image layer, capture an immutable record after source selection
and decode:

- resolved source/candidate identity and resolution;
- decoded state and explicit failure reason;
- natural width present/value, natural height present/value, and natural ratio;
- image orientation and effective zoom used for sizing; and
- the layer index before cyclic longhand expansion.

The async prepass finishes before the synchronous tree walk reads the record.
A failed or still-unknown asset warns and uses an explicit unavailable state;
it is not indistinguishable from a dimensionless image. Focused pure tests cover
CSS layer/token parsing, MIME filtering, stable density de-duplication, and DPR
selection. Six live-Chromium cases cover PNG/JPEG/SVG (including ratio-only and
one-dimension SVG), 1x/2x/3x at DPR 1/2, effective zoom, EXIF orientation,
delayed decode, failure, multilayer slot alignment, mutation, cleanup, and the
renderer consuming the selected candidate.

### Geometry record (DM-2478)

Transcribe the Blink stages into a pure helper with named fields, rather than
returning SVG text directly:

```text
positioningArea { snapped, unsnapped }
paintingArea    { snapped, unsnapped }
tileSize
destination     { snapped, unsnapped }
phase
repeatSpacing
sourceSubset
imageScale
```

The emitter may lower this record to one clipped `<pattern><image>` or a
single positioned `<image>` for no-repeat. Equivalence is defined by the
record and browser oracle, not by forcing every Blink branch through the same
SVG period trick. Layer longhands expand with `value[layerIndex %
valueCount]`. Origin changes the positioning area; clip changes the painting
area; neither is inferred from the other.

### Attachment and fragments (DM-2479 / DM-2365)

Attachment and fragmentation select the geometry inputs before the pure tile
calculation. Capture/renderer must retain fixed-viewport applicability and
local scroll facts rather than derive them from a computed token. DM-2479 owns
normal/fixed/local/root positioning spaces and transform mapping. Existing
DM-2365 owns the stitched imaginary box and slice/clone offsets for wrapped
inline and block fragmentation. Both consume the same geometry helper.

### Hard gate (DM-2480)

After the three implementation seams and DM-2365 land, convert every
`current-gap` row to `source-equivalent`, add DPR 2 and all three platforms,
and keep the one-device-pixel bound. The gate must retain source revisions,
browser/Playwright/platform fingerprints, logical pattern facts, mutation
pairs, and explicit evidence that every expected image decoded. Missing marker
ink, missing pattern ownership, or warnings fail rather than skip.

## Follow-up ordering

- **DM-2477** — implemented: authoritative natural sizing and selected-layer capture.
- **DM-2478** — exact pure tile geometry and SVG lowering; blocked by DM-2477.
- **DM-2479** — exact normal/fixed/local/root attachment positioning areas.
- **DM-2365** — existing slice/clone background-image continuation ticket;
  retained instead of filing a duplicate.
- **DM-2480** — all-platform/DPR parity gate; blocked by all four implementation
  tickets above.

DM-2477 changes production capture and removes renderer-side candidate guessing.
Until the remaining tickets land, URL background tile/attachment/fragment
geometry remains partial and the observational probe's expected-gap routes are
not accepted parity.
