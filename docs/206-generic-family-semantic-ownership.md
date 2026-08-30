---
id: "requirements/generic-family-semantic-ownership"
title: "Exact generic-family semantic ownership gate"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2515","DM-2516","DM-2517","DM-2518"]
code: ["src/render/skia-last-resort-routing.test.ts","tools/generic-family-semantics-audit.ts"]
aliases: ["docs/206-generic-family-semantic-ownership.md","doc-206"]
---

# Exact generic-family semantic ownership gate

## Verdict

Blink stores family-list entries and descriptor-wide `GenericFamily`
independently. Domotion historically lost that fact after resolving the stack
to one renderer key and reconstructed it from `primaryKey === "courier"`.
DM-2515 now derives the semantic from the unresolved stack and carries it as
request state through Windows routing and system-fallback cache identity.
DM-2517 carries the same descriptor state into the generic-sensitive initial
step of Blink's common-Skia last-resort walk after ordinary family/settings
selection is exhausted. DM-2518 now preserves that state at the earlier capture
boundary with one decoded, typed family-list record shared by ordinary,
generated, line-clamp, and control text. DM-2516 promotes the complete logical
contract to a strict macOS/Linux/Windows regression gate.

The fingerprinted logical audit retains the historical key heuristic as a
hostile mutation while grading the current production adapter directly. It
introduces no screenshot, pixel tolerance, or host-font snapshot.

## Pinned source ownership

The audit is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`, HarfBuzz
`4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium's Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

Blink owns the semantic decision before shaping:

1. `FontFamily` keeps `kFamilyName` and `kGenericFamily` as distinct types
   (`platform/fonts/font_family.{h,cc}`). A named `Courier` or `Courier New` is
   `kNoFamily`; neither is `kStandardFamily`.
2. `StyleBuilderConverter::ConvertFontFamily` walks the authored family list in
   reverse and sets `FontDescription::GenericFamily` once. The rightmost
   enum-bearing legacy generic therefore wins; quoted generic-looking names do
   not contribute an enum (`core/css/resolver/style_builder_converter.cc`).
3. `FontSelector::FamilyNameFromSettings` resolves a generic to a concrete
   browser preference without discarding the stored enum. The complete
   `FontDescription` then follows the run through `FontFallbackIterator`.
4. On Windows, `FontCache` passes that enum to
   `GetFallbackFamilyNameFromHardcodedChoices`. Only `kMonospaceFamily` changes
   the Arabic/Hebrew first candidate: Courier New instead of the ordinary
   Tahoma/David branch (`platform/fonts/win/font_cache_skia_win.cc` and
   `font_fallback_win.cc`).
5. In the common Skia terminal, `GetFallbackFontFamily(description)` maps the
   five legacy generics to concrete initial family questions (`sans-serif`,
   `serif`, `monospace`, `cursive`, `fantasy`) before the fixed Sans/Arial/
   unnamed tail. `kNoFamily`, `kStandardFamily`, and `kWebkitBodyFamily` map to
   an empty initial family (`alternate_font_family.h:107-123` and
   `skia/font_cache_skia.cc:146-259`). `system-ui` and `math` do not occupy the
   legacy enum: they preserve a preceding legacy generic or leave `kNoFamily`.

HarfBuzz receives the already-selected `FontData` and shapes it; it does not
reconstruct the CSS generic. Skia/DirectWrite receive concrete family/style
inputs after Blink's hardcoded stage. The missing semantic is therefore owned
by Domotion's Blink-routing adapter and its caches, not by either downstream
library.

## Discriminator

`tools/generic-family-semantics-audit.ts` crosses Arabic and Hebrew with 13
stacks:

| CSS family stack | Blink generic | Windows hardcoded branch |
|---|---|---|
| `Courier` | none (`kNoFamily`) | non-monospace |
| `monospace` | monospace | monospace |
| `Courier, monospace` | monospace | monospace |
| `Arial, monospace` | monospace | monospace |
| `Courier, serif` | serif | non-monospace |
| `monospace, serif` | serif | non-monospace |
| `serif, monospace` | monospace | monospace |
| `system-ui` | none (`kNoFamily`) | non-monospace |
| `math` | none (`kNoFamily`) | non-monospace |
| `Courier, system-ui` | none (`kNoFamily`) | non-monospace |
| `monospace, math` | monospace | monospace |
| `monospace, system-ui, math` | monospace | monospace |
| `"monospace", Courier` | none (`kNoFamily`) | non-monospace |

