# 100 — Rich-text typing & editing: captured states + compression + caret/selection tracks

Status: **Shipped end to end — primitives, config surface, and the flagship
validation.** The caret + selection track is implemented
(`docs/101-caret-selection-track.md`); the frame-sequence compressor's v1
engine is implemented ("Shipped engine (v1)" under Primitive 1 below); the
declarative config surface is shipped: the `states: [...]` run block
(+ `caret` auto-caret) and the `textTracks: [...]` caret/selection tracks in
the animate config, docs/43 §11–12, with the committed golden example
`examples/animate/compressed-run/`. The fold-ins shipped earlier. The stage-5
flagship validation is complete: the kerf getting-started EDITOR phases are
rebuilt on the new primitives as the committed golden
`examples/animate/editor-session/` with a rasterized-SVG proof suite
(`tests/editor-session.e2e.test.ts`) and measured numbers — see "Flagship
validation results" below — and the authoring recipe is written up as
`docs/102-editing-page-rig-cookbook.md`. Automatic run detection is now shipped
behind the opt-in `autoCompress` flag (below). Behind-glyph selection (the
`selection` option on `composeCompressedRun`), cross-line identity for
vertically-moved lines, paint-order-accurate occlusion demotion, and
chrome-variant reopen are also shipped — see Primitive 1 below. Remaining
items are the filed follow-ups (locally tracked): the complex-interaction cases
auto-detection excludes (per-frame overlays/cursor/magic-move crossing a run),
the multi-frame `compress: true` form, and the caret-track addressing limits
(docs/101 v1 limits).
Since then, **automatic run detection has shipped behind an opt-in flag**
(`autoCompress`, DM-1757 — see "Placement" below and docs/43 §13): the pre-pass
collapses maximal `continue` + `cut` runs into `states` runs automatically,
default OFF, pending a decision to flip the default. This is the requirements +
design reference for making editor-style typing/editing sequences (an IDE window
typed into and edited, with syntax coloring, selection, mid-line inserts that
reflow trailing text) first-class in the animate pipeline. Plain text is the trivial case, so this covers
"animate text being typed and edited" generally.

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
run-scoped identity tracking, not a pairwise A→B effect), and — originally — an
*automatic pass over all continue+cut runs* (right long-term, but it changes
every existing config's output shape; deferred until the machinery was proven
behind the opt-in).

**Automatic pass — shipped behind `autoCompress` (DM-1757).** Now that the
`states` machinery is proven, the automatic pass is implemented as an opt-in
top-level flag (`autoCompress: true`, or `--auto-compress`; docs/43 §13). It
does NOT need "shared-content groups spanning frame windows": rather than
collapsing at the animator level, it is a **config pre-pass** that rewrites each
maximal `continue` + `cut` run into a single `states` frame *before* the capture
loop — so it reuses the block form's machinery verbatim and keeps the 1
config-frame ↔ 1 animation-frame invariant that the block form preserves for
free (the reindexing of `frameStartsMs` / cursor `events[].frame` falls out of
operating on the rewritten config; explicit cursor events are remapped onto the
collapsed indices). Output is pixel-identical to the flipbook (verified in
`tests/auto-compress.e2e.test.ts`). It **defaults OFF** because flipping it on
changes the output shape of every config with such a run; the default-flip is a
separate, deliberate decision (see "Default-flip recommendation" below). v1
compresses only the safe simple case (pure continue+cut runs with no
overlays/animations/textTracks/forceState/cursor-in-run/magic-move-entry
crossing them); everything else is left uncompressed with a logged reason, and
the complex-interaction cases are a tracked follow-up.

**Default-flip recommendation (DM-1757).** Flip `autoCompress` to default-ON
only after: (1) the excluded complex-interaction cases (per-frame overlays,
cursor events, and magic-move transitions *inside* a run) are either handled or
the exclusion set is proven complete against the real config corpus; (2) a
size-regression guard confirms no config's raw output GROWS (a wholesale-change
run pairs poorly and re-emits from chrome — correct pixels, but ≈ flipbook +
nesting overhead, so a slideshow-shaped run could get marginally larger); and
(3) every committed golden is regenerated in one reviewed pass (the flip shifts
the output shape of any golden that contains a compressible run — expected, not a
regression). The risk surface is exactly "changes every existing config's
output": frame-count, nesting, and any frame-addressed feature crossing a run.
Until then it stays opt-in.

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
2. **Cross-line identity** — line buckets are paired across states even when a
   whole line MOVED vertically (an insertLine pushing later lines down, a wrap
   point moving), so a moved line rides a `translateY` waypoint instead of
   dying and re-birthing. Two order-preserving phases: each live line claims
   the next-state line with EQUAL content signature (char + style key +
   x-relative-to-line-start) at the nearest |Δy|, preferring Δ=0 — so unmoved
   lines stay put, moved lines match at their shift, two identical lines each
   prefer their own y (no invented crossing), and a mid-file insert with mixed
   Δ=0 / Δ=+lineHeight needs no global scroll detection; then a line whose
   content CHANGED pairs at the same y (in-place edit) or at a Δ established by
   its moved siblings (a line that moved AND was edited in the same state),
   with the per-glyph LCS sorting out the edit. Measured on a 5-line insertLine
   fixture: pairing 53.8% → **84.6%**, deaths 28 → **0**, emitted groups 20 →
   **6**, run bytes 7,490 → **3,054** (2.45× smaller; the run goes from 1.93×
   LARGER than the raw flipbook body to 0.79× of it).
