# Code summary — AI agents read me first

This file is the entry point the Hot Sheet ticket template tells you to read.
It points you at the existing canonical docs rather than duplicating them;
the source of truth lives in `CLAUDE.md` and the numbered `docs/*.md` set.

## Read these first, in order

1. **`CLAUDE.md`** (repo root) — the operating manual. Covers stack, code
   organisation, CAPTURE_SCRIPT discipline, decoration & shaping invariants,
   quality gates, language, **investigation + debugging tools (Playwright
   probes, `--debug` bundles, `svg-review`)**, git, ticket workflow,
   documentation rules. Always re-read when the date drifts past your last
   read — the file is updated as patterns emerge.

2. **`docs/README.md`** — index of the numbered docs. Each numbered doc is
   a per-feature requirements + design reference (what CSS round-trips, what
   doesn't, why). When you change capture/render/animate behaviour, the
   corresponding doc updates in the same commit.

3. **`docs/api.md`** — the published-package API surface. What
   `domotion-svg` consumers import. When you rename / add / break a public
   symbol, this is the contract document to keep in sync.

## Key code orientation

Demo-review evidence is resolved by `src/review/stage-evidence.ts`; the CI
producer is `tools/collect-stage-evidence.ts` plus
`tools/build-stage-evidence.ts`, and the server/client integration lives in
`tests/review-server.tsx` and `tests/review-client.tsx`.
Dependency-roll evidence is adjudicated by `src/review/roll-differential.ts`;
`src/review/source-drift-gate.ts` adds the fail-closed ICU/HarfBuzz boundary and
`tools/source-drift-evidence.ts` fingerprints the source pins, ICU data, native
helpers, and generated classifiers for representative or exhaustive profiles.
`tools/unified-shaping-oracle.ts` is the face→glyph→painted-origin logical record
consumed by those stage-evidence artifacts; its lower-level exact glyph leg is
`tools/exact-shaping-oracle.ts`. `tools/exact-shaping-control-fixtures.ts`
supplies doc 199's platform-independent applicability rows: two pinned Open Sans
non-default-axis→default omissions and HarfBuzz's `TRAK.ttf` `ptem=9`→unset
golden. Schema 3 requires complete expected glyph streams and exactly one
changed field (`xAdvance`), and distinguishes missing, inert, and unexpectedly
mutating fixtures without aborting the evidence artifact.
`tools/shaping-conformance.ts` and
`tools/shaping-font-feature-values.ts` own doc 204's named-alternate gate:
they harvest ordinary document-scoped `@font-feature-values` tables, retain a
single authenticated data-URL webfont, partition synthetic pages by rule/face
environment, and record the exact resolved feature list plus complete HarfBuzz
cluster record. The real WPT face exercises stylistic/styleset/character-
variant/swash/ornaments/annotation against direct-feature and missing-rule
controls; layered fusion is refused rather than approximated.
`tools/shaping-unicode-corpus.ts` (doc 205) makes the full ~312,822-run Unicode
corpus usable: canonical SHA-256 identities drive bounded representative and
eight-way exhaustive shards, resumable manifests carry doc-120 fingerprints,
and mismatch reductions retain one ticket-sized example per logical signature.
The native workflow runs both profiles on macOS, Linux, and Windows without
changing the shaping oracle's tolerance.
`tools/pingfang-live-descriptor-oracle.mjs` and its macOS workflow capture the
otherwise-ephemeral CoreText fallback descriptor, reopen arms, and matching CDP
font/Range evidence for the PingFang Extension-B discriminator (doc 153).
`docs/142-renderer-font-route-audit.md` inventories every production
face-assignment/emission owner and the missing per-run provenance seam between
those oracles and emitted glyphs.
`src/render/text-run-provenance.ts` and
`tools/renderer-font-route-oracle.ts` close that seam for representative
production runs without adding overhead unless explicitly enabled (doc 143).
`tools/sfns-mask-baseline-oracle.ts` plus its Swift helper form the diagnostic
macOS SFNS stage split (doc 168): exact bytes, four explicit axes, gids, and
quarter-pixel origins cross Chromium, direct CoreText mask, pinned-Skia
CoreText path, and production Domotion path arms, while baseline/typographic
metrics and cold/warm evidence remain separate. It authorizes no renderer or
tolerance change.
`tools/paths-native-raster-collector.ts` and
`tools/paths-native-raster-corpus.ts` own doc 197's terminal raster evidence:
six SHA-pinned outline technologies, a declared 348-cell source-table-owned
matrix per run, native SVG text and production path SVG in one authenticated
Chromium binary, and exact custom-face/source/axes/gid/advance/outline/emitted-
placement/paint-plan agreement before pixels. The producer and aggregate
reauthenticate real-path-confined PNG bytes through
`paths-native-raster-metrics.ts`; the workflow collects independent proposal
and validation runs on macOS/Linux/Windows without an external bundle.
Envelopes remain a separate four-artifact human review with exact cell hashes,
never a percentage cap.

The same orientation lives in `CLAUDE.md` "Code Organization" but the
shortest possible map:

- **`src/capture/`** — Playwright bring-up + the `CAPTURE_SCRIPT` (a
  serialised function that runs inside the page to walk the DOM). The
  capture-script bundle is pre-built into `src/capture/script.generated
  .ts` by `scripts/build-capture-script.mjs`.
  `native-control-raster.ts` owns required platform-control pixels after the
  synchronous walk: one caller-supplied/atomic compositor frame is paired
  with one transparent all-control isolation frame. Static controls use source
  RGB only at alpha-proven opaque pixels; time-dependent controls consume one
  overlap-free source crop atomically or fail closed. Invalid clips/frames add
  `native-control-raster` warnings; renderer presence is fail-closed and never
  authorizes sampled form chrome (doc 167).
  `native-control-decoration.ts` classifies the narrower structural-host
  boundary; `pseudo-style-cdp.ts` retains exact closed-UA nodes and
  `native-control-decoration-raster.ts` validates identity/quads/state and
  materializes one transparent atlas. Reservations suppress sampled
  chevron/picker/cancel/spin paint even when unavailable; select arrows compose
  in Blink's background-before-inset/border phase and other parts at content
  paint (DM-2455, doc 171).
  File inputs extend that boundary to Blink's real closed-shadow upload button:
  CDP resolves the child EffectiveAppearance, capture records its exact border
  quad/value and the following status span's shaped fragments, and render
  composes shadow overflow, native child pixels, then localized status text
  without reopening `Choose File` synthesis (DM-2454, doc 172).
  `formControlRenderRoute` is the terminal cleanup boundary (DM-2458, doc 182):
  a whole-host native appearance must have its Chromium surface or warn/emit
  nothing, while only `none`/`base`/`base-select`/`listbox`/
  `menulist-button` reach structural helpers with complete captured facts.
  The former macOS light/dark palettes, accent-luminance cutoff, and sampled
  checkbox/radio/range/progress/meter/file/date/select/spin/search/details
  geometry are deleted. `tools/native-control-fallback-gate.ts` plus the
  three-platform activation workflow reject constants, route fallthrough,
  platform/fixture switches, and missing producer fingerprints.
  `effective-appearance-cdp.ts` obtains Blink's matched cascade and active
  interpolation facts without CSSOM; `effective-appearance.ts` reconstructs
  author background/border flags after origin, importance, layers, logical
  mapping and rollback, then applies LayoutTheme's exact auto/author-style
  switch. The adjusted value is captured separately from the computed
  longhand; unavailable facts warn and retain a conservative Chromium owner
  (DM-2453, doc 170).
  `text-paint-geometry-cdp.ts` owns transformed text's same-frame Chromium
  protocol: live and all-transform-neutral physical text quads, exact source
  restoration, and private same-origin-frame correlation. It delegates only
  matrix solving/held-out-corner and shaped-segment correlation to
  `text-fragment-geometry.ts`, then serializes `textPaintGeometry` or reserves
  one fail-closed outer transform raster. CSS zoom stays in the neutral local
  geometry. `render/text-affine.ts` now composes the CTM already emitted for the
  element, swaps in that neutral text bundle, and applies exactly one signed
  residual matrix across normal, wrapped, vertical, bitmap, decoration, shadow,
  stroke, background-clip and input branches. The legacy transform-derived font
  magnitude, unsigned cumulative axes and anisotropic correction are removed
  (DM-2469/2470, docs 159/177). DM-2468 now consumes DM-2467 pseudo records
  directly; an unavailable generated clamp marker retains the outer raster.
  `tools/text-transform-geometry-audit.ts` is the hard two-leg release gate:
  direct Chromium live/neutral/restored quads versus capture, then final source
  versus SVG device-space ink/content. The identical 25-case DPR-1/2 corpus runs
  in `.github/workflows/text-transform-parity.yml` on all three platforms and
  uploads fingerprinted reports (DM-2471, doc 179).
- **`src/render/`** — pure node-side renderers that convert a captured
  element tree into SVG markup. `element-tree-to-svg.ts` is the big one;
  its straight border/outline reference geometry is guarded by
  `tools/border-phase-oracle.ts` plus the independent strict
  `border-phase-ratifier.ts`: all 128 rows per DSF/zoom scenario use the fixed
  three-platform paint envelopes. `src/render/borders.ts` owns the shared
  CSS-edge snap plus Blink big-third geometry for both uniform-double stripe
  boxes; its 4×4 width/quarter-phase mutation matrix leaves `outline.double`
  on the existing outline-owned path (doc 191).
  its URL clip-path route accepts only Blink's exclusive bare-URL operation,
  maps HTML `objectBoundingBox` content through the captured border rect, and
  leaves cloned SVG URL references on native forced-fill ownership. `svg-inline.ts`
  namespaces both presentation refs and outerHTML-encoded computed-style refs,
  so a stale `url(&quot;#id&quot;)` cannot override the rewritten clip (DM-2362,
  docs 39/130).
  `culling-geometry.ts` is its fail-closed geometry preflight: it exposes the
  generated subtree's exact fill/stroke/view reference boxes separately from
  bounded visual ink, applies frozen affine wrappers and emitted overflow
  clips, and returns unknown instead of an HTML carrier-box proxy;
  `text-to-path.ts` + `text.ts` own glyph/decoration/wrap logic;
  `font-resolution.ts` owns font-key resolution + the per-Unicode-block
  fallback chains + `FONT_PATHS`/`LINUX_FONT_PATHS`/`WIN32_FONT_PATHS`
  (extracted out of `text-to-path.ts`, DM-1305/DM-1307; still re-exported from
  it) + the per-platform generated routing tables
  (`unicode-font-routing.{darwin,linux,noto-linux,win32}.generated.ts`) + the
  Linux bare-vs-Noto runtime profile selector (`linuxFontProfile()`, DM-1404) +
  the live `fc-match`/CoreText system-fallback resolver (DM-1416/DM-1018).
  **The end-to-end flow (family→key→file→instance→shaped-cluster fallback→live
  resolver→glyph emission, with all platform branching + specific fonts) is
  mapped in `docs/font-resolution-diagram.md` — a canonical always-in-sync
  Mermaid reference; keep it current with any font-routing change.**
  `cluster-fallback.ts` is Blink's shaped-cluster fallback — shape with the
  current font, requeue only the `.notdef` clusters — and is the DEFAULT run
  splitter for BOTH render modes (`splitTextIntoFontRuns` for the embedded-font
  pipeline; `splitTextIntoGlyphPathRuns` invokes it in "paths" mode for the
  glyph-path emitter, preserving every materialized bidi/script × source-
  priority shaping-item boundary and
  its resolved direction plus ISO 15924 script (`FontRun.shapingDirection` /
  `FontRun.shapingScript`), while raster emoji use the same Chromium terminal
  as embedded mode. Dotted-circle insertion and canonical decomposition remain
  outcomes of shaping the iterator-selected candidate; unopenable faces do not
  trigger an implicit per-codepoint restart. `DOMOTION_CLUSTER_FALLBACK=0`
  restores the legacy per-codepoint walk in both) — see
  `docs/113-cluster-granularity-fallback.md`.
  Declared-family ordering and segmented `@font-face` capability-group/range
  construction are source-mapped in
  `docs/122-declared-family-segmented-face-parity.md`.
  Color-glyph raster ownership is downstream of that same splitter:
  `emoji-detect.ts` ports Blink's whole-sequence presentation grammar,
  `selectedGlyphRasterSpans()` inspects the selected shaped glyph and physical
  color tables; on Windows, the helper carries pinned Skia/DirectWrite's exact
  per-gid COLR/SVG/PNG representation through HarfBuzz's by-id outline fetch.
  `text.ts` suppresses exactly the returned UTF-16 span. See
  `docs/145-renderer-owned-color-glyph-boundary.md`; no codepoint/block/font-name
  allowlist or canvas-color probe participates.
  DM-2502/doc 201 identified an upstream exception; DM-2507 closes it.
  `emoji-presentation-priority.ts` produces Blink's maximal source-priority
  ranges, `script-segmentation.ts` intersects them with independently resolved
  bidi/script ranges by their next endpoint, and `cluster-fallback.ts` creates
  a fresh iterator per intersection. CSS applies afterward, selectors win,
  declared families retain precedence, and queued hints no longer own priority.
  The strict native arm64 order/VS/CSS/family/ICU/representation matrix and
  clean `02-text-emoji` fixture prove closure; DM-2508 owns aggregate promotion,
  with no pixel-tolerance change.
  Palette selection is a later identity dimension inside the selected color
  gid. `tools/font-palette-ownership-audit.ts` (DM-2350/doc 202) pins a WPT
  COLR/CPAL face, derives expected colors from its source tables, and proves
  normal/theme/named/override/fallback selection at DPR 1/2. Its A/B plus
  reverse-order full-capture control is now `source-exact`. Capture joins the
  computed token to its family-matched rule/base/ordered overrides, then adds
  selected face/gid/representation to the durable record and PNG cache key.
  Both palette rasters remain byte-equal in either order without vectorizing
  COLR paint or adding a tolerance.
  `script-iso15924.generated.ts` maps UCD script names to the ISO 15924 tags
  passed to `hb_buffer_set_script` (derived from HarfBuzz's
  `hb-script-list.h`);
  `standardized-variation-sequences.generated.ts` mirrors Chromium's valid
  standardized base+selector pairs for the shaped fallback retry gate. The
  alternate DejaVu Linux `system-ui` oracle is documented in doc 123 and run
  by `.github/workflows/linux-system-ui-inventory.yml`; it stays separate from
  the stock Noble baseline and proves host-dependent family/cut selection.
  The Linux helper's diagnostics-only `fcdiagnostic` query exposes effective
  Fontconfig patterns, inventory fingerprints, and covering sorted candidates;
  `tools/probe-linux-fallback-diagnostics.ts` pairs them with CDP paint results.
  `win-font-fallback.ts` is the transcription of Blink's **hardcoded Windows
  per-script fallback stage** — the 74-row `InitializeScriptFontMap` table,
  `GetFontBasedOnUnicodeBlock`, the emoji/math font lists, the Han locale
  disambiguation, plane routing, and the pan-Unicode probe lists — which Chrome
  consults BEFORE DirectWrite (`win/font_cache_skia_win.cc:286-296`);
  `win32FallbackChain` is a thin adapter over it, and `IsFontPresent` is answered
  live by the win32 helper's DirectWrite `FindFamilyName` rather than a baked
  filename table;
  `glyph-helper.ts` is the node side of the per-platform native helpers, and
  owns the **persistent channel** (stdio on macOS/Linux, a named pipe on
  Windows) plus exact helper glyph ink bboxes consumed by MathML token logical
  evidence (`measureInkMetrics`, doc 154), and
  the memos the platform answers land in. Two of those memos are
  keyed per codepoint and are therefore unbounded in the codepoint universe —
  `clearGlyphHelperCodepointMemos()` drops them and is called from
  `clearFontResolutionCaches()`, which is what keeps an exhaustive sweep inside
  a bounded heap. `DOMOTION_HELPER_NO_SERVE=1` forces the one-shot `spawnSync`
  transport so the channel's *cost* can be measured without changing the
  *answers* (doc 107 § Verifying the instrument). The native Linux arm64 release
  consumer is guarded by `tools/linux-arm64-release-evidence.ts` and
  `.github/workflows/linux-arm64-release-parity.yml` (doc 196): no checkout
  build is accepted, and acquisition, ELF identity, pinned/sidecar/GitHub
  digests, live helper protocols, cache reuse, runner/font/browser fingerprint,
  exact logical stages, source-owned axes/ptem applicability controls, and
  selected visual corpora must form one artifact;
  `unicode-classification.ts` owns the Unicode predicates;
  `synthesis-decision.ts` owns WHETHER a resolved face needs synthetic bold /
  oblique (`faceNeedsSyntheticBold` / `faceNeedsSyntheticOblique` — three
  different per-platform Blink rules plus a fourth webfont-descriptor one, and
  the `font-synthesis` vetoes), read by BOTH render modes so neither re-derives
  a font decision;
  `embolden-outline.ts` owns HOW — `skiaFakeBoldStrokeExtraPx` /
  `resolveFakeBoldTextPaint` reproduce Skia's unchanged-outline fake-bold
  scaler records and ordered SVG paint passes (`useStrokeForFakeBold`), and
  `shearPathCommands` bakes the faux-italic shear
  into an embedded outline (paths mode applies the same factor as a group
  transform instead);
  `embedded-font-builder.ts` builds the per-instance subset `glyf` TTF —
  hinting-preserving hb-subset of the original file when the entry is pure
  (variable sources fully instanced at the resolved axis location via
  `hb-subset.ts`, the wasm binding to harfbuzz's subsetter; DM-1714/DM-1716,
  doc 99), svg2ttf outline rebuild otherwise;
  `synth-test-fonts.ts` synthesizes deterministic hinted/variable test fonts
  for the subset unit tests;
  `mask.ts` owns mask-def emission and fragmented mask-strip composition;
  `mask-position.ts` owns Blink's concrete contain/cover tile fitting plus
  physical length-percentage/calc position resolution; and
  `mask-origin-clip.ts` independently resolves each HTML layer's origin
  positioning box and clip painting box (including no-clip). Capture awaits
  URL-mask natural dimensions, retains cyclic origin/clip lists, and
  physicalizes computed px terms plus border/padding edges once. SVG samples
  the resulting rectangle with `preserveAspectRatio="none"` and applies the
  independent paint intersection. URL `round`/`space` patterns retain that
  split too: size/phase use the origin box and the pattern/no-repeat cell uses
  the clip-owned paint destination, with collapsed-area unit and DPR-1/2
  browser mutations (DM-2379/2472/2494, docs 20/130/174). `borders.ts` owns border math;
  `svg-inline.ts` inlines an `<img src="*.svg">` as a native, id-namespaced
  nested `<svg>` (`prefixSvgIds`/`inlineImgSvg`, DM-1588, doc 96), and namespaces
  captured DOM inline-SVG fragment ids per source document/shadow-root scope — crisp at
  any zoom instead of a rasterized `<image data:image/svg+xml>`. DM-2358 also
  makes stylesheet-owned marker start/mid/end resources,
  `vector-effect:non-scaling-stroke`, and SVG `color-interpolation`
  self-contained on the atomic clone; native SVG still owns every associated
  geometry decision. `tools/svg-effect-combination-corpus.ts` generates a
  deterministic 24-case/953-pair matrix across 18 effect axes, and
  `tools/svg-effect-combination-oracle.ts` hard-gates structure, exact final
  pixels, URL grammar, and three destructive transition controls at DPR 1/2
  ([doc 188](../188-generated-svg-effect-combinations.md)).
- **`src/animation/`** — multi-frame composition (animator, magic-move) +
  the **caret + selection track** (doc 101): `text-address.ts` (node-side
  `{ target, charOffset }` / range resolution against the captured tree —
  code-point offsets over segment `xOffsets`) and `caret-track.ts`
  (`resolveTextTrack` / `textTrackMarkup` — blinking caret + selection sweep
  as global-timeline CSS, consumed via `AnimationConfig.textTracks`) + the
  **frame-sequence compressor** (doc 100 Primitive 1): `compressed-run.ts`
  (`composeCompressedRun` — N captured continue+cut states → one nested
  animated SVG: chrome union + per-line glyph identities on step-end
  opacity/translateX/fill tracks, opt-in auto-caret) and `glyph-align.ts`
  (`alignLineGlyphs` — the order-preserving per-line LCS aligner); both have a
  declarative surface in the animate config (docs/43 §11–12: the `states`
  run block + per-frame `textTracks`, wired in `src/cli/animate.ts`) +
  **animated-SVG compositing** (DM-1323, doc 77): `composite.ts`
  (`composeAnimatedLayers` — stack animated SVGs as placed, independently-timed
  layers), `embed-namespace.ts` (per-layer name namespacing), `embed-timeline.ts`
  (per-layer `hold`/`stretch`/`loop` timeline re-anchoring). **Motion presets**
  (doc 08 / DM-1526) live in `motion-presets.ts` — named motions
  (`fade-up`/`pop`/`slide-in-<dir>`/`wipe-in`) + easing presets (spring/back/
  standard) that expand to intra-frame animation fields (`preset`/`easing` on the
  animate config; also reused by the template reveals).
- **`src/scroll/`** — scroll-pattern grammar (DM-604) and the composer
  that stitches per-segment captures into one animated SVG.
- **`src/cli/`** — the five published bins: `domotion`, `svg-to-video`,
  `svg-to-image` (still SVG → PNG/JPEG/PDF/WebP/AVIF/TIFF, DM-1353 + DM-1354 /
  doc 78 — `svg-to-image.ts` + `svg-to-image-core.ts`, reusing the
  `svg-to-video-core` seek+screenshot machinery; WebP/AVIF/TIFF transcode via a
  lazy `sharp` import), `svg-review`, `svg-scrubber`. The
  `domotion` bin has six subcommands: `capture`, `animate`, `term`
  (terminal-session → animated SVG, DM-1225 / doc 67), `template` (render a
  parameterized template, DM-1276 / doc 70), `composite` (layer animated
  SVGs into one — `composite.ts`, DM-1323 / doc 77), and `storyboard` (sequence
  distinct scenes — template/capture/cast/svg — into one timeline with inter-scene
  transitions; `src/cli/storyboard.ts`, DM-1527 / doc 89). `capture`/`animate` also
  take `--brand` (brand-for-capture, doc 92); `--format` is on `template`,
  `capture`, and `animate` (viewport sizing, doc 90).
- **`src/terminal/`** — `domotion term` backend (DM-1225): asciinema `.cast`
  parser (`cast.ts`), `@xterm/headless` VT-emulator snapshot wrapper
  (`emulator.ts`), frame-selection + grid→HTML (`render.ts`), the incremental
  line-pool composer (`incremental.ts`), theme palettes (`theme.ts`), and
  `castToAnimatedSvg` (`index.ts`). Two front-ends: `--cast` (recording) and the
  live `pty.ts` shim (`domotion term -- <cmd>`, DM-1226 / doc 68 — optional
  `node-pty`).
- **`src/review/`** — the published review-tool surface
  (`compare-pngs.ts`, `region-overlay.ts`, `server.ts`, `client.tsx`) plus the
  shared, closed logical-residual vocabulary in `logical-classification.ts`
  shared between the in-repo `tests/review-server.tsx` and the
  consumer-facing `svg-review` CLI. Also `glyph-compare.ts` (doc 98): the
  deterministic-CV glyph font-identity comparator — given two crops of one
  character, CORRECT/INCORRECT on "same font (family/size/weight/style)?"
  with AA/subpixel noise excluded; CLI `tools/compare-glyphs.ts`,
  calibration harness `tools/glyph-compare-calibrate.ts`.
- **`tools/*-oracle.ts` + `tools/parity-program.json`** — decision-stage
  Chromium parity gates kept separate from whole-image similarity. The
  replaced-element leg is `tools/replaced-geometry-oracle.ts`, backed by the
  isolated producer/adjudicator in `tools/replaced-ownership-transition-*`:
  42 paired source-owned rows per DPR cover exact concrete object-fit and
  effective-zoomed natural sizes, decode fallbacks, canvas/video frame SHAs,
  native/author/split control ownership and platform states, plus authoritative
  generated pseudo fragments. A macOS/Linux/Windows DPR-1/2 workflow rejects
  partial records, warnings, inert mutations, bad fingerprints, and geometry
  drift over one device pixel.
  The generated-pseudo structural leg is
  `tools/pseudo-fragment-geometry-oracle.ts` plus the pure
  `src/capture/pseudo-fragment-protocol.ts` decoder (re-exported by the tool): one pierced CDP pseudo identity
  and one DOMSnapshot epoch are joined to ordered content quads, retaining
  anonymous text/image item boundaries, UTF-16 visual fragments,
  fragmentainer translations, logical slice/clone edges, shaped advances, and
  TextFragmentPainter's writing-mode baseline transform.
  `src/capture/pseudo-fragment-cdp.ts` is the DM-2467 production capture
  route: private per-frame host correlation, selected-face/typography facts,
  exact records on `CapturedElement.pseudoFragments`, and an isolated
  Chromium-painted pseudo surface on unavailable/ambiguous protocol geometry.
  DM-2468 deletes the transitional live compatibility projection.
  `src/render/pseudo-fragments.ts` validates and directly paints each captured
  text/image/box fragment through its ordinary path/image/background owner at
  the retained physical plane and baseline, with explicit negative/before/
  after/positioned/positive slots. New live capture never repopulates legacy
  pseudo fields; old serialized trees keep their existing compatibility path.
  `tools/pseudo-fragment-render-oracle.ts` independently compares colored
  Chromium and final-SVG edges at a fixed four-device-pixel bound for DPR 1/2,
  while `.github/workflows/pseudo-fragment-render-parity.yml` runs native
  macOS/Linux/Windows reports and uploads both surfaces (doc 178).
  DM-2459 includes Blink's real `::checkmark` node in that record protocol and
  routes `appearance:none`/`base` checkbox and radio indicators through it.
  `src/render/form-controls.ts` suppresses generic tick/dot/switch synthesis
  whenever the modern record array is present, including authoritative empty;
  only old trees with an undefined field retain compatibility synthesis.
  Dynamic replaced surfaces have a focused transform-space gate in
  `tests/replaced-snapshot-transform.e2e.test.ts`: Chromium-vs-SVG ink bounds
  for off-page/nested affine + zoom/scroll/DPR, transform-then-scrolled-ancestor-clip
  ownership, exact source-crop pixel mapping, clipped video/frame pixels,
  vector isolation, and the projective single-owner negative. Its pure geometry is in
  `src/capture/replaced-snapshot-geometry.ts`; `rasterizeReplacedElements`
  obtains Blink's content quad through CDP and records
  `replacedSnapshot.rasterToOutput` instead of copying live-AABB clip deltas.
  `tools/raster-boundary-oracle.ts` is the paired activation/vector gate for
  every inventoried raster fallback.
- **Broken-image hybrid boundary and hard gate (DM-2463/DM-2464/DM-2465 / doc 156)** —
  `src/capture/script/index.ts` seeds alt/title presence, load facts, effective
  zoom, and private live-node correlation for every `<img>`, including
  zero-sized states. Before that registry is released,
  `src/capture/broken-image-fallback.ts` pierces Chromium's closed UA shadow
  and attaches the six-way disposition, host/container/icon physical boxes,
  used style/clip/threshold facts, code-point-safe hidden-Text ranges, canvas
  fontBoundingBox metrics, platform fonts, DPR resource selection, and an
  independent AX name/ignored record. `src/capture/broken-image-icon-raster.ts`
  then takes a reversible transparent-isolation crop of only the live
  `#alttext-image`, retaining DPR dimensions and PNG/decoded-RGBA fingerprints.
  `src/render/broken-image-fallback.ts` emits captured UA border/clip vectors,
  routes alt/title segments through the normal shaped text renderer, stamps
  only that icon raster, and exposes the captured AX state independently.
  Required-fact failures warn and select a classified terminal surface; they
  never reactivate the removed legacy mountain/raw-text helper.
  Capture/unit tests cover the state machine and source facts;
  `tests/broken-image-fallback-render.e2e.test.ts` covers DPR-1/2 hybrid paint,
  LTR/RTL/vertical text, zoom, threshold/hidden/success negatives, fingerprints,
  and single-node AX exposure. `tools/broken-image-fallback-oracle.ts` then
  executes 27 independent live cases at DPR 1/2 and light/dark, second-reads
  closed-UA-shadow geometry/text/AX through CDP, checks final SVG ownership,
  directly compares the isolated live icon with emitted RGBA, and requires 15
  mutation discriminators. `.github/workflows/broken-image-fallback-parity.yml`
  is a hard PR/main macOS/Linux/Windows matrix and always uploads fingerprinted
  reports and exact icon crops.
- **`src/scrubber/`** — the `svg-scrubber` server + kerfjs
  page-side UI (`server.ts`, `client.tsx`, `trim.ts`): video-style
  play/scrub/range-loop/frame-export/trim for an animated SVG (doc 56), plus
  `--review` mode (DM-1445, doc 82) — an issue-reporting panel + region overlay
  that writes importable `.ticket` JSON via `POST /ticket` (`buildTicketFile`).
- **`src/templates/`** — the template system (DM-1276 / doc 70): the `Template`
  contract (`types.ts`), registry + `domotion-template-*` loader (`registry.ts`),
  param validation + render driver + the `captureToSvg` static-capture primitive
  (`render.ts`), zod→JSON-Schema projection (`json-schema.ts`), and the fourteen
  built-ins: `builtin/lower-third.ts`, `builtin/device-mockup.ts`,
  `builtin/background-loop.ts` (doc 71), `builtin/kinetic-text.ts` (doc 72),
  `builtin/chart.ts` (doc 75), `builtin/chat.ts` + `builtin/subscribe.ts` (doc 76),
  the **creative-pack text cards** `builtin/{title-card,quote,caption,cta}.ts`
  (doc 86 / DM-1531, sharing `builtin/text-card-common.ts`), and the
  **number-animation** cards `builtin/{counter,stat}.ts` (doc 86 / DM-1532, sharing
  the odometer digit-reel module `builtin/odometer.ts`), and the **before/after
  compare** `builtin/compare.ts` (doc 86 / DM-1533 — a clip-wipe reveal on
  `composeAnimatedLayers`' Firefox-safe `clipScale`).
  **Format presets** (doc 87 / DM-1534, DM-1537) live in `formats.ts` — the
  `FORMATS` table + `resolveFormat` (preset/alias/raw `WxH` → canvas size +
  `safeInset`) + `applyFormatSize` + `safeAreaPadding`, surfaced as `--format` on
  the CLI (`src/cli/template.ts`) and a `safeInset` field on
  `TemplateRenderContext` that the themeable built-ins consume to keep content
  within `canvas − safeInset`. **Brand kit** (doc 85 /
  DM-1530) lives in `brand.ts` — the zod `brandSchema` + `loadBrand` + the
  `brandParams`/`brandSeriesColors`/`brandBackground` helpers; each themeable
  built-in has a `brandDefaults(brand)` method, merged beneath explicit params by
  `applyBrandDefaults` (in `render.ts`) and surfaced as `--brand`. `brand.ts` also
  owns `brandCustomProperties`/`brandRootCss` (brand → CSS custom properties) for
  **brand-for-capture** (doc 92 / DM-1540): `--brand` on `capture`/`animate` injects
  those vars into the page before capture via `injectBrandVariables` (`src/capture/
  index.ts`), so a real page authored against `var(--brand-*)` themes at capture time.
  Templates are front-ends onto the animate/capture pipeline; the verb lives in
  `src/cli/template.ts`.
- **`src/tree-ops/`** — element-tree transforms (`tree-diff.ts`,
  `viewbox-culling.ts`, `swept-transform-bounds.ts`,
  `resize-embedded-images.ts`, `prune-tree.ts`,
  `for-each-element.ts`, `annotate-animated-properties.ts` — marks which CSS
  properties intra-frame animations animate on each target element so the
  renderer hands those channels to the animation, e.g. no baked wrapper
  opacity). `swept-transform-bounds.ts` is the fail-closed Chromium-derived
  continuous-time culling model: matching translate/scale/2D-rotate operations
  (including rotation-arc extrema),
  independently timed/fused and nested global clocks, easing extrema,
  repeat/alternate/hold partitions, and unknown-on-decomposition/projective
  paths. `viewbox-culling.ts` joins those sweeps to `culling-geometry.ts`,
  selecting each animation's SVG fill/stroke/view reference box and retaining
  unknown, empty, singular, or interleaved frozen-static/live paths. (The old
  `frame-merge.ts` fast path was removed — see doc 08.)
  `tools/animated-culling-geometry-oracle.ts` is the independent final-SVG
  timeline gate (doc 166): it compares an unculled control with the production
  cull decision in live Chromium, persists quads/alpha ink/visibility and the
  browser-platform fingerprint, and runs mutation controls across DPR/zoom.
- **`src/post-processing/`** — the optional svgo `optimize.ts` + `gzip.ts`, plus
  `hoist-image-payloads.ts` (always-on: shares a raster payload repeated across
  frames / elements as one `<defs>` `<image>` + `<use>` refs — see `docs/26`).
- **`src/utils/`** — small shared helpers.
- **`src/test-support/`** — shared test helpers (`close-browser-safely.ts`).
- **`vendor/harfbuzzjs/`** — harfbuzzjs v1.4.0 with `dist/harfbuzz.{js,wasm}`
  rebuilt using the HarfBuzz configuration **Chromium ships** (transcribed from
  `third_party/harfbuzz/BUILD.gn`). Imported by relative path, not as an npm
  dependency, so there is one HarfBuzz in the tree and it is Chrome's. The
  published build is `-DHB_TINY`, which compiles out Apple Advanced Typography
  and therefore mis-shapes macOS's `morx`-only system faces (GeezaPro,
  Helvetica). Provenance, remaining divergences and the reproduction recipe are
  in its README; the config itself is `build/config-override.h`. Ships in the
  npm tarball (`files` includes `vendor`).
- **`tests/`** — visual-regression suites (`features.ts`, `showcase.ts`,
  `html-test-suite.tsx`, `real-world.tsx`) + the in-repo review server
  (`review-server.tsx`). The composed parity layer lives in
  `composed-parity-fixtures.ts`: seven cross-decision repository rows backed by
  `tools/composed-parity-corpus.json`, a pinned html-test sibling, live
  metamorphic/freeze E2E assertions, and the fresh-process
  `scripts/run-composed-parity.mjs` aggregator. The hard native three-platform
  workflow is `.github/workflows/composed-parity-corpus.yml`; see doc 183.
  Also the **feature-coverage** axis (DM-1459):
  `tests/feature-coverage.ts` (behavior → export/verb → asserting-test index),
  `tests/conventions.test.ts` (dep allow-list + no-shell-exec + manifest
  integrity/drift, in the `npm test` gate), and `tools/check-feature-coverage.ts`
  (`npm run check:features` — the standalone report). See `docs/83-feature-coverage.md`.
- **Font parity** — the normative same-machine logical contract and staged
  verdicts are defined in `docs/120-same-machine-text-parity-contract.md`.
  `tools/font-conformance.ts` (`npm run fonts:conformance`) is
  the conformance oracle: Chrome's `CSS.getPlatformFontsForNode` vs
  `resolveFontForCodepoint`, over every assigned Unicode codepoint × every font
  stack in the fixture corpus, non-zero exit on any mismatch. Runs on **all
  three platforms**, each with its own corpus
  (`tools/font-conformance-stacks.<darwin|linux|win32>.json` — a corpus is not
  portable, since an element declaring no family computes to Chrome's
  per-platform default) and its own committed baseline
  (`tests/baselines/font-conformance-<os>.json`). CI:
  `.github/workflows/font-conformance.yml` (`os` input) →
  `scripts/ci-font-conformance-shard.sh` →
  `scripts/merge-font-conformance-shards.mjs` →
  `scripts/diff-font-conformance-baseline.mjs` (regression-relative gate).
  Routine synthetic dispatches use `tools/font-conformance-rotation.mjs` to
  derive a complete modulo-256 low-byte schedule and complementary coverage
  focus, recorded beside the tested revision; explicit byte/range/
  `--stack-filter` reruns remain available.
  `tools/cluster-conformance.ts` (`npm run fonts:cluster-conformance`) covers
  the complementary multi-codepoint unit: Chrome's painted face set vs the
  production glyph-path run split for partially covered shaped clusters. Its
  default-on/legacy A/B proves the oracle is sensitive to mid-cluster fallback.
  `tools/font-inventory.mjs` records the per-platform installed-font set the
  answers depend on. Logic pinned by `tests/font-conformance.test.ts` +
  `tests/font-conformance-baseline.test.ts`; see
  `docs/107-font-conformance-oracle.md`. `tools/chrome-font-agreement.ts` is its
  single-shot `FONTAGREE:` diagnostic sibling.
- **Live generic-family preference ownership** —
  `src/capture/generic-font-probe.ts` re-probes the exact capture Page and
  serializes Common plus script-keyed painted faces on the captured top-level
  roots. `elementTreeToSvgInner` scopes that record to one synchronous render;
  no production capture writes the legacy process-global oracle slot. This
  closes the deterministic A-capture/B-capture/A-render contamination and the
  fresh-CDP-session mutation invalidation gap. `tools/generic-family-preference-oracle.ts`
  (`npm run fonts:generic-preferences`) crosses pinned Chromium and full Chrome,
  headless and headed, controlled live mutations, 77 settings rows, 11
  `system-ui` separation controls, and 11 quoted-literal controls. The strict native three-platform workflow is
  `.github/workflows/generic-family-preference-parity.yml`; see doc 198.
- **Generic-family semantic ownership audit** —
  `tools/generic-family-semantics-audit.ts` (`npm run
  fonts:generic-family-semantics`) freezes Blink's separate family-name/type and
  descriptor-generic ownership before HarfBuzz/Skia. It compares exact Windows
  Arabic/Hebrew candidate order with the current resolved-key reconstruction
  over ten named/generic/rightmost/quoted/non-occupying stacks, then repeats the
  20 rows in reverse without clearing caches. The all-platform workflow retains
  logical CDP/source/routing fingerprints and contains no visual tolerance. The
  confirmed
  false-positive and false-negative gap remains production-read-only here; see
  doc 206 and the named production/gate follow-ups there.
- **Synthetic stack corpus** — `tools/font-conformance-synthetic-stacks.ts`
  generates a SECOND corpus for the same oracle from a stated rule (the 13 CSS
  generic-family keywords × the 9-rung weight ladder × the 9 stretch keywords ×
  normal/italic = 2,106 stacks) rather than from the fixtures, because the
  harvested corpus is 74% weight-400 and 98% 100%-stretch. Output is gitignored
  (a committed copy could be hand-edited into a curated list); its identity is a
  digest of the rule, not a timestamp, so regenerating stays baseline-comparable;
  it declares `platform: "any"`, the one corpus the platform guard exempts. Own
  CI dispatch + own baselines: `.github/workflows/font-conformance-synthetic.yml`
  → the shared shard script with `STACKS=…` →
  `tests/baselines/font-conformance-synthetic-<os>.json`. Rule pinned by
  `tests/font-conformance-synthetic-stacks.test.ts`.
- **Variable-axis oracle pair** — `tools/variable-axis-oracle-pair.ts` +
  `tests/fixtures/variable-axis/` (built by
  `tools/build-variable-axis-fixture.mjs`) measure the one thing neither oracle
  covers alone: a live variable axis. One `@font-face` at three
  `font-variation-settings` locations, run through BOTH oracles' shipped
  comparison functions. The face oracle's verdict never moves with our axis
  (name-blind in both directions); the shaping oracle discriminates at 39–137 px.
  Pinned by `tests/variable-axis-fixture.test.ts` (no browser) and
  `tests/variable-axis-oracle-pair.e2e.test.ts`.
- **Declared-family match** — `tools/family-match-conformance.ts`
  (`npm run fonts:family-match`, `docs/109-family-match-conformance.md`) sweeps
  every installed family × the full CSS weight ladder, Chrome via CDP against
  the helper's `familyMatch`. It covers the step BEFORE the other two oracles:
  which cut of a declared family Chrome opens. Fixtures cannot supply this —
  they declare weight 400 almost exclusively, and at 400 nearly every candidate
  rule agrees. macOS only (Blink runs different code per platform). Score the
  shipped port, not a restatement of it: two JS restatements measured *worse*
  than the Swift port because they omitted the trait-precedence loop.
  Per-platform siblings: `tools/family-match-conformance-linux.ts`
  (`npm run fonts:family-match:linux`, doc 110 — the Linux helper's
  `familyMatch` fontconfig transcription, baseline
  `tests/baselines/family-match-linux.json`) and
  `tools/family-match-conformance-win32.ts`
  (`npm run fonts:family-match:win32`, doc 111 — the win32 helper's `family`
  query plus Blink's family-name suffix layer,
  `src/render/win32-family-suffix.ts`, baseline
  `tests/baselines/family-match-windows.json`). Both comparators refuse to
  judge across an environment-fingerprint change; each baseline file is an
  env-keyed SET (`tools/family-match-baseline.ts` — one entry per
  environment, legacy single-report files read as one-entry sets), and both
  oracles run per-PR as regression-relative CI jobs ("Linux family-match
  conformance" in test-linux.yml, "Windows family-match conformance" in
  windows-fidelity.yml) that self-record a candidate baseline artifact on a
  runner environment with no committed entry.
- **Decoration geometry** — `tools/decoration-oracle.ts`
  (`npm run decorations:oracle`, `docs/112-decoration-geometry-oracle.md`)
  grades text-decoration GEOMETRY (bar y/thickness, skip-ink painted segments)
  three ways per case: Chrome's paint measured out of a dsf-4 screenshot with
  the decoration forced red, Blink's transcribed rules fed with in-page
  inputs, and Domotion's emitted SVG captured at that same device scale and
  parsed analytically. Exists because
  whole-fixture pixel-diff structurally rewards the WRONG decoration
  constants (they were fitted against the rasterization gap — since removed:
  `getDecorationMetrics` / `emitDecorationLine` now transcribe Blink's rules
  and all three legs pass and gate by default, 106/106 + 29/29 + 106/106).
  DM-2501 made the DPR ownership explicit after the first Linux arm64 run
  compared DPR-4 Chrome paint with a DPR-1 captured fragment and produced a
  false uniform `+1px`; `tests/decoration-coordinate-ownership.e2e.test.ts`
  now pins coherent DPR-1 and DPR-4 lanes, while the arm64 finalizer rejects a
  cross-DPR report or widened `0.3px` envelope. Pure pieces are pinned by
  `tests/decoration-oracle.test.ts`; the emit snap by
  `src/render/decoration-emit.test.ts`. No production geometry changed.
- **Shaper A/B** — `tools/shape-agreement.ts` (`npm run fonts:shaper-ab`)
  compares HarfBuzz against the platform helper at glyph-ID granularity. Both
  engines are opened at the SAME axis location; without that a variable face
  reports instance-vs-instance differences as engine disagreements. It measures
  the two engines against each other and is therefore **blind to which one the
  render pipeline routes a face to** — a routing change cannot move its number.
- **macOS glyph helper queries** (`tools/macos-glyph-extractor/`, Swift, built by
  its `build.sh` into a **gitignored** `domotion-glyph-paths`, so a fresh
  checkout must build it or the helper-backed tests silently skip):
  `glyphs` / `meta` / `fallback` / `notdef` / `shape` / `family`, plus
  `familyMatch` — Blink's declared-family style matcher
  (`BestStyleMatchForFamilyNS` + `BetterChoiceCT`, transcribed at Chromium tag
  147.0.7727.15, the build Playwright pins — NOT the local checkout, which
  carries a newer directional comparator the shipping build lacks),
  enumerating with AppKit and reproducing Chrome's per-weight cut for a family.
  Pinned by `tests/family-style-matcher.test.ts`. Built but **not yet wired into
  the render path**.
- **AAT tracking routing** — `faceHasTrakAndStat` (`src/render/harfbuzz-shaper.ts`)
  reads the sfnt table directory to decide whether a face is tracked; when it is,
  shaping goes to HarfBuzz while outlines stay with the original engine, via
  `preferShapeFallback` on the native-helper path and `installHarfbuzzShaping` on
  the fontkit path. `DOMOTION_TRAK_HB_SHAPING=0` bounds both.
  `takeFallbackResponseAnomalies()` (`src/render/glyph-helper.ts`) reports short
  or out-of-domain system-fallback batch responses, so a sweep reporting none has
  eliminated that failure mode rather than not looked.
- **Perspective ownership (DM-2385)** — capture records computed `perspective`
  and resolved `perspectiveOrigin` in `src/capture/script/index.ts`, plus an
  observed `transformRelatedBox` applicability fact from a neutral Blink layout
  probe for the `IsBox()` boundary. `src/render/stacking.ts` consumes computed
  perspective directly for
  real-SC/overflow classification and combines it with that fact for fixed-CB
  ownership; it never infers ancestor perspective from `matrix3d()` /
  `projectiveTransform` symptoms. A static non-box inline has no perspective
  paint layer; relative positioning makes its computed-style stacking
  observable while fixed ownership/projective paint remain rejected.
  Computed preserve-3d is also a fixed CB through grouping-property flattening.
  `transformSubtreeRaster` separately owns projective paint (doc 06).
- **Cloned inline-SVG 3D boundary (doc 162; affine freeze, projective ownership,
  and all-platform two-leg gate shipped)** —
  `tools/inline-svg-3d-audit.ts`
  (`npm run transform:inline-svg-3d-audit`) compares Blink's live
  parent-relative SVG-child CTM with the actual `captureInlineSvg` clone and
  inventories effective projective owners. Pinned source proves SVG graphics
  children are deliberately flattened to an affine
  `LocalToSVGParentTransform`. `src/capture/svg-affine-freeze.ts` correlates
  parent/used/neutral CTMs, removes nested viewport intrinsic geometry,
  rejects singular facts, and serializes one exact six-value matrix;
  `captureInlineSvg` removes retained CSS/SMIL owners and validates an isolated
  clone before accepting vector paint. Any mismatch promotes the root through
  `transformSubtreeRaster`. Projective box paint is likewise source-owned:
  `src/capture/index.ts` gathers CDP quads without marker mutations,
  `src/capture/projective-owner.ts` selects and promotes one owner through
  opaque inline-SVG clones, and the isolated alpha-trimmed post-pass emits that
  surface once. The focused DPR-2 route/pixel oracle covers nested
  `<foreignObject>`, zoom/scroll, ancestor rotation/opacity/filter, clipping,
  off-bounds paint, and a vector-sibling isolation control.
  `tools/inline-svg-3d-audit.ts` now hard-gates 31 static cases at DPR 1/2:
  exact parent-relative matrices and reachable raster ownership form leg one;
  untouched live-Chromium versus complete generated-SVG alpha/ink forms leg
  two, with fixed two-device-pixel/5%-alpha/3%-RGBA limits. Six mutations cover
  literal matrix3d syntax, the apparent 2D submatrix, non-scaling-stroke box
  ownership, HTML root markers, a raster below `svgContent`, and property-only
  routing. `.github/workflows/inline-svg-3d-parity.yml` enforces the gate on
  macOS/Linux/Windows and always uploads a fingerprinted native report. That
  gate proves SVG affine freezing, opaque-clone promotion, and atomic
  application; DM-2492/doc 189 records the corrected used-context selector for
  the preceding nested HTML owner.
- **Animated projective frame state (DM-2359/DM-2356, docs 186/189)** —
  `src/capture/animation-frame.ts` pauses CSS/WAAPI and SMIL timelines across
  every attached document, verifies exact numeric current time and stable
  enumeration after paint commit, and fails strict capture on drift/refusal or
  a non-document timeline. `CaptureElementTreeOptions.animationTimeMs` invokes
  it before every async/synchronous capture prepass. The CDP projective probe
  then serializes `projectiveFrameState`: sample time/count, computed transform
  operations/origin/perspective/style/overflow, content and border quads,
  fourth-corner residual, and selected raster owner. The CLI video seek
  reuses the same primitive in best-effort mode. The eight-family four-time
  oracle forbids projective 2D fitting and gates 64 DPR-1/2 rows plus five
  mutations on macOS/Linux/Windows. DM-2492 corrects the independent owner
  expectation and production selector: perspective owns its plane; direct
  parent used-preserve propagation chooses the context root; grouping breaks
  start a fresh nested root. The gate is 64/64 locally at DPR 1/2.
- **Nested projective ownership audit (DM-2356, doc 189)** —
  `tools/nested-projective-ownership-audit.ts` reconstructs pinned Blink
  `RenderingContextId` propagation from live used-style/CDP facts and compares
  exact owner IDs, atomic image placement, and uniquely colored vector
  sentinels with production. At DPR 1/2, source-model evidence is 26/26 while
  production is minimal in all 26/26 rows and retains every sentinel; six
  promotion/demotion/duplication/double-transform mutations are killed.
  Perspective does not create a context, ordinary/flat/grouping
  intermediaries break it, and a nested preserve subtree starts a fresh root.
  `src/capture/projective-owner.ts` now consumes the same-frame used facts;
  unknown internal view-transition participation warns and retains the
  conservative Chromium surface. DM-2493 adds
  `tools/projective-owner-release-gate.ts` and the three-OS
  `projective-owner-release.yml` aggregate: 25 ownership families cross four
  environment profiles and DPR 1/2 with lossless SHA/crop evidence,
  restoration integrity, complete Cartesian enforcement, and nine mutations.
- **Source-owned summary disclosure paint (DM-2457, doc 180)** —
  `src/capture/summary-marker-cdp.ts` joins a pierced Chromium `::marker` node
  with its single DOMSnapshot marker paint row, then threads an exact
  `summaryMarkerGeometry` record into the generic marker pipeline.
  `src/render/list-marker-geometry.ts` owns Blink's `0.66em` square,
  font-ascent offset, line-writing conversion, and physical point table;
  `src/render/form-controls.ts` no longer synthesizes a triangle from details
  child boxes. `tests/summary-disclosure-marker.e2e.test.ts` compares 15 live
  positive rows plus suppression/replacement controls at DPR 1/2, while
  `.github/workflows/summary-disclosure-marker-parity.yml` repeats the gate on
  macOS/Linux/Windows. The `sideways-lr` row documents the legitimate
  higher-level affine-text raster owner instead of adding a duplicate polygon.
- **Source-owned URL background geometry (DM-2370/2477/2478/2479/2365/2480)** —
  `tools/url-background-geometry-audit.ts`
  (`npm run background:url-geometry-audit`) paints a deterministic decoded
  color tile in live Chromium and through the actual capture→generated-SVG
  path, then compares classified marker pixels and per-color device-pixel
  bounds. Its 26 rows now pass at DPR 1 and DPR 2 for natural-ratio,
  calc, contain/cover, round/space, fixed/local, zoom, transformed phase,
  cyclic lists, clone fragments, and stitched LTR/RTL/vertical inline and
  multicol slices. Restart mutations prove slice does not collapse to clone.
  Pinned Blink proves natural sizing plus
  snapped/unsnapped destination/phase/spacing are owned by
  `BackgroundImageGeometry` before Skia consumes the image matrix; ordinary
  URL backgrounds remain vector-composable. The async
  `src/capture/background-image-sizing.ts` prepass now mirrors pinned Blink
  MIME/density selection at the live DPR, awaits decode, and records candidate,
  independent natural dimensions/ratio, orientation, zoom, and explicit load
  state and decoded bitmap/SVG/unknown kind per aligned layer. The walker
  serializes it and the renderer consumes the selected URL instead of guessing
  DPR 1. `src/render/image-pattern.ts` resolves Blink's geometry in the 1/64
  CSS-pixel LayoutUnit domain, including auto ratio, calc, contain/cover,
  positive/negative no-repeat, repeat phase, round, both space branches,
  independent origin/clip, and fail-closed unknown facts. Background longhands
  now expand cyclically across main, inline, and fragment routes.
  `src/capture/script/walker/background-attachment.ts` independently captures
  fixed applicability, the scrollbar-excluding layout viewport, snapped local
  scroll/overflow geometry, and the stitched root canvas;
  `src/render/background-attachment.ts` selects those positioning/painting
  inputs without applying transforms twice. Six pure cases and a three-case
  live Chromium oracle are exact at DPR 1/2 and cover mutation, zoom, affine,
  borders/padding, both axes, inert/perspective controls, and root stitching.
  [Doc 163](../163-url-background-image-geometry-audit.md) owns the exact
  boundary. `fragmentation.ts` serializes each physical fragment's stitched
  positioning area/offset and `paintInlineFragment` clips that virtual strip
  after origin/clip/attachment selection; fixed viewport layers use the
  physical clip and clone always restarts.
  `.github/workflows/url-background-geometry-parity.yml` runs the hard DPR-1/2
  producer on macOS, Linux, and Windows. It rejects warnings, observational
  routes, incomplete active palettes, missing/non-finite patterns, ink or
  per-color bounds above one device pixel, incomplete DPR rows, and inert
  slice mutations; every row uploads SHA-256-addressed source/rendered PNG and
  SVG evidence with browser/Playwright/source/runner fingerprints.
- **Vector `background-clip:text` URL/color stack (DM-2366)** —
  `src/render/element-tree-to-svg.ts` now mirrors Blink's bottom FillLayer:
  non-transparent `background-color` paints below its selected URL image and
  shares that layer's text clip instead of leaking as a box rect. Every clipped
  layer paints bottom→top through an SVG alpha mask that retains text-stroke
  geometry; ordinary opaque/transparent foreground fill and stroke paint later.
  A captured parent map gives descendant text the nearest ancestor's real stack,
  and wrapped URL text uses DM-2365's stitched slice positioning boxes (clone
  restarts). `tools/background-clip-text-oracle.ts`
  (`npm run background:clip-text-oracle`) deletes all text-raster escape data,
  requires loaded URL/natural-sizing plus alpha-mask/pattern/color evidence,
  and gates live Chromium versus complete SVG at DPR 1/2 within a fixed
  four-device-pixel signal-edge disk. Both local rows are source-exact; see
  [doc 181](../181-background-clip-text-url-color-semantics.md).
