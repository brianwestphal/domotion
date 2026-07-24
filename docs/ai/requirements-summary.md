# Requirements summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read
for behaviour contracts. Like `code-summary.md`, it points at the canonical
docs rather than duplicating them.

## The contract surface

Domotion's contract with consumers is "the SVG renders pixel-faithful to
Chromium-on-this-platform at 1×, embeds without external assets, and scales
crisply at any size." That's enforced by the visual-regression suites
(`features.ts`, `showcase.ts`, `html-test-suite.tsx`, `real-world.tsx`) and
documented per-feature in the numbered `docs/` set.

## Read these for behaviour contracts

1. **`docs/README.md`** — index of every numbered doc. Browse by topic
   (fidelity, writing-mode, gradients, animation, scroll, fonts, …).
2. **`FEATURES.md`** — per-feature support checklist with fixture links.
   Keep in sync when fixtures land.
3. **Doc 01 (`docs/01-fidelity.md`)** — the overarching fidelity
   contract. What's in scope, what isn't, what tolerance applies.
4. **`tests/feature-coverage.ts`** — the machine-checkable feature index
   (behavior → export/verb → asserting test), the orthogonal-to-line-coverage
   axis. `npm run check:features` (+ the `tests/conventions.test.ts` mirror in
   `npm test`) flags any behavior with no asserting test, and any new
   export/verb not yet in the index. See **Doc 83** (`docs/83-feature-coverage.md`)
   — and the `CLAUDE.md` "Testing Philosophy" note that line coverage ≠ behavior
   coverage, and stateful modules must test *transitions*.

## Always-in-sync docs

Some docs ARE the canonical reference for a user-facing surface — if the
code changes and the doc doesn't, consumers get a misleading contract.
Update these in the same commit as any change that touches the surface
they describe (see `CLAUDE.md` "Documentation"):

- **`docs/37-scroll-pattern-grammar.md`** — canonical EBNF + semantics for
  the scroll-pattern language. Any change to `src/scroll/pattern.ts`,
  `src/scroll/executor.ts`, or scroll-related CLI flags must update doc
  37 too.

## Recent additions worth knowing about

