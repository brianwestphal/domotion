# 100 — Rich-text typing & editing: captured states + compression + caret/selection tracks

Status: **Design; Primitive 2 shipped** (the caret + selection track is
implemented — see `docs/101-caret-selection-track.md`; the compressor, the
fold-ins, and the config surface remain design). This is the requirements +
design reference for making editor-style typing/editing sequences (an IDE window
typed into and edited, with syntax coloring, selection, mid-line inserts that
reflow trailing text) first-class in the animate pipeline. Plain text is the
trivial case, so this covers "animate text being typed and edited" generally.

**Design history.** The first draft of this doc specified a synthetic rich-text
primitive: a styled document model in config JSON plus an operation timeline
(type / insert / select / replace / restyle) compiled to a bespoke glyph renderer.
That core is **superseded** (see "The superseded alternative" at the end for what
it bought and why it lost). The adopted design keeps the *page* as the document
model — the capture page renders each editing state as real DOM, exactly the
authoring model the ground-truth kerf capture already used — and adds two
primitives that fix that model's real costs:

1. a **frame-sequence compressor** (an opt-in run block) that pairs identical
   glyphs across the N captured states and emits each once with step tracks —
   output O(doc + changes) instead of O(doc × states); and
2. a **caret + selection track** — declarative caret/selection rendering anchored
   to captured text, replacing hand-rolled page-side caret spans and selection CSS.

Both are grounded in a measured evaluation probe (12 per-keystroke states through
the production capture→render pipeline, plus a byte-level dissection of the
shipped kerf capture); the key numbers appear inline below.

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

Of these, the *authoring model* — page renders states, one continue+cut frame per
state — was actually sound: real reflow and real syntax coloring come from the
browser for free, and the per-state page helpers are simple. The genuine costs
were (a) every state is a full copy of the scene in the output SVG (and in the
viewer's live DOM), (b) caret/selection/cover machinery hand-rolled per page, and
(c) the timing contracts around the typing overlay's forced fade. The design
below attacks exactly those three; the two fold-ins at the end attack (c).

## Primitive 1 — the frame-sequence compressor (opt-in run block)

### What it does

A marked run of consecutive `continue` + `cut` states is composed into **one
nested animated SVG**: the first state's content is emitted once, every later
state contributes only what actually changed — new glyphs appear via `step-end`
opacity births, deleted glyphs die the same way, a shifted tail run rides
`step-end` `translateX` waypoints, a recolored glyph gets a `fill` step keyframe.
Layout changes **snap** at state boundaries — deliberately not tweened: real
editors snap, and cross-fading two nearly-identical lines reads as a blur-pulse
per keystroke.

This is `src/terminal/incremental.ts`'s identity model (`TrackedLine` /
`lineKeyframes`: each identity emitted once, driven by step-end opacity +
transform waypoint tracks) taken one level down — from line identity in a
terminal grid to **per-line glyph identity** driven by the captured `xOffsets`.

### Why pairing works (measured)

The captured tree already carries everything pairing needs: `TextSegment` has
`text`, baseline `x`/`y`, and **`xOffsets`** — per-code-unit viewport-absolute x,
subpixel, exactly what Chromium painted — plus per-segment color/font overrides.
The evaluation probe (an editor page modeled on the kerf window; a mid-line
insert typed one keystroke per state through the production pipeline) measured:

- **Zero capture jitter**: the same static page state captured twice is
  byte-identical (45/45 elements, 0.00 px glyph drift across 212 glyphs).
- **~87% of glyphs pair exactly** (same char + subpixel-x + fill) between
  adjacent keystroke states; the non-exact remainder is precisely the tail run
  right of the insertion point.
- **The tail shifts by a single uniform delta = exactly one glyph advance**
  (+7.53 px per state for Menlo 12.5px), so one `translateX` waypoint per
  keystroke represents the whole tail *exactly*, not approximately.
- **Recolors pair glyph-exactly**: the colorize-on-completion state (the whole
  line re-tokenized from one plain span into multiple colored spans) pairs
  219/221 glyphs with 2 recolored and 0 moved — element identity is destroyed by
  re-tokenization while glyph identity survives byte-exact. Pairing must
  therefore be **glyph-level**, matching on (char, position) with fill diffed
  into a step track.
- Pairing must use **order-preserving per-line alignment** (LCS over the
  (char, fill) sequence with tight position tolerance) — a greedy/multiset
  matcher measurably mispairs repeated characters.

The failure mode is graceful by construction: anything that fails exact pairing
(ligature/kern reshaping around an edit in a proportional font, layout jitter on
a non-static page) is simply **re-emitted from its own state's capture** — never
wrong pixels, just locally less compression. The compressor should log its
pairing ratio so authors can see when compression collapsed.

### What it saves (measured, with an honest caveat)