- **Native scrollbar ownership and capture (DM-2368 / DM-2481)** —
  `tools/native-scrollbar-ownership-audit.ts`
  (`npm run scrollbars:ownership-audit`) disables Playwright's normally
  injected `--hide-scrollbars`, records the active platform fingerprint, and
  compares loud custom track/thumb/corner pixels through the real
  capture-to-SVG route at DPR 1/2. Negative rows cover visible/hidden/clip,
  auto without overflow, and `scrollbar-width:none`; positive rows cover
  always-on/custom axes, top/mid/max, RTL logical-left, vertical writing,
  borders/ancestor clipping, zoom, standard colors, schemes, and gutters.
  `src/capture/scrollbar-capture.ts` now asks the same live Chromium frame to
  repaint existing parts with reserved colors, stores marker-owned axes,
  frames/parts/corner, ranges, RTL/logical side, used width/colors/scheme,
  zoom/DPR, clip/phase/state facts, and attaches explicit absent/partial/
  unavailable records. `pseudo-style-cdp.ts` captures final unqualified
  scrollbar pseudo winners and detects dynamic anonymous-instance selectors
  without replaying their cascade. `src/render/custom-scrollbar.ts` consumes
  the captured rectangles in Blink background/button/track/piece/thumb and
  horizontal/vertical/corner order, reusing the ordinary vector background,
  gradient, per-side border, radius, shadow, opacity, clip, and zoom machinery.
  A dynamic-only winner or unsupported author effect is a same-source-frame
  owner-part crop; all other parts remain vector. `native-scrollbar-raster.ts`
  captures one unmodified compositor frame, derives visible overlay ink with a
  reversible width:none discriminator, records lossless strip/corner crops and
  platform/SHA provenance, and renders horizontal/vertical/corner before the
  resizer. Fully faded overlays are explicit absence. The renderer has no offset-triggered
  7 px fallback. Pinned Blink proves geometry/phase are structured capture facts, custom
  WebKit parts are anonymous CSS/ObjectPainter boxes and vector-eligible, and
  stock native paint is platform-owned. Windows UXTheme/GDI already crosses an
  offscreen `SkBitmap`; macOS and Aura/Fluent depend on native animator/theme
  state. [Doc 165](../165-native-scrollbar-layout-paint-ownership-audit.md)
  and [doc 169](../169-authoritative-scrollbar-capture.md) define the capture
  record, narrow precomposited stock strips, shipped custom-vector lowering,
  explicit absence, the shipped stock-native seam, and the DM-2484 gate.

