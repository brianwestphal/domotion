---
id: "requirements/opentype-math-radical-geometry"
title: "OpenType MATH radical geometry"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-WGF8AE", "DM-XZZ0MS"]
code:
  [
    "packages/text-engine/src/render/open-type-math.ts",
    "packages/text-engine/src/render/math-radical-shape.ts",
    "packages/text-engine/src/render/text-to-path.ts",
    "src/capture/script/walker/style-record.ts",
    "src/capture/types.ts",
    "src/render/element-tree-to-svg.ts",
  ]
aliases: ["docs/264-opentype-math-radical-geometry.md", "doc-264"]
---

# OpenType MATH radical geometry

For a MathML `<msqrt>` or `<mroot>` whose selected primary face has an OpenType MATH table, Domotion reads the four radical `MathConstants` values from the raw SFNT table: `RadicalVerticalGap`, `RadicalDisplayStyleVerticalGap`, `RadicalRuleThickness`, and `RadicalExtraAscender`. It captures the radical's own computed, inherited CSS `math-style` and uses the display gap for `normal` or the regular gap for `compact`. This includes radicals nested in rows and fractions, and author `math-style` overrides. Older captured trees without this field retain the parent-display inference. The captured radicand box supplies the base height and position. The bar extends from the radical operator advance to the radicand's right edge, with Blink's layout-unit and pixel snapping. A font without MATH keeps the underline-thickness fallback described in `text-to-path.ts`.

The vertical `MathGlyphConstruction` for U+221A supplies ready-made glyph variants and, when those are too short, a bottom-to-top assembly. Selection tests each variant's **ink height** against the radicand height plus gap and rule, as Blink's `StretchyOperatorShaper` does. An assembly repeats extender pieces until the requested height is reached and overlaps connectors within the font's minimum and maximum limits. The renderer emits every selected outline as a separate SVG glyph use. It reads MATH bytes through fontkit's SFNT stream; for native-helper faces, it reopens the resolved physical source face by path and collection index while retaining the helper's live glyph outlines.

On a macOS host with STIX Two Math, a Chromium 1× sweep at 12, 16, 22, 30, 40, 50, and 60 px measured the base offset and painted bar rows in both display and compact math style. The emitted bar rows, thicknesses, and right edges matched all fourteen observations. The focused `mathml-radical-math-table-geometry` feature fixture covers normal and compact style plus a tall five-row radicand that requires an assembly; its Chromium comparison has zero differing regions. The 60 px glyph-outline raster has a separate residual tracked by DM-K0GPP7; its bar geometry is covered by a browser-measured unit regression.

The macOS sweep above is host-specific evidence. In the pinned Linux Playwright Noble container, Chromium reported **FreeSans** for the `math` generic on `<msqrt>`; the installed FreeSans face has a MATH table. Domotion produced the same painted bar rows and right edges as Chromium at all seven 12–60 px sizes in both normal and compact style (14/14 measurements). The focused `mathml-radical-bar-geometry` feature fixture passed there with one small glyph-raster region (0.05% of its image), within the documented Linux native-hinting floor. DM-24GQD3 still needs desktop Windows font selection, bar measurements, and its Windows workflow run; the current Windows arm64 VM is unavailable. The browser regression for inherited `math-style` covers a nested row, a fraction, and authored compact and normal overrides. Fonts whose physical MATH table cannot be read retain the captured-box fallback rather than inventing table values.

Sources: [OpenType MATH table](https://learn.microsoft.com/en-us/typography/opentype/spec/math), [Blink radical layout](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/layout/mathml/math_radical_layout_algorithm.cc), [Blink stretchy operator shaper](https://chromium.googlesource.com/chromium/src/%2B/be0abf5107c92eefda7fdea45cf9f7a48ee2e529/third_party/blink/renderer/platform/fonts/shaping/stretchy_operator_shaper.cc).