- **Doc 101 (`docs/101-caret-selection-track.md`, DM-1744/DM-1747/DM-1756/DM-1754/DM-1753)** —
  **Shipped** (engine + programmatic wiring + the declarative config surface:
  per-frame `textTracks: [...]` with capture-time selector stamping and
  frame-relative `at` times, docs/43 §12; mixed-content subtree addressing,
  DM-1756; logical-order bidi/RTL addressing, DM-1754; vertical writing modes,
  DM-1753).
  The caret + selection track from doc 100's "Primitive 2", standalone
  (not gated on the compressor): node-side addressing of `{ target,
  charOffset }` / ranges against the captured tree (code-point offsets over
  per-code-unit segment `xOffsets` — Chromium's painted x; baseline from
  captured `fontAscent`; input-value synthesis for form fields; fontkit
  advance fallback). DM-1756: an address resolves over the target's whole
  SUBTREE — mixed content (`<p>plain <b>bold</b> tail</p>`, a tokenized code
  line's colored token `<span>`s) is one logical string whose offsets/ranges
  span the descendants, with reading order reconstructed from painted geometry
  (baseline line-banding, then x); the single-element / input-value paths are
  preserved byte-for-byte (the merge only runs when a descendant contributes a
  run). Resolved caller-side into `AnimationConfig.textTracks`
  and emitted as global-timeline CSS: step-end caret waypoints with
  `caretShapeRect` geometry (bar/block/underscore, docs/97), the standard
  ~1.06 s blink on a nested group, and per-run selection rects swept by
  width keyframes through the exact per-char painted edges (cleared on
  command; translucent-blue default). Two z-order modes: a standalone
  `textTracks` selection paints ABOVE the text (highlight-marker look);
  behind-glyph editor selection is shipped via the compressor's merged
  emission (the `selection` option on `composeCompressedRun`, DM-1758,
  rasterized-proven the glyph ink shows through). Opt-in block-caret **glyph
  inversion** (`invert`, DM-1755): a solid block with the covered character
  re-emitted on top in the inverse ink (`invertTextColor`, default white) via
  `renderTextAsPath` in paths mode, per-waypoint layers that swap the covered
  glyph as the caret moves and blink together — the terminal/editor block-cursor
  look; additive/byte-identical when off. DM-1754: **logical-order addressing
  over RTL / bidi runs** — offsets map through `bidi-js` embedding levels
  resolved over the element's whole concatenated logical text (the renderer's
  `applyBidiAt` precedent), so an RTL caret sits on the addressed character's
  RIGHT edge (`rtl` on the point; `caretShapeRect` mirrors block/underscore
  cells about it) and a logical range emits ONE RECT PER BIDI LEVEL RUN in
  logical order, each sweeping in its own direction (an RTL rect grows leftward
  under a static mirror transform). Calibrated against Chrome's own selection
  paint: rect-for-rect agreement with `Range.getClientRects()` (≤1px over 11
  ranges) and pixel-span agreement between the composed SVG's ink and Chrome's
  `::selection` (≤2px), including a visually discontiguous logical range.
  Pure-LTR text is byte-identical. DM-1753: **vertical writing modes**
  (`vertical-rl` / `vertical-lr` / `sideways-*`) are addressable through the same
  offsets with the axes swapped — caret x from the column, y from the captured
  `yOffsets`, end-of-text at the column's bottom edge, `caretShapeRect`'s
  quarter-turned variant (horizontal `bar`, column-cell `block`, `underscore`
  down the column's left edge — the side Chrome paints a vertical underline on),
  selection rects spanning the column and sweeping via `height` keyframes, and
  column banding (block-flow order, top-to-bottom within a column) for mixed
  content. Scoped out + documented: one writing axis per address (an
  opposite-axis descendant contributes no runs), bidi INSIDE vertical text, and
  block-`invert` glyph repaint on vertical text (degrades to the translucent
  block). Verified by a rasterized-SVG e2e
  (caret ink at resolved x ±1.5px, sweep growth, hide; block-invert solid-block
  + inverse-glyph + waypoint swap) plus the bidi calibration e2e and a vertical
  e2e that checks Chrome's own column geometry at every offset and rasterizes a
  horizontal caret bar + a downward-growing selection sweep.

- **Doc 102 (`docs/102-editing-page-rig-cookbook.md`, DM-1748)** —
  **Shipped.** The authoring cookbook written from the rebuilt flagship
  (`examples/animate/editor-session/`): the two blessed patterns —
  (a) **typed reveal** (real page text + `holdToFrameEnd` +
  `anchor.baseline`, no cover rects / reveal choreography / ascent
  constants) and (b) **per-state editing pages** (a ~20-line reusable
  `window.state(i)` page rig + the `states:`/`caret`/`textTracks` config
  side) — plus the honest guidance: what stays page-side (the page is the
  document model), reading the pairing-ratio log, when to stay with plain
  flipbook frames, and the measured new-vs-old comparison table (runs
  compress 5.3×/4.6×; whole-file 1.8× raw / 2.3× fewer live-DOM elements at
  matched per-keystroke granularity, gzip ~1×).

- **Doc 100 (`docs/100-rich-text-editing.md`, DM-1739)** — **Shipped end to
  end (engines + the declarative config surface, DM-1747: the
  `states: [...]` run block with `caret` auto-caret, docs/43 §11, golden
  `examples/animate/compressed-run/`; and the DM-1748 flagship validation:
  `examples/animate/editor-session/` + the rasterized proof suite
  `tests/editor-session.e2e.test.ts` + doc 102 — remaining items are the
  filed follow-up tickets)**. Editor-style typing/editing sequences, redesigned (7/23) around
  captured states rather than a synthetic document model: the capture page stays
  the document model (per-state continue+cut frames — real reflow, real syntax
  coloring), and two primitives fix that model's measured costs: (1) the
  **frame-sequence compressor** (DM-1745, **shipped engine**:
  `composeCompressedRun` in `src/animation/compressed-run.ts` + the
  order-preserving per-line LCS aligner in `src/animation/glyph-align.ts`) —
  an opt-in run block composed as one nested animated SVG (typeResample
  placement via `embeddedAnimationPeriodMs`, zero animator changes) that
  threads per-line glyph identities across the N states over captured
  `xOffsets` and emits each once on step-end opacity/translate/fill tracks,
  with a chrome union (element-level byte-equality pairing, display-windowed
  variants) beneath the glyph layer and an opt-in auto-caret from the detected
  edit points; unpaired/ineligible content re-emits — graceful degradation,
  never wrong pixels; one-line pairing-ratio log per run. Measured on the
  12-state editor e2e: 99.6% glyphs paired, 135.6 KB → 46.6 KB (34%), and
  pixel parity with the uncompressed flipbook at every state. That parity bar
  is **shift-inclusive and stricter than the fidelity sweeps'** (DM-1766, one
  helper `tests/flipbook-parity.ts` behind every compressed-run e2e assertion
  site): `regionCount === 0` alone suppresses large-but-low-severity components,
  so a paint-order flip measured 3712 differing pixels and still scored
  `clean` — the bar now also bounds the comparator's new `strictRegionCount` /
  `strictRegionArea` / `strictMaxRegionArea` aggregates (doc 12). Calibrated on
  ALL platforms with ONE cap set (DM-1769): the earlier macOS-only limit was the
  fixtures measuring the host's text antialiasing — Chrome skips LCD subpixel
  text inside the composited layers a compressed run's transform groups create —
  so they now rasterize with LCD text off and pin bundled faces
  (`tests/fixture-fonts.ts`), which took the Linux clean ceiling from 829 px
  to 0 px.
  **Independent regions (DM-1770) — discrimination AND per-region timing
  shipped; the per-region size guard is the one piece still open.** Line
  buckets keyed on a segment's y alone merged two side-by-side panes into one
  logical line, so an editor pane and a preview pane at the same vertical
  position defeated each other's pairing (measured: 59.7% paired / 62.7 KB
  against 96.5% / 28.3 KB once separated). Each glyph now carries a **region** —
  the innermost clipping ancestor, else the innermost side-by-side column taller
  than one line box — and bucketing plus both bucket-pairing phases are scoped to
  it; inert on single-region scenes by construction (all 25 animate goldens
  byte-identical). Rasterized coverage: `tests/two-pane-regions.e2e.test.ts`.
  **Per-region timing** (docs/43 §11.1) adds the HYBRID declaration: a `states`
  frame may declare `regions: { <name>: <selector> }` (stamped
  `data-domotion-anim` at capture, overriding the auto-detected discriminator
  only where declared — auto-detection stays the default and still subdivides
  inside a declared region) and tag each state with the region(s) it `advances`.
  Capture stays whole-page; states advancing DISJOINT regions share one capture
  and each state's tree is assembled from the round holding each region's own
  state, so k regions cost `1 + max(nᵢ)` captures against `1 + Σnᵢ` (measured:
  7 states → 4 captures, 11 → 6, 17 → 9, 3 regions × 4 → 5). The assembly's one
  precondition — a region's content may not move anything outside itself — is
  CHECKED (the non-region remainder must be byte-identical across rounds) and
  hard-errors otherwise. Bytes are unchanged either way: timing is an
  authoring + capture-count win, not a payload one (a 3.5× finer state grid
  costs 0.4%). Coverage: `tests/region-timing.e2e.test.ts` asserts the trees
  assembled from 4 rounds BYTE-IDENTICAL to seven sequential captures (the
  page is never driven into the assembled configuration, so this is the only
  exact check available) and then holds the composed run to the uncompressed
  flipbook of those same captures at every state; golden
  `examples/animate/region-timing/`. Still global: the whole-run size guard
  (per-region demotion into the chrome union measures 172.1 KB → 83.2 KB where
  today's guard reverts to a 97.8 KB flipbook; deciding it on real bytes needs
  speculative composition, and the render-layer half of that now **ships** —
  `snapshotGeneration()` / `restoreGeneration()` roll the embedded-font subset
  builder AND the paths-mode glyph-defs registry back to a marker, so a trial
  compose measured for its real byte size leaves the output composed afterward
  byte-identical, doc 99 § speculative composition), and per-run eligibility.
  And (2) a **caret + selection track** — declarative
  caret/selection anchored node-side to captured text (`selector` + char offset
  over segment `xOffsets`; `caretShapeRect` geometry; blink + sweep), standalone
  and useful beyond editing. The original document-model + op-timeline core is
  recorded as a superseded alternative (ops could later compile to states + a
  compressed run). Includes two small independent fold-ins on the existing
  `typing` overlay: `holdToFrameEnd` (opt out of the forced 150 ms end-of-frame
  fade) and a baseline anchor mode (`anchor.baseline: true`).
  **Automatic run detection (DM-1757) — shipped behind an opt-in flag,
  default OFF.** `autoCompress: true` (or `--auto-compress`; docs/43 §13) runs a
  config pre-pass in `composeAnimateFrames` that collapses maximal consecutive
  `continue` + `cut` runs into `states` frames — reusing the block machinery
  verbatim, so the 1 config-frame ↔ 1 animation-frame reindexing (frameStartsMs,
  cursor `events[].frame` remap) falls out of operating on the rewritten config.
  Output is pixel-identical to the flipbook (`tests/auto-compress.e2e.test.ts`);
  the win is raw size + live-DOM weight. It compresses runs with no
  overlays/animations/textTracks/forceState crossing them; anything else is left
  uncompressed with a logged reason.
  **Sub-run splitting + size-regression guard (DM-1764) — shipped.** The three
  interaction exclusions (an explicit cursor event addressing a member, an
  interaction action a `cursor: "auto"` pointer would come from, a magic-move
  landing on the anchor) now SPLIT the candidate window instead of dropping it:
  that frame stays a plain sibling frame and the eligible sub-runs on either side
  collapse, so one bad frame costs one frame. And because compression is
  pixel-identical but NOT unconditionally smaller (measured: a per-char typing
  run composes at 0.61× its uncompressed payload, a wholesale-change slideshow at
  2.36×), a run the AUTOMATIC pass created is compared against the same states
  rendered uncompressed and reverted when it lost — `composeStatesFlipbook` in
  `src/cli/animate.ts`, same nesting + same pixels, so `autoCompress` can never
  make output bigger (`tests/compress-size-guard.e2e.test.ts`). A run the AUTHOR
  asked for is warned about, never rewritten. Per-frame overlays inside a run
  stay a split point by evaluation, not omission: overlay lifetime is
  frame-scoped and anchors resolve against the run's LAST state, so preserving
  them needs an explicit per-overlay window + per-state anchor resolution in the
  overlay model (doc 43 §13.1). The default-flip to ON is still a separate
  decision — prerequisite 2 (size guard) is now met, 1 is partly met, and the
  golden regen pass is untouched (doc 100 "Default-flip recommendation").
  **Per-run marker (DM-1761) — shipped.** `compress: true` on a run's anchor
  frame (docs/43 §13.2) collapses that ONE run through the same pre-pass, leaving
  every other frame alone — the surgical counterpart to the whole-config flag,
  for compressing the run that pays for it without changing the config's overall
  output shape. Anchor-only + greedy left-to-right (a marker on a later member of
  the same run is a redundant no-op); `compress: false` opts a frame out of a run
  under either surface. Unlike `autoCompress`, an ineligible marker is a HARD
  ERROR naming the frame + reason (an automatic pass that skips is doing its job;
  a typed marker that silently did nothing would hide a bug). Markers resolve
  before the automatic pass and a collapsed frame carries `states`, so the two
  compose with no double-collapse. Pixel-identity + selectivity proven in
  `tests/compress-marker.e2e.test.ts`. Doc 100's three authoring surfaces
  (`states:` block / `compress` marker / `autoCompress` flag) now all exist.
  **Ergonomics (DM-1763):** a `textTracks` track now auto-ends at its frame's cut
  by default (the CLI synthesizes the trailing `clearSelection`/`hide` at the
  frame duration; `persist: true` opts out) so a parked caret/selection no longer
  haunts later frames — docs/43 §12.