- **Pseudo-element filter effects (DM-2367)** —
  `src/render/pseudo-filter.ts` is the shared empty/text/image generated-paint
  wrapper. Capture retains Chromium's complete computed filter list; render
  keeps it as CSS `filter` on an SVG `<g>`, inside the captured transform and
  grouped opacity. CSSOM px terms cross effective zoom exactly once during
  capture, together with pseudo/image geometry and transform translations and
  origins; DPR never mutates the SVG coordinate record. This intentionally
  delegates list order, sRGB operation
  space, premultiplication, and moving-pixel output bounds to Blink/Skia rather
  than lowering shorthand functions to SVG primitives with different defaults.
  `tests/pseudo-filter-functions.e2e.test.ts` supplies the full function/list
  matrix, identity/none negatives, text/image activation, transform, clip,
  stack-slot, zoom/DPR, and a filter-stripped pixel mutation.

- **Blend/filter pixel-stage evidence (DM-2360, doc 185)** —
  `tools/blend-filter-pixel-stage-oracle.ts` is the source-derived arithmetic
  and live capture→SVG adjudicator for all 17 CSS blend modes, ordered shorthand
  color functions, blur/drop-shadow edges, isolation, background-layer blend,
  and opacity-created groups. It uses named source pixels plus independent
  no-filter/no-blend/no-isolation mutations and classifies shorthand/blend/
  ordinary URL/native-SVG convolution as vector versus backdrop and HTML URL
  convolution as narrow Chromium surfaces. The native workflow runs DPR 1/2 on
  macOS/Linux/Windows and preserves producer/artifact fingerprints. A
  source-owned alpha serialization preserving Blink's legacy two/three-decimal
  and modern six-decimal forms. The DPR-1/2 report is `source-exact`; there is
  no known-drift allowance, and the four-code pixel-stage bound plus mutation
  thresholds remain immutable.

