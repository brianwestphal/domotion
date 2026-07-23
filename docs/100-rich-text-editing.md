# 100 — Rich-text typing & editing (`richText`)

Status: **Design** (nothing in this doc is implemented). This is the requirements +
design reference for a first-class rich-text display/editing primitive in the
animate pipeline: a styled text document plus a timeline of editing operations
(type / insert / select / replace / restyle), rendered natively per keystroke with
a caret, selection highlights, and **real reflow of trailing text** — the text
analogue of what `domotion term` does for a terminal grid. Plain text is the
trivial case (one unstyled span per line), so this primitive subsumes "animate
some text being typed and edited" generally, not just syntax-colored code.

## Motivation — the workarounds this replaces

The ground-truth use case is the kerf getting-started coding-session capture
(`kerf/site/scripts/demo-captures/pages/getting-started/index.html` +
`gen-getting-started.mjs` in the kerf repo): an IDE window typed into and edited,
with syntax coloring, inside a multi-window desktop scene. Expressing it on
today's declarative surface required four classes of elaborate workaround:

1. **The cover-rect underlay contract.** A `typing` overlay always fades out
   starting 150 ms before its frame ends (`disappearGap = 150`, hardcoded in
   `renderTypingOverlay`, `src/animation/animator.ts` — not configurable). So a
   typed line cannot simply hold and hand off at the cut: the page must carry the
   IDENTICAL text as real opaque page text hidden under a background-colored cover
   rect, and a per-line `reveal` animation must fade the cover out the moment the
   overlay finishes typing — with the overlay baseline aligned to the page text's
   baseline via a hand-tuned `dy` (≈ 11.5 px for Menlo 12.5px — Menlo's ascent,
   measured against rendered probes). One cover span, one cover rect, one reveal
   animation, and one baseline constant **per typed line**, all page-side contract.
2. **Mid-line insertion.** Typing overlays paint on TOP of the captured frame —
   they cannot move captured pixels. Inserting ` computed,` into an existing
   import line (pushing ` mount, delegate } …` rightward as characters land)
   required page-side helpers (`window.ins(k)`) and one `evaluate`-action +
   full-capture frame per ~2 characters — five frames for a 10-character insert.
3. **Select-then-replace.** Replacing a selected `"btn"` with `{cls}` needed
   hand-authored selection markup in the page plus the same per-2-char
   page-driven frames.
4. **Colorize-on-completion.** The "tokenizer catching up" effect (plain typed
   text snapping to its syntax-colored form) was a page-side swap of the whole
   line for a colored twin with identical glyph geometry, staged as its own frame.

The result works, but the config is ~37 frames of which most exist only to fake
editing, every typed line needs a page-side contract, and each mid-line edit is
O(chars/2) full captures. A native primitive collapses all four into declarative
data the animator can render exactly.

## Existing machinery this builds on (reuse, don't reinvent)

- **Measured advances + the shared reveal plan** — `renderTypingOverlay`,
  `overlayAdvances`, `buildTypingPlan`, `buildTypingLines`, `buildTypingCaret`
  in `src/animation/animator.ts` (docs/93): fontkit-measured per-glyph advances,
  one compiled plan that the reveal clips AND the caret both ride (structurally
  cannot desync), `step-end` per-keystroke stepping, deterministic seeded jitter.
- **Glyph-path text** — `typedGlyphMarkup` / `renderTextAsPath` in `paths` mode
  plus the glyph-defs registry (`ensureGlyphDef` / `getGlyphDefsSince` /
  `truncateGlyphDefs`): typed text is baked outline geometry (`<use href="#gK">`),
  so painted advances equal measured advances on every viewer, proportional fonts
  included; `<text>` fallback when the font can't resolve.
- **Caret geometry** — `src/animation/caret-metrics.ts` (`caretShapeRect`,
  docs/97): Blink-faithful bar/block/underscore carets from real ascent/descent.
- **Identity-tracked incremental composition** — `src/terminal/incremental.ts`
  (`TrackedLine`, `lineKeyframes`): the line-pool model where each logical line is
  emitted ONCE and driven by waypoint keyframes (`step-end` opacity for appear/
  leave, `linear` translate glides for scrolls). The rich-text renderer applies
  the same identity + waypoint idea to text segments within a line.
