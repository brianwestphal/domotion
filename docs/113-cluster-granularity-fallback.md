# 113 — Font fallback at shaped-cluster granularity

Status: **SHIPPED, default-on** for BOTH run splitters — the embedded-font
pipeline and the glyph-path emitter. `src/render/cluster-fallback.ts` replaces
`splitTextIntoFontRuns`' per-codepoint cmap walk (embedded), and
`splitTextIntoGlyphPathRuns` (`src/render/text-to-path.ts`) invokes the same
splitter in its **"paths" mode** for `textToPathMarkup` — so the two render
modes assign the same fonts to the same partially-covered clusters.
`DOMOTION_CLUSTER_FALLBACK=0` restores the legacy per-codepoint walk in both
only for an explicit A/B. A candidate that Domotion's HarfBuzz bridge cannot
open remains in iterator order as an unshaped candidate; it does not restart
the text through a different assignment algorithm. Both entry points score
**10/10** on the Chrome probe corpus of
§2 (the design-time prototype scored 9/10; script itemization closed its one
miss; the legacy per-codepoint walk scores 6/10). DM-2507 additionally mirrors
Blink's independent `SymbolsIterator`: source emoji-presentation ranges are
intersected with complete bidi/script ranges before fallback allocation, and
CSS `font-variant-emoji` is applied only afterward. Unit corpora:
`src/render/cluster-fallback.test.ts` (embedded) and
`src/render/glyph-path-run-split.test.ts` (paths — its cases fail against the
legacy walk, the discrimination requirement). The multi-codepoint face oracle
is `tools/cluster-conformance.ts` (`npm run fonts:cluster-conformance`): it asks
Chrome and the production glyph-path splitter which faces paint the same
partially covered and control clusters. The default mechanism must pass every
comparable cell; `DOMOTION_CLUSTER_FALLBACK=0` must fail the four cells whose
mid-cluster assignment the shipped mechanism fixes. This A/B is the gate's
discrimination proof. Reports are written to
`tests/output/cluster-conformance/`. The partial-webfont conjunct is graded too:
the macOS helper opens the registered webfont's retained sfnt bytes as the
CoreText cascade base, matching the current run Blink passes to
`CTFontCreateForString`. `DOMOTION_WEBFONT_FALLBACK_BASE=0` restores the old
Times stand-in for a live A/B; the partial-webfont cell must then move red.

`src/render/cluster-fallback-bidi-boundary.test.ts` separately gates the
assembly boundary with one deterministic repo-owned webfont that covers Latin
and Hebrew: ordinary `AאבB` must remain three directed same-face runs, the
all-LTR control must still coalesce, and a deleted-boundary mutant must collapse
the positive case back to the old single LTR-owned run. The focused visual
integration case is `text-rtl-in-ltr-line` in `tests/features.ts`; its Arial
positive and negative rows prevent a font change from standing in for the bidi
boundary.

The paths mode (`ShapedSplitOptions.mode: "paths"`) is retained as a call-site
description, but face selection and source-text ownership are identical in both
emitters:

- **Raster emoji do not alter resolution.** The captured `<image>` overlay owns
  paint only. Its rectangle and neighboring glyph positions are captured from
  Chromium, so the logical run remains on the ordinary shape-then-requeue path,
  including Chromium's first-candidate `.notdef` terminal when no face covers
  the cluster. Paths and embedded modes therefore select the same face and
  metrics; the overlay cannot change wrapping or adjacent advances.
- **Default shaped runs preserve source text.** Neither a resolver-provided
  decomposition nor a dotted-circle probe rewrites the queued range. The
  selected candidate's HarfBuzz normalization/syllabic pass owns the emitted
  glyph stream. `FontRun.decomposed` remains only on the explicitly disabled
  legacy walk.

