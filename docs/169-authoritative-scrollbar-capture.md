# Authoritative Blink scrollbar capture

**Ticket:** DM-2481
**Status:** capture protocol implemented; dependent custom/native paint remains
DM-2482/DM-2483

This change replaces Domotion's `scrollWidth/clientWidth` plus positive-offset
scrollbar guess with a live Chromium ownership record. The renderer no longer
emits the legacy host-independent 7 px macOS-shaped pill. Scrollbar paint now
fails closed until the custom-vector and stock-native raster consumers land.

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
background, track, track pieces, buttons, thumb, and corner. For a stock or
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
radius, padding, shadow, and filter from Chromium. It does not scan stylesheet
source order.

Chromium's stable DOM/CSS agents do not expose the anonymous horizontal/
vertical or start/end scrollbar part nodes. A rule whose winner exists only on
`:horizontal`, `:vertical`, `:start`, `:end`, `:decrement`, `:increment`,
`:hover`, or `:active` therefore cannot be returned as a computed style object.
The live marker frame still proves its part rectangle, but the record remains
`partial` with `dynamic-scrollbar-pseudo-cascade`. Likewise, stock overlay
animator opacity, an invisible full frame, native subpart rectangles, overlay
hidden state, and internal paint phase remain named missing facts until
DM-2483 obtains them with the narrow source-frame raster/browser-internal seam.
Non-axis-aligned transforms fail with a named axis-correlation fact instead of
assigning a rotated marker to the wrong source axis. This is the required
explicit unknown path; no CSSOM cascade reconstruction or platform constant
substitutes for it.

## Evidence

The focused unit/browser contract covers connected marker classification,
custom horizontal/vertical/corner geometry, final unqualified pseudo winners,
mid-scroll ranges, RTL negative `scrollLeft`, logical-left placement,
`scrollbar-width:none`, CSS zoom 1.25, DPR 2, forced colors/dark preference,
non-axis transform failure, and the hidden-scrollbar launch negative.

The upgraded 23-row ownership audit completed on macOS arm64 with Headless
Chromium 147:

```text
23/23 PASS
verdict: authoritative-capture-and-dependent-paint-gaps-observed
generated legacy thumbs: 0 in every row
custom records: marker-owned author-custom axes/corner, explicit dynamic-cascade gap
native records: marker-owned visible thumbs, explicit theme/opacity/phase gaps
negative records: width:none and auto/no-overflow absent
```

Commands:

```sh
npm run build:capture-script
npx vitest run src/capture/scrollbar-capture.test.ts src/capture/pseudo-style-cdp.test.ts
npx vitest run --config vitest.e2e.config.ts tests/scrollbar-capture.e2e.test.ts
npm run scrollbars:ownership-audit -- --json /tmp/dm2481-scrollbar-audit.json
```

## Dependent work

- DM-2482 may vector-paint only author parts whose final Chromium style is
  present; a dynamic-only missing winner must warn or use an owner-only raster.
- DM-2483 must materialize stock native frame/corner strips from the same
  compositor frame and fill the animator opacity, platform fingerprint, phase,
  clip, and root-transform facts that stable CDP cannot expose.
- DM-2484 still owns native macOS/Linux/Windows DPR/zoom promotion and the
  final assertion that no legacy synthesis can reappear.
