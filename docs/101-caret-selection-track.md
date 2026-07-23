# 101 — Caret + selection track (declarative, anchored to captured text)

Status: **Shipped** (engine + programmatic wiring + declarative config surface
+ tests). Designed in `docs/100-rich-text-editing.md` ("Primitive 2");
standalone, deliberately NOT gated on the frame-sequence compressor (doc 100,
Primitive 1).

## What it is

A first-class caret / selection renderable for animated SVGs: the author gives
timed events addressing character positions inside a captured element, and the
pipeline emits a blinking caret (bar / block / underscore, docs/97 geometry)
and/or a sweeping selection highlight — anchored to **Chromium's own painted
glyph positions** from the captured tree, with no live-page probe, no fontkit
advance model at authoring time, and no hand-tuned `dy ≈ ascent` constants.

Non-editing uses are first-class: a caret parked in a captured form field
(complementing `typeResample`), a selection sweep highlighting a sentence in a
doc walkthrough, a block caret in a fake terminal.

## Addressing (`src/animation/text-address.ts`)

An address is `{ target, charOffset }` (ranges: `charStart` / `charEnd`),
resolved **node-side against the captured element tree**:

- **Target resolution.** A captured tree has no CSS-selector engine, so
  selector-space resolution happens at CAPTURE time by stamping
  `data-domotion-anim="<id>"` on the matched element — the exact mechanism
  intra-frame animations already use (the CLI tags the live DOM; CAPTURE_SCRIPT
  lifts the attribute into `CapturedElement.animId`). The engine locates the
  element by `animId` (`target.animId`); a `target.match` predicate is the
  programmatic escape hatch for callers holding the tree. This was chosen as
  the least-new-machinery path: zero new capture code, and raw HTML fixtures
  can carry the attribute directly.
- **Text runs.** The element's `textSegments` are concatenated in captured
  order (each segment is one visual line / styled run and carries per-UTF-16
  `xOffsets` — Chromium's painted x, subpixel, viewport-absolute — plus the
  line-box top `y`). Single-line `<input>` captures have no segments; they
  resolve through an input-value synthesis over `text` + `inputXOffsets` +
  `textLeft` / `textTop`, mirroring `renderInputText`'s anchors.
- **Indexing.** Offsets count Unicode **code points** (an astral pair is one
  position). `xOffsets` arrays are per UTF-16 code unit (a surrogate pair
  repeats the same painted x), so the engine converts per run.
- **Geometry.** Caret x comes straight from `xOffsets`; `charOffset == length`
  is the caret after the final character, at the run's captured right edge
  (`x + width`). Baseline = run top + `fontAscent` (Chrome's own
  `measureText` ascent); caret height = ascent + descent. The insertion-cell
  width (block / underscore carets) is the addressed character's painted
  advance, or the space advance at end-of-text.
- **Line breaks.** An offset landing exactly at a segment boundary resolves to
  the START of the next line (position 0 of the next run) — except at the very
  end of the element, where it parks after the last character.
- **Fallback.** Runs without captured `xOffsets` fall back to fontkit advances
  (the same resolve-key → font-instance path the typing overlay's
  `overlayAdvances` uses), anchored at the run's captured `x`.
- **Out of scope (v1).** Vertical-writing segments are skipped; RTL runs use
  the captured visual-order `xOffsets` as-is (logical-order addressing over
  bidi runs is future work); multi-line ranges yield one rect per line (see
  Selection below) but the *sweep* orders rects in captured segment order.

API: `resolveCaretPoint(roots, target, charOffset)` → `{ x, baselineY,
ascentPx, descentPx, fontSize, cellWidthPx }`;
`resolveRangeRects(roots, target, charStart, charEnd)` → one
`{ x, y, width, height, edges[] }` per covered run, where `edges` are the
successive per-character painted right edges (the exact sweep geometry);
`addressableLength`, `findAddressedElement`.

## The track (`src/animation/caret-track.ts`)

Two stages, mirroring the magic-move precedent (resolved caller-side from the
element trees, consumed by the animator as concrete geometry):