- **The cross-frame track precedent** — the config-level cursor overlay
  (docs/13): markup rendered once, animated in global-timeline percents across
  many frames. A rich-text document that persists across frames follows the same
  pattern.
- **Anchor resolution** — `resolveAnchoredOverlays` (`src/animation/
  resolve-overlays.ts`): selector → border box / content width / computed font at
  capture time.
- **Per-keystroke re-capture** — `typeResample` (`src/cli/type-resample.ts`,
  docs/93 v2) is the neighboring primitive for LIVE fields: it re-captures the
  real page per keystroke so masking/validation/IME render faithfully, at
  O(N·page) cost. `richText` is the synthetic counterpart for AUTHORED text:
  O(doc + ops) output, no page contract, full editing vocabulary. The two are
  complementary; `richText` deliberately does NOT use the flipbook approach for
  its core rendering.

## The document model

A rich-text document is a fixed grid of lines, each a sequence of styled spans.
Documents are declared once at the top level of the animate config and referenced
by id from frames (mirroring `vars`):

```jsonc
"richTexts": {
  "editor": {
    "fontFamily": "Menlo, ui-monospace, monospace",
    "fontSize": 12.5,
    "lineHeight": 19,             // px per line row (default: round(fontSize × 1.35))
    "color": "#e2e8f0",           // default span color
    "styles": {                    // named styles, referenced by spans and restyle ops
      "kw":  { "color": "#93c5fd" },
      "str": { "color": "#86efac" },
      "num":  { "color": "#fbbf24" },
      "sel":  { "background": "#3b82f6aa" }   // used for selection highlights too
    },
    "gutter": { "width": 40, "style": { "color": "#475569" }, "numbers": true },
    "lines": [
      { "spans": [] },             // starts empty; ops type content in
      { "spans": [ { "text": "const n = ", "style": null }, { "text": "42", "style": "num" } ] }
    ]
  }
}
```

- **`styles`** — a named-style map. A style is `{ color?, background?, weight?,
  italic?, underline? }`. Spans reference styles by name (`"style": "kw"`) or
  inline (`"style": { "color": "#…" }`); `null`/omitted means the document
  defaults. Named styles are what `restyle` ops target, and they keep the
  colorize-on-completion op cheap to author.
- **`lines`** — the initial state. A line is `{ spans: [...] }`; an empty spans
  array is a blank row. Lines occupy a fixed vertical grid: line `i` renders at
  `y = i × lineHeight` (baseline at `y + ascent`, from the resolved face's real
  metrics as in `overlayAdvances`). There is **no paragraph wrap** — a line is a
  line (the editor/terminal model, and what makes reflow tractable; see Out of
  scope).
- **`gutter`** (optional) — a left column of `width` px rendered right-aligned
  before each line's text origin (line numbers when `numbers: true`, or a per-line
  `gutterText`). Gutter text is static decoration and **excluded from column
  addressing** — `{ line, col }` positions address only the editable span text.
