# Requirements summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read
for behaviour contracts. Like `code-summary.md`, it points at the canonical
docs rather than duplicating them.

## The contract surface

Native Linux/Windows `background-clip:text` evidence must authenticate the headless Chromium binary, painted fonts, source revisions and DPR1/2 artifacts, and must pass logical owner/mutation controls before terminal native edge classification. No platform envelope is inferred (DM-2530; doc 228).

Replaced video/canvas output owns one frozen Chromium-presented frame only. Pairing exact animation time with the pre-navigation capture-rAF handle activates the shipped atomic preflight/freeze/capture/reverify transaction: finite video must decode, seek and present; origin-clean canvas bytes, media facts, every owner PNG, page/frame navigation and compositor/surface epochs must remain exact or capture fails closed. Captures without both authorities stay observational. Playback, decoder continuation, live canvas mutation and media-time effects after capture remain unsupported; animated-image decoder ownership is still separate (doc 229).

**Doc 120 (`docs/120-same-machine-text-parity-contract.md`) is normative.**
Chromium and Domotion must produce identical logical font selection, shaping,
and text layout in the same environment. Gates distinguish exact logical
agreement, accepted rasterization-only differences after logical proof, and
detected actionable unsupported input. Cross-machine face equality is not
required when inventories differ. Comparable reports fingerprint the browser,
host/fonts/preferences, helper/source versions, layout context, resources, and
oracle isolation, and require disable-and-require-movement controls.

**Doc 129 (`docs/129-chromium-parity-verification-program.md`) is the durable
cross-renderer verification plan.** `tools/parity-program.json` inventories each
rendering subsystem's upstream source proof, stage oracle, generated and
platform coverage, known confidence boundary, and next action. Work proceeds in
the mandatory order: source decision, branch classification, intermediate
oracle, negative activation control, transition/metamorphic coverage, then
all-platform visual integration. `npm run check:parity-program` keeps references
and unresolved gaps explicit in CI. The in-repo demos reviewer now requires a
human logical-stage classification before filing a residual ticket and records
that classification in the title and details; it deliberately does not infer
causality from pixel percentages (doc 31).
Doc 140 makes that integration concrete: CI attaches source-linked logical
stage reports and runner fingerprints, fixture relevance comes only from the
semantic inventory, and the required human classification persists through
reload and into the filed ticket.
Doc 141 closes the shaping-evidence split with one normalized record containing
CDP painted faces/origins and helper/HarfBuzz face, glyph, cluster, advance, and
offset evidence, while explicitly preserving CDP's glyph-ID boundary.
Doc 142 establishes that isolated resolver agreement proves only Blink's
system-font iterator stage. Exact renderer parity additionally requires
per-shaped-run provenance across declared/priority faces, cluster requeue,
dotted-circle/decomposition outcomes, embedded/path transitions, raster overlays,
and raw-text fallback; that audit produced DM-2398 and DM-2399.
Doc 143 ships DM-2398's opt-in production ledger and Chromium-joined route
oracle. Demo-review font-selection evidence passes only when both this
representative production-funnel gate and the broader unified report pass;
every new assignment owner or emitter transition requires its own route case
and independent mutation control.

Doc 160 makes ICU/HarfBuzz dependency rolls fail closed. Comparable evidence
includes Chromium's HarfBuzz pin, independent HarfBuzz/ICU revisions, bundled
ICU-data bytes, helper binaries, and generated classifier bytes. Exact ICU
property and HarfBuzz glyph/cluster/advance/offset row changes require upstream
source citations plus named updated oracle rows. Representative and exhaustive
profiles run independently; missing fingerprints or mixed profiles withhold a
regression verdict.

Doc 196 adds the release-consumer leg missing from Linux arm64 coverage. A
native `ubuntu-22.04-arm` job must acquire the pinned glyph and ICU assets via
the public production APIs into a never-used cache, prove AArch64 ELF identity,
three release checksum authorities plus the ratified digest, live protocols and
cache reuse, then pass the font-selection, ICU, shaping, decoration, paint,
HTML, and Unicode gates under one runner/font/browser fingerprint. The gate
does not build helpers or widen native-raster envelopes; its first remote
`exact-arm64-release-parity` artifact remains required after integration.
Run 32611751700 reached 686 exact host shaping pairs but correctly withheld
because the static image supplied no moving axes or ptem input. Doc 199 closes
that activation gap with repository-owned Open Sans `wght`/`wdth` omission rows
and pinned HarfBuzz `TRAK.ttf` `ptem=9`→unset, while schema 3 requires the full
expected logical arrays and only `xAdvance` movement. Invalid, inert, or
unexpected fixture rows withhold independently; pixels and raster thresholds
remain outside this gate.

DM-2502/doc 201 classified the same run's lone significant HTML residual as a
logical shaping-item ownership defect; DM-2507 closes it. Domotion now computes
Blink's maximal `SymbolsIterator` source-priority ranges independently of
bidi/script and intersects both streams before fallback allocation. CSS applies
after that split, explicit selectors win, declared-family faces retain
precedence, and priority no longer comes from a queued hint. Both `✗ ❗` and
`❗ ✗` route bare U+2757 to Noto Color Emoji, opposite-CSS VS15/VS16 and text
negatives remain exact, and `02-text-emoji` is clean. The gate has no pixel
threshold; DM-2508 owns arm64 aggregate promotion only.

Doc 197 defines the paths-mode native-raster floor as an evidence/ratification
matrix, not a percentage exception. Its self-contained collector uses six
SHA-pinned source-owned faces, all five transform classes, every quarter-pixel
phase, and DPR 1/2 for 348 declared cells per run. One-glyph-per-scalar samples
disable substitutions so sfnt tables—not an unobservable browser-HarfBuzz
claim—own expected logical facts. Every row must first match exact custom face
bytes, face index/axes, gid/cluster/advance/offset/source-outline stream, and
renderer-emitted baseline/matrix/synthetic paint plan.
The producer and aggregate reopen the lossless PNGs and recompute hashes and
residuals; supplied metrics and external observation bundles are not trusted.
Only then may a reviewed envelope keyed by the authenticated browser/toolchain
fingerprint and canonical cell hash classify the residual as rasterization-
only. GitHub Actions run `32621780121` ratifies 2,088 exact logical rows: 348
proposal plus 348 independent-validation cells on each of macOS, Linux, and
Windows at DPR1/2. Every validation residual remains inside its exact proposal
value; scalar harness caps stay unchanged.

DM-2532/doc 220 closes the declared logical substitution-stream gap before any
native raster grading. The same authenticated portable bytes must cross a sole
Chromium custom face, Chromium-configured pinned HarfBuzz, and production
text-run provenance with exact gid/UTF-16-cluster/source-span/advance/offset,
direction/script/language/features/axes, and source identity. The corpus covers
`liga`, required/contextual `rlig`, contextual Arabic forms, GPOS mark
attachment, variable axes, and `locl` language systems under Blink's actual
default `MONOTONE_GRAPHEMES`. All thirteen input/source/record mutations must
move. Cross-platform ratification requires independent proposal and validation
artifacts on macOS, Linux, and Windows with identical corpus/logical digests;
the aggregate reports rasterization `not-started`, and doc 197's 348-cell
corpus, envelopes, and scalar caps remain unchanged. DM-2552 owns the first
retained six-artifact run after integration.

The doc-116 text-layout stage is an exact CI gate: a declarative multi-valued
covering array proves every pair across Blink's bidi, writing, wrapping,
breaking, ruby, emphasis, justification, synthesis, zoom, transform, and
fragmentation inputs. It compares direct Chromium `Range` geometry with
production-captured `textSegments`, proves logical axes move, and checks five
metamorphic relations without cloning browser geometry into the Domotion leg.
Paint-only axes and live production diagnostics are classified separately;
stale standalone unsupported labels are forbidden.

