# 100 — Rich-text typing & editing: captured states + compression + caret/selection tracks

Status: **Primitives 1 + 2 shipped (engines + declarative config surface);
flagship validation remains.** The caret + selection track is implemented —
see `docs/101-caret-selection-track.md` — the frame-sequence compressor's v1
engine is implemented — see "Shipped engine (v1)" under Primitive 1 below —
and the declarative config surface is shipped: the `states: [...]` run block
(+ `caret` auto-caret) and the `textTracks: [...]` caret/selection tracks in
the animate config, docs/43 §11–12, with the committed golden example
`examples/animate/compressed-run/`. The fold-ins shipped earlier. This is the
requirements +
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
invariant. Authoring (decided at build time): the **`states: [...]` block**
inside one config frame — per-state actions + hold durations, state 0 being
the frame's own post-actions state — shipped as the surface (docs/43 §11).
The alternative `compress: true` form stamped across a run of ordinary
consecutive continue+cut frames was NOT built: collapsing N config frames into
one animation frame re-indexes every frame-addressed feature (cursor events,
transitions, magic-move bridges, frame trees), which breaks the invariant the
block form preserves for free. It remains a candidate follow-up on top of the
same machinery (tracked locally).

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

### Shipped engine (v1): `composeCompressedRun`

The v1 engine is `composeCompressedRun(states, opts)` in
`src/animation/compressed-run.ts` (public export), with the per-line aligner
in `src/animation/glyph-align.ts` (`alignLineGlyphs`, also public). It takes N
captured trees + per-state hold durations and returns `{ svg, durationMs,
pairingStats, edits }` — one self-contained nested animated SVG, embedded as a
single outer animate frame's `svgContent` with `embeddedAnimationPeriodMs:
durationMs` (the typeResample/cast precedent; zero animator changes). The
declarative run-block sugar is the config-surface stage below.

**Mechanism.** The output is three layers, all rendered through the production
`elementTreeToSvgInner` pipeline:

1. **Chrome layer** — each state's tree minus the text the glyph layer owns,
   merged into one union tree by element-level pairing on byte-equality of the
   captured records (a sound under-approximation of rendered-markup equality:
   the renderer is a pure function of captured element + id prefix). Shared
   subtrees emit once; anything unequal re-emits as a sibling variant gated by
   a `step-end` `display` track (the cull pass's `display: inline ↔ none`
   mechanism — chosen over opacity so the track can't fight a baked
   captured-opacity wrapper). z-order inside chrome is exact.
2. **Glyph layer** — per-line glyph identities threaded across all N states
   (the terminal composer's TrackedLine model one level down). Adjacent states
   align per line via order-preserving LCS on (char, style-key) — fill is
   ignored for pairing and diffed into a recolor track; exact painted
   positions win ties; lone shifting glyphs are demoted to re-emission
   (re-emit on any doubt; because every track is step-end, pairing quality
   affects only bytes, never pixels). Identities sharing a lifetime, line,
   style, shift timeline, and fill timeline coalesce into one **group**: a
   synthetic text-only element (box paint neutralized) holding the group's
   characters at their birth-state captured `xOffsets` — the mid-segment
   split is exact by construction. Groups ride up to three `step-end` tracks:
   opacity (birth/death), `translateX` (per-state waypoints), and `fill`
   (applied to the group's descendants, where a CSS animation outranks the
   `fill` presentation attribute). Keyframe bodies and animation lists are
   content-deduped across groups.
3. **Auto-caret** (opt-in `caret: true | { shape, color }`, default off) —
   the pairing pass knows each state's edit point (after the rightmost typed
   glyph; at the close-up x of a deletion), emitted through the docs/101
   caret-track machinery. The detected `edits` are also returned.

The glyph layer paints above the merged chrome. That yields true editor
z-order (selection-style box paint lands *behind* the glyphs), guarded by an
occlusion check: text only joins the glyph layer when no box-painting element
that paints after it (document order, or any non-auto z-index) intersects its
rects — otherwise the text stays in chrome and flipbooks. Further eligibility
guards (each demotes to chrome, never wrong pixels): captured `xOffsets`
present, horizontal LTR simple-script text only (no complex shaping across a
split), no decorations / shadows / strokes / emphasis / gradient fills / raster
overlays, no transform / filter / mask / clip / blend / sub-1 opacity on the
element or an ancestor, and text rects fully inside every overflow-clipping
ancestor.

**Pairing-ratio logging.** Every run logs one line via `opts.log`:
`compress: run of N states, X% glyphs paired, Y KB → Z KB` (raw = the N states
rendered independently, i.e. the flipbook frame payload; both sides exclude
the shared `@font-face` block). `pairingStats` carries the full breakdown
(paired %, births/deaths/recolors, group + chrome-track counts, byte sizes).

**Measured (the rasterized e2e, `tests/compressed-run.e2e.test.ts`).** A
12-state run on the evaluation's editor page (10-keystroke mid-line insert +
colorize-on-completion): **99.6% glyphs paired, 135.6 KB → 46.6 KB (34%)**,
and the composed SVG — embedded through the real outer-frame
`embeddedAnimationPeriodMs` path — rasterizes **pixel-identical to the
uncompressed flipbook at every one of the 12 states** (`regionCount === 0`),
with the tail verified to shift by exactly one advance per keystroke, the
prefix pixels byte-stable across all typed states, and the recolor landing in
place.

**v1 limitations** (each degrades to re-emission or is documented, never wrong
pixels): no cross-line identity (a vertically-moved line re-emits — automatic
run detection and line-move tracking are follow-ups); states are captured
statics (intra-frame animations / per-state cursor-overlay addressing inside a
run are unsupported — editing runs have no pointer); coding-ligature fonts may
unligate across a split boundary (positions stay exact; the glyph shape at the
boundary may differ from a ligated paint); no viewBox culling *inside* the run
(the outer animator still culls the frame as one unit); the default
embedded-font render mode is assumed (`paths` mode's glyph-defs registry is
not deduped across the compressor's internal renders); chrome variants don't
reopen (an A→B→A blink pattern emits A twice).

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
   goldens byte-identical). **Shipped** — see the parameter table in
   [93-realistic-typing.md](93-realistic-typing.md) and docs/43 §5.
2. **Baseline anchor mode** for typing overlays — `anchor.baseline: true` makes
   the resolved `y` the anchored element's **first-line text baseline** instead
   of its border-box top. `resolveAnchoredOverlays` already measures the
   element's computed font; this adds a page-side baseline measurement (canvas
   `fontBoundingBoxAscent` + the line-box placement math `measureCaret` in
   `src/cli/type-resample.ts` already implements) so the overlay's `y` — which IS
   the typed text's baseline in `renderTypingOverlay` — lands exactly on the
   page text's baseline. Kills the hand-tuned `dy ≈ 11.5` ascent constant.
   **Shipped** — see "Baseline anchor" in
   [93-realistic-typing.md](93-realistic-typing.md) and docs/43 §5; the shared
   placement math is `firstLineBaseline` in `src/animation/caret-metrics.ts`.

## Staged implementation plan

1. **Fold-ins** — `holdToFrameEnd`; baseline anchor. Small, independent,
   landable immediately. (days) **Both shipped** — see the Fold-ins section
   above.
2. **Caret + selection track** — standalone primitive per the section above.
   **Shipped** — `docs/101-caret-selection-track.md`: node-side addressing
   over captured `xOffsets` (`src/animation/text-address.ts`), the caret /
   selection emission (`src/animation/caret-track.ts`), and the
   `AnimationConfig.textTracks` wiring, verified by rasterized-SVG e2e. Its
   declarative config sugar lands with stage 4.
3. **Compressor v1** — **Shipped (engine)** — see "Shipped engine (v1)" above:
   `composeCompressedRun` (`src/animation/compressed-run.ts` +
   `src/animation/glyph-align.ts`), verified by aligner/threading unit tests, a
   transition-matrix sequence test, and the rasterized pixel-parity e2e.
4. **Config surface** — **Shipped** — the `states: [...]` run block (per-state
   actions + hold durations, `caret` auto-caret, pairing-ratio logging) and the
   `textTracks: [...]` caret/selection tracks (capture-time selector stamping →
   `data-domotion-anim` → node-side address resolution, frame-relative `at`
   mapped to global time) in `src/cli/animate.ts`; docs/43 §11–12 are the
   authoring reference. JSON Schema regenerated; validated by schema unit tests
   plus the rasterized config e2e (`tests/compressed-run-config.e2e.test.ts`)
   and the committed golden example `examples/animate/compressed-run/` (a
   mid-line insert + colorize run with the auto-caret riding it, then a
   declarative caret park/move + selection sweep).
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