- Probe (12 states, embedded-font mode): 163 KB raw → ~35–50 KB raw; only 8.0%
  of the flipbook's frame payload actually changes state-to-state.
- The shipped kerf capture (37 frames, 995 KB raw / 70 KB gzip): **91.3% of the
  869 KB frame payload is cross-frame redundancy** (76 KB of real change).
  Simulated compressed: ~190 KB raw / ~46 KB gzip — **~5.2× raw, ~1.45× gzip**.
- **The honest pitch is raw size and live-DOM weight, not bandwidth**: gzip
  already dedupes flipbooks, so the wire win is only ~1.2–1.5×. What gzip cannot
  fix is the viewer's retained DOM — 37 near-identical full desktop scenes vs
  ~9× fewer live nodes — which is what shows up as paint/composite cost on pages
  embedding these SVGs (plus data-URI and non-gzip contexts).
- The win is **not editing-specific**: kerf's browser click round (12 frames of
  near-identical scene, 334 KB payload) contains only 7.7 KB of real change.
  Any hold-heavy continue+cut run compresses as hard as an editing run.

### Placement: an explicit opt-in run block (v1)

The compressor composes its run as one nested animated SVG re-anchored into its
config frame's window (`embeddedAnimationPeriodMs`) — **exactly the
`typeResample` / `cast` / scroll-block precedent, requiring zero animator
changes** and preserving the load-bearing 1 config-frame ↔ 1 animation-frame
invariant. Authoring: either `compress: true` stamped on the run's frames or a
`states: [...]` block (per-state actions + hold durations) inside one config
frame — final surface decided at build time (the config-sugar ticket).

Rejected placements, for the record: a *transition type* (compression is
run-scoped identity tracking, not a pairwise A→B effect), and an *automatic pass
over all continue+cut runs* (right long-term, but it would change every existing
config's output shape and requires shared-content groups spanning frame windows;
promote to automatic later, once the machinery is proven behind the opt-in).

Interactions (all inherited from the nested-block precedent): outer transitions
compose normally around the run (the run holds its final state until the cut);
the cull pass runs once over the merged union (strictly better — the per-frame
cull-class collision class cannot occur within a merged run); magic-move to/from
a run block degrades to crossfade like other block frames; embedded-font and
glyph-defs accumulation are unaffected; the scrubber already supports nested
animated SVGs. One documented v1 restriction: cursor-overlay events address
config frames, so per-state pointer motion *inside* a run isn't addressable —
acceptable because editing runs have no pointer.

### Why not magic-move (the obvious-looking tool)

Three structural mismatches, from `src/animation/magic-move.ts` / `tree-diff.ts`:
(1) **granularity** — it fingerprints elements on (tag, text, children), so any
text change unmatches the whole line (added+removed → whole-line crossfade), and
even a forced `data-magic-key` pair goes through `appearanceChanged()` into the
dual-render cross-fade; the measured pairable unit is the glyph. (2) **motion
model** — magic-move interpolates continuously; editors need step-end snaps, and
an unchanged prefix must not participate in any fade. (3) **cost model** — each
bridge is a full composite render of the next tree, so N states would *grow*
output, not shrink it. The compressor keeps magic-move's *idea* (identity across
frames) and its caller-side placement; the identity unit, timing function, and
scope are all different.

## Primitive 2 — the caret + selection track

The genuinely new first-class renderable, valuable with or without the
compressor (it must not be gated on it):

- **Addressing**: `{ selector, charOffset }` (ranges: `charStart`/`charEnd`),
  resolved **node-side against the captured tree** — the captured segments carry
  per-char `xOffsets` and baseline `y`, so the caret sits on *Chromium's* painted
  x with no live-page probe, no fontkit advance model, and no hand-tuned
  `dy ≈ ascent` constant. Vertical geometry from the element's captured
  `fontAscent` (fallback: the `overlayAdvances` fontkit path).
- **Caret**: geometry via the shared `caretShapeRect`
  (`src/animation/caret-metrics.ts`, docs/97 — bar/block/underscore), `step-end`
  position waypoints, the standard ~1.06 s blink cycle while parked — the
  two-track emission pattern `buildCursor` (terminal) and `buildTypingCaret`
  (typing overlay) already implement. New code is essentially captured-text
  address resolution + waypoint-list → CSS.
- **Selection**: a rect track from `xOffsets[start]` to `xOffsets[end]`, grown
  over `sweepMs` via width keyframes (per-char x is available, so sweep geometry
  is exact), cleared on command. Z-order note: true editor selection paints
  *behind* the glyphs — inside a compressed run the merged emission can do that;
  as a standalone overlay on an ordinary frame the rect sits above the text
  (a translucent highlight-marker look, right for walkthrough highlighting).
- **Auto-caret inside compressed runs**: the pairing pass computes each state's
  edit point (where the new glyph landed / where the tail split), so caret
  waypoints inside a run are derivable **for free** — no authoring.
