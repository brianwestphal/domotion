# Generic-family semantic ownership investigation

## Verdict

Domotion loses a source-owned Blink fact after resolving a CSS family stack to
one concrete renderer key. Blink stores the family-list entries and the
descriptor-wide `GenericFamily` independently. The current Windows adapter
reconstructs that generic as `primaryKey === "courier" ? "monospace" :
"standard"`, so a concrete key can silently stand in for a different CSS
semantic.

This investigation confirms the information loss and adds a fingerprinted
logical audit. It does **not** change production routing and does not introduce
a screenshot, pixel tolerance, or host-font snapshot.

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

HarfBuzz receives the already-selected `FontData` and shapes it; it does not
reconstruct the CSS generic. Skia/DirectWrite receive concrete family/style
inputs after Blink's hardcoded stage. The missing semantic is therefore owned
by Domotion's Blink-routing adapter and its caches, not by either downstream
library.

## Discriminator

`tools/generic-family-semantics-audit.ts` crosses Arabic and Hebrew with ten
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
| `Courier, system-ui` | none (`kNoFamily`) | non-monospace |
| `monospace, math` | monospace | monospace |
| `"monospace", Courier` | none (`kNoFamily`) | non-monospace |

For each row it records the computed stack, source-derived generic, exact
source candidate order, current production primary key, key-derived candidate
order, and exactly one CDP-painted face/glyph. It clears Domotion's resolver
caches once, runs all 20 rows forward, then repeats them in reverse without a
second clear. A pass requires both orders to be identical and requires the
known false-positive and
false-negative controls to remain active:

- named `Courier` resolves to the `courier` key, which the current seam wrongly
  calls monospace;
- `Arial, monospace` resolves the first available named face to a non-`courier`
  key, which the current seam wrongly calls non-monospace even though Blink's
  descriptor remains monospace.

The CDP face is corroboration that the browser row painted one glyph. It is not
treated as a portable snapshot or as proof that macOS/Linux exercised the
Windows implementation. Indeed, a host may paint the same Courier face for
both controls while the source-level Windows candidate order still differs.

The local macOS arm64 run against Chromium `147.0.7727.15` is
`confirmed-information-loss`: 40/40 rows pass their logical evidence contract,
all eight semantic controls pass, and forward/reverse signatures are identical.
The workflow runs the same source-owned audit on macOS, Linux, and Windows and
retains each JSON report with the browser/source/environment fingerprint.

```sh
npm run fonts:generic-family-semantics -- \
  --json tests/output/generic-family-semantics.json
```

## Follow-ups

- **DM-2515 — carry Blink `FontDescription` generic-family identity through
  fallback routing and caches.** This production bug owns replacing the
  concrete-key heuristic, including every affected cache key and A/B order
  mutation.
- **DM-2516 — promote generic-family semantic ownership to an exact
  three-platform regression gate.** After the production correction, this task
  owns changing the investigation verdict into a strict source/production
  agreement gate while preserving the logical-only evidence boundary.
- **DM-2517 — propagate Blink generic identity into Skia last-resort routing and
  cache identity.** This separate terminal-path bug owns the generic-sensitive
  initial-family mapping after ordinary family/system fallback is exhausted;
  its activation and caches differ from the Windows hardcoded stage.
- **DM-2518 — harden structured family-stack capture across generated and
  control text.** This lower-priority task owns the pseudo/first-letter/
  line-clamp/control paths that bypass the host's `-webkit-standard` rewrite and
  the remaining non-CSS-aware family split.

Until the production bug lands, `text.family-fallback` remains partial. The
audit exits successfully only for a complete, reproducible confirmation of the
known information loss; source drift, missing rows, order-sensitive evidence,
or an incomplete painted-face record fail independently.
