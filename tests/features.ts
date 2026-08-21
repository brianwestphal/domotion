/**
 * Feature test definitions.
 *
 * Each test is a minimal HTML snippet that exercises one rendering feature.
 * The test runner compares HTML→PNG with SVG→PNG for each.
 *
 * Usage: npx tsx tests/features.ts [--only feature-name]
 */

import { runFeatureTests, type FeatureTest } from "./runner.js";

export const tests: FeatureTest[] = [
  // ── Text ──
  {
    name: "text-basic",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 16px;">Hello World</div>`,
  },
  {
    name: "text-bold",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><span style="font-weight: 700; font-size: 24px;">Bold Heading</span><br/><span style="font-weight: 400; font-size: 14px; color: #8b949e;">Regular body text below</span></div>`,
  },
  {
    name: "text-center",
    html: `<div style="width: 400px; text-align: center; padding: 40px 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><div style="font-size: 28px; font-weight: 800;">Centered Title</div><div style="font-size: 14px; color: #8b949e; margin-top: 8px;">Centered subtitle text</div></div>`,
  },
  {
    name: "text-right",
    html: `<div style="width: 400px; text-align: right; padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><div style="font-size: 16px;">Right-aligned text</div><div style="font-size: 12px; color: #8b949e;">Smaller right-aligned</div></div>`,
  },
  {
    name: "text-mono",
    html: `<div style="padding: 20px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3;">sk install @community/error-handling</div>`,
  },
  {
    name: "text-multiline",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; line-height: 1.6; width: 300px;"><div>First line of text</div><div>Second line of text</div><div style="color: #8b949e;">Third line dimmed</div></div>`,
  },
  {
    // Baseline pixel-grid snap regression test. 18px × line-height 1.6 gives a
    // 28.796875px line box (Chrome's 1/64px LayoutUnit snap of 28.8), so
    // successive baselines land on fractional-pixel phases (0, .797, .594,
    // .391, …). Skia rounds every axis-aligned horizontal glyph's y to an
    // integer device pixel at raster time; emitting the unsnapped fractional
    // baseline spread horizontal strokes across two pixel rows (a uniform
    // stroke-lightness error), and the fourth line's phase was the first to
    // cross the comparator's high-severity region gate.
    name: "lineheight-residual",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 18px; line-height: 1.6;">
      <div>Hello world one</div>
      <div>Book reading here</div>
      <div>mix content end</div>
      <div>id 123 ok</div>
    </div>`,
    width: 460,
    height: 200,
  },
  {
    name: "text-small",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif;">LABEL TEXT</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif; margin-top: 4px;">Score: 42/100 · 1,234 downloads</div></div>`,
  },
  {
    // DM-1879: the ONLY fixture that paints non-Latin text under a `system-ui`
    // primary, and therefore the only pixel ground truth for the whole UI-font
    // cascade.
    //
    // Every unicode fixture declares `system-ui` on `body` and then overrides it
    // on the glyph cells, so `system-ui` styles page chrome — which is Latin,
    // where the primary covers the codepoint and per-codepoint fallback never
    // runs. The cascade was consequently invisible to all 818 of them: the
    // change that introduced the CoreText UI-font base moved 0 fixtures by even
    // 1e-12 while moving the conformance oracle's CJK slice by −74%.
    //
    // That blindness was not theoretical. It also hid a 9.5% advance error on
    // these faces (they are optically size-dependent, and we were pinning them
    // to their largest optical cut at every size — DM-1900).
    //
    // Each row is a DISTINCT CoreText answer, verified against Chrome via CDP
    // `CSS.getPlatformFontsForNode` on macOS 26.5.2 — so a regression that
    // collapses the Text/Display or Regular/Bold distinction moves pixels here:
    //
    //     13px w400          -> .PingFangUITextSC-Regular
    //     13px w700          -> .PingFangUITextSC-Bold
    //     20px w400          -> .PingFangUIDisplaySC-Regular
    //     20px w700          -> .PingFangUIDisplaySC-Bold
    //     13px w400 italic   -> .PingFangUIDisplaySC-Regular   <- Text→Display,
    //                                         because PingFang has no italic
    //
    // `font-family` is deliberately declared ONCE on the wrapper and inherited:
    // restating it per row would be the same mistake the unicode corpus makes.
    name: "text-system-ui-cjk-fallback",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: system-ui;"><div style="font-size: 13px; font-weight: 400;">中文字体测试</div><div style="font-size: 13px; font-weight: 700;">中文字体测试</div><div style="font-size: 20px; font-weight: 400;">中文字体测试</div><div style="font-size: 20px; font-weight: 700;">中文字体测试</div><div style="font-size: 13px; font-weight: 400; font-style: italic;">中文字体测试</div></div>`,
  },

  {
    // DM-1867: the corpus had NO private-use fixture — `ls ../html-test/unicode/
    // | grep -i private` returns nothing, because the 819-block set excludes the
    // PUA ranges. So the notdef-suppression path could neither be regressed nor
    // shown to work: a change there broke no fixture and proved nothing.
    //
    // The path being covered: Blink runs NO per-codepoint font fallback for
    // private-use codepoints (`platform/fonts/font_cache.cc:242-244`), so the
    // run stays on its primary and paints THAT font's `.notdef` — for macOS
    // Helvetica a hollow rectangle at 1298/2048 em. Verified against Chrome
    // rather than inferred: CDP `CSS.getPlatformFontsForNode` names Helvetica
    // for every one of these, and the measured advance is 20.28125px at 32px.
    //
    // Deliberately mixes BMP PUA (U+E000, U+F8FF) with astral PUA (U+F0000,
    // U+100000): the astral ones are two UTF-16 units per glyph, which is
    // exactly the case where a glyph index cannot stand in for a text index —
    // the bug this fixture originally accompanied. U+F8FF is load-bearing in
    // the other direction: macOS Helvetica has a real glyph for it (the Apple
    // logo), so it pins that the rule skips only the SYSTEM-fallback stage and
    // still lets the declared family answer. Latin on either side so a wrong
    // advance shows as a collision rather than having to be measured alone.
    name: "text-private-use-tofu",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: Helvetica, sans-serif; font-size: 32px;"><div>A\u{E000}B\u{F8FF}C</div><div>D\u{F0000}E\u{100000}F</div><div>\u{E000}\u{E001}\u{E002}</div></div>`,
  },

  {
    // The OTHER half of the same Blink rule, and the half with no coverage
    // anywhere else: `FallbackFontForCharacter` skips fallback for
    // `Character::IsNonCharacter` as well as private-use, but noncharacters are
    // absent from the 819-block unicode corpus (`FFF0-FFFF-specials.html` and
    // the Arabic-Presentation-Forms fixtures contain none) AND excluded from
    // the conformance oracle's universe. So without this fixture the rule's
    // noncharacter branch was asserted only by a unit test.
    //
    // Chrome paints a `.notdef` for these, same as for private-use — measured,
    // not assumed: `getPlatformFontsForNode` reports Helvetica with a glyph per
    // character, and "A<nonchar>B" measures 62.97px against 42.69px for "AB",
    // a delta of exactly Helvetica's 20.28px `.notdef` advance.
    //
    // Covers both shapes the ICU predicate has: the contiguous U+FDD0..U+FDEF
    // window, and the last two codepoints of a plane (U+FFFE/U+FFFF, plus an
    // astral one so the per-plane arm is exercised rather than just the BMP).
    //
    // U+FFFE / U+FFFF are load-bearing for a second reason, found by this
    // fixture: they are the two codepoints the XML `Char` production excludes,
    // so carrying them into the accessible name made the whole SVG unparseable
    // and the consumer rendered a broken-image icon. That is why `esc` drops
    // XML-illegal codepoints \u2014 this row is its regression guard, and it fails
    // loudly (97% of image) rather than subtly if that is ever undone.
    //
    // Row 3 avoids the letter `G` deliberately, and NOT to flatter the result:
    // `G` beside a notdef box is the one Latin neighbour that trips the region
    // detector on the paths-mode hinting floor (measured: `G`\u21921 region, while
    // `A/B/C`, `D/E/F`, `J/K/L` \u2192 0, and the PUA sibling fixture shows the same
    // 1 region when given `G`). That floor is real but unrelated to what this
    // fixture asserts: Chrome's Skia HINTS Helvetica's `.notdef`, snapping its
    // 2.875px strokes to whole pixels, where the unhinted outline anti-aliases
    // both edges (scanline through the box: identical centres at 237, but edge
    // pixels 153 vs Chrome's 235 \u2014 0.834 of the ink). Embedded-subset mode, the
    // production default, preserves the hinting program and is pixel-exact here
    // (0.000%, 0 regions); only `paths` mode, which the visual harness pins,
    // carries it. Leaving `G` in would make a font-ROUTING fixture permanently
    // red for a RASTERIZATION reason and conflate the two.
    name: "text-noncharacter-tofu",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: Helvetica, sans-serif; font-size: 32px;"><div>A\uFDD0B\uFDEFC</div><div>D\uFFFEE\uFFFFF</div><div>J\u{1FFFE}K\u{10FFFF}L</div></div>`,
  },

  // ── Backgrounds & Colors ──
  {
    name: "bg-solid",
    html: `<div style="padding: 20px;"><div style="background: #161b22; padding: 16px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Dark surface background</div><div style="background: #238636; padding: 8px 16px; color: white; font-family: -apple-system, sans-serif; font-size: 14px; margin-top: 8px; display: inline-block;">Green button</div></div>`,
  },
  {
    name: "bg-transparent",
    html: `<div style="padding: 20px;"><div style="background: rgba(35,134,54,0.15); padding: 8px 12px; color: #3fb950; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">Semi-transparent green</div><div style="background: rgba(248,81,73,0.15); padding: 8px 12px; color: #f85149; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block; margin-left: 8px;">Semi-transparent red</div></div>`,
  },
  {
    name: "bg-nested",
    html: `<div style="padding: 20px; background: #161b22; width: 300px;"><div style="background: #0d1117; padding: 12px; margin: 8px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Nested darker box</div></div>`,
  },
  {
    // Smooth conic color wheel captured through Chromium's own gradient paint
    // boundary; SVG has no native conic paint server.
    name: "bg-conic-smooth",
    html: `<div style="padding: 20px;"><div style="width: 200px; height: 200px; background: conic-gradient(red, yellow, green, blue, red);"></div></div>`,
  },
  {
    // Regression guard: repeating-linear-gradient with px-positioned stops.
    // The earlier emitter treated px positions as raw fractions, so the SVG
    // `<stop offset="8">` clamped to 1 and the stripe pattern collapsed to a
    // single solid color. Fixed by normalizing px positions to fractions of
    // the gradient line length and scaling the SVG gradient vector to span
    // exactly one tile period (`spreadMethod="repeat"` then tiles outward).
    name: "bg-repeating-linear-px-stops",
    html: `<div style="padding: 20px;"><div style="width: 160px; height: 160px; background: repeating-linear-gradient(45deg, #fef3c7 0 8px, #fde68a 8px 16px); border: 1px solid #b45309;"></div></div>`,
    relaxedDiffPct: 0.5,
  },
  {
    // Advanced hue interpolation cannot be reproduced by the CPU fallback.
    // The physical 50×38 tile also proves computed px background-size crosses
    // the cumulative zoom boundary exactly once.
    name: "bg-conic-chromium-zoom-tile",
    html: `<div style="padding:20px;background:#fff"><div style="width:160px;height:120px;zoom:1.25;background-image:conic-gradient(from 30deg at 40% 60% in oklch longer hue,red,blue);background-size:40px 30px;background-repeat:repeat"></div></div>`,
    width: 260,
    height: 200,
  },
  {
    // DM-547 / doc 28 / canonical use case from 19-deep-color-mix:
    // hard-stop alpha checkerboard tile.
    name: "bg-conic-checkerboard",
    html: `<div style="padding: 20px;"><div style="width: 240px; height: 240px; background: repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px;"></div></div>`,
  },
  {
    // DM-547: from <angle> + at <position> — pie-meter-like sweep with off-center origin.
    name: "bg-conic-from-at",
    html: `<div style="padding: 20px;"><div style="width: 200px; height: 200px; background: conic-gradient(from 90deg at 30% 70%, #4f46e5 0% 25%, #ec4899 25% 75%, #4f46e5 75% 100%);"></div></div>`,
  },
  {
    // DM-547: multi-layer composition. Conic on top, linear-gradient under,
    // solid color base. SVG paint-order should stack them top-to-bottom.
    name: "bg-conic-multilayer",
    html: `<div style="padding: 20px;"><div style="width: 220px; height: 220px; background: repeating-conic-gradient(rgba(255,255,255,0.15) 0 25%, transparent 0 50%) 0/40px 40px, linear-gradient(135deg, #4f46e5, #ec4899);"></div></div>`,
  },

  // ── Borders ──
  {
    name: "border-solid",
    html: `<div style="padding: 20px;"><div style="border: 1px solid #30363d; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; width: 250px;">Box with border</div></div>`,
  },
  {
    name: "border-radius",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; width: 250px;">Rounded card</div></div>`,
  },
  {
    name: "border-radius-pill",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 6px 14px; color: #8b949e; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">tag-one</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 6px 14px; color: #8b949e; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">tag-two</div></div>`,
  },
  {
    // Chromium paints collapsed borders from one logical table edge graph, not
    // as four borders on every cell. Crosses spans, unequal tracks, conflicting
    // widths/styles, four-way joints, and vertical-rl + RTL physical mapping.
    name: "border-collapse-edge-graph",
    html: `<div style="padding:20px;background:#fff;display:flex;gap:30px"><style>.cg{border-collapse:collapse}.cg td{box-sizing:border-box;width:70px;height:38px;border:2px solid #2563eb}.cg .span{border-right:6px solid #dc2626}.cg .wide{height:62px;border-left:8px dashed #16a34a}.vg{writing-mode:vertical-rl;direction:rtl}.vg .a{border-right:7px solid #dc2626}.vg .b{border-right:5px dashed #16a34a}</style><table class="cg"><tr><td class="span" rowspan="2"></td><td></td></tr><tr><td class="wide"></td></tr></table><table class="cg vg"><tr><td class="a"></td><td class="b"></td></tr></table></div>`,
    width: 520,
    height: 190,
  },
  {
    // DM-2322 / DM-2337: LayoutNG keeps the global collapsed-border winner graph across
    // fragmentainers, but TablePainter clips/halves/omits edges using each
    // section fragment's row offsets. Includes both whole-row breaks and one
    // row continued across a multicol boundary.
    name: "border-collapse-fragmented",
    html: `<div style="padding:16px;background:#fff"><style>.fc{columns:3;column-fill:auto;width:720px;height:132px}.ft{border-collapse:collapse;width:100%}.ft td{box-sizing:border-box;height:38px;border:4px solid #2563eb;padding:2px}.ft .accent{border-left:7px dashed #dc2626}.ft .tall{height:164px}</style><div class="fc"><table class="ft"><tbody><tr><td></td></tr><tr><td class="accent"></td></tr><tr class="tall"><td></td></tr><tr><td></td></tr></tbody></table></div></div>`,
    width: 960,
    height: 210,
  },

  // ── Layout ──
  {
    name: "layout-flex-row",
    html: `<div style="padding: 20px; display: flex; gap: 12px; align-items: center;"><div style="background: #238636; padding: 8px 16px; border-radius: 6px; color: white; font-family: -apple-system, sans-serif; font-size: 14px;">Button A</div><div style="background: #161b22; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Button B</div></div>`,
  },
  {
    name: "layout-flex-col",
    html: `<div style="padding: 20px; display: flex; flex-direction: column; gap: 8px; width: 250px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Item one</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Item two</div></div>`,
  },
  {
    name: "layout-flex-center",
    html: `<div style="width: 400px; height: 200px; display: flex; justify-content: center; align-items: center;"><div style="background: #238636; padding: 12px 24px; border-radius: 6px; color: white; font-family: -apple-system, sans-serif; font-size: 16px; font-weight: 600;">Centered Button</div></div>`,
  },
  {
    name: "layout-padding",
    html: `<div style="background: #161b22; padding: 24px; width: 300px; border: 1px solid #30363d; border-radius: 6px;"><div style="color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 600; margin-bottom: 4px;">Card Title</div><div style="color: #8b949e; font-family: -apple-system, sans-serif; font-size: 13px;">Card description with padding</div></div>`,
    width: 340,
    height: 120,
  },

  // ── Components ──
  {
    name: "comp-button",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><div style="background: #238636; border: 1px solid #238636; border-radius: 6px; padding: 8px 16px; color: white; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Primary</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 16px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Secondary</div><div style="background: transparent; border: 1px solid #f85149; border-radius: 6px; padding: 8px 16px; color: #f85149; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Danger</div></div>`,
  },
  {
    name: "comp-badge",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><span style="background: rgba(35,134,54,0.15); color: #3fb950; border: 1px solid rgba(35,134,54,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">Published</span><span style="background: rgba(31,111,235,0.15); color: #58a6ff; border: 1px solid rgba(31,111,235,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">v1.2.0</span><span style="background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">Stack</span></div>`,
  },
  {
    name: "comp-card",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; width: 350px;"><div style="font-weight: 600; color: #58a6ff; font-size: 14px; font-family: -apple-system, sans-serif; margin-bottom: 4px;">@community/error-handling</div><div style="font-size: 13px; color: #8b949e; font-family: -apple-system, sans-serif; margin-bottom: 8px;">Structured error handling patterns</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif;">42/100 · 1,234 downloads · 92% positive</div></div></div>`,
    width: 400,
    height: 140,
  },
  {
    name: "comp-card-badge",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; width: 380px;"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><span style="font-weight: 600; color: #58a6ff; font-size: 14px; font-family: -apple-system, sans-serif;">@community/typescript-strict</span><span style="background: rgba(31,111,235,0.15); color: #58a6ff; border: 1px solid rgba(31,111,235,0.3); display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">universal</span></div><div style="font-size: 13px; color: #8b949e; font-family: -apple-system, sans-serif;">TypeScript strict mode conventions and type safety rules</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif; margin-top: 8px;">Score: 42/100 · 1,234 downloads · 92% positive</div></div></div>`,
    width: 420,
    height: 150,
  },
  {
    name: "comp-code-block",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3; width: 350px;">sk install @community/error-handling</div></div>`,
  },
  {
    name: "comp-input",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif; margin-bottom: 4px;">NAME</div><div style="display: flex; align-items: center; gap: 4px;"><span style="color: #e6edf3; font-size: 14px; font-weight: 500; font-family: -apple-system, sans-serif;">@devuser/</span><div style="background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; font-family: -apple-system, sans-serif; width: 200px;">error-handling</div></div></div>`,
  },
  // ── Regression: mixed content, inputs, multiline ──
  {
    name: "text-inline-mixed",
    html: `<div style="padding: 20px;"><p style="font-size: 14px; color: #8b949e; font-family: -apple-system, sans-serif;">Inline code: <code style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px; background: #161b22; padding: 2px 6px; border-radius: 4px;">slicekit.json</code> and <code style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px; background: #161b22; padding: 2px 6px; border-radius: 4px;">CLAUDE.md</code></p></div>`,
    width: 400,
    height: 80,
  },
  {
    name: "comp-input-value",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif; margin-bottom: 4px;">NAME</div><input style="background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; font-family: -apple-system, sans-serif; width: 250px;" value="error-handling" /></div>`,
    width: 300,
    height: 100,
  },
  // DM-581: button-typed inputs (and buttons styled as flex with align-items:
  // center) center their value text vertically within the rect — not anchored
  // at content-box top like a plain text input. The framer-mobile-fold "Okay"
  // button surfaced this. Three variants: UA-default `<input type=button>`,
  // padded button-input, and a flex/centered button-input mirroring the framer
  // shape. Chrome paints all three with vertically-centered baselines.
  {
    name: "comp-input-button",
    html: `<div style="padding: 20px; display: flex; gap: 12px; align-items: flex-start; font-family: -apple-system, sans-serif;">
      <input type="button" value="Okay" style="font-size: 14px;" />
      <input type="button" value="Submit" style="font-size: 14px; padding: 12px 16px; background: #2563eb; color: white; border: 0; border-radius: 6px;" />
      <input type="button" value="Okay" style="display: flex; align-items: center; justify-content: center; width: 58px; height: 45px; font-size: 14px; background: white; border: 1px solid #d4d4d8; border-radius: 8px; color: #18181b;" />
    </div>`,
    width: 320,
    height: 80,
  },
  {
    name: "text-pre-multiline",
    html: `<div style="padding: 20px;"><pre style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3; width: 350px; margin: 0; white-space: pre;">## Error Handling

- Always use typed errors
- Use Result&lt;T, E&gt; pattern</pre></div>`,
    width: 400,
    height: 160,
  },
  // SK-1236: text-decoration placement uses font.underlinePosition / OS/2
  // strikeout metrics. SF Pro and SF Mono have noticeably different underline
  // positions (SF Mono sits ~0.75px higher at 14px), so the fixture mixes
  // both families plus a large heading and dashed/dotted styles to exercise
  // every code path.
  {
    name: "text-decorations",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; line-height: 1.7;">
      <div><span style="text-decoration: underline">underlined</span> · <span style="text-decoration: line-through">struck</span> · <span style="text-decoration: overline">over</span></div>
      <div style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px;"><span style="text-decoration: underline">mono underline</span></div>
      <div style="font-size: 22px;"><span style="text-decoration: underline">Large underline</span></div>
    </div>`,
    width: 420,
    height: 160,
  },
  // Skip-ink EXCLUSIONS. Chrome refuses to interrupt a decoration line for
  // characters `Character::CanTextDecorationSkipInk` rejects — `/ \ _`, the CJK
  // ideograph-or-symbol property, and the Hangul / Linear B Ideograms blocks —
  // so underlined CJK and Korean paint an UNBROKEN line while Latin descenders
  // beside them still open gaps.
  //
  // This fixture exists because the sweep that was supposed to cover it cannot:
  // the 819 per-block unicode fixtures carry exactly one underline rule,
  // `p.meta a:hover`, which never applies in a static capture and is Latin
  // anyway. A filtered CJK sweep over them returns every tile byte-identical
  // whatever the skip-ink code does, so it reports a confident green for a
  // mechanism it never ran. Underlined CJK had to become a fixture to be
  // testable at all.
  //
  // The mixed row is the one that discriminates a per-character implementation
  // from a per-run one: Blink drops intercepts at each character index, so the
  // `jp` keeps its gaps while the ideographs beside it do not.
  {
    name: "text-decoration-skip-ink-exclusions",
    html: `<div style="padding: 16px; background: #fff; color: #111; font-family: -apple-system, sans-serif; font-size: 24px; line-height: 2;">
      <div><span style="text-decoration: underline">\u65e5\u672c\u8a9e\u6f22\u5b57</span></div>
      <div><span style="text-decoration: underline">\ud55c\uad6d\uc5b4 \uc9c0\uae08</span></div>
      <div><span style="text-decoration: underline">a/b\\c_d</span></div>
      <div><span style="text-decoration: underline">jumping gaps</span></div>
      <div><span style="text-decoration: underline">\u65e5jp\u8a9e gy</span></div>
      <div><span style="text-decoration: overline">overline jumping</span></div>
      <div><span style="text-decoration: underline dashed">dashed jumping</span></div>
    </div>`,
    width: 460,
    height: 400,
  },
  // DM-1960: `font-feature-settings: "liga" 0` (and the font-variant-ligatures
  // no-* keywords) must DISABLE a face's default-on ligatures the way Chrome
  // does — Blink hands HarfBuzz every setting with its value intact
  // (font_features.cc:203-225, rev 7d859f27) and HarfBuzz selects the AAT OFF
  // selector on morx faces (hb-aat-map.cc:79, rev 4de187d). The renderer used
  // to drop zero-valued entries (fontkit's feature list is enable-only), so the
  // disabled rows rendered WITH ligatures.
  //
  // The face matters: this must be a family whose ligatures actually FIRE, or
  // both sides agree by vacuity and the fixture grades nothing. Georgia — the
  // face the broad-corpus liga-off fixture uses — forms none. Verified by CDP
  // glyphCount on "office waffle affix flight" 24px: Times 22 glyphs normal ->
  // 26 under `"liga" 0`; Helvetica 22 -> 26; Georgia 26 -> 26 (inert).
  {
    name: "text-feature-settings-liga-off",
    html: `<div style="padding: 16px; color: #e6edf3; font-size: 24px; line-height: 1.5;">
      <div style="font-family: Times, serif;">office waffle affix flight</div>
      <div style="font-family: Times, serif; font-feature-settings: 'liga' 0;">office waffle affix flight</div>
      <div style="font-family: Times, serif; font-variant-ligatures: none;">office waffle affix flight</div>
      <div style="font-family: Helvetica, sans-serif; font-feature-settings: 'liga' 0, 'dlig' 0;">office waffle affix flight</div>
    </div>`,
    width: 420,
    height: 190,
  },
  // DM-1959: `font-variant-emoji` is a face-selection input, not a hint —
  // Blink overrides the run's fallback priority and forces VS15/VS16 into the
  // glyph lookups (harfbuzz_shaper.cc:184-198 + harfbuzz_face.cc:127-206, rev
  // 7d859f27). Measured by CDP on this host: under `emoji`, bare ❤ moves
  // ZapfDingbats → Apple Color Emoji, covered ☺ moves Helvetica → Apple Color
  // Emoji, and even digit 5 / # move (the `Emoji` property includes the keycap
  // bases); under `text`, ⚡ moves Apple Color Emoji → Apple Symbols and ⭐ →
  // STIX Two Math (Blink's monochrome-emoji replacement,
  // font_cache_mac.mm:156-184) while 😀 stays color (no mono face exists);
  // `unicode` forces emoji presentation for emoji-default codepoints only. An
  // explicit VS15/VS16 in the text always wins over the property.
  {
    name: "text-font-variant-emoji",
    html: `<div style="padding: 16px; color: #e6edf3; font-family: Helvetica, sans-serif; font-size: 24px; line-height: 1.6;">
      <div>A5# ❤ ☺ ⚡ ⭐ \u{1F600}</div>
      <div style="font-variant-emoji: text;">A5# ❤ ☺ ⚡ ⭐ \u{1F600}</div>
      <div style="font-variant-emoji: emoji;">A5# ❤ ☺ ⚡ ⭐ \u{1F600}</div>
      <div style="font-variant-emoji: unicode;">A5# ❤ ☺ ⚡ ⭐ \u{1F600}</div>
      <div style="font-variant-emoji: text;">❤️ ⚡️ VS16 wins</div>
    </div>`,
    width: 420,
    height: 240,
  },
  // SK-1255: mixed-script line exercises the multi-font xOffsets path.
  // Fallback runs (Arabic, Devanagari, CJK) must shape as units so contextual
  // joining, cluster reordering, and ligatures survive — per-char shaping
  // would render Arabic letters as detached isolated forms, हिन्दी without
  // its क्ष-style ligatures, and split CJK ligatures.
  {
    name: "text-mixed-script",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 18px; line-height: 1.6;">
      <div>Hello مرحبا 你好 नमस्ते</div>
      <div>greet السلام and こんにちは and हिन्दी</div>
    </div>`,
    width: 460,
    height: 120,
  },
  // A right-to-left word INSIDE a left-to-right line — including the same-face
  // boundary that shaped fallback assembly must preserve. Blink resolves bidi
  // runs before shaping: SegmentBidiRuns splits InlineItems at logical-run
  // boundaries, and ShapeText refuses to shape across items whose direction or
  // RunSegmenter data differs (inline_node.cc:1411-1435,470-490,1632-1653;
  // Chromium rev 7d859f27). Arial is deliberate: Latin, Hebrew, and digits stay
  // on one face in the calibrated browser inventories, so a font-key boundary
  // cannot accidentally preserve the bidi items for us.
  //
  // Why the broad sweeps cannot cover it: the per-Unicode-block fixtures are
  // single-script by construction, so an RTL block's fixture is entirely RTL and
  // its run starts at index 0 of the line, where the level lookup happened to be
  // right. It takes a MIXED line to put an RTL run at a non-zero offset.
  //
  // What it pins: the renderer hands the shaper an explicit direction per bidi
  // run, and that direction has to be the run's own embedding level. Hand an
  // RTL run "ltr" and the two engines diverge — the macOS CoreText helper's
  // shape query takes no direction at all and silently infers RTL from the
  // content, while HarfBuzz (which is what Chrome runs) obeys and reverses the
  // buffer before shaping, so the contextual forms come out computed on the
  // reversed characters: a differently-shaped word, not a placement nuance.
  //
  // Hebrew is covered explicitly and not only Arabic. Both are RTL and both are
  // routed to HarfBuzz, but they reached that routing in separate changes, and
  // only Arabic appeared in a mixed line anywhere — so Hebrew's exposure was
  // real and unexercised.
  //
  // Three lines, one behavior each: digits inside an RTL word (bidi resolves
  // them to their own even level, so one SAME-FACE line has four shaping
  // items); an all-LTR same-face negative control that must remain one item;
  // and POINTED Hebrew, where a wrong merged direction is most obvious because
  // each nikud lands under the wrong consonant.
  //
  // Deliberately three lines and not four. A FOURTH line of this style pushes
  // the fixture over the harness threshold on its own — measured at 0.07% with
  // the text replaced by plain Latin and no RTL anywhere in the fixture, so it
  // is a paths-mode residual of the line count, unrelated to direction. Adding
  // a line here would buy a failure that says nothing about shaping.
  {
    name: "text-rtl-in-ltr-line",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: Arial, sans-serif; font-size: 18px; line-height: 1.6;">
      <div>id שלום 123 ok</div>
      <div>id alpha 123 ok</div>
      <div>Book בְּרֵאשִׁית here</div>
    </div>`,
    width: 460,
    height: 150,
  },

  // ── Regression: modern CSS color formats (SK-434) ──
  // Each swatch uses a different color notation. All must parse to the
  // same-looking rgb() via the capture-side canvas normalizer. If any drop
  // back to the fallback fill, the swatch shows a bright off-color or no fill.
  {
    name: "color-modern-formats",
    html: `<div style="padding: 12px; display: flex; gap: 4px;">
      <div style="background: hsl(200, 80%, 40%); width: 40px; height: 40px;"></div>
      <div style="background: hwb(200 20% 30%); width: 40px; height: 40px;"></div>
      <div style="background: oklch(60% 0.2 30); width: 40px; height: 40px;"></div>
      <div style="background: oklab(60% 0.1 -0.1); width: 40px; height: 40px;"></div>
      <div style="background: lab(60% 40 -20); width: 40px; height: 40px;"></div>
      <div style="background: lch(60% 50 180); width: 40px; height: 40px;"></div>
      <div style="background: color(srgb 0.2 0.5 0.8); width: 40px; height: 40px;"></div>
      <div style="background: color-mix(in srgb, #dc2626 50%, #0ea5e9); width: 40px; height: 40px;"></div>
      <div style="background: #0ea5e9c0; width: 40px; height: 40px;"></div>
    </div>`,
    width: 420,
    height: 70,
  },


  // ── Regression: z-index paint order for positioned siblings (SK-439) ──
  // Red (z:1) should paint behind blue (z:3) regardless of DOM order. Before
  // the fix the SVG painted in DOM order so red covered blue.
  {
    name: "z-index-order",
    html: `<div style="position: relative; width: 240px; height: 120px; background: #0d1117;">
      <div style="position: absolute; top: 10px; left: 10px; width: 100px; height: 80px; background: #dc2626; z-index: 1;"></div>
      <div style="position: absolute; top: 30px; left: 60px; width: 100px; height: 80px; background: #58a6ff; z-index: 3;"></div>
      <div style="position: absolute; top: 50px; left: 110px; width: 100px; height: 60px; background: #3fb950; z-index: 2;"></div>
    </div>`,
    width: 260,
    height: 140,
  },

  // ── DM-473: cross-stacking-context z-index ──
  // A positioned descendant whose nearest positioned ancestor has z-index:auto
  // does NOT join that ancestor's "fake" stacking context — it joins the
  // nearest REAL stacking-context ancestor (here, the root). So blue
  // (z-index:1) inside red (z-index:auto) must paint ABOVE green (z-index:auto)
  // even though red comes before green in DOM order, because blue's effective
  // stack key (1) > green's (auto/0).
  {
    name: "z-index-cross-parent-non-context",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:1;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: stacking-context boundary blocks escape ──
  // Red establishes a real stacking context (positioned + z-index:1). Blue
  // (z-index:5) inside red is trapped at red's z-level. Green (z-index:2)
  // in the root context paints ABOVE red and therefore above blue, even
  // though blue's nominal z-index is higher. Without context-aware sorting
  // we'd hoist blue above green, which is the opposite of correct.
  {
    name: "z-index-stacking-context-boundary",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;z-index:1;">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:5;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;z-index:2;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: negative z-index escapes non-stacking-context parent ──
  // A z-index:-1 child of a positioned-but-z-auto parent paints BEHIND the
  // nearest stacking context's other content — it bubbles up. Here the gray
  // in-flow block paints first, blue (z:-1) escapes red and paints between
  // the gray block and red itself, so blue covers gray but red still sits
  // on top of blue.
  {
    name: "z-index-negative-escapes",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:220px;height:50px;background:#94a3b8;"></div>
      <div style="position:absolute;left:60px;top:40px;width:120px;height:80px;background:#dc2626;">
        <div style="position:absolute;left:-30px;top:-20px;width:200px;height:120px;background:#58a6ff;z-index:-1;"></div>
      </div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: transform creates a stacking context ──
  // `transform` ≠ none creates a stacking context even without z-index. So
  // blue (z-index:5) inside a transformed parent is trapped at the parent's
  // z-level (auto). Green (z-index:1) in the root context paints above the
  // transformed parent and therefore above blue. Uses `translate(0)` so the
  // transform has no visible position effect — only its SC-creating role
  // matters for this fixture.
  {
    name: "z-index-transform-stacking-context",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;transform:translate(0);">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:5;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;z-index:1;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // DM-587: Verifies that nested descendants of a scale-transformed parent
  // composite correctly. Mirrors the Stripe Payment Element pattern: outer
  // wrapper with `transform: scale(0.69)`, flex column of child rows, with
  // some rows carrying their own `transform: translateY(...)`. If the
  // renderer's <g transform> composition is right, the child rows should
  // appear at the same positions Chrome paints them; if descendants' rects
  // are treated as viewport-post-transform, rows will overlap.
  {
    name: "transform-scale-flex-descendants",
    html: `<div style="width:300px;height:400px;background:#0d1117;padding:20px;">
      <div style="width:200px;height:300px;background:#161b22;transform:scale(0.69);transform-origin:0 0;display:flex;flex-direction:column;gap:10px;padding:10px;">
        <div style="height:40px;background:#dc2626;"></div>
        <div style="height:40px;background:#3fb950;transform:translateY(-5px);"></div>
        <div style="height:40px;background:#58a6ff;"></div>
        <div style="height:40px;background:#d29922;transform:translateY(10px);"></div>
        <div style="height:40px;background:#a371f7;"></div>
      </div>
    </div>`,
    width: 320,
    height: 420,
    relaxedDiffPct: 0.05,
  },

  // DM-589: per CSS Transforms 2 §4, `transform-style` != `flat` creates a
  // stacking context. The outer card has `transform-style: preserve-3d`
  // (commonly applied to keep child cards in a 3D flip / parallax layout) and
  // a white background. A nested `position:relative; z-index:-1` child paints
  // at step 2 of the card's local SC — ABOVE the card's bg but below the
  // card's content. Without the preserve-3d SC, the z=-1 would hoist up to
  // the section-container SC and end up BEHIND the white card bg (hidden).
  // Real-world example: stripe.com's speaker-card uses preserve-3d to flip
  // the speaker photo on top of the card; our renderer missed the SC trigger
  // and rendered the photo behind the white bg.
  {
    name: "z-index-transform-style-preserve-3d-sc",
    html: `<div style="position:relative;width:300px;height:300px;background:#222;z-index:1;">
      <div>
        <div style="position:absolute;left:50px;top:50px;width:200px;height:200px;background:white;transform-style:preserve-3d;">
          <div style="position:relative;z-index:-1;width:120px;height:120px;left:40px;top:40px;background:#58a6ff;"></div>
        </div>
      </div>
    </div>`,
    width: 320,
    height: 320,
  },

  // DM-589: negative-z-index descendant of a non-SC parent inside a real SC
  // ancestor. The blue square has `position:relative; z-index:-1`, sitting
  // inside a `position:absolute; z-index:auto; background:white` card. Per
  // CSS 2.1 Appendix E, z-index:-1 paints at the parent stacking-context's
  // step 2 (negative z descendants), BELOW the SC's other content. The
  // closest SC ancestor here is the outer dark `position:relative; z-index:1`
  // box. Chrome paints: dark bg → blue at z=-1 → white card (z=auto) on top.
  // So in Chrome, blue is HIDDEN by the white card. The diff a viewer sees
  // is just the white card.
  //
  // This fixture pins the spec-compliant behavior in case anyone tries to
  // "make z=-1 always visible" by skipping the hoist or sort. It is also a
  // counter-example to a wrong hypothesis on Stripe DM-589: a negative-z
  // image whose card sibling has white bg ought to be hidden — Chrome's
  // expected showing the image must be due to a DIFFERENT mechanism than
  // a missing hoist (likely a transparency or clip on the card).
  {
    name: "z-index-negative-under-card-bg",
    html: `<div style="position:relative;width:300px;height:300px;background:#222;z-index:1;">
      <div>
        <div style="position:absolute;left:50px;top:50px;width:200px;height:200px;background:white;">
          <div style="position:relative;z-index:-1;width:120px;height:120px;left:40px;top:40px;background:#58a6ff;"></div>
        </div>
      </div>
    </div>`,
    width: 320,
    height: 320,
  },

  // DM-588: per CSS 2.1 Appendix E §6, positioned siblings with z-index:0 and
  // z-index:auto paint at the SAME stack level in tree order — z-index:0
  // does NOT paint above z-index:auto. The previous bucketing sorted z=0
  // into the "positive" group and painted it last, which caused stripe's
  // billing-plan-graphic background gradients (z-index:0 SC) to render ON
  // TOP of the sibling white card (z-index:auto) instead of underneath it.
  //
  // Fixture: red box (z-index:0) appears first in DOM; blue box (z-index:auto)
  // appears second. Both have position:absolute with the same coordinates.
  // Chrome paints blue on top (later in tree order); a correct renderer must
  // match. If z-index:0 is treated as "positive", red ends up on top.
  {
    name: "z-index-zero-equals-auto",
    html: `<div style="position:relative;width:200px;height:200px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#dc2626;z-index:0;"></div>
      <div style="position:absolute;left:50px;top:50px;width:100px;height:100px;background:#58a6ff;"></div>
    </div>`,
    width: 220,
    height: 220,
  },

  // ── Regression: CSS gradients translated to SVG linear/radial gradients (SK-432) ──
  {
    // DM-855: a gradient applied directly to the captured root (<body>) must be
    // emitted, not dropped. Previously the root was only captured-as-an-element
    // when it had a solid background-color, so a gradient-only body (whose
    // backgroundColor is `transparent`) fell through and lost its background —
    // rendering as white-on-nothing. The 100vh child makes the body fill the
    // viewport so its captured box matches Chromium's background propagation.
    name: "root-gradient-background",
    bodyStyle: "background: linear-gradient(135deg, #1e3a8a, #2563eb);",
    html: `<div style="height: 100vh; display: flex; align-items: center; justify-content: center; color: #ffffff; font-family: -apple-system, sans-serif; font-size: 24px; font-weight: 700;">Root gradient</div>`,
    width: 320,
    height: 200,
  },
  {
    name: "gradient-linear",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 80px; height: 80px; background: linear-gradient(#dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: linear-gradient(to right, #dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: linear-gradient(90deg, red 0%, yellow 50%, green 100%);"></div>
    </div>`,
    width: 300,
    height: 110,
  },
  {
    name: "gradient-radial",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 80px; height: 80px; background: radial-gradient(#dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: radial-gradient(circle at center, red, yellow, green);"></div>
    </div>`,
    width: 220,
    height: 110,
  },
  {
    // Negative radial stops alter the gradient's radius domain in Blink. The
    // repeating cases exercise whole-period positive shifts; the final cell
    // exercises the non-repeating zero-radius color/domain adjustment.
    name: "gradient-radial-negative-domain",
    html: `<div style="padding:12px;display:flex;gap:8px;background:#fff">
      <div style="width:120px;height:120px;background:repeating-radial-gradient(circle 100px,#111 -30px -20px,#f8fafc -20px -10px)"></div>
      <div style="width:120px;height:120px;background:repeating-radial-gradient(circle 100px at 40% 60%,#dc2626 -10px 0,#2563eb 0 10px)"></div>
      <div style="width:120px;height:120px;background:radial-gradient(circle 100px,#dc2626 -20px,#2563eb 80px)"></div>
    </div>`,
    width: 410,
    height: 145,
  },

  // ── Regression: CSS clip-path translated to SVG <clipPath> (SK-436) ──
  // circle, inset, and polygon clip shapes on solid-colored boxes. Previously
  // clip-path was ignored; now shape is translated to absolute SVG coords.
  {
    name: "clip-path-shapes",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 60px; height: 60px; background: #dc2626; clip-path: circle(28px at 50% 50%);"></div>
      <div style="width: 60px; height: 60px; background: #3fb950; clip-path: inset(10px 5px 10px 5px);"></div>
      <div style="width: 60px; height: 60px; background: #58a6ff; clip-path: polygon(50% 0, 100% 100%, 0 100%);"></div>
    </div>`,
    width: 240,
    height: 90,
  },

  {
    // DM-2309: mask generated images use Blink's FillLayer round/space tile
    // adjustment, and 3+ mask layers compose bottom-up with each upper
    // layer's own Porter-Duff operator.
    name: "mask-advanced-tiling-composite",
    html: `<div style="padding:12px;display:flex;gap:12px;background:#fff">
      <div style="width:150px;height:90px;background:#2563eb;mask-image:linear-gradient(to right,#000 0 50%,transparent 50%);mask-size:55px 90px;mask-repeat:round no-repeat"></div>
      <div style="width:150px;height:90px;background:#16a34a;mask-image:linear-gradient(to right,#000 0 50%,transparent 50%);mask-size:55px 90px;mask-repeat:space no-repeat"></div>
      <div style="width:150px;height:90px;background:#7c3aed;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2255%22 height=%2290%22%3E%3Crect width=%2228%22 height=%2290%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:55px 90px;mask-position:25% 75%;mask-repeat:round no-repeat"></div>
      <div style="width:150px;height:90px;background:#c2410c;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2255%22 height=%2290%22%3E%3Crect width=%2228%22 height=%2290%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:55px 90px;mask-position:25% 75%;mask-repeat:space no-repeat"></div>
      <div style="width:150px;height:90px;background:#dc2626;mask-image:radial-gradient(circle at 35% 50%,#000 0 35%,transparent 36%),linear-gradient(to right,#000 0 65%,transparent 66%),linear-gradient(#000 0 55%,transparent 56%);mask-size:auto;mask-repeat:no-repeat;mask-composite:subtract,intersect"></div>
    </div>`,
    width: 822,
    height: 114,
  },

  {
    // DM-2379: contain/cover first become concrete Blink-owned image rects;
    // arbitrary length-percentage positions are not SVG Min/Mid/Max buckets.
    // The source images have asymmetric alpha so cover positioning remains
    // visible after clipping. Vertical writing is a physical-axis control and
    // the final cell crosses the computed-px/effective-zoom boundary.
    name: "mask-contain-cover-arbitrary-position",
    html: `<div style="padding:12px;display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;background:#fff;width:600px">
      <div style="width:120px;height:90px;background:#1b7ae0;mask-mode:alpha;mask-repeat:no-repeat;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22 viewBox=%220 0 200 100%22%3E%3Crect width=%2286%22 height=%22100%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:contain;mask-position:23% 73%"></div>
      <div style="width:120px;height:90px;background:#16a34a;mask-mode:alpha;mask-repeat:no-repeat;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22 viewBox=%220 0 200 100%22%3E%3Crect width=%2286%22 height=%22100%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:contain;mask-position:17px 9px"></div>
      <div style="width:120px;height:90px;background:#dc2626;mask-mode:alpha;mask-repeat:no-repeat;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22200%22 viewBox=%220 0 100 200%22%3E%3Crect width=%22100%22 height=%2276%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:cover;mask-position:17px calc(25% + 7px)"></div>
      <div style="width:120px;height:90px;background:#7c3aed;writing-mode:vertical-rl;mask-mode:alpha;mask-repeat:no-repeat;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22 viewBox=%220 0 200 100%22%3E%3Crect width=%2286%22 height=%22100%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:contain;mask-position:calc(25% + 7px) 73%"></div>
      <div style="width:120px;height:90px;zoom:1.25;background:#c2410c;mask-mode:alpha;mask-repeat:no-repeat;mask-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22 viewBox=%220 0 200 100%22%3E%3Crect width=%2286%22 height=%22100%22 fill=%22black%22/%3E%3C/svg%3E&quot;);mask-size:contain;mask-position:calc(25% + 7px) calc(75% - 3px)"></div>
    </div>`,
    width: 630,
    height: 230,
  },

  {
    // DM-2308: SVG natively carries opaque sRGB/linearRGB gradients; spaces
    // and premultiplied-alpha curves SVG cannot express are tiled from the
    // already-running Chromium capture page without sampled-stop fitting.
    name: "gradient-interpolation-spaces-alpha",
    html: `<div style="padding:12px;display:flex;flex-wrap:wrap;gap:10px;background:#fff;width:620px">
      <div style="width:140px;height:70px;background:linear-gradient(90deg in srgb-linear,#f00,#00f)"></div>
      <div style="width:140px;height:70px;background:linear-gradient(90deg in oklab,#f00,#00f)"></div>
      <div style="width:140px;height:70px;background:linear-gradient(90deg in oklch longer hue,#f00,#00f)"></div>
      <div style="width:140px;height:70px;background:linear-gradient(90deg in srgb,rgba(255,0,0,0),#00f)"></div>
      <div style="width:140px;height:70px;background:#16a34a;mask-image:radial-gradient(circle in oklab,#000 0 35%,transparent 70%);mask-repeat:no-repeat"></div>
    </div>`,
    width: 644,
    height: 184,
  },

  // ── Regression: clip-path: url(#id) with clipPathUnits="userSpaceOnUse" (DM-828) ──
  // The clipPath's coords are element-local (origin at the element's border-box,
  // verified against Chrome), but Domotion draws content at absolute (x, y), so
  // each consumer needs a copy of the clip translated to its own position. Two
  // boxes at different x-offsets share one userSpaceOnUse triangle clip — before
  // the fix both clips landed at the SVG origin (top-left), clipping both boxes
  // wrongly; now each paints its own downward triangle in place.
  {
    name: "clip-path-userspaceonuse-fragment",
    html: `<div style="padding: 16px; display: flex; gap: 16px;">
      <svg width="0" height="0" style="position: absolute" aria-hidden="true">
        <clipPath id="us-tri" clipPathUnits="userSpaceOnUse">
          <polygon points="0,0 120,0 60,90"/>
        </clipPath>
      </svg>
      <div style="width: 120px; height: 90px; background: linear-gradient(135deg, #e91e63, #3f51b5); clip-path: url(#us-tri);"></div>
      <div style="width: 120px; height: 90px; background: #16a34a; clip-path: url(#us-tri);"></div>
    </div>`,
    width: 304,
    height: 122,
  },

  // ── Regression: CSS filter + mix-blend-mode pass through to SVG (SK-433) ──
  // Three colored boxes with filters applied. The browser's SVG renderer honors
  // CSS 'filter' and 'mix-blend-mode' in <img src=svg>, so we pass the value
  // through verbatim on a wrapping <g style=...>.
  {
    name: "filter-passthrough",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #0d1117;">
      <div style="width: 60px; height: 60px; background: #dc2626; filter: blur(2px);"></div>
      <div style="width: 60px; height: 60px; background: #3fb950; filter: grayscale(1);"></div>
      <div style="width: 60px; height: 60px; background: #58a6ff; filter: brightness(0.5) contrast(1.5);"></div>
    </div>`,
    width: 260,
    height: 90,
  },
  // Blend mode passthrough: top-right quadrant of a colored box uses
  // mix-blend-mode: multiply against an underlying colored band.
  {
    name: "blend-mode-passthrough",
    html: `<div style="padding: 14px; background: #fef3c7;">
      <div style="position: relative; width: 180px; height: 80px; background: #dc2626;">
        <div style="position: absolute; inset: 10px; background: #58a6ff; mix-blend-mode: multiply;"></div>
      </div>
    </div>`,
    width: 240,
    height: 120,
  },
  // Background blending is a separate stack from descendant mix blending:
  // the image must multiply against the element's own red background color.
  {
    name: "background-blend-color-stack",
    html: `<div style="padding: 20px; background: #f8fafc;">
      <div style="width: 180px; height: 80px; background-color: #ef4444; background-image: linear-gradient(#14b8a6, #14b8a6); background-blend-mode: multiply;"></div>
    </div>`,
    width: 220,
    height: 120,
  },

  // ── Regression: overflow:hidden clips children (SK-440) ──
  // The inner span is wider than the parent. With overflow:hidden the visible
  // portion should stop at the parent's padding edge. Before the fix, the
  // overflowing text continued past the parent's right edge in the SVG.
  {
    name: "overflow-hidden-clips",
    html: `<div style="padding: 20px;"><div style="width: 160px; height: 40px; background: #161b22; border: 1px solid #30363d; overflow: hidden; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 13px; white-space: nowrap; padding: 8px;"><span>This is a very long unbreakable string that should be clipped</span></div></div>`,
    width: 220,
    height: 80,
  },

  // ── Regression: native form control chrome (SK-467) ──
  // Checkbox/radio with checked + unchecked states, progress, meter.
  // Chrome's UA-default rendering is synthesized by form-controls.ts.
  {
    name: "form-controls",
    html: `<div style="padding: 16px; background: #fff; display: flex; gap: 12px; align-items: center;">
      <input type="checkbox" />
      <input type="checkbox" checked />
      <input type="radio" />
      <input type="radio" checked />
      <progress value="60" max="100" style="width: 80px; height: 8px;"></progress>
      <meter value="40" max="100" style="width: 80px; height: 8px;"></meter>
    </div>`,
    width: 360,
    height: 70,
  },

  // ── Regression: border-image 9-slice with url() source (SK-466) ──
  // Inline data-URI so the capture sees an image that loads synchronously.
  // 32x32 SVG with a red ring frame so the 9-slice corners/edges/center are visible.
  {
    name: "border-image-round-fill",
    // DM-730: `border-image-repeat: round` + `border-image-slice: N fill`
    // must tile the center slice in BOTH directions (using top-edge
    // horizontal-tile width and left-edge vertical-tile height — per CSS
    // Backgrounds 3 §6.1.3). The old code stretched the center to fill the
    // whole inner cell, masking the tile-count behavior Chrome paints.
    // Source SVG is 3:1 (90×30); slice 10 + a 60×60 cell with 10px borders
    // gives 4 vertical center tiles, 1 horizontal.
    html: `<div style="padding:20px;background:#0d1117"><div style="display:inline-block;width:60px;height:60px;border:10px solid transparent;border-image-source:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 90 30%22 width=%2290%22 height=%2230%22><rect width=%2290%22 height=%2230%22 fill=%22%230891b2%22/><rect x=%2210%22 y=%2210%22 width=%2270%22 height=%2210%22 fill=%22%23fbbf24%22/></svg>');border-image-slice:10 fill;border-image-repeat:round;"></div></div>`,
    width: 120,
    height: 120,
  },
  {
    name: "border-image-stretch",
    html: `<div style="padding: 20px; background: #0d1117;">
      <div style="width: 150px; height: 90px; background: #161b22; border: 16px solid transparent;
        border-image-source: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22 width=%2232%22 height=%2232%22><rect x=%220%22 y=%220%22 width=%2232%22 height=%2232%22 fill=%22%23dc2626%22/><rect x=%228%22 y=%228%22 width=%2216%22 height=%2216%22 fill=%22%23161b22%22/></svg>');
        border-image-slice: 8; border-image-repeat: stretch;"></div>
    </div>`,
    width: 220,
    height: 160,
  },

  // ── Regression: 3D border styles - double/groove/ridge/inset/outset (SK-470) ──
  // Smoke test — double is the closest to Chromium (no shading heuristic).
  // The shaded styles (groove/ridge/inset/outset) land within ~3-4% of
  // Chromium because the exact L-delta Chromium uses isn't documented; they're
  // covered indirectly by the 18-border-styles html-test (now passes at <3%).
  {
    name: "border-style-double",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #94a3b8;">
      <div style="width: 80px; height: 60px; border: 12px double #334155; background: #f1f5f9;"></div>
    </div>`,
    width: 140,
    height: 110,
  },

  // ── Regression: border styles + per-side borders (SK-437) ──
  // dashed/dotted uniform borders, plus a per-side box with 4 different widths
  // and colors. Before the fix these all collapsed to a single solid <rect>.
  {
    name: "border-styles-variants",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #0d1117;">
      <div style="width: 80px; height: 50px; border: 3px dashed #58a6ff;"></div>
      <div style="width: 80px; height: 50px; border: 3px dotted #3fb950;"></div>
      <div style="width: 80px; height: 50px; border-top: 4px solid #f85149; border-right: 2px dashed #d29922; border-bottom: 6px dotted #8b949e; border-left: 8px solid #58a6ff;"></div>
    </div>`,
    width: 320,
    height: 90,
  },
  {
    // Blink strokes one closed rounded centerline per visible dashed/dotted
    // side, then clips it to that side's miter wedge. This matrix crosses
    // widths, colors, missing sides, asymmetric radii, and side orientation;
    // the old straight-line-plus-outer-clip route visibly loses every arc.
    name: "border-rounded-mixed-dashed-dotted",
    html: `<div style="padding:16px;background:#0d1117;display:grid;grid-template-columns:repeat(4,92px);gap:14px">
      <i style="width:72px;height:52px;border-radius:18px;border-top:4px solid #f85149;border-right:2px dashed #d29922;border-bottom:6px dotted #8b949e;border-left:8px solid #58a6ff"></i>
      <i style="width:72px;height:52px;border-radius:28px 5px 20px 9px;border-top:10px solid #58a6ff;border-right:3px dashed #f85149;border-bottom:5px dotted #3fb950;border-left:2px solid #d29922"></i>
      <i style="width:72px;height:52px;border-radius:22px;border-top:none;border-right:7px dotted #bc8cff;border-bottom:2px dashed #58a6ff;border-left:5px solid #3fb950"></i>
      <i style="width:72px;height:52px;border-radius:8px 24px;border-top:3px dashed #3fb950;border-right:9px solid #f85149;border-bottom:4px dotted #d29922;border-left:none"></i>
      <i style="width:72px;height:52px;border-radius:26px;border-top:8px dotted #f85149;border-right:2px solid #58a6ff;border-bottom:3px dashed #bc8cff;border-left:5px solid #3fb950"></i>
      <i style="width:72px;height:52px;border-radius:5px 20px 30px 12px;border-top:2px solid #d29922;border-right:6px dotted #8b949e;border-bottom:9px solid #58a6ff;border-left:3px dashed #f85149"></i>
      <i style="width:72px;height:52px;border-radius:50%;border-top:4px dashed #58a6ff;border-right:8px solid #3fb950;border-bottom:6px dotted #f85149;border-left:2px solid #d29922"></i>
      <i style="width:72px;height:52px;border-radius:16px;border:0;border-top:5px dotted #bc8cff;border-left:7px dashed #d29922"></i>
    </div>`,
    width: 440,
    height: 180,
  },

  // ── Regression: element opacity applies to children (SK-434) ──
  // opacity: 0.5 on the parent should tint both its bg AND its text/child badge.
  // Before the fix, only the bg rect got the opacity attribute and text/children
  // stayed fully opaque, producing a visible mismatch.
  {
    name: "color-opacity-children",
    html: `<div style="padding: 20px; background: #30363d;"><div style="opacity: 0.5; background: #dc2626; padding: 10px; color: white; font-family: -apple-system, sans-serif;">Parent 50% opacity<span style="background: #fbbf24; color: #111; padding: 2px 6px; margin-left: 6px;">child badge</span></div></div>`,
    width: 360,
    height: 100,
  },

  // ── DM-457: replaced-element static snapshots ──
  // <canvas> / <video> / <iframe> / <object> / <embed> are captured as a
  // per-element page.screenshot under a hide-everything-else stylesheet, then
  // emitted as <image> at the element's content-box rect. See docs/17.
  {
    name: "replaced-canvas-shape",
    html: `<div style="padding:20px;"><canvas id="c1" width="200" height="100" style="display:block;background:#222;"></canvas></div><script>(function(){var c=document.getElementById('c1').getContext('2d');c.fillStyle='#fff';c.fillRect(40,20,120,60);c.fillStyle='#3fb950';c.beginPath();c.arc(100,50,15,0,Math.PI*2);c.fill();})();</script>`,
    width: 240,
    height: 140,
  },
  {
    // DM-2380: the canvas source is local to both affine wrappers. Sampling
    // Chrome's final transformed AABB and emitting it inside these wrappers
    // rotates/scales the pixels twice; applying its clip delta to the local
    // rect also stretches the asymmetric red/blue split. The green sibling is
    // deliberately outside raster ownership.
    name: "replaced-canvas-transformed-clip",
    html: `<div style="position:absolute;left:8px;top:24px;width:190px;height:120px;zoom:1.1;transform:rotate(11deg);transform-origin:35px 20px"><div style="position:absolute;left:-22px;top:18px;transform:scale(1.08,.88) skewX(7deg);transform-origin:15px 12px"><canvas id="c2380" width="130" height="78" style="display:block;width:130px;height:78px"></canvas></div></div><div style="position:absolute;left:260px;top:20px;width:32px;height:28px;background:#00bb55"></div><script>(function(){var c=document.getElementById('c2380').getContext('2d');c.fillStyle='#ed1234';c.fillRect(0,0,37,78);c.fillStyle='#164ee8';c.fillRect(37,0,93,78);})();</script>`,
    width: 340,
    height: 190,
  },
  {
    name: "replaced-video-poster",
    html: `<div style="padding:20px;"><video poster="data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 120'><rect width='200' height='120' fill='%23222'/><polygon points='80,40 80,80 120,60' fill='white'/></svg>")}" width="200" height="120" style="display:block;background:#000;"></video></div>`,
    width: 240,
    height: 160,
  },
  {
    // Blink computes a concrete replaced-content rectangle before paint.
    // These non-min/mid/max positions cannot be represented by SVG's native
    // preserveAspectRatio alignment buckets, and scale-down must choose the
    // smaller of the intrinsic and contain sizes.
    name: "image-concrete-object-fit-position",
    html: `<div style="padding:20px;background:#e2e8f0;display:flex;gap:12px">
      <img alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ed1234"/><circle cx="12" cy="12" r="8" fill="#fde047"/></svg>')}" style="display:block;width:140px;height:100px;background:#0f172a;object-fit:contain;object-position:25% 75%">
      <img alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0ea5e9"/><circle cx="68" cy="28" r="8" fill="#fde047"/></svg>')}" style="display:block;width:140px;height:100px;background:#0f172a;object-fit:cover;object-position:calc(100% - 10px) calc(100% - 20px)">
      <img alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="30"><rect width="50" height="30" fill="#22c55e"/></svg>')}" style="display:block;width:140px;height:100px;background:#0f172a;object-fit:scale-down;object-position:30% 80%">
    </div>`,
    width: 496,
    height: 140,
  },
  {
    name: "replaced-canvas-overlay",
    html: `<div style="padding:20px;"><div style="position:relative;width:200px;height:100px;"><canvas id="c3" width="200" height="100" style="display:block;background:#444;position:absolute;left:0;top:0;z-index:1;"></canvas><div style="position:absolute;left:60px;top:30px;width:80px;height:40px;background:rgba(220,38,38,0.7);z-index:10;"></div></div></div><script>(function(){var c=document.getElementById('c3').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,200,100);c.fillStyle='#000';c.fillRect(20,20,30,30);c.fillRect(150,50,30,30);})();</script>`,
    width: 240,
    height: 140,
  },
  {
    // Sibling div above canvas via a fixed-position ancestor — exercises the
    // hide-everything-else stylesheet's ability to suppress out-of-tree
    // overlays during the snapshot. Pseudo-element overlays (::before/::after
    // with content:"") are also suppressed by the same CSS visibility
    // inheritance but the renderer doesn't synthesize their backgrounds onto
    // the SVG, so a fixture that exercises them comparably is deferred — the
    // snapshot isolation itself is the same property as this test.
    name: "replaced-canvas-fixed-overlay",
    html: `<div style="padding:20px;position:relative;"><canvas id="c4" width="200" height="100" style="display:block;background:#888;"></canvas><div style="position:absolute;left:70px;top:50px;width:100px;height:40px;background:#22c55e;"></div></div><script>(function(){var c=document.getElementById('c4').getContext('2d');c.fillStyle='#1f6feb';c.fillRect(0,0,200,100);})();</script>`,
    width: 240,
    height: 140,
  },
  {
    // DM-462: background-clip:text + transparent text-fill-color → the
    // bg-image fills the glyph shapes (gradient headline pattern). Renderer
    // suppresses the bg rect for the text-clipped layer and routes the
    // gradient as fill on the text glyph group.
    name: "text-bg-clip-gradient",
    html: `<div style="padding:24px;background:#0d1117;font-family:-apple-system,sans-serif;"><h1 style="font-size:36px;font-weight:800;margin:0;background:linear-gradient(90deg,#22d3ee 0%,#a855f7 50%,#f97316 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;">Gradient Headline</h1></div>`,
    width: 360,
    height: 110,
  },
  {
    name: "replaced-iframe-same-origin",
    html: `<div style="padding:20px;"><iframe srcdoc="<html><body style='margin:0;background:#225;color:#fff;font-family:sans-serif;'><div style='padding:14px;font-size:18px;'>Hello iframe</div></body></html>" width="240" height="100" style="display:block;border:0;"></iframe></div>`,
    width: 280,
    height: 140,
  },
  {
    // DM-1446: a recursed same-origin iframe whose inner content references a
    // same-document clip-path fragment (#innerClip) AND a mask fragment
    // (#innerMask) defined in the iframe's own <defs>. Discovery must resolve
    // those ids against the INNER document (el.ownerDocument), not the outer
    // one, so the <clipPath>/<mask> defs are hoisted and the shapes paint.
    name: "iframe-inner-clip-mask",
    html: `<div style="padding:16px;"><iframe srcdoc="<html><body style='margin:0;background:#fff'><svg width='0' height='0'><defs><clipPath id='innerClip' clipPathUnits='objectBoundingBox'><circle cx='0.5' cy='0.5' r='0.5'/></clipPath><mask id='innerMask'><rect width='120' height='120' fill='white'/><rect x='30' y='30' width='60' height='60' fill='black'/></mask></defs></svg><div style='width:120px;height:120px;background:#e11d48;clip-path:url(#innerClip)'></div><div style='width:120px;height:120px;background:#0ea5e9;-webkit-mask-image:url(#innerMask);mask-image:url(#innerMask)'></div></body></html>" width="160" height="240" style="display:block;border:0;"></iframe></div>`,
    width: 220,
    height: 280,
    relaxedDiffPct: 0.5,
  },
  {
    // DM-1448: recursed iframe TALLER than its inner content. Chrome fills the
    // iframe canvas with the inner body's background (propagated) across the
    // whole inner viewport; the recursion must paint the strip below the
    // content with that canvas color (not leave it transparent → outer bg).
    // Inner body bg is a distinct teal; content is only ~90px in a 200px frame.
    name: "iframe-canvas-bg-fill",
    html: `<div style="padding:16px;background:#0d1117;"><iframe srcdoc="<html><body style='margin:0;background:#0d9488;color:#fff;font-family:sans-serif'><div style='padding:16px;font-size:16px'>Short content</div></body></html>" width="200" height="200" style="display:block;border:0;"></iframe></div>`,
    width: 240,
    height: 240,
  },
  {
    // DM-1441: same-origin iframe recursion through a non-zero border + padding
    // on the iframe itself. The inner document's (0,0) origin must land at the
    // iframe's CONTENT box (border-left + padding-left in, border-top +
    // padding-top down), and the inner subtree must clip to that content box.
    // Inner content mixes text + a positioned colored box to exercise the
    // coordinate offset across multiple node kinds.
    name: "iframe-recursion-bordered",
    html: `<div style="padding:24px;"><iframe srcdoc="<html><body style='margin:0;background:#0b1b34;color:#e6edf3;font-family:sans-serif;'><div style='padding:12px;font-size:16px;'>Native&nbsp;SVG</div><div style='margin:0 12px;width:120px;height:24px;background:#22d3ee;'></div></body></html>" width="220" height="120" style="display:block;border:6px solid #f97316;padding:8px;background:#0b1b34;"></iframe></div>`,
    width: 300,
    height: 180,
  },
  {
    // DM-498: positioned button overlay must paint ABOVE preceding-sibling
    // artwork in the same stacking context. Mirrors apple.com's hero where a
    // <picture> (transform; position:absolute) appears before the button
    // overlay in DOM order, and the buttons should paint on top of the
    // artwork via positioned-on-top stacking. Domotion was emitting the
    // image AFTER the buttons in the SVG, causing it to overpaint them.
    name: "stacking-button-overlay-above-artwork",
    html: `<div style="position:relative;width:300px;height:160px;overflow:hidden;background:#0d1117;"><div style="position:absolute;inset:0;transform:translateX(0);"><div style="background:linear-gradient(135deg,#1d4ed8 0%,#312e81 100%);width:100%;height:100%;"></div></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"><a style="background:#0071e3;color:white;padding:8px 16px;border-radius:18px;font-family:-apple-system,sans-serif;font-size:14px;text-decoration:none;">Shop</a></div></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-498: same as above but the artwork wrapper uses `will-change:
    // transform` instead of (or in addition to) the actual `transform`.
    // Apple's carousel applies will-change for animation perf without an
    // initial transform value — Domotion previously didn't detect this as
    // an SC-creating signal, so positioned descendants of NON-will-change
    // siblings would hoist past the will-change wrapper and the overlay
    // button could end up emitted before the artwork. CSS spec: a
    // will-change listing any SC-creating property creates an SC.
    name: "stacking-will-change-creates-sc",
    html: `<div style="position:relative;width:300px;height:160px;overflow:hidden;background:#0d1117;"><div style="position:absolute;inset:0;will-change:transform;"><div style="background:linear-gradient(135deg,#7c3aed 0%,#1e3a8a 100%);width:100%;height:100%;"></div></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"><a style="background:#0071e3;color:white;padding:8px 16px;border-radius:18px;font-family:-apple-system,sans-serif;font-size:14px;text-decoration:none;">Shop</a></div></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-497: pseudo-element paint box. ::after with bg-color + border-radius
    // + padding (badge / pill pattern). Capture records the pseudo's own
    // bg-color and border-radius on the segment, the renderer emits a <rect>
    // behind the glyph paths so the red pill paints under the white text.
    // The pseudo is on a span whose own positioning is `position: relative`
    // with the pseudo `position: absolute`, so the box anchors directly off
    // the captured pcs.left / pcs.top and the pcs padding/border are added
    // to xPos at capture time (the cleanest path for box geometry — see
    // CAPTURE_SCRIPT line ~1486).
    name: "pseudo-after-badge",
    html: `<div style="padding:32px;background:#0d1117;width:200px;height:80px;font-family:-apple-system,sans-serif;"><span class="m" style="position:relative;display:inline-block;width:60px;height:30px;background:#1f6feb;"></span><style>.m::after{content:'X';position:absolute;top:0;right:-50px;background:#dc2626;width:40px;height:30px;line-height:30px;font-size:11px;color:transparent;text-align:center;}</style></div>`,
    width: 280,
    height: 160,
  },
  {
    // DM-1271: a color emoji in `::after` content (`content: " 📄"`) whose
    // painted square (its glyph advance, ~1.25× font-size — 20px at font-size
    // 16) is TALLER than the `line-height:normal` line box (18px). The segment-
    // level raster screenshots the line box, so a line-box-tall rect clipped the
    // emoji's vertical overflow and re-embedded it ~2px low ("emoji looks clipped
    // on top a bit"). The capture pass now grows the raster rect to the emoji's
    // square (whitespace + CSS quote delimiters excluded from the advance),
    // centered on the real line box, and the renderer drops the line-box clip for
    // the overflowing emoji so the full glyph paints where Chrome puts it.
    name: "pseudo-after-emoji-overflows-line-box",
    html: `<div style="padding:40px;background:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:normal;"><a href="report.pdf" style="color:#1d4ed8;text-decoration:none;">Quarterly report</a><style>a[href$=".pdf"]::after{content:" 📄";}</style></div>`,
    width: 360,
    height: 120,
  },
  {
    // DM-783: CSS check-mark idiom — empty `::before` with a right + bottom
    // border, sized 6×12, rotated 45° around its centre. Before the pseudo's
    // own `transform` was captured + emitted as a `<g transform="…">` wrapper,
    // the L-shape painted axis-aligned, reading as a backwards-L instead of a
    // tick. Verifies (a) the per-side border emit for the empty-content
    // pseudoBox, (b) transform-origin centring on the pseudo's own box (not
    // the host's origin), (c) z-stacking — text + box wrap together so the
    // tick lands inside the green circle.
    name: "pseudo-before-checkmark-rotated",
    html: `<div style="padding:24px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:10px;color:#e6edf3;font-size:13px;"><span style="display:inline-block;position:relative;width:18px;height:18px;background:#22c55e;border-radius:50%;"><span style="position:absolute;left:6px;top:2px;width:5px;height:10px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(45deg);transform-origin:50% 50%;display:block;"></span></span>Completed</div>`,
    width: 200,
    height: 80,
  },
  {
    // DM-782: text-content `::before` with `background: linear-gradient(...)`
    // and white glyph text — the "gradient badge / pill / chip" pattern
    // (`32-real-world-pricing-table` MOST POPULAR badge). Previously the
    // background-image was dropped at capture-inject and the box painted with
    // `fill="none"`, so only the white glyphs were visible. Verifies the
    // gradient layer reaches the renderer and paints under the text.
    name: "pseudo-before-gradient-badge",
    html: `<div style="padding:40px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;"><span class="badge" style="position:relative;display:inline-block;padding:28px 18px;background:#161b22;color:#e6edf3;font-size:13px;border-radius:6px;width:160px;text-align:center;">Pro Tier<style>.badge::before{content:'NEW';position:absolute;top:-10px;right:-12px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;}</style></span></div>`,
    width: 280,
    height: 140,
  },
  {
    // DM-785: rotated gradient pill with `width: auto` absolute `::before`.
    // The pseudo's shrink-to-fit width is taken from the painted text, which
    // canvas.measureText drifted from by 1-3px on bold uppercase short strings
    // — the badge box ended up undersized vs Chrome's paint, and the rotation
    // amplified the visible mismatch (text overflowed the gradient on one
    // side). Swapping the canvas measurement for an off-screen <span>
    // getBoundingClientRect probe matches Chrome's HarfBuzz layout exactly.
    name: "pseudo-before-rotated-gradient-badge",
    html: `<div style="padding:40px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;"><span class="ribbon" style="position:relative;display:inline-block;padding:30px 22px;background:#161b22;color:#e6edf3;font-size:13px;border-radius:6px;width:180px;text-align:center;">Premium<style>.ribbon::before{content:'MOST POPULAR';position:absolute;top:-14px;left:50%;transform:translateX(-50%) rotate(-8deg);background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 12px;border-radius:999px;white-space:nowrap;}</style></span></div>`,
    width: 320,
    height: 160,
  },
  {
    // DM-1105: an in-flow `::before` text marker (a code-diff "+" gutter) on a
    // host whose content begins with a CHILD element (a syntax-highlight token
    // span), not with the host's own text. The injection re-anchor used the
    // host's first OWN text segment — which sits AFTER the leading token span —
    // so the "+" landed mid-line instead of at the line start. Chrome paints a
    // static ::before at the host's content-box left and pushes all following
    // content (child spans included) right; the marker must clamp to that.
    // NOTE: the precise positioning is gated by `pseudo-before-marker.e2e.test.ts`
    // (asserts the captured "+" segment x is at the content-box left, not
    // mid-line) — the perceptual visual-diff gate is too lenient on a thin
    // marker to catch a ~110px x-shift on its own. This fixture documents the
    // case and guards the end-to-end paint.
    name: "pseudo-before-marker-child-first-content",
    html: `<div style="background:#0d1117;padding:20px;"><style>.code{position:relative;display:block;white-space:pre;font:22px/30px monospace;color:#c9d1d9;}.code::before{content:"+";color:#3fb950;}.kw{color:#ff7b72;}</style><div class="code"><span class="kw">function</span> run</div></div>`,
    width: 320,
    height: 80,
  },
  {
    // DM-751: `transform-style: preserve-3d` creates a 3D rendering context
    // where children sort by Z position in 3D space (`translateZ`), NOT by
    // z-index (CSS Transforms 2 §6). Without honoring the Z, a child with
    // a low z-index but a positive `translateZ` paints behind siblings with
    // higher z-index, instead of in front of them where Chrome paints.
    name: "preserve-3d-translatez-paint-order",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;"><div style="transform-style:preserve-3d;perspective:600px;position:relative;width:300px;height:160px;background:#1e293b;"><div style="position:absolute;top:20px;left:40px;width:120px;height:120px;background:#6d28d9;z-index:5;color:white;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;">z=5 (purple)</div><div style="position:absolute;top:50px;left:90px;width:120px;height:120px;background:#ea580c;z-index:1;transform:translateZ(20px);color:white;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;">z=1 +Z (orange)</div><div style="position:absolute;top:80px;left:140px;width:120px;height:120px;background:#0ea5e9;z-index:10;color:white;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;">z=10 (sky)</div></div></div>`,
    width: 380,
    height: 230,
  },
  {
    // DM-749: Stripe's keynote-speaker pattern — gradient + `background-clip:
    // text` + `webkit-text-fill-color: transparent` lives on the PARENT
    // span; the actual text is in a child div with no background of its
    // own. Chrome's paint propagates the parent's gradient through the
    // descendant text shapes because background-clip: text masks the
    // gradient by the union of all descendant glyphs. Capture walks up the
    // ancestor chain (up to 8 levels) looking for the gradient owner.
    name: "background-clip-text-inherited-from-ancestor",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;font-size:30px;font-weight:700;"><span style="display:inline-block;background-image:linear-gradient(0deg,#ff2ede,#d298ff);background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:#061b31;"><div>Patrick</div><div>Collison</div></span></div>`,
    width: 320,
    height: 130,
  },
  {
    // DM-1053: a child element with its OWN `background-clip: text` gradient
    // nested inside an ancestor that also uses bg-clip:text — AND the child's
    // text WRAPS to multiple lines (so it renders via the inline-fragment
    // path). The child's own gradient must win over the ancestor's for its
    // run of glyphs. Mirrors resend.com's "Integrate this morning" hero where
    // "this morning" (a gold `... in oklab` gradient) wraps inside a white-
    // gradient H2; the inline-fragment renderer used to skip the child's
    // text-clip layer and paint it with the inherited white gradient.
    name: "background-clip-text-nested-child-wraps",
    html: `<div style="padding:24px;background:#000;font-family:system-ui,sans-serif;"><h2 style="margin:0;width:250px;font-size:40px;font-weight:800;line-height:1.1;background-image:linear-gradient(to right bottom,#fff 30%,rgba(255,255,255,0.5));background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:transparent;">Integrate <span style="background-image:linear-gradient(to right bottom in oklab,rgb(255,255,146) 0%,rgb(238,137,18) 100%);background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:transparent;">this morning</span></h2></div>`,
    width: 320,
    height: 150,
  },
  {
    // DM-722: `border-image-source` with a CSS gradient. The 9-slice URL
    // path bails when the source is a gradient because it expects a fixed
    // intrinsic size. For the common `border-image: <grad> 1` case (slice 1,
    // stretch), emit a "border ring" path filled with the gradient scoped to
    // the border-image-area instead — matches Chrome's paint because slice 1
    // + stretch effectively maps a continuous gradient along all four sides.
    name: "border-image-gradient-source",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;"><div style="display:inline-block;width:240px;height:60px;border:8px solid transparent;border-image:linear-gradient(45deg,#dc2626,#f59e0b,#10b981,#0ea5e9) 1;color:#fff;font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:center;">gradient border</div></div>`,
    width: 320,
    height: 130,
  },
  {
    // DM-794 follow-up to DM-722: `border-image-source: <gradient>` with a
    // non-trivial slice value (here `25% fill` + `width: 16px`) must do a
    // proper 9-slice — each corner / edge / center sees a different region
    // of the gradient stretched to its destination slot, not a continuous
    // ring fill of the whole area. Verifies the renderer's per-slot
    // viewBox-into-source-gradient remap.
    name: "border-image-gradient-source-sliced",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;"><div style="display:inline-block;width:240px;height:80px;border:16px solid transparent;border-image:linear-gradient(45deg,#dc2626,#f59e0b,#10b981,#0ea5e9) 25% fill / 16px / 0 stretch;color:#fff;font-weight:600;font-size:13px;"></div></div>`,
    width: 320,
    height: 160,
  },
  {
    // DM-758: `mask-border` (legacy `-webkit-mask-box-image`) with a
    // gradient source + `slice 1 fill / 0 / 0` paints the entire element
    // through the gradient as a mask. Verifies the gradient routes through
    // the existing mask-image pipeline with `mask-size: 100% 100%` + no-repeat.
    name: "mask-border-gradient-source",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;"><div style="width:240px;height:120px;background:linear-gradient(135deg,#1d4ed8,#ec4899);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;-webkit-mask-box-image:linear-gradient(45deg,black 20%,transparent 50%,black 80%) 1 / 0 / 0;mask-border:linear-gradient(45deg,black 20%,transparent 50%,black 80%) 1 / 0 / 0;">diagonal fade</div></div>`,
    width: 300,
    height: 180,
  },
  {
    // DM-755: CSS `zoom` scales BOTH layout and paint. Chrome includes the
    // zoom factor in `getBoundingClientRect()` but NOT in
    // `getComputedStyle().fontSize` (which returns pre-zoom CSS pixels), so
    // text inside a `zoom: 2` box was painted at the base font size in a
    // 2× layout box. Folding zoom into the same cumulative-scale map that
    // already pre-scales fontSize for `transform: scale()` makes the text
    // paint at the effective zoomed size.
    name: "zoom-scaled-card-text",
    html: `<div style="padding:24px;background:#0d1117;font-family:system-ui,sans-serif;display:flex;align-items:center;gap:16px;"><div style="zoom:1;background:#2563eb;color:white;padding:8px 14px;border-radius:4px;font-weight:700;font-size:13px;">zoom: 1</div><div style="zoom:2;background:#2563eb;color:white;padding:8px 14px;border-radius:4px;font-weight:700;font-size:13px;">zoom: 2</div></div>`,
    width: 380,
    height: 140,
  },
  {
    // DM-791: Greek `<mi>` letters get the same mathvariant=italic
    // substitution as Latin (α → 𝛼 U+1D6FC, Β → 𝛣 U+1D6E3, etc., with
    // explicit fallbacks at the symbol-variant codepoints ∂ ϵ ϑ ϰ ϕ ϱ ϖ ∇).
    name: "mathml-mi-greek-italic",
    html: `<div style="padding:24px;background:#fff;font-family:system-ui,sans-serif;"><math display="block" style="font-size:24px"><mi>α</mi><mo>+</mo><mi>β</mi><mo>=</mo><mi>π</mi><mo>·</mo><msup><mi>r</mi><mn>2</mn></msup><mo>-</mo><msup><mi>e</mi><mi>θ</mi></msup></math></div>`,
    width: 360,
    height: 120,
  },
  {
    // DM-747: MathML `<mi>` with a single ASCII letter is painted by Chrome
    // using the Mathematical Italic alphabet (the mathvariant=italic mapping
    // from MathML Core). Chrome reports `font-style: normal` on `<mi>` even
    // when it paints `<mi>a</mi>` as U+1D44E (𝑎, MATHEMATICAL ITALIC SMALL
    // A) — the substitution happens at paint time, not via CSS. Capture
    // applies the mapping itself so the downstream shaping pipeline picks up
    // the right glyphs from whatever math font the system has.
    name: "mathml-mi-italic-letters",
    html: `<div style="padding:24px;background:#fff;font-family:system-ui,sans-serif;"><math display="block" style="font-size: 22px;"><mrow><mo>(</mo><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable><mo>)</mo></mrow></math></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-2397: generated Chromium operator-dictionary coverage. The first
    // row includes vertical stretchy pairs absent from the former curated
    // fence set; the second keeps inline-axis stretchy arrows and large-op
    // metadata from being misrouted through the vertical fence renderer.
    name: "mathml-generated-operator-dictionary",
    html: `<div style="padding:18px;background:#fff;color:#111;font-family:math,serif"><math display="block" style="font-size:24px"><mrow><mo>⟦</mo><mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mrow><mi>c</mi><mo>−</mo><mi>d</mi></mrow></mfrac><mo>⟧</mo><mo>⟮</mo><mfrac><mi>x</mi><mi>y</mi></mfrac><mo>⟯</mo><mo>⦃</mo><mfrac><mn>1</mn><mi>z</mi></mfrac><mo>⦄</mo></mrow></math></div>`,
    width: 460,
    height: 130,
  },
  {
    // DM-788: `counter(name, custom-style)` / `counters(name, sep, custom-style)`
    // inside pseudo `content` should run the counter value through the named
    // `@counter-style`. Chrome's empirical paint includes the pad-applied
    // value only — prefix / suffix are reserved for marker context, not the
    // `counter()` function. Verifies `content: counter(step, padded2)`
    // renders as `01Intro` / `02Body` (numeric system + `pad: 2 "0"`).
    name: "counter-style-counter-function-with-pad",
    html: `<div style="padding:24px;background:#fff;font-family:system-ui,sans-serif;font-size:16px;"><style>@counter-style padded2 { system: numeric; symbols: "0" "1" "2" "3" "4" "5" "6" "7" "8" "9"; pad: 2 "0"; } .sc { counter-reset: step; } .sc h3 { counter-increment: step; margin: 4px 0; font-size:16px; } .sc h3::before { content: counter(step, padded2); color:#1d4ed8; font-family: ui-monospace, monospace; margin-right: 8px; }</style><div class="sc"><h3>Intro</h3><h3>Body</h3><h3>Wrap</h3></div></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-770: `@counter-style` resolution at capture time. CSS exposes
    // computed `::marker { content }` as the literal `"normal"` even when
    // the painted marker is a custom symbol, so the capture walker re-
    // implements the resolution algorithm (cyclic / fixed / numeric /
    // alphabetic / symbolic / additive systems, plus prefix / suffix / pad
    // / negative / range / fallback / extends descriptors). Verifies the
    // baseline cyclic + numeric paths against an emoji-bullet (cyclic) and
    // a prefixed numeric counter with `pad: 2 "0"`.
    name: "counter-style-cyclic-and-prefixed-numeric",
    html: `<div style="padding:24px;background:#fff;font-family:system-ui,sans-serif;font-size:14px;line-height:1.7;"><style>@counter-style domo-emoji { system: cyclic; symbols: "🔵" "🟢" "🟡"; suffix: " "; } @counter-style domo-step { system: numeric; symbols: "0" "1" "2" "3" "4" "5" "6" "7" "8" "9"; prefix: "Step "; suffix: ":  "; pad: 2 "0"; } ul.a{list-style:domo-emoji;padding-left:32px;margin:0 0 12px;} ol.b{list-style:domo-step;padding-left:64px;margin:0;}</style><ul class="a"><li>First</li><li>Second</li><li>Third</li><li>Wraps to first</li></ul><ol class="b"><li>Initialize</li><li>Migrate</li><li>Seed</li></ol></div>`,
    width: 320,
    height: 260,
  },
  {
    // DM-787: per-axis `overflow-x: clip; overflow-y: visible` (and the
    // inverse) — CSS Overflow 3 allows mixing `clip` with `visible` (only
    // `clip` permits this; `hidden + visible` coerces to `auto + hidden`).
    // Chrome paints only on the clipped axis; descendants escape on the
    // visible axis. The SVG `clipPath` rect would otherwise cut on both
    // axes, so the unclamped axis is extended by ±100000 px in the clip emit.
    name: "overflow-per-axis-clip",
    html: `<div style="padding:32px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;gap:32px;"><div style="width:140px;height:80px;background:#1e293b;border:2px solid #475569;overflow-x:clip;overflow-y:visible;position:relative;"><div style="width:120px;height:180px;background:linear-gradient(135deg,#1d4ed8,#ec4899);color:#fff;padding:8px;font-size:12px;">y can escape, x cannot</div></div></div>`,
    width: 280,
    height: 260,
  },
  {
    // DM-761: `overflow: clip` with `overflow-clip-margin` extends the clip
    // outward from a reference box (content / padding / border) by a length.
    // Without margin support the SVG clipPath stays at the padding box, so a
    // child wider than the parent's content area gets cut at the inner edge
    // even though Chrome paints it 20 px past on every side. Verifies that
    // `overflow-clip-margin: 20px` lets the gradient child overflow 20 px.
    name: "overflow-clip-margin",
    html: `<div style="padding:24px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;gap:32px;"><div style="width:140px;height:80px;background:#1e293b;border:2px solid #475569;overflow:clip;overflow-clip-margin:20px;position:relative;"><div style="width:220px;height:80px;background:linear-gradient(135deg,#1d4ed8,#ec4899);color:#fff;padding:8px;font-size:12px;">expands 20px outward</div></div></div>`,
    width: 280,
    height: 160,
  },
  {
    // DM-768: static `display: inline-block` pseudo with `vertical-align: middle`
    // — the CSS-triangle down-caret idiom (`width: 0; height: 0; border-left:
    // transparent; border-right: transparent; border-top: solid currentColor`).
    // The pseudo lands inside the inline flow at `baseline − 0.5 × x-height`,
    // not at the line-box top, but the prior static-flow position formula used
    // `rect.top + hostBorT + hostPadT + pMarT` and pinned the pseudo 6-7 px too
    // high. Verifies that a sentinel-probed pseudo position correctly aligns
    // the caret with the surrounding text.
    name: "pseudo-after-down-caret-vertical-align",
    html: `<div style="padding:24px;background:#fff;font-family:-apple-system,sans-serif;font-size:14px;"><style>.menu{display:inline-block;padding:6px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;}.caret::after{content:'';display:inline-block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid #0f172a;margin-left:8px;vertical-align:middle;}</style><span class="menu">Sort: Newest <span class="caret"></span></span></div>`,
    width: 240,
    height: 80,
  },
  {
    // DM-754: multi-column block-level `box-decoration-break`. The middle
    // callout is tall enough to fragment at the column boundary. With slice
    // (default) the first fragment owns TOP + LEFT + RIGHT borders and the
    // second owns BOTTOM + LEFT + RIGHT (no border across the column gap);
    // without per-fragment paint the bbox path would paint a single rect
    // spanning both columns and bridging the gap.
    name: "multi-column-block-decoration-slice",
    html: `<div style="padding:16px;background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;font-size:12px;line-height:1.5;"><div style="column-count:2;column-gap:24px;padding:12px;background:#1e293b;border-radius:6px;"><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;">Short block in column 1.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;">A tall block whose content runs past the bottom of the first column and continues into the second column — its border should not bridge the column gap. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;">Final block.</div></div></div>`,
    width: 480,
    height: 280,
  },
  {
    // DM-754 + DM-721: same multi-column container as the slice fixture but
    // with `box-decoration-break: clone` on the fragmented block. Each
    // fragment paints a complete bordered + rounded box (all four sides on
    // both column ends, all four corners rounded).
    name: "multi-column-block-decoration-clone",
    html: `<div style="padding:16px;background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;font-size:12px;line-height:1.5;"><div style="column-count:2;column-gap:24px;padding:12px;background:#1e293b;border-radius:6px;"><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">Short clone block.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A tall clone block whose content fragments at the column boundary — each fragment paints its own complete border + rounded corners. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">Final clone block.</div></div></div>`,
    width: 480,
    height: 280,
  },
  {
    // DM-506: CSS sprite icon image-replacement idiom — `text-indent: -9999px`
    // hides the accessible label off-screen and the visible icon is a slice of
    // a sprite sheet selected via `background-position`. Capture detects the
    // pattern and rasterises the painted box (sprite slice) instead of trying
    // to slice the bg-image declaratively (which doesn't work because the
    // sync naturalWidth read in CAPTURE_SCRIPT often returns 0 for url()
    // backgrounds whose <img> cache hasn't loaded). See docs/23.
    name: "sprite-icon-text-indent",
    html: (() => {
      const sprite =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='60' height='20' viewBox='0 0 60 20'>" +
            "<rect x='0' y='0' width='20' height='20' fill='%23f59e0b'/>" +
            "<rect x='20' y='0' width='20' height='20' fill='%231f6feb'/>" +
            "<rect x='40' y='0' width='20' height='20' fill='%2322c55e'/>" +
            "</svg>",
        );
      const a = (cls: string, label: string, posX: string) =>
        `<a class="${cls}" aria-label="${label}" href="#" style="background:url(${sprite}) ${posX} 0 no-repeat;width:20px;height:20px;display:inline-block;text-indent:-9999px;overflow:hidden;margin-right:8px;">${label}</a>`;
      return `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;">${a("rss", "RSS", "0")}${a("fb", "Facebook", "-20px")}${a("li", "LinkedIn", "-40px")}</div>`;
    })(),
    width: 140,
    height: 60,
  },
  {
    // DM-499: inline SVG `<use href="#sym">` referencing a `<symbol>` defined
    // in a sibling hidden defs SVG — the apple.com country-dropdown checkmark
    // pattern. Capture-time resolver inlines the symbol into the consumer's
    // outerHTML so the output is fully self-contained (no dangling fragment
    // refs that the re-embedded SVG can't resolve).
    name: "inline-svg-use-symbol",
    html: `<div style="padding:24px;background:#0d1117;color:#22d3ee;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><symbol id="dm-icon-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></symbol></svg><svg width="20" height="20"><use href="#dm-icon-check"/></svg><span style="font-size:14px;">Selected</span><svg width="32" height="32" style="color:#a855f7;"><use href="#dm-icon-check"/></svg></div>`,
    width: 220,
    height: 80,
  },
  {
    // DM-499: <use href="#group-id"> targeting a <g> (no symbol viewBox).
    // Resolver wraps the cloned target in <g transform="translate(x,y)">.
    name: "inline-svg-use-group",
    html: `<div style="padding:24px;background:#0d1117;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><g id="dm-grp-star"><circle cx="12" cy="12" r="10" fill="#f59e0b"/><circle cx="12" cy="12" r="4" fill="#fff"/></g></svg><svg width="32" height="32" viewBox="0 0 24 24"><use href="#dm-grp-star"/></svg><svg width="32" height="32" viewBox="0 0 24 24"><use href="#dm-grp-star" x="0" y="0"/></svg></div>`,
    width: 160,
    height: 80,
  },
  {
    // DM-508: <use href="#sym"> targeting a CSS-animated <symbol>. Domotion
    // bakes the t=0 computed transform / fill / opacity onto the inlined
    // subtree at capture time so the painted moment matches Chrome — even
    // though the animation itself doesn't survive into the output (frozen
    // at capture time, like every other Domotion capture).
    name: "inline-svg-use-symbol-animated",
    html: `<style>@keyframes dm-fixture-spin{from{transform:rotate(45deg);}to{transform:rotate(45deg);}}.dm-fixture-spin-target{animation:dm-fixture-spin 4s infinite linear;transform-box:fill-box;transform-origin:center;}</style><div style="padding:24px;background:#0d1117;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><symbol id="dm-anim-icon" viewBox="0 0 24 24"><rect class="dm-fixture-spin-target" x="6" y="6" width="12" height="12" fill="#3fb950"/></symbol></svg><svg width="32" height="32"><use href="#dm-anim-icon"/></svg></div>`,
    width: 120,
    height: 80,
  },
  {
    // DM-524: inline SVG with `var(--token)` / `calc()` / `env()` references
    // baked directly into presentation attributes (Stripe's nav-button
    // <rect fill="var(--hds-color-text-solid)"> idiom). Chrome resolves these
    // against the source page's custom-property cascade; outside that
    // cascade — i.e. in our extracted SVG — the var is unresolved and the
    // rect paints black/currentColor instead of the intended palette color.
    // Capture-time fix overwrites the literal with the resolved computed
    // value when the source attribute is a CSS function ref.
    name: "inline-svg-css-var-attr",
    html: `<div style="--btn-bg:#1f6feb;--btn-stroke:#22d3ee;--btn-thick:calc(2px + 1px);padding:24px;background:#0d1117;display:flex;gap:12px;align-items:center;"><svg width="60" height="40"><rect x="2" y="2" width="56" height="36" fill="var(--btn-bg)" stroke="var(--btn-stroke)" stroke-width="var(--btn-thick)" rx="6"/></svg><svg width="60" height="40"><circle cx="30" cy="20" r="14" fill="var(--btn-stroke)" opacity="0.5"/></svg></div>`,
    width: 180,
    height: 80,
  },
  {
    // DM-2328: CSS-only SVG clip-path declarations must be baked onto the
    // cloned subtree so the output browser resolves native fill/stroke/view
    // reference boxes instead of losing the source page's stylesheet.
    name: "inline-svg-effect-geometry-boxes",
    html: `<style>.dm-svg-boxes{display:flex;gap:10px}.dm-svg-boxes svg{width:200px;height:120px;overflow:visible}.dm-svg-boxes rect{fill:#2563eb;stroke:#dc2626;stroke-width:20px}.dm-fill{clip-path:circle(20% at 0% 50%) fill-box}.dm-stroke{clip-path:circle(20% at 0% 50%) stroke-box}.dm-view{clip-path:circle(20% at 0% 50%) view-box}.dm-mask{mask-image:linear-gradient(to right,#000 0 50%,transparent 50%);mask-size:50% 100%;mask-repeat:no-repeat}.dm-mask-fill{mask-origin:fill-box;mask-clip:fill-box}.dm-mask-stroke{mask-origin:stroke-box;mask-clip:stroke-box}.dm-mask-view{mask-origin:view-box;mask-clip:view-box}</style><div style="padding:20px"><div class="dm-svg-boxes"><svg viewBox="0 0 200 120"><rect class="dm-fill" x="60" y="30" width="80" height="40"/></svg><svg viewBox="0 0 200 120"><rect class="dm-stroke" x="60" y="30" width="80" height="40"/></svg><svg viewBox="0 0 200 120"><rect class="dm-view" x="60" y="30" width="80" height="40"/></svg></div><div class="dm-svg-boxes"><svg viewBox="0 0 200 120"><rect class="dm-mask dm-mask-fill" x="60" y="30" width="80" height="40"/></svg><svg viewBox="0 0 200 120"><rect class="dm-mask dm-mask-stroke" x="60" y="30" width="80" height="40"/></svg><svg viewBox="0 0 200 120"><rect class="dm-mask dm-mask-view" x="60" y="30" width="80" height="40"/></svg></div></div>`,
    width: 690,
    height: 300,
  },
  {
    // DM-523: position:fixed inside a transformed ancestor pins to that
    // ancestor (CSS Transforms 2: any non-none transform creates a
    // containing block for fixed-positioned descendants). When capturing,
    // we used to clear the ancestor's inline transform to read its
    // un-transformed rect — but transform: none destroys the CB, letting
    // the fixed descendant escape to the viewport. The fix substitutes
    // transform: translate(0), preserving the CB while still producing the
    // un-rotated/un-scaled rect we need for the SVG group wrapper.
    //
    // The fixture: ancestor has transform: translate(0,0) (a no-op);
    // descendant pin is position: fixed with bottom/right offsets that
    // anchor it to the ancestor's bottom-right corner. If the CB-preserve
    // bug regressed, the pin would jump to viewport bottom-right.
    name: "fixed-in-transform-cb",
    html: `<div style="padding:24px;background:#0d1117;"><div style="position:relative;width:280px;height:140px;background:#1f2937;transform:translate(0,0);"><div style="position:fixed;bottom:8px;right:8px;width:40px;height:24px;background:#dc2626;"></div></div></div>`,
    width: 360,
    height: 200,
  },
  {
    // DM-522: `contain: paint` must clip descendants to the principal box
    // per the CSS Containment spec. Before the fix the renderer treated
    // contain:paint as stacking-context-only and emitted no clip, so
    // descendants leaked past the ancestor box (regression observable on
    // 13-deep-stacking-context-creators's contain:paint stage).
    //
    // Fixture: ancestor is contain:paint with width:120 / height:60. A
    // child rect at top:30 left:60 width:120 height:60 would overflow the
    // ancestor's right and bottom edges by 60px each in a non-clipping
    // context. With contain:paint clipping, only the top-left quadrant
    // (60x30) of the child should be visible.
    name: "contain-paint-clips",
    html: `<div style="padding:24px;background:#0d1117;"><div style="position:relative;width:120px;height:60px;background:#1f2937;contain:paint;"><div style="position:absolute;top:30px;left:60px;width:120px;height:60px;background:#2563eb;"></div></div></div>`,
    width: 240,
    height: 120,
  },
  {
    // DM-543: position:fixed paints in the viewport stacking context and
    // escapes ALL ancestor overflow clips. The bug: the renderer hoisted
    // fixed pins only up to the nearest stacking-context ancestor — and an
    // overflow:auto scroller IS an SC. So a pin captured at viewport
    // bottom-right got buried inside the section's <g clip-path> wrapper
    // and was clipped out (invisible).
    //
    // Fixture: a section with overflow:hidden and NO fixed-CB ancestor
    // contains a position:fixed pin at viewport bottom-right. The pin's
    // captured x/y are the viewport coordinates (bottom-right of the
    // 280x180 viewport here, anchored 8px in). With the fix, the pin is
    // hoisted to the root SC and renders at viewport bottom-right
    // regardless of the section's clip.
    //
    // Constraint check (covered by `fixed-in-transform-cb` above): when
    // the ancestor IS a fixed CB (transform / filter / will-change /
    // contain), the pin stays trapped — don't over-escape.
    name: "fixed-escapes-overflow",
    html: `<div style="padding:0;margin:0;"><section style="border:2px solid #475569;background:#f8fafc;height:120px;overflow:hidden;padding:8px;"><div style="border:2px dashed #94a3b8;padding:8px;height:200px;"><div style="position:fixed;bottom:8px;right:8px;background:#dc2626;color:#fff;padding:4px 8px;font:bold 12px sans-serif;">PIN</div></div></section></div>`,
    width: 280,
    height: 180,
  },
  {
    // DM-2385: perspective is an authored/computed ancestor signal, not a
    // symptom to recover from a descendant matrix. The first panel has an
    // asymmetric perspective-origin and a projected child; Chromium owns that
    // projective surface, and its fixed pin remains fixed to (and clipped by)
    // the panel. The middle panel proves computed preserve-3d remains a fixed
    // CB even though overflow:hidden is a grouping property that flattens its
    // used 3D style. The final perspective:none/origin-only panel is the
    // negative control: its fixed pin escapes to the viewport bottom-right.
    name: "perspective-fixed-containing-block-ownership",
    html: `<div style="position:relative;width:720px;height:220px;padding:20px;background:#0d1117;font:12px/1.3 system-ui,sans-serif;color:#e2e8f0;display:flex;gap:28px;"><section style="position:relative;width:200px;height:130px;border:3px solid #f87171;overflow:hidden;background:#3f1d2e;perspective:420px;perspective-origin:20% 75%;"><b style="display:block;padding:8px;">perspective: 420px</b><div style="position:absolute;left:45px;top:38px;width:120px;height:70px;background:#7c3aed;transform:rotateY(28deg);"></div><i style="position:fixed;left:142px;top:90px;width:44px;height:24px;background:#facc15;border:2px solid #111827;"></i></section><section style="position:relative;width:200px;height:130px;border:3px solid #60a5fa;overflow:hidden;background:#172554;transform-style:preserve-3d;"><b style="display:block;padding:8px;">preserve-3d + clip</b><i style="position:fixed;left:142px;top:90px;width:44px;height:24px;background:#38bdf8;border:2px solid #111827;"></i></section><section style="position:relative;width:200px;height:130px;border:3px solid #4ade80;overflow:hidden;background:#052e16;perspective:none;perspective-origin:20% 75%;"><b style="display:block;padding:8px;">perspective: none</b><i style="position:fixed;right:12px;bottom:12px;width:52px;height:28px;background:#4ade80;border:2px solid #f8fafc;"></i></section></div>`,
    width: 720,
    height: 220,
  },
  {
    // DM-499 regression: plain self-contained inline SVG (paths declared
    // inline) must keep round-tripping via the existing DM-279 path.
    name: "inline-svg-self-contained",
    html: `<div style="padding:24px;background:#0d1117;color:#3fb950;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg width="20" height="20" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="font-size:14px;">Inline</span></div>`,
    width: 180,
    height: 80,
  },
  {
    // DM-494 / DM-1450: mask-image: element(#id) paint-reference. NOTE: CSS
    // `element()` is UNSUPPORTED in Chromium (Firefox-only `-moz-element`) — it
    // parse-rejects, so Chrome computes `mask-image: none` and paints both
    // consumers UNMASKED (no diagonal luminance cut). This fixture is therefore
    // a VACUOUS pass: it only verifies Domotion gracefully no-ops on the
    // unsupported syntax (renders the consumers unmasked, matching Chrome's
    // unmasked paint) — NOT that the element()-mask path produces a cut. The
    // capture/render path (rasterizeMaskSources etc.) is dormant; it's
    // synthetic-input-tested in tests/iframe-inner-element-mask.e2e.test.ts.
    // See docs/22. If a future engine resolves element(), restore a real
    // masked-output assertion here.
    name: "mask-element-ref",
    html: `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;color:#e6edf3;"><div id="src" style="position:absolute;left:-9999px;top:-9999px;width:200px;height:120px;background:linear-gradient(135deg,#fff 0%,#fff 50%,#000 50%,#000 100%);"></div><div style="display:flex;gap:16px;"><div style="width:200px;height:120px;background:#22d3ee;mask-image:element(#src);-webkit-mask-image:element(#src);mask-mode:match-source;-webkit-mask-mode:match-source;"></div><div style="width:200px;height:120px;background:#a855f7;mask-image:element(#src);-webkit-mask-image:element(#src);mask-mode:match-source;-webkit-mask-mode:match-source;"></div></div></div>`,
    width: 480,
    height: 180,
  },
  {
    // DM-493: mask-image: url("#id") referencing an inline <mask> defined in
    // the same document. Capture resolves the fragment, serialises the mask's
    // outerHTML, and the renderer copies it into the output <defs> with id
    // rewriting. Two boxes share one mask def to exercise dedupe.
    name: "mask-fragment-url",
    html: `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;color:#e6edf3;"><svg width="0" height="0" style="position:absolute;"><defs><mask id="diag-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="120"><rect x="0" y="0" width="200" height="120" fill="white"/><polygon points="0,0 200,0 200,40 0,120" fill="black"/></mask></defs></svg><div style="display:flex;gap:16px;"><div style="width:200px;height:120px;background:linear-gradient(135deg,#22d3ee,#a855f7);mask-image:url(#diag-mask);-webkit-mask-image:url(#diag-mask);"></div><div style="width:200px;height:120px;background:#f97316;mask-image:url(#diag-mask);-webkit-mask-image:url(#diag-mask);"></div></div></div>`,
    width: 480,
    height: 180,
  },
  {
    // DM-580: accessibility "visually-hidden" / "sr-only" patterns paint
    // nothing in Chrome but the DOM still carries the text. Real-world
    // captures of nytimes.com / slashdot etc. were leaking stray skip-link /
    // section-abbreviation text into the SVG. Three patterns exercised:
    //   1. `clip: rect(0,0,0,0)` (legacy)
    //   2. `clip-path: inset(50%)` (modern, used by Tailwind's `sr-only`)
    //   3. `width:1px;height:1px;overflow:hidden;position:absolute` (1×1 sr-only)
    // The fixture wraps a normally-painted "Hello" so we can verify the box
    // around it is unchanged while the hidden text drops out.
    name: "visually-hidden-text",
    html: `<div style="padding:20px;background:#fff;font-family:-apple-system,sans-serif;font-size:16px;color:#111;">
      <a href="#main" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">Skip to content</a>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;">Section: SK</span>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;">Tooltip label</span>
      <span>Hello</span>
    </div>`,
    width: 240,
    height: 80,
  },
  {
    // Inline elements that wrap across multiple line boxes need per-fragment
    // paint of background + border (CSS Backgrounds 3 §3.7
    // `box-decoration-break`). Without it the captured bbox covers the
    // union of every line and the single rect paint smears across the full
    // container width — text floats outside its highlight, and pill chips
    // lose their per-line rounded corners. This fixture exercises:
    //   1. slice (default): first fragment gets TL/BL + LEFT border,
    //      last gets TR/BR + RIGHT, middle fragments paint only top + bottom.
    //   2. clone: every fragment paints a full pill with all four corners,
    //      including a `border-radius: 999px` chip that should keep its
    //      rounded ends on every line.
    name: "inline-box-decoration-break",
    html: `<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.7;padding:20px;background:#fff;color:#111;">
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:12px;">
        Default body text. <span style="background:#fef3c7;border:2px solid #b45309;padding:2px 8px;border-radius:6px;box-decoration-break:slice;-webkit-box-decoration-break:slice;">A highlighted span that wraps across multiple lines using slice.</span> After.
      </div>
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:12px;">
        Default body text. <span style="background:#fef3c7;border:2px solid #b45309;padding:2px 8px;border-radius:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A highlighted span that wraps across multiple lines using clone.</span> After.
      </div>
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">
        <span style="background:#1d4ed8;color:white;padding:2px 10px;border-radius:999px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A pill-shaped chip wrapping across lines keeps rounded corners.</span>
      </div>
    </div>`,
    width: 420,
    height: 360,
  },
  {
    // CSS 2.1 Appendix E paint order is CONTEXT-WIDE for floats: a stacking
    // context paints every in-flow block descendant's background + border
    // (step 3), THEN every non-positioned float (step 4), THEN all in-flow
    // inline content — text, inline boxes, replaced content (step 5). Steps 4
    // and 5 span the whole stacking context, so a float belonging to the first
    // paragraph paints below the text of the third paragraph, and above the
    // background of a later block sibling.
    //
    // Both rows below make the float's painted box overlap content it does
    // NOT push out of the way — `margin-right: -140px` zeroes the float's
    // outer width so line boxes are never shortened (the `shape-outside`
    // spelling of the same trick produces the same overlap). Without a
    // three-phase walk the renderer gets one row wrong whichever local
    // approximation it picks:
    //   Row 1 — the float's parent has no text of its own, so it is hoisted
    //     into the stacking context's float bucket. It must still paint
    //     BELOW the following paragraph's text.
    //   Row 2 — the float's parent does have its own text, and a later
    //     block sibling's background is pulled up over the float by a
    //     negative margin. The float must paint ABOVE that background and
    //     BELOW that block's text.
    //   Row 3 — the float sits inside an `inline-block`, which CSS paints
    //     atomically ("as if it created a new stacking context"). Its floats
    //     stay with it: pulled out into the enclosing context's float step
    //     they would paint under the wrapper's own background and vanish.
    name: "float-paint-order-context-wide",
    html: `<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:20px;color:#0d1117;background:#fff;padding:16px;">
      <div style="width:380px;margin-bottom:24px;">
        <div><span style="float:left;width:140px;height:72px;margin-right:-140px;background:#f85149;"></span></div>
        <p style="margin:0;">Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.</p>
      </div>
      <div style="width:380px;">
        <p style="margin:0;"><span style="float:left;width:140px;height:84px;margin-right:-140px;background:#f85149;"></span>Alpha beta gamma delta epsilon zeta eta theta iota kappa.</p>
        <div style="background:#2ea043;color:#fff;margin-top:-24px;padding:2px 4px;">Later sibling background</div>
      </div>
      <div style="display:inline-block;width:380px;background:#dbeafe;padding:6px;margin-top:8px;">
        <span style="float:left;width:60px;height:40px;background:#f85149;"></span>Inline-block wrapper keeps its float.
      </div>
    </div>`,
    width: 420,
    height: 320,
  },
  {
    // CSS `unicode-bidi: bidi-override` over RTL text, which Blink implements by
    // injecting U+202D LRO / U+202E RLO and a trailing U+202C PDF and then running
    // the ordinary bidi algorithm (inline_items_builder.cc:1501-1505).
    //
    // The subtle half is what happens NEXT, and it is why Arabic is here alongside
    // Hebrew. HarfBuzz never shapes a run under a direction contrary to its
    // script's own: hb_ensure_native_direction reverses the characters into native
    // order first, shapes, and reverses back (hb-ot-shape.cc:588, :1184). Reversing
    // BEFORE shaping means the contextual forms are computed on the reversed
    // sequence, so Chrome paints Arabic under a forced LTR order with the ends
    // UNJOINED — the first letter no longer has anything to its right. Shaping the
    // text as-is under a forced direction keeps the joined forms and paints a
    // different word shape; that residual is what this fixture pins.
    //
    // Hebrew is included because it does not join, so it isolates the ORDER half
    // of the same mechanism and fails differently if only the reversal regresses.
    name: "text-bidi-override-rtl",
    html: `<div style="font-family:Helvetica,sans-serif;font-size:28px;color:#000;background:#fff;padding:20px;">
      <div>eng <span style="unicode-bidi:bidi-override;direction:ltr">مرحبا بالعالم</span> tail</div>
      <div>eng <span style="unicode-bidi:bidi-override;direction:ltr">שלום ניסיון</span> tail</div>
      <div>eng <span style="unicode-bidi:bidi-override;direction:rtl">שלום ניסיון</span> tail</div>
    </div>`,
    width: 700,
    height: 180,
  },

  {
    // `font-stretch` end to end: glyphs AND decoration metrics from the same
    // width-matched face. 75% on Helvetica Neue opens the family's condensed
    // cut (Blink turns any width below 100% into the condensed symbolic trait
    // and scores it ahead of weight, `mac/font_matcher_mac.mm:185-202` +
    // `:234-235`); the underline must be measured on that SAME cut — the
    // decoration helpers used to resolve the family at normal width, so a
    // condensed run was underlined where the normal cut wants it. The
    // system-ui line pins the OTHER mechanism: on the variable SF face the
    // width is the `wdth` axis (identity, clamped to the axis range), not a
    // cut. Large font size so a metrics disagreement is pixels, not noise.
    name: "text-font-stretch-underline",
    html: `<div style="background:#fff;color:#111;padding:24px;">
      <div style="font-family:'Helvetica Neue',sans-serif;font-size:42px;font-stretch:75%;text-decoration:underline;">Hamburgefonstiv 75%</div>
      <div style="font-family:'Helvetica Neue',sans-serif;font-size:42px;text-decoration:underline;">Hamburgefonstiv normal</div>
      <div style="font-family:system-ui,sans-serif;font-size:42px;font-stretch:50%;text-decoration:underline;">Hamburgefonstiv 50%</div>
    </div>`,
    width: 700,
    height: 220,
  },
  {
    // DM-1973: the declared-family WEIGHT-SCORING rung, which no other fixture
    // exercises. The suite already discriminates the Linux matcher's nomination
    // walk (via `text-font-stretch-underline`, at weight 400), but the other
    // half of the matcher — where the transcribed rule and the degraded
    // two-slot `key` / `key-bold` table disagree — lives in the 500-599 band
    // and had no pixel coverage at all.
    //
    // 550 is the rung, and it resolves to a DIFFERENT cut on each platform,
    // which is why this fixture is written to be graded against each host's own
    // Chrome rather than against a fixed expectation. Measured over CDP
    // (`CSS.getPlatformFontsForNode`), Arial at 550:
    //
    //   macOS     ArialMT            (crosses at 600 — verified for Arial,
    //                                 Helvetica, Georgia, Times New Roman and
    //                                 Verdana alike, and our resolver agrees on
    //                                 every one of those rungs)
    //   Linux     LiberationSans-Bold  (fontconfig's weight scoring already
    //                                 prefers Bold at 550)
    //   Windows   Arial-BoldMT       (DirectWrite scores 550 closer to bold)
    //
    // So on Linux this fixture MOVES between the built helper and
    // `DOMOTION_DISABLE_HELPER=1`: the fallback two-slot table crosses at 600
    // and answers the regular cut, which is a visible ink difference rather
    // than a sub-pixel one. That movement is the whole point — a fixture that
    // does not move grades nothing.
    //
    // The 400 and 700 rows are controls: both paths agree there, so a change
    // that broke the matcher outright would fail them too and could not be
    // mistaken for this rung moving.
    name: "text-declared-family-weight-550",
    html: `<div style="background:#fff;color:#111;padding:20px;font-size:38px;">
      <div style="font-family:Arial,sans-serif;font-weight:400;">Hamburgefonstiv 400</div>
      <div style="font-family:Arial,sans-serif;font-weight:550;">Hamburgefonstiv 550</div>
      <div style="font-family:Arial,sans-serif;font-weight:700;">Hamburgefonstiv 700</div>
    </div>`,
    width: 700,
    height: 200,
  },
];

// Only auto-run the suite when invoked directly (not when the fixtures are
// imported by another harness, e.g. the byte-identical refactor baseline).
if (process.argv[1] != null && process.argv[1].endsWith("features.ts")) {
  void runFeatureTests(tests, "features");
}
