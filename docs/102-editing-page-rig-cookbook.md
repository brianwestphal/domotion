# 102 — The editing-page rig cookbook: typed reveals + per-state editing pages

Status: **Shipped** (written from the rebuilt flagship,
`examples/animate/editor-session/`). This is the authoring recipe for
editor-style typing/editing sequences on the primitives from
[100-rich-text-editing.md](100-rich-text-editing.md): what goes in the config,
what stays page-side, and the two blessed patterns with copy-pasteable code.
The design rationale and the measured evaluation live in doc 100; the config
reference is [43-declarative-animate-config.md](43-declarative-animate-config.md)
§5 (typing overlays), §11 (`states` runs), §12 (`textTracks`).

The running example throughout is the committed flagship
`examples/animate/editor-session/` — a code editor window where five lines are
typed, ` computed,` is inserted mid-line (pushing the tail right per
keystroke), a `"btn"` string is selected and replaced by `{cls}`, and each
edit's line re-tokenizes ("the tokenizer catching up") — the kerf
getting-started editor scenario rebuilt with **zero** cover rects, reveal
animations, baseline constants, page-side carets, or page-side selection
markup.

## Choosing a pattern

| The moment | Pattern | Why |
|---|---|---|
| A line/word typed at the END of existing content (append-only) | **Typed reveal** (pattern A) | One capture; the overlay paints on top and hands off at the cut. Cheapest by far. |
| An edit that RE-FLOWS captured text (mid-line insert, delete, replace) | **Per-state editing page** (pattern B) | Overlays paint *over* the frame — they cannot move captured pixels. Only re-captured page states show real reflow. |
| A caret parked/moving over captured text, a selection sweep | **`textTracks`** (docs/43 §12) | Declarative, anchored to Chromium's own painted `xOffsets` — never page-side caret/selection markup. |
| Colorize-on-completion (plain typed text snapping to its tokenized form) | A final **recolor state** inside the pattern-B run — or, for a whole typed line, just the next frame's page text (pattern A's handoff IS the colorize). | Glyph-identical recolors pair exactly; the compressor emits them as fill steps in place. |
| Per-state pointer motion, non-text scene changes | Ordinary frames / cursor overlay | A `states` run has no pointer (docs/43 §11); big scene changes don't pair anyway. |

## Pattern A — typed reveal (`holdToFrameEnd` + `anchor.baseline`)

A typed line is a `typing` overlay on the frame where the line is still absent
from the page; the NEXT frame's page carries the finished line as real
(usually syntax-colored) text. Three fields make the handoff seamless with no
page-side machinery:

```jsonc
{ "continue": true, "duration": 1250,
  "transition": { "type": "cut", "duration": 0 },
  "actions": [{ "type": "evaluate", "script": "state(1)" }],   // page shows the PREVIOUS line's final form
  "overlays": [
    { "kind": "typing", "text": "const count = signal(0);",
      "anchor": { "selector": "[data-line='3']", "at": "top-left", "baseline": true },
      "fontFamily": "anchor", "color": "#e2e8f0", "caret": true,
      "speed": 24, "jitter": 0.12, "delay": 300, "holdToFrameEnd": true }
  ] }
```

- **`holdToFrameEnd: true`** (docs/93) — the typed text holds at full opacity
  through the frame's end and drops with a hard step-end cut at the boundary.
  Without it the overlay fades out 150 ms early, which is what forced the old
  cover-rect underlay contract (identical page text hidden under a
  background-colored cover, plus a per-line reveal animation timed to the
  overlay's fade).
- **`anchor.baseline: true`** (docs/93) — the overlay's `y` (its text
  baseline) resolves to the anchored element's measured first-line baseline.
  `dy` stays 0. This kills the hand-tuned ascent constant (`dy ≈ 11.5` for
  Menlo 12.5px) the old stack needed per font/size.
- **`fontFamily: "anchor"`** — font (and size) adopted from the anchored
  element, so overlay glyphs match the page text glyph-for-glyph.

The anchor target is the line's (still empty) content span — give it real
box geometry (e.g. `flex: 1` inside a fixed-height row, as in the rig below)
so the baseline measurement has a line box to work from. At the cut, the next
frame's action swaps the finished line in as real page text at the same
geometry; monospace type plus identical family/size means the handoff is
ink-bbox-continuous (verified rasterized in
`tests/editor-session.e2e.test.ts`). When the swapped-in form is the
syntax-colored one, the cut doubles as the "tokenizer catching up" beat.

**When do you still need a cover?** For the plain cases — a line typed into
empty space, handed off at a cut — never. The residual case is a typed line
that must appear ATOP already-captured text (retyping over existing content
in one frame with no cut available); that is pattern B territory anyway
(the page owns the document, capture the states).

## Pattern B — per-state editing pages (`states` + `caret`, `textTracks`)