1. **`resolveTextTrack(roots, spec)`** — resolves an address-based
   `TextTrackSpec` into a `ResolvedTextTrack`. Events (sorted by `t`, ms on
   the animation's GLOBAL timeline):
   - `park` / `move` `{ t, charOffset, target? }` — place the caret (both are
     step-end jumps; the two names keep scripts readable);
   - `hide` `{ t }` — hide the caret until the next park/move;
   - `select` `{ t, charStart, charEnd, sweepMs?, color?, target? }` — sweep a
     selection over the range, growing over `sweepMs` (0 = appears at `t`);
   - `clearSelection` `{ t }` — clear the most recent selection.
   Track-level options: `shape` (`bar` default / `block` / `underscore`),
   `color` (default `#111111`), `barWidthPx` (2), `blinkMs` (1060),
   `selectionColor` (default `#3b82f6aa`, a translucent blue). Unresolvable
   events are skipped with a console warning (the cursor-overlay convention).
2. **`textTrackMarkup(track, totalDurationMs, index)`** — pure emission: a
   self-contained `<g class="text-track">` with a local `<style>`, keyframe
   names namespaced by a content hash (composited SVGs can't collide).

### Emission model

The `buildCursor` (terminal) / `buildTypingCaret` (typing overlay) two-track
pattern:

- **Caret position**: `step-end` `transform: translate(...)` waypoints in
  global timeline percents. The caret rect is sized by the shared
  `caretShapeRect` (`src/animation/caret-metrics.ts`, docs/97) from the first
  waypoint's metrics; waypoints with different metrics (another font size /
  element) fold a `scale(...)` into their transform — exact for a solid rect.
- **Caret visibility**: a separate `step-end` opacity track (hidden before the
  first waypoint, toggled by `hide`, holds its final state through the loop).
- **Blink**: the standard ~1.06 s cycle (`0%{opacity:1} 50%{opacity:0}`,
  step-end) on a nested group — opacities compose through nesting
  (vis × blink), the terminal cursor's convention. The caret blinks whenever
  visible; moves are instantaneous so the blink phase carries through.
- **Selection**: one `<rect>` per covered text run, grown via `width`
  keyframes stepping through the per-character painted edges — an exact
  per-char sweep (the same width-keyframe machinery the typing overlay's
  reveal clips use). `sweepMs` distributes across covered characters in order,
  so a range spanning wrapped lines sweeps line 1 fully, then line 2. Above
  120 covered characters the sweep interpolates linearly per rect (bounded
  CSS, mirroring the typing overlay's discrete cap). Cleared rects snap back
  to the hidden width (0.01px — a zero-area rect is WebKit-hazardous) at the
  clear time; otherwise they hold to the loop end.

All motion is CSS opacity / transform / width — **no SMIL** (docs/84), no
animated filter.

### Z-order (documented contract)

As a standalone overlay the selection rect paints **above** the captured text —
a translucent highlight-marker look, which is the right reading for walkthrough
highlighting. True editor selection paints *behind* the glyphs; that arrives
with the frame-sequence compressor's merged emission (doc 100, Primitive 1),
which owns the glyph layers and can interleave. The track group itself layers
above every frame group and **below the cursor overlay** (the demo's pointer
stays the topmost paint). Within a track, selection rects paint before the
caret.

## Wiring

`AnimationConfig.textTracks?: ResolvedTextTrack[]` on `generateAnimatedSvg`
(`src/animation/animator.ts`). The caller resolves tracks against the captured
frame trees (`resolveTextTrack`) before composing — the magic-move pattern.
Omitting the field (or passing an empty list) leaves output byte-identical.
Public exports from the package root: `resolveTextTrack`, `textTrackMarkup`,
`resolveCaretPoint`, `resolveRangeRects`, `findAddressedElement`,
`addressableLength` and their types.

### Config surface (shipped)

The declarative surface is the per-frame `textTracks: [...]` list in the
animate config (`src/cli/animate.ts`; authoring reference **docs/43 §12**):
each track gives a `selector` (stamped `data-domotion-anim` on the first match
at capture time — the intra-frame-animation mechanism; a no-match is a hard
error naming the frame + config path) plus events with frame-relative `at`
times, mapped to global time like cursor events. Per-event `selector`
overrides stamp their own animId. The CLI maps the config track to a
`TextTrackSpec` (`configTextTrackSpec`), resolves it against the frame's
captured tree via `resolveTextTrack`, and threads the accumulated tracks into
`AnimationConfig.textTracks`. `${vars}` interpolation applies to the selector
fields like every other config string. Covered by schema unit tests
(`src/cli/animate.test.ts`), the rasterized config e2e
(`tests/compressed-run-config.e2e.test.ts`), and frame 1 of the committed
golden `examples/animate/compressed-run/`.

## Limits (v1)

- Horizontal writing modes only (vertical segments are not addressable).
- Ranges across elements are not supported (one target element per event).
- A block caret does not invert the glyph color beneath it (Blink paints the
  caret-covered glyph in the background color; the translucent 0.5-alpha block
  from docs/97 is used instead).
- Addresses resolve against ONE captured tree; a caret that must track text
  across frame boundaries needs per-frame tracks (or the compressor's merged
  runs, doc 100).
- The blink runs on its own short cycle rather than the global timeline, so a
  scrubbed/paused viewer sees the blink phase for the paused wall-time (same
  behavior as the terminal cursor).

## Tests

- `src/animation/text-address.test.ts` — code-point vs UTF-16 indexing (astral
  pair), segment boundaries, end-of-text caret, input-value synthesis, range
  rects + sweep edges, fontkit fallback, out-of-range rejection.
- `src/animation/caret-track.test.ts` — event resolution (ordering, skips,
  per-event target override), caret waypoint/visibility/blink CSS, shape
  geometry (bar/block/underscore, metric scaling), selection sweep keyframes,
  clear snapping, multi-line sweep, animator wiring + byte-identity without
  tracks.
- `tests/caret-track.e2e.test.ts` — captures a real page (heading + form
  field), resolves addresses, composes via `generateAnimatedSvg`, rasterizes
  the actual SVG at chosen times (pause + seek every animation), and asserts
  the caret INK lands at the resolved x (±1.5px), the field caret parks after
  the value, the selection sweep rect grows mid-sweep → full, and `hide`
  removes the caret ink.

## Related

- `docs/100-rich-text-editing.md` — the design this implements (Primitive 2)
  and the compressor it composes with later.
- `docs/97-caret-shapes.md` / `src/animation/caret-metrics.ts` — the shared
  caret geometry.
- `docs/13-cursor-overlay.md` — the overlay layering + namespacing conventions
  this mirrors.
- `docs/84-viewer-browser-support.md` — the cross-engine animation constraints
  (CSS only, no SMIL).