- **Doc 99 (`docs/99-hinted-embedded-subset.md`, DM-1714/DM-1716)** —
  **Shipped.** Embedded-font subsets preserve TrueType hinting: when an
  embedded entry's glyphs all come from one openable sfnt at one axis location
  with no synthetic bake, the ORIGINAL file is hb-subset (`RETAIN_GIDS`, keeps
  `cvt`/`fpgm`/`prep` + per-glyph bytecode) with a PUA→gid cmap injected —
  variable sources (SF Pro, Segoe UI Variable) are fully instanced at the
  run's resolved axis location, dropping `fvar`/`gvar`. Removes the dominant
  (embedded-mode) share of the Windows/Linux hinting floor (~93% diff
  reduction on Windows text fixtures); synthetic/`hvgl`/webfont/mixed entries
  keep the unhinted svg2ttf rebuild. Windows axis pinning adopts DirectWrite's
  RESOLVED axis values (DM-1721): the win32 helper's `family`/`fallback`
  queries report `IDWriteFontFace5::GetFontAxisValues` for variable-face
  matches (named optical subfamilies pin `opsz` at a fixed value at every
  size — Text 10.5 / Display 36), the helper font opens at that location via
  the spec's `variations`, and the win32 helper now implements the `family`
  query so `resolveInstalledFont` works on Windows. `src/render/hb-subset.ts` (wasm binding),
  `embedded-font-builder.ts` (branch), `synth-test-fonts.ts` (deterministic
  test fonts).

- **Doc 98 (`docs/98-glyph-font-compare.md`, DM-1686)** — **Shipped.** The glyph
  font-identity comparator: given two PNG crops of the SAME character (expected
  Chromium paint vs rendered SVG), a deterministic traditional-CV pipeline
  (coverage normalization → symmetric subpixel registration → distance-transform
  outline agreement, coverage-mass, mean-stroke-width, local Δcoverage hotspot,
  edge-orientation histogram, counter topology, adaptive zoning) answers
  CORRECT/INCORRECT on "same font (family/size/weight/style)?" with AA and
  subpixel-phase noise excluded by construction. Calibrated on a 410-pair
  real-font corpus to 353/353 decisive-pair accuracy incl. Helvetica-vs-Arial
  lookalikes. Library `src/review/glyph-compare.ts`; CLI
  `tools/compare-glyphs.ts`; recalibration harness
  `tools/glyph-compare-calibrate.ts`; e2e guard in
  `src/review/glyph-compare.e2e.test.ts`.

- **Doc 97 (`docs/97-caret-shapes.md`, DM-1591)** — **Shipped.** The `typing`
  overlay + `typeResample` carets can be a `bar` / `block` / `underscore` (Blink's
  `CaretShape`). `typeResample` honors the field's computed CSS `caret-shape` by
  default (`caretShape: "auto"`) or takes a forced shape; the `typing` overlay
  takes `caret.shape`. Shared geometry in `caret-metrics.ts` (`caretShapeRect`):
  block = translucent (0.5) cell-wide box, underscore = thin baseline bar. Since
  Blink only paints a caret with OS focus, these are author-driven animation
  surfaces (spec-faithful, not Chrome-pixel-compared). Committed demo
  `examples/animate/caret-shapes/`.

- **Doc 96 (`docs/96-native-svg-image-inlining.md`, DM-1588)** — **Shipped.** An
  `<img src="*.svg">` inlines as a native, positioned, id-namespaced nested
  `<svg>` in the output instead of `<image href="data:image/svg+xml;base64,…">`.
  Chromium rasterizes an SVG-in-`<image>` at layout size then scales it (softens
  at zoom); the native inline stays vector-crisp at any scale and drops the ~33%
  base64 bloat. Trigger `resolveSvgSource(el.imageSrc)` (`src/capture/embed.ts`),
  rewrite `inlineImgSvg`/`prefixSvgIds` (`src/render/svg-inline.ts`), emitted from
  `paintImage`. Raster `<img>` (PNG/JPEG/…) unaffected. This is the *inverse* of a
  raster fallback — see `docs/reference/raster-image-fallback-cases.md`. All
  `object-fit` values take the native path (incl. `object-fit: none` at intrinsic
  size, DM-1592). Ids AND CSS class names are namespaced (`prefixSvgIds` +
  `prefixSvgClasses`, DM-1593 — class scoping runs only for `<style>`-bearing
  SVGs). All three SVG-inlining paths share `prefixSvgClasses` (DM-1595): the
  `<img>` inliner (ids + classes), the DOM inline-`<svg>` path (classes only —
  ids stay for the `<use>` resolver), and the animator overlay inliner.

- **Doc 08 motion presets (`docs/08-animation-model.md`, DM-1526)** — **Shipped.**
  A named motion + easing vocabulary on intra-frame animations so authors don't
  hand-tune cubic-beziers. `src/animation/motion-presets.ts`: motion presets
  (`fade`, `fade-up`, `fade-down`, `pop`, `slide-in-<dir>`, `wipe-in`; `exit:true`
  reverses) that expand to `{property,from,to,fuse,easing}`, and easing presets
  (standard eases + `back`/`spring` overshoot → plain `cubic-bezier`, cross-engine).
  Surfaced as `preset`/`easing`/`exit`/`presetDistance`/`presetScaleFrom` on the
  animate config's intra-frame animations (expanded in `expandMotionPreset`), and
  reused by the template reveals (`staggeredReveal`). **Follow-ups shipped
  (DM-1542):** a true multi-oscillation spring baked to CSS `linear(...)` samples
  (`spring-bouncy` / `spring-soft`, `springEasingFn`/`springLinearEasing` in
  `src/animation/easing.ts` — `resolveEasingPreset` returns the `linear()` for
  these), and a `shine` motion overlay on the shared masked-gradient-sweep helper
  `buildShineSweep` (`src/animation/shine.ts`).

