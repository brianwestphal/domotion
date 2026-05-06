/**
 * Feature test definitions.
 *
 * Each test is a minimal HTML snippet that exercises one rendering feature.
 * The test runner compares HTML→PNG with SVG→PNG for each.
 *
 * Usage: npx tsx tests/features.ts [--only feature-name]
 */

import { runFeatureTests, type FeatureTest } from "./runner.js";

const tests: FeatureTest[] = [
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
    name: "text-small",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif;">LABEL TEXT</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif; margin-top: 4px;">Score: 42/100 · 1,234 downloads</div></div>`,
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

  // ── Regression: CSS gradients translated to SVG linear/radial gradients (SK-432) ──
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
    name: "replaced-video-poster",
    html: `<div style="padding:20px;"><video poster="data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 120'><rect width='200' height='120' fill='%23222'/><polygon points='80,40 80,80 120,60' fill='white'/></svg>")}" width="200" height="120" style="display:block;background:#000;"></video></div>`,
    width: 240,
    height: 160,
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
    name: "replaced-iframe-same-origin",
    html: `<div style="padding:20px;"><iframe srcdoc="<html><body style='margin:0;background:#225;color:#fff;font-family:sans-serif;'><div style='padding:14px;font-size:18px;'>Hello iframe</div></body></html>" width="240" height="100" style="display:block;border:0;"></iframe></div>`,
    width: 280,
    height: 140,
  },
];

void runFeatureTests(tests, "features");
