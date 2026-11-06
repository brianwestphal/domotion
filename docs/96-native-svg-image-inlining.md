---
id: "requirements/native-svg-image-inlining"
title: '96 — Native inlining of <img src=".svg">'
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-1592", "DM-1593", "DM-1595", "DM-97E2CN", "DM-VGPTYG", "DM-JZR5T6", "DM-KA02KF", "DM-JGBC33"]
code:
  [
    "src/capture/embed.ts",
    "src/capture/script/walker/inline-svg.ts",
    "src/cli/animate-orchestrator.ts",
    "src/cli/capture.ts",
    "src/cli/index.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/resolve-svg-source.test.ts",
    "src/render/svg-image-natural-sizing.test.ts",
    "src/render/svg-image-root-stylesheet.test.ts",
    "src/render/svg-image-root-stylesheet.ts",
    "src/render/svg-image-root-transform.test.ts",
    "src/render/svg-image-style-scope.test.ts",
    "src/render/svg-image-style-scope.ts",
    "src/render/svg-image-root-transform.ts",
    "src/render/svg-inline.test.ts",
    "src/render/svg-inline.ts",
    "tests/inline-svg-text-presentation.e2e.test.ts",
    "tests/inline-svg-textpath-oracle.e2e.test.ts",
    "tests/replaced-used-size.e2e.test.ts",
  ]
aliases: ["docs/96-native-svg-image-inlining.md", "doc-96"]
---

# 96 — Native inlining of `<img src="*.svg">`

## Summary

When a captured page references an SVG through an `<img>` (or any replaced image whose source resolves to `image/svg+xml`), Domotion inlines the SVG as a **native, positioned `<svg>`** in the output rather than embedding it as `<image href="data:image/svg+xml;base64,…">`. The result is truly resolution-independent (crisp at any zoom), smaller (no ~33% base64 bloat), and more cross-engine-robust than an SVG-in-`<image>`.

This is the _inverse_ of the raster-image fallbacks catalogued in [reference/raster-image-fallback-cases.md](reference/raster-image-fallback-cases.md): instead of turning a paint we can't express into a raster, we turn a raster-ish embedding into crisp vector.

## Motivation

Chromium paints an SVG referenced from an `<image>` (or an `<img>`) by rasterizing it at the element's **layout size** and then scaling that raster. So an SVG logo displayed at 100×100 is rasterized to ~100×100 device pixels (times DPR) and any subsequent zoom scales those pixels — the edges soften and alias. This was the user-reported symptom on the `brand-mixed` demo: the embedded `assets/logo.svg` looked pixelated at 3× zoom.

A nested native `<svg>` carries live vector geometry (paths, gradients, filters). The browser scales the _geometry_, not a bitmap, so it stays razor-sharp at any scale — and the payload is the SVG's own markup rather than a base64 blob roughly one-third larger than the raw bytes.

## Behavior

### Trigger

The native path fires when, and only when, the `<img>`'s source resolves to an SVG. `resolveSvgSource(el.imageSrc)` (`src/capture/embed.ts`) resolves the source the same way the `<image href>` path does — via `embedAsDataUri` (file read, `file://` decode, or a pre-fetched remote `_dataUriCache` hit) — and returns the decoded SVG text only when the mime is `image/svg+xml`. It returns `null` (→ raster `<image>` path) for:

