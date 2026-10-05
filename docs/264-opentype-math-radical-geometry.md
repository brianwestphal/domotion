---
id: "requirements/opentype-math-radical-geometry"
title: "OpenType MATH radical geometry"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-WGF8AE", "DM-XZZ0MS", "DM-24GQD3", "DM-K0GPP7", "DM-9DC90C"]
code:
  [
    "packages/text-engine/src/render/open-type-math.ts",
    "packages/text-engine/src/render/math-radical-shape.ts",
    "packages/text-engine/src/render/text-to-path.ts",
    "tests/mathml-radical-bar-snap.e2e.test.ts",
    "tests/mathml-radical-raster.e2e.test.ts",
    "src/capture/script/walker/style-record.ts",
    "src/capture/types.ts",
    "src/render/element-tree-to-svg.ts",
  ]
aliases: ["docs/264-opentype-math-radical-geometry.md", "doc-264"]
---

# OpenType MATH radical geometry

For a MathML `<msqrt>` or `<mroot>` whose selected primary face has an OpenType MATH table, Domotion reads the four radical `MathConstants` values from the raw SFNT table: `RadicalVerticalGap`, `RadicalDisplayStyleVerticalGap`, `RadicalRuleThickness`, and `RadicalExtraAscender`. It captures the radical's own computed, inherited CSS `math-style` and uses the display gap for `normal` or the regular gap for `compact`. This includes radicals nested in rows and fractions, and author `math-style` overrides. Older captured trees without this field retain the parent-display inference. The captured radicand box supplies the base height and position. The bar extends from the radical operator advance to the radicand's right edge, with Blink's layout-unit and pixel snapping. A font without MATH keeps the underline-thickness fallback described in `text-to-path.ts`. Both paint branches use Blink's `SnapSizeToPixel` rule: if a positive LayoutUnit rule exceeds four raw units (4/64 px), edge rounding cannot erase it and the snapped bar is at least one pixel tall.

The vertical `MathGlyphConstruction` for U+221A supplies ready-made glyph variants and, when those are too short, a bottom-to-top assembly. Selection tests each variant's **ink height** against the radicand height plus gap and rule, as Blink's `StretchyOperatorShaper` does. An assembly repeats extender pieces until the requested height is reached and overlaps connectors within the font's minimum and maximum limits. For a single upright, regular-width glyph at weight 400, the renderer emits a self-contained subset font and SVG `<text>` so the consumer's text rasterizer paints the selected outline as Blink does. Assemblies and other font styles retain separate SVG glyph paths. It reads MATH bytes through fontkit's SFNT stream; for native-helper faces, it reopens the resolved physical source face by path and collection index while retaining the helper's live glyph outlines.

On a macOS host with STIX Two Math, a Chromium 1× sweep at 12, 16, 22, 30, 40, 50, and 60 px measured the base offset and painted bar rows in both display and compact math style. The emitted bar rows, thicknesses, and right edges matched all fourteen observations. The focused `mathml-radical-math-table-geometry` feature fixture covers normal and compact style plus a tall five-row radicand that requires an assembly; its Chromium comparison has zero differing regions. The 60 px hook raster differed when its correct outline was painted as an SVG path; a self-contained text subset paints it without that residual. The browser regression repeats the seven-size sweep and requires zero differing regions.

The macOS sweep above is host-specific evidence. In the pinned Linux Playwright Noble container, Chromium reported **FreeSans** for the `math` generic on `<msqrt>`; the installed FreeSans face has a MATH table. Domotion produced the same painted bar rows and right edges as Chromium at all seven 12–60 px sizes in both normal and compact style (14/14 measurements). The focused `mathml-radical-bar-geometry` feature fixture passed there with one small glyph-raster region (0.05% of its image), within the documented Linux native-hinting floor.

A native hosted Windows x64 probe ([run 37265451131](https://github.com/brianwestphal/domotion/actions/runs/37265451131), Windows release 10.0.26100, Chromium 147.0.7727.15) reported **Times New Roman** for a directly painted U+221A with `font-family: math`. On each `<msqrt>`, Chromium's painted-font census included **Cambria Math** and Times New Roman. Browser and captured base offsets agreed exactly at all fourteen normal/compact 12–60 px cases. The emitted and painted bar rows agreed in thirteen cases; at normal 16 px Chromium painted one bar row while Domotion emitted no bar rect. `DM-9DC90C` traces that gap, and the corresponding two macOS small-size gaps, to a missing one-pixel floor in the size-snap transcription. The fix passes the fourteen-row real-Chromium macOS regression; the hosted Windows rerun is pending. This hosted Windows image is distinct from the unavailable desktop Windows arm64 VM. The browser regression for inherited `math-style` covers a nested row, a fraction, and authored compact and normal overrides. Fonts whose physical MATH table cannot be read retain the captured-box fallback rather than inventing table values.

Sources: [OpenType MATH table](https://learn.microsoft.com/en-us/typography/opentype/spec/math), [Blink radical layout](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/layout/mathml/math_radical_layout_algorithm.cc), [Blink stretchy operator shaper](https://chromium.googlesource.com/chromium/src/%2B/be0abf5107c92eefda7fdea45cf9f7a48ee2e529/third_party/blink/renderer/platform/fonts/shaping/stretchy_operator_shaper.cc), [Blink pixel size snap](https://chromium.googlesource.com/chromium/src/%2B/96b04b8744c3300c980cd87bc41cc3444d463fb0/third_party/blink/renderer/platform/geometry/layout_unit.h).