3. **Glyph layer** — per-line glyph identities threaded across all N states
   (the terminal composer's TrackedLine model one level down). Adjacent states
   align per line via order-preserving LCS on (char, style-key) — fill is
   ignored for pairing and diffed into a recolor track; exact painted
   positions win ties; lone shifting glyphs are demoted to re-emission
   (re-emit on any doubt; because every track is step-end, pairing quality
   affects only bytes, never pixels). Identities sharing a lifetime, line,
   style, shift timeline, and fill timeline coalesce into one **group**: a
   synthetic text-only element (box paint neutralized) holding the group's
   characters at their FINAL-state captured `xOffsets` — the mid-segment
   split is exact by construction. Groups ride up to three `step-end` tracks:
   opacity (birth/death), `translateX` (per-state waypoints), and `fill`
   (applied to the group's descendants, where a CSS animation outranks the
   `fill` presentation attribute). The `translateX` track is anchored at the
   final state and runs BACKWARD for earlier states, so **rest = identity at
   the run's end**: the held final state — the only one a following frame cuts
   against at the run's exit — carries no composed transform, so the exit is
   byte-identical to the same DOM painted directly (the "animations rest at
   identity" house rule; the transform-composed AA moves onto the transient
   earlier states, which nothing compares against). Keyframe bodies and
   animation lists are content-deduped across groups.
4. **Auto-caret** (opt-in `caret: true | { shape, color }`, default off) —
   the pairing pass knows each state's edit point (after the rightmost typed
   glyph; at the close-up x of a deletion), emitted through the docs/101
   caret-track machinery. The detected `edits` are also returned.
5. **Behind-glyph selection** (opt-in `selection: CompressedRunSelection |
   CompressedRunSelection[]`, default off) — docs/101 selection rects
   (`resolveRangeRects`) resolved against each selection's appear-state
   captured tree and emitted **into the chrome↔glyph layer gap**, so the
   highlight paints BEHIND the glyph ink — true editor selection z-order,
   which only the run's merged emission can give (a standalone `textTracks`
   selection paints ABOVE the text; docs/101 documents both modes). Each spec
   is `{ target, charStart, charEnd, state?, clearState?, sweepMs?, color? }`;
   the range resolves on Chromium's painted glyph edges. Config-surface
   exposure of this option is tracked separately.

