# Domotion: Supported Features

Each feature has a visual regression test that compares HTML-to-PNG with SVG-to-PNG.

## Rendering Features

### Text
- [x] **text-basic**: Plain text rendering (font-size, font-family, color)
- [x] **text-bold**: Bold/weight text
- [x] **text-center**: Centered text (text-align: center)
- [x] **text-right**: Right-aligned text
- [x] **text-mono**: Monospace font rendering
- [x] **text-multiline**: Multiple lines of text in a container
- [x] **lineheight-residual**: Baseline pixel-grid snap on fractional line-height baselines (18px × 1.6 → 28.796875px line boxes; Skia rounds glyph y to integer device pixels)
- [x] **text-small**: Small/label text (11-12px)
- [x] **text-inline-mixed**: Mixed inline content (prose with inline code spans)
- [x] **text-pre-multiline**: Preformatted multiline text (`<pre>` with `white-space: pre`)
- [x] **text-font-stretch-underline**: CSS `font-stretch` end to end — condensed/expanded cut selection for declared families (Blink's trait-based style matcher), the `wdth` variation axis on the macOS `system-ui` face and variable webfonts, and decoration metrics resolved on the same width-matched face as the glyphs

### Backgrounds & Colors
- [x] **bg-solid**: Solid background colors
- [x] **bg-transparent**: Semi-transparent backgrounds (rgba)
- [x] **bg-nested**: Nested backgrounds (child on top of parent)
- [x] **bg-conic-gradient** (DM-547, DM-2327, doc 28): `conic-gradient` / `repeating-conic-gradient` background layers via Chromium-painted pattern tiles — covers smooth, checkerboard, from/at, multilayer, and advanced-color effective-zoom fixtures; CPU rasterization is helper-absent best effort only
- [ ] **bg-dark-mode** (DM-455, doc 29): Dark-mode capture support — caller-chosen `colorScheme`, dark form-control palette, scheme-aware transparent-root fallback

### Borders
- [x] **border-solid**: Solid borders with color
- [x] **border-radius**: Rounded corners
- [x] **border-radius-pill**: Fully rounded (pill shape)
- [x] **inline-box-decoration-break**: wrapped inline backgrounds / borders paint per line-fragment (`slice` + `clone`); first/last fragment own the start/end edges in slice mode, every fragment paints a full box in clone mode

### Layout
- [x] **layout-flex-row**: Horizontal flex layout with gap
- [x] **layout-flex-col**: Vertical flex layout
- [x] **layout-flex-center**: Centered content (justify-content/align-items)
- [ ] **layout-grid**: CSS Grid layout
- [ ] **layout-absolute**: Absolute positioning
- [x] **layout-padding**: Padding affecting content position
- [x] **float-paint-order-context-wide** (doc 01 § Stacking): a stacking context paints in CSS 2.1 Appendix E phases — every in-flow block's background + border (step 3), then every non-positioned float (step 4), then all inline content (step 5). So a float paints above a later block sibling's background and below the text of every paragraph in the context, and an `inline-block` / flex item keeps its own floats (it paints atomically).
- [x] **perspective-fixed-containing-block-ownership** (DM-2385, doc 06): computed `perspective` creates a real stacking context and fixed-position containing block; asymmetric `perspective-origin` is captured as resolved pixels but has no ownership effect by itself. Computed `transform-style: preserve-3d` still traps fixed descendants when `overflow:hidden` flattens its used 3D style, while `perspective:none` remains the viewport-fixed negative control.
- [x] **animated-projective-frame-state** (DM-2359/DM-2356/DM-2492/DM-2493, docs 186/189): `animationTimeMs` exactly pauses document timelines before all capture prepasses and exposes the CDP quad, composed 3D state, residual, and selected atomic raster owner without a fitted 2D approximation. Same-frame used-preserve facts select Blink's direct-parent rendering-context root; a strict 25-family/four-profile native three-OS DPR-1/2 gate rejects larger crops, warnings, restoration drift, incomplete evidence, and nine ownership mutations.

### Components
- [x] **comp-button**: Button with background, border, padding, text
- [x] **comp-badge**: Small badge with colored background and text
- [x] **comp-card**: Card with background, border, radius, content
- [x] **comp-card-badge**: Card with inline badge (flex row with mixed components)
- [x] **comp-input**: Form input with border and placeholder-style text
- [x] **comp-input-value**: Native `<input>` element with value attribute
- [x] **native-control-decoration-split** (DM-2455, doc 171): styled select/temporal/search/number hosts and value text remain structural while exact Chromium menulist-arrow and closed-shadow picker/cancel/spin layers are isolated into fail-closed transparent overlays; base-select remains fully vector.
- [x] **comp-code-block**: Code block with monospace, background, border
- [ ] **comp-nav**: Navigation bar with logo and links

### SVG
- [x] **svg-inline**: Inline SVG elements are cloned as self-contained vectors; CSS-only clip/mask effects preserve native fill-box, stroke-box, and view-box resolution (DM-2328)
- [x] **clip-path-url-reference-ownership** (DM-2362, docs 39/130): bare same-document/external URL clips preserve HTML border/object-bounding-box and SVG forced-fill ownership; Blink-invalid URL-plus-box declarations stay inactive, including stale captured trees and nested frames.

### Masks
- [x] **mask-contain-cover-arbitrary-position** (DM-2379, doc 20): URL masks capture Chromium-decoded intrinsic ratios and emit concrete Blink-fitted rectangles for percentage, length, and calc positions; zoom/DPR, physical writing axes, multilayer, and slice/clone fragment controls reject the retired SVG Min/Mid/Max buckets.

### Text effects
- [x] **text-bg-clip-gradient** (DM-462): `background-clip: text` + `-webkit-text-fill-color: transparent` — gradient fills the glyph shapes via SVG `<mask>` over the bg-color rect
- [x] **pseudo-filter-functions** (DM-2367, doc 38): generated empty/text/image paint supports blur, drop-shadow, brightness, contrast, grayscale, hue-rotate, invert, opacity, saturate, sepia, and ordered lists through Chromium's native SVG CSS-filter pipeline; identity/none, transform, clip, stack slot, zoom, DPR, and filter-stripped mutation controls are browser-gated.

### Replaced elements (rasterized as static snapshot — DM-457)
- [x] **replaced-canvas-shape**: `<canvas>` with drawn shapes — bitmap survives via `page.screenshot`
- [x] **replaced-video-poster**: `<video poster=…>` paused — poster image captured
- [x] **replaced-canvas-overlay**: `<canvas>` under a positioned `<div z-index:10>` overlay — overlay does NOT bleed into the canvas snapshot
- [x] **replaced-canvas-fixed-overlay**: `<canvas>` under a sibling-positioned `<div>` painting on top — sibling does NOT bleed into the canvas snapshot
- [x] **replaced-iframe-same-origin** (DM-1441): same-origin `<iframe>` (srcdoc) — content **recurses into native SVG** (crisp/scalable/selectable), not rastered; pixel-identical to the prior snapshot. See [docs/81](docs/81-iframe-recursion.md).
- [x] **iframe-recursion-bordered** (DM-1441): same-origin iframe recursion through a non-zero border + padding on the iframe — inner document's origin lands at the iframe **content box** and the inner subtree clips to it.
- [x] **iframe-canvas-bg-fill** (DM-1448): recursed iframe **taller than its content** — the inner document's propagated canvas background (html-bg-or-else-body-bg) fills the whole inner viewport, so the strip below the content paints the canvas color instead of showing through to the outer page.
- [x] **iframe-inner-clip-mask** (DM-1446): recursed iframe whose inner content uses `clip-path: url(#id)` + `mask-image: url(#id)` defined in the **iframe's own** `<defs>` — fragment refs resolve against `el.ownerDocument`, so the `<clipPath>`/`<mask>` defs hoist and paint (clipped circle + masked square-with-hole, 0.00%). (Inner `element(#id)` paint refs are frame-aware — DM-1447 — though CSS `element()` itself is unsupported in Chromium / dormant, DM-1450; tall-iframe canvas-bg fill shipped in DM-1448.)
- [x] **multi-layer-fragment-mask** (DM-2520): ordered local SVG mask layers keep per-layer TreeScope, units/region, mode, composite, and consumer zoom across duplicate outer/iframe ids; two-/three-layer add/intersect/subtract/exclude output is raw-RGBA exact to Chromium at DPR 1/2, with destructive scope/operator/mode/zoom controls.
- [x] **cross-origin iframe recursion** (DM-1442): `--cross-origin-frames "*"|host[:port],…` (config: `captureCrossOriginFrames`) recurses **allowlisted** cross-origin frames into native SVG by launching Chromium with web security disabled; non-allowlisted frames stay raster. Default off + a stderr security warning (disabling web security disables CORS). Unit + e2e tested (`tests/cross-origin-iframe-recursion.e2e.test.ts`). See [docs/81](docs/81-iframe-recursion.md).
- [x] **snapshot-isolation-pseudo-overlay** (DM-458, `tests/snapshot-isolation.tsx`): canvas covered by a sibling's `::after` pseudo overlay. Inspection-style — decodes the captured snapshot's PNG data URI and asserts no overlay-color pixels leaked through. Catches regressions in the hide-everything-else stylesheet that a comparison-style fixture wouldn't.

### Showcase Integration Tests
- [x] **showcase-typography**: Full-page layout with headings, badges, code blocks, inline code, status text
- [x] **showcase-cards**: Card list with badges, buttons, metadata
- [x] **showcase-forms**: Publish form with labels, inputs, pre block, button

### Composed Parity Integration Tests
- [x] **composed-multilingual-flex-grid**: Platform fallback and bidi isolation inside flex/grid messaging UI, with neutral-wrapper and node-split relations
- [x] **composed-responsive-fragmented-controls**: Native controls inside responsive multicol layout with equivalent grid syntax
- [x] **composed-gradient-mask-clip-stacking**: Gradients, masks, and clips under explicit stacking ownership and reversed DOM order
- [x] **composed-svg-effects-translation**: Inline SVG filter/clip/marker effects under translation covariance
- [x] **composed-zoom-transform-scale**: Effective zoom, nested transforms, and scale-normalized geometry
- [x] **composed-same-origin-iframe**: Native same-origin recursion containing fallback, bidi, gradient, mask, and clip decisions
- [x] **composed-dynamic-replaced-freeze**: Transformed canvas pixels frozen at capture under an independently stacked vector overlay

## Testing Approach

Tests are defined in `tests/features.ts` (26 feature tests) and `tests/showcase.ts` (3 integration tests). Both use the shared runner in `tests/runner.ts`.

For each test case:
1. Define an HTML snippet (feature tests) or full-page HTML (showcase tests) exercising the feature
2. Render the HTML in Playwright (Chromium) and capture as PNG ("expected")
3. Capture the DOM via `captureElementTree` on the Playwright page
4. Convert the element tree to SVG via `elementTreeToSvg` using the selected text rendering mode
5. Render the SVG in Playwright and capture as PNG ("actual")
6. Compare pixel-by-pixel with per-channel tolerance (threshold 16, pass if < 8% total diff)
7. Save expected, actual, and diff PNGs to `tests/output/` for visual inspection

### Text Rendering Modes

The runner accepts a `--mode` flag (or `TEXT_MODE` env var) to select the text rendering strategy:

- **`css`** (default): SVG `<text>` with CSS font properties. Smallest output (~20KB). Best fidelity in Chromium (~0.6% diff). Cross-browser differences from font engine differences.
- **`path`**: Fontkit converts text to `<path>` outlines using macOS system fonts (SFNS.ttf variable font). Glyph deduplication via `<defs>`/`<use>`. Identical across browsers but larger (~290KB).
- **`font`**: Embedded woff2 `@font-face` with subsetted system fonts. Uses subset-font for character subsetting, wawoff2 for compression. Largest output (~550KB).

### Running Tests

```bash
# Run all feature tests (default css mode)
npx tsx tests/features.ts

# Run a single feature test
npx tsx tests/features.ts --only text-basic

# Run with a specific text mode
npx tsx tests/features.ts --mode path

# Run showcase integration tests
npx tsx tests/showcase.ts
```
