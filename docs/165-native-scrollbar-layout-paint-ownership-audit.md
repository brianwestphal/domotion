# Native scrollbar layout and paint ownership audit

**Status:** source audit plus DM-2481 capture implemented; scrollbar paint is
still fail-closed pending DM-2482/DM-2483

**Ticket:** DM-2368

**Implementation follow-ups:** DM-2482 (custom-vector paint), DM-2483
(stock-native raster), and DM-2484 (all-platform gate). See
[doc 169](169-authoritative-scrollbar-capture.md) for the implemented live
marker protocol, explicit stable-CDP unknowns, and removal of the 7 px
synthesis.

Before DM-2481, Domotion emitted one synthetic, macOS-shaped scrollbar thumb
whenever a captured scroll offset was positive. That is not Chromium's
scrollbar model
and cannot become one by tuning the thumb width or alpha. Blink owns scrollbar
existence, layout reservation, physical placement, part geometry, state, and
paint phase. The active platform theme owns stock pixels. Author
`::-webkit-scrollbar*` parts are a different route: Blink lays them out as
anonymous CSS boxes and paints them through `ObjectPainter`, so their supported
CSS paint is vector-representable.

This audit uses Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and Skia
`62efacd37737505732dbe3d8daa62abd679626a1`, the revision named by that
Chromium checkout at `external/chromium/DEPS:330`. The standalone Skia checkout
was newer and was not used as source authority.

## Verdict

The exact boundary is hybrid and source-owned:

1. **Capture structured geometry for every scrollbar route.** Preserve the
   actual horizontal/vertical scrollbar objects, overlay classification, used
   width, frame and part rectangles, logical-side placement, current/visible/
   total ranges, scroll-corner rectangle, opacity/visibility, dynamic state,
   used color scheme, paint phase, overflow-controls clip, and applicable
   transform. Do not recreate those facts from `scrollWidth/clientWidth`.
2. **Keep author scrollbar parts vector when supported.** A custom scrollbar
   is non-overlay in Blink's custom theme. Its scrollbar background, buttons,
   track pieces, thumb, and corner are anonymous style-bearing layout objects.
   Capture Chromium's final pseudo styles and source rectangles, then pass the
   same ordinary background/border/radius/shadow paint machinery used by other
   CSS boxes. An unsupported effect may raster only its owning part.
3. **Freeze stock native chrome as a narrow precomposited raster.** Native
   macOS appearance depends on the OS scroller animator and native theme;
   Aura/Fluent depends on feature flags, the native theme engine, platform
   sizes, color provider, hover/minimal state, and scheme; Windows literally
   sends UXTheme/GDI output through an offscreen bitmap before Skia composites
   it. A capture made on one platform must preserve that platform's live strip
   pixels, including current overlay alpha. A generated 7 px black pill is not
   a portable substitute.
4. **Preserve the vector document around that raster.** Crop only the live
   overflow-control frame rectangles/corner after the page reaches the chosen
   capture frame. The crop is intentionally precomposited when an overlay thumb
   is translucent. Place it in output/viewport coordinates at Blink's recorded
   overflow-control phase and clip, without reapplying the element transform.
   Siblings and scrolled content remain vector.
5. **Absence is a captured state.** A faded overlay scrollbar, `overflow`
   visible/hidden/clip, `scrollbar-width:none`, an `auto` axis without overflow,
   or an invisible/throttled owner emits no chrome. A nonzero `scrollTop` is
   neither necessary nor sufficient for paint.

The capture implementation now fails or warns if the authoritative geometry/
raster record is missing. It does not silently call the former host-independent
synthesis, because that produces confidently wrong pixels and can invent an
indicator which Chromium did not paint.

## Pre-DM-2481 information loss (historical baseline)

The capture/renderer findings below describe the baseline audited by DM-2368.
DM-2481/doc 169 now supplies structured marker-owned records and removes the
7 px fallback; the custom/native paint gaps remain.

