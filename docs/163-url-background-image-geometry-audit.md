# URL background image geometry audit

**Status:** DM-2477, DM-2478, and DM-2479 implemented; sliced-fragment continuation remains DM-2365

**Ticket:** DM-2370 / DM-2477 / DM-2478 / DM-2479

**Implemented seams:** selected-image/natural-sizing capture, exact Blink tile geometry, cyclic longhand expansion, and exact attachment positioning-area ownership

**Remaining follow-ups:** existing DM-2365 and all-platform gate DM-2480

Domotion turns each CSS `url()` background layer into an SVG
`<pattern><image>`. DM-2477 captures the selected candidate and complete
natural-sizing state before the synchronous tree walk. DM-2479 captures
fixed/local/canvas positioning ownership and selects those inputs before tile
construction. DM-2478 now carries snapped and unsnapped positioning areas
through a source-derived `BackgroundImageGeometry` record and lowers Blink's
destination, phase, spacing, and tile size without the former `parseFloat` or
oversized-pattern approximation. The remaining URL-background defect is
DM-2365's stitched continuation for `box-decoration-break: slice` fragments.

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

The implemented surface includes natural ratio on a single `auto` axis,
calculated size and position, contain/cover rounding, both `space` branches,
round's orthogonal-auto rule, positive and negative no-repeat, effective zoom,
transformed phase, independent origin/clip, and cyclic lists. Fixed,
transformed-fixed, local, and canvas positioning use the independently captured
DM-2479 inputs. Only sliced fragments remain outside the exact tile route.

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

### Tile sizing and phase (resolved by DM-2478)

`src/render/image-pattern.ts` now resolves CSS lengths and all intermediates in
Blink's integer 1/64 CSS-pixel `LayoutUnit` domain. Its pure geometry record
retains unsnapped/snapped positioning areas and destinations, tile size, phase,
spacing, and per-axis repeat mode. It implements natural-ratio fallback,
`calc()`, contain/cover, edge origins, both signs of no-repeat offset, repeat,
round, and both space branches. The emitter consumes that record; it does not
invent a large pattern cell. Unknown decoded-image kind or unavailable natural
facts fail closed with a warning rather than selecting guessed geometry.

### Layer and fragment ownership

`paintBackgroundImageLayers` and the inline/fragment background routes now
select every shorter longhand with `layers[index % layers.length]`, producing
the Blink-required `0,1,0,1` expansion for four images and two values. Origin
selects the positioning box independently from clip's painting box; both are
passed into the pure geometry helper.