- **Doc 88 (`docs/88-transition-effect-expansion.md`, DM-1524)** — **Shipped.**
  SVG-safe inter-frame transitions beyond crossfade/cut/push-left/scroll/magic-move,
  in `src/animation/animator.ts`: directional pushes (`push-right`/`push-up`/
  `push-down` — generalized the slide engine to signed displacement; `push-left`/
  `scroll` byte-identical), a linear `wipe` + expanding-circle `iris` (clip-path
  reveals via `emitRevealFrame`), `zoom-in`/`zoom-out` scale dollies under a
  crossfade, and a `shine` sweep (reuses `buildShineSweep`). All transform + clip-path
  + opacity + gradient (no animated `filter`); wired into the transition enum, the
  generated `animate-config.schema.json`, and `--transition`. **Follow-ups shipped:**
  the `shine` overlay takes a `radius` (rounds its clip to a rounded element) and
  auto-sizes to its anchor (DM-1551/1549); the reveal transitions take an optional
  named `easing` incl. the sampled spring `linear()` curves (DM-1550); `wipe-radial`
  (an `iris` alias) + `wipe-clock` (a fixed-vertex animated `clip-path: polygon()`
  angular sweep — no conic mask/filter, DM-1547; `wipeStartAngle` +
  `wipeCounterclockwise` variants in DM-1585). An **`interact`** overlay kind
  (synthetic hover/focus/press fill+ring+scale for no-DOM/PDF inputs, DM-1565, docs/94;
  ambient `repeat` pulse in DM-1585) shares `shine`'s anchor auto-sizing.
  **Still open:** mixed transition-type chaining (unified entrance/exit compositor, DM-1548).

- **Doc 89 (`docs/89-storyboard-sequencing.md`, DM-1527)** — **Shipped.** A
  declarative **storyboard** runner + `domotion storyboard <config.json>` verb that
  sequences distinct SCENES end-to-end into one self-contained animated SVG with
  inter-scene transitions. Each scene is one source — `template`+`params` / `capture`
  / `cast` / existing `svg` — with a per-scene `duration` (optional for animated
  sources → inherits play time) and a `transition` (`{type,duration}`). Reuses the
  scene→SVG→`namespaceEmbeddedAnimatedSvg`→`placeEmbeddedFrame`→`AnimationFrame`
  (`embeddedAnimationPeriodMs`)→`generateAnimatedSvg` path — no new render code — and
  exports to MP4 via `svg-to-video` unchanged. `src/cli/storyboard.ts` +
  `schemas/storyboard-config.schema.json`. **Follow-ups shipped (DM-1552/1553/1554):**
  the full doc-88 reveal transitions between scenes; cross-scene font dedup (shared
  cast builder + `dedupeCompositeFonts`); optional per-scene `overlays[]` (typing/tap/
  svg/blink/shine) + a scene-spanning `cursor` track. **Still open:** anchored overlays
  on a `capture` scene (resolve selectors during capture).