### Capture

`src/capture/script/index.ts:334-341` recognizes only an overflowing
`auto`/`scroll` element and emits the legacy SK-468 warning. The captured style
record at `src/capture/script/index.ts:579-596` includes `overflow-x/y`,
`scrollbar-gutter`, scroll/client sizes, and offsets. It does not retain:

- `scrollbar-width`, `scrollbar-color`, the resolved overlay/classic route, or
  the page/theme thickness;
- whether either scrollbar object exists (which differs from overflow);
- the bar frame, track, button, thumb, corner, and resizer-overlap rectangles;
- the used platform/overlay color scheme, animator opacity, hidden state,
  hover/pressed/enabled/minimal mode, or forced-colors result;
- the overflow-controls paint phase, clip, property-tree transform, or
  composited scroll translation;
- final scrollbar pseudo styles and their anonymous part layout; or
- a stock-native strip raster at the capture DPR.

`src/capture/pseudo-style-cdp.ts` already demonstrates the correct
Chromium-resolved direction for control pseudos and `::-webkit-resizer`, but it
does not enumerate `::-webkit-scrollbar*` pseudo nodes. The custom-vector
follow-up should extend that authoritative route instead of scanning author
stylesheets in source order.

### Render

`renderScrollbarChrome` at
`src/render/element-tree-to-svg.ts:5363-5408` hard-codes a 7 px
`rgba(0,0,0,.40)` rounded thumb. It:

- activates only for a positive x/y scroll offset and therefore misses an
  always-present `overflow:scroll` bar, a top-position thumb, and RTL's
  negative horizontal range;
- still activates for `scrollbar-width:none`;
- assumes the vertical bar is on the physical right and horizontal bar on the
  physical bottom;
- uses the whole captured border box as track geometry, ignores borders,
  buttons, corner, resizer, gutter, clipping, zoom snapping, and minimum length;
- cannot represent author track/thumb/corner paint;
- paints the same thumb for overlay/classic, light/dark, standard author
  colors, every platform, every DPR, and every interaction state; and
- places the result after descendants regardless of Blink's background,
  foreground, or overlay-overflow-controls phase.

The comment that Playwright showed no macOS bars at rest was produced under a
critical harness condition: Playwright adds `--hide-scrollbars` by default.
The focused audit explicitly removes that default. A hidden-scrollbar baseline
is a useful negative control, not evidence that a nonzero scroll offset should
activate synthetic chrome.

## Pinned Blink ownership

### Existence and layout reservation

`paint_layer_scrollable_area.cc:830-850` first restricts potential scrollbar
axes to `auto`, `scroll`, and the legacy overlay value. The actual decision at
`1732-1848` is more specific:

- settings/element restrictions, framesets/fieldsets, and used
  `scrollbar-width:none` suppress the objects;
- `scroll` is always-on for a non-overlay/custom bar, hidden/clip/visible is
  off, and `auto` depends on actual overflow;
- a stock platform overlay `scroll` axis is reduced to auto semantics because
  an overlay is shown only for real overflow; a custom scrollbar is not; and
- rooted status and a nonzero visible orthogonal dimension participate.

Layout width is not the painted thumb width. `1596-1642` uses either a custom
part's hypothetical thickness or the page theme thickness when resolving
`scrollbar-gutter`. `1690-1729` gives overlay and `none` zero layout thickness,
and doubles a stable both-edges gutter along the writing-mode block axis.
`1977-2006` separately excludes overlay thickness from layout, clipping, or hit
testing according to the caller. The DOM's `offset-client-border` difference
can observe reservation, but it cannot identify all existence/paint states;
the capture record must obtain the authoritative result.

### Frame, side, corner, and thumb geometry

`paint_layer_scrollable_area.cc:303-350` derives the corner from actual bar
presence and theme thickness. `1488-1528` constructs pixel-snapped horizontal
and vertical frame rectangles from the border box, border widths, opposing bar
or corner, and the logical-left decision. `computed_style.h:2369-2371` makes
that decision physical-left only for horizontal writing with RTL direction.
`2148-2180` assigns those rectangles before custom parts are positioned.

