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
`tools/unified-shaping-oracle.ts` is the face→glyph→painted-origin logical record
consumed by those stage-evidence artifacts; its lower-level exact glyph leg is
`tools/exact-shaping-oracle.ts`.
`docs/142-renderer-font-route-audit.md` inventories every production
face-assignment/emission owner and the missing per-run provenance seam between
those oracles and emitted glyphs.
`src/render/text-run-provenance.ts` and
`tools/renderer-font-route-oracle.ts` close that seam for representative
production runs without adding overhead unless explicitly enabled (doc 143).

The same orientation lives in `CLAUDE.md` "Code Organization" but the
shortest possible map:

- **`src/capture/`** — Playwright bring-up + the `CAPTURE_SCRIPT` (a
  serialised function that runs inside the page to walk the DOM). The
  capture-script bundle is pre-built into `src/capture/script.generated
  .ts` by `scripts/build-capture-script.mjs`.
- **`src/render/`** — pure node-side renderers that convert a captured
  element tree into SVG markup. `element-tree-to-svg.ts` is the big one;
  `text-to-path.ts` + `text.ts` own glyph/decoration/wrap logic;
  `font-resolution.ts` owns font-key resolution + the per-Unicode-block
  fallback chains + `FONT_PATHS`/`LINUX_FONT_PATHS`/`WIN32_FONT_PATHS`
  (extracted out of `text-to-path.ts`, DM-1305/DM-1307; still re-exported from
  it) + the per-platform generated routing tables
  (`unicode-font-routing.{darwin,linux,noto-linux,win32}.generated.ts`) + the
  Linux bare-vs-Noto runtime profile selector (`linuxFontProfile()`, DM-1404) +
  the live `fc-match`/CoreText system-fallback resolver (DM-1416/DM-1018).
  **The end-to-end flow (family→key→file→instance→per-codepoint fallback→live
  resolver→glyph emission, with all platform branching + specific fonts) is
  mapped in `docs/font-resolution-diagram.md` — a canonical always-in-sync
  Mermaid reference; keep it current with any font-routing change.**
  `cluster-fallback.ts` is Blink's shaped-cluster fallback — shape with the
  current font, requeue only the `.notdef` clusters — and is the DEFAULT run
  splitter for BOTH render modes (`splitTextIntoFontRuns` for the embedded-font
  pipeline; `splitTextIntoGlyphPathRuns` invokes it in "paths" mode for the
  glyph-path emitter, preserving per-run `decomposed` flags plus every
  bidi/script shaping-item boundary and its resolved direction plus ISO 15924
  script (`FontRun.shapingDirection` / `FontRun.shapingScript`), while raster
  emoji use the same Chromium terminal as embedded mode; `DOMOTION_CLUSTER_FALLBACK=0` restores the legacy
  per-codepoint walk in both) — see `docs/113-cluster-granularity-fallback.md`.
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
  Windows) plus the memos the platform answers land in. Two of those memos are
  keyed per codepoint and are therefore unbounded in the codepoint universe —
  `clearGlyphHelperCodepointMemos()` drops them and is called from
  `clearFontResolutionCaches()`, which is what keeps an exhaustive sweep inside
  a bounded heap. `DOMOTION_HELPER_NO_SERVE=1` forces the one-shot `spawnSync`
  transport so the channel's *cost* can be measured without changing the
  *answers* (doc 107 § Verifying the instrument);
  `unicode-classification.ts` owns the Unicode predicates;
  `synthesis-decision.ts` owns WHETHER a resolved face needs synthetic bold /
  oblique (`faceNeedsSyntheticBold` / `faceNeedsSyntheticOblique` — three
  different per-platform Blink rules plus a fourth webfont-descriptor one, and
  the `font-synthesis` vetoes), read by BOTH render modes so neither re-derives
  a font decision;
  `embolden-outline.ts` owns HOW — `skiaFakeBoldStrokeExtraPx` /
  `resolveFakeBoldTextStroke` reproduce Skia's fake-bold stroke frame
  (`useStrokeForFakeBold`), and `shearPathCommands` bakes the faux-italic shear
  into an embedded outline (paths mode applies the same factor as a group
  transform instead);
  `embedded-font-builder.ts` builds the per-instance subset `glyf` TTF —
  hinting-preserving hb-subset of the original file when the entry is pure
  (variable sources fully instanced at the resolved axis location via
  `hb-subset.ts`, the wasm binding to harfbuzz's subsetter; DM-1714/DM-1716,
  doc 99), svg2ttf outline rebuild otherwise;
  `synth-test-fonts.ts` synthesizes deterministic hinted/variable test fonts
  for the subset unit tests;
  `mask.ts` owns mask-def emission; `borders.ts` owns border math;
  `svg-inline.ts` inlines an `<img src="*.svg">` as a native, id-namespaced
  nested `<svg>` (`prefixSvgIds`/`inlineImgSvg`, DM-1588, doc 96) — crisp at
  any zoom instead of a rasterized `<image data:image/svg+xml>`.
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
  replaced-element leg is `tools/replaced-geometry-oracle.ts`: exact concrete
  object-fit rectangles, control paint ownership, and generated pseudo boxes.
  `tools/raster-boundary-oracle.ts` is the paired activation/vector gate for
  every inventoried raster fallback.
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
  `viewbox-culling.ts`, `resize-embedded-images.ts`, `prune-tree.ts`,
  `for-each-element.ts`, `annotate-animated-properties.ts` — marks which CSS
  properties intra-frame animations animate on each target element so the
  renderer hands those channels to the animation, e.g. no baked wrapper
  opacity). (The old `frame-merge.ts` fast path was removed — see doc 08.)
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
  (`review-server.tsx`). Also the **feature-coverage** axis (DM-1459):
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
  inputs, and Domotion's emitted SVG parsed analytically. Exists because
  whole-fixture pixel-diff structurally rewards the WRONG decoration
  constants (they were fitted against the rasterization gap — since removed:
  `getDecorationMetrics` / `emitDecorationLine` now transcribe Blink's rules
  and all three legs pass and gate by default, 84/84 + 7/7 + 84/84). Pure
  pieces pinned by `tests/decoration-oracle.test.ts`; the emit snap by
  `src/render/decoration-emit.test.ts`.
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