The glyph layer paints above the merged chrome (with selection rects, when
requested, interleaved just below it). That yields true editor z-order
(selection-style box paint lands *behind* the glyphs), guarded by an
occlusion check: text only joins the glyph layer when no box-painting element
that paints after it intersects its rects — otherwise the text stays in chrome
and flipbooks. "Paints after" is the renderer's REAL paint order
(`paintOrderHitSequence`, the same `gatherStackingContextChildren` /
`sortChildrenByPaintOrder` traversal `elementTreeToSvg` emits with: stacking
contexts, z-index buckets, float/inline hoisting, viewport-fixed pull,
preserve-3d re-sort), and candidate occluders are intersected with their own
overflow clips first. So a later-in-DOM negative-z-index underlay correctly
does NOT demote the text, and a clipped-away overlay does not either — both of
which the earlier DFS-order-plus-"any non-auto z-index occludes" approximation
got wrong (conservatively, but at a real cost in compression). Further eligibility
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
pixels): states are captured
statics (intra-frame animations / per-state cursor-overlay addressing inside a
run are unsupported — editing runs have no pointer); coding-ligature fonts may
unligate across a split boundary (positions stay exact; the glyph shape at the
boundary may differ from a ligated paint); no viewBox culling *inside* the run
(the outer animator still culls the frame as one unit); the default
embedded-font render mode is assumed (`paths` mode's glyph-defs registry is
not deduped across the compressor's internal renders). Chrome variants DO
reopen: a subtree that reappears byte-identical after an absence (an A→B→A
blink) gains a second visibility window on its existing emission instead of a
duplicate variant, with the whole reopened subtree's windows kept in lockstep.
The one deliberate hold-back is positional: a variant only reopens when it
already sits inside the insertion range the reappearing element would occupy,
so a reopen can never reorder paint — otherwise it re-emits (re-emit on any
doubt).

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
needed where reflow actually happens. The documented page-rig recipe (a small
reusable snippet the `S`/`ins`/`rep` helpers could have been copied from) is
`docs/102-editing-page-rig-cookbook.md`, written from the rebuilt flagship.

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
5. **Flagship validation** — **Shipped** — see "Flagship validation results"
   below: the rebuilt editor phases (`examples/animate/editor-session/`), the
   rasterized proof suite (`tests/editor-session.e2e.test.ts`), the measured
   size/DOM/granularity numbers, and the page-rig cookbook
   (`docs/102-editing-page-rig-cookbook.md`).

## Flagship validation results (stage 5)

The kerf getting-started EDITOR phases, rebuilt on the primitives above as the
committed golden `examples/animate/editor-session/` (11 config frames): five
lines typed via `holdToFrameEnd` + `anchor.baseline` overlays handing off to
real page text at cuts, the ` computed,` mid-line insert as a 12-state
compressed run, the `"btn"` selection as a declarative `textTracks` sweep, the
`"btn"` → `{cls}` replacement as a 7-state run, and colorize-on-completion as
a paired recolor state inside each run. The entire old workaround stack —
cover rects, per-line reveal animations, the hand-tuned `BASELINE_DY ≈ 11.5`,
page-side caret spans, page-side selection markup — is gone from the page,
which now carries only the ~20-line state-stepping rig documented in doc 102.

**Rasterized proof** (`tests/editor-session.e2e.test.ts`, 11 assertions over
the composed SVG): the typed-line handoff at a `holdToFrameEnd` cut is
ink-bbox-continuous; the trailing text shifts by exactly one advance per
keystroke while the prefix stays byte-stable across states; the colorize and
`{cls}` recolors land in place (amber appears, glyph bbox unchanged); the
selection sweeps per painted character edge and clears at the cut; the track
caret and both runs' auto-carets sit on the captured glyph edges; and both
run exits are byte-identical against the following frame's page text (both
the zero-net-shift replace exit and the insert exit — the latter now that
groups rest at identity at the run's end, so the held final state has no
composed transform; zero pixels differ beyond the independent-rasterization
AA floor at both exits).

**Measured** (vs the same phases built the old way as a throwaway config;
full table + reading in doc 102): the runs themselves compress 121.1 → 22.8
KB and 88.5 → 19.4 KB (5.3× / 4.6×, pairing 99.4% / 99.6%) — the predicted
~5×. Whole-file at matched per-keystroke granularity: 184.1 KB vs 336.9 KB
raw (1.8×), 2,284 vs 5,236 live DOM elements (2.3×), gzip ~1× (30.0 vs 31.4
KB) — the whole-file ratio is diluted here because the scene is one small
window and the typed-line phase costs the same on both stacks; the shipped
kerf file's 91%-redundant 37-frame desktop payload is where the ~5.2×/~9×
projection above applies. Per-keystroke granularity came out CHEAPER than the
old per-2-char compromise (184.1 vs 257.7 KB raw). Authoring cost: ~4.9 s to
compose the 11-frame config including all 19 state captures (~5.1 s and
~7.8 s for the old-way variants).

**Fixed during the rebuild** (both invisible until a states run sat at
t > 0 / carried a re-tokenization):

- The run's auto-caret free-ran on its local clock: the caret/selection track
  declares its animations INLINE on its rects/groups, and the embed-timeline
  re-anchor pass only rewrote `<style>` contents — correct only when the host
  frame started at t = 0. `offsetEmbeddedAnimatedSvgTimeline` now retimes
  inline `style="animation:…"` declarations too (all modes).
- A recolor-only state (the colorize) derived an "edit point" from its
  whitespace churn — spaces re-segmenting across the new token spans — and
  yanked the caret to the recolor site. The edit-point derivation now skips
  states whose only births/deaths are whitespace while glyphs recolored, so
  the auto-caret holds at the previous edit (a tokenizer catching up does not
  move a real editor's caret). Typing a literal space still derives an edit.

**Authoring caveats found** (recorded in doc 102): a `textTracks` caret and
selection hold their final state through the loop and layer above every
frame — this originally required ending every track by hand with
`clearSelection` + `hide` at the frame's cut. Since DM-1763 the CLI
synthesizes that terminal `clearSelection` + `hide` at the frame's `duration`
by default (config tracks are per-frame), so a parked caret no longer haunts
later frames without author action; `persist: true` opts out for a deliberate
carry-over (docs/43 §12). And track addressing covers the element's OWN text
runs only, so a selection over a token targets the token span
(`[data-line='6'] .str`), not the line.

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

- `docs/102-editing-page-rig-cookbook.md` — the authoring recipe written from
  the rebuilt flagship: the two blessed patterns (typed reveal, per-state
  editing pages), the reusable page rig, and the measured comparison table.
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