`scrollbar_theme.cc` owns the proportional thumb mapping, not the renderer:
thumb position is the usable track length times current position divided by
`total-visible`, with a positive sub-pixel result promoted to one, and thumb
length is `cc::ScrollUtils::CalculateScrollbarThumbLength` with the theme's
minimum. `SplitTrack` produces back-track, thumb, and forward-track rectangles.
Custom scrollbar buttons and margins further shorten the track.

`scrollbar.cc:80-103` initializes thickness through the current theme and CSS
width. `757-770` distinguishes frame thickness from theme thickness and asks
the theme whether the object is overlay. `930-990` reads the used CSS width,
resolved standard thumb/track colors, opacity, and different overlay versus
non-overlay color-scheme owners. These are live source facts, not values that
can be recovered from a cross-platform constant.

### Paint order, clipping, and compositing

`scrollable_area_painter.cc:176-208` assigns three different phases:

- reordered or self-painting overlay controls use the overlay-overflow phase;
- non-reordered overlay controls on a non-self-painting scroller use foreground;
- non-overlay controls use the background phase.

Lines `212-244` apply `OverflowControlsClip` and the visual-viewport scrollbar
transform for a global root. Lines `246-260` paint horizontal, vertical,
corner, then resizer. The resizer is therefore the final owner when it overlaps
the corner.

At `265-313`, custom bars call `CustomScrollbar::Paint`; native bars take the
native display-item route. `316-355` records a `ScrollbarDisplayItem` and may
associate a scroll translation when the bar is composited. `357-404` paints a
custom corner through its layout object, a native corner through the current
theme, and no opaque corner for overlay bars. Any emitted strip must carry
these phase/clip/transform facts rather than merely be appended to the element
markup.

## Custom scrollbar vector boundary

`custom_scrollbar.cc:60-73` constructs hypothetical thickness from the
`::-webkit-scrollbar` part. Lines `137-164` ask Blink for uncached pseudo style
using the concrete pseudo id and dynamic part state. Lines `173-214` create all
anonymous parts and can force relayout when computed thickness changes.
`290-344` applies authored button lengths and margins; `366-423` positions the
buttons, track pieces, and thumb with the custom minimum.

`layout_custom_scrollbar_part.cc:108-170` resolves fixed/percentage sizes,
display suppression, min/max constraints, and native fallback sizing for each
part. `custom_scrollbar_theme.cc:154-237` paints, in order, scrollbar
background, buttons, track background/pieces, and thumb by handing each
`LayoutCustomScrollbarPart` to ordinary object paint. `CustomScrollbar`
explicitly reports non-overlay ownership.

Therefore supported author background, gradient, border, radius, inset/outset
shadow, and opacity belong in vector SVG. Rasterizing the entire scroller for a
solid author thumb would discard information and create a larger boundary than
Chromium. Conversely, pseudo syntax alone is insufficient: the implementation
must capture Blink's final cascade, dynamic state, layout rectangles, and
source order/phase.

## Stock platform raster boundary

The stock route is deliberately not one reusable vector recipe.

### macOS

`scrollbar_theme_mac.cc:62-94` defines distinct overlay/legacy regular/thin
thicknesses and minimum lengths. `162-229` sends orientation, physical side,
overlay status, hover, scale, and optional author thumb/track colors to the
native theme. The track's opacity comes from the Mac scrollbar animator; zero
means no paint. Lines `263-320` use the animator's track box for thumb geometry
and invoke native theme paint. `385-413` refreshes the OS overlay preference
and invalidates all scrollbars when it changes.

`ui/native_theme/native_theme_mac.mm:80-181` chooses overlay/legacy, dark,
hover, and author-color branches with scaled insets and minimums, and paints
the anti-aliased rounded thumb. Lines `186-327` own legacy track gradients and
borders; `394-413` is the platform scrollbar entry point. Capturing only a
style keyword cannot preserve the animator alpha or current OS preference.