DM-2524/doc 214 makes bidi paragraph ownership exact before shaping. Ordinary
blocks must resolve UAX #9 with captured CSS `direction`; `unicode-bidi:
plaintext` must use first-strong auto; and LRO/RLO overrides must resolve inside
the same paragraph base. Forward/reverse pointed-Hebrew + Arabic + digit rows
retain exact levels, scripts, gids, clusters, UTF-16 spans, advances, offsets,
captured/emitted origins, and baselines. Opposite-level, collapsed-cluster, and
logical-start-origin mutations must all move on macOS, Linux, and Windows.
This logical gate changes no visual tolerance.

**Doc 128 (`docs/128-chromium-unicode-decision-audit.md`) — Supported-path
migration complete; visual validation pending.** Both native companions are the
Chromium-fidelity contract. With them validated, pinned ICU supplies Unicode
properties, pinned HarfBuzz shapes every run and owns normalization/cluster
behavior, and platform APIs own fallback. JavaScript codepoint heuristics and
generated host-inventory routes remain only as loudly warned, nonfatal
helper-absent compatibility.

**Doc 130 (`docs/130-paint-geometry-oracle.md`) — Partial stage gate.**
`npm run paint:geometry-oracle` exactly compares source-transcribed linear
magic-corner geometry, radial ending shapes plus negative/out-of-range domain
normalization, Blink stop fixup and nine-stop color hints, basic clip shapes,
and gradient-mask geometry against the production SVG builders. Mutation
controls prove both the old direct-to-corner approximation and SVG-side radial
clamp move. Conic center/domain/zoom/raster ownership has structured and live
coverage. SVG effect geometry boxes also have source-transcribed class
selection, mutation, live-browser, capture-contract, and strict visual evidence;
the production path preserves computed declarations and delegates bounding-box
resolution to native SVG. URL clip sources are a separate exclusive Blink
operation: any URL-plus-geometry-box form is invalid; bare HTML references use
the border box (with objectBoundingBox normalized content explicitly mapped
through it), while SVG-child references force fill-box. Strict capture→SVG DPR
1/2 controls cover stale trees, transparent hosts, nested frames, and external
references (DM-2362, doc 39).
All 118 logical rows are exact at the unchanged `0.00011` tolerance. DM-2528/
[doc 223](../223-legacy-webkit-gradient-geometry.md) adds pinned Blink/Skia
ownership for deprecated `-webkit-gradient()` linear endpoints, two-circle
radial geometry, unitless effective zoom, physical writing axes, and
stable-sort-before-terminal-clamp stops. Modern-line substitution,
width/height exchange, and omitted-zoom mutations all fail while modern and
repeating routes remain unchanged. DM-2494
adds source-derived URL-mask `round`/`space` ownership: mask-origin supplies
tile size/phase, mask-clip supplies the tiled paint destination, and a
collapsed-area mutation is rejected structurally and by DPR-1/2 Chromium ink.
DM-2358/[doc 188](../188-generated-svg-effect-combinations.md) extends that
contract from curated rows to 37 deterministic cases covering all 1,088 pairs
among 19 shape, unit, reference-box, viewport, filter, marker, non-scaling-stroke,
transform, mask-longhand/composition, and interpolation axes, plus all 83 values
of six source-selected Blink dependency triples. External CSS
marker resources, `vector-effect`, and SVG `color-interpolation` are now baked
as computed declarations without moving their geometry into Domotion. The
logical gate proves resource/reference identity and native versus Chromium-owned
projective ownership with four destructive controls before fixed DPR evidence;
the native macOS/Linux/Windows workflow records fingerprinted DPR-1/2 reports.
Unselected higher-order combinations and future effect classes remain the
explicit partial boundary; this is not exhaustive CSS Cartesian coverage.

**Doc 107 routine parity matrix — Shipped.** The synthetic workflow derives a
deterministic modulo-256 low-byte bucket and complementary coverage focus from
the workflow ordinal, records both beside the tested revision in shard/merged metadata, and runs the 351-stack
single-axis matrix on macOS, Linux, and Windows. The first shard also gates
cluster/webfont fallback with a required disabled-path movement arm and the
variable-axis paired oracle. Explicit byte, range, stack-filter, and exhaustive
inputs provide targeted and confidence/release reruns.

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
   contract. What's in scope, what isn't, what tolerance applies. Multicol text
   preserves Chromium's physical fragment coordinates through forced breaks,
   break avoidance, and spanning-element column-group transitions (DM-2161).
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

- **Cross-platform border/outline phase envelopes (DM-2355/DM-2491, docs
  127/191) — Shipped source-exact matrix.** The native HTML-versus-img-rendered-SVG
  producer now fingerprints source pins, corpus, runner, and every lossless
  artifact; a separate strict macOS/Linux/Windows gate crosses DSF 1/2/4 and
  zoom 0.8/1/1.25. Pinned Blink reference-box ownership ratifies all 128 rows
  per scenario with narrow stable paint ceilings. Uniform `border.double`
  rounds one reference rectangle before deriving both Blink big-third stripe
  boxes; the full local matrix repeats with all 144 double rows at zero error
  and no envelope widening, while `outline.double` remains unchanged.

- **Projective inline-SVG raster ownership (doc 162) — Shipped.** Chromium CDP
  content/border quads now distinguish actual non-affine paint from inert
  `perspective`/`preserve-3d` property presence without appending HTML markers
  to SVG. A projective root, an owning HTML ancestor, or HTML 3D inside
  `<foreignObject>` crosses one effective outer Chromium surface; any owner
  hidden under an atomic `svgContent` clone is promoted to the outermost
  suppressing inline-SVG root. The isolated full-viewport snapshot is trimmed
  by real alpha, retains DPR, excludes vector siblings, and emits once at the
  clone's content paint position. Affine matrices, planar matrix3d, and
  source-flattened SVG graphics remain vector. The focused DPR-2 oracle covers
  nested foreignObject, zoom, scroll, ancestor rotation/opacity/filter,
  overflow/border clipping, off-bounds paint, and a vector sibling within four
  device pixels. Exact SVG-child used
  affine freezing remains the separate follow-up documented by doc 162.

- **Arbitrary contain/cover mask positions (DM-2379, doc 20) — Shipped.**
  Chromium-decoded per-layer intrinsic dimensions and effective-zoom-adjusted
  computed positions feed a Blink LayoutUnit transcription: concrete
  contain/cover tile first, then physical x/y length-percentage resolution
  against the remaining space (including negative cover space). SVG receives
  an exact rectangle with no Min/Mid/Max alignment decision. Wrapped slice
  masks continue across a clipped synthetic strip; clone/block fragments
  restart. A DPR/zoom Chromium-vs-SVG oracle covers percentage, length, calc,
  vertical writing, fragments, and multi-layer ownership and rejects the
  retired quantized route.

- **Independent HTML mask origin/clip boxes (DM-2472, docs 20/174) — Shipped.**
  Capture retains computed per-layer `mask-origin` separately from
  `mask-clip` and crosses physical border/padding edges through CSS zoom once.
  URL contain/cover, explicit sizing, calc positioning, repetition, cyclic
  composition, writing modes, and slice/clone fragments size and anchor from
  Blink's origin positioning area, then intersect against the distinct
  border/padding/content painting area; no-clip remains unbounded by the HTML
  border box. A DPR-1/2 Chromium-vs-SVG oracle includes same-box controls and
  rejects the collapsed-origin-to-clip mutation. DM-2494 extends the exact
  split through URL `round`/`space`: the origin owns tile size/phase and the
  clip owns the SVG pattern/no-repeat destination; collapsing the pattern cell
  to the origin box is independently rejected at DPR 1/2.

- **Raster activation boundaries (doc 134) — Shipped.** A 24-row gate pairs
  every live raster ownership class with its representable vector control,
  including helper-disabled text, recursive iframes, projective transforms,
  advanced gradients, and the retired textarea/vertical-text raster path.

- **Source-frame-coherent native controls (DM-2456, doc 167) — Shipped.**
  Required native host paint consumes one authoritative compositor frame and
  one atomic transparent isolation frame for all owners, never per-control
  screenshots. Static source RGB is used only where isolation proves alpha
  255; transparent checkbox/radio edges and positioned overlaps remain
  isolated. Time-dependent paint consumes its complete overlap-free source
  crop or fails closed, so no later alpha surface can move its edge.
  Clip/DPR/content validation is fail-closed: a missing required bitmap emits a
  named capture warning and no sampled `form-controls.ts` chrome. The
  all-platform E2E matrix covers progress/meter timing, state, alpha, overlap,
  outline overflow, viewport clipping, scroll, fractional zoom/DPR, and forced
  screenshot failure.

- **Sampled native-control fallback retirement (DM-2458, doc 182) — Shipped.**
  `formControlRenderRoute` makes Blink EffectiveAppearance the terminal owner:
  complete native appearances consume a materialized Chromium surface;
  required-raster absence and unknown old captures warn and emit nothing; only
  captured structural `none`/`base`/`base-select`/`listbox`/
  `menulist-button` paint reaches the remaining helpers. The macOS light/dark
  palettes, accent luminance threshold, and all sampled native checkbox/radio/
  range/progress/meter/file/date/select/spin/search/details branches are
  deleted. A 24-row static/mutation gate and fingerprinted macOS/Linux/Windows
  browser matrix cover state, accent, scheme/forced colors, zoom/DPR, direction,
  whole-host/partial/structural ownership, and missing-source failure.

- **Blink EffectiveAppearance ownership (DM-2453, doc 170) — Shipped.**
  Native-control routing now uses the pinned LayoutTheme auto mapping and
  author-style switch instead of host tags or a CSSOM declaration scan.
  Chromium CDP matched-rule facts preserve UA/user/author origin, shorthand,
  logical sides, importance, layers/scopes and rollback keywords; active
  animation/transition origins participate before the author background and
  border flags are collected. Font/color/padding/text-shadow alone retain a
  native button; author background/border deactivate button/progress/meter,
  shadow additionally deactivates text controls and turns menulist into
  menulist-button, while checkbox/radio/range stay native. Partial or
  substitution-ambiguous data emits a named warning and keeps a conservative
  Chromium host raster. The focused activation matrix runs on all three OSes.

- **Closed-shadow control decorations (DM-2455, doc 171) — Shipped.** Styled
  control hosts and value text remain structural while Chromium supplies only
  the source-owned menulist arrow, temporal picker, search cancel, or number
  spin layer. Capture retains the actual pierced UA node and used quad, uses
  one state-preserving transparent isolation frame, verifies exact reversible
  select-inner restoration, and fails closed without sampled glyphs. Paint
  phase, culling/reference bounds, base-select negatives, interaction,
  scheme/forced-colors, writing axes, zoom, fractional geometry, and DPR are
  gated on macOS, Linux, and Windows.

- **Native file-selector button (DM-2454, doc 172) — Shipped.** A file host's
  `appearance:none` does not own its closed-shadow upload button: capture
  resolves the real child button's EffectiveAppearance and crops exactly its
  platform-painted border quad. The 4 px logical margin, host/focus paint, and
  localized status sibling remain structural; status text uses Chromium's
  captured segments for multiple/long labels, bidi, and vertical writing.
  Unknown child facts or changed topology warn and suppress the sampled button.
  Author background/border/radius/none retain the existing vector pseudo route;
  author font/color/padding/shadow retain native paint. SVG composes button
  shadow overflow, exact child pixels, then status text.

- **Replaced/control/generated geometry (doc 133) — Shipped.** A live
  11-row Chromium oracle gates every object-fit mode, exact percentage/calc
  object-position, native-vs-author control ownership, and positioned
  `::before`/`::after` boxes. Images now emit Blink's concrete object rectangle
  instead of reducing alignment to SVG min/mid/max buckets.

- **Transformed dynamic replaced surfaces (DM-2380, doc 17) — Shipped.**
  Canvas/video/inaccessible-frame snapshots use Blink's CDP content quad in the
  capture walk's transform space. Rotation/skew is neutralized for sampling and
  applied once by SVG; ancestor overflow/clip/mask nodes are likewise suppressed
  only while sampling and remain owned once by the SVG clip tree after that
  transform, with scroll offsets restored.
  Pure affine scale/translation stays baked, projective paint stays one outer
  Chromium surface, and actual PNG dimensions define the device-pixel-to-CSS
  map. A DPR-2 Chromium-vs-SVG gate covers partial off-page paint, nested affine
  transforms, CSS zoom, scroll, source-image cropping, clipped video/frame
  pixels, vector siblings, and double-transform/stretch/clip-order mutations.

- **Symbol list-marker geometry (DM-2192, docs 01/38) — Shipped.** Disc,
  circle, square, and disclosure markers use Blink's captured-font-ascent
  integer sizing/offset formulas and physical edge snapping; disclosure paths
  follow the marker's writing direction. Ratio-based diameter/baseline guesses
  remain only as old-capture metric fallback.

- **Source-owned `<summary>` disclosure markers (DM-2457, doc 180) —
  Shipped.** Capture correlates Chromium's real `::marker`, verifies one
  axis-aligned content quad, and records the anonymous DOMSnapshot paint
  fragment, primary-font ascent, specified marker size, zoom, color, list
  position/type, writing mode, and direction. The generic Blink marker route
  owns exact open/closed polygons; absent, suppressed, transformed, or
  ambiguous facts never fall back to the deleted details-box triangle.
  A higher authoritative subtree raster may preempt the vector without
  double-paint. The DPR-1/2 gate covers the full state/writing/zoom matrix on
  macOS, Linux, and Windows and retains both details HTML fixtures as composed
  controls.

- **Vertical text baselines (DM-2193, doc 02) — Shipped.** Vertical column and
  text-combine segments carry the captured run's font ascent; upright glyphs,
  rotated origins, and combined runs use that metric. Element ascent and then
  `0.85em` remain compatibility fallbacks for older captured trees only.

- **Vertical orientation ownership (DM-2525, docs 02/216) — Shipped.** Mixed
  orientation uses the complete Chromium-pinned ICU 17
  `Vertical_Orientation` property and Blink's `Grapheme_Extend` inheritance at
  UTF-16 boundaries; ordinary text, pierced broken-image fallback text, and
  generated pseudos share one owner. Text combine is valid only for
  vertical-rl/lr, never sideways-rl/lr, and sideways-lr physical envelopes
  come from the exact captured Range union rather than logical first/last
  order. Transition/source-digest checks, four active mutations, and an exact
  live placement corpus run on macOS/Linux/Windows with no visual fitting.

- **Gradient computed lengths (DM-2194, docs 07/10) — Shipped.** Chromium's
  computed-style serialization is the context-sensitive boundary: font/root/
  viewport-relative gradient lengths become px in the source element's real
  style context, percentages remain relative through capture, and the renderer
  resolves px/%/flat calc sums against the gradient line or radial reference
  box. Raw unresolved context-dependent units are rejected rather than coerced
  from their numeric prefix or against an assumed 16px font. Repeating-linear
  px stops cross effective zoom exactly once. Negative and
  over-line repeat domains move the SVG vector; coincident domains paint the
  final solid color. A DPR1/2 three-platform logical-interior gate replaces the
  retired per-fixture relaxation without fitting antialiased edge pixels.

- **Doc 119 (`docs/119-degraded-font-resolution.md`, DM-2195) — Adopted.**
  Helper-absent macOS/Linux rendering remains supported as a deterministic,
  functional best-effort mode: retain the static fallback chains, warn loudly
  when automatic helper acquisition fails, and explicitly relinquish Chromium
  parity for installed-family selection, fallback faces, traits, axes, and
  pixels. Helper-present routing remains live-before-static; Windows retains
  its Chromium-derived hardcoded nomination stage. Renderer-route evidence must
  fingerprint the helper implementation and availability arm; records from
  different arms are incomparable after cache invalidation, and native-only
  facts in the absent arm are explicitly withheld.

- **Doc 126 (`docs/126-backdrop-filter-isolation.md`, DM-2171) — Shipped for
  direct target isolation; source-surface transitions remain partial.**
  Elements with a non-`none` computed `backdrop-filter` become isolated
  Chromium-composited box-surface boundaries. The captured image includes the
  sampled backdrop and the element's own ordered filter surface; descendant
  subtrees are excluded from that crop and emitted as vectors above it. Doc 187
  records where a viewport-final crop cannot stand in for Blink's Backdrop Root
  Image without replaying ancestor effects.
- **Doc 114 (`docs/114-angled-linear-wipe.md`, DM-2041) — Shipped.** The linear
  `wipe` transition accepts `wipeAngle`, clockwise from its byte-identical
  left-to-right default. Non-axis angles use analytically clipped, fixed-eight-
  vertex polygon samples so CSS interpolation remains valid across viewer
  engines; both ordinary and mixed-family reveal paths carry the parameter.
- **Doc 115 (`docs/115-parameterized-transition-design.md`, DM-2042) —
  Investigation complete.** Transition names, optional knobs, animator dispatch,
  and duplicated CLI schemas should converge on a shared discriminated schema
  plus a compatibility normalizer into one viewer-safe motion plan. Delivery is
  split into DM-2070 (foundation), DM-2071 (built-in parameters), and DM-2072
  (bounded custom recipe); legacy defaults retain byte-identical output.

- **Doc 113 (`docs/113-cluster-granularity-fallback.md`)** — **Shipped,
  default-on for BOTH run splitters (embedded-font and glyph-path).** Blink
  runs font fallback at SHAPED-CLUSTER granularity (shape with the current
  font, requeue only the `.notdef` clusters — `ExtractShapeResults`);
  `src/render/cluster-fallback.ts` ports that mechanism (script itemization
  first, full-text buffer context, explicit script/direction/language,
  same-face bidi/script item-boundary and direction preservation,
  last-resort stage, U+3000 rule, unmatched-variation-sequence recycling,
  webfont primaries + unicode-range partitions, exact `@font-face`
  weight/style/stretch capability-group selection, shape-verdict cache) and
  replaces `splitTextIntoFontRuns`' per-codepoint cmap walk; the glyph-path
  emitter (`splitTextIntoGlyphPathRuns` → `textToPathMarkup`) invokes the same
  splitter in its "paths" mode. Every candidate's `.notdef` probe receives the
  same resolved OpenType feature state; dotted-circle insertion and canonical
  decomposition belong to that candidate's HarfBuzz shape; a locally unopenable
  face cannot restart assignment through the legacy walk. Raster emoji remain
  on the shared Chromium terminal (`DOMOTION_CLUSTER_FALLBACK=0` explicitly
  restores the legacy walk in both). Both entry points score 10/10 on the Chrome CDP probe
  corpus where the legacy walk scores 6/10. Also carries the static-chain
  retirement measurement: over the
  conformance universe × top-6 stacks, `staticChain()` answered 6 of 916k
  system-stage decisions on macOS and 0 of 780k on Linux. The existing
  unicode-grid sweeps are one-codepoint-per-cell and structurally cannot grade
  this mechanism (gating corpus tracked separately).
  DM-2502 found one omitted independent source-presentation boundary; DM-2507
  closes it with Blink's min-end intersection and per-intersection iterator.
  `tools/emoji-presentation-ownership-audit.ts` now requires order-invariant
  color ownership while leaving family, selector, CSS, and raster negatives
  exact. DM-2508 tracks release activation, not a renderer ownership gap.
  DM-2350/doc 202 separately audits palette choice within one already selected
  COLR gid. A pinned WPT CPAL fixture produces 22 exact native DPR-1/2 rows for
  normal, theme, named, override, and invalid-rule transitions with no pixel
  envelope. Production now captures the family-matched rule/base/override
  identity and selected face/gid/representation in the color-glyph cache key.
  The A/B and reverse-order controls retain two byte-exact PNGs; selected-glyph
  raster activation remains exact. DM-2510 promotes that proof to the strict
  native paint gate: an independently pinned COLRv1 PaintLinearGradient source
  joins the exact COLRv0 rows at DPR 1/2 on macOS, Linux, and Windows. The
  COLRv1 arm requires source-bounded channels, active palette mutations, and
  exact missing/mismatched-rule collapse; it covers Fontations on all three
  platforms while COLRv0 retains the Windows DirectWrite split. No percentage
  or adjustable anti-aliasing envelope is introduced. DM-2534 closes the
  dynamic states: the captured identity recursively preserves mix endpoints,
  weights, normalized animation progress, alpha multiplier, interpolation
  space, hue method, resolved document rule/base/overrides, and selected
  face/gid/representation. Exact DPR-1/2 controls cover sRGB mix, Oklab frozen
  animation, document adopted-sheet last-wins behavior, document palette rules
  inside open shadow trees, ignored shadow-local rules, and forward/reverse
  native-to-captured raster order under explicit headless Chromium.
- **Doc 112 (`docs/112-decoration-geometry-oracle.md`, DM-2009)** —
  **Shipped.** `tools/decoration-oracle.ts` (`npm run decorations:oracle`)
  grades text-decoration GEOMETRY against Chrome's paint and Blink's
  transcribed rules, because whole-fixture pixel-diff structurally rewards
  the wrong decoration constants (they were fitted against the rasterization
  gap). The decoration-geometry transcription (DM-2012) has since landed:
  `getDecorationMetrics` / `emitDecorationLine` emit Blink's rules exactly —
  fragment-top anchoring on the captured FloatAscent, fs/10 auto thickness,
  gap `max(1, ceil(t/2))` zeroed by an explicit offset, per-style paint snap
  — and ALL THREE legs pass and gate by default. DM-2345 (doc 207) adds
  effective-zoom ownership and fingerprinted cross-platform evidence: its
  `zoom: 1.25` absolute-length discriminator exposed and closed a missing
  renderer multiplier, and the pinned Linux arm64 run is exact at
  109/109 transcription, 30/30 skip-ink/pattern, and 109/109 rule-vs-SVG.
  Windows run 32624743248 ratifies 109/30/109 exact at both DPR 1 and DPR 4.
  The DirectWrite helper now transports raw selected-face OS/2 typo metrics for
  `under`; integer solid snaps, wavy DPR-1 paint bounds, and patterned edge
  alpha are classified without changing the 0.2/0.3/0.9 envelopes. The
  workflow retains exact fingerprinted reports. DM-2514 closes vertical
  writing through the same shared line-relative emitter plus a dedicated
  central-baseline resolver: locale-derived Kana/Hangul versus other-script
  sides, semantic underline/overline flip, central em-edge offsets, target
  UsedFont ownership for propagated declarations, and upright-glyph skip-ink
  suppression, including the source distinction between `auto` exclusions and
  `all` intercepts. Its independent 26-row logical oracle has ten destructive
  controls; a separately classified live Chromium lane authenticates 16/16
  sides at coherent DPR 1/4. Neither lane changes a raster envelope. DM-2501
  (doc 200) additionally
  binds Chrome paint and Domotion capture to one DPR-qualified Blink fragment
  state: the original Linux arm64 run compared DPR 4 with DPR 1 and produced
  a false uniform `+1px`. Coherent DPR-1/DPR-4 regressions and the native-arm64
  aggregate now reject cross-DPR evidence and any widening of the `0.3px`
  geometry envelope; no production renderer change was required.
  Discrimination proven: restoring the
  known-wrong skip-ink dilation (`max(0.5, t/2)` vs Blink's `min(t, 13)`)
  drops the skip-ink leg from 4/7 to 1/7 with edge errors growing from
  ≤1.45px to 3.95px.
- **Docs 110 + 111 (`docs/110-family-match-conformance-linux.md`,
  `docs/111-family-match-conformance-windows.md`, DM-1938)** — **Shipped.**
  The declared-family style matcher now runs Blink's own mechanism on all
  three platforms, each with its own conformance oracle and committed,
  environment-fingerprinted baseline. Linux: the Linux glyph helper's
  `familyMatch` query transcribes `SkFontConfigInterfaceDirect::matchFamilyName`
  at the Skia revision the pinned Chrome tag (147.0.7727.15) actually ships
  (which differs from the current Skia tree), replacing the two-slot
  `key`/`key-bold` sibling table via `linuxPrimaryCutKey`;
  `npm run fonts:family-match:linux` scores 2,292/2,292 on the noble image.
  Windows: the DirectWrite `family` query was already the identical call, and
  measuring it exposed the missing Blink family-name suffix layer
  ("Segoe UI Light" → "Segoe UI" with weight pinned at 300,
  `src/render/win32-family-suffix.ts`); with it ported,
  `npm run fonts:family-match:win32` scores 516/516 on the Windows 11 VM.
  Both platforms verified in the loop by disabling
  (`DOMOTION_SYSTEM_FALLBACK=0` / `DOMOTION_DISABLE_HELPER=1`) and requiring
  the resolved face to move. The env fingerprint now carries the **Chromium
  build** as well, since Chrome's answers are what these oracles grade;
  `envMatches` skips a field absent on either side ("cannot tell", not
  "known different") so adding it did not disarm the committed sets, and the
  check arms per environment as each is re-seeded.
- **Linux declared-family NOMINATION walk (doc 110, DM-1955)** — **Shipped.**
  The stage ABOVE the cut matcher now runs Blink's stack walk verbatim for
  non-generic names on Linux: ask the transcribed matcher per name, retry a
  rejection once under Blink's alias (Courier ↔ Courier New, Times ↔ Times
  New Roman, Arial ↔ Helvetica), walk past on rejection, and run the
  transcribed last-resort chain ("" → Sans → Arial →
  `legacyMakeTypeface(nullptr)`) when everything rejects. Fixes measured
  divergences (declared "Courier New"/"Courier" now paint Liberation Mono as
  Chrome does, not WenQuanYi; rejected "Menlo"/"Consolas"/"Helvetica Neue"
  land on the `-webkit-standard` stand-in). The settings-mapped generic
  keywords now go through the SAME walk after swapping in the capture
  session's settings value — Playwright's vendored Linux table
  (`defaultFontFamilies.js`, playwright-core 1.59.1; equal to the
  `locale_settings_linux.grd` defaults at rev 7d859f27: cursive →
  "Comic Sans MS", fantasy → "Impact", serif → "Times New Roman", sans-serif
  → "Arial", monospace → "Monospace"; math → "Latin Modern Math" from the
  `WebPreferences` constructor since Playwright has no math key), so a
  settings value the matcher's acceptance filter rejects makes the family
  unavailable and the stack terminates at the standard family — which is why
  bare `cursive`/`fantasy` paint Liberation Serif on the noble image. Only
  `system-ui` (a `FontCache::SystemFontFamily()` value, not a settings-table
  entry) remains un-transcribed; Playwright's Linux table has no per-script
  entries, so the content script never moves a Linux generic (doc 110).
- **Live Common/script generic-family preferences (font-resolution-diagram §2,
  doc 198)** — **Shipped.** The settings-mapped generics resolve per content
  script, mirroring `FamilyNameFromSettings`'s `settings.<Generic>(script)`
  consult with the values the exact capture Page paints. Capture probes on
  every call; legacy arrays serialize authority on their top-level roots while
  the versioned captured-tree envelope stores it once and preserves it through
  identity-checked descendant promotion and JSON round-trips. Render selects
  either form in a synchronous `try/finally` scope; no BrowserContext cache or
  production process-global survives to contaminate another Page. Language
  discovery reads Blink's flattened DOMSnapshot and response-header-owned
  content language, so closed-shadow-only and header-only scripts are covered.
  `resolveFontKey` /
  `resolveFontKeyChain` / `resolveFont` take the element's `lang`; the
  lang→script mapping is `LocaleToScriptCodeForFontSelection` transcribed in
  full (`src/render/generic-script-families.ts`, drift-guarded against the
  installed playwright-core). The standard family is script-keyed in the same
  change, both as the exhausted-stack terminal and as the chain's final
  pre-system-fallback entry. Quoted generic spellings stay literal family
  names (`splitFontFamilyNames` carries a per-entry generic bit;
  `system-ui`'s dispatch is name-keyed per `font_cache.cc:161-166` and
  ignores the bit). The strict logical gate crosses pinned/full Chrome,
  headless/headed, Common + ten standing scripts + Page language scripts, and
  dynamically derived preference mutations on macOS/Linux/Windows. It uses
  `system-ui` only as a separation control and has no pixel tolerance.
  The isolated-profile gate in docs 212/219 additionally proves the upstream
  PrefService/WebPreferences route. All 21 Common/Japanese/Devanagari fields
  must persist raw and paint exactly in headed Chrome; headless ownership is
  split only by the keys derived from Playwright's installed source table.
  Full-Chrome path/SHA/channel/command-line/user-data-dir identity, both profile
  launch orders, and both all-field main/OOPIF mutation orders are mandatory.
  Cross-site target divergence is detected and refused rather than inheriting
  unauthenticated main-Page authority; `system-ui` remains a stable separate
  control. No fixed overlay count, pixel tolerance, or font-name answer table
  can satisfy the gate.
- **Platform-owned `system-ui` preferences (font-resolution-diagram §2,
  doc 211, DM-2504)** — **Shipped logical gate.** `system-ui` bypasses generic
  Settings: macOS resolves a CoreText UI handle through the pinned
  `MatchSystemUIFont` transcription, Linux consumes the browser-owned renderer
  system family (including `--system-font-family`) through the transcribed
  Skia/fontconfig cut matcher, and Windows reads the live
  `NONCLIENTMETRICS.lfMenuFont` family then matches its DirectWrite cut.
  `resolveSystemUiFontFace()` exposes those native logical answers without an
  OS-name table. The four-launch native workflow derives every alternate from
  the current inventory, requires a face movement and exact PostScript/family
  join, carries source/platform/font fingerprints, and uses no screenshots,
  pixel tolerance, or committed answer snapshot. The Windows mutation is
  explicit and restored in `finally`; environment invalidation now also expires
  the memoized menu family, with a stale-before/fresh-after discriminator.
- **Resolved keys do not own Blink's generic-family semantic (font-resolution
  diagram §§3/7, doc 206)** — **Exact three-platform gate shipped.**
  Blink preserves the rightmost enum-bearing generic in `FontDescription`
  independently of the concrete selected family. Domotion now derives that
  semantic once from the unresolved stack, carries it through fallback requests,
  and keys the OS fallback memo by normalized declared head plus node kind. A
  strict 26-row Arabic/Hebrew discriminator runs forward and reverse from one
  cache clear on macOS/Linux/Windows. It independently fingerprints Chromium's
  source enum, Windows candidate order, and complete raw platform terminal
  questions, compares pure production seams, and then asserts normalized
  terminal owners, activation, routing, and cache identity separately. Exactly
  one CDP-painted glyph corroborates each row; no face-name snapshot or pixel
  threshold grades it. When family/settings selection exhausts, the common-Skia
  terminal asks the descriptor's legacy generic first (or unnamed for
  none/system-ui/math), keys only that terminal result by the source-selected
  family, and leaves the concrete face/style cache generic-agnostic. A
  repository-owned forward/reverse family-exhaustion suite covers named
  Courier, monospace, serif, system-ui, math, and non-occupying controls; its
  shaped U+E000 mutation distinguishes first-candidate `.notdef` from a covering
  monospace last-resort face without host snapshots or raster assertions.
- **Family-match CI gates (docs 110/111, DM-1953)** — **Shipped (awaiting
  first-run baselines).** Regression-relative against env-keyed baseline SETS
  (`tools/family-match-baseline.ts`; one entry per environment fingerprint in
  the same committed file). The first CI run on each x64 image records a
  candidate baseline and uploads it as an artifact; committing it arms the
  gate. **`Linux family-match conformance` runs per PR** (test-linux.yml);
  **`Windows family-match conformance` is manual-dispatch only**
  (windows-fidelity.yml) because its DirectWrite path is substantially slower;
  this scheduling difference does not change its first-class support contract.

- **PLATFORM SUPPORT.** macOS, Linux, and Windows are **first-class** for
  font-capture precision, and a parity defect on any platform is a real defect.
  macOS is always the primary development and testing platform. Linux and
  Windows receive native validation for affected changes; Windows fidelity is
  manually dispatched and routine conformance is sampled because DirectWrite
  runs are slower, not because Windows has a weaker correctness contract.

- **Doc 104 §3.1 (DM-1796) — typing-overlay handoff seam, FIXED.** A `typing`
  overlay used to fade out starting 150 ms before its window ended and sit fully
  transparent for the last ~50 ms. But a typing overlay exists to be REPLACED —
  the next frame (or compressed-run state) carries the same value as real
  captured text — so the pre-fade opened a hole where the value was on NEITHER
  side: a measured ~120 ms blank field on `examples/animate/form-fill/`,
  reported as "the input value disappears then reappears". The overlay now holds
  at full opacity through its window's end and leaves the way its frame does:
  hard `step-end` cut at a `cut` boundary or a state snap, dissolve across a
  non-`cut` transition, and the historical fade ONLY on the scene's last frame
  (nothing takes over before the loop wraps). `holdToFrameEnd` (DM-1749) is thus
  the default wherever it mattered; the field is retained and still forces the
  cut in the other two cases. Guarded by `tests/typing-handoff-seam.e2e.test.ts`
  — a rasterized, 10 ms-resolution walk across the boundary asserting the field
  never blanks OR thins (verified to fail on the pre-fix build with a 110 ms
  blank). Only `form-fill`'s golden moved.

- **Doc 105 (`docs/105-asymmetric-harness-browsers.md`, DM-1790)** — **Shipped**
  (opt-in; nothing runs in this mode by default). `tests/runner.tsx` and
  `tests/html-test-suite.tsx` each drove ONE Chromium for BOTH the expected
  paint and the candidate SVG's rasterization, so a `chromium.launch({ args })`
  flag meant for one side silently moved both — which makes a capture-only
  experiment unmeasurable (docs/66: `--font-render-hinting=none` reads as an
  IMPROVEMENT in embedded render mode purely because the flagged browser also
  rasterizes the SVG's hinted subset font unhinted; a real consumer's browser
  does not). `DOMOTION_CAPTURE_FLAGS` / `DOMOTION_RASTER_FLAGS` now configure
  the two sides independently: neither set ⇒ one browser (the unchanged default
  every committed baseline was measured under), capture only ⇒ asymmetric (the
  consumer's condition), both identical ⇒ the historical coupled behavior stated
  deliberately. Two things it has to get right: the default path must stay
  byte-identical (same `Browser` object under both names, no extra context), and
  the html-test **expected-PNG cache key** must include the capture flags — it
  didn't at first, and three conditions produced identical coverage to four
  decimals because the flagged runs reused the unflagged cached screenshots.
  Validated on Linux (`--disable-lcd-text`, which unlike the hinting flag does
  change that platform's paint): three configurations → three genuinely
  different numbers, with the asymmetric one NOT between the other two.

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
  **Independent regions (DM-1770) — discrimination, per-region timing, AND the
  per-region size guard (DM-1772) all shipped.** Line
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
  `examples/animate/region-timing/`. **Per-region size guard** (DM-1772,
  docs/103): the whole-run revert is now a per-region decision made on REAL
  BYTES. The trigger only arms it; the guard then picks the smallest of
  {keep-all, per-region demotion, `composeStatesFlipbook` floor}, each sized in a
  `snapshotGeneration()` / `restoreGeneration()` trial so a discarded compose's
  PUA / `dmfN` addressing never leaks (DM-1771, doc 99 § speculative
  composition). Demoting a region moves its text into the chrome union (the
  ineligible path — pixel-safe, occlusion check stays whole-tree); demoting all
  is the whole union, which beats the flipbook where states share subtrees it
  deduplicates (mixed fixture 81.8 vs 97.8 KB). The flipbook is kept as a floor
  (not replaced) so `autoCompress` still never grows output on a pure-wholesale
  run the union can't dedupe. Coverage: `tests/compress-size-guard.e2e.test.ts`
  (mixed fixture beats the flipbook, byte-identical re-compose, pixel parity).
  And (2) a **caret + selection track** — declarative
  caret/selection anchored node-side to captured text (`selector` + char offset
  over segment `xOffsets`; `caretShapeRect` geometry; blink + sweep), standalone
  and useful beyond editing. The original document-model + op-timeline core is
  recorded as a superseded alternative (ops could later compile to states + a
  compressed run). Includes two small independent fold-ins on the existing
  `typing` overlay: `holdToFrameEnd` (opt out of the forced 150 ms end-of-frame
  fade) and a baseline anchor mode (`anchor.baseline: true`).
  **Automatic run detection (DM-1757) — shipped, default ON (DM-1768).**
  `autoCompress` (opt out with `false` / `--no-auto-compress`; docs/43 §13) runs a
  config pre-pass in `composeAnimateFrames` that collapses maximal consecutive
  `continue` + `cut` runs into `states` frames — reusing the block machinery
  verbatim, so the 1 config-frame ↔ 1 animation-frame reindexing (frameStartsMs,
  cursor `events[].frame` remap) falls out of operating on the rewritten config.
  Output is pixel-identical to the flipbook (`tests/auto-compress.e2e.test.ts`);
  the win is raw size + live-DOM weight. It compresses runs with no
  animations/textTracks/forceState crossing them (per-frame `overlays` ride along
  as per-state overlays since DM-1767); anything else is left uncompressed with a
  logged reason.
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
  asked for is warned about, never rewritten. The default-flip to ON SHIPPED
  (DM-1768): all three prerequisites met — (1) exclusion set (every per-frame
  decoration split cleanly), (2) size guard (DM-1772), (3) golden regen was a
  no-op at the time (byte-neutral across all 26 goldens — the corpus then had no
  auto-collapsible plain continue+cut run). Opt out per config with
  `autoCompress: false`.
  **Per-overlay windows + per-state overlays (DM-1767, docs/104) — shipped.**
  The two overlay-model changes DM-1764 identified, now built, which removed
  `overlays` from the exclusion set. (1) **`endAt`** on every overlay kind: the ms
  from frame start at which THAT overlay's window closes instead of the frame's
  end — clamped to the frame, so an overlay may end early but never leak across
  the cut; plus a `delay` on the `svg` kind so all six share one `[delay, endAt]`
  window. Useful standalone (bound an overlay inside an ordinary frame). (2)
  **Per-state `overlays`** on a `states:` run, anchor-resolved WHILE the page is
  at that state (not the run's last) inside `buildStatesRunContent`'s capture
  loop, then re-based onto the frame's timeline (`delay` += the state's offset,
  `endAt` pinned to the state's end). On collapse each member's overlays become
  its state's, so an overlay-carrying run compresses whole and reproduces the
  authored behavior exactly. Corpus impact: `form-fill` 4 → 2 animation frames
  (−12% bytes), `editor-session` 11 → 6 (−15%), both verified pixel-identical
  frame-by-frame across their full timelines (`tests/overlay-window.e2e.test.ts`
  is the rasterized proof — an overlay anchored to a MOVING element appears in
  its state only, at that state's position).
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

- **Doc 26 (`docs/26-self-contained-svgs.md`)** — **Shipped**, extended twice in
  DM-1855 / DM-1866. (a) Every pipeline whose captured tree reaches output inlines
  remote image bytes; the pairing is one call, `captureElementTreeSelfContained`
  (`src/capture/index.ts`), because the several sites that call
  `captureElementTree` directly — animate frames + compressed-run states, the
  scroll executor, storyboard `capture` scenes, `typeResample` re-captures,
  `jsReveal` captures — each re-opened the same dead-href hole. `domotion capture
  --scroll` and the real-world harness opt out (`embedImages: false`) because they
  embed after their own cull pass / with their own warning sink. (b) A repeated
  raster payload is serialized ONCE:
  `hoistDuplicateImagePayloads` (`src/post-processing/hoist-image-payloads.ts`,
  applied by `wrapSvg` / `generateAnimatedSvg` / the scroll composer) emits one
  `<defs>` `<image id="dmiN">` per distinct (payload, width, height,
  preserveAspectRatio) and references it with `<use>` — 137.3 KB → 47.5 KB raw on
  three plates across 26 frames. Keyed on geometry because `<use width/height>`
  does not override an `<image>` referent.

- **Doc 96 (`docs/96-native-svg-image-inlining.md`, DM-1588)** — **Shipped.** An
  `<img src="*.svg">` inlines as a native, positioned, id-namespaced nested
  `<svg>` in the output instead of `<image href="data:image/svg+xml;base64,…">`.
  Chromium rasterizes an SVG-in-`<image>` at layout size then scales it (softens
  at zoom); the native inline stays vector-crisp at any scale and drops the ~33%
  base64 bloat. Trigger `resolveSvgSource(el.imageSrc)` (`src/capture/embed.ts`),
  rewrite `inlineImgSvg`/`prefixSvgIds` (`src/render/svg-inline.ts`), including
  document/shadow-root-scoped fragment ownership for captured DOM inline SVGs, emitted from
  `paintImage`. Raster `<img>` (PNG/JPEG/…) unaffected. This is the *inverse* of a
  raster fallback — see `docs/reference/raster-image-fallback-cases.md`. All
  `object-fit` values take the native path (incl. `object-fit: none` at intrinsic
  size, DM-1592). Ids AND CSS class names are namespaced (`prefixSvgIds` +
  `prefixSvgClasses`, DM-1593 — class scoping runs only for `<style>`-bearing
  SVGs). All three SVG-inlining paths share `prefixSvgClasses` (DM-1595): the
  `<img>` inliner (ids + classes), the DOM inline-`<svg>` path (classes only —
  ids stay for the `<use>` resolver), and the animator overlay inliner.
  Flex/grid used sizing remains capture-owned: Blink's captured border box is
  passed unchanged to raster and native-SVG paint, while intrinsic dimensions
  participate only in `object-fit` inside its content box (DM-2162).

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
  (`tests/cross-origin-iframe-recursion.e2e.test.ts`). DM-2537 now threads a
  fresh Chromium `FrameId`/parent graph, the exact parent-relative allowlist,
  ancestor reachability, frame-local scrollbar owners and raw offsets through
  every scroll anchor. Composition rejects omitted/reused/wrong-frame state;
  denied/inaccessible branches remain diagnosed rasters with no descendant
  owner leakage. A forced OOPIF control authenticates its target/parent IDs
  while web security keeps the child inaccessible ([doc 217](../217-cross-origin-frame-scroll-ownership.md)).
  **Phase 1 (DM-1441):** a same-origin `<iframe>` no longer rasters to a flat `<image>`
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
  all resolve against the iframe's own document. **DM-2338** closes inner mask/clip
  fragment ownership end to end: capture and renderer key by Blink's originating
  `(TreeScope,id)`, output definitions have independent descendant namespaces,
  HTML border-box object/user-space region/content maps retain source viewport
  plus EffectiveZoom, and effective alpha/luminance is explicit. The focused
  DPR-1/2 capture-to-SVG gate covers opposing duplicate ids, zoom, asymmetric
  border/padding, hostile mask image geometry, and binary channel probes; the
  `iframe-inner-clip-mask` feature is strict 0.00% with its relaxation removed
  ([doc 208](../208-iframe-fragment-reference-ownership.md)). **DM-2520** now
  preserves ordered `(layerIndex,TreeScope,id)` fragment-mask lists, cyclic
  per-layer mode/composite values, materialized resource regions/units/zoom,
  and Blink's clipped bottom-up Porter-Duff recurrence. Its duplicate-frame
  DPR-1/2 gate is raw-RGBA exact and rejects scope/operator/mode/zoom
  mutations. Transitive resources outside a copied mask subtree and filter
  refs' existing document-local collection path remain separate boundaries.
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
- **HarfBuzz is vendored, built with Chromium's configuration** — `vendor/harfbuzzjs/`
  is harfbuzzjs v1.4.0 with the wasm rebuilt from the define list in Chromium's
  `third_party/harfbuzz/BUILD.gn`, replacing the npm dependency. The published build
  is `-DHB_TINY`, which compiles out Apple Advanced Typography, so it mis-shaped
  macOS's `morx`-only system faces (GeezaPro returned unjoined isolated forms for
  Arabic). Both projects pin HarfBuzz 14.2.1, and with the configuration matched the
  build reproduces `hb-shape` exactly on both an AAT-only and a `GSUB` face. Two
  divergences remain, documented in `vendor/harfbuzzjs/build/config-override.h`:
  Unicode properties come from HarfBuzz's built-in UCD rather than ICU, and the Rust
  backend is absent (not a divergence for shipping Chrome — Blink pins the `"ot"`
  shaper unless an off-by-default runtime flag is set).
- **Doc 79 (`docs/79-harfbuzz-use-reroute.md`, DM-1197 + DM-1215)** — narrow
  uses of real HarfBuzz (the vendored build above) where macOS shaping diverges
  from Chrome. Since DM-1916/DM-1925 there is a THIRD, and it is much broader
  than the other two: any face carrying both `trak` and `STAT` has its SHAPING
  done by HarfBuzz at the run's CSS pixel size, because AAT tracking is
  size-dependent and no platform helper reproduces it (the macOS helper opens
  every face at `size = unitsPerEm`, so it tracks as though every run were
  1000 px). Thirteen macOS faces carry the pair — SF Pro and SF Pro Italic, SF
  Compact, SF Hebrew, SF Pro Text, and every PingFang cut — i.e. `system-ui` body
  text and CJK. **Outlines do not move with the shaping**: the native-helper path
  routes through `preferShapeFallback` (ids/positions/clusters only) and the
  fontkit path through `installHarfbuzzShaping`, both leaving the original engine
  to draw by glyph id. That split is Chrome's own — Blink shapes with HarfBuzz
  and rasterizes from the platform typeface — and it is load-bearing: an earlier
  attempt that moved outlines too shaped byte-identically and still moved a Thai
  fixture's worst tile from 0.0940 to 0.1214. `DOMOTION_TRAK_HB_SHAPING=0` bounds
  the whole mechanism. **Only the `shape` query tracks; the per-glyph `glyphs` /
  `notdef` queries no longer do.** They report a DESIGN-unit advance, which cannot
  hold a size-dependent term, so they read it from the CTFont's CGFont rather than
  from `CTFontGetAdvancesForGlyphs` — which was silently adding the largest-size
  tracking value to every advance (`.SFDevanagari-Regular` came back exactly 10
  design units short of the file at every `opsz` instance, so the helper's numbers
  for the 126 affected faces were not reproducible by any independent reader). See
  doc 16, "Advances are design units, not typeset units".
  (1) DM-1197: USE-shaped precomposed letters with a canonical base+mark NFD
  (Kaithi `U+110AB`, Balinese, Tulu-Tigalari — 13 cps) shape via HarfBuzz instead
  of the CoreText helper, which recomposes and mis-places the mark; scoped to the
  USE shaper, `DEDICATED_SHAPER_RANGES` stay on CoreText. (2) DM-1215: an
  ORPHANED complex-script combining mark (no spacing base) routes through the
  mark's own font as a HarfBuzz instance so the dotted circle `U+25CC` Chrome
  inserts + GPOS-positions the mark on is reproduced — fontkit drops the ◌ for
  USE faces (Adlam/Miao) and mis-centers it otherwise. Fixed adlam/miao/brahmi/
  kharoshthi/tagalog/tai-tham/syloti via `resolveDottedCircleHbRun` in the
  legacy splitter. DM-2387 removed that pre-pin from the default shaped
  splitter: its ordinary fallback iterator selects the candidate, preserves the
  authored range, and HarfBuzz alone decides whether U+25CC is inserted.
- **Doc 80 (`docs/80-cross-platform-system-fallback-resolver.md`, DM-1403)** —
  **macOS / Linux / Windows all Shipped + default-on.** The per-codepoint live
  system-fallback resolver (macOS CoreText `CTFontCreateForString`) — previously
  hard-gated `process.platform !== "darwin" → null` — is now one
  platform-dispatched entry point (`resolveSystemFallbackKeyForCp`). **DM-1868
  changed WHEN it fires on macOS + Linux:** it is no longer the catcher for
  codepoints the static per-block table misses, it is the stage that *answers*,
  with `fallbackFontChain` demoted to the net below it — Blink's own
  `kSystemFonts` order, since neither `mac/font_cache_mac.mm` nor
  `linux/font_cache_linux.cc` has a static stage preceding the OS call. Windows
  keeps chain-first, because there Blink's hardcoded per-script table genuinely
  is the first answer and `win32FallbackChain` transcribes it.
  `DOMOTION_LIVE_FALLBACK_FIRST=0` restores the old order for an A/B. Linux backend via fontconfig
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
  wrong glyph). **DM-1864 updates the Windows half twice over:** the
  `MapCharacters` call now carries the run's real weight/slant/stretch (a
  transcription of `FontDescription::SkiaFontStyle()` — measured 5/5 faces moving
  to their bold cut at weight 700, where before every weight got the regular cut),
  and Blink's hardcoded per-script stage now runs *ahead* of the resolver as it does
  in Chrome. That invalidates the DM-1424 sweep's "0 codepoints move" reasoning,
  which rested on the sampled table shadowing the resolver — read those numbers as
  a record of the flip decision, not a current measurement. **DM-1871 and DM-1896
  close the call's last two arguments**: `baseFamilyName` (the run's primary
  family, which is what lets that family's own font linking participate) and
  `locale`. The locale was a hardcoded `en-us` in the helper's analysis source
  while Blink resolves one per codepoint
  (`FallbackLocaleForCharacter(...)->LocaleForSkFontMgr()`), so every query was
  asked in English regardless of the page — the Han-unification trap. Transcribed
  in `blinkWinFallbackLocale` and pinned against Blink's own `layout_locale_test.cc`
  table; the reduction keeps the SCRIPT and drops the region, measured on a Win11
  VM for U+6F22 as `ja`→Yu Gothic UI, `ko`→Malgun Gothic, `zh-Hans`→Microsoft
  YaHei UI, `zh-Hant`→Microsoft JhengHei UI, and bare `zh`→Yu Gothic UI (i.e.
  truncating the tag lands on a Japanese face and looks exactly like not passing
  the argument). Skia's `IDWriteNumberSubstitution` — same tag, method NONE,
  `ignoreUserOverride` TRUE — is now built here too rather than passed as null,
  and is **measured** answer-neutral (0 moved answers over every Unicode `Nd`
  digit × 10 locale tags, the full BMP at two style contexts, and the astral
  planes at stride) rather than argued harmless; the `HRNM` bail Skia takes on a
  tag DirectWrite rejects is mirrored as `found:false` and measured unreachable
  across 66 tags. The **simulation-stripping loop** Skia wraps around both
  `GetFirstMatchingFont` and `MapCharacters` is transcribed alongside it — active
  in shipping Chrome via `SK_WIN_FONTMGR_NO_SIMULATIONS`, invisible to a
  PostScript-name oracle by construction, and worth one moved answer in ~600,000
  on a Win11 host. **DM-1889 corrects the Windows half
  again, and more fundamentally: the resolver never actually ran there.** The Node
  side declared a base font (`"Helvetica"`, no path) that DirectWrite does not take
  and the helper cannot open by name, and one-shot mode — Windows's only transport,
  since the persistent channel was disabled for want of a real pipe fd — treats an
  unopenable declared font as fatal. Every call returned an error envelope, read as
  "no fallback font" for every codepoint, so Windows was scoring its static chain
  alone while reporting a stable plausible number. Fixed by declaring no base font
  on Windows, plus a named-pipe persistent channel (~83x cheaper per call). Any
  pre-DM-1889 Windows conformance figure describes the static chain and is not
  comparable to a later one. **DM-1949 makes the macOS half order-dependent, as
  Chrome's is:** Blink caches ideograph (`[:Ideographic=Yes:]`) fallback per
  (base font, raw weight, raw style, orientation, effective size) on the renderer's FontCache — first ask wins,
  later covered ideographs reuse it without re-asking CoreText — so the resolver
  now mirrors that with an owned `FontRendererSession` (one per `DemoRecorder`
  or composition lifetime; standalone renders are isolated), and the
  cascade base became the primary's WEIGHT-MATCHED cut (Times-Bold at 800, not
  Times-Roman) since `CTFontCreateForString`'s nomination tracks the base's cut.
  A/B flags `DOMOTION_MAC_CHAR_FALLBACK_CACHE=0` / `DOMOTION_FALLBACK_BASE_CUT=0`.
  See doc 80's order-dependence section + `docs/font-resolution-diagram.md` § 8b.
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
  (macOS DM-983, Linux DM-984, Windows DM-987). All three are first-class;
  macOS remains the primary and most frequently validated platform. Re-probe
  each native platform when its font inventory or runner image changes.
- **Windows no longer routes off a probed table (DM-1864).**
  `win32FallbackChain` is a transcription of the hardcoded per-script stage Blink
  consults BEFORE DirectWrite (`win/font_cache_skia_win.cc:286-296`) —
  `src/render/win-font-fallback.ts`: the 74-row `InitializeScriptFontMap` table,
  `GetFontBasedOnUnicodeBlock`, the emoji/math lists, the Han locale
  disambiguation, plane routing, and the pan-Unicode probe lists.
  `IsFontPresent` is asked live through the win32 helper's DirectWrite
  `FindFamilyName` (the identical call), never tabulated. The generated
  `unicode-font-routing.win32.generated.ts` survives only as the net *behind* the
  live DirectWrite resolver. Same change made the resolver style-aware: the helper
  now passes the run's real weight/slant/stretch to `MapCharacters`, transcribing
  `FontDescription::SkiaFontStyle()`, where it previously hardcoded
  `NORMAL/NORMAL/NORMAL`. See doc `font-resolution-diagram.md` §7c and doc 42's
  "Windows: superseded by Blink's own hardcoded stage".
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
- **Doc 107 (`docs/107-font-conformance-oracle.md`)** — **Shipped.** The
  font-parity *instrument*: `tools/font-conformance.ts` asks Chrome (CDP
  `CSS.getPlatformFontsForNode`) and `resolveFontForCodepoint` the same
  per-codepoint question over every assigned Unicode codepoint × every
  font stack the fixture corpus uses, writes a JSON + text report, and
  exits non-zero on any mismatch. Parity is measured here, not inferred
  from a passing fixture sweep. The allowlist ships empty by design. Our
  side is materialized through the renderer's own call
  (`getFontInstance`), so the face compared is the weight/slant-selected
  cut rather than the family's base path-table entry. **Now runs on all
  three platforms**, each with its own stack corpus, recorded font
  inventory and committed baseline
  (`tests/baselines/font-conformance-<os>.json`) — the numbers are not
  comparable across platforms (different Blink code, different font sets,
  different ICU universes) and the CI gate is regression-relative rather
  than absolute-zero. The codepoint axis is exhaustive; the stack axis was
  bounded by the fixtures, so a **synthetic, rule-derived corpus**
  (`tools/font-conformance-synthetic-stacks.ts`, 2,106 stacks, its own CI
  dispatch and baselines) now sweeps the CSS generic families across the
  whole weight ladder, the stretch keywords and both slopes. It named two
  defects on its first slice: `font-stretch` never reaches our resolution
  (Chrome takes `Papyrus-Condensed`, we take `Papyrus` — 3 mismatches at
  100% against 1,110 at each condensed step) and weight 800/900 takes the
  wrong CJK cut. Doc 107 also now records the variable-axis pairing as a
  measurement rather than an argument: the face oracle's verdict is
  invariant to our axis location (blind in both directions), while the
  shaping oracle (doc 108) separates the cases by 39–137 px.
  **`font-feature-settings` is now extracted and declared on the probe
  page** (corpus 434 → 442 stacks on all three platforms, 9 with a
  non-normal value) — but deliberately *not* adjudicated here: Blink omits
  `feature_settings_` from `FontDescription::CacheKey` and reads it only at
  shaping time, and a 6-family × 8-setting CDP probe moved Chrome's
  reported face in 0 of 42 cases while moving the painted width in 11, so
  the consequence belongs to doc 108 — where it is now adjudicated: feature
  lists carry disables/values as HarfBuzz feature strings (`-liga`,
  `aalt=2`), runs bearing one shape through the vendored HarfBuzz
  (`fontFeatureValueShapingOverride`), and the in-repo
  `tests/fixtures/shaping` corpus dir gives the oracle Times/Helvetica
  `"liga" 0` runs that discriminate (12 mismatch-count pre-fix →
  12 agree-exact). Two properties that *are* selection
  inputs — `font-variant-alternates` and `font-variant-emoji`, both in the
  cache key — are modeled end to end. Doc 204 closes the shaping
  corpus's named-alternate blind spot: it now harvests `@font-feature-values`
  aliases with Blink's per-key cascade-layer postorder and current
  document-only TreeScope boundary, retains one authenticated data-URL webfont,
  re-emits the effective table into environment-partitioned Chrome probes, and
  records exact resolved feature lists plus complete HarfBuzz cluster records.
  A pinned WPT font proves all six named functions against direct-feature,
  layer/source-order, shadow-scope, and missing-rule mutations without a pixel
  tolerance. Doc 205 extends the shaping evidence to the roughly
  312,822-run Unicode corpus through deterministic SHA-256 sharding. Pull
  requests gate a bounded representative profile on macOS/Linux/Windows;
  scheduled and manual runs cover eight exhaustive shards per platform.
  Resumable manifests retain full environment/corpus fingerprints and nonzero
  outcomes, while reductions group logical signatures without allowlisting
  them or changing a tolerance. The renderer
  models **both** end to end: `font-variant-alternates` captures the computed
  functions plus family-scoped CSSOM `@font-feature-values` aliases and
  resolves Blink's exact `salt`/`ssNN`/`cvNN`/`swsh`+`cswh`/`ornm`/`nalt`/
  `hist` feature sequence before HarfBuzz fallback verdicts and final shaping;
  `font-variant-emoji` is captured and threaded into the
  per-codepoint resolver with Blink's priority override + forced-VS
  semantics and the macOS monochrome-emoji replacement, and applied to the
  raster-emoji overlay routing — see doc 15). All three committed baselines await a
  re-seed from CI, since re-extraction moved each corpus's `generatedAt`.
  **The report now records `meta.chromium`**, the build that produced the
  Chrome side of every comparison, read from `browser.version()` on the
  launched binary rather than from Playwright's declared revision (a
  Windows VM launches a 148 build out of a `chromium-1217` directory). It
  is checked for agreement across a run's shards and compared against the
  baseline, so a run under a different browser is **refused rather than
  judged** — added after four `font-variant-emoji: emoji` rows read as a
  Windows-specific divergence for a week and turned out to be a 147→148
  behaviour change, reproducible on macOS with the platform held constant.
  The same field now rides in the family-match env fingerprint (docs
  110/111) and in the visual sweep's `run-env.json` (doc 66, where it
  *warns* rather than refuses, since that gate is regression-relative).
  Two instrument fixes landed alongside: the batch memory reset now also
  drops `glyph-helper.ts`'s own per-codepoint memos (a full-corpus macOS
  run had been losing four of twenty shards to
  `JavaScript heap out of memory`), and `DOMOTION_HELPER_NO_SERVE=1`
  forces the one-shot helper transport so the persistent channel's cost is
  measurable without changing the answers — 0.615 ms/codepoint with it,
  24.480 ms without.
- **`docs/font-resolution-diagram.md`** — **Shipped.** Canonical
  always-in-sync Mermaid flow diagram of the *entire* font-resolution
  system, synthesizing docs 03/30/40/42/51/52/80: family-stack→key, the
  platform path tables, key→`FontInstance`, the per-codepoint resolver
  (Blink `FontFallbackIterator` mirror), the darwin/linux/win32 fallback
  chains with specific per-block fonts, and the live CoreText/fontconfig/
  DirectWrite resolver. Verified by the `check-requirements-against-code`
  skill; must be updated in lockstep with any font-routing change.

### Transition schema and normalization (docs 115–116)

- `src/animation/transition-schema.ts` is the transition SSOT: the exported
  programmatic type, animate/storyboard validation, and both generated JSON
  Schemas derive from it. Storyboard only refines out `magic-move`, which needs
  element-tree pairs unavailable between opaque scenes.
- Normalize legacy names before renderer classification into the bounded
  opacity / translate / scale / clip / supported-overlay channel plan. Preserve
  every compatibility spelling and the existing emitter output; new built-in
  parameters and custom recipes belong to DM-2071 and DM-2072 respectively.
- Parameterized built-ins (doc 117) use strict nested objects: push angle or
  cardinal direction + viewport-fraction distance; reveal shape-specific
  angle/origin/radius/direction; zoom scale + viewport-relative origin; shine
  angle/band fraction/color/opacity. Reject irrelevant fields and out-of-range
  values. Every form settles at identity and stays on the CSS timeline using
  opacity, transform, clip-path, and the supported gradient sweep only.
- Custom recipes (doc 118) are strict declarative compositions, never raw CSS,
  filters, masks, JS, SMIL, or arbitrary SVG. Incoming owns optional clip and
  rests at opacity 1 / translate 0 / scale 1 / full clip; outgoing owns its
  opacity/translate/scale exit. Z-order is incoming-on-top. Require at least one
  primitive per layer, shared origins for combined entrance scale+clip, explicit
  reduced-motion (`crossfade`/`cut`) and loop (`hold-last`/`crossfade-to-first`).

- **Doc 124 (`docs/124-embedded-font-build-diagnostics.md`) — Shipped.**
  HTML/unicode visual artifacts record every embedded entry's source path,
  physical face index, axes, selected builder, exact hinted-subset
  disqualification reasons, retained sfnt table tags, and affected glyph/run
  counts. CI artifacts can therefore separate propagation failures from
  genuine native-font versus webfont rasterization differences.

- **Doc 125 (`docs/125-windows-unicode-font-route-trace.md`) — Shipped
  diagnostic.** Focused Windows Unicode CI runs attach a per-cell route trace:
  declared-family exhaustion, Blink hardcoded candidate/coverage, DirectWrite
  base/locale/style and reopened answer, Chromium painted/reopened face and gid,
  and Domotion's legacy and production-shaped final key/face/gid. The declared
  chain includes Blink's preferred STANDARD face before system fallback. The
  trace is observational and adds no routing overrides.

- **Doc 126 (`docs/126-backdrop-filter-isolation.md`) — Shipped narrow
  boundary.** A computed
  backdrop filter is captured from Chromium as an isolated raster box surface,
  with text and descendants emitted as vectors above it. This preserves backdrop
  sampling and the browser's backdrop-then-element-filter stacking semantics,
  which SVG cannot reproduce from DOM geometry alone, for the direct target
  cases established by that implementation. Doc 187 makes ancestor effect-space,
  generated-pseudo, and fixed sibling-order limitations explicit.

- **Doc 135 (`docs/135-corner-shape-superellipses.md`) — Shipped.** Capture
  Chromium's computed physical `corner-*-shape` longhands and carry Blink's
  superellipse exponent through the shared corner model. Named shapes are
  aliases for the source's `2^parameter` rule, not separately tuned paths.
  Non-degenerate contours use Blink's fitted two-cubic construction; concave
  contours invert it, overlapping opposite concave hulls receive the source's
  radius constraint, and inset contours align to their border origin. Preserve
  the round path for old captures and zero radii.
  Non-uniform hyperellipse borders normalize each side into Blink's general
  quad construction and intersect corner miters with the inner bevel hull.
  Concave/mixed curvature uses the close-edge miter/opposite bound. For a
  non-renderable inset, preserve Blink's four corner constraints as nested SVG
  clips and subtract their intersection with a vector luminance mask.

- **Doc 136 (`docs/136-semantic-coverage-inventory.md`) — Shipped framework,
  partial coverage.** A machine-readable matrix tracks CSS/SVG rendering state
  transitions to upstream and production owners, structured oracles,
  metamorphic tests, visual fixtures, platform evidence, and explicit
  unsupported boundaries. CI rejects silent/stale claims and reports every
  acknowledged gap; the release-level strict mode fails while any row remains
  partial or unsupported.

- **Doc 137 (`docs/137-specialized-path-activation-ledger.md`) — Shipped.**
  Every registered helper, resolver, cache, platform branch, generated table,
  fallback trigger, and representation boundary links positive, negative, and
  mutation evidence. CI rejects stale/inert registrations, and visual-test
  artifacts carry the platform-specific activation ledger into demo review.

- **Doc 138 (`docs/138-parity-release-gate.md`) — Shipped gate, currently not
  ready.** The strict release command combines semantic/source/activation/stage
  and reviewed three-platform visual evidence. It names every blocker and
  explicit unsupported boundary; it never substitutes a confidence percentage
  or permits unexplained logical residuals.

- **Doc 139 (`docs/139-raster-fallback-content-gates.md`) — Implemented,
  awaiting fresh all-platform evidence.** Every active raster boundary is paired
  with a pixel/paint gate for its relevant size, crop, scale, color/alpha,
  placement, freshness, and sibling-order dimensions. The combined live-browser
  gate runs once per platform visual workflow rather than once per shard.

- **Doc 147 (`docs/147-inner-live-scroll-capture.md`) — Shipped.** Scroll
  ownership, captured subtree, and page-space crop are independent. Every
  scroll anchor re-captures the live DOM, so an inner virtualized list can
  recycle rows while fixed page chrome outside the selected clip is excluded
  from the animated composite.

- **Doc 148 (`docs/148-sourcegraphic-url-filter-surfaces.md`) — Shipped.** An
  HTML CSS URL-filter graph containing `feConvolveMatrix` is owned by a narrow
  Chromium final-surface raster boundary because Blink/Skia consume layer-space
  `SourceGraphic` pixels and a resolved crop/tile state. Ordinary URL filters
  and native SVG filters remain vector; screenshot failure falls back to the
  prior vector emission rather than tuning offsets or thresholds.

<!-- DM-2390 -->
- Synthetic bold is paint-stage geometry over the selected source outline, not
  a calibrated outline dilation. The Chromium-pinned Skia rule records
  FrameAndFill(`extra`) for a fill and `authorWidth + extra` for a stroke on
  FreeType, CoreText, DirectWrite, and Fontations. Both text render modes keep
  hinted/static/variable subsets unchanged; opaque `stroke fill` emits the
  author stroke followed by a fill-color frame as two passes. The 5,400-row
  `fonts:synthetic-bold-paint` oracle covers platform, face/weight activation,
  hinting, size knees, transparency/order, and transform controls, and rejects
  the retired derived-outline mutation plus its former production symbols.

<!-- DM-2367 -->
- Generated `::before` / `::after` paint keeps Chromium's authoritative
  computed filter function list on a native SVG CSS-filter group. Empty boxes,
  text (including raster glyph overlays), and generated images share one
  `content → filter → transform → opacity` wrapper, while ancestor clips and
  the pseudo's established paint-order slot stay outside. The supported vector
  set is blur, brightness, contrast, drop-shadow, grayscale, hue-rotate,
  invert, opacity, saturate, sepia, and ordered lists, including non-`none`
  identity values. Pinned Blink `FilterEffectBuilder` owns list order, sRGB
  interpolation, unclipped primitive bounds, and Skia premultiplication; do not
  replace it with manually authored `<fe*>` primitives or fitted percentage
  regions. CSSOM px terms, generated-box/image dimensions, transform origins,
  and matrix translations cross effective zoom once during capture; DPR does
  not alter that physical-CSS-pixel record. HTML `SourceGraphic` URL convolution
  remains the separate explicit
  Chromium raster boundary in doc 148.

<!-- DM-2360 -->
- Blend and filter parity is checked at the browser-owned pixel stage, not by
  tuning an end-image threshold. [Doc 185](../185-blend-filter-pixel-stage-oracle.md)
  pins Blink's author-order sRGB shorthand graph and Skia's unpremultiply,
  clamp, premultiply, decal-blur, drop-shadow, and premultiplied 17-mode blend
  rules. The native three-platform DPR-1/2 gate compares named source/model/SVG
  pixels, proves activation with independent filter/blend/isolation mutations,
  and asserts six raster boundaries: shorthand/blend/ordinary URL/native-SVG
  convolution stay vector, while backdrop-filter and HTML URL convolution are
  Chromium surfaces. Computed color alpha now preserves Blink's legacy
  two/three-decimal and modern six-decimal serialized forms instead of using
  the one-decimal SVG coordinate formatter. The DPR-1/2 report is
  `source-exact`; the fixed four-code stage bound and mutation thresholds were
  not widened, and no known-drift workflow allowance remains.

<!-- DM-2535 -->
- Mixed SVG/reference and shorthand filters remain one browser-owned native
  CSS filter terminal. [Doc 218](../218-mixed-reference-color-space-ownership.md)
  pins Chromium's current compositor-list behavior: a linearRGB reference
  followed by a shorthand filter receives no intermediate linearRGB-to-sRGB
  conversion, and the terminal converts to sRGB only after the list. Domotion
  must not insert, lower, or approximate that missing transition. The DPR-1/2
  oracle must retain exact straight and premultiplied stages, explicit-sRGB and
  reversed-order controls, partial alpha, six vector boundaries, hostile
  transfer/order/isolation models, and independently active source/candidate
  mutations. Blink's blend Effect remains the outer consumer of its inner
  Filter: source content is filtered before it blends with the effect backdrop.
  Localized reference filters now preserve that nesting; DM-2549 owns strict
  three-platform promotion afterward. DM-2535 changes neither production behavior nor the
  fixed four-code channel and eight-code mutation bounds.

<!-- Ordinary backdrop ownership -->
- [Docs 187](../187-backdrop-source-surface-transitions.md),
  [194](../194-ordinary-backdrop-effect-space.md), and
  [195](../195-strict-ordinary-backdrop-ownership.md) establish and ship the
  ordinary backdrop source boundary. Pinned Blink/Skia defines a
  prior-parent-device Backdrop Root surface and separate backdrop/regular-filter
  effect nodes. Opacity/blend/mask own an atomic captured root; rotate/skew owns
  one final-space terminal compositor patch; scroll and sticky remain ordinary
  document-root target surfaces. The strict schema-v2 17-family DPR-1/2 audit
  requires 34/34 root and owner records, exact source clip/pass facts,
  raster-before-vector and source sibling order, both destructive mutations,
  and no backdrop materialization warning. The four-code and 1% diagnostics are
  unchanged. Residuals above 1% pass only with exact source-owner geometry and
  zero logical-interior changed pixels—all changes must already lie on a
  Chromium source edge. A native macOS/Linux/Windows workflow persists the
  reports and source/render/mutation artifacts.

<!-- DM-2490 -->
- `backdrop-filter` warnings describe the Node materialization outcome, not the
  presence of the computed property. A successfully isolated Chromium source
  surface emits no warning. Planner/snapshot misses and unresolved CDP paint
  owners emit a machine-readable `partial` warning naming the unisolated or
  partially isolated crop; a missing token or screenshot emits
  `unavailable` and names the vector/frosted box fallback. The synchronous DOM
  walk must never revive the retired unconditional “no true blur” warning.

<!-- DM-2488 -->
- A live `::before`, `::after`, or `::checkmark` with non-`none`
  `backdrop-filter` owns one Chromium prior-device raster on its source-owned
  pseudo record. It must paint first inside the captured generated-child slot;
  retained pseudo box/text/image vectors follow directly. `none`, hidden and
  empty records own no raster. Capture must use the pseudo backend node's
  independent paint order, restore every temporary mutation, and must never
  substitute a host-wide raster. The native DPR-1/2 gate requires exact owner
  counts, all five pseudo slots, ancestor-root/zoom/nested/overlap rows, no
  warnings, and discriminating no-surface plus final-composite mutations.

## What this file is NOT

- Not a complete requirements doc — the per-feature docs are.
- Not a substitute for opening the actual numbered doc — when a ticket
  touches gradients, open `docs/07-gradient-fills.md` /
  `docs/10-repeating-gradients.md`. When it touches fonts, open
  `docs/03-font-family-chain.md` / `docs/52-embedded-mode-glyph-fallback
  .md`. And so on.
<!-- DM-2158 -->
- Text capture preserves an explicit UTF-16 source span for every rendered
  `text-transform` chunk. Length-changing casing (for example `ß` → `SS`),
  locale-sensitive casing, supplementary codepoints, tabs, and `::first-line`
  transformations must never use rendered indices as DOM `Range` offsets.
  When one source span expands to multiple rendered codepoints and CSSOM cannot
  expose internal anchors, the rendered run is shaped normally rather than
  inventing duplicate per-character positions.

<!-- DM-2157 -->
- CSS counters use per-name scope stacks in layout-tree order. A counter
  introduced by an element remains visible across following siblings while its
  originating parent remains an ancestor; same-parent resets replace the
  innermost peer scope. Directives run in Blink order (reset, increment, set),
  with generated content processed as `::before`, descendants, `::after`, so
  `counter()` and `counters()` observe the value at their actual pseudo-tree
  position rather than one element-wide snapshot.

<!-- DM-2191 -->
- Legacy serialized text-bearing `::before` / `::after` boxes may still carry
  the former isolated real-element-probe fields. New live capture instead uses
  the source-owned protocol record below; the probe is not geometry authority
  for new generated paint.

<!-- DM-2383 -->
- New live `::before`/`::after` captures use the DM-2467 source-owned fragment
  contract from [docs 157](../157-pseudo-generated-fragment-geometry-audit.md)
  and [176](../176-source-owned-pseudo-fragment-capture.md). A private
  frame-scoped CDP prepass joins one DOMSnapshot epoch to real pseudo content
  quads and retains anonymous text/image items, item-local UTF-16 visual runs,
  fragmentainer translations, logical slice/clone edge ownership, selected
  faces, shaped advances, and writing-mode-aware physical baselines. Missing
  or ambiguous protocol facts warn and become one isolated Chromium-painted
  pseudo surface; they never select the clone, half-leading, host-first/last,
  or wrap-threshold heuristics. DM-2468 now consumes that record directly:
  generated text uses the normal resolved-face/path route at captured physical
  baselines, anonymous images use captured quads, and per-fragment box paint
  honors slice/clone edges in explicit negative/before/after/positioned/
  positive slots. The transitional live compatibility projection is deleted;
  old serialized aggregate trees remain readable. A native macOS/Linux/Windows
  workflow compares Chromium and final-SVG edges at a fixed four-device-pixel
  DPR-1/2 bound and uploads source/rendered surfaces. See
  [doc 178](../178-direct-pseudo-fragment-rendering.md).

<!-- DM-2459 -->
- Authored checkbox/radio indicators with resolved `appearance:none`, plus
  feature-enabled `appearance:base` checkmarks, use the same source-owned
  generated-pseudo contract. Real `::checkmark`, `::before`, and `::after`
  nodes retain Blink geometry, text/face/style, gradients, transforms, radii,
  and paint slots. An authoritative record array, even empty, suppresses the
  generic tick/dot/switch synthesizer; only a pre-contract undefined field may
  use that compatibility route. Native auto controls remain Chromium-owned.
  The macOS/Linux/Windows gate crosses state, content, switch, base, zoom,
  fractional-origin, and DPR controls at the unchanged four-device-pixel edge
  bound. See [doc 11](../11-custom-checkbox-radio.md),
  [176](../176-source-owned-pseudo-fragment-capture.md), and
  [178](../178-direct-pseudo-fragment-rendering.md).

<!-- DM-2364 -->
- Replaced/native ownership changes are gated as paired live-Chromium facts,
  not inferred from a static visual fixture. The 42-row-per-DPR matrix covers
  all object-fit modes and arbitrary positions, intrinsic and effective-zoom
  changes, loaded/loading/failed image fallback, independently changing canvas
  and video source frames, native/author/split controls, appearance none/base,
  accent/color-scheme/axis/zoom state, and exact generated pseudo boxes.
  `<img>` capture retains unzoomed `imageIntrinsic` plus
  `imageEffectiveZoom`, matching Blink's `GetNaturalDimensions(EffectiveZoom)`;
  old trees default to one. A strict pure adjudicator and native
  macOS/Linux/Windows DPR-1/2 workflow fail closed on missing pairs/facts,
  partial capture, warnings, inert state changes, invalid fingerprints, or
  more than one device pixel of geometry drift. See [doc 133](../133-replaced-geometry-oracle.md)
  and [184](../184-replaced-ownership-transition-matrix.md).

- Dotted-circle routing is owned by the selected face's HarfBuzz result, with
  Chromium capture ink as the covered-glyph control and pinned ICU properties
  supplying script/category inputs. Unicode block floors, plane gates, and
  script-specific joiner pairs are not production decisions. The resolver's
  exact face metadata and RunSegmenter's resolved ISO 15924 script survive on
  the final font run and are consumed by path emission, embedded emission, and
  provenance shaping; insertion still requires HarfBuzz's broken-syllable
  classification and a nominal U+25CC glyph in that selected face.
  The pinned Linux Vedic visual row persists and validates all 14 affected
  FreeSans/FreeSerif glyph streams, plus well-formed, no-U+25CC, and
  cluster-disabled activation controls; these exact records are oracle data,
  never production routing exceptions.

- The PingFang Extension-B runner diagnostic (doc 153) persists the live
  `CTFontCreateForString` descriptor plus cold/warm reopen arms and parallel
  Chromium Range/CDP evidence. It fingerprints the exact macOS/font/browser
  environment and is observational; CDP face names alone never establish the
  native descriptor or variation instance.

- MathML token ink evidence (doc 154) uses exact bboxes from the selected
  fontkit or native-helper fallback glyphs. Mixed-script tokens union those
  boxes; they never fall back to a primary-face ascent merely because the
  selected physical face is helper-backed.

- The Linux MathML Greek-italic re-audit (doc 203) finds the former significant
  feature residual inactive on the current pinned noble image: six `<mi>`
  tokens end at capture-owned raster overlays, operators remain paths, and the
  focused run has zero significant regions without a threshold change. The
  logical grading now has a token-only pre-terminal contract for exact
  FreeSans face/gid/advance/offset/outline and captured baseline facts, without
  demanding paths provenance from a raster-owned terminal. Production
  provenance classifies transform-subtree, text-segment, and legacy element
  rasters as `capture-raster`; the canonical fixture requires a non-vacuous
  final terminal plus an active helper-enabled/disabled availability control
  before validating the live Linux token projection. Doc 210 adds a
  separate authenticated Noble FreeSans native/paths/no-hint Linux collector
  and proposal/validation gate. Independent Linux evidence in workflow run
  `32628749740` ratifies that terminal raster boundary with distinct boot
  identities and validation residuals no greater than proposal; the 348-cell
  core and every scalar visual threshold are unchanged.

<!-- DM-2452 / DM-2567 -->
- The macOS SFNS mask/baseline oracle (doc 168) is diagnostic-only. It routes
  the exact `SFNS.ttf` bytes through Chromium, fixes
  `wdth=100, opsz=17, GRAD=400, wght=700`, and requires Chromium CSS,
  CoreText's actual axes, Domotion provenance, gids, cmap mapping, and captured
  quarter-pixel origins to agree before comparing direct `CTFontDrawGlyphs`,
  pinned-Skia `CTFontCreatePathForGlyph`, and production Domotion path rasters.
  Two cold and two warm observations per stage must be stable; an `opsz=26`
  mutation must move every representation. Native metrics and best integer
  baseline fits are independent of fixed-position coverage. Current evidence
  finds a sub-0.017px CoreText-path/Domotion coordinate delta, native-mask-like
  dominance in four rows, a distinct zoom/transform-cancellation boundary,
  and no one-pixel y correction. None of those observations defines a visual
  tolerance or authorizes a renderer change. The follow-on pinned-source audit
  excludes different source bytes, gids, axes, metrics, baselines, quarter
  phases, uniform residual matrices, and cold/warm behavior. It adjudicates the
  dominant residual as CoreText/Skia terminal smoothing, hinting, gamma, mask
  conversion, preblend, and possible compositor resampling; the direct RGBA
  CoreText arm is not a byte-exact Skia A8/LCD mask. DM-2567 closes the separate
  variable-outline gap: on macOS, an authenticated file-backed variable run
  with a known matched member routes every nonempty gid through CoreText using
  the selected instance's complete axes; static/unmatched sources retain
  fontkit, and helper absence fails closed. Helper/font caches include the
  physical face and sorted axes, while SVG-def identity includes the exact
  commands. Provenance records the resolved outline disposition. Two
  explicitly headless proposal/validation arms authenticate SFNS and helper
  bytes, axes, gids, x/y quarter inputs, two cold/two warm observations, uniform
  zoom/transform/cancellation rows, and a moving `opsz=26` control. All 30 gid
  observations per arm are `helper-outline` and equal the independent
  pinned-Skia/CoreText stream exactly on the declared 0.001-design-unit protocol
  lattice (`maxDesignUnitDelta = 0`); no pixel tolerance changed. Terminal mask
  and pre-compositor raster ownership remain the only gap in this area.

<!-- Animated viewBox culling source audit, implementation, and oracle -->
- Animated viewBox culling's composed-timeline path is implemented (doc 155):
  matching translate/scale/2D-rotate functions interpolate before composition
  (with exact rotation-arc extrema); nested
  and own-timing fused wrappers share the global scene clock; delay, hold,
  steps, repeat/alternate, and cubic-bezier overshoot partition/bound the
  continuous sweep; and no fixed sample is used to prove exclusion. Unknown
  transform lists/timing, decomposition-only matrices, projective/non-finite
  states, and excessive/unbounded partitions retain content. DM-2460 replaces
  the HTML carrier proxy with renderer-owned exact fill/stroke/view reference
  boxes and separate bounded visual surfaces, including frozen affine wrappers,
  emitted overflow clips, outline/shadow ink, and exact replaced/atomic raster
  rectangles. Unknown/empty/singular facts, split backdrop ownership, and a
  live animation interleaved with frozen static transforms retain. A focused
  production Chromium discriminator covers the offset-descendant fill box at
  zoom 1/1.25 and DPR 1/2. The independent final-SVG timeline gate (doc 166)
  now covers every reference-box, static/live/nested/projective transform,
  timing, narrow-crossing, motion-path, visual-overflow, clip, and mask family
  with enter/leave/non-activation rows. It persists quads, alpha-trimmed ink,
  emitted visibility, and browser/OS/arch/Node/DPR/zoom fingerprints on macOS,
  Linux, and Windows; reference-box, ancestor, function-first, fixed-sampling,
  and fail-closed mutations must move. Exact per-frame quads remain
  oracle/finite-raster evidence, never proof between continuous SVG frames.

<!-- DM-2385 -->
- Computed `perspective` is an ancestor-owned stacking-context and
  fixed-containing-block signal; `perspective-origin` is captured as a resolved
  border-box point but is inert when perspective is `none`. Computed
  `transform-style: preserve-3d` remains a fixed containing block even when an
  overflow/grouping property flattens its used 3D style. Fixed descendants stop
  at those owners and remain under their nested clips; origin-only and
  matrix-symptom-only controls continue to the viewport. Capture must preserve
  Blink's `IsBox()` activation boundary independently from computed-style
  stacking: a static non-replaced inline has no perspective paint layer, while
  relative positioning may make its computed-style z-index isolation
  observable; both keep fixed children viewport-owned and activate no
  perspective paint node.
  Non-representable 3D paint remains the Chromium projective-subtree raster
  boundary (doc 06).

<!-- DM-2384 -->
- Broken-image fallback parity (doc 156) is **capture-, emit-, and independent
  all-platform-gate complete**.
  Blink replaces a
  failed host with a UA-shadow block-flow/inline fallback state machine; it
  does not ask `ImagePainter` to draw a framed mountain. Source and fresh CDP
  evidence require a hybrid result: author paint plus the UA container/clip
  remain vector, hidden-node alt/title text uses the ordinary shaped vector
  text path, and only Chromium's DPR-selected broken-image bitmap is raster.
  Empty/missing alt, the exact 17/18 px transition, standards/quirks sizing,
  RTL/vertical placement, zoom, title/AX semantics, and platform-native text
  must come from captured browser facts. DM-2463 now pierces the closed UA
  shadow through CDP and records the six-way disposition, physical boxes and
  clip/style facts, alt/title presence and resolution, code-point-safe hidden
  text ranges/font metrics/platform fonts, DPR resource selection, and AX
  name/ignored state. DM-2464 reversibly isolates only `#alttext-image` into a
  fingerprinted 16×16/32×32 DPR crop (and effective-zoom-scaled equivalents),
  keeps captured UA container/clip and author paint vector, routes alt/title
  segments through the ordinary shaped text path including bidi/vertical
  facts, and exposes captured AX independently. Missing required facts warn
  and select a classified terminal surface; the fixed gray mountain/raw-text
  approximation is removed. A focused DPR-1/2 browser matrix proves local
  ownership and negatives. DM-2465 adds 27 independent cases crossed with DPR
  1/2 and light/dark on native macOS/Linux/Windows runners, exact pierced-CDP
  geometry/text/AX versus capture/final-SVG comparisons, browser/OS/font
  provenance, direct isolated-source versus emitted RGBA, the 100%/200% switch,
  and fifteen mandatory mutation discriminators. CSS geometry uses a 1/64 px
  bound, icon alpha bounds a one-device-pixel bound, and no platform consumes
  another platform's screenshot baseline.