One ground-truth observation from the port, beyond the §2 corpus: Helvetica
`◌` + U+0E48 (an EXPLICIT dotted circle before a Thai mark) paints
**Helvetica ×2** in Chrome — Thonburi (the hint answer for the mark) has no
U+25CC glyph, so the whole cluster's verdict is `.notdef`, Times / Lucida
Grande cover neither char, and `kFirstCandidateForNotdefGlyph` re-returns
Helvetica. The legacy walk split it per codepoint (◌ → Hiragino, mark →
Thonburi) — two glyphs Chrome never paints. The shaped splitter reproduces
Chrome's answer by construction.

All Chromium references are to `external/chromium` at rev **7d859f27
(2026-06-27)**; HarfBuzz references to `external/harfbuzz` at rev **4de187d
(2026-07-31)**.

---

## 1. The mismatch

Blink does not decide font fallback per codepoint. It shapes the **whole
segment** with the current font and re-queues only the clusters whose glyphs
came back `.notdef`:

- `HarfBuzzShaper::ShapeSegment` (`platform/fonts/shaping/harfbuzz_shaper.cc:965-1144`)
  drives a reshape queue seeded with `[NextFont, Range(segment)]`. Each cycle
  takes the next font from `FontFallbackIterator`, shapes every queued range
  with it, and splits the result.
- `ExtractShapeResults` (`harfbuzz_shaper.cc:627-787`) walks the shaped buffer
  **by cluster**: a cluster is `kShaped` only if *every* glyph HarfBuzz mapped
  to it is non-zero (`:672-739`); maximal same-state cluster runs are committed
  (`CommitGlyphs`) or re-queued (`QueueCharacters`) as units.
- The re-queued range's next font is chosen from **one hint character**:
  `ChooseHintIndex` (`platform/fonts/font_fallback_iterator.cc:242-262`) picks
  the first hint char with a real script value (not Common/Inherited), else the
  first; each hint char is asked of the system **at most once**
  (`previously_asked_for_hint_`, `:275-277`).
- When the system stage declines or repeats, Blink tries
  `GetLastResortFallbackFont` (**Times** on macOS, `mac/font_cache_mac.mm:376-388`),
  and finally `kFirstCandidateForNotdefGlyph` re-returns the **first** candidate
  so *its* `.notdef` paints (`font_fallback_iterator.cc:159-164`).

The legacy Domotion route decides **per codepoint from cmap coverage, before
any shaping**
(`splitTextIntoFontRuns`, `src/render/text-to-path.ts`, with
`resolveFontForCodepoint` in `src/render/font-resolution.ts` as the
per-codepoint oracle). The unit is wrong, and no table can fix a wrong unit.

## 2. Verified divergence classes (Chrome ground truth, CDP `CSS.getPlatformFontsForNode`)

Probed against Playwright Chromium on macOS before designing anything, per the
falsify-first rule. Ten (font, text) cases; the legacy per-codepoint path
matches Chrome's per-glyph font assignment on **6/10**, the design-time
prototype on **9/10**, and the shipped implementation on **10/10** (the
"prototype" column below is preserved as the design-time record; the shipped
splitter additionally passes the Geneva `e`+U+0E48 case because script
itemization now precedes the requeue loop):

| case | Chrome paints | shipping path | prototype |
|---|---|---|---|
| Helvetica `x` + U+0951 (base covered, mark not) | **Helvetica ×2** — the mark is Helvetica's `.notdef` tofu. The cluster's hint char is `x` (U+0951 is Inherited); CoreText answers Helvetica; the iterator refuses the duplicate; the terminal commits `.notdef`. | `x`→Helvetica, mark→Kohinoor Devanagari — paints a mark Chrome never finds | Helvetica ×2 ✓ |
| Helvetica `ก` + U+0301 (base not covered, mark covered) | **Thonburi ×2** — the covered mark travels with its base and keeps its GPOS anchor | `ก`→Thonburi, U+0301→Helvetica — mid-cluster split, anchor lost | Thonburi ×2 ✓ |

## Post-spacing cluster origins