- raster sources (PNG / JPEG / GIF / WebP / AVIF),
- remote SVG URLs that were not pre-fetched into a data URI (we don't have the bytes),
- decode failures.

`resolveSvgSource` deliberately does **not** consult `_resizedDataUriCache`: the image-resize pre-pass ([27-image-resize-on-embed.md](27-image-resize-on-embed.md)) rasterizes SVGs to PNG via `sharp`, which is exactly what this feature avoids. The native path always works from the original vector bytes.

Local file URLs are converted with Node's URL parser using the host platform's
path semantics. This matters on Windows: `file:///C:/assets/logo.svg` must
resolve to `C:\\assets\\logo.svg`; manually removing `file://` produces the
nonexistent `/C:/assets/logo.svg`, silently disabling native inlining and its
`object-fit` mapping.

### Rewrite

`inlineImgSvg` (`src/render/svg-inline.ts`) rewrites the SVG file's source into a nested `<svg>` ready to drop into the output:

1. **Coordinate system.** It uses the SVG's own `viewBox`; if there is none it synthesizes one from the SVG's absolute `width`/`height` attributes, and failing that from the `<img>` intrinsic size (`el.imageIntrinsic`). With no coordinate system available at all (no viewBox, no absolute size, no intrinsic size — e.g. a percentage-sized SVG), it returns `null` and the caller keeps the raster `<image>` path, because a nested `<svg width/height>` with no viewBox can't scale its contents into the placement rect.
2. **Placement.** It strips the source root's `x` / `y` / `width` / `height` / `viewBox` / `preserveAspectRatio` and re-declares them: `x`/`y` at the element's **content-box** top-left, `width`/`height` at the content-box size, `viewBox` from step 1, and `preserveAspectRatio` derived from the CSS `object-fit` / `object-position` (`preserveAspectRatioFor`). Everything else on the root tag (`xmlns`, `class`, `style`, `role`, …) is preserved.
3. **Id namespacing.** `prefixSvgIds` prefixes every `id`, `href="#…"`, `xlink:href="#…"`, and `url(#…)` with a per-document-unique prefix (allocated from the renderer's id counter) so the inlined SVG's internal gradients / clipPaths / filters / masks / `<use>` targets can't collide with ids elsewhere in the output document or in another inlined SVG.

The result is emitted by `paintImage` in `src/render/element-tree-to-svg.ts`. A `border-radius` on the `<img>` wraps the nested `<svg>` in a `<g clip-path="url(#…)">` using the same rounded-content-box clip the raster path uses.

### Flattened output (`--flatten-nested-svg`)

`domotion capture <input> --flatten-nested-svg` is an opt-in compatibility mode for consumers that have trouble importing nested `<svg>` elements. For an inlined SVG image, `flattenImgSvg` replaces the nested viewport with a positioned `<g transform="matrix(…)">` and adds a rectangular clip when the source SVG hides overflow. The ordinary nested `<svg>` remains the default.

The same flag flattens a DOM-inline `<svg>` (`flattenCapturedInlineSvg` in `src/render/element-tree-to-svg.ts`). In both paths the group keeps the root's own attributes (`flattenedRootGroupAttributes` in `src/render/svg-inline.ts`), dropping only the viewport, namespace, `overflow` and transform-family (`transform`, `transform-origin`, `transform-box`) attributes that the group's matrix and clip replace (see "Root `<svg transform>`" below). The same goes for the root's `style`: its `transform`, `rotate`, `scale`, `translate`, `transform-origin`, `transform-box` and `overflow` declarations are removed. Capture neutralizes a DOM root's own transform on the clone (the renderer applies it outside the SVG), and a CSS `transform` left on the group would override the group's matrix attribute and collapse the content onto the origin. That keeps inheritable presentation on the root, such as `fill`, `stroke`, `color` and the `font-family` that capture bakes from the page cascade, so children inherit exactly what they did under the nested `<svg>`. Before this, the DOM-inline path dropped every root attribute, and SVG text fell back to the serif default.

#### Root `<svg transform>`

An outermost `<svg>`'s `transform` attribute is a presentation attribute for the CSS `transform` property (`core/svg/svg_transformable_element.cc:38-41, 50-52`, Chromium `7d859f27`). The outermost `<svg>` lays out as `LayoutSVGRoot`, a CSS replaced box, so the transform applies to that box about the initial `transform-origin: 50% 50%`. The UA rule that sets `0 0` (`core/css/svg.css:88-90`) only matches an svg whose parent is an SVG element. Each path applies it exactly once:

- **DOM-inline `<svg>`.** Capture records Blink's resolved transform as the element's CSS transform, which the renderer's wrapper group applies. It also neutralizes the attribute with an inline `style="transform: translate(0px)"`. The nested output therefore keeps the attribute inert. The flattened group drops the attribute, and the carried `style` loses its transform-family declarations as described above, so the transform is applied once, by the wrapper.
- **`<img src="*.svg">`.** Nothing else applies the root transform, so both the nested and the flattened output wrap the root's markup in `<g transform="translate(c) T translate(-c)">`, where `c` is the center of the concrete object rect (the viewBox mapped into the placement). The result is clipped to the content box intersected with that rect, because `SVGImage::DrawInternal` clips every frame to its destination rect (`core/svg/graphics/svg_image.cc:548`) whatever the root's `overflow`. The root box's own overflow clip stays inside the transform. Before this, the nested `<svg transform>` rotated about the output origin and the flattened output dropped the transform.

  The root's other CSS transform inputs apply the same way (`src/render/svg-image-root-transform.ts`). A `style` `transform` overrides the attribute (an author declaration beats a presentation attribute). The individual `translate`, `rotate` and `scale` properties compose before it, in the order `ComputedStyle::ApplyTransform` uses (`core/style/computed_style.cc:1429-1490`): origin, translate, rotate, scale, transform, minus origin. `transform-origin` is also a presentation attribute (`core/svg/svg_element.cc:381`), and a `style` declaration overrides it; it moves the pivot from the default `50% 50%`. Percentages resolve against the concrete object rect. `transform-box` needs no handling: for a CSS box every value resolves to the content box or border box (`ComputedStyle::UsedTransformBox`, `core/style/computed_style.cc:1372`), and both equal the object rect for an image root, which has no border or padding. The nested output strips these attributes and declarations from the nested `<svg>`. A value outside the supported 2D subset (`calc()`, font-relative units, a 3D function, an axis form of `rotate`) falls back to the `transform` attribute alone about the box center, with a `svg-image-root-transform` warning. Fixture: `image-svg-root-style-transform`.

  The image's own `<style>` sheets cascade onto the root too (`src/render/svg-image-root-stylesheet.ts`): Blink treats the SVG image document's author sheets like any author rule, so `svg { transform: … }`, `:root { transform-origin: 0 0 }` or a `#id` / `.class` rule matching the root transforms the image. The root of an SVG image has no parent or element siblings, so a selector with a combinator never matches it; a combinator-free compound of a type (`svg`, `*`), `#id`, `.class` and `:root` is matched against the root's tag, id and classes. Declarations are ranked by the CSS cascade: `!important` first, then the style attribute over any selector at equal importance, then specificity, then source order. The applied transform-family declarations are removed from the inlined sheet, because an inlined `<style>` applies to the whole output document, including the nested root and the outer document root. A selector that also reaches other elements of the image (`*`, `svg` when the image nests `<svg>` elements, or a class another element carries) keeps its declarations for them as `selector:not([data-domotion-image-root])`, and the nested root carries that attribute. A transform-family declaration that could reach the root through a selector this cannot decide (an attribute selector or another pseudo-class) or inside an at-rule (`@media`) leaves the sheet's transform unapplied, with a `svg-image-root-transform` warning. Fixture: `image-svg-root-stylesheet-transform`.

**The drawn-image clip.** `SVGImage::DrawInternal` clips every SVG image frame to its destination rect before drawing it (`core/svg/graphics/svg_image.cc:548`, Chromium `7d859f27`), whatever the root's `overflow`. Both `<img>` paths therefore clip to the content box intersected with the concrete object rect (`clipToImage` in `src/render/svg-inline.ts`) when the root sets `overflow="visible"` or `overflow: visible`, and when the object rect is inset from the placement box (an aspect-preserving `par` such as `object-fit: contain`), where the nested viewport's own clip at the placement box would be wider than the drawn image. A Chromium probe confirms that content outside the viewBox of an `overflow="visible"` image does not paint outside the image box, and that a `contain` image is clipped to its object rect inside a wider content box. Icons whose object rect fills the placement box keep their output unchanged. Fixture: `image-svg-overflow-visible-clip`.

Capture also bakes the resolved text presentation onto each DOM-inline `<text>` as inline declarations, because none of it survives outside the page cascade: `font-family`, `font-size`, `font-weight`, `font-style`, `font-stretch` (written as its keyword), `font-variant-numeric`, `text-anchor`, `dominant-baseline`, `letter-spacing` and `word-spacing`. A nested `<tspan>` or `<textPath>` carries only the values that differ from its parent's. This bake lives in `bakeSvgTextPresentation` (called from `walkBake`) in `src/capture/script/walker/inline-svg.ts`.

Flattening is conservative. The renderer keeps the nested `<svg>` when the source lacks a usable coordinate system, uses viewport-relative percentages in painted geometry or user-space definitions, has CSS selectors beyond scoped class/id selectors, contains another `<svg>`, `<symbol>`, `<use>`, `<foreignObject>`, or `<image>`, or uses `vector-effect="non-scaling-stroke"`. The same fallback applies if the source cannot be parsed as an SVG. It does not turn the image into a raster.

The CLI sets the internal `setFlattenNestedSvg(true)` process flag for its one-shot capture and restores the previous value when the execution settles, even when it fails (`withProcessRenderSettings` in `src/cli/process-render-settings.ts`). In an in-process renderer, prefer the per-call `flattenNestedSvg` option of `elementTreeToSvg` (or the internal `withFlattenNestedSvg(enabled, fn)` scope): both restore the previous setting afterward, even when the render throws. The scope accepts only a synchronous callback: a Promise-like result is rejected with a `TypeError`, since the flag cannot stay scoped across an `await`. `setFlattenNestedSvg` / `getFlattenNestedSvg` remain as internal process-wide controls, and a caller using the bare setter must restore the previous value itself. The public `domotion-svg/render` barrel does not export these controls.

The placement rectangle is captured layout output, not a size recomputed from
the asset. This mirrors Chromium revision `7d859f27`: flex/grid layout first
establishes the replaced element's used box, then `LayoutReplaced` computes
`object-fit` and `object-position` within its `PhysicalContentBoxRect`
(`layout_replaced.cc:422-497`), and `ImagePainter` paints the resulting
`ReplacedContentRect` (`image_painter.cc:140`). Domotion therefore carries the
captured used border box through to `paintImage` and consults intrinsic
dimensions only for the object-fit calculation.

`prefixSvgIds` is shared with the animator's SVG-overlay inliner (`namespaceSvgIds` in `src/cli/animate-orchestrator.ts`), so the namespacing regexes live in exactly one place.

## object-fit coverage

All `object-fit` values take the native path:

- **With an intrinsic size** (every SVG `<img>` Chromium loads reports a non-zero `naturalWidth`/`naturalHeight`), `paintImage` computes Blink's concrete object rect for the `object-fit` / `object-position` pair and places the nested `<svg>` there, clipped to the content box. For an SVG source the rect comes from Blink's **natural sizing info**, not from `naturalWidth`/`naturalHeight`, which report a concrete size resolved against the 300x150 default (a viewBox-only square reports 150x150). `svgImageNaturalSizing` (`src/render/svg-inline.ts`) mirrors `LayoutSVGRoot::UnscaledNaturalSizingInfo` (`core/layout/svg/layout_svg_root.cc:74-103`): the natural width/height come from absolute `width`/`height` attributes (a percentage, including the initial `100%`, is no dimension), and the ratio comes from that size when it is non-empty, else from the viewBox. Following `SVGImage::GetNaturalDimensions` (`core/svg/graphics/svg_image.cc:236-262`), everything is cleared when a dimension is missing and the root's `preserveAspectRatio` is `none`. `computeObjectFitRectFromNaturalSizing` (`src/render/element-tree-to-svg.ts`) transcribes `LayoutReplaced::ComputeObjectFitAndPositionRect` (`core/layout/layout_replaced.cc:422-482`) with `ConcreteObjectSize` (`core/layout/natural_sizing_info.cc:56-100`). So `none` / `scale-down` on a ratio-only SVG resolve a contain size against the content box, and an SVG with no size and no ratio fills the content box for every value. A root length in font- or viewport-relative units or a math function keeps the captured concrete size. Fixture: `image-svg-natural-sizing-object-fit`. Raster images keep `computeObjectFitRect` over the captured size. That rect is the SVG image document's **viewport**: `ImagePainter` requests the image at `dest_rect.size` (`core/paint/image_painter.cc:218`) and `SVGImage` lays the root out at that container size (`core/svg/graphics/svg_image.cc:463`, Chromium `7d859f27`). Inside it the root maps its content exactly as a standalone document would (`InlineSvgPlacement.documentViewport`):
  - a valid root `viewBox` maps with the **root's own `preserveAspectRatio`** (default `xMidYMid meet`), so an `object-fit: fill` box whose aspect differs from the viewBox letterboxes (or, for `slice`, crops) instead of stretching, and content outside the viewBox but inside the object rect still paints;
  - without a valid viewBox, Blink synthesizes one from the root `width`/`height` (a missing or percentage value resolves against the viewport) and a `none` `preserveAspectRatio` (`SVGSVGElement::CurrentViewBoxRect` / `CurrentPreserveAspectRatio`, `core/svg/svg_svg_element.cc:598-626`), so such an SVG does stretch to the object rect.
    The drawn-image clip and the root transform's reference box are the object rect itself. Fixture: `image-svg-root-preserve-aspect-ratio`.
- **Without an intrinsic size** (a source Chromium never reported dimensions for), the nested `<svg>` is placed at the content box with a `preserveAspectRatio` derived from `object-fit` / `object-position` (`preserveAspectRatioFor`).
- **`object-fit: none`** (DM-1592) is the intrinsic-size case of the first bullet: the object rect is the SVG's intrinsic size, positioned by `object-position` inside the content box and clipped to it. Falls back to the raster `<image>` when the source isn't SVG or has no coordinate system.

## Id + class namespacing

`prefixSvgIds` rewrites every `id`, `href="#…"`, `xlink:href="#…"`, and `url(#…)` with the per-document-unique prefix so gradients / clipPaths / filters / masks / `<use>` targets can't collide across inlined SVGs or with the outer document.

`prefixSvgClasses` (DM-1593) does the same for **CSS class names** — but only when the SVG carries a `<style>` block (the only way a class affects rendering, so a presentation-attribute export like the `brand-mixed` logo stays byte-identical). It rewrites class selectors in the _selector portion_ of each rule inside `<style>` (never a `.` in a declaration value) plus every `class="…"` attribute. Without this, two design-tool exports that both define `.cls-1` in a `<style>` block would cross-contaminate, since an inlined SVG `<style>` applies document-wide (verified: a red-`.cls-1` and a blue-`.cls-1` SVG now render independently). Nested at-rules (`@media`) inside an SVG `<style>` are not handled — essentially never present in an SVG asset.

**Sheet scoping for `<img>` SVGs.** Blink gives every SVG image its own document, so the image's author sheets reach only its own elements and `:root` means the image root. An inlined `<style>` instead belongs to the whole output document, where an element selector such as `g rect { stroke: … }` would reach every rect in the output and `svg` / `:root` rules would reach the output root. When the source has a `<style>`, `inlineImgSvg` therefore marks the nested root with `data-domotion-image-root="<prefix>"` and rewrites every selector (`scopeImageStyleSheets`, `src/render/svg-image-style-scope.ts`). Each compound gains `:where([data-domotion-image-root="<prefix>"], [data-domotion-image-root="<prefix>"] *)`, which adds no specificity, so the image's rules keep their relative ranking. A compound that already requires one of the image's namespaced classes or ids is left alone. `:root` becomes the root attribute selector, which has the same specificity. Conditional group rules (`@media`, `@supports`, `@layer`, `@container`, `@scope`) are scoped recursively, and other at-rules are left alone. The root's own `id` is part of the id set for the body too, so a `#root rect` rule or `href="#root"` follows the namespaced id. The flattened output needs no marker because its gate already rejects every selector that is not a class or id selector. Fixture: `image-svg-style-scope`.

`prefixSvgClasses` is shared by all three SVG-inlining paths (DM-1595), each gated on `<style>` presence:

- **`<img src="*.svg">`** (`inlineImgSvg`) — namespaces both ids and classes (self-contained file, no cross-SVG refs).
- **Captured DOM inline `<svg>`** (`paintInlineSvg`) — namespaces ids by the captured document/shadow-root scope. Sibling SVGs in one source scope share a prefix, preserving legitimate cross-SVG `<use>` and paint-server references; independent iframe/shadow scopes receive different prefixes before they are combined into the consumer document. Same-scope `href`/`xlink:href`, CSS `url(#…)`, embedded ID selectors, SMIL event references, and ARIA IDREFs are rewritten only when their target exists, so unresolved references remain unresolved. CSS classes retain their separate per-inline-SVG namespace.
- **Animator svg-overlay files** (`namespaceSvgIds` in `src/cli/animate-orchestrator.ts`) — namespaces ids (already) and now classes.

## Scope / known boundaries

- **`<filter>` regions, `currentColor`, and CSS custom properties** inside the SVG resolve against the nested `<svg>` context, matching how the browser resolves them for the original `<img>` in the common cases (design-tool exports with self-contained gradients/filters). SVGs that rely on inheriting `color` / CSS variables from the host page are out of scope.

## Testing

- `src/render/svg-inline.test.ts` — `prefixSvgIds` namespacing (fragment/CSS/timing/ARIA consumers, both quote styles, unresolved/external passthrough, shared-vs-independent scopes); `inlineImgSvg` (viewBox preservation, width/height synthesis, intrinsic fallback, no-coordinate-system → `null`, no-root → `null`, XML-decl stripping); and end-to-end through `elementTreeToSvgInner` (SVG `<img>` → native `<svg>`, raster `<img>` → `<image>`, border-radius clip wrapper). `tests/inline-svg-textpath-oracle.e2e.test.ts` proves two iframe documents can reuse one path id without cross-binding after capture.
- `src/render/resolve-svg-source.test.ts` — `resolveSvgSource` decode (base64 + URL-encoded), local URL-encoded files, Windows drive/UNC conversion, raster → `null`, remote → `null`, empty/nullish → `null`.
- `tests/replaced-used-size.e2e.test.ts` — captures stretched raster and SVG
  images in flex/grid, then proves their browser-used boxes survive unchanged
  into `<image>` and nested `<svg>` placement.
- The `brand-mixed` demo golden exercises the full path (the `lower-third` brand logo is an `<img src="*.svg">`).

## Files

- `src/capture/embed.ts` — `resolveSvgSource`.
- `src/render/svg-inline.ts` — `prefixSvgIds`, `prefixSvgClasses`, `inlineImgSvg`, `flattenImgSvg`, and the internal `setFlattenNestedSvg` / `getFlattenNestedSvg` / `withFlattenNestedSvg` controls (+ the `InlineSvgPlacement` shape).
- `src/render/svg-image-root-transform.ts` — `resolveImageRootTransform`: an `<img>` SVG root's CSS transform inputs as an SVG transform list and origin.
- `src/cli/capture.ts` and `src/cli/index.ts` — the opt-in `--flatten-nested-svg` flag and help text.
- `src/render/element-tree-to-svg.ts` — `paintImage` native-SVG branch.
- `src/cli/animate-orchestrator.ts` — `namespaceSvgIds` now delegates to the shared `prefixSvgIds`.