<!-- DM-2382 -->
- Legacy WebKit control-pseudo cascade is Chromium-owned. A Node-side CDP
  prepass pierces instantiated UA-shadow control nodes, uses direct matched-rule
  origins only to classify native versus author paint ownership, and transfers
  Blink's final ComputedStyle longhands to the serialized capture walk.
  Specificity, importance, origins, normal/reversed-important layer order,
  scopes, media/supports/container conditions, adopted sheets, shadow tree
  scopes, selector nesting, shorthand expansion, and dynamic state are never
  reimplemented from CSSOM. `::-webkit-resizer` is the source-defined exception:
  Blink gives its resolved style to an anonymous layout part, so capture reads
  the host's native resizer computed style and CDP pseudo-match metadata. The
  old source-order fallback is removed and authoritative-surface failure is
  explicit. See [doc 158](../158-authoritative-control-pseudo-cascade.md).

<!-- DM-2381 / DM-2469 / DM-2470 / DM-2471 -->
- Exact transformed-text capture and affine renderer consumption are
  **implemented**.
  A same-frame Node/CDP prepass pauses animations, retains real text nodes
  without author-visible markers, measures live and all-transform-neutral
  physical fragments with zoom active, and serializes the complete signed
  affine mapping plus ordered baselines and UTF-16 shaped origins/advances.
  Equal-diagonal rotation/scale, reflection, wrap, transform-box, RTL/vertical,
  same-origin iframe, zoom and DPR controls are green. Missing, ambiguous,
  changing, singular, or projective facts warn and select the existing outer
  Chromium raster owner. The renderer consumes the transform-neutral local
  bundle through one complete signed residual matrix across normal, wrapped,
  vertical, input, bitmap, shadow, decoration, stroke and background-clip text;
  the former diagonal magnitude, unsigned ancestor axes and anisotropic wrapper
  are deleted. The retained baseline is the normal captured segment baseline
  (or ascent plus physical origin), not an independently decoded private Blink
  baseline fact. The hard all-platform gate now checks direct live/neutral/
  restored fragment facts plus fixed device-space final ink/content over 25
  cases at DPR 1/2, with eight scalar/matrix/raster mutations and native
  macOS/Linux/Windows artifacts. DM-2468 independently owns direct generated-
  pseudo record consumption and its native final-paint gate. See
  [doc 159](../159-exact-text-transform-geometry-audit.md) and
  [docs 177](../177-affine-text-paint-consumption.md) and
  [178](../178-direct-pseudo-fragment-rendering.md) and
  [179](../179-transformed-text-all-platform-gate.md).