### Aura/Linux and Fluent

`scrollbar_theme_aura.cc:109-150` selects Fluent overlay, generic overlay, or
Aura from runtime features and asks the native engine for thickness; CSS thin
is two thirds of that platform size. `158-204` gets platform button, track, and
minimum-thumb geometry. `268-364` sends every part, state, standard colors, and
used scheme to `WebThemeEngine`.

`scrollbar_theme_overlay.cc:42-120` combines native thumb thickness and margins,
reports overlay ownership, and obtains fade delay/duration from the native
theme. `135-203` handles logical-left offsets, margins, standard colors,
scheme, and state. `scrollbar_theme_fluent.cc:26-125` obtains platform sizes,
insets, animation style, and overlay policy; `143-251` adds centered/minimal
thumb geometry and idle shrink before native paint.

`web_theme_engine_default.cc:191-252` routes sizes, paint, and overlay timing to
`ui::NativeTheme::GetInstanceForWeb`. Aura's native implementation reads
platform sizes/colors and paints either platform nine-patch resources or Skia
primitives. These branches may be reproducible on the same configured host,
but they are not portable facts available to an offline renderer.

### Windows

`ui/native_theme/native_theme_win.cc:147-180` selects the Explorer or classic
Scrollbar UXTheme class. Lines `240-325` map Blink parts and dynamic states to
Windows theme parts/states; `747-805` invokes `DrawThemeBackground`, while the
classic fallback at `871-885` uses GDI.

Most decisively, `970-1037` creates an offscreen platform surface, paints the
theme with the HDC route, repairs alpha in the resulting `SkBitmap`, and calls
`destination_canvas->drawImage`. Lines `1071-1083` obtain the platform
`SM_CXVSCROLL` metric with a 17 DIP fallback. Windows stock chrome is already a
platform-produced bitmap at the Chromium-to-Skia boundary. Rebuilding it as a
macOS-like SVG pill would reverse ownership.

### Pinned Skia

Pinned Skia `src/core/SkCanvas.cpp:1728-1730,2167-2196` sends rounded-rectangle
draws to the active device after culling/effects. Lines `2231-2278` normalize
image paint and sampling before device draw; `2385-2405` lowers `drawImage` to
an image rectangle. Skia is the final raster/composition consumer for both
native primitives and Windows' bitmap. It does not select CSS overflow axes,
logical sides, theme, overlay opacity, or scrollbar state.

## Exact capture record

A follow-up should add one optional record per captured scroll container:

```ts
interface CapturedScrollbarSet {
  horizontal?: CapturedScrollbar;
  vertical?: CapturedScrollbar;
  corner?: CapturedScrollbarPart;
  overlay: boolean;
  paintPhase: "background" | "foreground" | "overlay-overflow-controls";
  overflowControlsClip: CapturedPhysicalClip;
  outputTransform: CapturedPaintTransform;
}

interface CapturedScrollbar {
  orientation: "horizontal" | "vertical";
  route: "author-custom" | "native-raster";
  frameRect: PhysicalRect;
  usedWidth: "auto" | "thin";
  logicalSide: "left" | "right" | "bottom";
  visibleSize: number;
  totalSize: number;
  currentPosition: number;
  enabled: boolean;
  hoveredPart: ScrollbarPart;
  pressedPart: ScrollbarPart;
  hiddenIfOverlay: boolean;
  opacity: number;
  usedColorScheme: "light" | "dark";
  parts: CapturedScrollbarPart[];
  nativeRaster?: CapturedViewportRaster;
}

interface CapturedScrollbarPart {
  kind: "background" | "back-button" | "forward-button" | "track" |
        "back-track" | "forward-track" | "thumb" | "corner";
  rect: PhysicalRect;
  finalPseudoStyle?: CapturedPseudoStyle;
  raster?: CapturedViewportRaster;
}
```