For edits that move captured pixels, the page renders each editing state and
the config captures them inside ONE frame as a compressed run. The page is the
document model — real reflow and real syntax coloring come from the browser —
and the compressor pairs identical glyphs across states so the output is
O(doc + changes), not O(doc × states).

### The page rig (copy-pasteable)

The whole page-side contract is ~20 lines. Rows are pre-tokenized HTML
strings; `STATES` is the ordered list of document states; the config steps
`state(i)`:

```html
<script>
  /* ---- the reusable editing-page rig (docs/102) ---------------------- */
  const tok = (c, s) => '<span class="' + c + '">' + s + '</span>';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function renderRows(rows) {
    document.getElementById('code').innerHTML = rows
      .map((html, i) => '<div class="ln"><span class="no">' + (i + 1) +
        '</span><span class="src" data-line="' + (i + 1) + '">' + (html ?? '') + '</span></div>')
      .join('');
  }
  // withRow(rows, n, html): rows with 1-based row n replaced.
  const withRow = (rows, n, html) => rows.map((r, i) => (i === n - 1 ? html : r));
  // keystrokes(before, text, after): the row's HTML at k chars of `text` typed
  // between two fixed (already-tokenized) halves.
  const keystrokes = (before, text, after) => (k) => before + esc(text.slice(0, k)) + after;
  const STATES = [];
  window.state = (i) => renderRows(STATES[i]);
</script>
```

Building a mid-line insert progression is then one loop (from the flagship —
` computed,` typed into an import line, one keystroke per state):

```js
const insRow = keystrokes(K('import') + " { signal,", " computed,",
  " mount } " + K('from') + " " + S("'kerfjs'") + ";");
for (let k = 1; k <= 10; k++) STATES.push(withRow(V1, 1, insRow(k)));
STATES.push(withRow(V1, 1, R1_RETOKENIZED));   // colorize-on-completion
```

This generalizes the bespoke helpers the kerf capture hand-rolled
(`window.S` / `window.ins` / `window.rep` / `window.E`): one linear state
index, progressions built by tiny row builders. What the rig deliberately
does NOT contain — because the primitives replaced them — is cover rects,
reveal hooks, `.caret` spans, and `.sel` selection markup.

Style notes that matter to the compressor:

- Fixed-height rows (`.ln { height: 19px }`), `white-space: pre`, a stable
  monospace font — glyphs must land at identical x across states to pair.
- Give the content span `flex: 1` (or another real box) so it anchors
  pattern-A overlays and `textTracks` selectors even while empty.
- Keep per-state changes to token `<span>`s inside the row. Row-level
  background flips (kerf's `.ln-new` highlight) work but re-emit that row's
  box as a chrome variant per state.

### The config side

```jsonc
{ "continue": true, "duration": 2300,
  "transition": { "type": "cut", "duration": 0 },
  "caret": { "color": "#e2e8f0" },                     // the run's auto-caret
  "states": [
    { "duration": 300 },                                // state 0: the frame's own post-actions state
    { "actions": [{ "type": "evaluate", "script": "state(6)" }], "duration": 120 },
    { "actions": [{ "type": "evaluate", "script": "state(7)" }], "duration": 120 },
    // … one state per keystroke …
    { "actions": [{ "type": "evaluate", "script": "state(16)" }], "duration": 800 }  // colorize: a paired recolor, held
  ] }
```

- `caret: true | { shape, color }` — the auto-caret rides the derived edit
  points (after the rightmost typed glyph; at the close-up x of a deletion)
  with zero addressing. A recolor-only state (the colorize) derives NO edit
  point, so the caret holds where the last keystroke left it — a tokenizer
  catching up doesn't move a real editor's caret.
- Per-keystroke states are CHEAP: they compress to births + one tail
  `translateX` waypoint each, so finer granularity than the old
  per-2-char-frame compromise costs almost nothing (measured below).
- The exit cut needs no choreography: the run holds its final state until the
  cut, and the next frame simply continues the live page (already in that
  state) — pixel-continuous by construction.

### Selection: `textTracks` on the frame before the edit

The select-then-replace moment is a `textTracks` frame (docs/43 §12) followed
by a `states` run frame:

```jsonc
{ "continue": true, "duration": 2400,
  "transition": { "type": "cut", "duration": 0 },
  "textTracks": [
    { "selector": "[data-line='6'] .str",              // the "btn" token span
      "color": "#e2e8f0",
      "events": [
        { "type": "park", "at": 250, "charOffset": 5 },
        { "type": "move", "at": 700, "charOffset": 0 },
        { "type": "select", "at": 950, "charStart": 0, "charEnd": 5, "sweepMs": 400 },
        { "type": "clearSelection", "at": 2400 },
        { "type": "hide", "at": 2400 }
      ] } ] }
```

Two authoring rules learned from the flagship:

- **Target the token span, not the line.** Addressing covers the element's
  OWN text runs; text inside child elements is not addressable (v1 limit,
  docs/101). `"btn"` lives in a `.str` child of the line, so the track
  targets `[data-line='6'] .str` directly.
- **End the track explicitly.** A track's caret and selection hold their
  final state through the animation loop — and the track layers above every
  frame. Always `clearSelection` + `hide` at the frame's end (the cut into
  the replacement run), or the parked caret haunts every later frame.