- **Kills a measured artifact**: page-side caret spans perturb trailing geometry
  by ±0.5 px whenever they appear/disappear (measured in the probe); native
  carets remove the perturbation and the page-side `.caret` machinery with it.
- **Non-editing reuse**: caret parked in a captured form field (complementing
  `typeResample`), selection sweep highlighting a sentence in a doc walkthrough,
  block caret in a fake terminal.

## What stays page-side (and its cost, measured)

The author still builds the state-stepping page (kerf's `window.S/ins/rep/E`
helpers): the page is the document model, and that is the design's deliberate
trade — real reflow and real syntax coloring from the browser, zero synthetic
text renderer to keep faithful. The contract shrinks a lot (no cover rects, no
baseline constants, no caret spans, no per-line reveal animations) but does not
vanish. Capture cost stays O(N·page) at authoring time: ~30 ms/state measured on
the probe page (~100–200 ms for a kerf-scale desktop scene) — minutes for a
whole per-keystroke session, acceptable. Append-only typed lines can stay as
typing overlays (with `holdToFrameEnd` below), so per-keystroke states are only
needed where reflow actually happens. A documented page-rig recipe (a small
reusable snippet the `S`/`ins`/`rep` helpers could have been copied from) ships
with the flagship validation.

## Fold-ins: two small, independent typing-overlay improvements

These fix the two sharpest edges of the CURRENT workaround and are worth landing
regardless of (and before) everything above:

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

## Staged implementation plan

1. **Fold-ins** — `holdToFrameEnd`; baseline anchor. Small, independent,
   landable immediately. (days)
2. **Caret + selection track** — standalone primitive per the section above.
   **Shipped** — `docs/101-caret-selection-track.md`: node-side addressing
   over captured `xOffsets` (`src/animation/text-address.ts`), the caret /
   selection emission (`src/animation/caret-track.ts`), and the
   `AnimationConfig.textTracks` wiring, verified by rasterized-SVG e2e. Its
   declarative config sugar lands with stage 4.
3. **Compressor v1** — the opt-in run block: maximal marked continue+cut runs →
   per-line order-preserving glyph alignment (LCS on (char, fill), tight position
   tolerance, re-emit on any doubt) → union emission at birth positions +
   step-end opacity/translate/fill tracks → auto-caret from per-state edit
   points → one nested animated SVG. Pairing-ratio logging. Committed golden.
   (~1–2 weeks)
4. **Config surface** — the run-block sugar + caret/selection overlay schema,
   validation, JSON-Schema regeneration, docs/43 cross-reference, examples.
5. **Flagship validation** — rebuild the kerf getting-started editor phases on
   runs + caret/selection; compare size and frame-by-frame visual parity against
   the shipped SVG (rasterize the actual output, per the verify-the-SVG rule);
   write the page-rig cookbook from the rebuilt flagship; fold findings back
   here and flip this doc's status.

## The superseded alternative — the synthetic document model + op timeline

The original design core: a `richTexts` config registry (styled spans, named
styles, gutter, fixed line grid), an op vocabulary (`type` / `delete` / `select`
/ `replace` / `restyle` / `insertLine` / `caretTo` / …) with `{line, col}`
addressing, compiled to a bespoke glyph-path renderer with identity-tracked
segment waypoints. What it bought over the adopted design: config-only authoring
(no capture page at all), an op vocabulary friendly to generator scripts,
per-keystroke humanization (jitter/mistakes) as compiled timing, and byte-stable
output independent of a browser run. Why it lost: 2–3× the build cost across a
document model + reducer + plan compiler + renderer; its hardest edge is
matching a synthetic text renderer against real page text at every handoff —
precisely the class of fidelity risk the adopted design cannot have, because
compressed pixels always come from captures. The op surface remains available
later at low risk: ops can **compile to page states + a compressed run** instead
of to a bespoke renderer, if config-only authoring is ever wanted.

## Related

- `docs/101-caret-selection-track.md` — the SHIPPED caret + selection track
  (Primitive 2 above): addressing engine, event vocabulary, emission model,
  z-order contract, and v1 limits.
- `docs/93-realistic-typing.md` — the typing overlay (measured advances, shared
  reveal plan, glyph paths, `typeResample`); the fold-ins land there.
- `docs/97-caret-shapes.md` / `src/animation/caret-metrics.ts` — shared caret
  geometry the caret track reuses.
- `docs/67-terminal-capture.md` / `src/terminal/incremental.ts` — the
  identity-tracked incremental composition model the compressor generalizes.
- `docs/43-declarative-animate-config.md` — the animate config the run-block and
  caret/selection surfaces extend.
- `docs/08-animation-model.md` — the frame/transition model the run block nests
  into (typeResample/cast/scroll precedent).
- `docs/84-viewer-browser-support.md` — the cross-engine animation constraints
  (CSS opacity/transform/fill only; no SMIL).
