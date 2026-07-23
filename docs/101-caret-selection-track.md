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
- **Mixed content across descendants (DM-1756).** The address resolves over the
  target's whole SUBTREE, not just its own text nodes:
  `<p>plain <b>bold</b> tail</p>` — or a syntax-highlighted code line tokenized
  into `<span>`s — is one logical string whose `charOffset` spans the children,
  and a range spans them too. The captured tree stores a parent's own
  `textSegments` and its child elements (`el.children`) SEPARATELY — the DOM
  interleave order between them is not retained — so reading order is
  reconstructed from Chromium's painted geometry: every element in the subtree
  contributes its own runs (each keeping ITS OWN font metrics / baseline /
  `xOffsets`), runs are grouped into lines by baseline (a `<sub>`/`<sup>` stays
  on its line; a wrapped or `display:block` child starts a new line), and
  ordered left-to-right by captured `x` within each line. For horizontal LTR
  inline flow that visual order equals DOM/logical order (this is a text-flow
  reading order, distinct from the element z-order paint sort in
  `src/render/paint-order.ts`). Because each run carries its own text +
  `xOffsets`, the code-point → UTF-16 conversion composes correctly across child
  boundaries. Whitespace is taken verbatim from what Chromium captured — the
  leading / trailing spaces inside a text run (`"plain "`, `" tail"`) are
  preserved and the engine never synthesizes a space at a child boundary. This
  is the prerequisite for addressing a tokenized editor line by its line
  selector alone (`{ selector: '.code-line-3', charOffset: 12 }` resolves across
  that line's colored token spans). **Regression safety:** when no descendant
  element contributes a run (the single-element and input-value cases), the
  target's own runs are returned in captured order unchanged, so existing
  single-element / bidi-fragment / input behavior is byte-for-byte preserved —
  the paint-order merge only runs for genuinely mixed content.
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
   `selectionColor` (default `#3b82f6aa`, a translucent blue), `invert`
   (block-caret glyph inversion, off by default — see below) + `invertTextColor`
   (the inverted-glyph ink, default `#ffffff`). Unresolvable events are skipped
   with a console warning (the cursor-overlay convention).
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

The shorthands are declared INLINE on the track's rects/groups (the
keyframes in the track's local `<style>`). When track markup is embedded
inside a nested animated SVG (the compressed run's auto-caret, doc 100), the
embed re-anchor pass (`offsetEmbeddedAnimatedSvgTimeline`,
`src/animation/embed-timeline.ts`) retimes inline `style="animation:…"`
declarations along with `<style>` contents — position/visibility/selection
tracks remap into the host frame's window; only the fixed-period blink stays
free-running.

A track's caret and selection **hold their final state through the loop** and
the track layers above every frame group — so a track that should not outlive
its frame must end with explicit `clearSelection` + `hide` events at the
frame's cut (see the docs/102 cookbook; the editor-session flagship's
selection frame is the reference).

### Block-caret inversion (`invert`)

By default a `block` caret paints the docs/97 translucent 0.5-alpha cell over
the glyph (Blink's auto-caret-color look). A true terminal/editor block cursor
instead **inverts** the covered glyph — the character repaints in the
background color over a solid block. As a standalone overlay the track doesn't
own the page's glyph paint, so `invert: true` (block shape only) makes the
track **repaint the covered glyph itself** in the inverse color:

- **The block** paints SOLID (opacity 1) in the track `color` — no longer the
  0.5-alpha translucency.
- **The covered glyph** is re-emitted on top in `invertTextColor` (default
  `#ffffff`, a light "background" ink). Which character is covered comes from
  the same captured-tree resolution the caret geometry uses — resolved node-side
  from the addressed element's text runs at each waypoint — and its outline is
  produced by `renderTextAsPath` (the addressed char at that offset, in the
  captured font/size), forced into **paths mode** so it emits `<use href="#gN">`
  whose glyph defs the animator collects into the document `<defs>`
  (self-contained, deterministic across repeat calls).
- **Per-waypoint layers.** Rather than the plain block caret's moving-rect +
  `scale()` position track, the inverted caret emits ONE layer per waypoint
  (solid block + its inverted glyph, absolutely positioned at that waypoint's
  cell, each glyph at its own exact font/size so a size change needs no
  outline-distorting rect scale). A `step-end` per-layer opacity window shows
  only the active waypoint's layer — running from the waypoint's time until the
  next position change or the next `hide` — so the covered glyph **swaps** as
  the caret moves between addressed offsets. All layers sit inside one nested
  blink group, so the block and its inverted glyph blink together while parked
  (in the blink-off phase the page's own glyph shows through beneath — matching
  a real block cursor).
- **End-of-text / graceful degrade.** A caret parked after the last character
  covers an empty cell (a space) with no glyph to invert — a solid block, no
  repaint. If the covered glyph's outline can't be produced on the host (font
  unresolvable in paths mode, e.g. a system font on a non-macOS `paths` run),
  the layer degrades to the translucent 0.5-alpha block so the page's own glyph
  still shows through — the overlay never covers a character with an opaque
  block it can't re-ink.

`invert` is **opt-in and additive**: with it off (or on a non-block shape) the
emission is byte-identical to before. Like docs/97's caret geometry, the
inverted glyph is spec-faithful (author-driven), not pixel-compared against a
Chrome caret.

The other route to true inversion — the frame-sequence compressor's merged
emission (doc 100, Primitive 1), which owns the glyph layers and can recolor
them in place — remains future work; this standalone repaint is the
overlay-only path.

### Z-order (documented contract) — two modes

There are two selection z-orders, and which one you get depends on where the
selection is emitted:

1. **Standalone overlay (above the text)** — a `textTracks` selection resolved
   through `resolveTextTrack` and layered by `generateAnimatedSvg` paints
   **above** the captured text: a translucent highlight-marker look, the right
   reading for walkthrough highlighting. The track group layers above every
   frame group and **below the cursor overlay** (the demo's pointer stays the
   topmost paint). Within a track, selection rects paint before the caret.
2. **Behind-glyph (true editor selection)** — inside a **compressed run**
   (doc 100, Primitive 1) the run owns the glyph layers (chrome below, glyphs
   above), so a selection can interleave into the chrome↔glyph gap and paint
   **behind** the glyph ink — exactly how a real text editor highlights a
   selection. This is the `selection` option on `composeCompressedRun`
   (**shipped**): it resolves the same docs/101 rects (`resolveRangeRects`) and
   emits them below the run's glyph layer. The glyph ink shows through the
   highlight rather than blending over it. See doc 100, Primitive 1 for the
   option shape (`CompressedRunSelection`).

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

- Horizontal writing modes only (vertical segments are not addressable). A
  vertical-writing descendant inside an otherwise-horizontal target is skipped
  (contributes no runs), same as the single-element case.
- One target element per event, but that target's whole SUBTREE is addressed as
  one string and a range may span its descendant elements (DM-1756). A range
  across two SEPARATE targets (two distinct addressed elements) is still not
  supported.
- A pure-whitespace text node between two inline children is dropped at capture
  (all-whitespace segments aren't emitted), so it is not part of the addressed
  string and not individually addressable — e.g. a code line
  `<span>const</span> <span>x</span>` addresses as `"constx"` (the lone
  separating space is absent). Spaces that live inside a text run bearing
  visible characters (`" = "`, `"plain "`, `" tail"`) ARE preserved. The engine
  deliberately does not synthesize a space at a child boundary (there is no
  captured geometry for a synthesized glyph). Wrapping tokens (including their
  own leading/trailing whitespace) in elements — as real syntax highlighters do
  — keeps every space addressable.
- Mixed-content reading order is reconstructed from painted geometry, so within
  a bidi (RTL) run that split into visual fragments the fragments order by
  visual x, not logical order — the same visual-order limitation the
  single-element bidi path already carries (logical-order addressing over bidi
  is future work).
- Block-caret glyph inversion IS supported standalone via glyph repaint (the
  `invert` option — see "Block-caret inversion" above; the track re-emits the
  covered glyph in the inverse color over a solid block). Default block carets
  still use the docs/97 translucent 0.5-alpha cell. The compressor-merged
  emission (doc 100) that recolors the page's own glyph layers in place remains
  the other, future route.
- Addresses resolve against ONE captured tree; a caret that must track text
  across frame boundaries needs per-frame tracks (or the compressor's merged
  runs, doc 100).
- The blink runs on its own short cycle rather than the global timeline, so a
  scrubbed/paused viewer sees the blink phase for the paused wall-time (same
  behavior as the terminal cursor).

## Tests

- `src/animation/text-address.test.ts` — code-point vs UTF-16 indexing (astral
  pair), segment boundaries, end-of-text caret, input-value synthesis, range
  rects + sweep edges, fontkit fallback, out-of-range rejection. Mixed content
  (DM-1756): `<p>plain <b>bold</b> tail</p>` interleaved by painted x (offsets
  mid-child, at child boundaries, end-of-subtree), a tokenized code line
  resolved as one string across its token spans, a range spanning children
  yielding one correct rect per run, a deeply-nested run reached through an
  empty wrapper (`<span><em>x</em></span>`), descendant runs keeping their own
  font metrics (sub/sup on the same line), block-level descendants ordered into
  separate lines by geometry, and a single-element / input-value
  no-regression pin.
- `src/animation/caret-track.test.ts` — event resolution (ordering, skips,
  per-event target override), caret waypoint/visibility/blink CSS, shape
  geometry (bar/block/underscore, metric scaling), selection sweep keyframes,
  clear snapping, multi-line sweep, animator wiring + byte-identity without
  tracks. Block-invert: solid block + inverse-colored glyph path per covered
  char, per-waypoint glyph swap, opt-in byte-identity vs the default block
  caret, and no-op on non-block shapes.
- `tests/caret-track.e2e.test.ts` — captures a real page (heading + form
  field), resolves addresses, composes via `generateAnimatedSvg`, rasterizes
  the actual SVG at chosen times (pause + seek every animation), and asserts
  the caret INK lands at the resolved x (±1.5px), the field caret parks after
  the value, the selection sweep rect grows mid-sweep → full, and `hide`
  removes the caret ink. A second case rasterizes a block-`invert` caret: the
  block reads as SOLID (pure red — a translucent blend would fail the pixel
  test), the covered glyph repaints in the inverse ink (blue) on top, and both
  swap to the next covered character when the caret moves.

## Related

- `docs/100-rich-text-editing.md` — the design this implements (Primitive 2)
  and the compressor it composes with later.
- `docs/97-caret-shapes.md` / `src/animation/caret-metrics.ts` — the shared
  caret geometry.
- `docs/13-cursor-overlay.md` — the overlay layering + namespacing conventions
  this mirrors.
- `docs/84-viewer-browser-support.md` — the cross-engine animation constraints
  (CSS only, no SMIL).