<!-- DM-2371 / DM-2473 / DM-2474 / DM-2475 -->
- Cloned inline-SVG 3D ownership and its independent static parity gate are
  **implemented**. Blink resolves SVG
  graphics-child matrix3d, exact fill/stroke/view reference boxes, x/y/z
  origin, zoom, motion, and independent operations, then explicitly flattens
  the used result to a parent-relative affine transform. Capture must freeze
  that matrix as valid SVG rather than emit literal matrix3d or reconstruct the
  box. Capture now correlates the used local CTM with a transform-neutral
  intrinsic mapping, serializes one valid SVG matrix, removes competing
  CSS/SMIL owners, and fails closed on singular/unavailable/mismatched facts.
  A non-affine outer SVG/HTML box, or HTML 3D inside `<foreignObject>`, crosses
  one Chromium surface promoted above the opaque `svgContent` owner.
  Property-only SVG perspective/preserve-3d is not activation. The hard gate
  crosses 31 static cases with DPR 1/2 and requires exact used matrices/owner
  routing plus independent live-Chromium versus complete generated-SVG
  alpha/ink within fixed device tolerances. Six unsafe mutations must move,
  and native macOS/Linux/Windows jobs upload fingerprinted reports. The exact
  SVG boundary and evidence are in
  [doc 162](../162-inline-svg-3d-transform-audit.md). The smallest nested HTML
  owner chosen before opaque-clone promotion remains partial as documented in
  [doc 189](../189-nested-projective-context-ownership.md).