- **Doc 93 (`docs/93-realistic-typing.md`, DM-1518)** — **Shipped.** The `typing`
  overlay now animates character-by-character with the caret glued to the *measured*
  glyph edge (was ~12.7px behind on a long line — it estimated a monospace advance of
  `fontSize×0.6` vs the real ~0.618em). `measureTypingLines` builds a cumulative
  per-glyph advance array from fontkit; one shared reveal plan drives both the line
  clips and the caret (can't desync); reveal/caret step per keystroke (`step-end`),
  falling back to the estimate when the mono face can't resolve. New params: `mode:
  "type"|"paste"`, `jitter` (seeded, byte-stable). Verified vs Chromium. **Follow-ups
  shipped:** `mistakes` typo→backspace→correct (DM-1555), glyph-path rendering +
  proportional fonts + pixel-accurate wrap (DM-1557), `fontFamily` override (DM-1558),
  and a **v2 `typeResample`** per-keystroke real-site re-sampling mode (DM-1556 — types
  one key at a time, re-captures after each, so the field's own input mask/validation/
  font renders; nests N states as one frame's animated SVG). **Later follow-ups also
  shipped:** optional GPOS-kerned shaping (`kern`, DM-1578), CLI font-family
  auto-resolve from the anchored field (DM-1579), caret shapes (bar/block/underscore,
  DM-1591; doc 97), and an opt-in `typeResample.regionOnly` that captures just the
  field's region per keystroke onto a static base to cut O(N·page) output size (DM-1581).

- **Doc 94 (`docs/94-interaction-state-capture.md`, DM-1516)** — **Shipped (v1).** An
  `animate` frame can capture a **real forced CSS pseudo-state** so a page's own
  `:hover`/`:active`/`:focus` styling is captured (not a fake overlay): a per-frame
  `forceState: [{selector, states}]` field applied via a Playwright CDP session
  (`CSS.forcePseudoState`, `applyForcedPseudoStates` in `src/cli/animate.ts`) before
  capture — the page's own rules fire (incl. `:has()` cascade siblings). Composes with
  the cursor so the pointer sits on the hovered element. **Gotcha guarded:** the CDP
  session must stay attached through capture — detaching clears the override and the
  SVG silently captures the rest state. **All follow-ups shipped:** a forced-state
  `reset` verb (DM-1566), and all four auto-detection options — `hoverReveal` sugar
  (Option 1, DM-1562), `hoverDetect` computed-style-diff (Option 2, DM-1563), `jsReveal`
  MutationObserver harness (Option 3, DM-1564 — added/removed-node crossfade, plus a
  surviving-node **motion tween** for transform/opacity attribute deltas, DM-1580;
  `hoverDetect` and `jsReveal` share one `synthesizeMotionTween`, DM-1582), and the
  `interact` overlay (Option 4, no-DOM/PDF fake, DM-1565).

- **Doc 86 (`docs/86-creative-template-pack.md`, DM-1523 design → DM-1531/1532/1533 impl)** —
  **All three batches shipped.** Batch A: four narrative text-card templates
  (`title-card`, `quote`, `caption` [transparent overlay subtitle, distinct from
  lower-third], `cta` [end-card with a pulsing button + logo slot]) sharing
  `src/templates/builtin/text-card-common.ts`. Batch B: `counter` (count
  up/down/timer) + `stat` (KPI + trend chip) on the **odometer digit-reel** module
  `src/templates/builtin/odometer.ts` (per-digit `translateY` roll — cross-engine-
  safe; **rests at identity** and rolls in from an offset, so Domotion's capture
  doesn't double-transform; real spin on low-order digits). This needed a
  **capture fix**: the script (`src/capture/script/index.ts`) now exempts
  `[data-domotion-anim]` subtrees from the off-viewport drop so a reel's off-canvas
  cells (which scroll into view) survive capture — the animation-aware viewBox cull
  trims the rest. Batch C: `compare` (`builtin/compare.ts`, DM-1533) reveals the
  after over the before with a clip wipe (+ optional divider) + labels, via
  `composeAnimatedLayers`' Firefox-safe `clipScale`; page/image/SVG inputs resolved
  through `captureToSvg`. All have `brandDefaults` (DM-1522) + honor format
  `safeInset` (DM-1537) where applicable.

- **Doc 85 (`docs/85-brand-kit.md`, DM-1522 design → DM-1530 impl)** —
  **Shipped v1.** A reusable brand file (palette / font / radius / logo /
  background) supplies every built-in template's *defaults*: `--brand acme.json`
  on `domotion template`. `loadBrand` (in `src/templates/brand.ts`) parses +
  validates (zod `brandSchema`) + resolves a relative `logo`; each themeable
  built-in exposes `brandDefaults(brand)`, merged BENEATH explicit params by
  `applyBrandDefaults` before zod defaults (precedence: explicit > brand >
  default). Composes with format presets (`--brand acme.json --format reel`).
  **Logo slot wired (DM-1539):** `cta`'s `brandDefaults` maps `brand.logo` → its
  `logo` param (first built-in to consume `brand.logo`).

- **Doc 92 (`docs/92-brand-for-capture.md`, DM-1540)** — **Shipped.** `--brand
  <file>` on `domotion capture` / `animate` injects the brand as CSS custom
  properties into the page *before capture*, so a real page authored against
  `var(--brand-*)` picks up the brand at capture time (distinct from the template
  *defaults* mechanism above). `brandCustomProperties` / `brandRootCss` (pure, in
  `src/templates/brand.ts`) emit only the tokens the brand set; `injectBrandVariables`
  (`src/capture/index.ts`) applies them as inline `:root` styles at document-start
  and re-applies on `DOMContentLoaded`. Contract: `palette.primary`→`--brand-primary`,
  `accent`→`--brand-accent`, `background`→`--brand-background`, `text`→`--brand-text`,
  `muted`→`--brand-muted`, `font.family`→`--brand-font-family`, `radius`→`--brand-radius`.
  **Follow-ups shipped:** brand → `template` frames in `animate` (`renderTemplateFrames`
  now threads the run brand, DM-1543); an inline `brand` key (path or object) in the
  animate config with CLI override (`resolveConfigBrand`, DM-1544); `lower-third` now
  consumes `brand.logo` (DM-1545, second built-in after `cta`). **Still open:**
  `brand.logo` on `title-card`/other end-cards (DM-1575), a `logoPosition` for
  `lower-third` (DM-1576).

- **Doc 87 (`docs/87-format-presets.md`, DM-1521 design → DM-1534 impl)** —
  **Shipped v1.** Social-format presets on `domotion template`: `--format <name|WxH>`
  where names are `reel`/`story` (1080×1920), `square` (1080×1080), `portrait`
  (1080×1350), `landscape` (1920×1080). `resolveFormat` (in `src/templates/formats.ts`)
  returns `{width,height,safeInset}`; size precedence is explicit `--width`/`--height`
  > format > template default. The safe-area inset (px per side; vertical formats
  reserve top/bottom room) rides `TemplateRenderContext.safeInset` and is now
  **consumed by the themeable built-ins** (DM-1537): flex templates via
  `safeAreaPadding`, `chart` via an inner-dimension safe-rect wrapper — content
  stays within `canvas − safeInset` at 9:16 (default output byte-identical when no
  format). **Follow-ups shipped:** `--format` on `capture`/`animate` (doc 90,
  DM-1538) and per-ratio adaptive type scaling (doc 91, DM-1541).

- **Doc 90 (`docs/90-format-on-capture.md`, DM-1538)** — **Shipped.** `--format
  <name|WxH>` on `domotion capture` / `animate` (same `resolveFormat` machinery,
  no fork) sizes the **capture viewport**; precedence explicit `--width`/`--height`
  > format > default. `--format` sizes captured *content*, `--chrome` adds the
  bezel around it. `safeInset` on a raw capture is informational — a `--safe-guide`
  overlay (`safeAreaGuideSvg`) draws the safe-area rect; captured content isn't
  reflowed (an `animate` `template` frame does receive the inset). **Follow-up
  shipped:** device-mockup format-awareness (DM-1559) — a format sizes the inner
  screen to its aspect and the phone bezel scales proportionately (`--format reel
  --chrome phone` → 1158×1998; byte-identical ≤390). **Still open:** browser/window
  bezel-bar scaling (DM-1577).

- **Doc 91 (`docs/91-adaptive-format-scaling.md`, DM-1541)** — **Shipped for the
  creative-pack text/number cards.** `formatScaleFactor(w,h,safeInset)` (√ of the
  usable-area ratio vs a 1280×720 reference, clamped) enlarges authored type so a
  landscape-authored card reads well at 9:16 rather than merely fitting. Applied via
  `cardScaleFactor` in `caption`/`cta`/`quote`/`title-card`/`counter`/`stat`/`compare`
  (odometer gets a width-fit clamp). Opt-in like `safeAreaPadding` — **scale 1 with
  no format, so default output is byte-identical**. **Follow-ups shipped:** `chart`
  now folds into `formatScaleFactor` (DM-1560, no-op proven at sf=1); the CSS
  `clamp()`/viewport-unit alternative was investigated (doc 95, DM-1561 — verdict:
  keep the uniform factor, add per-element scale *exponents* rather than clamp/vw,
  since naive `vw` shrinks reel type). **Per-element exponents shipped (DM-1568):**
  `fs`/`fsNum` take an optional exponent so a headline scales `sf**1.25` (harder)
  while its eyebrow/subtitle scale `sf**0.9` (softer) under a format — applied to
  `title-card`; `1 ** exp === 1` keeps the no-format default byte-identical.
  **Still open:** a designer tuning pass on the curve/exponents (DM-1569).

- **Doc 84 (`docs/84-viewer-browser-support.md`, DM-1515)** — **Shipped contract.**
  The support matrix for the browsers that *view* the output (distinct from the
  capture-platform matrix). **Blink** (Chrome/**Edge**/Brave/Opera/Electron) +
  **WebKit** (Safari + all iOS browsers) are **first-class**; **Gecko** (Firefox)
  is **best-effort**: under heavy load Firefox demotes some OMTA animations to the
  main thread and a unit's paired opacity/transform can desync (graceful, not a
  break). Animation is authored as **CSS `@keyframes`** (not SMIL, never mixed —
  DM-1507) so it plays inside `<img>` with no runtime (JS/WAAPI don't run there).
  Generator mitigation: fuse a unit's co-timed tracks into one CSS animation
  (DM-1512/1513). Stress-test harness: `examples/output/stress-gallery.html`
  (DM-1514, regenerate via `examples/build-stress-gallery.ts`). Not to be confused
  with the fixed DM-1511 transparent-flash-at-cut-points bug (see doc 08).

- **Doc 82 (`docs/82-svg-scrubber-review-mode.md`, DM-1445 + DM-1449)** — **Shipped.**
  `svg-scrubber --review` adds an issue-reporting panel (title + category + note +
  drag-to-draw regions) that writes importable `.ticket` JSON files to the launch
  cwd, capturing the current frame time, the in/out range, and the region(s) (SVG
  user-units). `title`/`category`/`details` map straight onto `hotsheet_create_ticket`
  (the "tell Claude to import the .ticket files" flow). `POST /ticket` (review-only,
  404 otherwise) + the pure unit-tested `buildTicketFile` in `src/scrubber/server.ts`;
  the region overlay reuses the crop overlay's zoom/pan-aware SVG-unit math in
  `client.tsx`. **DM-1449** added **multiple regions** (overlay stays armed across
  drags; `regions` array, with `region` kept as the first for back-compat) and an
  **Attach frame** option that renders the current frame to a sibling `.png`
  (`framePng`, via the `/export-frame` seek+screenshot path). A built-in import
  command was explicitly deferred. Animated-SVG analogue of `svg-review`.
- **Doc 81 (`docs/81-iframe-recursion.md`, DM-1441 + DM-1442)** — **Both phases Shipped.**
  **Phase 2 (DM-1442):** `--cross-origin-frames "*"|host[:port],…` (config-object
  `captureCrossOriginFrames`) recurses **allowlisted** cross-origin frames by launching
  Chromium with web security disabled (`crossOriginFramesLaunchArgs`); non-allowlisted
  frames stay raster even when readable (blast-radius limit). Matching is two pure
  functions in `src/capture/script/cross-origin.ts` (bundled into the capture script +
  unit-tested), exact-host with optional port (default ports normalized). Default off +
  a stderr security warning (web-security-off disables CORS). Unit + e2e tested
  (`tests/cross-origin-iframe-recursion.e2e.test.ts`). Scroll-path threading is a minor
  follow-up. **Phase 1 (DM-1441):** a same-origin `<iframe>` no longer rasters to a flat `<image>`
  (raster-fallback §E4) — its `contentDocument` is recursed with the **same** capture
  logic and spliced in as the iframe node's child, yielding crisp/scalable/selectable
  native SVG. Placement uses a **temporary `vp`-origin shift** during the inner walk
  (every capture helper reads `vp.x/vp.y` live, so the inner subtree comes out already
  positioned at the iframe content box, the viewport cull tests inner content against
  the real region, and the shift composes for nested frames) rather than a fragile
  per-field offset; the iframe node is set `overflow:hidden` so the existing renderer
  clip bounds the inner content to the content box (no renderer change). Cross-origin
  frames stay raster until **Phase 2** (planned `--cross-origin-frames` host allowlist +
  `--disable-web-security`, default-off + a security warning). **DM-1443** then ran the
  inner-document pre-passes (`_runInnerDocumentPrePasses`) so inner CSS counters,
  `@counter-style`, fixed/sticky/transform cull exemptions, and scale/zoom font metrics
  all resolve against the iframe's own document; inner mask/clip/filter `<defs>`
  fragment refs remain a tracked gap.
- **Doc 78 (`docs/78-svg-to-image.md`, DM-1353 + DM-1354)** — **Shipped.** A fifth
  published bin, `svg-to-image`: convert one SVG to a single image file — PNG /
  JPEG / PDF / WebP / AVIF / TIFF, format inferred from the `-o` extension (or
  `--format`). The headless, one-shot counterpart to the scrubber's interactive
  frame export and the still analogue of `svg-to-video`; built for the agent review
  loop ("render → look at the pixels → critique"). `--at <ms>` samples an animated
  SVG's timeline; `--scale` supersamples raster output (retina); `--width/--height`
  contain preserving aspect; PNG/WebP/AVIF/TIFF keep alpha (JPEG/PDF composite on
  white). PNG/JPEG/PDF are native Chromium (`page.screenshot`/`page.pdf`); WebP/AVIF/
  TIFF transcode from the PNG buffer via the already-bundled `sharp` (DM-1354),
  lazy-`import()`ed only when requested. Input is an SVG file only (URL/HTML → image
  is `domotion capture` then this). Reuses the `svg-to-video-core` seek+screenshot
  machinery (`src/cli/svg-to-image{,-core}.ts`).
- **Doc 77 (`docs/77-nested-animated-compositing.md`, DM-1323)** — **Shipped (core).**
  General animated-SVG compositing: nest one *animated* composition (cast / scroll
  capture / template / `animate` result) inside another, animation intact — the
  terminal-window-on-a-desktop / website-in-a-browser-bezel composite. Ships:
  `composeAnimatedLayers` (`src/animation/composite.ts`, package-root export) — z-
  ordered layers, each placed with an independent timeline (`hold`/`stretch`/`loop`,
  `offsetEmbeddedAnimatedSvgTimeline`) + layer-level animations (move/scale/fade,
  e.g. a window resized mid-playback); the `domotion composite <config.json>` verb
  (`src/cli/composite.ts`); and `device-mockup`'s `screenSvg` param (nest an
  animated screen instead of capturing to static). E2E demo:
  `examples/composite-desktop.ts` + `examples/composite/`. A published JSON Schema
  ships at `schemas/composite-config.schema.json` (generated from the zod schema by
  `npm run build:composite-schema`). Embedded fonts are deduped across layers two
  ways: byte-identical payloads collapse anywhere (DM-1329, `dedupeCompositeFonts`),
  and `cast` layers in the declarative `composite` path share ONE embedded-font
  builder so terminals in the same monospace with *different* text embed the union
  subset once (DM-1331, `deferFonts` + `fontFaceCss`).
- **DM-1319 cast/template timeline re-sync (`src/animation/embed-timeline.ts`)** —
  **Shipped.** A `cast` / `template` frame's nested animation now starts when its
  frame becomes visible (offset by preceding frames) and holds before/after,
  instead of running on the shared document origin. New `AnimationFrame.
  embeddedAnimationPeriodMs` field drives it inside `generateAnimatedSvg`. See
  `docs/67`.
- **Doc 76 (`docs/76-social-templates.md`, DM-1278)** — **Shipped.** Two social
  built-ins: `chat` (a message thread whose bubbles pop in one at a time,
  alternating `me`/`them` sides; parsed from a `{from,text}[]` array or `me:`/
  `them:` lines) and `subscribe` (a follow/subscribe pop-up card that pops in with
  a looping `alternate` pulse on the CTA). Both are timed-reveal staggered
  intra-frame animation passes. Code in `src/templates/builtin/{chat,subscribe}.ts`.
- **Doc 75 (`docs/75-chart-template.md`, DM-1279)** — **Shipped.** The `chart`
  built-in: an animated `column` / `bar` / `line` chart from a list of values
  (CSV or JSON `data`). Bars grow from the axis via `scaleY`/`scaleX` +
  `transformOrigin` (the `width`/`height` intra-frame properties don't apply to
  the `<g>` wrapper); the line is an inline `<svg>` revealed by a `clipPath` wipe.
  Title, value/category labels, palette, nice axis max. Code in
  `src/templates/builtin/chart.ts`.
- **Doc 74 (`docs/74-template-authoring.md`, DM-1282)** — **Shipped.** The
  third-party template authoring + publishing guide: a template is an npm package
  named `domotion-template-<name>` exporting a `Template` (`domotion-svg` is a
  types-only peer dep); covers package shape, generator vs decorator, the two
  animation constraints (incl. `transformOrigin`), params/`z.coerce`, `durationMs`,
  testing via `renderTemplateToSvg`, and the `domotion-template-*` discovery
  convention. Runnable scaffold in `examples/template-package/`; public template
  gallery + authoring guide on the site (`site/src/content/docs/usage/templates.md`,
  `site/src/content/docs/developer/custom-templates.md`).
- **Doc 73 (`docs/73-template-frames.md`, DM-1287)** — **Shipped.** A `template`
  frame kind in the `animate` config: `{"template":"lower-third","params":{…}}`
  embeds a named template (doc 70) as a nested animated SVG, composing it into a
  larger multi-frame animation. Params validated against the template's own
  schema; template inherits the canvas size (centered otherwise). The crux is
  nesting an animated SVG inside another: template frames are pre-rendered before
  the outer font lifecycle, and the nested document's global names (ids, font
  families, `.f-N` classes, `@keyframes`, `--scene-dur`) are namespaced per-frame
  (`namespaceEmbeddedAnimatedSvg`, `src/animation/embed-namespace.ts`) so they
  can't collide with the outer animation or sibling template frames. The same
  namespacer (with `namespaceFonts:false`) now also fixes the `cast` path's latent
  class/`@keyframes`/`--scene-dur` collision (DM-1292). A template frame's
  `duration` is optional (DM-1294) — omitted, it's derived from the template's
  intrinsic play time (`TemplateOutput.durationMs`).
- **Doc 72 (`docs/72-kinetic-text-template.md`, DM-1277 + DM-1286)** — **Shipped.**
  The `kinetic-text` **generator** template: a headline string is expanded at
  author time into per-word / per-char units, each revealed with a staggered
  animation (`rise` / `slide` / `fade` / `clip`) then held assembled. DM-1286 added
  the `clip` wipe, multi-line `\n`, light inline emphasis tags (`<b>`/`<i>`/`<u>`/
  `<font color>` safelist, others dropped), and `loop` / `boomerang` modes. The
  clearest showcase of the doc-70 "pre-process once, replay free" thesis; same two
  animation constraints as doc 71. DM-1297 added the `pop` (center-origin
  scale-up) variant + the underlying intra-frame `scale` property and
  `transformOrigin` support (emits `transform-box: fill-box; transform-origin` so
  any transform can pivot about the element's own box — doc 08). A `blur-in`
  variant (DM-1296) was built (a `filter: blur()` keyframe reveal) but **dropped**:
  animated CSS `filter` on an `<img>`-embedded SVG works in Chromium but not
  Safari/other engines, so it isn't cross-browser-safe. Do not re-attempt the
  `filter`-keyframe approach.
- **Doc 71 (`docs/71-background-loop-template.md`, DM-1280 + DM-1285 + DM-1295)** —
  **Shipped.** The first deferred first-party template built on the doc-70
  contract: a `background-loop` **generator** that emits a procedural seamlessly-
  looping animated background. Six variants: `aurora` / `orbs` / `stars` blobs, a
  `gradient-pan` color wash, a drifting `grid`, and `wave` ribbon bands (DM-1285 +
  DM-1295); deterministic from a `seed`; comma-separated `--colors`. Demonstrates
  the two animation constraints templates must respect —
  one intra-frame animation per captured element (so each blob is a drift-wrapper
  around a breathe-inner), and origin-(0,0) SVG transforms (so motion is
  origin-safe translate + opacity, looped with `alternate`).
- **Doc 70 (`docs/70-template-system.md`, DM-1276)** — **Spike shipped** (the
  de-risking spike from the DM-1210 templates investigation). A Domotion
  *template* is a parameterized generator — `render(params)` produces a
  self-contained SVG by driving the **existing** capture/compose pipeline (no new
  rendering code), so it can do arbitrary author-time pre-processing and stay
  HTML/CSS-native. Ships: the `Template` contract + registry/loader (`src/
  templates/`), the `domotion template <name>` CLI verb, and two built-ins —
  `lower-third` (generator) and `device-mockup` (decorator reusing
  `wrapInDeviceChrome`). Third-party templates are npm `domotion-template-*`
  packages (same mechanism as built-ins). Decorators must use the `captureToSvg`
  *static* primitive, not a one-frame animate config (an animated SVG won't nest
  in a bezel). The wider first-party library + a Lottie **input** adapter are
  filed follow-ups, **not yet built**.
- **Doc 69 (`docs/69-scroll-button-rendering.md`, DM-1234)** — **Shipped.**
  `::scroll-button(left/right/up/down)` paging arrows are captured + rendered as
  replica siblings of the scroller. `getComputedStyle` can't disambiguate the
  parameterized pseudo, so per-side `content` + the `:disabled` rule are read
  from the author stylesheet (CSSOM); geometry is resolved by a `<body>`-appended
  replica that — like the real generated button — takes the **viewport** as its
  containing block (`top:50%` = 50% of the viewport, not the scroller, verified
  by probe-and-match); enabled/disabled comes from the captured scroll offset.
  `_captureScrollButtons` in `src/capture/script/index.ts`. Companion to doc 38.
- **Doc 67 (`docs/67-terminal-capture.md`, DM-1225)** — `domotion term --cast
  <file.cast>` converts a recorded terminal session (asciinema v2) into an
  animated SVG. Backend in `src/terminal/`: `@xterm/headless` VT emulation →
  settle-point frames → terminal HTML → the normal capture→SVG pipeline →
  `generateAnimatedSvg` with hard cuts. **Two front-ends** now ship: asciinema
  `--cast` import, and live `node-pty` capture (`domotion term -- <cmd>`, DM-1226
  / **doc 68**, `src/terminal/pty.ts`, optional dep) onto the same backend.
  Composes into larger animations two ways: a `cast` frame in the `domotion
  animate` JSON config (embeds the terminal as a nested animated SVG, sized like
  a `scroll` block), and the `castToTermFrames` frames-out API (+ the terminal
  primitives) re-exported from the package root for retiming / chrome-wrapping.
- **Doc 65 (`docs/65-device-chrome.md`, DM-1206 / DM-1211 / DM-1212)** — `domotion capture
  --chrome <device>` wraps a capture in a hand-drawn device bezel: `phone`,
  `browser` (traffic lights + URL pill), `window` (title bar); `--chrome-label`
  sets the browser URL / window title and `--chrome-theme dark|light` themes the
  bezel (DM-1212). `src/render/device-chrome.ts`
  (`wrapInDeviceChrome`, optional `{ label }`) nests the *rendered* capture as a
  child `<svg>` rather than re-rendering the tree (re-rendering drops the system
  font to `.notdef` tofu). Pure-SVG + cross-platform (the label is the one live
  `<text>`).
- **Doc 64 (`docs/64-demo-gallery.md`, DM-214..223)** — the progressive
  **demo gallery** concept. NOTE: the legacy kerfjs manual it described
  (`site/scripts/demos/`, `site/pages/guides/`) was removed when the site was
  rebuilt as Astro + Starlight (DM-1308); the gallery now lives across the new
  `site/` Showcase + Usage pages, sourced from `examples/output`,
  `examples/output/templates`, and the runnable `examples/animate/` goldens. Doc
  64 itself is partly historical — reconciliation tracked separately.
- **Doc 54 (`docs/54-svg-review-tool.md`, DM-946)** — the published
  `svg-review` CLI for single-fixture render-fidelity bug reports.
- **Doc 55 (`docs/55-debug-mode-capture.md`, DM-945)** — the
  `domotion capture --debug` flag's reproduction bundle (HAR +
  screenshot + actual SVG + captured-tree JSON).
- **Doc 56 (`docs/56-svg-scrubber.md`, DM-1040)** — the
  `svg-scrubber` CLI: a local video-style bench for an animated
  SVG (play / scrub / speed / range-loop / frame-PNG / range-MP4 / trim).
- **Doc 57 (`docs/57-scrubber-crop.md`, DM-1104)** — the scrubber's crop
  mode: a draggable crop rect (8 handles) baked into all three exports
  (raster clip for PNG/MP4, viewBox vector crop for the trimmed SVG).
- **Doc 58 (`docs/58-new-york-optical-cuts.md`, DM-1108)** — macOS New York
  serif optical cuts. Unlike SF Pro's single variable file (DM-1103), New
  York ships its cuts as separate static OTFs (no `opsz` axis), so the
  `OPTICAL_CUT_OPSZ` mechanism does not apply; only `"New York Medium"`
  needed a routing fix (it collided with the variable font's Medium weight).
- **Doc 79 (`docs/79-harfbuzz-use-reroute.md`, DM-1197 + DM-1215)** — two narrow
  uses of real HarfBuzz (harfbuzzjs) where macOS shaping diverges from Chrome.
  (1) DM-1197: USE-shaped precomposed letters with a canonical base+mark NFD
  (Kaithi `U+110AB`, Balinese, Tulu-Tigalari — 13 cps) shape via HarfBuzz instead
  of the CoreText helper, which recomposes and mis-places the mark; scoped to the
  USE shaper, `DEDICATED_SHAPER_RANGES` stay on CoreText. (2) DM-1215: an
  ORPHANED complex-script combining mark (no spacing base) routes through the
  mark's own font as a HarfBuzz instance so the dotted circle `U+25CC` Chrome
  inserts + GPOS-positions the mark on is reproduced — fontkit drops the ◌ for
  USE faces (Adlam/Miao) and mis-centers it otherwise. Fixed adlam/miao/brahmi/
  kharoshthi/tagalog/tai-tham/syloti via `resolveDottedCircleHbRun` in both
  run-splitters.
- **Doc 80 (`docs/80-cross-platform-system-fallback-resolver.md`, DM-1403)** —
  **macOS / Linux / Windows all Shipped + default-on.** The per-codepoint live
  system-fallback resolver (macOS CoreText `CTFontCreateForString`) that catches
  codepoints the static per-block table misses — previously hard-gated
  `process.platform !== "darwin" → null` — is now one platform-dispatched entry
  point (`resolveSystemFallbackKeyForCp`). Linux backend via fontconfig
  `fc-match :charset=<hex>` (`resolveLinuxSystemFallbackKeyForCp`, reusing the
  existing `fcMatch` — no new native code), calibrated against Chromium-on-noble
  and flipped default-on in DM-1416 (with a `fontFileCoversCodepoint` coverage
  guard). Windows backend via DirectWrite `IDWriteFontFallback::MapCharacters`
  (the win32 glyph helper's `fallback` query, `HasCharacter` coverage guard),
  calibrated against Chromium-on-Win11 and flipped default-on in DM-1424 — the
  4,899-codepoint sweep found 0 sampled codepoints move (every MapCharacters/
  Chromium divergence is on a static-table-owned cp). `DOMOTION_SYSTEM_FALLBACK=0`
  forces it off on Linux/Windows. The chain walker's `glyphForCodePoint` check
  makes a non-covering backend result harmless (falls through to tofu, never a
  wrong glyph).
- **Doc 61 (`docs/61-overlay-resolution-primitive.md`, DM-1132)** — `resolveOverlays(
  page, overlays)` lowers an overlay's selector `anchor` + typing `maxWidth:
  "anchor"` into concrete `x`/`y`/`bgWidth` for imperative scripting-API callers.
  The CLI and the public primitive share one engine; the box helper `contentBox`
  / `boxAnchorPoint` (DM-1133) and overlay SSOT (DM-1131) underpin it.
- **Doc 62 (`docs/62-frames-out-animate-pipeline.md`, DM-1136)** — **SHIPPED.**
  Opened up the all-or-nothing `composeAnimateConfig`: a frames-out variant
  (`composeAnimateFrames` returning the assembled `AnimationConfig` before the
  final `generateAnimatedSvg`, DM-1137) + an optional `onFrame` per-frame hook
  with an options-object signature (DM-1138). Lets a JSON-config consumer inject
  custom per-frame edits without reimplementing the capture→compose loop.
- **Doc 63 (`docs/63-cursor-action-primitives.md`, DM-1135)** — **SHIPPED.**
  Exposed the cursor selector→point resolution (`borderBox` + `resolveCursorTarget`,
  DM-1139) and the declarative action runner (`runActions` + the `AnimateAction`
  union, DM-1140) as public primitives. Companion to doc 62 (per-feature
  primitives vs the whole pipeline). Notes the border-box (cursor) vs content-box
  discrepancy.
- **Doc 60 (`docs/60-programmatic-animate-pipeline.md`, DM-1130)** — the
  declarative `animate` pipeline (`composeAnimateConfig` / `validateAnimateConfig`
  / `interpolateConfigVars` / `AnimateConfig`) is now re-exported from the
  package root, so library callers run a JSON-config animation in-process.
  `configDir` defaults to `process.cwd()`; the CLI is a thin file-read wrapper.
- **Doc 59 (`docs/59-overlay-schema-ssot.md`, DM-1131)** — overlay / intra-frame
  animation shapes are now defined once as zod base schemas in
  `src/animation/overlay-schema.ts`; the renderer's runtime types are `z.infer`red
  from them and the declarative config (`src/cli/animate.ts`) extends the same
  bases. One base, two views (resolved vs authoring) — renames cascade at compile
  time, and `schemas/animate-config.schema.json` stays generated from the source.
- **Doc 13 cursor-type matching (DM-1106)** — the cursor overlay now paints
  the correct cursor glyph for whatever is under the pointer (hand over links,
  I-beam over text, resize arrows, grab, …) and switches at element boundaries.
  Capture records the effective `cursor` per element (`auto` resolved per Blink);
  glyphs are Lucide-composed in `src/animation/cursor-glyphs.ts`.

These two together form the consumer-side bug-report workflow: capture
with `--debug`, review with `svg-review`, file an issue with the
generated Markdown. AI agents working on render bugs should reach for
the same flow internally — see `CLAUDE.md` "Debugging the generated
output".

## Cross-platform support

Per `CLAUDE.md` "Platform support — non-negotiable":

- macOS, Linux, Windows must all work. The output should be pixel-faithful
  to Chromium ON the platform the capture runs on (CoreText on macOS,
  fontconfig on Linux, DirectWrite on Windows).
- All three platforms now have calibrated fallback chains AND generated
  per-Unicode-block routing tables — `unicode-font-routing.{darwin,linux,win32}
  .generated.ts`, from Chrome CDP `CSS.getPlatformFontsForNode` sweeps
  (macOS DM-983, Linux DM-984, Windows DM-987). macOS remains the most
  mature / most-validated; Linux + Windows native glyph extractors and CI
  are partially landed (docs 41 / 45 / 49–52). Treat macOS as the reference
  and re-probe the others when their font set changes.
- New font / fallback / metric routing must be designed platform-aware
  from the start — `process.platform` based, not assumed `darwin`.

## Platform-specific docs

- **Doc 40 (`docs/40-cross-platform-font-paths.md`)** — how the platform
  font-path lookup works.
- **Doc 42 (`docs/42-cross-platform-fallback-calibration.md`)** — how
  fallback chains get probed against Chromium's painted output.
- **Doc 41 (`docs/41-windows-glyph-extraction.md`)** and
  **doc 45 (`docs/45-linux-glyph-extraction.md`)** — native glyph
  extraction helpers (currently macOS via CoreText is doc 16).
- **Doc 49 / 50 / 51 / 52** — glyph-helper dispatch, acquisition,
  probe-then-fallback, embedded-mode glyph fallback.
- **`docs/font-resolution-diagram.md`** — **Shipped.** Canonical
  always-in-sync Mermaid flow diagram of the *entire* font-resolution
  system, synthesizing docs 03/30/40/42/51/52/80: family-stack→key, the
  platform path tables, key→`FontInstance`, the per-codepoint resolver
  (Blink `FontFallbackIterator` mirror), the darwin/linux/win32 fallback
  chains with specific per-block fonts, and the live CoreText/fontconfig/
  DirectWrite resolver. Verified by the `check-requirements-against-code`
  skill; must be updated in lockstep with any font-routing change.

## What this file is NOT

- Not a complete requirements doc — the per-feature docs are.
- Not a substitute for opening the actual numbered doc — when a ticket
  touches gradients, open `docs/07-gradient-fills.md` /
  `docs/10-repeating-gradients.md`. When it touches fonts, open
  `docs/03-font-family-chain.md` / `docs/52-embedded-mode-glyph-fallback
  .md`. And so on.
