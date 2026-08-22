# Authoritative Blink scrollbar capture

**Tickets:** DM-2481, DM-2482, DM-2483
**Status:** authoritative capture, author-custom vector paint, and same-frame
platform-native strip paint implemented

This change replaces Domotion's `scrollWidth/clientWidth` plus positive-offset
scrollbar guess with a live Chromium ownership record. The renderer no longer
emits the legacy host-independent 7 px macOS-shaped pill. Author-custom paint
now consumes the captured parts; stock-native paint stays on its separate
platform-raster route.

The source authority is pinned Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `paint_layer_scrollable_area.cc:1488-1528,1732-1848,2148-2180` owns object
  existence, physical frames, logical-left placement, and pixel snapping;
- `scrollbar.cc:757-770,930-990` owns overlay classification, used standard
  width/colors, scheme, ranges, and object opacity/state;
- `custom_scrollbar.cc:137-214,290-423` owns final pseudo instances and custom
  part layout; and
- `scrollable_area_painter.cc:176-260` owns background/foreground/
  overlay-overflow-controls phase, `OverflowControlsClip`, root viewport
  transform, horizontal-before-vertical-before-corner-before-resizer order.

## Capture boundary

`src/capture/scrollbar-capture.ts` performs a color-only measurement pass on
the same live page. It never installs width, height, display, margin, overflow,
direction, writing-mode, zoom, transform, or clipping declarations.

Blink maps `visible` root overflow to used `auto` on the viewport, but does not
repaint an already-built viewport scrollbar when only a root pseudo rule is
inserted. For that root-only case, capture synchronously flips each visible
overflow longhand to the equivalent used `auto`, forces invalidation, and
restores the original inline declaration before the measured animation frame.
No measurement is taken while the temporary declaration is present.

For an author WebKit scrollbar, reserved colors repaint the already-created
background, track, track pieces, buttons, thumb, and corner. The topmost parts
are measured together, then the lower scrollbar background and track each get
an isolated paint-only marker pass; this prevents a thumb or track piece from
occluding the lower owner's rectangle without changing layout. For a stock or
standard scrollbar, the pass changes only standard `scrollbar-color`, which
keeps Blink on the native `ScrollbarTheme` route. Chromium paints one frame;
the pass subtracts a just-prior unmarked frame, classifies connected changed
device-pixel marker components inside the source owner, normalizes them to CSS
capture coordinates exactly once, restores the page, and attaches the result
as a private expando for the ordinary capture walk.

The resulting `CapturedScrollbarSet` stores:

- explicit `captured`, `partial`, `absent`, or `unavailable` status;
- actual horizontal/vertical marker-owned objects, author/native route,
  logical side, pixel-snapped frame/part/corner rectangles, raw RTL-negative
  offset, visible/total ranges, enabled state, used width/colors/scheme, zoom,
  DPR, and forced-colors state;
- capture-viewport coordinates plus an identity output transform, preventing a
  later raster consumer from applying the element transform twice;
- background paint phase for non-overlay/custom controls, the measured
  ancestor clip when it is axis-aligned, and corner/resizer overlap with the
  pinned corner-before-resizer paint order; and
- named `missingFacts`. A partial/unavailable record emits a
  `scrollbar-capture` warning and cannot reactivate legacy synthesis.

`scrollbar-width:none` and auto-without-overflow produce explicit `absent`
records. `overflow:visible/hidden/clip` never produces a scrollbar candidate.
Playwright's default `--hide-scrollbars` produces an explicit unavailable
negative for a ranged scroller instead of being mistaken for evidence about
normal platform paint.

## Chromium protocol limit

CDP exposes matched unqualified `::-webkit-scrollbar*` pseudos on the scroll
host. `src/capture/pseudo-style-cdp.ts` now obtains their final computed
display/visibility/opacity, size constraints, margins, background, border,
radius, padding, shadow, and filter from Chromium. Stylesheet text is inspected
only to detect selectors whose anonymous dynamic instance cannot be queried;
it is never used to replay source order, specificity, or cascade winners.