- Animated CSS 3D frame synchronization, geometry, and atomic paint are
  **shipped** (DM-2359, [doc 186](../186-animated-3d-frame-state-parity.md)).
  Direct capture accepts
  an exact `animationTimeMs`, pauses CSS/WAAPI and SMIL timelines before every
  capture prepass, and rejects drift, refused/non-document time, or changing
  animation enumeration. Each 3D-influenced element exposes the same-frame CDP
  content/border quad, computed transform composition/origin/perspective/style,
  residual, and selected atomic-raster owner. A native macOS/Linux/Windows
  DPR-1/2 workflow crosses rotate3d, affine translate3d retention, matrix3d,
  perspective/origin, preserve-to-flat ownership, overflow grouping flattening,
  and additive composition at 0/250/500/750ms; 64 rows and five mutations are
  locally green without fitting an apparent 2D matrix. DM-2356 proved that the
  perspective/grouping expected owner was copied from production's former
  descendant-union assumption; DM-2492 corrected both expectations and the
  selector, and the focused gate is 64/64 with 5/5 mutations.
- Scroll/view progress timing is **source-owned and shipped; rAF remains an
  explicit boundary** (DM-2531/DM-2553,
  [doc 221](../221-scroll-view-raf-timeline-ownership.md)).
  Pinned Blink proves that ScrollTimeline/ViewTimeline time is a CSS percentage
  from post-layout scroll/range snapshots and can also tick from the compositor
  scroll tree. HTML/CSS-box position/size ignores projective paint for this
  purpose, while SVG-child size uses transform-sensitive mapped bounds.
  `document.getAnimations()` is TreeScope-limited. rAF is a PageAnimator queue
  outside that enumeration. The live main/OOPIF oracle proves exact percentage
  holds freeze effects but not sources. Production now enumerates Document and
  reachable open-shadow participants, rejects closed/unresolved scopes before
  mutation, carries logical axis/direction, source/range/zoom, HTML stitched
  size or SVG mapped bounds, and revalidates the same source snapshot between
  capture prepasses. The oracle also proves
  and a pre-navigation Playwright clock stops benign page-global callbacks but
  exposes saved native rAF and misses worker rAF. DM-2554 must own, disable, or reject page-native and worker escapes
  and pass the combined ordering gate. No millisecond-to-percentage mapping,
  pixel evidence, or tolerance is authorized.
