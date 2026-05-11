# 24 — Inline SVG icon references

## Context

Inline SVG icons typically come in two shapes on real-world pages:

```html
<!-- 1. Self-contained: paths declared inline. -->
<svg viewBox="0 0 24 24" width="16" height="16">
  <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
</svg>

<!-- 2. <use> reference: paths declared once in a hidden SVG, reused via <use href="#icon-check">. -->
<svg style="display:none">
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="M9 16.17…"/></symbol>
  <symbol id="icon-cart" viewBox="0 0 24 24"><path d="…"/></symbol>
</svg>
…
<svg width="16" height="16"><use href="#icon-check"/></svg>
```

apple.com uses pattern (2) heavily — the country dropdown checkmark, the search/cart icons in the global nav, the social icons in the footer. The defs live in a single hidden `<svg>` at the bottom of the page, every consumer references via `<use href="#…">`.

Pattern (1) round-trips through Domotion correctly today (DM-279 bakes computed presentation attrs onto the cloned outerHTML and the inline paths re-embed cleanly).

Pattern (2) is broken: the cloned consumer's `outerHTML` contains a `<use href="#icon-check">` whose target is in a *different* SVG that Domotion never emits. The reference dangles in the output — Chromium's SVG renderer falls back to nothing painted, and the icon disappears (or, worse, the host element's text label is captured and renders as PUA-glyph tofus where Chrome painted the icon).

## Today's behavior

Implemented in DM-499 (this doc). `CAPTURE_SCRIPT` clones the host `<svg>`'s outerHTML, walks the cloned subtree for `<use href="#id">` references, resolves each via `document.getElementById`, and inlines the resolved subtree:
- `<symbol viewBox="…">` targets are inlined as a nested `<svg x y w h viewBox="…" preserveAspectRatio="…">{symbol.children}</svg>` — declarative form preserves SVG's own viewport scaling.
- `<g>` / `<path>` / etc. targets are wrapped in `<g transform="translate(x, y)">{target.outerHTML}</g>`.
- `<use>` presentation attrs (`fill`, `stroke`, `stroke-width`, `opacity`, `class`, `style`) override the same on the resolved root.
- `currentColor` substitution: any `fill="currentColor"` / `stroke="currentColor"` in the resolved subtree is eagerly replaced with the host SVG's resolved `cs.color` so it survives re-embedding outside the original cascade.
- Cycle / depth guard: 5-level recursion limit on `<use>` chains.

When the resolved subtree contains an active CSS animation (`getAnimations({subtree:true})` non-empty), capture warns and falls back to the page-screenshot raster path (mirrors doc 17 / doc 22). Declarative keyframe extraction is tracked in DM-508.

Hidden-defs SVGs (`<svg style="position:absolute;width:0;height:0">` containing `<symbol>` definitions) capture as 0×0 elements; the renderer skips emission of their content so they don't paint visibly in the output.

## Proposed approach

Two complementary strategies:

### A. Resolve `<use>` references at capture time

Walk the cloned SVG subtree, find every `<use href="#id">` (or legacy `<use xlink:href="#id">`), look up the target element via `document.getElementById`, and inline the resolved symbol's content into the consumer SVG.

Concretely:
1. After cloning the consumer SVG, walk its descendants for `<use>` elements.
2. For each `<use>`, parse the `href`/`xlink:href` attribute. Same-document fragment-only refs (`#foo`) are resolved here; external-file refs (`./icons.svg#foo`) and absolute URLs are deferred.
3. Resolve via `document.getElementById(id)`. Confirm the target is an SVG element (`<symbol>`, `<g>`, `<path>`, `<svg>`, etc.).
4. Replace the `<use>` element with the resolved target's content, preserving `<use>`-side x/y/width/height attributes (which translate the symbol's content) and inheriting fill/stroke/transform.
5. Bake presentation attrs on the resolved subtree the same way DM-279 does for the consumer.

The output SVG is fully self-contained (no fragment refs to dangle) and stays vector-scalable.

### B. Rasterise the SVG element when (A) can't resolve

