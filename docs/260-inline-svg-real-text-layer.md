---
id: "requirements/inline-svg-real-text-layer"
title: "260 — Opt-in real-text layer for inline SVG"
kind: "contract"
status: "current"
owners: ["text-fonts", "rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-1775","DM-2715","DM-6SQXGF"]
code: ["src/cli/capture.ts","src/cli/animate-command.ts","src/cli/animate-orchestrator.ts","src/cli/animate-frame-capture.ts","src/scroll/composer.ts","src/animation/compressed-run.ts","src/render/element-tree-to-svg.ts","src/render/real-text-layer.ts","src/render/text-to-path.ts","src/render/text.ts","src/render/pseudo-fragments.ts","src/render/real-text-layer.test.ts","tests/real-text-layer.e2e.test.ts","tests/animate-real-text.e2e.test.ts"]
aliases: ["docs/260-inline-svg-real-text-layer.md","doc-260"]
---

# 260 — Opt-in real-text layer for inline SVG

Domotion can append a paintless layer of authored SVG `<text>` runs to a
single-frame capture. The visible output remains the existing authenticated
glyph geometry. The second layer exists only so an inline `<svg>` has searchable,
selectable, copyable text and a real accessibility text flow.

This is deliberately opt-in. Use `domotion capture page.html --real-text` or
`elementTreeToSvg(tree, width, height, { realTextLayer: true })`. Omission and
explicit `false` preserve the previous output byte-for-byte.

## Required representation

- Every real-text layer is a root-level
  `<g data-domotion-real-text-layer="true" fill="none" stroke="none"
  xml:space="preserve">`. Both paint properties are explicit. Consumer font
  fallback therefore cannot paint even if a viewer changes its defaults.
- Each captured run becomes one ordinary `<text>` child. It uses the captured
  font size, baseline, width, writing mode, direction, and Chromium-owned
  per-code-unit x/y positions. It does not serialize an authored `font-family`
  or an external resource reference.
- Authored text comes from the segment's `dom-text-utf16-v1` source mapping.
  This preserves source case and length-changing `text-transform` input for
  search/copy. When source mapping is unavailable, the captured rendered string
  is the fallback. Password inputs remain the already-captured bullet string;
  plaintext values are not recovered.
- UTF-16 positions collapse to one SVG position per Unicode scalar. When a
  length-changing transform has no internal CSSOM coordinates, the run keeps
  its captured start and `textLength`; Domotion does not invent glyph anchors.
- Current captures use `blink-text-fragment-affine-v2`: the layer applies the
  complete captured paint matrix at SVG root. Legacy or failed affine records
  retain their existing viewport-space run coordinates.
- Generated line-clamp ellipses are not authored text and are omitted. Captured
  generated/pseudo text without a DOM source mapping remains in stable capture
  order.

Chromium's FragmentItem `StartOffset`/`EndOffset`/`TextLength` contract is the
authority for authored UTF-16 ownership
(`external/chromium/third_party/blink/renderer/core/layout/inline/fragment_item.h:448-451`).
SVG positioning and `textLength` are native SVG text-content/positioning
attributes (`external/chromium/third_party/blink/renderer/core/svg/svg_text_content_element.h:68-73`
and `svg_text_positioning_element.h:35-45`). HarfBuzz glyph clusters remain indices
into the original text (`external/harfbuzz/src/hb-buffer.h:47-56`); this layer
does not reinterpret clusters or reshape the visible capture.

## Accessibility ownership

The normal renderer labels each visual glyph run as an image. With the
real-text option active, those text-only visual wrappers switch to
`aria-hidden="true"`, while the paintless `<text>` nodes own the readable flow.
This prevents duplicate announcements. Non-text semantics such as broken-image
fallback labels are not globally hidden. A caller-supplied root `<title>` is
retained, but `role="img"` is not placed on that root because an image role would
flatten the descendant text flow.

## Gates

- A text-heavy live capture rendered with and without the layer must compare at
  `regionCount === 0`, `strictRegionCount === 0`, and `nonAaPixels === 0`.
- Chromium must find the authored string with Find-in-Page, expose it as
  `StaticText` through the accessibility protocol, and return it from a DOM
  selection range.
- The production SVGO pass must retain the layer, its source strings, and both
  `fill="none"` and `stroke="none"`.
- Default rendering must emit no layer and retain its previous run labels.

## Multi-frame composition (DM-6SQXGF)

`--real-text` composes with multi-frame outputs — animated flipbooks
(`animate --real-text` / config `realText: true`), `capture --scroll`, compressed
editing runs, and Studio/composite layers. The contract is **active-frame
ownership**: only the currently on-screen frame's authored text is exposed to
Find-in-Page and assistive technology; other frames' text is not.

This falls out of the existing hide mechanism rather than any per-frame
bookkeeping. The animator and scroll composer hide inactive frames/segments with
a **`visibility: hidden` keyframe** (DM-641), and Chrome's Find-in-Page and the
accessibility tree both **exclude `visibility:hidden` text** (`opacity:0` text is
still found — so relying on the visibility track, not opacity, is load-bearing).
So the layer is emitted **inside each visibility-gated group**, inheriting its
window:

- **Animated flipbook**: one layer per frame, inside its `<g class="f f-N">`
  (`animate-frame-capture.ts`). Frame hoisting/culling is per-frame, so no
  cross-frame duplication.
- **`--scroll`**: one layer per visibility-gated content region — each scroll
  segment plus the hoisted sticky/fixed/static layers (`scroll/composer.ts`).
  Hoisting places each element's content in exactly one region.
- **Compressed run**: a run flattens N states into one emission with `opacity`
  birth tracks (which stay find-in-page-visible) and synthetic glyph elements
  (no `TextSegment`s), so per-state gating is impossible. Instead it emits **one**
  layer from the **final state's** tree — a stable deduplicated story flow;
  intermediate typing prefixes are deliberately not exposed
  (`animation/compressed-run.ts`, and the uncompressed `composeStatesFlipbook`
  fallback matches it).
- **Composite**: needs no real-text-specific code. Layers are pre-rendered with
  their own real text; `namespaceEmbeddedAnimatedSvg` rewrites ids/classes/fonts/
  keyframes only and leaves the paintless `data-domotion-real-text-layer` group
  and its `<text>` untouched. Stacked layers are simultaneously visible, so each
  contributing its own active-frame text is correct (no cross-layer dedup).

In every path the visible glyph runs switch to `aria-hidden="true"` while a layer
owns their readable string (`withRealTextLayerVisualSemantics`, scoped per
frame/state/layer), and the layer stays paintless, so the composed paint is
byte-identical — **zero visual regions**.

## Honest limits

- `<img src="capture.svg">` remains an image: its inner SVG DOM is neither
  searchable nor selectable and is not exposed as document text. Inline
  `<svg>` is required. The same caveat applies to image-only preview surfaces.
- `--real-text` still **rejects paged capture** (its authenticated native SVG
  bytes have a separate contract). Multi-frame animation/scroll/compressed/
  composite are supported (DM-6SQXGF, above); the niche animate frame *types*
  built from non-DOM sources — terminal (`tr`), jsReveal (`jr`), and pre-rendered
  embedded frames — do not yet inject a layer and are tracked separately.
- Text selection geometry is anchored to captured run positions, but native
  selection highlight details and accessibility presentation remain properties
  of the consuming browser and assistive technology.
