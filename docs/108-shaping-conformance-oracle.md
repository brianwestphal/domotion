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

It also gates the shaping work: replacing fontkit's `layout()` with harfbuzzjs as the single shaper has a strong structural argument (Blink shapes with HarfBuzz everywhere, and `vendor/harfbuzzjs/` is now built with Chromium's own HarfBuzz configuration — same release, same defines, AAT included) and, without this, **no instrument to confirm it**. "Same engine, so it must match" is exactly the kind of claim this project retires.

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

**Derived, not authored.** `--extract-runs` walks the fixture corpus, and for every text node records `(text, fontFamily, fontSize, fontWeight, fontStyle, fontVariationSettings)` from the element's **computed** style. A hand-written list of "interesting" strings is precisely the sampled artifact this tool replaces — it would contain only the cases someone already thought of.

Runs are filtered to non-empty, ≤24 characters, and **whitespace-free**. The last is not cosmetic: Chrome's `glyphCount` includes the space glyphs HarfBuzz produced, while our renderer usually emits no position for them (no ink) — but **does** on at least one path (measured: the emoji path emits one entry per character, spaces included). Normalizing by subtracting the whitespace count papers over that with an assumption that is false somewhere, so the corpus excludes the question instead. Nothing is lost for shaping: ligatures, joining, reordering and mark attachment are all *within-word* phenomena, and a space is a word boundary.

### The variable axis is part of a run's identity

`font-variation-settings` is recorded alongside the other font properties, declared on Chrome's probe page, and parsed into `renderTextAsPath`'s `variationSettings` argument on ours — using the **same** parser the renderer uses on a real capture, so the oracle cannot drift from the shipped parse. One variable face at two axis locations is two different sets of outlines; a corpus that omits the axis sweeps a `wght` 700 run as though it were the face's default instance.

Two measurements shaped this, and the second was the surprise:

- **Most declared axes are inert.** Of the 13 text runs in the fixture corpus rendering under a non-normal axis, 9 resolve to Georgia — not a variable face — and stripping the axis moves nothing. This matches what the face oracle found when stretch and variation settings were added to its stack key: 17 new stacks, 0 mismatches.
- **The movers need no webfont.** The `.var-stack` runs in `20-deep-font-palette.html` declare `font-family: "Inter Variable", system-ui, sans-serif`. "Inter Variable" is not installed, so the stack falls through to `system-ui` — macOS SF, which *is* variable and *does* respond. Stripping the axes moves Chrome's painted width by **76.27px** and **3.56px**.

That second point matters because the expectation going in was that only a webfont could move an axis, which would have made this work depend on webfont support the corpus does not exercise. It does not.

A third obstacle was not anticipated at all: **every one of the 11 axis-declaring text nodes in `external/html-test` contains a space**, so the whitespace filter dropped all of them. Recording the axis alone would have widened the schema and changed nothing — the corpus measured 0 axis-bearing runs. Axis-bearing nodes therefore have their text **split on whitespace** rather than dropped, which preserves the whitespace-free invariant exactly (each word contains no space) and rests on the same word-boundary argument the filter itself does. The split is applied *only* to axis-bearing nodes deliberately: splitting every node grows the corpus 10.95× (2,385 → 26,121 runs), which is a separate question about sweep breadth. The corpus is 2,417 runs, 32 of them axis-bearing.

**The mechanism is confirmed in the loop, not merely enabled.** Per the standing rule that a flag being on is not evidence a mechanism runs, the axis runs were scored twice — once with the axis plumbed through both sides and once with it stripped — and the answer was required to move. It moved on exactly the 12 `system-ui` runs and on none of the 20 Georgia ones, which is the correct partition. Chrome's reported face name is the direct evidence, and it encodes the applied coordinates as **hex 16.16 fixed point**:

| declared | Chrome's face | decoded |
| --- | --- | --- |
| *(none)* | `.SFNS-Regular` | default instance |
| `"opsz" 32, "wdth" 120, "wght" 700` | `.SFNS-Regular_wdth780000_opsz200000_GRAD_wght2BC0000` | wdth 120, opsz 32, wght 700 |
| `"opsz" 14, "wdth" 80, "wght" 300` | `.SFNS-Regular_wdth500000_opsz110000_GRAD_wght12C0000` | wdth 80, opsz **17**, wght 300 |

