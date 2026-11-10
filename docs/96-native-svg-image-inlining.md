---
id: "requirements/native-svg-image-inlining"
title: '96 — Native inlining of <img src=".svg">'
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets:
  [
    "DM-1592",
    "DM-1593",
    "DM-1595",
    "DM-97E2CN",
    "DM-VGPTYG",
    "DM-JZR5T6",
    "DM-KA02KF",
    "DM-JGBC33",
    "DM-XMBY4P",
    "DM-GZP5P2",
    "DM-9JBJ9F",
    "DM-KE2WFC",
    "DM-QK62CS",
    "DM-6ZX6W0",
    "DM-KGD5KC",
    "DM-YMAF0G",
    "DM-SXDNW9",
    "DM-WT73T4",
  ]
code:
  [
    "src/capture/embed.ts",
    "src/capture/image-document-settings.ts",
    "src/render/svg-image-root-font.ts",
    "src/render/svg-image-root-font.test.ts",
    "packages/text-engine/src/render/isolated-primary-font-metrics.ts",
    "src/capture/image-document-settings.test.ts",
    "tests/img-svg-document-settings.e2e.test.ts",
    "src/capture/script/walker/inline-svg.ts",
    "src/cli/animate-orchestrator.ts",
    "src/cli/capture.ts",
    "src/cli/index.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/resolve-svg-source.test.ts",
    "src/capture/script/walker/image-elements.ts",
    "src/capture/script/walker/document-prepass.ts",
    "tests/capture-selected-replaced-root.e2e.test.ts",
    "src/render/svg-image-media.test.ts",
    "src/render/svg-image-media.ts",
    "src/render/svg-image-natural-sizing.test.ts",
    "src/render/svg-image-root-stylesheet.test.ts",
    "src/render/svg-image-root-stylesheet.ts",
    "src/render/svg-image-root-transform.test.ts",
    "tests/svg-root-transform-raster.e2e.test.ts",
    "src/render/svg-image-selector-engine.test.ts",
    "src/render/svg-image-selector-engine.ts",
    "src/render/svg-image-style-scope.test.ts",
    "src/render/svg-image-supports.test.ts",
    "src/render/svg-image-supports.ts",
    "src/capture/image-svg-supports.ts",
    "src/capture/image-svg-supports.e2e.test.ts",
    "src/render/svg-image-style-scope.ts",
    "src/render/svg-image-root-transform.ts",
    "src/render/svg-inline.test.ts",
    "src/render/svg-inline.ts",
    "src/render/svg-image-css-import.ts",
    "src/render/svg-image-css-import.test.ts",
    "src/render/svg-image-fragment-ids.ts",
    "src/render/svg-image-fragment-ids.test.ts",
    "src/render/svg-image-references.ts",
    "src/render/svg-image-reference-css.ts",
    "src/render/svg-image-reference-syntax.ts",
    "src/render/svg-image-references.test.ts",
    "tests/img-svg-reference-identity.e2e.test.ts",
    "tests/img-svg-import-fragments.e2e.test.ts",
    "src/render/svg-image-cdata.ts",
    "src/render/svg-image-style-names.ts",
    "tests/img-svg-css-import.e2e.test.ts",
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

A visible image can be selected directly through `captureElementTree` or the
CLI's `--selector`; it does not need an authored background, border or text.
Root admission reaches the existing image-content producer, so selecting a
transparent `<img>` retains the same image as selecting its container. The
ordinary visibility, viewport and geometry gates still apply. The shared root
admission also reaches existing inline-SVG, replaced-snapshot and native-control
producers; transparent ordinary containers keep their existing child walk.

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

  The root's other CSS transform inputs apply the same way (`src/render/svg-image-root-transform.ts`). A `style` `transform` overrides the attribute (an author declaration beats a presentation attribute). The individual `translate`, `rotate` and `scale` properties compose before it, in the order `ComputedStyle::ApplyTransform` uses (`core/style/computed_style.cc:1429-1490`): origin, translate, rotate, scale, transform, minus origin. `transform-origin` is also a presentation attribute (`core/svg/svg_element.cc:381`), and a `style` declaration overrides it; it moves the pivot from the default `50% 50%`. Percentages resolve against the concrete object rect. `transform-box` needs no handling: for a CSS box every value resolves to the content box or border box (`ComputedStyle::UsedTransformBox`, `core/style/computed_style.cc:1372`), and both equal the object rect for an image root, which has no border or padding. The nested output strips these attributes and declarations from the nested `<svg>`. Values resolve exactly: px and the other absolute units, percentages, `em` / `rem` against the root's font-size (its `font-size` style or attribute in absolute units, else the initial 16px), the four angle units, and `calc()` over them. The 3D functions and the axis forms of `rotate` (`x` / `y` / `z` / `<n> <n> <n>`) are composed as 4x4 matrices (CSS Transforms 2) and flattened once to their 2D affine part. That is exact because the image root paints into a flat picture with no perspective: the rasterizer maps (x, y, 0, 1), so the z row and column never reach the screen, though two 3D factors still couple through z, which is why the whole list is composed first. Viewport units (`vw` / `vh` / `vmin` / `vmax`) resolve against the image viewport, the object rect in the image's CSS px (`svg_image.cc:463-473`). A plane point (x, y, 0, 1) maps through w = m14·x + m24·y + m44, so a `perspective(<length>)` (used depth `max(1px, d)`, `PerspectiveTransformOperation::UsedPerspective`) only reaches the screen through a later factor that tilts the plane. When the composed matrix keeps m14 = m24 = 0 and m44 > 0, it is still affine and divides out exactly. Otherwise it is projective: SVG transforms are affine, so `inlineImgSvg` / `flattenImgSvg` return null and the `<img>` takes the `<image href="data:image/svg+xml">` path, whose own SVG document applies the transform (see `docs/reference/raster-image-fallback-cases.md`). The font-metric units resolve against the root's primary font (`src/render/svg-image-root-font.ts`). `CSSToLengthConversionData::FontSizes` and `LineHeightSize` (`core/css/css_to_length_conversion_data.cc:101-228`) read `Font::PrimaryFont()` and its `WithDigitZero` / `WithCjkWater` forms, which for system fonts are all the first font data of the family list (`font_fallback_list.cc:88-128`). The root has no parent, so its font is its own `font-family` / `font-size` / `font-weight` / `font-style` (presentation attribute or inline style) over the initial standard family and `medium`, which the image page copies from the embedder's Settings (`isolated_svg_document_host.cc:178-189`). The text engine resolves system faces without borrowing embedding-page registrations. Authenticated image-owned data faces can supply their own metrics (`isolatedPrimaryFontMetrics`; see `docs/274-dynamic-svg-image-fonts.md` and `docs/font-resolution-diagram.md`):
  - `ex` / `rex` is the x-height and `cap` / `rcap` the cap height. Each is left unresolved when the platform value is not reproducible from the font file, for example macOS `CTFontGetCapHeight` for a face without an OS/2 v2 `sCapHeight`.
  - `ch` / `rch` is the advance of `0`, or 0.5em without one (`ZeroInlineSize`, `simple_font_data.cc:557-586`).
  - `ic` / `ric` is the advance of U+6C34, or 1em without one (`FontSizes::Ic`).
  - `lh` / `rlh` is `ComputedLineHeight` (`computed_style.cc:2413-2429`) over the inline `line-height` as `ConvertLineHeight` computes it (`style_builder_converter.cc:2198-2233`). A number resolves through `LayoutUnit`, and a percentage keeps its integer part. At the root, `rlh` equals `lh`.

  The platform-aware primary-font provider supplies native or exact-file metrics on macOS, Linux and Windows; insufficient face/size evidence remains unresolved. Root attribute values are read as the XML DOM holds them: line ends and literal whitespace normalized, character references and predefined entities expanded. See `docs/274-dynamic-svg-image-fonts.md` for font-unit ownership and native-helper compatibility.

  If any winning root transform, individual transform or origin cannot be lowered exactly, both `inlineImgSvg` and `flattenImgSvg` retain the original SVG image through the `<image>` fallback (DM-KGD5KC). The same applies when the root stylesheet cascade is undecidable. A named `svg-image-root-transform` warning explains the fallback. The renderer never substitutes a lower-priority transform presentation attribute for unresolved CSS, nor assumes a center origin after an unresolved origin. Supported static transforms and affine 3D compositions remain vector. `tests/svg-root-transform-raster.e2e.test.ts` compares complete native-image pixels with emitted output for dynamic viewport units, CSS math, presentation origins and undecidable selectors in both modes, with vector neighbor controls.

  The image's own `<style>` sheets cascade onto the root too (`src/render/svg-image-root-stylesheet.ts`): Blink treats the SVG image document's author sheets like any author rule, so `svg { transform: … }`, `:root { transform-origin: 0 0 }` or a `#id` / `.class` rule matching the root transforms the image. The root of an SVG image has no parent or element siblings, so a selector with a combinator never matches it; a combinator-free compound of a type (`svg`, `*`), `#id`, `.class` and `:root` is matched against the root's tag, id and classes. Declarations are ranked by the CSS cascade: `!important` first, then the style attribute over any selector at equal importance, then specificity, then source order. The applied transform-family declarations are removed from the inlined sheet, because an inlined `<style>` applies to the whole output document, including the nested root and the outer document root. A selector that also reaches other elements of the image (`*`, `svg` when the image nests `<svg>` elements, or a class another element carries) keeps its declarations for them as `selector:not([data-domotion-image-root])`, and the nested root carries that attribute. The matcher also decides attribute selectors (every operator and the `i` / `s` flags), `:not()` / `:is()` / `:where()` with their specificity, the dynamic pseudo-classes, which never match in an image document, and the structural pseudo-classes. The root is the sibling-less document element, so `:first-child` / `:last-child` / `:only-child` and the `-of-type` forms hold (`IsFirstChild` / `IsLastChild`, `core/css/selector_checker.cc:476-486`). `:nth-*()` tests An+B at index 1 (`NthIndexCache::NthChildIndex`, `core/dom/nth_index_cache.cc:148`); its `of S` form adds the most specific selector of S (`core/css/css_selector.cc:233-236`). `:scope` means the root (`CheckPseudoScope`, `selector_checker.cc:3644-3654`), and `:empty` reads the root's children: any element or non-empty text child, whitespace included, makes it non-empty (`kPseudoEmpty`, `selector_checker.cc:2310-2335`). `:has()` is decided against the image's own element tree (`src/render/svg-image-selector-engine.ts`): the source is parsed into elements with decoded attributes, and each relative argument is matched right to left from the root as the anchor (`CheckPseudoHas`, `selector_checker.cc:2111-2273`, and `kPseudoRelativeAnchor`, `selector_checker.cc:3214-3216`). Every combinator is supported, and `+` / `~` never match from the sibling-less root. Inside the argument, compounds take types (case-sensitive, as in an XML document), ids, classes, attribute selectors, `:not()` / `:is()` / `:where()`, `:root` / `:scope`, and the structural pseudo-classes against real sibling indices. Its specificity is its most specific argument (`css_selector.cc:221-222`). A nested `:has()` (a parse error inside a `:has()` argument, `css_selector_parser.cc:1288-1296`), a pseudo-element, another pseudo-class or a DTD-defined value leaves the answer undecided. An `@media` block is evaluated against the image viewport, which is the concrete object rect in the image's CSS px, because Blink sizes the image document's frame view to the container size (`svg_image.cc:472`). That covers the `all` / `screen` / `print` media types, `not` / `only` / `and`, and width / height / aspect-ratio / orientation in both the min/max and range forms. The environment media features are decided too (see the next paragraph). Root-matching transform declarations in a block that does not match are removed too, because the inlined sheet would otherwise test the query against the output document. An `@container` block never applies to the root: a container query starts from the element's flat-tree parent or nearest ancestor size container, the root has neither, and no container means no match (`ContainerQueryEvaluator::DetermineStartingElement` / `EvalAndAdd`, `core/css/container_query_evaluator.cc:138-203`). `@layer` blocks and `@layer a, b;` statements order the cascade as CSS Cascade 5 does: importance, then layer (a layer's sublayers before its own rules, unlayered last, the order reversed for `!important`; `ComputeLayerOrder`, `core/css/cascade_layer_map.cc:40-66`, and `EncodeLayerOrder`, `core/css/resolver/cascade_priority.h:45-50`), then specificity, then order. Selectors are compared as the DOM sees them: CSS escapes are decoded in identifiers and attribute values, sheet text outside a CDATA section has its XML references expanded, and the root's attribute values are normalized and expanded; a DTD-defined entity leaves a comparison undecided. An `@supports` block applies as the capturing page's Chromium decided it (see **Sheet scoping for `<img>` SVGs** below). A selector the matcher cannot decide, an undecided media or supports condition, or another group rule (`@scope`, `@starting-style`) that could reach the root's transform retains the source image fallback, with a `svg-image-root-transform` warning. Fixtures: `image-svg-root-stylesheet-transform`, `image-svg-document-environment`, `image-svg-root-has`.

  **The image document's media environment.** The image lives in a non-ordinary `Page` (`IsolatedSVGDocumentHost`, `core/svg/graphics/isolated_svg_document_host.cc:105-125`). It copies only fonts, animation policy, `prefersReducedMotion`, `preferredColorScheme`, `inForcedColors` and accept-languages from an ordinary page's Settings (`CopySettingsFrom`, :178-202), and never sees DevTools media overrides (`src/render/svg-image-media.ts`):
  - `hover` / `any-hover` / `pointer` / `any-pointer` keep the Settings defaults: no hover and no pointer (`core/frame/settings.json5:748-777`). `(hover: none)` holds and `(hover)` does not.
  - `prefers-contrast` and `prefers-reduced-transparency` keep `no-preference` (settings.json5:1186-1209).
  - `resolution` and `-webkit-device-pixel-ratio` are 1dppx: `LocalFrame::DevicePixelRatio` multiplies the page's inspector override (1, `core/page/page.cc:276`) by the frame's layout zoom, which is 1 for a frame with no parent (`core/frame/local_frame.cc:288-291, 1839-1846`). dpcm comparisons round to two decimals as `EvalResolution` does.
  - `prefers-color-scheme` is the embedder's: `LayoutImageResource::GetImage` passes `StyleEngine::ResolveColorSchemeForEmbedding(&img style)` to the image (`core/layout/layout_image_resource.cc:227-233`, `core/css/style_engine.cc:4644-4656`). Capture records it on the `<img>` as `imageEmbeddingColorScheme`. When the img's color-scheme flags (its computed `color-scheme`, or for `normal` the first valid `<meta name=color-scheme>`) name no scheme, it is the embedder document's preferred scheme. Otherwise it is the img's used scheme (`ComputedStyleBuilder::SetUsedColorScheme`, `core/style/computed_style.cc:3139-3181`). Forced darkening (a WebView setting) is assumed off.
  - `prefers-reduced-motion` and `forced-colors` follow the Settings the image page copied from the renderer's first ordinary page (`SVGImage::DataChanged`, `core/svg/graphics/svg_image.cc:901-904`; `CopySettingsFrom`, :192-199). The image page has no media overrides, so `MediaValues::CalculatePrefersReducedMotion` (`core/css/media_values.cc:441-459`) and its StyleEngine's forced colors (`core/css/style_engine.cc:4431`) answer from those Settings. The embedding page's `matchMedia` can disagree: a Playwright `reducedMotion` emulation is a page media override that never reaches the image, while `--force-prefers-reduced-motion` sets Settings under Playwright's default `no-preference` emulation, and a `forcedColors` emulation writes the page's Settings (`core/inspector/inspector_emulation_agent.cc:418-430`). Capture therefore asks an SVG image itself, once per capture with an `<img>` in the tree (`src/capture/image-document-settings.ts`): it draws a `data:` SVG whose rect is hidden under each query into a canvas and reads the alpha, which goes through the same `SVGImage` path in the same renderer process. It records `imageDocumentPrefersReducedMotion` / `imageDocumentForcedColors` on each `<img>`, and both features are then decided in its sheets (`PrefersReducedMotionMediaFeatureEval` / `ForcedColorsMediaFeatureEval`, `core/css/media_query_evaluator.cc:1000-1022, 1207-1228`). If the probe cannot run (a CSP that blocks `data:` images, say) they stay undecided with a `svg-image-sheet-media` warning. `tests/img-svg-document-settings.e2e.test.ts` holds the probe to a real `<img>` paint in configurations where the page's `matchMedia` gives the opposite answer. Fixture: `image-svg-document-settings`.

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

**Sheet scoping for `<img>` SVGs.** Blink gives every SVG image its own document, so the image's author sheets reach only its own elements and `:root` means the image root. An inlined `<style>` instead belongs to the whole output document, where an element selector such as `g rect { stroke: … }` would reach every rect in the output and `svg` / `:root` rules would reach the output root. When the source has a `<style>`, `inlineImgSvg` therefore marks the nested root with `data-domotion-image-root="<prefix>"` and rewrites every selector (`scopeImageStyleSheets`, `src/render/svg-image-style-scope.ts`). Each compound gains `:where([data-domotion-image-root="<prefix>"], [data-domotion-image-root="<prefix>"] *)`, which adds no specificity, so the image's rules keep their relative ranking. A compound that already requires one of the image's namespaced classes or ids is left alone. `:root` and `:scope` become the root attribute selector, which has the same specificity. The child-indexed structural pseudo-classes give the root its image-document answer, since the nested root has siblings in the output and the image root has none: `:first-child` becomes `:is(:first-child, <root>)`, and `:nth-child(An+B)` becomes `:is(…, <root>)` when An+B matches index 1, else `:not(:where(<root>))`. Each rewrite keeps the specificity. Conditional group rules (`@media`, `@supports`, `@layer`, `@container`, `@scope`) are scoped recursively, and other at-rules are left alone. An `@media` query is decided against the image viewport (`src/render/svg-image-media.ts`) and frozen as `@media all` / `@media not all`, so the output document's viewport never decides it. The environment features are decided with the image document's answers (see above), even when the image viewport is unknown. A query outside the supported features stays as written, with a `svg-image-sheet-media` warning. Fixtures: `image-svg-document-context`, `image-svg-document-environment`. `@supports` conditions are decided by Chromium itself. Capture resolves each `<img>` SVG source Node-side while the page is alive (`src/capture/image-svg-supports.ts`, after the tree is captured and again after remote images are embedded), collects every `@supports` prelude of its sheets (`collectImageSupportsConditions`, `src/render/svg-image-supports.ts`; XML references expanded outside CDATA), and decides them in one `page.evaluate`. The page answers as an `@supports` rule would: the prelude must parse as an at-rule prelude, because `CSSParserImpl::ConsumeSupportsRule` drops a rule whose condition fails to parse (`core/css/parser/css_parser_impl.cc:1441-1451`), and a parsed condition is then evaluated with `CSS.supports(conditionText)`, which runs the same `CSSSupportsParser::ConsumeSupportsCondition` on the parenthesized text (`CSSParser::ParseSupportsCondition`, `css_parser.cc:371-394`, chromium 7d859f27). `CSS.supports` alone would accept a bare declaration such as `display: grid` that a prelude rejects. The answers are recorded on the capture record as `imageSvgSupports`, keyed by the whitespace-collapsed prelude. The scoped output sheet freezes a decided block as `@media all` / `@media not all`, and the root-transform cascade applies it or not. A condition capture did not decide (a remote SVG that was not embedded, an older tree) retains source image ownership when it can affect the root cascade. Fixture: `image-svg-supports`. Cascade layers are per document too: Blink builds one `CascadeLayerMap` per tree scope from every active sheet, and same-named layers from different sheets merge into one layer whose order is the first declaration across all of them (`CascadeLayerMap::CascadeLayerMap` / `AddLayers`, `core/css/cascade_layer_map.cc:15-60`, chromium 7d859f27). Inlined, an image's layers would join the output document's map, so a second image declaring `@layer b, a` after a first declaring `@layer a, b` would take the first image's order. Every top-level layer name (in a `@layer` block, a `@layer a, b;` statement or an `@import … layer(a)`) therefore gains the image prefix, keeping each image's order to itself. Sublayer names inside a layer block are relative to it and stay as written, and anonymous layers are always distinct. Fixture: `image-svg-layer-scope`. The root's own `id` is part of the id set for the body too, so a `#root rect` rule or `href="#root"` follows the namespaced id. The flattened output needs no marker because its gate already rejects every selector that is not a class or id selector. Fixture: `image-svg-style-scope`.

`prefixSvgClasses` is shared by all three SVG-inlining paths (DM-1595), each gated on `<style>` presence:

- **`<img src="*.svg">`** (`inlineImgSvg`) — namespaces both ids and classes (self-contained file, no cross-SVG refs).
- **Captured DOM inline `<svg>`** (`paintInlineSvg`) — namespaces ids by the captured document/shadow-root scope. Sibling SVGs in one source scope share a prefix, preserving legitimate cross-SVG `<use>` and paint-server references; independent iframe/shadow scopes receive different prefixes before they are combined into the consumer document. Same-scope `href`/`xlink:href`, CSS `url(#…)`, embedded ID selectors, SMIL event references, and ARIA IDREFs are rewritten only when their target exists, so unresolved references remain unresolved. CSS classes retain their separate per-inline-SVG namespace.
- **Animator svg-overlay files** (`namespaceSvgIds` in `src/cli/animate-orchestrator.ts`) — namespaces ids (already) and now classes.

## Data stylesheet imports in SVG image mode (DM-6ZX6W0)

`resolveSvgImageCssImports` expands image-allowed data sheets before root
cascade, global-name isolation, selector scoping and ID rewriting. In a strict
SVG image document Chromium accepts `text/css` and
`application/x-unknown-content-type`; other data MIME types contribute no
rules. HTTP/blob and relative stylesheet loads remain blocked. A rejected
sheet still reserves an active import's named layer, while false import
conditions do not: media/supports wrappers surround the imported layer.
Flattened rules retain their original import position and nested order.

The decoder follows pinned Chromium's byte boundary: percent decoding before
forgiving base64, then BOM, transport charset, initial in-band `@charset`, and
inherited stylesheet encoding. The root environment is UTF-8; non-UTF-8 XML
encoding declarations remain conservative. Image-context differential probes
verify UTF-8, Windows-1252/ISO-8859-1/US-ASCII, and UTF-16LE/BE. Only this set is
admitted; Node `TextDecoder` support alone is insufficient evidence for another
encoding. Every charset parameter is validated before selecting the first
nonempty label: a malformed later token can invalidate the URL in Chromium's
parameter-preserving path. Unsupported or quoted labels, malformed byte
sequences and ambiguous charset parameters retain raster fallback. Nested imports inherit the decoded sheet's
encoding. Decoded bytes, expanded UTF-8 text and serialized XML CSS each stay within 256,000 bytes,
with at most four nested import levels.

XML style character references and CDATA are read as CSS text before
expansion. XML-sensitive `<` and `&` use CDATA; a literal `]]>` splits into
adjacent sections without changing the CSS text. A shared helper joins those
sections before selector, root-cascade and font-name processing and masks
actual comments/wrappers without erasing quoted marker text. Native checks
include marker-bearing selectors, root font/em transforms, comments, and
competing imported data-font families with the same marker-bearing name.

Imported author font faces remain vector for ordinary paint. When metric-dependent
font units occur with an author face, the image retains raster: the existing
isolated root metric provider resolves system fonts and cannot authenticate the
image's own font-face metrics. A native embedded-mono `2ch` probe translates
24 px where the system-font fallback would translate 20 px. Strings and data URL
payload bytes do not count as dimensions for this conservative gate.
DM-NZQE02 tracks authenticated image-local author-font metric resolution.

Declaration resources can use independent canonical `data:` URLs
without escapes, raw markup/quotes/parentheses or ambiguous whitespace. Literal
URL-looking strings do not count as loads. Relative/external URLs,
escaped resource syntax and alternate image functions remain raster-backed;
they cannot acquire the output document's base URL or bind to its IDs. Native
pixel checks cover canonical data SVG paint, filter and mask resources. An
external-fetch control loads in the ordinary host SVG, while the same nested
load stays blocked through the data resource in both native image and inline
output.
DM-Y3H2EV tracks escaped import/URL classification. Literal `</style>` inside imported
CSS remains unrepresentable by downstream stylesheet extraction (DM-5D93J3).
Unknown XML entities, invalid XML characters, undecodable sheets and budget
violations also keep the original raster.

**Authenticated local fragments (DM-YMAF0G).** A literal `url(#id)` can remain
vector for `fill`, `stroke`, `filter`, `clip-path`, `mask`, `mask-image` and the
three marker properties. The SVG image's actual XML element tree supplies the
inventory; comments and CDATA string data cannot invent IDs. Every ID must be
unique, nonempty ASCII letters/digits/underscore/dot/colon/hyphen and written
exactly as `id="..."` or `id='...'`. Lexical attribute evidence proves that the
existing downstream namespace pass will rewrite the same identity. Nested
imports share that image inventory.
Class attributes likewise require canonical assignment spelling and plain ASCII
class names. Escaped selectors and selectors containing attribute or string data
retain raster output until the token-aware image namespace rewrite is available;
native controls cover escaped class names, class assignment whitespace and dots
inside attribute selectors in both flatten modes.
DTD-dependent documents, stylesheet processing instructions and unresolved XML
attribute data remain raster because this lexical inventory cannot prove their
complete DOM state.

Blink records the authored leading `#` in `CSSUrlData` and treats it as local
regardless of the imported sheet's data URL base (`css_url_data.cc:83–96,
231–234`). SVG consumers resolve it in the element's originating tree scope
(`ElementStyleResources::GetSVGResourceFromValue`,
`element_style_resources.cc:281–289`; masks use `LoadMaskSource:374–384`), at
Chromium `7d859f27`. Competing host gradients, clips, filters, masks and markers
therefore must not become candidates after lowering.

Missing/duplicate targets, entity or whitespace ID spellings, percent-encoded
fragments, escaped URL syntax and unproved consumers such as font sources,
background images, cursors and custom properties remain raster. Neighboring
ordinary references must also be owned and rewritable before a newly admitted
fragment image is lowered; canonical gradient `href` chains are preserved.
Unresolved references, unproved attribute serialization and namespace-sensitive
text/string data retain the source image. This admission gate does not repair
the shared ordinary-image namespace rewrite: DM-WT73T4 owns its complete
XML/URL identity and reference handling. Its admission gate remains deliberately
strict after that ordinary-image repair; encoded imported forms are not
silently admitted by the later namespace pass.

### Ordinary image XML identity (DM-WT73T4)

An SVG captured as an image document uses a separate XML-aware namespace pass.
It reads actual XML attribute values, including character references and
whitespace around `=`, and rewrites IDs and their consumers from one image-local
identity inventory. Percent-encoded fragments use Chromium's URL normalization
and UTF8-or-isomorphic decoding: if any decoded byte sequence is invalid UTF8,
the entire sequence becomes isomorphic bytes. CSS URL functions, hash/class
selectors and their escapes are tokenized; ordinary strings, comments and
unrelated attribute/text data remain data. The shared DOM-inline/animation
`prefixSvgIds` API retains its intentional host-reference behavior.

Known image-local references include the nine SVG paint/resource properties
above, `href`/`xlink:href`, ARIA IDREF attributes and SMIL syncbase/eventbase
conditions. IDs/classes and selectors share the same prefix. Original DOM
values of changed attributes are saved under fresh private attribute names;
attribute selector names and CSS `attr()` reads use those original-value
attributes. This preserves equality/substrings, specificity and typed `attr()`
geometry rather than changing which source nodes match. The private names are
chosen outside authored XML and decoded CSS vocabulary.

Duplicate/empty IDs, unknown XML data, missing targets, relative/external
references, unsupported URI consumers, namespace/base-URL ambiguity, dynamic
animation of identity/reference attributes and unproved selector syntax retain
the source image fallback. A missing target therefore preserves its original
fallback paint instead of binding to a same-named host target. URL-bearing
custom properties remain conservative. DTD-bearing images are also retained;
DM-1YAE1F tracks source-proving harmless self-contained doctypes. Stylesheet
processing instructions remain outside lexical authentication. This pass does
not relax data-import MIME/charset/depth/size or fragment admission gates.
It still relies on the caller's generated namespace being distinct from other
output IDs. DM-R7ME85 tracks the separate existing ambiguity in concatenating
numeric image prefixes with authored IDs and wrapper helper suffixes.

The source contract is Chromium `7d859f27`:
[`SVGURIReference::FragmentIdentifierFromIRIString`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/svg/svg_uri_reference.cc),
[`CSSURIValue::NormalizedFragmentIdentifier`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/css/css_uri_value.cc),
[`DecodeUrlEscapeSequences`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/url/url_util.cc#L833-L890),
and [`SVGSMILElement::ParseCondition`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/svg/animation/svg_smil_element.cc#L562-L664).

The source contract is Chromium `7d859f27`:
[`CSSStyleSheetResource::CanUseSheet`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/loader/resource/css_style_sheet_resource.cc),
[`DataURL::Parse`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/net/base/data_url.cc),
and [`TextResourceDecoder`](https://github.com/chromium/chromium/blob/7d859f271cbda744098ac69f44978d4edfa62be3/third_party/blink/renderer/core/html/parser/text_resource_decoder.cc).

## Scope / known boundaries

- **`<filter>` regions, `currentColor`, and CSS custom properties** inside the SVG resolve against the nested `<svg>` context, matching how the browser resolves them for the original `<img>` in the common cases (design-tool exports with self-contained gradients/filters). SVGs that rely on inheriting `color` / CSS variables from the host page are out of scope.

## Testing

- `src/render/svg-image-references.test.ts` checks XML/URL identity decoding,
  selector/string preservation, fresh private names, href/ARIA/SMIL consumers
  and conservative ambiguous-input fallbacks. The native
  `tests/img-svg-reference-identity.e2e.test.ts` compares source image paint to
  captured output under competing host IDs in both flatten modes, including
  explicit typed `attr()` source geometry checks. Import overlap remains in
  `tests/img-svg-import-fragments.e2e.test.ts`.

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