- **Strict ordinary backdrop ownership (docs 187/194/195)** —
  `backdrop-composite-raster.ts` owns atomic opacity/blend/mask roots and the
  narrower rotate/skew terminal compositor surface. `backdrop-layer-space.ts`
  retains the ordinary counter-transform mapping; overflow, scroll, fixed, and
  sticky never become terminal owners. `tools/backdrop-source-surface-audit.ts`
  derives the nearest Backdrop Root from pinned Blink effect-tree triggers,
  records independent `DOMSnapshot` sibling order, and gates 17 font-free
  families at DPR 1/2. Schema v2 requires exact owner clips, pass counts,
  warning-free backdrop materialization, vector/sibling order, and active
  no-surface/final-composite mutations. A row above the unchanged 1% diagnostic
  is accepted as consumer raster phase only when every changed pixel is already
  an edge in Chromium's source; a new/shifted output edge remains a logical
  failure. The native macOS/Linux/Windows workflow is
  `.github/workflows/backdrop-source-surface-parity.yml`.

- **Backdrop raster outcome diagnostics (DM-2490, docs 19/126)** — the
  synchronous capture walk records only backdrop intent, token, rect, and
  selector. `rasterizeBackdropFilters` owns the fidelity decision after its
  DOMSnapshot plan, CDP node isolation, and screenshot complete: an isolated
  Chromium crop is silent; an unisolated/partially-isolated crop reports
  `status: partial`; a missing token or screenshot reports
  `status: unavailable` and names the retained vector/frosted box fallback.
  `backdrop-isolation.ts` holds the pure outcome-to-warning contract.