DM-2479 moved attachment selection out of this approximation.
`src/capture/script/walker/background-attachment.ts` records the
scrollbar-excluding layout viewport, transform/will-change applicability,
pixel-snapped two-axis local scroll offsets, overflow clip, scroll extent plus
borders, and root stitched canvas box. `src/render/background-attachment.ts`
selects and maps those captured inputs before the existing tile builder runs,
so tile geometry is not transformed twice. Old captures without the record
retain the previous scroll-box fallback.

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
npm run background:url-geometry-audit -- --dpr 1 --json /tmp/url-background-dpr1.json
npm run background:url-geometry-audit -- --dpr 2 --json /tmp/url-background-dpr2.json
npx vitest run --config vitest.e2e.config.ts tests/background-image-geometry.e2e.test.ts
```

The 2026-08-22 run used Playwright 1.59.1, Headless Chromium 147.0.7727.15,
macOS arm64, DPR 1/2, and a 240 by 170 viewport. Each row paints a decoded 32 by
20 SVG image with four solid color regions in live Chromium, runs the real
Domotion capture and renderer, reopens the generated SVG in the same Chromium,
and classifies only marker colors authored by that row. That restriction keeps
bilinear red/blue edge pixels from being misclassified as an unused violet
fixture marker. Text, borders, and the white canvas cannot satisfy the
classifier.

Strict rows require at most 0.5% classified-label mismatch **and** at most one
device pixel of delta in every marker-color ink bound. The external-SVG rows
whose image is sampled at a different boundary (`contain`, `round`, affine)
retain the independent one-device-pixel geometry bound while allowing at most
7% differently filtered edge pixels. That sampling envelope is not used for
ordinary rows and is not a tile-position tolerance. A current-gap row must
still have at least 4% mismatch or two pixels of movement. DM-2480 owns the
all-platform promotion after DM-2365.

| Row | DPR 1 mismatch / bound | DPR 2 mismatch / bound | Route |
| --- | ---: | ---: | --- |
| explicit 32×20 repeat | 0.00% / 0 | 0.00% / 0 | strict |
| intrinsic auto/auto | 0.00% / 0 | 0.00% / 0 | strict |
| auto width from 37 px height | 0.00% / 0 | 0.00% / 0 | strict |
| calculated two-axis size | 0.00% / 0 | 0.00% / 0 | strict |
| contain in fractional area | 3.11% / 1 | 1.06% / 1 | SVG sampling / exact bounds |
| cover + 37%/63% position | 0.00% / 0 | 0.00% / 0 | strict |
| calculated position | 0.00% / 0 | 0.00% / 0 | strict |
| round + orthogonal auto | 6.32% / 1 | 5.22% / 1 | SVG sampling / exact bounds |
| space with multiple tiles | 0.00% / 0 | 0.00% / 0 | strict |
| space single-tile fallback | 0.00% / 0 | 0.00% / 0 | strict |
| content origin + padding clip | 0.00% / 0 | 0.00% / 0 | strict |
| fixed viewport | 0.00% / 0 | 0.00% / 0 | strict |
| fixed under transformed ancestor | 0.00% / 0 | 0.00% / 0 | strict |
| local after x/y scroll | 0.00% / 0 | 0.00% / 0 | strict |
| zoom 1.25 + intrinsic auto | 0.00% / 0 | 0.00% / 0 | strict |
| affine transformed local space | 4.25% / 0 | 2.12% / 0 | SVG sampling / exact bounds |
| four images + two-value lists | 0.00% / 0 | 0.00% / 0 | strict |
| wrapped inline clone | 0.00% / 0 | 0.31% / 0 | strict |
| wrapped inline slice | 100% / missing | 100% / missing | expected DM-2365 gap |
| multicol block clone | 0.00% / 0 | 0.00% / 0 | strict |
| multicol block slice | 100% / missing | 100% / missing | expected DM-2365 gap |

Both runs pass 21/21 rows. The two slice rows pass only by discriminating the
known DM-2365 defect; they are not accepted fidelity. Held-out controls require
all source palettes to decode, every positive row to remain tight, fixed and
transformed-fixed ownership to differ, local x/y facts to equal live scroll,
the cyclic row to emit four image patterns, and both slice gaps to remain
visible. The focused attachment oracle remains byte-exact at DPR 1 and DPR 2.

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

### Geometry record (DM-2478, implemented)

`resolveBlinkBackgroundImageGeometry` transcribes the Blink stages into a pure
helper with named fields rather than returning SVG text directly:

```text
positioningArea { snapped, unsnapped }
tileSize
destination     { snapped, unsnapped }
phase
repeatSpacing
repeatMode      { x, y }
```

The emitter lowers this record to a clipped `<pattern><image>`; no-repeat uses
the exact clipped destination instead of a fake period. Equivalence is defined
by the record and browser oracle, not by forcing every Blink branch through an
oversized SVG cell. Layer longhands expand with `value[layerIndex %
valueCount]`. Origin changes the positioning area; clip changes the painting
area; neither is inferred from the other. SVG images preserve their intrinsic
ratio mapping, while bitmaps use the exact resolved tile extent.

### Attachment positioning (DM-2479, implemented)

Attachment selects geometry inputs before the pure tile calculation. The live
walker stores one `blink-box-background-paint-context-v1` record containing:

- the layout viewport with root scrollbars excluded and capture-viewport origin;
- whether fixed attachment survives the non-root applicable-transform and
  `will-change` walk;
- for local attachment, active scroll-container state, physically snapped x/y
  offsets, border-ended scroll extent, and the scrollbar-aware overflow clip;
- for the visible root/body-propagated canvas owner, the root stitched
  positioning rectangle; and
- physical zoom/scale at the capture boundary, excluding affine transforms
  frozen and later re-applied by the renderer.

The renderer uses that record to choose the positioning and painting boxes,
then invokes ordinary scroll tile construction once. This keeps transforms out
of tile math and preserves old-capture compatibility. Six pure resolver cases
and three live Chromium cases cover fixed/scroll/local/canvas routing, DPR 1/2
pixels, both scroll axes, scroll/page mutation, borders/padding, zoom,
applicable and inert ancestors, perspective, affine mapping, and stitching.

### Fragments (DM-2365)

Existing DM-2365 owns the stitched imaginary box and slice/clone offsets for
wrapped inline and block fragmentation. It should consume the same geometry
helper without creating a second attachment approximation.

### Hard gate (DM-2480)

After DM-2365 lands, convert the two remaining `current-gap` rows to
`source-equivalent` and run the existing DPR 1/2 evidence on all three
platforms. The gate must retain source revisions,
browser/Playwright/platform fingerprints, logical pattern facts, mutation
pairs, and explicit evidence that every expected image decoded. Missing marker
ink, missing pattern ownership, or warnings fail rather than skip.

## Follow-up ordering

- **DM-2477** — implemented: authoritative natural sizing and selected-layer capture.
- **DM-2478** — implemented: exact pure tile geometry, cyclic longhands, and
  SVG lowering in the 1/64 px LayoutUnit domain.
- **DM-2479** — implemented: exact normal/fixed/local/root attachment positioning areas.
- **DM-2365** — existing slice/clone background-image continuation ticket;
  retained instead of filing a duplicate.
- **DM-2480** — all-platform/DPR parity gate; now blocked only by DM-2365.

DM-2477, DM-2478, and DM-2479 remove renderer-side candidate, tile, and
attachment guessing. URL tile geometry is source-derived; only the explicitly
discriminated slice-fragment rows remain partial and are not accepted parity.
