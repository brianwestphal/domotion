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
    agreement 7,308 / 7,317 (99.88%)   families with a miss: 4

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

## The residual, and what it means

The nine remaining disagreements fall in four families. One of them is a
**genuine divergence between the local Chromium checkout and the Chrome that
Playwright ships**, established by construction rather than inferred:

**`Avenir Next` (and `Avenir Next Condensed`) at CSS 300.** The family offers
UltraLight (100) and Regular (400) with nothing between. Chrome paints
**Regular**; the checkout's algorithm cannot produce that answer under either
weight source. `BetterWeightMatch` (`platform/fonts/mac/font_matcher_mac.mm`,
`external/chromium` rev `7d859f27`) takes the `desired_weight < lower_threshold`
branch at 300 and prefers *any* candidate at or below the desired weight over
any candidate above it, so UltraLight wins whether its weight is read from the
CoreText descriptor (100) or from AppKit (2 → 100). The same holds for the
AppKit-space sibling `BetterChoice`, whose thresholds are 5/6 rather than
400/500. Measured across all 860 families, the shipping behavior at the light
end is **nearest-weight**, not the directional search — while at the heavy end
it *is* directional (`Avenir` at 600 takes Heavy over the nearer Medium). No
single rule in the checkout expresses that asymmetry.

This is the drift the project documents as expected: the checkout is refreshed
periodically and is not pinned to Playwright's Chrome. It is recorded here
rather than "fixed", because changing the port to match the shipping build
would mean deliberately diverging from the transcribed source — a policy call,
not a bug fix. The other three families (`Chivo` at 600/700, `Splendid 66`
below 600) are un-diagnosed.

## Scope

macOS only. Blink runs different code for this step on each platform — Linux
and Windows would each need their own oracle, and a number from one platform
says nothing about another.