- **Addressing** — positions are `{ "line": L, "col": C }`, both 0-based,
  `col` counted in Unicode code points across the line's concatenated span text
  (astral pairs count as one, same as the typing overlay's per-glyph arrays).
  Ranges are `{ "from": pos, "to": pos }`, end-exclusive, single-line in v1
  (`from.line === to.line`; multi-line ranges are a v2 extension).
- **Plain text** is the trivial case: no `styles`, each line one default span.

### Placement

The document renders as a **cross-frame track**: its markup is emitted once and
animated in global-timeline percents (the cursor-overlay pattern), layered above
the frame content like other overlays for the contiguous run of frames that
reference it. Placement comes from the first referencing frame:

```jsonc
{ "richText": { "id": "editor", "anchor": { "selector": "#code", "at": "top-left", "dx": 54, "dy": 10 }, "ops": [ … ] } }
```

or explicit `x`/`y`. The anchor resolves through the same
`resolveAnchoredOverlays` engine as other overlays. An optional
`mask: { width, height, color }` paints an opaque backdrop behind the document
(same knob as the typing overlay) for placing the doc over non-empty captured
content.

## The operation timeline grammar

Each referencing frame carries `richText: { id, ops: [...] }`. Ops run
**sequentially** within the frame, starting at frame start (+ optional block
`delay`), and the document state carries across frames: frame N's initial state
is the state after all ops of earlier frames (exactly how `continue` frames
accumulate page state). The op vocabulary:

```jsonc
// Type text at a position, one keystroke at a time. Text to the RIGHT of the
// insertion point shifts right per keystroke (real reflow). At end-of-line this
// is plain append (the typing-overlay case).
{ "op": "type", "at": { "line": 3, "col": 0 }, "text": "const cls = computed(…);", "style": null,
  "speed": 24, "jitter": 0.12 }

// Paste: the whole string lands at once (single reflow step).
{ "op": "type", "at": …, "text": "…", "mode": "paste" }

// Delete a range: the range's glyphs vanish and trailing text snaps left.
// `perChar: true` deletes one code point per keystroke (backspace cadence,
// right-to-left) instead of one atomic snap.
{ "op": "delete", "range": { "from": { "line": 0, "col": 8 }, "to": { "line": 0, "col": 18 } } }

// Select a range: a selection highlight (the document's `sel` style background,
// or an inline `background`) appears behind the glyphs. `sweepMs` grows the
// highlight from `from` to `to` over that time; omitted = instant.
{ "op": "select", "range": …, "sweepMs": 220 }

// Clear the selection without editing.
{ "op": "deselect" }

// Replace a range with typed text: the selection highlight (if any) clears, the
// range is deleted (trailing text snaps left), then `text` types in per
// keystroke (trailing text pushes right again) — the kerf "btn" → {cls} edit as
// ONE op. Sugar for select? + delete + type at range.from.
{ "op": "replace", "range": …, "text": "{cls}", "speed": 24 }

// Restyle a range in place (no geometry change for color-only styles): the
// colorize-on-completion effect. `styleMap` recolors several sub-ranges at once
// so a whole line "tokenizes" in one step.
{ "op": "restyle", "range": …, "style": "kw" }
{ "op": "restyle", "line": 0, "styleMap": [ { "from": 0, "to": 6, "style": "kw" }, { "from": 26, "to": 34, "style": "str" } ] }

// Insert a blank line at `line`, pushing later lines down (translateY glide,
// terminal-composer style); deleteLine is the inverse.
{ "op": "insertLine", "line": 4 }
{ "op": "deleteLine", "line": 4 }

// Move the caret without editing (glide or jump), park it blinking.
{ "op": "caretTo", "at": { "line": 11, "col": 71 } }

// Hold the current state (a beat between ops).
{ "op": "pause", "ms": 600 }

// End the track early / re-show it (see "Handoff" below). Default: the track
// shows from its first referencing frame to the end of its last one.
{ "op": "hide" }
{ "op": "show" }
```

A worked fragment — the kerf mid-line insert, today five evaluate+capture frames
plus page helpers, as one op:

```jsonc
{ "continue": true, "duration": 1400,
  "richText": { "id": "editor", "ops": [
    { "op": "type", "at": { "line": 0, "col": 15 }, "text": " computed,", "speed": 85 }
  ] } }
```

## Timing semantics

- **Per-keystroke cadence**: `speed` is ms per code point (default 60, the
  typing-overlay default), `jitter` (0–1) humanizes it via the same deterministic
  FNV-1a/mulberry32 PRNG seeded off the op text (byte-stable output, the
  committed-golden invariant). `mode: "paste"` lands the whole string at once.
- **Sequencing**: ops run back-to-back in array order; an op's optional `delay`
  inserts a beat before it. The block-level `delay` offsets the whole frame's op
  run from frame start.
- **Duration coverage**: a frame's op run should fit its `duration`; when it
  doesn't, the CLI warns and the remaining ops **compress** into the available
  window (the typing overlay's existing compress-to-fit rule) rather than leak
  past the cut. Sizing rule of thumb, same as `cast` frames: `duration ≈ delay +
  Σ(op time) + a settle beat`.
- **Holds**: after a frame's ops finish, the document holds its state — through
  the frame end and across subsequent frames until the next ops (or the track
  end). There is **no forced end-of-frame fade**: holding to the cut is the
  entire point (contrast the typing overlay's `disappearGap`).

## Rendering model

The compiler lowers the ops into one **shared plan** per document (extending the
`buildTypingPlan` idea), from which all visual tracks are generated — so glyphs,
segment shifts, selection, and caret cannot desync:

- **Glyphs appear once.** Every glyph the document ever shows is emitted once as
  a glyph-path `<use>` (via `typedGlyphMarkup` / the glyph-defs registry;
  `<text>` fallback when the font can't resolve), positioned at its **birth**
  coordinates. Typed glyphs get a `step-end` opacity keyframe at their
  keystroke time; deleted glyphs get a `step-end` off at deletion time.
- **Reflow = segment waypoints.** An edit splits its line into identity-tracked
  segments (the `TrackedLine` idea, applied within a line): the text right of the
  edit point becomes a tail segment whose `translateX` rides `step-end` waypoints
  — one stop per keystroke, each `Δx` = the measured advance of the glyph that
  landed (real editors move text atomically per keystroke, matching the typing
  overlay's staircase). A delete snaps the tail left in one stop (or steps
  per-char with `perChar`). Line insert/delete moves later lines with a short
  `translateY` glide (the terminal composer's `SLIDE_MS`-style slide). Because
  per-glyph advances are context-free with kerning off, tail Δx is exact for
  proportional fonts too (see Open questions on `kern`).
- **Selection** is a rect track behind the glyph layer: born at `select` (grown
  over `sweepMs` via a width keyframe or per-glyph steps), cleared at
  `deselect`/`replace`. Rect geometry comes from the same measured cum-advance
  arrays as the glyphs.
- **Restyle**: color-only restyles animate `fill` on the affected span group with
  a `step-end` keyframe (same outlines, new paint). A weight/italic restyle
  changes outlines, so both copies are emitted and swapped by paired `step-end`
  opacity tracks.
- **Caret**: one caret element per document, geometry from `caretShapeRect`
  (bar default; block/underscore per docs/97), `step-end` position waypoints at
  every keystroke (including the leftward snap on delete/replace — the retreat
  the mistakes machinery already renders for typing overlays), a standard blink
  cycle while parked, hidden while the track is hidden.
- **Determinism**: glyph-defs snapshot/rollback around generation (the
  typing-overlay pattern) so repeated runs re-assign the same `gK` ids; jitter
  seeded off op text. Output is byte-stable.
- **Output cost** is O(unique glyphs + ops), not O(states × doc): a 12-line
  editor session with ~500 typed characters emits ~500 glyph uses + per-keystroke
  CSS stops — compare the per-2-char flipbook's full page capture per state.
- **Cross-engine**: everything above is CSS `@keyframes` over `opacity` /
  `transform` / `fill` (no SMIL, no animated `filter`), per the docs/84 viewer
  matrix.

### Why not a nested per-state flipbook

`typeResample` composes N full captures into a nested animated SVG per frame —
right for live pages (the browser must paint each state), wrong here: the states
are synthetic and differ by one glyph, so a flipbook re-emits the whole document
per keystroke. The incremental model above is the same insight that took the
terminal composer from "22 copies of one line" to one tracked line with
waypoints.

## Interaction with frames, overlays, and transitions

- **Z-order**: the track renders in the overlay layer of its participating
  frames' window — above captured frame content, below the cursor overlay. Other
  overlays on the same frames compose normally.
- **Contiguity**: the frames referencing one document id must be contiguous
  (validation error otherwise). The track's visibility keyframe spans exactly
  that window (plus `hide`/`show` ops within it).
- **Transitions**: frame transitions behave normally around the track; since the
  track holds through cuts, a `cut` between two op frames is seamless by
  construction. Crossfades under a static track region also read correctly (the
  track itself doesn't fade).
- **Handoff to page text**: when the document's region must return to captured
  page content (e.g. the kerf editor window glides away — the track is statically
  positioned and would NOT follow an animated window), end the track (`hide` op,
  or let its frame run end) at a cut where the page carries identical text. The
  handoff is invisible when text/geometry match — and unlike today it happens
  **once per document**, not once per line, with no fade gap to paper over.
  Mirroring a window glide with a transform on the track itself is out of scope
  for v1 (see Open questions).
- **Capture side**: none. The document renders node-side from fontkit metrics —
  no page contract, no `evaluate` helpers, no extra captures. (Fonts must be
  resolvable node-side, same constraint as typing-overlay glyph paths; webfonts
  registered via the capture's webfont discovery work as they do for overlays.)

## Fold-ins: two small, independent typing-overlay improvements

These fix the two sharpest edges of the CURRENT workaround and are worth landing
regardless of (and before) `richText`:

1. **`holdToFrameEnd: true`** on the `typing` overlay — opt out of the forced
   end-of-frame fade. Today `renderTypingOverlay` computes `holdEndMs = frameEnd
   − disappearGap` (150 ms) and fades the overlay (and its mask) out over the
   remainder; the flag instead holds full opacity to the frame's end and drops
   with a hard `step-end` cut at the frame boundary (the mask rect too). With the
   next frame carrying identical page text, the handoff becomes seamless without
   the cover-rect reveal choreography. Default stays the current fade (existing
   goldens byte-identical).
2. **Baseline anchor mode** for typing overlays — `anchor.baseline: true` makes
   the resolved `y` the anchored element's **first-line text baseline** instead
   of its border-box top. `resolveAnchoredOverlays` already measures the
   element's computed font; this adds a page-side baseline measurement (canvas
   `fontBoundingBoxAscent` + the line-box placement math `measureCaret` in
   `src/cli/type-resample.ts` already implements) so the overlay's `y` — which IS
   the typed text's baseline in `renderTypingOverlay` — lands exactly on the
   page text's baseline. Kills the hand-tuned `dy ≈ 11.5` ascent constant.

## Explicitly out of scope for v1

- **Paragraph wrap / cross-line reflow** — a line is a line; an over-long line
  runs on (clip with the mask). Editors don't soft-wrap in these demos, and wrap
  would make every edit a whole-block relayout. (The typing overlay's
  `wrapWidth` remains the tool for textarea-style wrapped typing.)
- **Multi-line ranges** for select/replace/restyle (v1 ranges are single-line;
  `styleMap` covers the common whole-line tokenize).
- **Mistake → backspace → correct** on richText ops (the typing overlay's
  `mistakes` machinery ports cleanly onto the shared plan later; `jitter` IS in
  v1).
- **Bidi/RTL editing and cross-boundary contextual reshaping** — Arabic joining
  forms across a moving edit point would need per-state re-shaping; v1 targets
  LTR scripts with context-free advances (the code/editor use case).
- **GPOS kerning** (`kern`) across edit boundaries — kerned advances are
  context-dependent, breaking the exact tail-shift math; v1 is per-glyph
  advances (the typing overlay's default too).
- **IME composition, live-field fidelity** — that's `typeResample`'s domain.
- **Following an animated container** (a track that rides a window glide).
- **A built-in syntax tokenizer** — spans and `restyle` ops are explicit;
  highlighting is the author's (or a generator script's) job in v1.

## Staged implementation plan

Each stage is a self-contained, independently landable ticket:

1. **Model + state machine** (`src/animation/rich-text/model.ts`): zod schemas
   for the document (styles/lines/spans/gutter), positions/ranges, and the op
   union; a pure `applyOp(state, op)` reducer + state sequencer; line layout via
   the `overlayAdvances` measurement path. Unit tests including transition-matrix
   sequences (type→select→replace→restyle→delete interleavings, per the stateful-
   module testing rule).
2. **Timeline compiler** (`src/animation/rich-text/plan.ts`): ops → the shared
   plan — glyph birth/death events, segment identities + translate waypoints,
   selection rect track, caret waypoints, per-op time windows with jitter +
   compress-to-fit. Pure + unit-tested (no SVG yet).
3. **Renderer + animator wiring** (`src/animation/rich-text/render.ts`): plan →
   glyph-path markup + `@keyframes` CSS in global-timeline percents; the
   cross-frame track hookup in `generateAnimatedSvg` (cursor-overlay pattern);
   glyph-defs snapshot/rollback; `<text>` fallback; mask/gutter emission.
   E2E-verified by rasterizing frames of the rendered SVG (the "verify the
   rendered SVG, not plan math" rule).
4. **Declarative config surface** (`src/cli/animate.ts`): top-level `richTexts`
   registry + per-frame `richText` blocks, anchor resolution (including the
   fold-in baseline mode), contiguity/duration validation + warnings, JSON-Schema
   regeneration, docs/43 cross-reference, a committed golden under
   `examples/animate/rich-text/`, feature-coverage index entries.
5. **Flagship validation**: rebuild the kerf getting-started editor phases as an
   example on the new primitive; compare output size + visual parity against the
   per-2-char flipbook approach; fold findings back into this doc and flip its
   status.

The two fold-ins (`holdToFrameEnd`; baseline anchor) are separate small tickets,
landable before stage 1.

## Open questions

Genuinely open decisions where the answer changes the design (not bikeshed):

1. **Placement form.** This doc proposes a **cross-frame overlay track**
   (document declared once, ops per frame, glyphs emitted once, holds through
   cuts). The alternative in the original sketch is a **frame-kind** (`cast`-
   style nested SVG per frame). The track wins on output size, persistence, and
   the handoff story, but is a new animator concept (second cross-frame track
   after the cursor). Is the track model approved, or should v1 be the simpler
   nested-per-frame block despite per-frame re-emission?
2. **Source of truth for the styled model.** V1 proposes **inline JSON spans**
   (deterministic, no capture dependency). The alternative: **capture-derived** —
   point at a selector and harvest per-char computed styles from the captured
   page into a document, then edit it with ops (avoids restating styled content
   that already exists in a page, e.g. kerf's colored lines). Inline-only for v1
   with capture-derived as a follow-up — or is capture-derived needed up front
   for the flagship use case to be ergonomic?
3. **Proportional fonts & kerning.** With per-glyph advances (kern off),
   proportional fonts work exactly (context-free Δx). Supporting `kern: true`
   would require re-shaping the edited line per state and re-positioning
   surviving glyphs (kern pairs change across the edit boundary). Is kern-off
   proportional support sufficient for v1 (recommended), or is kerned editing a
   requirement?
4. **Ops → frame mapping.** Proposed: ops run **intra-frame** (many keystrokes
   per frame, state persists across frames via the doc id) — one frame per
   narrative beat rather than per edit. Any need for the inverse (auto-splitting
   an op list into generated frames, e.g. to let transitions land mid-edit)?
5. **Vertical reflow scope.** V1 has explicit `insertLine`/`deleteLine` with
   translateY pushes on a fixed line grid, no soft wrap. Sufficient for the
   editor/terminal-style use cases this targets?
6. **Following animated containers.** When the region a document sits over is
   itself animated (the kerf window glides), v1's answer is "end the track at a
   cut and hand off to page text". Is a v2 `transform`-mirroring facility (the
   track restates the container's glide) worth designing now, or is boundary
   handoff acceptable indefinitely?
7. **Selection sweep & mistakes parity.** Should v1 ship `sweepMs` selection
   growth and defer the `mistakes` port (recommended), or is typo/backspace
   humanization expected at parity with the typing overlay from day one?

## Related

- `docs/93-realistic-typing.md` — the typing overlay (measured advances, shared
  reveal plan, glyph paths, `typeResample`), the machinery this generalizes.
- `docs/97-caret-shapes.md` / `src/animation/caret-metrics.ts` — shared caret
  geometry.
- `docs/67-terminal-capture.md` / `src/terminal/incremental.ts` — the
  identity-tracked incremental composition model this borrows.
- `docs/43-declarative-animate-config.md` — the animate config the `richTexts` /
  `richText` surface extends.
- `docs/13-cursor-overlay.md` — the cross-frame track precedent.
- `docs/84-viewer-browser-support.md` — the cross-engine animation constraints
  the rendering model observes.