The last row is worth reading carefully: `opsz110000` is 0x110000/65536 = **17.0**, not decimal 11 — and 17 is not what the page asked for. The requested `opsz 14` was clamped up to the bottom of the face's `[17..28]` optical-size range. Skia does that clamp with `SkTPin<double>(position.coordinates[j].value, minDouble, maxDouble)` in `ctvariation_from_SkFontArguments` (`src/ports/SkTypeface_mac_ct.cpp:1147`, checkout `ebf5052`), independently of Blink's own clamp on the way in. Our positions track Chrome's to within **0.01px** on all four instanced runs, so the renderer resolves to the same clamped instance — a parity claim that was previously unmeasured rather than merely unverified.

## Instrument audit

Three defects were found and fixed in this tool **before any of its numbers were quoted**, which is the discipline doc 107 earned the hard way:

1. **Whitespace counting.** The first run reported 25 mismatches on 200 runs. The glyph-count delta was exactly the space count in 24 of them — the instrument disagreeing with itself. Resolved by excluding whitespace runs from the corpus.
2. **Only the first `<text>` element was read.** A run spanning two fonts emits one element per font, so a mixed-font run looked truncated: on `"FIXED → trapped"` our 5 positions were exactly Chrome's first 5, with the other 8 in the second element. Now every element is summed.
3. **The cluster blind spot was scored as a position disagreement**, inflating the interesting tier with cases it had not actually checked. Now its own tier.

Positive control: the tool reports the glyph counts hand-measured against Chrome for `fi` → 1 (Times ligature), `Á` → 1 (precomposed), `क्षि` (4 chars) → 2, `السلام` (6 chars) → 5. Negative control: earlier revisions did report mismatches, so it is not a no-op.

## Baseline (macOS)

Full derived corpus from `external/html-test`:

| | 2026-07-30 | 2026-08-04 |
| --- | ---: | ---: |
| runs | 2,385 | 2,417 |
| agree exact | 2,023 (84.8%) | 2,387 (98.8%) |
| agree count-only | 348 (14.6%) | 16 (0.7%) |
| agree clustered | 13 (0.5%) | 13 (0.5%) |
| MISMATCH count | 1 | 0 |
| MISMATCH unrendered | 0 | 1 |
| position deltas across count-only | median 1.20px · p90 2.82px · max 5.64px | median 0.88px · p90 2.57px · max 2.94px |

The 348 → 16 collapse is **not** the doing of the axis work in the column beside it; it is the per-script HarfBuzz shaping fixes (Telugu, Hangul, Devanagari, Hebrew, Arabic) that landed in between, which is exactly what this tool was built to grade. Measured as a controlled A/B on one machine at one commit: the 2,385-run corpus scores 2,355 exact / 16 count-only / 13 clustered / 1 unrendered, and adding the 32 axis-bearing runs moves only `agree-exact` (+32) with every other tier byte-identical. The remaining hard mismatch is an emoji run where Chrome produces 1 glyph and we produce 0.

Read the count-only tier first: those runs shape to **visibly different glyph positions** than Chrome, at the same magnitude as the nukta defect that motivated this tool, and every one of them is invisible to the face oracle.

## Covering the face oracle's variable-instance blind spot — measured

Doc 107 has always said that its name-blindness for variable faces is covered here, because one PostScript name spans a variable font's whole design space and only positions can tell two instances apart. That was an argument. Nothing in either corpus drove an axis Chrome honors: macOS Helvetica has no `wdth` axis, so Chrome's painted width for `sans-serif` is identical at every `font-stretch` 50–200% and unchanged across `"wght" 100` ↔ `"wght" 900`.

> **Correction (2026-08).** This paragraph used to extend that claim with "even on `system-ui`, whose SFNS file *is* variable." **That was wrong, and the way it was wrong is worth keeping.** macOS `system-ui` responds to both axes, and strongly:
>
> | `system-ui`, 26px | width | face |
> | --- | ---: | --- |
> | *(default)* | 192.17 | `.SFNS-Regular` |
> | `"wght" 100` | 181.00 | `.SFNS-Regular_wdth_opsz1A0000_GRAD_wght640000` |
> | `"wght" 900` | 223.02 | `.SFNS-Regular_wdth_opsz1A0000_GRAD_wght3840000` |
> | `font-stretch: 50%` | 133.52 | `.SFNS-Regular_wdth320000_opsz1A0000_GRAD_wght` |
> | `font-stretch: 200%` | 272.70 | `.SFNS-Regular_wdth960000_opsz1A0000_GRAD_wght` |
>
> The original probe almost certainly wrote `font-variation-settings:"wght" 100` straight into an inline `style` attribute. The `"` **terminates the attribute**, so the property never reaches the page — the element renders at the default instance and the probe reports "no response" for every axis value. The same bug was reproduced while writing this section: an unescaped probe said all ten `system-ui` axis cases were inert, and escaping the quotes to `&quot;` moved every one of them. A negative result from a probe is only as good as the proof that the input arrived.
>
> `sans-serif` → Helvetica remains genuinely inert, which is what made the wrong half plausible.