Z-order caveat (docs/101): as a standalone overlay the selection paints
ABOVE the glyphs (a translucent highlight-marker look). True behind-the-glyph
editor selection is a compressed-run capability (tracked follow-up).

## What stays page-side, and when compression collapses

The page remains the document model — that is the design's deliberate trade
(doc 100 "What stays page-side"). The author still writes the states list and
the tokenized rows; the browser supplies reflow and coloring. What moved into
the pipeline: baselines, handoffs, carets, selections, and the cross-state
output redundancy.

**Watch the pairing log.** Every run logs
`compress: run of N states, X% glyphs paired, Y KB → Z KB`. The flagship's
runs log 99.4% / 99.6% paired. If your ratio drops well below ~90%, pairing
has collapsed and the run is degrading toward a flipbook (never wrong pixels,
just less compression). Usual causes, from doc 100's guards: proportional
fonts reshaping around the edit, layout jitter (animations/transitions live
during capture), decorated/shadowed/complex-script text (demoted to chrome),
text moving BETWEEN lines (no cross-line identity in v1 — a wrapped or
inserted-above line re-emits per state), or per-state changes outside the
edited line (a live counter, a blinking page element). **Stay with plain
flipbook frames** (ordinary continue+cut, no `states`) when the scene changes
wholesale per state — a slideshow, a scroll, a layout reflow of everything —
because pairing buys nothing there and the run block only adds nesting.

## Measured (the rebuilt flagship vs the same phases the old way)

Same scenario, same page geometry, composed both ways (macOS, embedded-font
mode; "old way" = cover-rect underlays + reveal animations + hand-tuned
baseline `dy` + page-side caret spans/selection markup + one evaluate+capture
frame per edit step, the kerf getting-started stack):

| Build | Frames | Raw | Gzip | Live DOM elements | Compose time |
|---|---|---|---|---|---|
| **New primitives** (per-keystroke) | 11 | 184.1 KB | 30.0 KB | 2,284 | ~4.9 s |
| Old way @ kerf's per-2-char granularity | 19 | 257.7 KB | 28.8 KB | 3,825 | ~6.1 s |
| Old way @ matched per-keystroke granularity | 26 | 336.9 KB | 31.4 KB | 5,236 | ~7.8 s |

- **On the editing runs themselves** the compressor delivers the predicted
  ~5× raw: the insert run measured 121.1 KB → 22.8 KB (5.3×), the replace run
  88.5 KB → 19.4 KB (4.6×), pairing 99.4% / 99.6%.
- **At whole-file scale the ratio depends on how much of the file is editing
  states of a large scene.** This flagship dilutes to 1.8× raw / 2.3× fewer
  live-DOM elements at matched granularity (1.4× / 1.7× vs the per-2-char old
  way) because the scene is one small window and the typed-line phase costs
  the same on both stacks. The shipped kerf file (37 frames of a four-window
  desktop, 91% cross-frame redundancy) sits at the other end, where the
  ~5×-raw / ~9×-nodes projection of doc 100 applies to its frame payload.
- **Gzip is a wash by design** (~1× here; doc 100 predicted 1.2–1.5× at kerf
  scale): gzip already dedupes flipbook redundancy. The honest pitch is raw
  size, the viewer's retained DOM, and the authoring-model wins — not wire
  bytes.
- **Per-keystroke granularity got cheaper than the old per-2-char
  compromise** (184 KB vs 258 KB raw) — the granularity kerf actually wanted
  but couldn't afford is now the cheap default.

## Related

- [100-rich-text-editing.md](100-rich-text-editing.md) — design, evaluation
  probe, compressor mechanism + v1 limits.
- [101-caret-selection-track.md](101-caret-selection-track.md) — the caret /
  selection track engine (addressing, events, z-order).
- [43-declarative-animate-config.md](43-declarative-animate-config.md) §5 /
  §11 / §12 — the authoring surfaces.
- [93-realistic-typing.md](93-realistic-typing.md) — the typing overlay
  (`holdToFrameEnd`, `anchor.baseline`, `fontFamily: "anchor"`).
- `examples/animate/editor-session/` — the flagship this recipe was written
  from; `examples/animate/compressed-run/` — the minimal run + track example.
- `tests/editor-session.e2e.test.ts` — the rasterized proof of every claim
  above (handoff continuity, tail shifts, prefix byte-stability, sweep/clear,
  caret edges, seamless run exits).