- **Generated-pseudo backdrop ownership (DM-2488, doc 193)** —
  `pseudo-fragment-cdp.ts` retains the computed pseudo backdrop operation and
  uses the real pseudo backend node plus `pseudo-backdrop-isolation.ts` to keep
  prior paint, hide later overlapping owners, and neutralize only reproducible
  pseudo paint. `CapturedPseudoFragmentSet.backdropFilterRaster` owns the
  Chromium prior-device crop. `pseudo-fragments.ts` emits it before the direct
  box/text/image vector group in the record's existing negative/before/after/
  positioned/positive slot. `pseudo-backdrop-source-oracle.ts` gates 15 states
  at DPR 1/2 with under-capture and final-composite over-capture mutations on
  macOS, Linux and Windows.

## Upstream source is checked out locally — read it

Two gitignored checkouts under `external/`. Between them they answer essentially every "what does Chrome actually do here" question this project asks, and reading them beats probing every time it has been tested.

| checkout | contains | ask it about |
| --- | --- | --- |
| `external/chromium` | `third_party/blink/renderer/`, `third_party/harfbuzz/` (build config only) | font *selection* + fallback, glyph metrics, paint order, CSS parsing, layout — and **how Chrome builds HarfBuzz** (`BUILD.gn`; note the directory is `harfbuzz`, not `harfbuzz-ng`) |
| `external/harfbuzz` | HarfBuzz `src/` (sparse) | **all *shaping*** — clusters, marks, ligatures, reordering, dotted circles |

