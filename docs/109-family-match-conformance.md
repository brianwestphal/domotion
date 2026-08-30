---
id: "requirements/family-match-conformance"
title: "109 — Declared-family match conformance oracle (macOS)"
kind: "evidence"
status: "current"
owners: ["platform-release"]
platforms: ["macos","linux","windows"]
tickets: []
code: ["src/render/text-to-path.test.ts","tools/family-match-conformance.ts"]
aliases: ["docs/109-family-match-conformance.md","doc-109"]
---

# 109 — Declared-family match conformance oracle (macOS)

`tools/family-match-conformance.ts` · `npm run fonts:family-match`

## What it measures, and why it is a separate oracle

Three decisions sit between a CSS declaration and a painted glyph, and each has
its own oracle because each can be wrong on its own:

| Question | Oracle |
| --- | --- |
| Given `font-family: X; font-weight: N`, which **cut of X** does Chrome open? | **this doc** |
| Given a codepoint no declared family covers, which **fallback face** does Chrome reach? | doc 107 |
| Given a face and a run, which **glyphs, at which offsets**? | doc 108 |

The first question was previously unmeasured. Its failure mode is a family's
weight ladder collapsing onto one or two faces — which is invisible to a fixture
corpus, because fixtures overwhelmingly declare weight 400, and at 400 nearly
every candidate rule agrees. The defect only appears off the default rung.

## Method

Both axes are **derived, not authored**, so the sweep cannot decay into a
curated list of cases someone already thought of:

- **Families** — every family name reported by the font files actually present
  under `/System/Library/Fonts` and `/Library/Fonts`. Families with a single
  face are dropped (they cannot discriminate between any two rules), as are
  dot-prefixed system families (CoreText refuses them by name from a client
  process and Chrome will not match them from CSS, so every row would be a
  disagreement that is really "neither side can address this").
- **Weights** — the full CSS ladder, 100…900.

Our side is the macOS helper's `familyMatch` query. Chrome's side is CDP
`CSS.getPlatformFontsForNode`, read by **`postScriptName`** — `familyName`
cannot distinguish the cuts, which is the entire question — and selected by
**maximum `glyphCount`**, because the returned array is not ordered by coverage.

**Rows where Chrome leaves the family entirely are not scored.** Families with
no Latin coverage (Arial Hebrew, Al Bayan, Apple Braille) send Chrome to Times
for the probe text; that is a coverage artifact of the probe, not a
style-matcher decision. On this machine that is 423 of 7,740 rows.

## Result at the time of writing

    families 860   cases 7,740   scored 7,317   skipped 423
    agreement 7,317 / 7,317 (100.00%)   families with a miss: 0

(An earlier revision of the port scored 7,308 / 7,317 — see "The residual"
below for what the nine misses were and why they disappeared.)

Two calibration notes, both of which cost real time to learn:

1. **Score the shipped port, not a restatement of it.** Two JavaScript
   re-implementations of the same rule scored 98.65% and 99.75% against Chrome
   — both *worse* than the Swift port at 99.88% — because both omitted the
   trait-precedence loop and so picked condensed faces (`Futura-CondensedExtraBold`,
   `HelveticaNeue-CondensedBlack`) where Chrome takes the plain Bold. A
   restatement measures the restatement.
2. **A number computed over all families is not a number over addressable
   ones.** Before the no-coverage rows were excluded, the same run reported 441
   "misses" that were almost entirely Chrome declining to use a Hebrew or
   Arabic family for Latin text.

## The residual that was, and the mechanism that resolved it

An earlier revision of the port transcribed the **local `external/chromium`
checkout** (rev `7d859f27`, 2026-06-27) and left nine canonical-weight
disagreements plus two whole intermediate-weight bands (below). Every one of
them had a single cause, identified by reading `font_matcher_mac.mm` **at the
tag of the Chrome build Playwright actually ships** — `refs/tags/147.0.7727.15`
(playwright-core `browsers.json`, chromium 147.0.7727.15) — instead of at the
checkout's revision:

**The checkout is AHEAD of the shipping build.** The checkout carries a
directional `BetterWeightMatch` (its `:100-139`: below CSS 400 prefer any
candidate at or below the desired weight, above 500 any at or above) and
deliberately drops the bold trait from `BetterChoiceCT`'s mask list (its
`:225-229`). That rewrite landed upstream **after** the 147 branch point. The
shipping `BetterChoiceCT` (`:172-220` at the tag) is instead:

1. a trait-precedence loop over `{condensed, expanded, italic, bold}` — bold
   **included** — with one exception on the bold mask: an exact-weight
   candidate beats an inexact chosen regardless of the trait bit (`:186-196`,
   the HiraginoSans-W5 case);
2. then **nearest CSS weight** by absolute delta, with a tie broken toward the
   candidate **further from 500** (`:209-219`).

Candidate weights are AppKit's (`AppKitToCSSFontWeight`: `w<7 → (w−1)·100`,
else `(w−2)·100` — so Helvetica-Light, AppKit 3, is CSS **200**, not 300), and
candidate traits are AppKit's `font_info[3]` masked to the four important bits
(`:245-255`). The desired bold trait derives from the weight
(`ComputeDesiredTraits` `:134-151`: bold iff ≥ 600). The dispatch is
unchanged between checkout and tag: `FontFamilyStyleMatchingCTMigration` has no
`status:` in `runtime_enabled_features.json5` at the tag, so
`MatchFontFamily` → `BestStyleMatchForFamilyNS` (`:548-552`) is the live path.

That one comparator explains every previously-recorded anomaly at once:

- **`Helvetica` 305-399 → plain `Helvetica`**: Light is CSS 200, so 400 is
  strictly nearer everywhere above 300; at exactly 300 the 100-vs-100 tie
  breaks toward Light (further from 500).
- **`Helvetica` 501-599 → plain `Helvetica`**: Bold's bold trait is unwanted
  below 600 and loses in the trait loop before weight is ever compared.
- **`Avenir Next` @300 → Regular**: plain nearest weight among {100, 400,
  500}.
- **`Avenir` @600 → Heavy over the nearer Medium**: at ≥ 600 the bold trait is
  *desired*, so non-bold faces lose on traits — the "directional heavy end"
  was never a weight rule at all.
- **`PingFang SC` @300 → Thin**: AppKit reports Thin and Light both as weight
  3 → CSS 200; the three-way delta-100 tie (Thin, Light, Regular) breaks
  toward 200 (further from 500), and enumeration order keeps Thin.

The helper now transcribes the tag's comparator, and the oracle scores
**7,317 / 7,317 (100.00%)** — including the previously un-diagnosed `Chivo`
and `Splendid 66` rows, which fell out of the same mechanism.

### The intermediate weights are now measured, and they agree

The canonical sweep's weight axis is the nine CSS values, so the bands between
them were re-measured separately over CDP: 20 families × 41 weights (100-900
in steps of 25, plus the 305/349/399/501/599 band edges), 760 scored cases —
**760/760 agreement** for the 147 transcription, against 567/760 for the
directional checkout port it replaced. The former drift table on `Helvetica`
(`305-399` and `501-599` painting Light/Bold where Chrome paints plain
Helvetica) now reads identically on both sides.

The rungs are pinned as tests (`src/render/text-to-path.test.ts`, "matches the
shipping Chrome at the intermediate weights"). **When the pinned Playwright
Chromium moves to a build containing the upstream directional rewrite, that
test and the helper's `betterChoiceCT` must be re-transcribed together** — the
checkout already shows what the successor algorithm looks like.

## Scope

macOS only. Blink runs different code for this step on each platform, and a
number from one platform says nothing about another. The sibling oracles now
exist: doc 110 (Linux — the fontconfig `matchFamilyName` transcription,
`npm run fonts:family-match:linux`) and doc 111 (Windows — the DirectWrite
`GetFirstMatchingFont` call plus Blink's family-name suffix layer,
`npm run fonts:family-match:win32`), each with its own committed,
environment-fingerprinted baseline.
