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
- The fallback iterator carries two facts into the final `FontRun`: the exact
  selected face (source path, collection member, and axes on its HarfBuzz
  proxy) and RunSegmenter's resolved ISO 15924 script. No dotted-circle prepass
  selects or pins a companion face. Embedded, path, and provenance shaping all
  consume that script. This is observable for a lone Vedic mark: dropping
  `Deva` makes HarfBuzz guess Common and bypass the syllabic shaper even though
  the correct Mukta face was already selected.

This remains separate from font fallback: fallback selects the concrete face;
the selected face and its HarfBuzz glyph stream decide dotted-circle behavior.

## Controls

Focused tests cover BMP and SMP probe candidates, ordinary letters and
punctuation, leading ZWJ/ZWNJ versus unrelated Format controls, based marks,
default-shaper Latin marks, uncovered BMP/SMP Brahmic marks, pre-base and
post-base matras, RTL marks, and captured negative/positive decisions. The
embedded Mukta control additionally pins U+25CC-present and U+25CC-absent
faces, broken and non-broken syllables, U+1CF7 `.notdef`, source clusters,
advances, offsets, and the selected physical face. The capture bundle is
regenerated from the reviewed source.

Linux has a separate native-inventory gate for the Vedic Extensions visual
fixture. On the pinned Playwright Noble image, the 14 Chromium-circled cells
must select the same FreeSans or FreeSerif face as the renderer and match exact
glyph ids, shared cluster zero, advances, and offsets. The fixture also pins
Chromium's `FreeSans:20` / `FreeSerif:37` face census and persists the production
records in `results.json`. Focused controls shape FreeSerif base+mark without a
circle, shape a retained-gid subset that lacks nominal U+25CC, and disable shaped
cluster fallback to prove that the orphan's inserted base disappears. These
names and codepoints are oracle expectations for that runner image only; they
are not renderer routing inputs.

The production route oracle adds a paired Thai control: bare U+0E48 and explicit
U+25CC+U+0E48 both retain their authored source spans, but Chromium and Domotion
produce distinct selected glyph records because only the latter asks candidate
coverage for an authored circle. Brahmi remains in the broad-script exact-record
set. This prevents a pre-inserted/pinned circle from masquerading as the selected
candidate's shaping outcome.