**Shaping goes to HarfBuzz first.** Blink delegates it entirely, so the Blink tree only shows the call site. `hb-ot-shaper-{indic,use,khmer,myanmar,arabic,hangul}.cc`, `hb-ot-shaper-syllabic.cc` (dotted circles), `hb-ot-shape.cc` (normalization, shaping plan).

Widen the sparse set with `git -C external/chromium sparse-checkout add <path>` when the file you need isn't there yet — several paths are one command away rather than genuinely absent.

Quote the revision beside anything you transcribe — `git -C external/<repo> log -1 --format='%h %cd' --date=short`.

**Neither is complete.** `ui/gfx` is absent, as is the browser-side code supplying Windows' menu font. When the file you need is missing, mark the claim un-transcribed rather than filling the gap with a plausible story; a fetched summary is not the file.

Full rationale, worked examples of what skipping this costs, and the per-platform entry points are in `CLAUDE.md` → "Read the local source. Always. Before probing."

## Debugging a render-fidelity bug

The shortest possible path, per `CLAUDE.md` "Debugging the generated output":

```sh
# 1. Capture the source page with a debug bundle.
domotion capture <url-or-file> --debug -o out.svg

# 2. Review the diff in a browser UI with draggable region markers.
svg-review --expected out.debug/expected.png --actual out.debug/actual.svg

# 3. For a fixture already in the suite, crop the ticket's REGIONS:
npx tsx tools/crop-regions.ts --ticket DM-{id}
```

If those don't surface the cause, fall through to a Playwright probe under
`tools/probe-*.mjs` — `CLAUDE.md` has copy-pasteable patterns for the two
most common probes (measure-an-element, screenshot-a-region).

For orphan dotted circles, start at
`src/capture/script/dotted-circle-detect.ts` and
`insertSyntheticDottedCircles` in `src/render/text-to-path.ts`. Candidate
collection is broad; Chromium paint and the selected-face HarfBuzz glyph stream
own the decision. The shaped splitter carries its resolved script and concrete
face metadata through `FontRun` into both emitters. Do not reintroduce block,
plane, font, or script samples as routing gates.

## What this file is NOT

- Not a complete summary of the codebase — `CLAUDE.md` is. Don't grow
  this file into a parallel orientation; update `CLAUDE.md` instead.
- Not a substitute for reading the relevant numbered doc — when a ticket
  touches a specific feature area (animation, scroll, gradients, fonts,
  ...), read its dedicated doc.