- Nested projective owner selection is **source-derived and shipped**
  (DM-2356/DM-2492, [doc 189](../189-nested-projective-context-ownership.md)). Pinned
  Blink source propagates a rendering-context ID only through a direct parent
  whose *used* style preserves 3D; perspective alone creates no context, and an
  ordinary, flat, opacity/filter/clip/mask/isolation, or non-visible-overflow
  intermediary breaks propagation. The DPR-1/2 observational corpus proves
  26/26 source-model and production-owner rows with every vector sentinel
  retained. Capture records frame-coherent used context roots, retains
  inline-SVG promotion, and warns while retaining a conservative Chromium
  surface when internal active view-transition grouping is unavailable.
  DM-2493 promotes that proof to a required native macOS/Linux/Windows
  schema-v2 aggregate. It rejects missing Cartesian rows, warnings, stale or
  duplicate owners, vector-sentinel absorption, restoration drift, artifact
  corruption/fingerprint substitution, and final-image drift beyond four
  device pixels.

<!-- DM-2370 -->
- URL background tile geometry, including sliced-fragment continuation, is
  **source-derived**. DM-2477 captures Blink-equivalent selected CSS image/natural
  sizing at effective zoom, including DPR/type/density, independent dimensions
  and ratio, orientation, aligned layer index, and explicit decode/failure
  state; the renderer consumes that selected URL instead of a DPR-1 guess.
  DM-2479 also captures fixed-viewport applicability, the scrollbar-excluding
  layout viewport, local pixel-snapped x/y scroll plus overflow/extent, and the
  stitched root canvas, then selects those positioning/painting inputs before
  URL tile construction without double-applying affine transforms.
  DM-2478 tracks snapped and unsnapped positioning/destination geometry in
  Blink's 1/64 px LayoutUnit domain and lowers auto/contain/cover/calc,
  positive/negative no-repeat, repeat phase, round, both space branches, and
  independent origin/clip to vector SVG without oversized pattern cells.
  Capture preserves candidate/density/dimensions/ratio/orientation/decode kind;
  unknown sizing or kind fails explicitly. Fixed under a transformed ancestor becomes
  scroll; local subtracts the real scroll offset; shorter longhand lists repeat
  cyclically; slice continues through one stitched box while clone restarts.
  DM-2365 records Blink's imaginary positioning box and physical stitched
  offset for LTR/RTL/vertical inline and multicol fragments; slice continues
  through it, viewport-fixed layers ignore it, and clone restarts. The strict
  26-row evidence and exact contract are in
  [doc 163](../163-url-background-image-geometry-audit.md). DPR 1 and DPR 2
  pass 26/26 with restart mutations. A hard native macOS/Linux/Windows
  workflow now requires complete warning-free palette, pattern, independent
  ink-bound, and mutation evidence at both DPRs and preserves lossless
  fingerprinted artifacts. There is no observational/current-gap success
  route.

