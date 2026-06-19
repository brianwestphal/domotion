# HarfBuzz routing for complex-script edge cases (DM-1197, DM-1215)

This doc covers two narrow uses of the `harfbuzz-shaper.ts` machinery, both routing
specific complex-script runs through real HarfBuzz (harfbuzzjs, the engine Chrome
embeds) where macOS shaping diverges from Chrome's paint: (1) USE-shaped precomposed
letters (DM-1197, below) and (2) orphaned-mark dotted circles (DM-1215, at the end).

## USE-shaped precomposed letters (DM-1197)

A narrow shaping reroute: a handful of complex-script precomposed letters paint
DIFFERENTLY in Chrome than in Domotion's macOS shaping path, so the renderer
shapes those specific runs with the real HarfBuzz library (harfbuzzjs) instead.

## The divergence

Chrome shapes all complex text with **HarfBuzz**. For a precomposed letter that
has a canonical `base + combining-mark` decomposition AND whose script is shaped
by HarfBuzz's **Universal Shaping Engine** (USE), the USE shaper sets
`HB_OT_SHAPE_NORMALIZATION_MODE_COMPOSED_DIACRITICS_NO_SHORT_CIRCUIT`
(`hb-ot-shaper-use.cc`). `NO_SHORT_CIRCUIT` disables the optimization that would
grab the precomposed cmap glyph, and `compose_use` refuses to recompose across
the trailing mark — so the letter renders as **base + a separately
GPOS-positioned mark**, not the precomposed glyph.

Example — Kaithi `U+110AB` VA (NFD = `U+110A5` BA + `U+110BA` NUKTA):

```
hb-shape NotoSansKaithi U+110AB  →  [ktBa=0+568 | ktNukta=0@-11,0+0]
```

The nukta's vertical position comes from the `ktNukta` glyph outline (≈3px below
the baseline), giving a visible gap below the base.

Domotion routes the Indic Noto fonts through the **CoreText glyph-helper** (they
crash fontkit's GSUB parser — see `docs/49` / DM-983). CoreText **recomposes**
the same sequence back to the precomposed `ktVa` glyph, whose built-in nukta sits
≈3px higher (touching the base). Result: the nukta lands in the wrong place vs
Chrome (DM-1197 — the Kaithi `U+110AB` "dot position" diff).

## The reroute

`resolveFontForCodepoint` (`src/render/text-to-path.ts`) detects these
codepoints via `complexShaperBaseMarkDecomposition(cp)` and, when the primary
font covers the decomposed pieces, sets the run's `fontOverride` to a HarfBuzz
shaping instance (`src/render/harfbuzz-shaper.ts::makeHarfbuzzShapingInstance`).
That instance delegates every metric / coverage query to the base instance but
overrides `layout()` to shape via harfbuzzjs (the same engine Chrome embeds) and
return the glyphs (outlines from `font.glyphToPath`), GPOS positions, and source
clusters. The run text stays the SOURCE codepoint — HarfBuzz decomposes
internally, like Chrome — so clusters / captured xOffsets stay aligned and the
embedded-font emitter's cluster-aware anchoring (DM-1028) places the mark.

harfbuzzjs is also robust where fontkit isn't: it does not crash on the Indic
Noto GSUB tables, so this works for the exact fonts that forced the CoreText
route in the first place.

## Scope — USE shaper ONLY

The reroute fires ONLY for codepoints in a USE-shaped block. The dedicated
HarfBuzz shapers — Indic (Devanagari … Sinhala), Thai/Lao, **Tibetan**, Myanmar,
Khmer, Arabic, Hebrew, Hangul (`DEDICATED_SHAPER_RANGES`) — are excluded for two
reasons:

1. They don't trigger the divergence: macOS CoreText already matches Chrome for
   them (the devanagari / bengali / gurmukhi / oriya / tamil / myanmar / tibetan
   unicode fixtures all PASS on the CoreText path).
2. harfbuzzjs's dedicated-shaper output can itself diverge from Chrome's paint —
   it decomposes Tibetan `U+0F43` (`[82,199]`) where Chrome and the `hb-shape`
   CLI render the precomposed glyph (`[gh.]`). Rerouting Tibetan regressed the
   tibetan fixture until the exclusion was added.

As of writing the reroute affects 13 codepoints in 3 blocks: Balinese
(`U+1B06`, `U+1B08`, `U+1B0A`, `U+1B0C`, `U+1B0E`, `U+1B12`), Kaithi (`U+1109A`,
`U+1109C`, `U+110AB`), and Tulu-Tigalari (`U+11383`, `U+11385`, `U+1138E`,
`U+11391`). The gate is unit-tested in `text-to-path.test.ts`.

# HarfBuzz routing for orphaned-mark dotted circles (DM-1215)

A second, related use of the same `harfbuzz-shaper.ts` machinery. When a complex-
script combining mark appears with **no spacing base** (orphaned — at the start of
a run, or alone in a per-cell Unicode-table fixture), Chrome's HarfBuzz inserts a
dotted circle `U+25CC` as a stand-in base and GPOS-positions the mark onto it.
Confirmed in the Blink/HarfBuzz source: `hb_syllabic_insert_dotted_circles`
(`hb-ot-shaper-syllabic.cc`) calls `font->get_nominal_glyph(0x25CC)` — so the ◌
comes from the **mark's own font** and the cluster is positioned within that single
font.

The two font styles, verified with the `hb-shape` CLI:

- **Indic** faces give the mark a real GPOS offset — Brahmi `U+11038` shapes to
  `[uni25CC=0+594 | brm_vowelAA=0@-294,0+0]`, the `-294` centering the mark on the
  594-unit ◌.
- **USE** faces (Adlam / Kharoshthi / Miao / Tagalog / Tai-Tham / Syloti) give the
  mark offset 0 and self-position via the mark's own outline — Adlam `U+1E944`
  shapes to `[u1E944=0+0 | uni25CC=0+594]`, both glyphs at x=0 (overlapping).

fontkit diverges: for the USE faces it **drops the ◌ entirely** (Adlam `U+1E944` →
just `gid144 adv0` — the bare floating mark, no circle), and its geometric
mark-centering never matched Chrome's positioning. The fix routes the orphaned
cluster through the mark's font as a `makeHarfbuzzShapingInstance`, so HarfBuzz
inserts AND positions the ◌ exactly as Chrome does.

The routing lives in BOTH run-splitters — `textToPathMarkup` (glyph-path mode) and
`splitTextIntoFontRuns` (embedded-font mode, which these Unicode fixtures use) —
via the shared `resolveDottedCircleHbRun` helper. The trigger is "an orphaned mark
(no spacing base in its cluster) whose font covers `U+25CC` and is HarfBuzz-
openable"; a mark that follows a real base is NOT rerouted (it shapes normally), so
ordinary accented / Arabic / Devanagari text is untouched. An explicit `U+25CC`
already present before a mark (inserted upstream by `insertSyntheticDottedCircles`)
opens the cluster the same way. Trailing marks join one cluster, sharing a single
◌. The behavior is unit-tested in `text-to-path.test.ts` (orphan → 2 glyphs;
multi-mark → 3; based mark → 2 with no ◌; bare base letter → 1).

This fixed the remaining DM-1215 dotted-circle blocks (adlam, miao, brahmi,
kharoshthi, tagalog, tai-tham, syloti — plus vedic-extensions) without regressing
the blocks already passing.
