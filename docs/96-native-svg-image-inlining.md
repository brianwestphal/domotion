# 96 — Native inlining of `<img src="*.svg">`

## Summary

When a captured page references an SVG through an `<img>` (or any replaced image whose source resolves to `image/svg+xml`), Domotion inlines the SVG as a **native, positioned `<svg>`** in the output rather than embedding it as `<image href="data:image/svg+xml;base64,…">`. The result is truly resolution-independent (crisp at any zoom), smaller (no ~33% base64 bloat), and more cross-engine-robust than an SVG-in-`<image>`.

This is the *inverse* of the raster-image fallbacks catalogued in [reference/raster-image-fallback-cases.md](reference/raster-image-fallback-cases.md): instead of turning a paint we can't express into a raster, we turn a raster-ish embedding into crisp vector.

## Motivation

Chromium paints an SVG referenced from an `<image>` (or an `<img>`) by rasterizing it at the element's **layout size** and then scaling that raster. So an SVG logo displayed at 100×100 is rasterized to ~100×100 device pixels (times DPR) and any subsequent zoom scales those pixels — the edges soften and alias. This was the user-reported symptom on the `brand-mixed` demo: the embedded `assets/logo.svg` looked pixelated at 3× zoom.

A nested native `<svg>` carries live vector geometry (paths, gradients, filters). The browser scales the *geometry*, not a bitmap, so it stays razor-sharp at any scale — and the payload is the SVG's own markup rather than a base64 blob roughly one-third larger than the raw bytes.

## Behavior

### Trigger

The native path fires when, and only when, the `<img>`'s source resolves to an SVG. `resolveSvgSource(el.imageSrc)` (`src/capture/embed.ts`) resolves the source the same way the `<image href>` path does — via `embedAsDataUri` (file read, `file://` decode, or a pre-fetched remote `_dataUriCache` hit) — and returns the decoded SVG text only when the mime is `image/svg+xml`. It returns `null` (→ raster `<image>` path) for:

- raster sources (PNG / JPEG / GIF / WebP / AVIF),
- remote SVG URLs that were not pre-fetched into a data URI (we don't have the bytes),
- decode failures.

`resolveSvgSource` deliberately does **not** consult `_resizedDataUriCache`: the image-resize pre-pass ([27-image-resize-on-embed.md](27-image-resize-on-embed.md)) rasterizes SVGs to PNG via `sharp`, which is exactly what this feature avoids. The native path always works from the original vector bytes.

### Rewrite

`inlineImgSvg` (`src/render/svg-inline.ts`) rewrites the SVG file's source into a nested `<svg>` ready to drop into the output:

1. **Coordinate system.** It uses the SVG's own `viewBox`; if there is none it synthesizes one from the SVG's absolute `width`/`height` attributes, and failing that from the `<img>` intrinsic size (`el.imageIntrinsic`). With no coordinate system available at all (no viewBox, no absolute size, no intrinsic size — e.g. a percentage-sized SVG), it returns `null` and the caller keeps the raster `<image>` path, because a nested `<svg width/height>` with no viewBox can't scale its contents into the placement rect.
2. **Placement.** It strips the source root's `x` / `y` / `width` / `height` / `viewBox` / `preserveAspectRatio` and re-declares them: `x`/`y` at the element's **content-box** top-left, `width`/`height` at the content-box size, `viewBox` from step 1, and `preserveAspectRatio` derived from the CSS `object-fit` / `object-position` (`preserveAspectRatioFor`). Everything else on the root tag (`xmlns`, `class`, `style`, `role`, …) is preserved.
3. **Id namespacing.** `prefixSvgIds` prefixes every `id`, `href="#…"`, `xlink:href="#…"`, and `url(#…)` with a per-document-unique prefix (allocated from the renderer's id counter) so the inlined SVG's internal gradients / clipPaths / filters / masks / `<use>` targets can't collide with ids elsewhere in the output document or in another inlined SVG.

The result is emitted by `paintImage` in `src/render/element-tree-to-svg.ts`. A `border-radius` on the `<img>` wraps the nested `<svg>` in a `<g clip-path="url(#…)">` using the same rounded-content-box clip the raster path uses.

`prefixSvgIds` is shared with the animator's SVG-overlay inliner (`namespaceSvgIds` in `src/cli/animate.ts`), so the namespacing regexes live in exactly one place.

## object-fit coverage

All `object-fit` values take the native path:

- `fill` (default), `contain`, `cover`, and `scale-down` place the nested `<svg>` at the content box with a `preserveAspectRatio` derived from `object-fit` / `object-position` (the standard branch).
- **`object-fit: none`** (DM-1592) places the nested `<svg>` at the SVG's **intrinsic size** (`el.imageIntrinsic`), positioned by `object-position` inside the content box and clipped to it — the native counterpart of the raster intrinsic-size branch. Since `iw×ih` *is* the SVG's intrinsic size, its own viewBox maps 1:1 and `preserveAspectRatio="xMidYMid meet"` (the SVG default) keeps that exact with no distortion. Falls back to the raster `<image>` when the source isn't SVG or has no coordinate system.

## Scope / known boundaries (v1)

- **CSS class selectors inside an SVG `<style>` block are not namespaced.** `prefixSvgIds` rewrites ids and hash/`url(#…)` references but not class names, so two inlined SVGs that both define, say, `.cls-1` in a `<style>` block could cross-contaminate. Id-based collisions (the common case for gradients/filters exported by design tools) are fully handled; class-based `<style>` collisions are a rarer follow-up. This matches the existing behavior of the inline-`<svg>` DOM path (`paintInlineSvg`), which emits `<style>` blocks without namespacing class names.
- **`<filter>` regions, `currentColor`, and CSS custom properties** inside the SVG resolve against the nested `<svg>` context, matching how the browser resolves them for the original `<img>` in the common cases (design-tool exports with self-contained gradients/filters). SVGs that rely on inheriting `color` / CSS variables from the host page are out of scope.

## Testing

- `src/render/svg-inline.test.ts` — `prefixSvgIds` namespacing (both quote styles, external-URL passthrough); `inlineImgSvg` (viewBox preservation, width/height synthesis, intrinsic fallback, no-coordinate-system → `null`, no-root → `null`, XML-decl stripping); and end-to-end through `elementTreeToSvgInner` (SVG `<img>` → native `<svg>`, raster `<img>` → `<image>`, border-radius clip wrapper).
- `src/render/resolve-svg-source.test.ts` — `resolveSvgSource` decode (base64 + URL-encoded), raster → `null`, remote → `null`, empty/nullish → `null`.
- The `brand-mixed` demo golden exercises the full path (the `lower-third` brand logo is an `<img src="*.svg">`).

## Files

- `src/capture/embed.ts` — `resolveSvgSource`.
- `src/render/svg-inline.ts` — `prefixSvgIds`, `inlineImgSvg` (+ the `InlineSvgPlacement` shape).
- `src/render/element-tree-to-svg.ts` — `paintImage` native-SVG branch.
- `src/cli/animate.ts` — `namespaceSvgIds` now delegates to the shared `prefixSvgIds`.
