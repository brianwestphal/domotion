# Authoritative control-pseudo cascade capture

Domotion captures author paint for Chromium's legacy WebKit control pseudos
without reimplementing CSS cascade. The old page-side rule walker treated later
source order as the winner. That answer was observably wrong for specificity,
`!important`, origin ordering, cascade layers, `@scope`, inactive conditional
rules, adopted stylesheets, shadow tree scopes, and shorthand/longhand
competition.

## Blink ownership

The pinned Chromium revision is
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `StyleResolver::UAShadowPseudoCascading` in
  `third_party/blink/renderer/core/css/resolver/style_resolver.cc:679-710`
  identifies legacy custom pseudos such as `::-webkit-meter-bar` and permits
  their author rules to cross one UA-shadow boundary.
- The outer-scope collection at `style_resolver.cc:915-1025` collects rules in
  the owning `TreeScope`, sorts and transfers them at the author origin, and
  handles the legacy `-webkit-*` style-attribute ordering. This is why a
  document-only CSSOM walk cannot be authoritative for adopted or shadow-root
  sheets.
- `StyleCascade::CollectFromMatchResult` in
  `third_party/blink/renderer/core/css/resolver/style_cascade.cc` expands the
  matched declaration blocks into `CascadePriority` records before applying
  them. Specificity, importance, origin, layer order, and declaration order are
  already encoded in that result; Domotion must consume it, not approximate it.
- `PaintLayerScrollableArea::UpdateResizerStyle` in
  `third_party/blink/renderer/core/paint/paint_layer_scrollable_area.cc:2304-2334`
  is the exception to the UA-shadow-node model. It asks Blink for
  `kPseudoIdResizer` style and puts it on an anonymous
  `LayoutCustomScrollbarPart`; there is no resizer DOM node to inspect.

## Capture boundary

`src/capture/pseudo-style-cdp.ts` runs immediately before the serialized DOM
walk:

1. `DOM.getDocument({depth:-1,pierce:true})` exposes the closed UA-shadow nodes
   for range, progress, meter, color, number, and search controls, including
   same-origin frame documents and controls inside author shadow roots.
2. `CSS.getMatchedStylesForNode` classifies customization. Direct rules whose
   origin is only `user-agent` retain native renderer ownership; any direct
   non-UA origin transfers author-pseudo paint ownership.
3. `CSS.getComputedStyleForNode` supplies Blink's final longhands. Consequently
   media/supports/container conditions, scope limits, nesting, state, variables,
   `calc()`, shorthand expansion, and the whole cascade have already been
   resolved by Chromium.
4. Each originating host receives a random, configurable JavaScript expando.
   It is not an HTML attribute and therefore cannot affect selector matching.
   The page walker uses the expando to look up immutable pseudo facts, then the
   Node pass deletes every expando and releases the CDP object group.
5. Resizable hosts are discovered without DOM mutation. Their final
   `::-webkit-resizer` style comes from Chromium's native pseudo
   `getComputedStyle` surface, while `CSS.getMatchedStylesForNode(host)` supplies
   the pseudo-rule origin metadata that distinguishes custom paint from the
   platform resizer.

There is intentionally no stylesheet-order fallback. A missing DevTools
surface fails capture rather than silently restoring a cascade result already
known to be incorrect.

The compact capture schema can express only a uniform border. Final asymmetric
border longhands therefore do not become a false four-sided stroke; their
`border` scalar remains absent. All four computed corner radii and padding
longhands are serialized to valid CSS shorthand, and `none` image/shadow values
remain absent.

## Gates

`src/capture/pseudo-style-cdp.test.ts` covers pseudo identity, author-origin
activation, final-longhand serialization, elliptical radius/padding shorthand,
and the asymmetric-border fail-closed rule.

`tests/pseudo-cascade.e2e.test.ts` compares the captured fields with an
independent CDP read of Blink's live UA-shadow ComputedStyle. Its controls cover:

- higher-specificity earlier rules and earlier `!important` rules;
- normal layer order and the reversed important-layer order;
- UA-only versus author-origin ownership and the legacy `-webkit-*`
  UA-shadow style-attribute origin reversal (the color input's inline swatch
  value remains Chromium's winner over a normal author background rule);
- active/inactive `@scope`, `@media`, `@supports`, and `@container` rules;
- document and shadow-root `adoptedStyleSheets`, a same-origin iframe, CSS
  nesting, and functional pseudo-class selectors;
- shorthand/longhand priority with resolved `calc()` geometry;
- custom `::-webkit-resizer` specificity; and
- focus, hover, disabled state, repeated captures, and live adopted-sheet
  mutation.

The shadow-root row inspects the production CDP payload directly because open
custom-element shadow paint is intentionally owned by Domotion's existing
replaced-element raster route rather than the light-DOM vector walk.
