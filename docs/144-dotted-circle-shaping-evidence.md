# Dotted-circle decisions from shaping evidence

Domotion no longer uses a Unicode block floor, an SMP-only letter gate, or a
Tamil codepoint pair to decide whether an orphan receives U+25CC. Those were
samples of outcomes, not the decision Chromium makes.

## Upstream owner

At the pinned HarfBuzz revision, `hb_syllabic_insert_dotted_circles` inserts
U+25CC only when the selected shaping buffer contains a syllable classified as
broken and the selected font maps U+25CC
(`external/harfbuzz/src/hb-ot-shaper-syllabic.cc:33-91`). The Indic, USE,
Khmer, and Myanmar shapers call that common operation after their generated
machines have assigned syllable types. Blink hands each resolved face and
script run to HarfBuzz; it does not maintain a parallel codepoint-range list.

## Domotion decision boundary

- Capture considers every Unicode Mark, Lo, and Lm scalar as a possible probe
  candidate. The Chromium canvas comparison between the source glyph and an
  explicit-circle control is the decision for a covered glyph. Ordinary BMP
  letters and default-shaper combining marks are candidates but compare false.
- ZWJ and ZWNJ preserve the current base state, matching their shaping-machine
  joiner category. This general rule replaces the former Tamil ZWJ + U+0BC6
  exception; unrelated Format characters do not inherit it.
- For helper-backed rendering, the pinned ICU companion supplies General
  Category, Script, and Indic Syllabic Category. Domotion then shapes the
  orphan on the selected face through the vendored HarfBuzz build and detects
  the selected face's U+25CC glyph in the returned glyph stream. The old
  `usesComplexShaperDottedCircle` block table remains only as a compatibility
  diagnostic/test export and is not a production routing input.
- When the shaped-cluster emitter owns the same HarfBuzz result, the source text
  remains intact and that emitter inserts/reorders the circle. Synthetic text is
  retained only for the explicitly degraded non-cluster path or a captured
  covered-face result whose layout facade cannot reproduce Chromium's circle.

This remains separate from font fallback: fallback selects the concrete face;
the selected face and its HarfBuzz glyph stream decide dotted-circle behavior.

## Controls

Focused tests cover BMP and SMP probe candidates, ordinary letters and
punctuation, leading ZWJ/ZWNJ versus unrelated Format controls, based marks,
default-shaper Latin marks, uncovered BMP/SMP Brahmic marks, pre-base and
post-base matras, RTL marks, and captured negative/positive decisions. The
capture bundle is regenerated from the reviewed source.