The record is descriptive, not a new layout engine. Browser-internal/CDP facts
or a capture-time measurement/raster probe must produce the same rectangles
that Blink painted. Values unavailable from a stable browser interface should
remain explicit unknowns and choose the narrow raster route, never fall back to
the current estimator.

For native overlay chrome, `nativeRaster` is a device-pixel crop of the visible
frame at the chosen capture frame. Because overlay alpha is already composited
with content, it is emitted as an opaque precomposited output-space image. For
non-overlay stock bars the same narrow crop is safe because descendants do not
paint into the reserved frame. The rectangle, capture DPR, crop bounds, clip,
and output transform are mandatory provenance.

## Fresh browser evidence

Run:

```sh
npm run scrollbars:ownership-audit -- --json /tmp/dm2368-scrollbar-audit.json
```

The 2026-08-22 run used Playwright 1.59.1, Headless Chromium 147.0.7727.15,
macOS 25.5 arm64, a 270 by 205 viewport, and DPR 1/2 controls. The launcher
explicitly removes Playwright's default `--hide-scrollbars`. Every row paints a
text-free uniform scroller. Author rows use four reserved colors—red track,
blue thumb, green corner, yellow button—then run the actual Domotion
capture-to-SVG path and reopen its output in the same Chromium. Classification
accepts only pixels close to those colors. Native rows retain edge color
histograms rather than interpreting one platform's colors as a specification.

The focused evidence includes:

| Control | Live Chromium result at DPR 1 | Current generated SVG |
| --- | --- | --- |
| visible / hidden / clip / auto-no-overflow | no marker chrome | no synthetic thumb (correct negative) |
| width:none at x=51,y=67 | no chrome | two synthetic thumbs (false positive) |
| custom `scroll`, no overflow | 16 px vertical + 14 px horizontal reservation; red disabled tracks and 16×14 green corner; no thumb | no scrollbar paint |
| custom vertical top/mid/max | 16 px gutter; blue thumb y=33/70/109, 12×30, for scrollTop 0/122/250 | none at top; generic 7 px pill after positive offset |
| custom horizontal mid | authored 14 px bar; blue thumb 46×10 at x=92 | generic 7 px pill |
| both axes | red tracks, both blue thumbs, green 16×14 corner | two generic pills, no track/corner |
| RTL horizontal-tb | vertical blue thumb moves from physical x=172 to x=40 | fixed physical-right assumption |
| vertical-rl | both physical bars/corner; negative horizontal offset retained | one axis omitted by positive-offset activation |
| asymmetric border + ancestor clip | marker bounds stay inside the 145×112 clip | generic geometry ignores source part rectangles |
| zoom 1.25 | bar/corner bounds scale once; DPR 2 bounds normalize to within 1 CSS px of DPR 1 | fixed 7 px geometry |
| stock macOS light | overlay: zero layout gutter; 185 right-edge and 318 bottom-edge changed pixels | two synthetic pills |
| stock macOS dark surface | separate scheme/surface fingerprint, still zero layout gutter | same hard-coded color |
| standard thin + blue/red colors | zero layout gutter; 426 blue classified thumb pixels | no standard color ownership |
| stable both-edges, no overflow | overlay platform reserves zero and paints zero on this host | current capture only stores the computed gutter token |

The author both-axis row produced exact 2× device-pixel bounds at DPR 2: its
red track union changed from 148×110 to 296×220, its green corner from 16×14
to 32×28, and the normalized blue union stayed within one CSS pixel. This is a
geometry/DPR control, not a claim that all platforms choose those authored
widths differently—the widths are explicit CSS.

The local platform native row observed macOS overlay chrome with no layout
gutter. Its dominant composited light thumb color was `rgb(118,120,122)`; the
same bar over the dark-scheme/dark surface changed to `rgb(142,144,148)`, and
the standard-color row's dominant thumb was the authored `rgb(25,85,209)`.
Those are capture facts for this host/frame only and must not become constants.

