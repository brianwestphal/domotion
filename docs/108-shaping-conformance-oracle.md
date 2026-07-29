# 108 — Shaping conformance oracle

`tools/shaping-conformance.ts` · `npm run fonts:shaping`

The sibling of the face oracle ([doc 107](107-font-conformance-oracle.md)). That one answers *which font*; this one answers *which glyphs, where*.

## Why it exists

The face oracle is a **face-identity** instrument. It asks "which font did Chrome pick for this codepoint, and did we pick the same" — and nothing else. Everything shaping decides is invisible to it:

- glyph counts (a ligature that forms, or fails to)
- contextual forms and Arabic joining
- Indic reordering and cluster formation
- mark attachment offsets

That gap is not hypothetical. The nukta misplacement fixed in 2026-07 was a real **3px mark offset** that a prior session first dismissed as antialiasing; a face-identity oracle scores it as a clean pass, because the face was right and only the position was wrong.

It also gates the shaping work: replacing fontkit's `layout()` with harfbuzzjs as the single shaper has a strong structural argument (Blink shapes with HarfBuzz everywhere, we already depend on harfbuzzjs) and, without this, **no instrument to confirm it**. "Same engine, so it must match" is exactly the kind of claim this project retires.

## What each side is asked

| | source |
| --- | --- |
| **Chrome** | CDP `CSS.getPlatformFontsForNode` → glyph count per face; `Range.getClientRects()` per source character → geometry |
| **Ours** | the `<text x="x0 x1 …">` list `renderTextAsPath` emits — one entry per glyph we actually paint, at the x we paint it |

**Neither side exposes glyph IDs.** There is no glyph-level CDP domain (checked against `Schema.getDomains`), and `getPlatformFontsForNode` carries only `familyName` / `postScriptName` / `isCustomFont` / `glyphCount`. So this compares what both sides *do* expose — which is strictly more than the face oracle, and enough for the classes above: a ligature that fails to form changes the count, and a mark attached wrong changes a position.

Our side is read back off the renderer's **real output** rather than from a fresh shaping call. That is deliberate: the face oracle's own instrument bug was asking a different question than the renderer asks (`resolveFontSpec` vs `getFontInstance`), and reading the emitted markup makes that class of divergence impossible here.

## Tiers

Agreement is tiered, and the tiers are the point — a single pass/fail number would hide both the findings and the blind spots.

| Tier | Meaning |
| --- | --- |
| `agree-exact` | same glyph count, every comparable position within tolerance |
| `agree-count` | same glyph count, comparable positions **differ** — this is the mark-offset tier |
| `agree-count-clustered` | same glyph count, positions **not comparable** (see below) |
| `mismatch-count` | different glyph count — a shaping decision differs |
| `mismatch-unrendered` | we produced nothing for a run Chrome painted |

`agree-count` rows are recorded in full in `report.json`, not merely tallied: it is the tier a 3px mark misplacement lands in, and a tier you can only see the size of is one nobody acts on. The summary also prints the median / p90 / max position delta across it.

### The structural blind spot, stated plainly

Chrome reports one x per **source character**; we report one per **glyph**. Whenever shaping is not 1:1 — any ligature, any Indic or Arabic cluster — the two lists differ in length and **cannot be compared pairwise at all**, even though the counts agree. Those runs get the `agree-count-clustered` tier. Scoring them as position disagreements would invent findings; scoring them as exact would hide that positions went unchecked. This is the same lesson as the face oracle's retired `agree-same-file` tier, which scored different cuts of one `.ttc` as agreement and hid 2,064 real wrong-cut picks.

## Corpus

**Derived, not authored.** `--extract-runs` walks the fixture corpus, and for every text node records `(text, fontFamily, fontSize, fontWeight, fontStyle)` from the element's **computed** style. A hand-written list of "interesting" strings is precisely the sampled artifact this tool replaces — it would contain only the cases someone already thought of.

Runs are filtered to non-empty, ≤24 characters, and **whitespace-free**. The last is not cosmetic: Chrome's `glyphCount` includes the space glyphs HarfBuzz produced, while our renderer usually emits no position for them (no ink) — but **does** on at least one path (measured: the emoji path emits one entry per character, spaces included). Normalizing by subtracting the whitespace count papers over that with an assumption that is false somewhere, so the corpus excludes the question instead. Nothing is lost for shaping: ligatures, joining, reordering and mark attachment are all *within-word* phenomena, and a space is a word boundary.

## Instrument audit

Three defects were found and fixed in this tool **before any of its numbers were quoted**, which is the discipline doc 107 earned the hard way:

1. **Whitespace counting.** The first run reported 25 mismatches on 200 runs. The glyph-count delta was exactly the space count in 24 of them — the instrument disagreeing with itself. Resolved by excluding whitespace runs from the corpus.
2. **Only the first `<text>` element was read.** A run spanning two fonts emits one element per font, so a mixed-font run looked truncated: on `"FIXED → trapped"` our 5 positions were exactly Chrome's first 5, with the other 8 in the second element. Now every element is summed.
3. **The cluster blind spot was scored as a position disagreement**, inflating the interesting tier with cases it had not actually checked. Now its own tier.

Positive control: the tool reports the glyph counts hand-measured against Chrome for `fi` → 1 (Times ligature), `Á` → 1 (precomposed), `क्षि` (4 chars) → 2, `السلام` (6 chars) → 5. Negative control: earlier revisions did report mismatches, so it is not a no-op.

## Baseline, 2026-07-30 (macOS)

Full derived corpus from `external/html-test`:

    runs               2,385
    agree exact        2,023  (84.8%)
    agree count-only     348  (14.6%)   <- real position disagreements
    agree clustered       13  ( 0.5%)
    MISMATCH count         1  ( 0.0%)

    position deltas across the 348: median 1.20px   p90 2.82px   max 5.64px

Read the 348 first. Those runs shape to **visibly different glyph positions** than Chrome, at the same magnitude as the nukta defect that motivated this tool — and every one of them was invisible to the face oracle. The single hard mismatch is an emoji run where Chrome produces 1 glyph and we produce 2.

## Known gaps

- **Glyph IDs are not compared** — neither side exposes them. A run could agree on count and position while painting the wrong glyph. Closing this needs a signal Chrome does not currently offer.
- **Advances are compared only via positions.** A per-glyph advance is inferred from adjacent positions, so the final glyph's advance is unchecked.
- **macOS only**, like the face oracle. Shaping is HarfBuzz on every platform so the results should travel better than face selection does, but that is an expectation, not a measurement.
- Corpus is `external/html-test` only; the unicode fixture set is not yet swept.

## Related

- [107 — font conformance oracle](107-font-conformance-oracle.md) — the face half
- [106 — Blink font parity inventory](106-blink-font-parity-inventory.md) — what Blink runs, per platform
- [font-resolution-diagram.md](font-resolution-diagram.md) — the resolution flow both oracles measure