Chromium's stable DOM/CSS agents do not expose the anonymous horizontal/
vertical or start/end scrollbar part nodes. A rule whose winner exists only on
`:horizontal`, `:vertical`, `:start`, `:end`, `:decrement`, `:increment`,
`:hover`, or `:active` therefore cannot be returned as a computed style object.
The live marker frame still proves its part rectangle. DM-2482 retains the
corresponding pre-marker source-frame pixels as a crop bounded to that owning
part, with `dynamic-author-part` provenance; it does not guess a CSSOM winner.
Unsupported author filters and CSS image functions take the same narrow route
with `unsupported-author-part` provenance, while the remaining supported
parts stay vector. Stock paint crosses the source-frame boundary described
below; no native theme or animator value is synthesized.
Non-axis-aligned transforms fail with a named axis-correlation fact instead of
assigning a rotated marker to the wrong source axis. This is the required
explicit unknown path; no CSSOM cascade reconstruction or platform constant
substitutes for it.

## Platform-native source-frame strips

DM-2483 captures one unmodified Chromium compositor frame before marker paint.
Classic horizontal and vertical frames use Blink-owned marker/layout geometry;
the physical overlap of both frames owns the native corner. Overlay controls
use a reversible `scrollbar-width:none` discriminator: connected source versus
underlay device pixels supply only the visible ink rectangles, while the
emitted crop always comes from the unmodified source. Restoration may advance
only pixels already proven to belong to the platform animator; any changed
backdrop pixel rejects the frame. Source-equal underlay/restoration proves a
fully faded overlay and records `absent` with `overlay-source-frame-empty`.

`CapturedNativeScrollbarRaster` records the outward-snapped CSS crop, exact
pixel dimensions and DPR, source/crop SHA-256, interaction state, scheme/color
facts through its parent bar, and a platform fingerprint containing OS,
architecture, Chromium/Playwright revisions and launch arguments. The bitmap
is precomposited for overlays, already clipped in capture-viewport coordinates,
and has identity `outputTransform`; render therefore emits it once without a
theme constant, resampling, alpha reconstruction, or element-local geometry.
`src/render/native-scrollbar-raster.ts` preserves horizontal, vertical, corner,
then resizer order. Missing/unstable crops warn and remain fail-closed. Culling
unions exact emitted strip rectangles and retains missing reservations.

## Evidence

The focused unit/browser contract covers connected marker classification,
custom horizontal/vertical/corner geometry, Blink paint order, final
unqualified pseudo winners, dynamic-selector and unsupported-effect owner
crops, uniform and asymmetric vector borders, mid-scroll ranges, RTL negative
`scrollLeft`, logical-left placement, `scrollbar-width:none`, CSS zoom 1.25,
DPR 2, forced colors/dark preference, non-axis transform failure, and
the hidden-scrollbar launch negative. The native oracle additionally compares
each embedded PNG byte-for-byte with the supplied Chromium source crop and the
final generated-SVG strip pixel-for-pixel at DPR 2, while a vector sentinel
outside the crop remains vector.

The upgraded ownership audit completed on macOS arm64 with Headless Chromium
147. Every author-custom route passes the strict generated marker gate:

```text
custom-vector rows: PASS
source/generated marker bounds: <= 1 device px on every part
custom coverage: top/mid/max, x/y, both axes/corner, RTL, vertical writing,
                 clipping, zoom 1.25, DPR 1/2, and no-paint negatives
generated legacy thumbs: 0 in every custom row
```

Commands:

```sh
npm run build:capture-script
npx vitest run src/capture/scrollbar-capture.test.ts src/capture/pseudo-style-cdp.test.ts
npx vitest run --config vitest.e2e.config.ts tests/scrollbar-capture.e2e.test.ts
npm run scrollbars:ownership-audit -- --json /tmp/dm2481-scrollbar-audit.json
```

## Dependent work

- DM-2482 is implemented: `src/render/custom-scrollbar.ts` preserves Blink's
  background, button, track, piece, thumb, axis, corner, and resizer-relative
  order. Supported final styles use the ordinary vector CSS-box painters;
  dynamic-only or unsupported effects retain only their owning part as raster.
- DM-2483 is implemented: stock frames/corners are lossless same-frame crops;
  overlay no-ink is explicit absence and every crop carries its platform and
  source-frame provenance.
- DM-2484 now supplies the strict schema/adjudicator and dispatch-only native
  macOS/Linux/Windows artifact workflow in [doc 173](173-native-scrollbar-release-gate.md).
  Its producer/adjudicator still stays red until fresh macOS, Linux, and Windows
  Cartesian artifacts are collected and reviewed; the legacy synthesis is a
  named mutation blocker.