Decoding those names confirms two mechanisms the corpus now depends on. `wght640000` is 0x640000/65536 = **100.0** and `wght3840000` = **900.0**, so both extremes were applied rather than clamped together. `opsz1A0000` = **26.0** — exactly the CSS font size, which is Blink setting `opsz` from the specified size under the default `font-optical-sizing: auto`. And `font-stretch: 200%` lands at `wdth960000` = **150.0**, not 200: the request is clamped to the top of SF's `wdth` range by the same `SkTPin` in `ctvariation_from_SkFontArguments` (`src/ports/SkTypeface_mac_ct.cpp:1147`, checkout `ebf5052`) that clamps `opsz` up from 14 to 17 above.

`tests/fixtures/variable-axis/variable-axis.html` (a subset of variable Open Sans as a webfont, `fvar`/`gvar` intact) supplies the missing case, and `tools/variable-axis-oracle-pair.ts` runs **this tool's own `compareShaping`** and the face oracle's own `identifyFace` over every pair of instances. The full table is in [doc 107](107-font-conformance-oracle.md#the-variable-axis-blind-spot-measured-rather-than-asserted); the part that concerns this tool:

| our instance vs Chrome's | `compareShaping` | max position delta |
| --- | --- | ---: |
| same | `agree-exact` | 0.01 px |
| `wght 800` vs default | `agree-count` | 39.56 px |
| `wdth 75` vs default | `agree-count` | 97.83 px |
| `wdth 75` vs `wght 800` | `agree-count` | 137.39 px |

Two things worth carrying away. The discrimination is not marginal — 0.01 px against 39–137 px, where this tool's whole macOS baseline tops out at 5.64 px — so it is not a threshold-tuning result. And it lands in `agree-count`, the tier this document already argues is the interesting one: same glyph count, positions differ. A wrong variable instance is a *geometry* defect with no shaping decision behind it, which is precisely the shape `agree-count` exists to name.

The corollary for `agree-count` reading generally: a row in that tier can mean a mark attached 3 px wrong **or** the right glyphs painted from the wrong point in a design space. Both are real; they want different fixes.

Pinned by `tests/variable-axis-oracle-pair.e2e.test.ts`.

## Known gaps

- **Glyph IDs are not compared** — neither side exposes them. A run could agree on count and position while painting the wrong glyph. Closing this needs a signal Chrome does not currently offer.
- **Advances are compared only via positions.** A per-glyph advance is inferred from adjacent positions, so the final glyph's advance is unchecked.
- **macOS only**, like the face oracle. Shaping is HarfBuzz on every platform so the results should travel better than face selection does, but that is an expectation, not a measurement.
- Corpus is `external/html-test` only; the unicode fixture set is not yet swept.
- **`RunSpec` carries `font-stretch`, but the committed corpus predates it.** The schema, extractor, probe page and our-side call all model the property now (optional on read; absent = `"100%"`, which is what every pre-existing run computed to), and the renderer honors it — the `wdth` axis on the macOS `system-ui` face and variable webfonts, cut selection on declared families. What remains is data: `tools/shaping-conformance-runs.json` was extracted before the field existed, so no committed run carries a non-normal stretch. The next `--extract-runs` picks it up automatically; until then the stretch mechanism is pinned by `src/render/font-stretch-wdth.test.ts` and the `text-font-stretch-underline` feature fixture rather than by this sweep.
- **Webfont runs still cannot be swept.** `chromeShaping` synthesizes its probe page with `setContent` and no `@font-face`, and our side has no webfont registered because there is no capture step, so a run in a custom family resolves to a system face on both sides. `tests/fixtures/variable-axis/variable-axis.html` is therefore driven by `tools/variable-axis-oracle-pair.ts` rather than swept here. Closing it means carrying the `@font-face` into the probe page *and* registering the same buffer on our side — the measurement above is what deprioritized it: the axis movers actually present in the fixture corpus are system faces, not webfonts.
- **Only axis-bearing text nodes are split on whitespace.** Every other node must be whitespace-free as a whole or it is dropped, so multi-word runs are unswept. Splitting universally would grow the corpus 10.95× (2,385 → 26,121); whether that breadth is worth its runtime is unanswered.

## Related

- [107 — font conformance oracle](107-font-conformance-oracle.md) — the face half
- [106 — Blink font parity inventory](106-blink-font-parity-inventory.md) — what Blink runs, per platform
- [font-resolution-diagram.md](font-resolution-diagram.md) — the resolution flow both oracles measure