Path emission preserves two distinct layers of shaped positioning (DM-2444).
Blink/HarfBuzz owns glyph order, clusters, advances, and intra-cluster GPOS
offsets. Blink then applies letter/word spacing at grapheme-cluster boundaries
(`ShapeResult::ApplySpacingOrExpansion`, Chromium `7d859f27`), and capture records
the resulting Range origins. Each emitted cluster is therefore anchored to its
captured post-spacing origin while additional glyphs in that cluster retain the
shaper's advance and offset. This avoids per-character shaping, preserves
ligatures and cursive/Indic behavior, and prevents native advances from
accumulating over captured positive or negative spacing. RTL clusters and the
bidi-override native-direction reversal map back to the same source anchors.
| Arial `ل` + U+08F0 | **Arial ×2** (mark = `.notdef`) | mark→SF Arabic | Arial ×2 ✓ |
| Menlo `α` + U+0345 (decomposed input) | **Menlo ×1** — HarfBuzz *composes* to the precomposed ᾳ glyph (`hb-ot-shape-normalize.cc`) | `α`→Menlo, U+0345→**Monaco** | Menlo ×1 ✓ |
| Geneva `e` + U+0E48 | **Geneva + Thonburi** — U+0E48 is Script=**Thai**, not Inherited, so Blink's `RunSegmenter` splits base and mark into separate script runs *before* shaping | agrees (by accident of per-cp granularity) | ✗ merges them — see §4 itemization note |
| partial webfont (क ् only), text क्ष | webfont ×2 (क + visible halant) + **Kohinoor ×1 (ष only)** — the requeue unit is the *shaped cluster*: HarfBuzz keeps the unligated ष in its own cluster, so only it is re-queued, not the syllable | same assignment here | same ✓ |
| 4 controls / fully-uncovered clusters | — | agree | agree |

Three corrections these probes force on the ticket's own framing:

1. **The requeue unit is the shaped cluster, not the grapheme or syllable.**
   For the broken conjunct, HarfBuzz merged क+् (grapheme) but left ष in its
   own cluster; Chrome re-queued exactly ष. Cluster boundaries are an *output*
   of shaping with the failing font.
2. **Chrome often paints tofu where we paint a "better" glyph.** Cluster
   granularity plus the one-ask hint rule means a partially-covered cluster
   frequently ends at `.notdef`. Parity means matching that, including when it
   is uglier.
