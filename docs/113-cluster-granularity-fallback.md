# 113 — Font fallback at shaped-cluster granularity (design)

Status: **design + measured prototype** — not shipped. The prototype is
flag-gated (`DOMOTION_CLUSTER_FALLBACK=1`, default OFF) in
`src/render/cluster-fallback.ts`; the shipping per-codepoint path is unchanged
with the flag off. Implementation lands under follow-up tickets.

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

Domotion decides **per codepoint from cmap coverage, before any shaping**
(`splitTextIntoFontRuns`, `src/render/text-to-path.ts`, with
`resolveFontForCodepoint` in `src/render/font-resolution.ts` as the
per-codepoint oracle). The unit is wrong, and no table can fix a wrong unit.

## 2. Verified divergence classes (Chrome ground truth, CDP `CSS.getPlatformFontsForNode`)

Probed against Playwright Chromium on macOS before designing anything, per the
falsify-first rule. Ten (font, text) cases; the shipping path matches Chrome's
per-glyph font assignment on **6/10**, the prototype on **9/10**:

| case | Chrome paints | shipping path | prototype |
|---|---|---|---|
| Helvetica `x` + U+0951 (base covered, mark not) | **Helvetica ×2** — the mark is Helvetica's `.notdef` tofu. The cluster's hint char is `x` (U+0951 is Inherited); CoreText answers Helvetica; the iterator refuses the duplicate; the terminal commits `.notdef`. | `x`→Helvetica, mark→Kohinoor Devanagari — paints a mark Chrome never finds | Helvetica ×2 ✓ |
| Helvetica `ก` + U+0301 (base not covered, mark covered) | **Thonburi ×2** — the covered mark travels with its base and keeps its GPOS anchor | `ก`→Thonburi, U+0301→Helvetica — mid-cluster split, anchor lost | Thonburi ×2 ✓ |
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
contain a mid-cluster case. Grading this mechanism needs a **new fixture family
and a new oracle mode** (multi-codepoint cells: base+mark pairs and partial
conjuncts against partially-covered primaries — the probe corpus above is the
seed). This is the "a sample can be blind" lesson again: the existing gates
would have scored the wrong unit at 100% forever.

## 4. Architecture

The prototype (`src/render/cluster-fallback.ts`) is the design in miniature;
the follow-up implementation replaces `splitTextIntoFontRuns`'s per-codepoint
walk with it:

```
capture text
  → script itemization (segmentForShaping — Blink: RunSegmenter)   [MUST come first]
  → per segment: shape-then-requeue loop
       queue = [segment]
       font cycle: primary → remaining declared families            (kFontGroupFonts)
                   → webfont unicode-range partitions               (kSegmentedFace)
                   → one system answer per hint char, asked once    (kSystemFonts)
                   → platform last-resort face (Times on macOS)
                   → first candidate commits its .notdef            (kFirstCandidateForNotdefGlyph)
       each cycle: shape queued ranges with hb (harfbuzzShapeRun),
                   split by per-cluster all-glyphs-nonzero verdict,
                   commit shaped cluster runs, requeue notdef cluster runs
  → FontRun[] (same contract as today; downstream emitters unchanged)
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
  become behavior we inherit. The `resolveDottedCircleHbRun` and per-codepoint
  NFD machinery are retirement candidates *after* the mechanism ships — not
  before, and each retirement needs its own A/B.

### Blink details the implementation must keep (and the prototype does not)

- **Context**: Blink fills the *whole* text into the hb buffer with an item
  offset/length (`CaseMappingHarfBuzzBufferFiller`, `hb_buffer_add_utf16(span,
  size, start_index, num_characters)`), so re-queued ranges shape with joining
  context. The prototype shapes substrings; a lam re-queued off the end of an
  Arabic word would lose its init/medial form. harfbuzzjs's `Buffer.addText`
  has no offset/length parameters — the implementation needs a small wasm-API
  addition (hb_buffer_add_utf8 with item bounds) or pre/post-context feeding.
- **Direction/script on the buffer**: Blink sets them explicitly from the bidi
  run and itemizer; the prototype guesses (`guessSegmentProperties`).
- **The last-resort stage**: Blink shapes once more with Times (macOS) before
  committing `.notdef`. The prototype skips straight to the terminal; on the
  probe corpus the outcome was identical (Times covered none of the failing
  clusters), but that is a property of the corpus, not of the design.
- **`kUnmatchedVSGlyphId`** (variation-selector re-cycling with
  `kReshapeQueueReset`, `harfbuzz_shaper.cc:1009-1020`) and the U+3000
  synthesized-space special case (`:684-691`) are unmodeled.
- **Webfont primaries** currently decline (no exported bytes→face seam in the
  prototype); `webfontShapingFace` exists and closes this.

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

- Every calibrated single-codepoint behavior that today routes through
  per-codepoint special cases (dotted-circle runs, math-alpha decomposition,
  emoji presentation forcing) must survive the reordering — the prototype
  defers to `resolveFontForCodepoint` for the hint, which preserves them for
  the *font choice*, but the run *shape* changes (e.g. an orphan mark no longer
  gets a synthetic ◌ prepended by us; it gets one iff HarfBuzz inserts it,
  which is Chrome's rule — `hb-ot-shaper-syllabic.cc:51-53` — but our paths
  emitters must then draw what hb returns).
- Fixtures calibrated against the old (wrong-unit) behavior will move — that
  is the point, but the moves land in the visual suites as diffs to re-baseline.
- Helper-backed faces whose file cannot be opened by hb (none known on macOS
  system fonts; webfonts pending) decline to legacy in the prototype; in the
  final design a face hb cannot open cannot take this path at all and must be
  documented.
- Wall-time regressions on pathological fixtures (hundreds of distinct failing
  clusters, e.g. the unicode grids under a narrow primary) are possible without
  the verdict cache; the A/B saw none, but the A/B corpus is also the best case.

## 8. Flags and instrumentation (in-tree now)

- `DOMOTION_CLUSTER_FALLBACK=1` — enable the prototype split
  (`src/render/cluster-fallback.ts`; a decline falls back to the shipping path).
- `DOMOTION_CLUSTER_FALLBACK_DEBUG=1` — print invoked/accepted counters at exit
  (armed-mechanism proof for A/Bs; a flag being on is not evidence a mechanism
  ran).
- `FontStageStats` (`_getFontStageStats` / `_resetFontStageStats`,
  `font-resolution.ts`) — stage-attribution counters behind the static-chain
  retirement question; sweep driver pattern in `tools/scratch/` (see the
  Hot Sheet ticket notes for the exact scripts used here).
