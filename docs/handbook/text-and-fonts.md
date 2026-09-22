---
id: "handbook/text-and-fonts"
title: "Text and fonts handbook"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-1775", "DM-2596", "DM-2643"]
code:
  [
    "src/capture/script/index.ts",
    "src/capture/script/walker/text-segments.ts",
    "src/render/font-resolution.ts",
    "src/render/glyph-helper-font.ts",
    "src/render/glyph-helper-outline.ts",
    "src/render/glyph-helper-protocol.ts",
    "src/render/glyph-helper-transport.ts",
    "src/render/glyph-helper.ts",
    "src/render/linux-target-strike.ts",
    "src/render/real-text-layer.ts",
    "src/render/text-to-path.ts",
    "src/render/text-engine.ts",
    "src/render/text.ts",
    "tests/feature-coverage.ts",
  ]
aliases: ["docs/handbook/text-and-fonts.md"]
---

# Text and fonts handbook

This is the current normative entry point for text. Detailed algorithms,
upstream source traces, corpora, and retained runs remain in the linked records.

## Contract

1. On one machine and browser profile, Domotion must preserve Chromium's face
   selection, glyph sequence, UTF-16 clusters, advances, offsets, line geometry,
   writing direction, and decoration ownership before raster differences are
   considered. Cross-machine equality is not promised when font inventories differ.
2. CSS family lists, generic families, `unicode-range`, language/script,
   variation axes, features, synthesis, emoji presentation, MathML, bidi, and
   vertical writing participate in selection and shaping. Unsupported or
   unauthenticated branches fail closed with diagnostics rather than silently
   substituting a guessed face.
3. Webfonts use their captured bytes. System fonts resolve through platform
   APIs: CoreText on macOS, Fontconfig/FreeType on Linux, and DirectWrite on
   Windows. Native helpers are acquired and authenticated on demand; missing
   helpers retain an explicit compatibility boundary.
4. Text normally emits glyph outlines as SVG paths. Bitmap/color glyphs and
   paint-only effects use their declared specialized route. Placement stays in
   captured physical coordinates, including fragmentation, transforms, zoom,
   vertical orientation, and generated content.
5. Logical agreement is exact. Native raster comparison is a later,
   fingerprinted platform gate and may not hide a face, shaping, placement, or
   metric disagreement.
6. Single-frame captures may opt into an authored `<text>` layer for inline-SVG
   search, selection, copy, and accessibility. It explicitly owns no paint,
   suppresses duplicate visual-run labels, does not serialize source font
   families, and leaves default output unchanged. See [doc 260](../260-inline-svg-real-text-layer.md).
7. Text emission has three modes (`RenderTextMode`): the default `embedded-font`
   and `paths` are both pixel-faithful; the opt-in `system-font` instead paints
   authored `<text>` with the source `font-family` stack via the CONSUMER's
   installed fonts (smaller output, **not** pixel-faithful, run-anchor-only
   positioning, browser-owned bidi). Selected by `--text-mode` /
   `setRenderTextMode` / `elementTreeToSvg({ renderTextMode })`. See
   [doc 261](../261-system-font-render-text-mode.md).
8. Font resolution and shaping form one text engine. Callers that need an
   independently scoped renderer use `TextEngineSession` and
   `withTextEngineDocument`; the document owns text mode, fallback lifetime,
   generated artifacts, and diagnostics. Nested adapters join that document
   rather than coordinating resolver globals directly. See
   [doc 262](../262-text-engine-session-boundary.md).

## Verified implementation map

| Area                         | Current contract                                                                                                                                                                       | Primary implementation and tests                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Family and generic selection | [Font family chain](../03-font-family-chain.md), [system resolver](../80-cross-platform-system-fallback-resolver.md), [generic semantics](../206-generic-family-semantic-ownership.md) | `src/render/font-resolution.ts`, `src/capture/script/index.ts`, `tests/font-family-stack-capture.e2e.test.ts`                                          |
| Shaping and clusters         | [Production shaping](../115-production-harfbuzz-shaping.md), [browser substitution streams](../220-browser-harfbuzz-substitution-streams.md)                                           | `src/render/text.ts`, `tools/unified-shaping-oracle.ts`, `tools/browser-harfbuzz-substitution-oracle.ts`                                               |
| Layout and bidi              | [Layout parity](../116-layout-stage-parity.md), [bidi ownership](../214-mixed-script-bidi-logical-geometry.md)                                                                         | `src/capture/script/walker/text-segments.ts`, `tools/layout-stage-oracle.ts`, `tools/mixed-bidi-logical-oracle.ts`                                     |
| Native outlines              | [Glyph extraction](../16-coretext-glyph-extraction.md), [Linux](../45-linux-glyph-extraction.md), [Windows](../41-windows-glyph-extraction.md)                                         | `src/render/glyph-helper-{transport,protocol,outline,font}.ts`, `src/render/linux-target-strike.ts`, native helpers, `src/render/glyph-helper.test.ts` |
| Paint and decoration         | [Text decoration](../207-cross-platform-decoration-geometry.md), [background clip](../18-background-clip-text.md)                                                                      | `src/render/text.ts`, `src/render/text-to-path.ts`, `src/render/decoration-fragment-ownership.ts`, decoration oracle tests                             |
| Inline text semantics        | [Opt-in real-text layer](../260-inline-svg-real-text-layer.md)                                                                                                                         | `src/render/real-text-layer.ts`, `src/render/real-text-layer.test.ts`, `tests/real-text-layer.e2e.test.ts`                                             |
| Text-emit mode               | [system-font render text mode](../261-system-font-render-text-mode.md)                                                                                                                 | `src/render/text-to-path.ts` (`renderTextAsSystemFont`), `src/render/text.ts`, `src/cli/capture.ts`, `src/render/system-font-mode.test.ts`             |
| Engine lifecycle             | [Text-engine session boundary](../262-text-engine-session-boundary.md)                                                                                                                 | `src/render/text-engine.ts`, `src/render/text-engine.test.ts`, `src/render/text-engine-boundary.test.ts`                                               |
| Fallback and evidence        | [Same-machine contract](../120-same-machine-text-parity-contract.md), [renderer provenance](../143-production-text-run-provenance.md)                                                  | `src/render/text-run-provenance.ts`, `tools/renderer-font-route-oracle.ts`, native platform workflows                                                  |

## Boundaries

The exact SFNS terminal-mask ratification remains a macOS evidence problem; it
does not weaken the shipped logical contract. Consult the generated index for
partial evidence and investigations before extending a specialized branch.
