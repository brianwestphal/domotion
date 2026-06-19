# HarfBuzz reroute for USE-shaped precomposed letters (DM-1197)

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
