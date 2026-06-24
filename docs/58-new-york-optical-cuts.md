# 58 — macOS New York optical-size cuts (DM-1108)

Status: implemented (macOS-calibrated; gated on the optional New York font package being installed).

## Summary

macOS ships the **New York** serif (Apple's companion to San Francisco) in optical-size *cuts*: `New York Small`, `New York Medium`, `New York Large`, `New York Extra Large`. Domotion renders an explicitly-named cut from the same face Chrome paints it with.

This is the New York analogue of the SF Pro Text optical-cut work (DM-1103, `docs/03-font-family-chain.md`), but the underlying font packaging is **fundamentally different**, so the fix is different too.

## Why this is NOT the SF Pro `OPTICAL_CUT_OPSZ` case

| | SF Pro (DM-1103) | New York (DM-1108) |
|---|---|---|
| Packaging | **one** variable file `SFNS.ttf` with an `opsz` axis (17–96) | **separate static OTFs** per cut, no `opsz` axis |
| How CoreText exposes a cut | a named face (`SFProText-Regular`) that is a fixed-opsz *instance* of the one variable font | a distinct installed font file with its own family name (`New York Small`, …) |
| What fontkit sees | only the variable font's default master (opsz 28) → wrong design unless we pin `opsz` | the dedicated cut OTF directly → already the correct design |
| Fix | pin `opsz` via `OPTICAL_CUT_OPSZ` + `opticalCutOpszFor` | route the colliding name to the right OTF; **no opsz pinning** |

Because each New York cut is a complete static font, `opsz` pinning is meaningless for it — there is no axis to pin. fontkit loads `NewYorkSmall-Regular.otf` etc. and gets the correct optical design with no further work.

## The one real defect: the `New York Medium` name collision

Three of the four cut names are unambiguous, so CoreText's family query already returns the right OTF and our resolver matched Chrome with no change:

- `New York Small` → `NewYorkSmall-Regular.otf` ✓
- `New York Large` → `NewYorkLarge-Regular.otf` ✓
- `New York Extra Large` → `NewYorkExtraLarge-Regular.otf` ✓

`New York Medium` is special: `Medium` is **also a weight name**. The variable `NewYork.ttf` exposes a `Medium`-*weight* named instance (PostScript `NewYork-Medium`), and CoreText's family query for `"New York Medium"` returns **that heavier weight** rather than the lighter `New York Medium` optical *cut* (`NewYorkMedium-Regular.otf`) that Chrome paints. Result before the fix: an explicit `font-family:"New York Medium"` run rendered visibly too bold.

`matchFamilyNameToKey` (`src/render/font-resolution.ts`) now resolves `"new york medium"` via the cut's unambiguous PostScript name `NewYorkMedium-Regular`, matching Chrome. When that OTF isn't installed, the lookup returns null and the name falls through to the variable font's `Medium` weight — which is also what Chrome paints in that case.

## Bare `New York` and `ui-serif`

- **`New York`** (no cut suffix) is the always-present system serif variable font `/System/Library/Fonts/NewYork.ttf`. Chrome paints it from there; we resolve it to `sysfb:NewYork-Regular` and leave it alone (its rendered design already matches Chrome in the probe).
- **`ui-serif`** does **not** resolve to New York on macOS — Chrome maps it to Apple Times (already handled: `matchFamilyNameToKey` routes `serif` / `ui-serif` / `times` → `times`, see `docs/03-font-family-chain.md`). The DM-1108 ticket's framing of New York as "the `ui-serif` generic" is imprecise; New York is only reached via an explicit `font-family` name.

## Install dependency

The cut OTFs live in `/Library/Fonts/` (`NewYork{Small,Medium,Large,ExtraLarge}-Regular.otf`) and are part of Apple's **optional** "New York" font download, not stock macOS. The variable `NewYork.ttf` is always present in `/System/Library/Fonts/`. The fix is therefore a no-op on a host without the package, and degrades to the variable font exactly as Chrome does there.

## Verification

- Chrome CDP `getPlatformFontsForNode` confirms Chrome paints each named cut from its dedicated cut face (incl. `New York Medium` → the optical cut, not the weight), and `ui-serif` → Times.
- A 2×-DPR side-by-side render of all four cuts + bare `New York` (ours vs Chrome) showed only `New York Medium` diverging (too bold) before the fix, and matching after.
- `tests/new-york-optical-cut.e2e.test.ts` (macOS + cut-package-gated) asserts the resolver routing: `New York Medium` → `sysfb:NewYorkMedium-Regular` (not `sysfb:NewYork-Medium`), the unambiguous cuts → their OTFs, and bare `New York` → the variable font.