<!-- DM-2366 -->
- `background-clip:text` URL image and non-transparent color semantics are
  **implemented without rasterizing text**. Pinned Blink paints color only in
  the bottom FillLayer, paints that layer's image above it, applies one DstIn
  alpha text mask (including author stroke geometry), and paints foreground
  text later. Domotion now follows that order for color-only, selected URL,
  multiple-layer, transparent/opaque fill, stroke, descendant-owner, and
  sliced/cloned fragmented-inline states. URL size/position/repeat/origin/
  attachment facts stay capture-owned, slice uses the stitched imaginary box,
  and clone restarts. The independent live vector-only oracle is green at DPR
  1/2 with zero structural errors and a constant four-device-pixel edge bound;
  source links and evidence are in
  [doc 181](../181-background-clip-text-url-color-semantics.md).

<!-- DM-2368 -->
- Native scrollbar **capture is source-owned; author-custom paint is vector and
  stock-native paint remains platform-owned**. Never
  infer paint from a positive scroll offset or synthesize a host-independent
  7 px pill. The live marker protocol captures Blink's actual bar
  existence, overlay/classic route, used width, logical side, frame/part/corner
  rectangles, ranges, dynamic state/opacity, used scheme, paint phase,
  overflow-controls clip, and transform. Supported author
  `::-webkit-scrollbar*` parts are final-cascade anonymous CSS boxes and remain
  vector; unsupported part effects may raster only their owner. Stock native
  chrome is a narrow, capture-DPR, precomposited platform raster because macOS
  depends on its scroller animator, Aura/Fluent on runtime native theme/state,
  and Windows UXTheme/GDI already produces an offscreen bitmap before Skia.
  Stable CDP cannot return dynamic anonymous-part winners, so affected custom
  parts retain a pre-marker source-frame crop bounded to their owner; unsupported
  author effects take the same narrow route. Neither reconstructs cascade or
  layout, and every other supported part remains vector. Native platform paint
  is losslessly cropped from one source frame at the captured rectangles with
  DPR, SHA, interaction, launch, browser, and OS provenance; overlay geometry
  comes from a reversible width:none ink discriminator and retains its backdrop.
  Missing/incoherent source facts remain explicit partial/unavailable warnings. A faded
  overlay, width:none, hidden/clip/visible axis, or auto axis without overflow
  emits nothing. The focused overflow/axis/RTL/writing/clip/scheme/
  zoom/DPR evidence and exact contract are in
  [doc 165](../165-native-scrollbar-layout-paint-ownership-audit.md); its oracle
  must run without Playwright's default `--hide-scrollbars` and later be
  promoted on native macOS/Linux/Windows images. DM-2481's implementation and
  stable-CDP limits, DM-2482 custom-vector paint, and DM-2483 native strip
  rasters are in [doc 169](../169-authoritative-scrollbar-capture.md). DM-2484
  owns the dependent three-platform release gate.