3. **Script itemization comes first.** A mark with a real script value
   (Thai U+0E48) never joins a Latin base's fallback context, because
   `RunSegmenter` split them before the shaper ever saw them. Cluster-level
   fallback without itemization *over-merges* (the prototype's one miss).

## 3. Why the existing sweeps cannot grade this

The 819-block unicode fixtures are **one-codepoint-per-cell grids** — there is
no multi-codepoint cluster anywhere in them, so cluster granularity is
structurally identical to codepoint granularity on that corpus. Measured: the
flag-on arm over the Hebrew/Arabic/Devanagari/Bengali/Tamil/Thai/Myanmar/Khmer
fixtures is identical to the flag-off arm to five decimals of raw `diffPct` on
all 9 fixtures — **with the mechanism proven armed** (invocation counters:
182/182 texts of the Thai fixture took the prototype path). The same is true of
the font-conformance oracle: it asks one codepoint at a time, so it can never
contain a mid-cluster case. Grading this mechanism needs a **multi-codepoint
oracle** (base+mark pairs and partial conjuncts against partially-covered
primaries). That oracle now ships as `tools/cluster-conformance.ts`; the probe
corpus above is its seed. This is the "a sample can be blind" lesson again: the
older gates would have scored the wrong unit at 100% forever.

## 4. Architecture

The shipped implementation (`src/render/cluster-fallback.ts`) replaces
`splitTextIntoFontRuns`'s per-codepoint walk:

```
capture text
  → independent bidi/script + SymbolsIterator source ranges
  → intersect at each next minimum endpoint (segmentForShaping)    [MUST come first]
  → per segment: shape-then-requeue loop
       queue = [segment]
       font cycle: primary → remaining declared families → STANDARD (kFontGroupFonts)
                   → webfont unicode-range partitions               (kSegmentedFace)
                   → one system answer per hint char, asked once    (kSystemFonts)
                   → platform last-resort face (Times on macOS)
                   → first candidate commits its .notdef            (kFirstCandidateForNotdefGlyph)
       each cycle: shape queued ranges with hb (harfbuzzShapeRun),
                   split by per-cluster all-glyphs-nonzero verdict,
                   commit shaped cluster runs, requeue notdef cluster runs
  → assemble FontRun[] without crossing a shaping-item boundary;
    carry each item's resolved direction and ISO 15924 script to every
    downstream shaper
```

- **`resolveFontForCodepoint` becomes "next font for this failing cluster".**
  The system stage asks it for the cluster's `ChooseHintIndex` character. This
  keeps every calibrated stage — live resolver first, static chain as net, PUA
  guard, emoji forcing — while changing only *what question* is asked (one hint
  per cluster, once) instead of one question per codepoint. `ChooseHintIndex`
  and the asked-once set are ~20 lines, ported in the prototype
  (`chooseHintIndex` / `collectHintChars`) — the ticket was right that this
  lands nearly free here and is meaningless before it.
- **Shaping engine**: the vendored harfbuzzjs (`harfbuzzShapeRun`), already
  rebuilt with Chromium's HarfBuzz configuration. The face for a key comes from
  `getFontSourceInfo`/`shapingFaceFor` (same derivation the NFD reroute uses).
- **Dotted-circle / NFD special cases dissolve rather than accrete.** The
  in-font decomposition branches (`complexShaperBaseMarkDecomposition`,
  `nfdBaseMarkDecomposition`), the composing direction (the Menlo ᾳ case), and
  dotted-circle insertion are all things real HarfBuzz does natively during
  shaping. Under shape-then-requeue they stop being special cases we detect and
  become behavior we inherit. The shaped splitter no longer calls
  `resolveDottedCircleHbRun`, pins a dotted-circle span, or commits a resolver's
  substituted NFD/math text. Those helpers remain reachable only from the
  explicitly disabled legacy walk and classified capture compatibility paths.

### Blink details the shipped implementation carries (closed from the prototype)

- **Source priority is an item boundary, not a queued-hint property**:
  `sourcePriorityItems()` ports the pinned emoji scanner into maximal `text`,
  `emoji`, `text-vs`, and `emoji-vs` ranges. `segmentForShaping()` computes the
  complete bidi/script ranges independently, then intersects the two streams as
  `RunSegmenter` does. It does not restart script resolution at a priority
  boundary: the Common U+2757 in `A❗B` inherits Latin on both sides. Each
  intersection owns a fresh fallback iterator. CSS may change that iterator's
  effective priority after the split, but explicit selectors win and equal
  effective priorities never merge source iterators. Declared families remain
  before the one-shot priority face. The authenticated Linux arm64 order,
  selector, CSS, and family matrix plus `02-text-emoji` gate this ownership;
  see [doc 201](201-emoji-presentation-item-ownership.md).
- **Script itemization first**: `segmentForShaping` (the RunSegmenter mirror,
  with bidi levels from `bidiLevelsFor`) runs before the requeue loop; each
  segment gets its own FontFallbackIterator, exactly as `ShapeSegment` is
  invoked per `RunSegmenterRange`. This is what closed the Geneva `e`+U+0E48
  probe miss.
- **Bidi/run-segment identity survives assembly**: Blink's
  `InlineNode::SegmentBidiRuns` splits an `InlineItem` whenever a resolved
  logical run ends (`core/layout/inline/inline_node.cc:1411-1435`), then
  `ShapeText` stops its forward coalescing scan when
  `ShouldBreakShapingBeforeText` sees a different resolved direction or
  RunSegmenter record (`:470-490`, `:1632-1653`). Domotion therefore merges
  adjacent same-face cluster assignments only within the same
  `segmentForShaping` item and records that item's LTR/RTL direction on the
  resulting `FontRun`. The same run carries the item's resolved ISO 15924
  script, so final emission cannot discard itemization and ask HarfBuzz to
  guess from a lone Common/Inherited mark. This matters when a broad face
  covers both sides of a bidi boundary: font identity alone contains no
  evidence that two shaping calls are required.
- **Neutral preferred scripts are preserved.** Blink keeps Common/Inherited
  characters neutral for run merging, but a neutral with exactly one
  `Script_Extensions` member records that member as `common_preferred_` and
  uses it if no strong script supersedes it. This matters for lone Vedic
  marks: the preferred Bengali/Devanagari tag selects HarfBuzz's syllabic
  shaper, while a mark with several possible scripts stays Common.
- **Context**: the buffer is filled with the *whole* text plus item
  offset/length. The design-time note that harfbuzzjs's `Buffer.addText` lacks
  offset/length parameters was **stale** — the vendored build's `addText(text,
  itemOffset, itemLength)` maps directly onto `hb_buffer_add_utf16`'s item
  bounds, so no wasm-API addition was needed. Re-queued ranges therefore keep
  Arabic joining context, and cluster values come back as absolute indices.
- **Direction/script/language on the buffer**: set explicitly per segment
  (`hb_buffer_set_script` via the generated UCD-name→ISO 15924 table
  `script-iso15924.generated.ts`, direction from the segment's bidi level,
  language from the run's `lang`), after `guessSegmentProperties` so the
  explicit values win.
- **The last-resort stage**: `GetLastResortFallbackFont` is shaped before the
  terminal — Times then Lucida Grande on macOS (`mac/font_cache_mac.mm:376-394`),
  and on common Skia the descriptor-selected `GetFallbackFontFamily` first,
  followed by the existing "Sans"/"Arial" tail
  (`alternate_font_family.h:107-123`, `skia/font_cache_skia.cc:146-259`, rev
  7d859f27). The five legacy generics map to their logical keys; none/standard/
  webkit-body start unnamed, while `system-ui` and `math` do not occupy the
  legacy enum. Candidates are deduped like every other stage, with
  `kFirstCandidateForNotdefGlyph` re-returning the first candidate so ITS
  `.notdef` paints. The exact family-exhaustion and reverse-cache-order checks
  are in `src/render/skia-last-resort-routing.test.ts`; they compare logical
  routes and instance identity, and include a shaped U+E000 `.notdef`
  activation whose monospace terminal alone covers the queued cluster—never
  pixels.
- **U+3000 synthesized-space** (`harfbuzz_shaper.cc:684-691`): a U+3000 shaped
  to the current font's SPACE glyph reads `.notdef` unless shaping with the
  last font, so a font with a real ideographic-space glyph is found.
- **`kUnmatchedVSGlyphId` re-cycling**: modeled outside the glyph funcs (wasm
  fonts take no callbacks) — `variationGlyph` asks the identical cmap-14
  question per (base, selector) pair after the pair passes Blink's
  `Character::IsVariationSequence` gate. That gate recognizes emoji sequences,
  Chromium's generated standardized-sequence table, and undecomposed
  ideographic sequences; an invalid base+selector pair remains an ordinary
  default-ignorable and does not spuriously requeue. The VS15/VS16 presentation
  rule calls `fontHasSupportedColorTable`, the same sbix / COLR+CPAL /
  CBDT+CBLC test as Blink's
  `TypefaceHasAnySupportedColorTable`, an unmatched sequence re-queues its
  cluster, and exhausting the list with unmatched sequences left triggers the
  `kReshapeQueueReset` restart in ignore-VS mode. `font-variant-emoji`
  forcing rides the same path: `text` synthesizes VS15, `emoji` synthesizes
  VS16, and `unicode` chooses VS15/VS16 from the codepoint's default.
- **Webfont primaries and unicode-range partitions**: the primary shapes via
  its retained `@font-face` bytes (`webfontShapingFace` /
  `registerHbBufferSource`); a range-partitioned family walks its variants as
  kSegmentedFace faces (contribution checked against the hint list, subsetted
  variants exempt from the unique-set dedup), with cluster verdicts clamped to
  the variant's `unicode-range` — the stand-in for Blink passing the face's
  range set into `ShapeRange` (`harfbuzz_shaper.cc:1119`). For variation-glyph
  callbacks, the clamp applies to the base `unicode`, never independently to
  `variation_selector` (`harfbuzz_face.cc:98-101`).
- **Shape-verdict cache**: keyed on face, size, axes, direction, script,
  language, and the item text with five code units of context per side —
  exact, because `hb_buffer_t::CONTEXT_LENGTH` is 5 (`hb-buffer.hh`, rev
  4de187d). LRU-capped at 4096.
- **One feature state for every candidate shape**: `ShapeSegment` passes the
  same resolved `font_features` into every `ShapeRange` call
  (`harfbuzz_shaper.cc:1098-1127`). Domotion does the same for primary,
  declared, priority, system, last-resort, and first-candidate probes; a
  `-liga` or explicit feature value cannot disappear after the first miss.
- **Face materialization is candidate-local**: failure to open one selected
  face through the local HarfBuzz bridge produces no verdict for that
  candidate, leaving its ranges queued. The iterator continues and its
  first-candidate terminal remains authoritative. Iterator non-convergence or
  a non-tiling assignment is an implementation error, not a reason to silently
  select fonts per codepoint.

### Reconciled prepasses (DM-2387)

- The state machine shapes the authored dotted-circle/orphan range on every
  iterator candidate. HarfBuzz inserts U+25CC only for a broken syllable when
  that candidate nominally maps U+25CC
  (`hb-ot-shaper-syllabic.cc:33-99`, rev `4de187d`). There is no mark-face pin.
- `resolveFontForCodepoint(...).decomposed` may inform the system-stage face
  answer, but the state machine always shapes the original queued source range.
  HarfBuzz tests composed coverage and canonical-piece coverage in that same
  candidate (`hb-ot-shape-normalize.cc:108-200`). There is no substituted-text
  commit.
- The capture funnel's source-preserving shaper evidence and its explicitly
  classified compatibility rewrites remain separate from fallback assignment.
  The default production route records source span, emitted text, selected
  face, glyph id, cluster, advance, and offset so a hidden rewrite cannot pass
  as iterator evidence.

## 5. The static-chain question (measurement)

The ticket asks whether the sampled static chains still earn their place now
that the live resolvers are default-on. Instrumented at the decision sites
(`FontStageStats` in `font-resolution.ts`) and swept over the conformance
universe (154,998 codepoints, no PUA) × the top-6 corpus stacks:

**macOS (dev machine, helper present):**

| counter | value |
|---|---|
| resolver decisions | 929,988 |
| reached the system stage | 916,119 |
| live resolver answered | 423,495 (46.2%) |
| **static chain answered** | **6 (0.001%)** — all six are variation selectors (U+FE0x page) routed to `u-noto-sans` |
| uncovered terminal (primary `.notdef`, as Chrome) | 492,618 |
| static chain *asked* | 492,624 |

The chain was consulted half a million times to contribute six answers — and
those six are answers Chrome does **not** give (Blink's system stage is the
only stage; what it declines paints `.notdef`). On this corpus the macOS chain
is not a net, it is pure divergence surface plus probe cost (the chain walk is
where ~64% of the resolver's coverage probes come from).

What this number does NOT establish, stated so the retirement decision is made
honestly:

- **Helper-absent hosts.** With no native helper the live resolver answers
  nothing and the chain answers everything. Retiring the chain means those
  hosts drop to `<text>`/`.notdef` for every fallback codepoint. That may be
  acceptable (the helper ships with the package on macOS) but it is a real
  behavior change on a real configuration.
- **Six stacks are a sample.** A primary that is itself a broad-coverage family
  (Arial Unicode MS-first stacks exist in the corpus tail) exercises the chain
  differently. The instrumentation is cheap to re-run over all 450 stacks.
- **Windows is excluded by design** — its chain transcribes Blink's own
  hardcoded table and *is* the parity mechanism (docs/106 §4).
- Linux: same instrumentation queued in the CI container (fontconfig helper
  built in-container); the fcfallback resolver answers by construction from the
  same fontconfig Chrome consults, so the expected shape is the same as macOS.
  Record the number before deciding.

## 6. Cost

- **Shaping count.** Today every emitted run is already shaped downstream
  (fontkit `layout` or hb). Shape-then-requeue adds: one hb shape of the full
  segment with the primary (replacing the per-codepoint cmap walk), plus one
  shape per (requeued range × candidate font). On clean text (primary covers
  everything — the overwhelmingly common case) that is one shape, and the
  per-codepoint probe storm disappears with it: the 92%-of-probes fast path
  (one helper IPC round trip per codepoint on helper-backed primaries,
  4,000/4,353 probes in the profiled Windows walk) is *replaced* by a single
  in-process wasm shape whose `.notdef` scan is the byproduct. Measured on the
  9-fixture A/B: wall time identical (~7 s both arms) with 182 prototype
  invocations per fixture — the prototype is not measurably slower even
  unoptimized, because hb shaping of short runs is cheap next to Playwright
  capture.
- **Fallback storms are bounded by the hint rule.** Each failing cluster run
  costs at most one system ask per distinct hint char (asked-once set), then
  the last-resort shape. Blink's own bound.
- **Cache design.** Two layers: (i) hb face/font objects per (file, faceIndex)
  — already cached in `harfbuzz-shaper.ts` with ptem/variations reset per call;
  (ii) a shape-verdict cache keyed (faceKey, segment text) → cluster verdicts
  + committed split, LRU-capped, exactly where the per-codepoint decision
  cache sits today. The unicode-grid case (hundreds of one-char segments per
  fixture) hits (i) hard and (ii) not at all; real paragraphs hit (ii).
- **Risk of double shaping drift**: the split decision and the final emission
  both shape; if they use different engines (hb for splitting, fontkit for
  emission) a cluster can be committed on hb's verdict and then emitted with
  fontkit glyphs. The end state (tracked separately, docs/106 §6) is hb
  everywhere; until then the split verdict must be treated as authoritative
  only for *font assignment*, never for glyph ids.

## 7. What it fixes, what it might break

**Fixes** (verified against Chrome on the probe corpus): mid-cluster splits
that strip marks of their GPOS anchors (Thai/Arabic/Hebrew-pointed/Indic);
phantom fallback glyphs where Chrome paints `.notdef` tofu; the composing
direction of cmap-vs-shaped divergence (Menlo ᾳ); partial-webfont conjuncts
split at the exact cluster boundary Chrome uses.

**Might break / will change:**

- The default route intentionally changes old per-codepoint special cases:
  an orphan receives U+25CC only if the selected candidate's HarfBuzz shaper
  inserts it, and canonical decomposition happens only inside that candidate.
  The production provenance oracle grades the resulting glyph/cluster/advance
  stream rather than accepting face agreement alone.
- Fixtures calibrated against the old (wrong-unit) behavior will move — that
  is the point, but the moves land in the visual suites as diffs to re-baseline.
- Helper-backed faces whose file cannot be opened by hb remain candidate-local
  misses. A portable fixture test pins the terminal to the first candidate and
  proves that no implicit legacy restart occurs.
- Wall-time regressions on pathological fixtures (hundreds of distinct failing
  clusters, e.g. the unicode grids under a narrow primary) are possible without
  the verdict cache; the A/B saw none, but the A/B corpus is also the best case.

## 8. Flags and instrumentation (in-tree now)

- `DOMOTION_CLUSTER_FALLBACK=0` — restore the legacy per-codepoint walk (the
  shaped splitter is the default; there is no per-call implicit fallback).
- `DOMOTION_CLUSTER_FALLBACK_DEBUG=1` — print invoked/accepted counters at exit
  (armed-mechanism proof for A/Bs; a flag being on is not evidence a mechanism
  ran).
- `FontStageStats` (`_getFontStageStats` / `_resetFontStageStats`,
  `font-resolution.ts`) — stage-attribution counters behind the static-chain
  retirement question; sweep driver pattern in `tools/scratch/` (see the
  Hot Sheet ticket notes for the exact scripts used here).
