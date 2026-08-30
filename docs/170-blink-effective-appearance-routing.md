---
id: "requirements/blink-effective-appearance-routing"
title: "Blink EffectiveAppearance ownership routing"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2453","DM-2455"]
code: [".github/workflows/visual-tests.yml","src/capture/effective-appearance-cdp.ts","src/capture/effective-appearance.test.ts","src/capture/effective-appearance.ts","tests/effective-appearance.e2e.test.ts"]
aliases: ["docs/170-blink-effective-appearance-routing.md","doc-170"]
---

# Blink EffectiveAppearance ownership routing

DM-2453 replaces the old host-tag/CSSOM declaration scan with Blink's actual
`ComputedStyle::EffectiveAppearance()` decision. The distinction matters before
pixels are captured: a control whose computed `appearance` is `auto` may be
entirely platform-themed, entirely CSS-owned, or (for `menulist-button`) split
between an author-owned host and a native decoration.

The implementation is deliberately platform-neutral. macOS, Windows, and
Linux use the same classifier; only the Chromium surface selected by that
classifier remains platform paint.

## Pinned source contract

All source references below are pinned at Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `third_party/blink/renderer/core/layout/layout_theme.cc:83-131` defines
  `AutoAppearanceFor`: button, meter, progress, textarea, select menu/listbox,
  and each input type acquire their internal appearance before author-style
  adjustment.
- `layout_theme.cc:194-203` maps a styled menulist to
  `kMenulistButton` and every other styled appearance in the eligible switch to
  `kNone`.
- `layout_theme.cc:485-506` is the complete activation table:

  | Appearance before adjustment | Author background | Author border | Resolved box-shadow |
  |---|---:|---:|---:|
  | button / push-button / square-button | CSS-owned | CSS-owned | no change |
  | progress-bar / meter | CSS-owned | CSS-owned | no change |
  | menulist | menulist-button | menulist-button | menulist-button |
  | searchfield / textarea / textfield | CSS-owned | CSS-owned | CSS-owned |
  | checkbox / radio / slider | no change | no change | no change |

  Font, color, padding, accent-color, and text-shadow are absent from this
  switch and therefore cannot deactivate a native button.
- `style_cascade.cc:1174-1203` resolves substitutions and `revert`,
  `revert-layer`, and `revert-rule` before calling `CollectFlags`.
  `cascade_resolver.h:119-130` retains a property flag only when the final
  origin is author; `style_resolver_state.cc:547-560` turns those flags into
  `HasAuthorBackground` / `HasAuthorBorder`.
- `theme_painter.cc:121-200` identifies complete host-theme paint versus the
  CSS/decorations boundary. `menulist-button` and listbox return to normal CSS
  painting rather than owning a complete themed host.

## Captured facts

`src/capture/effective-appearance-cdp.ts` runs before the synchronous document
walk. For every control host it asks Chromium's DOM/CSS agents for:

1. the rules Chromium actually matched;
2. the computed writing mode and direction, so logical border properties map
   to the same physical longhand as Blink's surrogate-property resolution; and
3. active animation/transition styles, whose higher cascade origins can win a
   flagged longhand without setting an author flag.

The pre-pass attaches a collision-resistant, non-selector expando to the live
host. It never adds an attribute and therefore cannot activate author CSS.
`src/capture/effective-appearance.ts` consumes the protocol order already
resolved for selectors, conditions, scopes, tree scopes, specificity, and
source order, then applies property-specific important/origin/layer ordering.
Shorthands are expanded, named layers remain shared across stylesheets,
important layer order is inverted, and CSS rollback keywords are followed
before the winning origin is classified.

This is why resolved-color comparison is insufficient: `background: unset`
at author origin sets Blink's flag even when it computes to the UA-looking
value, while `background: revert` does not.

## Cross-origin and failure boundary

Page CSSOM is never consulted. `document.styleSheets[i].cssRules` may throw for
a cross-origin stylesheet, while Chromium's inspector agent still has the
matched rule and its origin; that normal case remains exact.

If Chromium returns a partial matched-rule record, a control cannot be
correlated, or a winning relevant declaration contains a substitution whose
post-substitution rollback origin is not exposed, the fact is explicitly
`available:false`. The capture emits an
`effective-appearance-cascade` warning and retains the conservative complete
Chromium host raster. It never silently guesses author ownership and never
falls back to the retired CSSOM selector/declaration scan.

## Paint ownership

The capture records the adjusted value as
`CapturedStyles.effectiveAppearance`.

- Complete native appearances receive `nativeControlRaster` and use doc 167's
  same-source-frame, fail-closed materialization.
- `none`, `base`, `base-select`, listbox, and adjusted
  `menulist-button` do not receive a whole-host raster; their host box remains
  structural CSS paint.
- `menulist-button` contains a native arrow decoration. DM-2455 now captures
  that ThemePainter layer—and temporal/search/spin closed-shadow parts—as a
  narrow fail-closed Chromium overlay while preserving the structural host and
  text; see [doc 171](171-closed-shadow-control-decorations.md).

## Verification

`src/capture/effective-appearance.test.ts` protects auto mappings, every
activation group, negative font/color/padding/text-shadow declarations,
checkbox/radio/range invariance, explicit none/base/base-select, shorthand and
inline declarations, UA/user/author origins, rollback keywords, normal and
important layers, logical borders, active animation/transition origins, and
partial/substitution failure.

`tests/effective-appearance.e2e.test.ts` runs real Chromium controls for:

- default, disabled, rest, focus, hover, and active state;
- font-only, color/padding/text-shadow-only, background, border, and shadow;
- button/input-button, progress, meter, menulist, search, textfield, textarea,
  checkbox, radio, and range;
- `none`, experimental `base`, `base-select`, accent auto/explicit;
- light, dark, forced colors, CSS zoom, DPR 1/2, horizontal/vertical/sideways
  writing, and LTR/RTL; and
- the explicit unavailable-fact warning plus conservative raster route.

The focused spec is included in the native-control step of
`.github/workflows/visual-tests.yml` on macOS, Linux, and Windows. Local gates:

```sh
npx vitest run src/capture/effective-appearance.test.ts
npm run build:capture-script
npx vitest run --config vitest.e2e.config.ts tests/effective-appearance.e2e.test.ts
```