<!-- DM-2537 -->
- Cross-origin iframe scroll ownership is **source-derived and implemented**
  ([doc 217](../217-cross-origin-frame-scroll-ownership.md)). Each capture uses
  Chromium's default execution-context `FrameId`, local `Page.Frame` parent
  ID, and OOPIF `TargetInfo.parentFrameId`, not URL/order/geometry correlation,
  then binds that child record to its exact iframe owner element. Access is
  decided relative to the immediate parent;
  a denied, inaccessible, or unauthenticated ancestor exposes no descendant
  scroll owners. Every reachable frame records exact viewport/element owner
  IDs, raw negative RTL/vertical offsets, dimensions, direction and writing
  mode. Frame-local scrollbar sets carry the same owner identity. Each scroll
  segment seals a fresh state, selected top-frame owner and offset; composition
  rejects capture reuse, an omitted/changed allowlist, a sibling owner,
  wrong-frame scrollbar, stale iframe identity or offset mutation. Unit
  mutations and a three-origin live Chromium E2E cover nested same/cross/denied
  frames, a forced site-isolated inaccessible iframe, fixed descendants, and
  mask/clip TreeScopes on macOS/Linux/Windows.
  No pixel threshold, fitting constant or tolerance changed.

<!-- Composed parity corpus -->
- The composed integration corpus is **shipped** ([doc 183](../183-composed-metamorphic-parity-corpus.md)). Seven repository visual rows and one pinned html-test page cross multilingual fallback/bidi with flex/grid, controls with responsive fragmentation, gradient/mask/clip paint with stacking, SVG effects, zoom/transforms, same-origin iframe recursion, and dynamic canvas pixels frozen at capture. A live Chromium E2E leg proves the neutral-wrapper, equivalent-syntax, node-split, translation, scale, and DOM-order relations actually move or remain invariant as declared; the visual leg launches a fresh process per page so global cache history cannot become a hidden fixture-order axis. A hard native macOS/Linux/Windows workflow builds each platform resolver helper, records the producer fingerprint, and uploads source/SVG/raster/diff evidence. The primary macOS calibration is exact on all seven rows (zero regions and zero changed coverage).

<!-- DM-2518 -->
- Captured font-family ownership is **structured and source-semantic**
  ([doc 213](../213-structured-font-family-stack.md)). Ordinary, generated,
  first-letter/first-line, line-clamp, placeholder, listbox, and file text must
  consume one decoded list of Blink `family-name`/`generic-family` nodes plus
  the independent rightmost legacy generic. Quoted commas, CSS escapes, quoted
  generic-looking literals, inherited kStandard, and an authored same-face
  pseudo are exact logical controls. The legacy string is only an old-tree
  fallback; selected face keys must not reconstruct the semantics. This
  contract adds no pixel tolerance or font-name snapshot.

<!-- DM-2544, DM-2547, DM-2546 -->
- Affine text baseline ownership is a **separately decoded logical protocol**
  ([doc 215](../215-affine-text-baseline-protocol.md)), not an inference from
  final glyph pixels. Range rectangles and CDP text-node quads must retain the
  same ordered physical `FragmentItem` count and UTF-16 ownership after
  effective-zoom adjustment. Blink rounds the containing paint offset, retains
  the fragment-relative fractional top, adds the selected primary font's
  integer ascent in line-relative space, applies the writing-mode rotation, and
  only then applies the complete transform-origin-aware paint matrix. CSS zoom
  remains a local metric/layout input and must not be applied twice. The exact
  fractional, nested-zoom, mixed-script, vertical-rl/lr, and sideways-rl/lr
  rows plus all eight wrong-plane/snap/zoom/origin/cardinality mutations must
  remain active without screenshots. Each v2 affine fragment must carry the
  source-pinned structured neutral-plane record, and render must validate and
  consume it exactly once before the affine map. Before correlation, the same
  neutral frame must recover every full Range FragmentItem rectangle and exact
  half-open DOM UTF-16 span, join ordinary items one-to-one and in order with
  `DOM.getContentQuads`, keep the separate first-letter item, and split both
  authored/rendered source maps and shaped origins/advances on those spans.
  Crossing or multiply owned spans fail closed; transform-induced length
  changes stay explicitly mapped. The logical evidence must cover one
  LayoutText containing Latin/Arabic/CJK fallback, bidi, ligatures, wrapping,
  first-letter, vertical writing, nested zoom and nested transforms, retain
  clusters/gids/advances/offsets/source spans/fragment origins, and reject
  collapse, reorder and wrong-span mutations on macOS, Linux and Windows.
  Native glyph antialiasing and all existing visual tolerances remain outside
  this geometry requirement.

<!-- DM-2539 -->
- Isolated browser generic preferences are an **authenticated 21-field logical
  protocol** ([doc 219](../219-authenticated-profile-oopif-generic-preferences.md)).
  Every run must resolve full Chrome through Playwright channel `chrome`, hash
  that executable, and match the CDP product, command path, and exact isolated
  user-data-dir. Raw `Default/Preferences` must retain all seven maps for
  Common, Japanese, and Devanagari before launch and after headed/headless
  launches in both orders. Headless ownership is determined by structurally
  reading the installed Playwright overlay source, never by a remembered row
  count. Every requested field must be non-inert and each script must use at
  least two independently painted mutation families. A cross-site child must
  authenticate as a distinct `iframe` target; child→main and main→child
  `Page.setFontFamilies` orders must each move all 21 selected-target fields,
  leave all 21 other-target fields stable after the first step, converge to the
  same final state, and leave locale-tagged `system-ui` controls unchanged.
  Script discriminators must restore Blink's `lang`-owned `-webkit-locale`
  after style neutralization. The gate is native macOS/Linux/Windows logical
  evidence only: screenshots, pixel tolerances, committed family answers, and
  unchecked “supported field” counts are forbidden.
### Transitive SVG fragment resources (DM-2529)

- Resolve every local mask/clip dependency edge in its referencing element's originating TreeScope.
- Preserve computed SVG paint and separately hoist reachable out-of-subtree resources under a collision-free output namespace.
- Fail closed on missing, stale, external, cross-scope, unreachable, or structurally forged evidence; retain authenticated cycles for native SVG resource-specific handling.
- Do not replace source-owned logic with pixel thresholds or bake computed geometry/transform values that would override unit-sensitive SVG attributes.
### Hidden macOS generic fallback faces

Protected dot-prefixed faces reported by a macOS script generic probe must not
be reopened or treated as declared families. Preserve the captured Common
generic primary and reach the protected face through CoreText per-codepoint
fallback, matching Blink's `IsSystemFontName` rejection and
`CTFontCreateForString` route. Require exact PostScript identity; do not add a
pixel tolerance or fitted font-name table (DM-2550, doc 224).

### Fragmented collapsed-table borders

- Treat Blink's global collapsed-edge graph and each physical table-section
  fragment as separate authenticated inputs. Preserve physical table-fragment
  identity, section source/paint slot, global start row, exact row offsets,
  content-before/after, start/end continued-row state, repeat role/occurrence,
  writing direction, and source/version provenance before vector paint.
- Whole-row fragmentainer breaks paint the source half edge; continued-row
  seams omit the inline edge while continuing block edges without joint
  adjustment. Adjacent section fragments paint their shared global row once,
  and row/column spans must not acquire filled interior edges.
- Repeated headers and footers require explicit source-owned occurrences and
  Blink's eligibility/placement facts. Do not infer repetition from aliased
  `getClientRects()` coordinates or synthesize an occurrence in every table
  fragment without authentication.
- Screen CSSOM fragmentation cannot stand in for paged media. Collect an exact
  print fragment record or fail the print route closed when page/section/row,
  continuation, repetition, and paint-order ownership is unavailable.
- Keep logical fragment-record gates and native final-ink evidence independent
  on macOS, Linux, and Windows. Pixels may validate the terminal only after the
  logical record passes; they may not fill missing provenance or justify a
  tolerance change (DM-2526, DM-2557–DM-2560, doc 225).

### Pre-navigation rAF capture ownership

- Install callback ownership before page/OOPIF author script and never expose a
  saved native rAF function. Reject Playwright's page-visible builtin escape,
  late installation, recurring/unbounded queues, target churn, or time/source
  drift.
- Fail closed on worker, SharedWorker, and OffscreenCanvas ownership because a
  Window init script cannot authenticate worker-global rAF.
- Drain one bounded callback batch at `animationTimeMs`, then seek document and
  SMIL timelines while preserving progress percentages/source snapshots, and
  reverify the exact target set between every capture prepass.
- Use CDP style/layout metrics as the controlled rendering commit. Pixels and
  visual tolerances are not evidence for callback quiescence (DM-2554, doc 228).