For each row it records the computed stack; independent source and production
generic/fallback-mode decisions; exact platform candidate order; raw terminal
family-question order; separately normalized terminal-owner order and
activation; cache identity; current production primary key; the hostile
key-derived route; and exactly one CDP-painted face/glyph. The production
`skiaLastResortFamilyQuestionOrder()` seam is compared with the independently
fingerprinted Chromium source transcription before either sequence is
normalized to Domotion's logical owners. It clears Domotion's resolver caches
once, runs all 26 rows forward, then repeats them in reverse without a second
clear. A pass requires both orders to be identical and requires the known
false-positive and false-negative controls to remain active:

- named `Courier` resolves to the `courier` key, which the historical seam
  wrongly called monospace;
- `Arial, monospace` resolves the first available named face to a non-`courier`
  key, which the historical seam wrongly called non-monospace even though Blink's
  descriptor remains monospace.

The CDP face is corroboration that the browser row painted one glyph. It is not
treated as a portable snapshot or as proof that macOS/Linux exercised the
Windows implementation. Indeed, a host may paint the same Courier face for
both controls while the source-level Windows candidate order still differs.

The local macOS arm64 run against Chromium `147.0.7727.15` is `source-exact`:
52/52 rows pass their source/production logical evidence contract,
all 17 semantic/evidence controls pass, and forward/reverse signatures are
identical.
The workflow runs the same source-owned audit on macOS, Linux, and Windows and
retains each JSON report with the browser/source/environment fingerprint.

```sh
npm run fonts:generic-family-semantics -- \
  --json tests/output/generic-family-semantics.json
```

The common-Skia terminal has an additional exact logical discriminator in
`src/render/skia-last-resort-routing.test.ts`. Its repository-owned helper
cassette forces the named Courier stand-in to reject, makes unnamed and serif
terminal questions converge on one fixture face, and makes monospace select a
different fixture face. Named Courier, monospace, serif, system-ui, math, and
`monospace, system-ui, math` then run in both cache orders. The terminal memo
must retain three source decisions (empty/monospace/serif), while the ordinary
face/style cache must share the one physical serif face after selection. The
test also applies the exact description-blind terminal mutation: named and the
two non-occupying controls remain unchanged, while monospace and serif must
move ahead of the platform tail. A shaped U+E000 activation then forces the
first/serif fixtures through `.notdef`: named Courier, serif, system-ui, and
math return the first candidate's `.notdef`, while the monospace terminal's
repository-owned all-scalar fixture covers it at the last-resort stage, in both
cache orders. This is exact family-exhaustion logic—no screenshot, tolerance,
or host-font answer table.

## Shipped work and remaining boundary

- **DM-2515 — shipped:** the unresolved stack now creates one request-scoped
  Blink generic semantic before fallback matching. Windows nomination consumes
  that carrier rather than a face key; Linux/Windows system-fallback memo
  identity includes the normalized declared head and node kind. Forward/reverse
  no-reset mutations cover named/quoted Courier, rightmost generics, and
  system-ui/math non-occupying controls.
- **DM-2516 — shipped:** the schema-v2 audit now fails unless source enum,
  platform candidate order, raw terminal questions, normalized terminal owners,
  production routing, semantic cache identity, and forward/reverse no-reset
  behavior agree on macOS/Linux/Windows. Source-file fingerprints and hostile
  mutations make each ownership assertion non-vacuous; the one painted glyph is
  corroboration only.
- **DM-2517 — shipped:** the common-Skia terminal now consumes the descriptor
  carrier for its source-selected initial family. Linux's terminal-result memo
  keys that initial family, while a successful by-name cut and the final
  concrete face/style cache remain generic-agnostic. The shaped-cluster
  last-resort iterator uses the same carrier and source order.
- **DM-2518 — shipped:** one browser-safe CSS parser and structured family-list
  record now preserve decoded names, literal/generic node identity, rightmost
  legacy generic semantics, and kStandard ownership across ordinary,
  generated, first-letter/first-line, line-clamp, placeholder, listbox, and file
  text. Logical raw-string/type mutations and a live cross-owner capture matrix
  replace comma splitting; no visual tolerance changed. See doc 213.

`text.family-fallback` remains partial only for the separately owned
helper-absent boundary. The audit accepts only `source-exact`; source drift, any
source/production routing mismatch, missing rows, order-sensitive evidence, or
incomplete painted-face records fail.