## Existing cross-platform fixtures are corroboration, not proof

The repository contains platform results for `25-deep-scrollbar-style` and
`25-scrollbar-gutter`:

| Platform record | scrollbar-style diff / regions | gutter diff / regions |
| --- | ---: | ---: |
| macOS arm64, commit `ebf0fa7`, 2026-08-02 | 0.0408% / 0 | 0.0457% / 0 |
| Linux, older commit `913be89` | 0.8490% / 0 | 0.6262% / 0 |
| Windows, older commit `913be89` | 0.2848% / 7 (failed) | 0.0057% / 1 |

These broad screenshots mix text/layout and do not state whether their browser
launch retained Playwright's default `--hide-scrollbars`. The apparently clean
macOS expected image has no at-rest scrollbar ink, so it is a blind negative
for stock/custom paint. Linux/Windows metadata also lacks a capture timestamp
and image fingerprint. The numbers demonstrate platform divergence and the
need for isolated native artifacts, but they cannot approve any visual model.

Pinned source supplies the platform evidence that the old fixtures lack:
macOS uses its animator/native scroller, Aura/Fluent uses runtime-selected
native engines and platform metrics, and Windows rasterizes UXTheme/GDI. The
all-platform follow-up must run this focused oracle natively on macOS, Linux,
and Windows at DPR 1 and 2 and persist its launch arguments, browser revision,
OS image, overlay preference, color-scheme, and strip crops.

## Required mutation and release controls

The implementation/gate sequence must retain all of these independent controls:

- `overflow`: visible, auto with/without overflow, scroll with/without
  overflow, hidden, clip, and per-axis combinations;
- suppression/reservation: `scrollbar-width:auto/thin/none` and
  `scrollbar-gutter:auto/stable/stable both-edges`;
- route: stock native, standard width/color, author WebKit parts, an
  author-part unsupported-effect raster, and no-author negative;
- state: top/mid/max, negative RTL scrollLeft, enabled/disabled, hover,
  pressed, overlay newly revealed, overlay fully faded, and no-ink capture;
- geometry: vertical only, horizontal only, both axes/corner, logical-left,
  vertical writing, unequal borders, border radius, ancestor overflow clip,
  nested transform, root visual viewport, and resizer overlap;
- appearance: light/dark surfaces, used overlay scheme, standard
  `scrollbar-color`, forced colors, platform overlay/classic preference, Aura,
  Fluent, macOS legacy/overlay, and Windows themed/classic fallback;
- scale: CSS zoom 1/1.25/2 and DPR 1/2 without double scaling; and
- composition: scrolled vector descendants under overlay chrome and vector
  siblings immediately outside the raster crop remain vector and unchanged.

The strict gate should compare author marker bounds within one device pixel and
native strip pixels exactly or under a reviewed platform-specific raster
envelope. It must also mutate every activation to its nearest negative, assert
that `--hide-scrollbars` causes the expected explicit no-ink state, reject a
missing platform fingerprint, reject any native raster crop outside its
source-owned frame, and reject any emitted legacy 7 px synthesized thumb.

## Dependency order

1. DM-2481 captures authoritative scrollbar existence/geometry/state/phase
   records and removes offset-based activation.
2. DM-2482 extends Chromium-resolved pseudo capture and emits supported custom
   parts as vector CSS boxes; it is blocked by DM-2481.
3. DM-2483 captures and composites narrow stock-native strip/corner rasters
   with exact clip/phase/transform ownership; it is blocked by DM-2481.
4. DM-2484 promotes the observational oracle on all three platforms/DPRs and
   is blocked by all three implementation tickets. It deletes the legacy
   synthesis and SK-468 warning only when every route is explicit.

Until all three implementation seams exist, native scrollbar fidelity remains
partial and source screenshots made with hidden scrollbars must not be counted
as positive paint evidence.