Some `<use>` refs point at external files (`<use href="./icons.svg#foo"/>`) or at content with non-trivial CSS animations on the symbol that don't survive the clone. For these, fall back to `page.screenshot({ clip: svg-rect, omitBackground: true })` and emit as `<image>` (same pattern as doc 17 / doc 22).

This loses vector scalability for those cases but is a strict improvement over emitting a dangling reference.

## Detection rules

When walking the cloned SVG, an unresolvable `<use>` is one whose `href`/`xlink:href`:
- doesn't start with `#`, OR
- starts with `#` but `getElementById(id)` returns null, OR
- starts with `#` but the resolved target lives outside the captured tree's root selector (per the docs — Domotion's capture is rooted at a selector, not the entire document).

For each unresolvable case, the host SVG element is flagged for rasterisation in the post-capture pass (doc 17 machinery) and the cloned outerHTML is discarded.

## Symbol vs. direct-path targets

`<use href="#foo">` is allowed to reference any element with an id, but in practice the targets are almost always:
- `<symbol viewBox="…">` — defines an icon with its own coordinate system
- `<g>` — a group of paths
- `<path>` — a single shape

For `<symbol>` targets: the spec says `<use>` instantiates a `<symbol>` with the consumer's x/y/width/height as a viewport. The translation is non-trivial (need to honor preserveAspectRatio + viewBox scaling). Practical implementation: replace the `<use>` with `<svg x=… y=… width=… height=… viewBox=symbolViewBox>` containing the symbol's children.

For `<g>` and `<path>` targets: simpler — replace `<use x=X y=Y>` with `<g transform="translate(X, Y)">{symbol.outerHTML}</g>`.

## Test fixtures

`tests/features.ts` gains:
- `inline-svg-use-symbol`: a `<symbol id="check" viewBox="0 0 24 24">` defined in a hidden defs SVG, plus two consumers `<svg width="16" height="16"><use href="#check"/></svg>` at different positions. After the change, the diff vs. Chrome's paint should hit 0 non-AA pixels.
- `inline-svg-use-group`: `<g id="icon-grp">…</g>` consumed via `<use href="#icon-grp">` — exercises the simpler `<g>`/`<path>` substitution path.
- `inline-svg-self-contained` (regression): a plain inline `<svg><path/></svg>` continues to round-trip identically (covers the DM-279 path didn't regress).

`src/dom-to-svg.test.ts` (or a new `src/inline-svg.test.ts`): unit tests for the `<use>` resolver — exercise href / xlink:href, missing target, target outside root selector, symbol-with-viewBox vs. plain-group target.

## Open design questions

1. **Symbol viewBox translation**: emit `<svg x y w h viewBox=…>{symbol.children}</svg>` or fully resolve to `<g transform=scale(…)>` after computing the scale factor manually? The first preserves declarative spec compliance; the second produces fewer nested SVG elements. Recommend the first (declarative form).
2. **External-file refs (`./icons.svg#foo`)**: out of scope for this ticket? File a follow-up if seen in the wild — probably needs to fetch the external file at capture time, which is async and adds I/O cost similar to DM-258 font discovery.
3. **CSS-animated symbols**: if `<symbol id="icon">` has a child with a CSS animation, the cloned outerHTML captures the animation declaration, but the keyframe rules don't survive. Should we fall through to rasterisation when `getAnimations()` is non-empty on any symbol descendant? My read: yes, conservatively; warn at capture time.
4. **`fill="currentColor"` resolution**: `<use>` consumers commonly set `color:` on the host and the symbol uses `fill="currentColor"`. After our resolve-and-inline pass, `currentColor` resolves against the symbol's *own* DOM context (which has no inherited color), not the consumer's. Should we eagerly substitute `currentColor` with the resolved color from the consumer's `cs.color` at capture time? Recommend yes — simpler than deferring resolution to render time.

## Follow-ups to file when this lands

- External-file `<use>` refs (`<use href="./icons.svg#foo">`) — needs an external-fetch capture path.
- `<use>` chains (`<symbol id="a"><use href="#b"/></symbol>`) — recursive resolution with cycle detection.
- Rasterisation fallback bench step in `npm run demos:test` to ensure resolve-and-inline wins for the common case (no per-icon screenshots).
